import hashlib
import hmac
import ipaddress
import json
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from unittest.mock import patch,MagicMock

from setup_agent import Agent,GatewayClient
from setup_gateway import Profiles
from setup_discovery import NetworkDiscovery
from setup_usb import USBProvisioner,SetupError,validated_nvs,private_json


def flash():
    data=bytearray(b'\xff'*(4*1024*1024))
    entry=struct.pack('<HBBII16sI',0x50aa,1,2,0x9000,0x5000,b'nvs',0)
    app=struct.pack('<HBBII16sI',0x50aa,0,16,0x10000,0x140000,b'app0',0)
    table=entry+app
    data[0x8000:0x8060]=table+b'\xeb\xeb'+b'\xff'*14+hashlib.md5(table).digest()
    data[0x10000]=0xe9;struct.pack_into('<H',data,0x1000c,5)
    return bytes(data)


class Response:
    def __init__(self,data):self.raw=json.dumps({'data':data}).encode()
    def read(self,*_):return self.raw
    def __enter__(self):return self
    def __exit__(self,*_):pass


class SetupTests(unittest.TestCase):
    def test_backup_partition_checksum_and_chip_are_required_before_nvs_writes(self):
        data=flash();self.assertEqual(validated_nvs(data),(0x9000,0x5000))
        for offset in [0x8000,0x8041,0x1000c]:
            bad=bytearray(data);bad[offset]^=1
            with self.assertRaises(SetupError):validated_nvs(bad)

    def test_recovery_restores_only_nvs_even_after_cancel(self):
        with tempfile.TemporaryDirectory() as directory:
            cancelled=threading.Event();cancelled.set()
            reader=USBProvisioner({'path':'/dev/serial/by-id/test'},directory,cancelled,lambda _:None)
            reader.nvs=(0x9000,0x5000);reader.changed=True
            with patch.object(reader,'esptool') as writer:reader.rollback()
            args=writer.call_args.args[0]
            self.assertEqual(args[0],'write_flash');self.assertEqual(args[-2],'0x9000')
            self.assertNotIn('0x10000',args);self.assertTrue(cancelled.is_set())

    def test_private_state_never_becomes_world_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'profile.json';private_json(path,{'secret':'local-only'})
            self.assertEqual(path.stat().st_mode&0o777,0o600)

    def test_network_hint_cannot_probe_an_off_lan_target_or_forward_credentials(self):
        discovery=NetworkDiscovery();discovery.services={'nfc-reader._http._tcp.local.':('8.8.8.8',time.monotonic())}
        with patch('setup_discovery.lan_networks',return_value=[ipaddress.ip_network('192.0.2.0/24')]),patch('setup_discovery.urllib.request.build_opener') as opener:
            self.assertEqual(discovery.devices(),[]);opener.assert_not_called()

    def test_recovery_and_retry_are_ordered_per_device_without_blocking_another_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            agent=self.agent(Path(directory));started=threading.Event();release=threading.Event();other=threading.Event();order=[]
            def recovery():started.set();release.wait(2);order.append('restored')
            first=agent.submit('first',recovery);self.assertTrue(started.wait(1))
            second=agent.submit('first',lambda:order.append('next-setup'))
            parallel=agent.submit('other',other.set)
            self.assertTrue(other.wait(1));self.assertEqual(order,[])
            release.set();first.join(2);second.join(2);parallel.join(2)
            self.assertEqual(order,['restored','next-setup'])
            for executor in agent.executors.values():executor.shutdown()

    def test_gateway_report_signs_exact_body_and_checks_bound_reply(self):
        def opener(request,**options):
            headers={k.lower():v for k,v in request.header_items()};body=json.loads(request.data)
            self.assertEqual(request.full_url,'https://backend.example/api/devices/setup/poll')
            expected=hmac.new(b'g'*64,headers['x-gateway-timestamp'].encode()+b'\n'+request.data,hashlib.sha256).hexdigest()
            self.assertEqual(headers['x-gateway-signature'],expected)
            self.assertNotIn('path',json.dumps(body))
            return Response({'gatewayId':'pi','eventId':body['eventId'],'jobs':[]})
        client=GatewayClient('https://backend.example','pi','g'*64,opener)
        self.assertEqual(client.poll([{'id':'usb-'+'a'*24,'model':'Mini','transport':'usb'}],[]),[])
        client.opener=lambda *a,**k:Response({'gatewayId':'wrong','eventId':'wrong','jobs':[]})
        with self.assertRaises(ValueError):client.poll([],[])

    def profiles(self,root):
        for char in ['a','b']:
            private_json(root/('usb-'+char*24+'.json'),{'deviceId':'usb-'+char*24,'jobId':'job','readerId':'reader-'+char,
                'readerSecret':char*64,'linkKey':char*64,'backendUrl':'https://backend.example'})
        return Profiles(root,'https://backend.example')

    def frame(self,counter=1):
        return json.dumps({'type':'reader_poll','session':'1234abcd','nonce':'f'*32,'counter':counter,
            'scan_id':0,'uptime_ms':100,'reader_ready':True,'pending':False},separators=(',',':')).encode()

    def test_two_readers_have_independent_credentials_replay_state_and_reply_signatures(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);profiles=self.profiles(root)
            with patch('wireless.reader_bridge.BackendClient.health',return_value=True):
                for char in ['a','b']:
                    key=bytes.fromhex(char*64);raw=self.frame()
                    signature=hmac.new(key,b'reader-poll\n'+raw,hashlib.sha256).hexdigest()
                    reply,mac=profiles.signed_poll(raw,signature)
                    self.assertEqual(mac,hmac.new(key,b'gateway-reply\n'+reply,hashlib.sha256).hexdigest())
                    status=json.loads((root/('usb-'+char*24+'.status')).read_text())
                    self.assertEqual(status['pairingProof'],hashlib.sha256(key).hexdigest())
                    with self.assertRaises(ValueError):profiles.signed_poll(raw,signature)
                with self.assertRaises(ValueError):profiles.signed_poll(raw,'0'*64)

    def test_activation_preserves_replay_state_and_revocation_removes_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);profiles=self.profiles(root);raw=self.frame();key=bytes.fromhex('a'*64)
            signature=hmac.new(key,b'reader-poll\n'+raw,hashlib.sha256).hexdigest()
            with patch('wireless.reader_bridge.BackendClient.health',return_value=True):profiles.signed_poll(raw,signature)
            path=root/('usb-'+'a'*24+'.json');cfg=json.loads(path.read_text());cfg['activated']=True;private_json(path,cfg)
            with self.assertRaises(ValueError):profiles.signed_poll(raw,signature)
            path.unlink()
            raw=self.frame(2);signature=hmac.new(key,b'reader-poll\n'+raw,hashlib.sha256).hexdigest()
            with self.assertRaises(ValueError):profiles.signed_poll(raw,signature)

    def agent(self,root):
        return Agent({'state_dir':str(root/'state'),'profiles':str(root/'profiles'),'backend_url':'https://backend.example'},client=MagicMock())

    def test_stale_status_from_a_previous_pairing_cannot_complete_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);agent=self.agent(root);device='usb-'+'a'*24
            private_json(agent.profiles/(device+'.status'),{'updated_at':time.time(),'esp32':{'state':'ready'},'reader':{'state':'ready'},'pairingProof':'wrong'})
            with patch('setup_agent.time.monotonic',side_effect=[0,0,36]),patch('setup_agent.AccessClient') as backend:
                with self.assertRaises(SetupError):agent.verify({'id':'job','deviceId':device},{'firmware':'1.7.1-c3-checkin'},'a'*64,threading.Event())
                backend.assert_not_called()

    def test_valid_pairing_requires_fresh_real_poll_and_new_disabled_reader_heartbeat(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);agent=self.agent(root);device='usb-'+'a'*24;key='a'*64
            private_json(agent.profiles/(device+'.status'),{'updated_at':time.time(),'esp32':{'state':'ready'},'reader':{'state':'ready'},'pairingProof':hashlib.sha256(bytes.fromhex(key)).hexdigest()})
            job={'id':'job','deviceId':device,'readerId':'new','readerSecret':'b'*64}
            with patch('setup_agent.AccessClient') as backend:
                backend.return_value.status.return_value={'mode':'disabled'}
                agent.verify(job,{'firmware':'1.7.1-c3-checkin'},key,threading.Event())
                backend.return_value.decide.assert_not_called()
                backend.return_value.status.return_value={'mode':'access'}
                with self.assertRaises(SetupError):agent.verify(job,{'firmware':'1.7.1-c3-checkin'},key,threading.Event())

    def test_lost_acceptance_reply_keeps_paired_settings_and_ack_activates_existing_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);agent=self.agent(root);device='usb-'+'a'*24
            job={'id':'job','deviceId':device,'readerId':'new','readerSecret':'b'*64,'ssid':'network','password':'private'}
            with patch('setup_agent.USBProvisioner') as provisioner,patch.object(agent,'verify'):
                provisioner.return_value.configure.return_value={'ip':'192.0.2.1','firmware':'1.7.1-c3-checkin','readerReady':True}
                agent.provision(job,{'path':'/dev/serial/by-id/mini'},threading.Event(),threading.Event())
                provisioner.return_value.rollback.assert_not_called()
            cfg=json.loads(agent.profile(device).read_text());self.assertFalse(cfg['activated']);self.assertNotIn('password',cfg)
            agent.handle([{'id':'job','deviceId':device,'readerId':'new','status':'complete'}],{})
            self.assertTrue(json.loads(agent.profile(device).read_text())['activated'])

    def test_provisioning_failure_removes_new_profile_and_restores_original_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);agent=self.agent(root);device='usb-'+'a'*24
            job={'id':'job','deviceId':device,'readerId':'new','readerSecret':'b'*64,'ssid':'network','password':'private'}
            with patch('setup_agent.USBProvisioner') as provisioner:
                provisioner.return_value.configure.side_effect=SetupError('wifi_failed')
                agent.provision(job,{'path':'/dev/serial/by-id/mini'},threading.Event(),threading.Event())
                provisioner.return_value.rollback.assert_called_once()
            self.assertFalse(agent.profile(device).exists());self.assertEqual(agent.updates['job']['errorCode'],'wifi_failed')

    def test_unsupported_boot_never_writes_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            reader=USBProvisioner({'path':'/dev/serial/by-id/mini'},directory,threading.Event(),lambda _:None)
            port=MagicMock();port.readline.return_value=b'FIELDNOTE version=other chip=ESP32-S3 sda=0 scl=1\n'
            with patch.object(reader,'check'),patch('setup_usb.time.monotonic',side_effect=[0,0]):
                with self.assertRaises(SetupError):reader.read_boot(port)
            port.write.assert_not_called();self.assertFalse(reader.changed)


if __name__=='__main__':unittest.main()
