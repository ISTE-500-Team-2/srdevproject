"""Outbound authenticated Pi discovery/provisioning worker.

The browser never contacts the LAN or receives signing credentials. A dedicated
gateway credential delivers bounded, admin-approved jobs. Only verified USB
hardware may be paired; network advertisements are discovery hints only.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import signal
import threading
import time
import urllib.error
import urllib.request
import uuid

from access_client import AccessClient
from setup_discovery import NetworkDiscovery
from setup_usb import SetupError, USBProvisioner, private_json, usb_devices, validated_nvs
from wireless.reader_bridge import base_url


class Task:
    def __init__(self,future):self.future=future
    def is_alive(self):return not self.future.done()
    def join(self,timeout=None):
        try:self.future.result(timeout=timeout)
        except Exception:pass


class GatewayClient:
    def __init__(self, url, gateway_id, secret, opener=None):
        self.url=base_url(url,backend=True)
        if not re.fullmatch('[a-zA-Z0-9_-]{1,64}',gateway_id) or len(secret)<32:
            raise ValueError('Invalid gateway credential')
        self.id,self.secret=gateway_id,secret
        self.last_stamp=0
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args): return None
        self.opener=opener or urllib.request.build_opener(NoRedirect()).open

    def poll(self,devices,updates):
        event=str(uuid.uuid4())
        raw=json.dumps({'eventId':event,'devices':devices[:32],'updates':updates[:32]},separators=(',',':')).encode()
        self.last_stamp=max(int(time.time()*1000),self.last_stamp+1)
        stamp=str(self.last_stamp)
        signature=hmac.new(self.secret.encode(),stamp.encode()+b'\n'+raw,hashlib.sha256).hexdigest()
        request=urllib.request.Request(self.url+'/api/devices/setup/poll',data=raw,headers={
            'Content-Type':'application/json','X-Gateway-ID':self.id,
            'X-Gateway-Timestamp':stamp,'X-Gateway-Signature':signature},method='POST')
        with self.opener(request,timeout=5) as response:
            raw=response.read(65537)
        if len(raw)>65536: raise ValueError('Oversized setup response')
        data=json.loads(raw).get('data',{})
        if data.get('eventId')!=event or data.get('gatewayId')!=self.id or not isinstance(data.get('jobs'),list):
            raise ValueError('Invalid setup response')
        for job in data['jobs']:
            if not isinstance(job,dict) or not re.fullmatch(r'[a-f0-9-]{36}',job.get('id','')) or not re.fullmatch('usb-[a-f0-9]{24}',job.get('deviceId','')):
                raise ValueError('Invalid setup job')
            if job.get('status') not in ['queued','backing_up','connecting','pairing','verifying','complete','failed','cancelled','expired']:
                raise ValueError('Invalid setup state')
            if job.get('status') not in ['complete','failed','cancelled','expired']:
                if (not re.fullmatch('[a-zA-Z0-9_-]{1,64}',job.get('readerId',''))
                    or not re.fullmatch('[a-f0-9]{64}',job.get('readerSecret',''))
                    or not isinstance(job.get('ssid'),str) or not (0 if job.get('reuseWifi') else 1)<=len(job['ssid'].encode())<=32
                    or not isinstance(job.get('password'),str) or len(job['password'].encode())>63
                    or any(c in job['ssid']+job['password'] for c in '\n\r\0')):
                    raise ValueError('Invalid provisioning job')
        return data['jobs']


class Agent:
    def __init__(self,cfg,client=None):
        self.cfg=cfg
        self.root=Path(cfg['state_dir'])
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.root.chmod(0o700)
        self.profiles=Path(cfg['profiles'])
        self.profiles.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.lock=threading.Lock()
        self.workers={}
        self.executors={}
        self.updates={}
        self.metadata={}
        self.client=client or GatewayClient(cfg['backend_url'],cfg['gateway_id'],Path(cfg['gateway_secret_file']).read_text().strip())
        self.stop=threading.Event()
        self.network=NetworkDiscovery()
        self.network_devices=[]

    def stage(self,job_id,status,**fields):
        with self.lock:
            self.updates[job_id]={'id':job_id,'status':status,**fields}
        private_json(self.root/job_id/'progress.json',{'id':job_id,'status':status,**fields})

    def profile(self,device_id):
        return self.profiles/(device_id+'.json')

    def submit(self,device_id,fn,*args):
        # Recovery and the next attempt on the SAME USB device are FIFO. Another
        # reader has its own executor, so a long backup never blocks its setup.
        if device_id not in self.executors:
            self.executors[device_id]=ThreadPoolExecutor(max_workers=1)
        return Task(self.executors[device_id].submit(fn,*args))

    def verify(self,job,device,link_key,cancelled):
        self.stage(job['id'],'verifying')
        deadline=time.monotonic()+35
        status_path=self.profiles/(job['deviceId']+'.status')
        while time.monotonic()<deadline:
            if cancelled.is_set(): raise SetupError('cancelled')
            try:
                status=json.loads(status_path.read_text())
                if (time.time()-status['updated_at']<4 and status['esp32']['state']=='ready'
                    and status['reader']['state']=='ready'
                    and status.get('pairingProof')==hashlib.sha256(bytes.fromhex(link_key)).hexdigest()):
                    # The TLS gateway attests a fresh, HMAC-verified poll using
                    # THIS pairing key. Works without inbound reader-LAN access.
                    if not device['firmware'].startswith('1.7.1-c3-'):
                        raise SetupError('verification_failed')
                    # New reader remains disabled until this real credential and
                    # live PN532 are verified; this creates no access/check-in event.
                    heartbeat=AccessClient(self.cfg['backend_url'],job['readerId'],job['readerSecret']).status()
                    if heartbeat['mode']!='disabled': raise SetupError('verification_failed')
                    return
            except (OSError,ValueError,KeyError,urllib.error.URLError):
                pass
            cancelled.wait(.5)
        raise SetupError('verification_failed')

    def provision(self,job,device,cancelled,accepted):
        provisioner=USBProvisioner(device,self.root/job['id'],cancelled,lambda stage:self.stage(job['id'],stage))
        path=self.profile(job['deviceId'])
        previous=path.read_bytes() if path.exists() else None
        try:
            self.stage(job['id'],'backing_up')
            key=secrets.token_hex(32)
            result=provisioner.configure(job['ssid'],job['password'],key,reuse_saved=job.get('reuseWifi',False))
            job['password']='';job['ssid']=''
            profile={'deviceId':job['deviceId'],'jobId':job['id'],'readerId':job['readerId'],
                     'readerSecret':job['readerSecret'],'linkKey':key,'backendUrl':self.cfg['backend_url'],
                     'ip':result['ip'],'firmware':result['firmware'],'usbPath':device['path'],'activated':False}
            private_json(path,profile)
            with self.lock:
                self.metadata[job['deviceId']]={'model':'ESP32-C3 mini','firmware':result['firmware']}
            self.verify(job,result,key,cancelled)
            self.stage(job['id'],'complete',readerReady=True)
            # Keep the paired profile until the server acknowledges or explicitly
            # cancels/expires it. A lost HTTP reply is NOT evidence of failure.
        except Exception as error:
            # Stop the new identity BEFORE attempting settings recovery.
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(previous);path.chmod(0o600)
            code=error.code if isinstance(error,SetupError) else 'internal_error'
            try:provisioner.rollback()
            except Exception:code='recovery_required'
            self.stage(job['id'],'failed',errorCode=code)
        finally:
            job['password']='';job['ssid']='';job['readerSecret']=''

    def handle(self,jobs,devices):
        # Queue cancellation/recovery before starting a replacement setup.
        for job in sorted(jobs,key=lambda j:j['status'] not in ['complete','cancelled','expired','failed']):
            worker=self.workers.get(job['id'])
            if job['status']=='complete':
                if worker:worker['accepted'].set()
                path=self.profile(job['deviceId'])
                if path.exists():
                    profile=json.loads(path.read_text())
                    if profile.get('jobId')==job['id'] and not profile.get('activated'):
                        profile['activated']=True;private_json(path,profile)
                        private_json(self.root/job['id']/'accepted.json',{'readerId':job['readerId'],'accepted':True})
                with self.lock:self.updates.pop(job['id'],None)
            elif job['status'] in ['cancelled','expired','failed']:
                with self.lock:
                    update=self.updates.get(job['id'],{})
                    if update.get('errorCode')!='recovery_required' or job.get('errorCode')=='recovery_required':
                        self.updates.pop(job['id'],None)
                if worker and not worker['accepted'].is_set():worker['cancelled'].set()
                path=self.profile(job['deviceId'])
                if path.exists() and (not worker or not worker['thread'].is_alive()):
                    profile=json.loads(path.read_text())
                    if profile.get('jobId')==job['id']:
                        path.unlink() # Disable this profile before recovery.
                        def recover(j=dict(job),p=profile):
                            try:
                                root=self.root/j['id']
                                data=(root/'full-flash-before.private.bin').read_bytes()
                                proof=json.loads((root/'backup-proof.json').read_text())
                                if hashlib.sha256(data).hexdigest()!=proof['sha256']:raise SetupError('backup_failed')
                                recovery=USBProvisioner({'path':p['usbPath']},root,threading.Event(),lambda stage:None)
                                recovery.nvs=validated_nvs(data);recovery.changed=True;recovery.rollback()
                            except Exception:self.stage(j['id'],'failed',errorCode='recovery_required')
                        thread=self.submit(job['deviceId'],recover)
                        if worker:worker['cleanup']=thread
                        else:self.workers[job['id']]={'thread':thread,'cancelled':threading.Event(),'accepted':threading.Event()}
            elif not worker:
                path=self.profile(job['deviceId'])
                if path.exists():
                    profile=json.loads(path.read_text())
                    if profile.get('jobId')==job['id']:
                        # Resume a paired-but-unacknowledged job after restart
                        # without changing NVS or generating a replacement key.
                        cancelled=threading.Event()
                        def resume(j=dict(job),p=profile,event=cancelled):
                            try:
                                self.verify(j,p,p['linkKey'],event)
                                self.stage(j['id'],'complete',readerReady=True)
                            except Exception:self.stage(j['id'],'failed',errorCode='verification_failed')
                        thread=self.submit(job['deviceId'],resume)
                        self.workers[job['id']]={'thread':thread,'cancelled':cancelled,'accepted':threading.Event()}
                        continue
                device=devices.get(job['deviceId'])
                if not device:
                    self.stage(job['id'],'failed',errorCode='disconnected')
                    continue
                cancelled,accepted=threading.Event(),threading.Event()
                thread=self.submit(job['deviceId'],self.provision,dict(job),device,cancelled,accepted)
                self.workers[job['id']]={'thread':thread,'cancelled':cancelled,'accepted':accepted}

    def scan_network(self):
        while not self.stop.is_set():
            known=[]
            for path in self.profiles.glob('usb-*.json'):
                try:known.append(json.loads(path.read_text()).get('ip'))
                except (OSError,ValueError):pass
            found=self.network.devices(known)
            with self.lock:self.network_devices=found
            self.stop.wait(20)

    def run(self):
        self.network.start()
        scan=threading.Thread(target=self.scan_network,daemon=True);scan.start()
        previous=None
        try:
            while not self.stop.is_set():
                try:
                    devices=usb_devices()
                    with self.lock:
                        reports=[{k:v for k,v in d.items() if k!='path'}|self.metadata.get(key,{}) for key,d in devices.items()]
                        reports+=list(self.network_devices)
                        updates=list(self.updates.values())
                    jobs=self.client.poll(reports,updates)
                    self.handle(jobs,devices)
                    status='connected'
                except Exception:
                    status='gateway_unavailable'
                if status!=previous:
                    print(json.dumps({'setupService':status}),flush=True);previous=status
                self.stop.wait(2)
        finally:
            self.stop.set()
            for worker in self.workers.values():
                if not worker['accepted'].is_set():worker['cancelled'].set()
            for worker in self.workers.values():worker['thread'].join(timeout=200)
            for worker in self.workers.values():
                if 'cleanup' in worker:worker['cleanup'].join(timeout=200)
            for executor in self.executors.values():executor.shutdown(wait=True,cancel_futures=True)
            self.network.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True)
    cfg=json.loads(Path(parser.parse_args().config).read_text())
    agent=Agent(cfg)
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:agent.stop.set())
    agent.run()


if __name__=='__main__':main()
