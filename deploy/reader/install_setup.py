"""One-time unprivileged Pi service installation. Dry-run unless --apply.

An operator privately provisions the dedicated host credential on the Pi and in
ACCESS_SETUP_GATEWAYS_JSON once. Ordinary reader setup then happens in the UI;
administrators never copy a per-reader key or choose a reader ID.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import ssl
import socket
import subprocess
import sys
import time
import venv

from setup_usb import private_json


def systemctl(*args,check=True):
    return subprocess.run(['systemctl','--user',*args],capture_output=True,text=True,check=check)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--apply',action='store_true')
    args=parser.parse_args();config_path=Path(args.config).resolve();cfg=json.loads(config_path.read_text())
    if os.geteuid()==0:raise SystemExit('Install as the unprivileged reader-service owner, not root.')
    for field in ['gateway_secret_file','state_dir','profiles','tls_cert','tls_key']:
        value=cfg.get(field,'')
        if not Path(value).is_absolute() or any(c in value for c in '\r\n%'):
            raise SystemExit('Use absolute, non-templated private configuration paths.')
    for field in ['gateway_secret_file','tls_key']:
        path=Path(cfg[field])
        if not path.is_file() or path.stat().st_mode&0o077:raise SystemExit('Private key files must be owner-only.')
    if config_path.stat().st_mode&0o077:raise SystemExit('Host configuration must be owner-only.')
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cfg['tls_cert'],cfg['tls_key'],password='') # Never open a password prompt.
    root=Path(cfg['state_dir']).parent;source=Path(__file__).resolve().parent
    if not Path(cfg['profiles']).is_relative_to(root):raise SystemExit('Keep profiles inside the private setup installation directory.')
    existing=systemctl('is-active','arbor-c3-direct.service',check=False).returncode==0
    legacy=Path(cfg['legacy_config']) if cfg.get('legacy_config') else None
    if existing and (legacy is None or not legacy.is_file()):raise SystemExit('Existing C3 gateway found; supply its private legacy_config before replacing its listener.')
    if legacy and legacy.exists():
        prior=json.loads(legacy.read_text())
        if prior['backend_url']!=cfg['backend_url']:raise SystemExit('Refusing an implicit backend/environment change for the existing reader.')
        if Path(prior['tls_cert']).resolve()!=Path(cfg['tls_cert']).resolve():raise SystemExit('Preserve the existing firmware TLS trust anchor.')
    if not args.apply:
        print(json.dumps({'validated':True,'applied':False,'existingGatewayPreserved':True}));return
    root.mkdir(parents=True,exist_ok=True,mode=0o700);root.chmod(0o700)
    environment=root/'venv'
    if not (environment/'bin/python').exists():venv.EnvBuilder(with_pip=True).create(environment)
    subprocess.run([str(environment/'bin/python'),'-m','pip','--disable-pip-version-check','--quiet','install','-r',str(source/'setup-requirements.txt')],check=True)
    # Verify the actual deployed application supports this gateway BEFORE any
    # listener/service switch. Failure leaves the old reader service running.
    from setup_agent import GatewayClient
    GatewayClient(cfg['backend_url'],cfg['gateway_id'],Path(cfg['gateway_secret_file']).read_text().strip()).poll([],[])
    profiles=Path(cfg['profiles']);profiles.mkdir(parents=True,exist_ok=True,mode=0o700)
    if legacy and legacy.exists():
        prior=json.loads(legacy.read_text())
        identity='usb-'+hashlib.sha256(('legacy:'+prior['backend_reader_id']).encode()).hexdigest()[:24]
        path=profiles/(identity+'.json')
        if not path.exists():private_json(path,{'deviceId':identity,'jobId':'legacy-adopted','readerId':prior['backend_reader_id'],
            'readerSecret':Path(prior['backend_reader_secret_file']).read_text().strip(),
            'linkKey':Path(prior['reader_link_key_file']).read_text().strip(),'backendUrl':prior['backend_url'],'activated':True})
    units=Path.home()/'.config/systemd/user';units.mkdir(parents=True,exist_ok=True)
    definitions={}
    for name,script in [('arbor-reader-network.service','setup_gateway.py'),('arbor-reader-setup.service','setup_agent.py')]:
        definition=f'''[Unit]
Description=ARBOR {'authenticated multi-reader TLS gateway' if script=='setup_gateway.py' else 'automatic reader discovery and setup'}
After=network-online.target
[Service]
WorkingDirectory={str(source).replace(chr(92), chr(92)+'x5c').replace(' ', chr(92)+'x20').replace(chr(34), chr(92)+'x22')}
ExecStart={json.dumps(str(environment/'bin/python'))} {json.dumps(str(source/script))} --config {json.dumps(str(config_path))}
Restart=on-failure
RestartSec=3
TimeoutStopSec=780
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths={json.dumps(str(root))}
[Install]
WantedBy=default.target
'''
        path=units/name
        if path.exists() and path.read_text()!=definition:
            previous=path.read_text().replace('WorkingDirectory='+json.dumps(str(source)),
                'WorkingDirectory='+str(source).replace(chr(92), chr(92)+'x5c').replace(' ', chr(92)+'x20').replace(chr(34), chr(92)+'x22'))
            if previous!=definition:raise SystemExit('Existing setup service differs; review the update before replacing its unit.')
        definitions[name]=definition
    # Validate the actual systemd syntax BEFORE stopping a working gateway.
    validation=root/'unit-validation';validation.mkdir(exist_ok=True,mode=0o700)
    for name,definition in definitions.items():(validation/name).write_text(definition)
    subprocess.run(['systemd-analyze','--user','verify',*[str(validation/name) for name in definitions]],
        capture_output=True,text=True,check=True)
    old_enabled=systemctl('is-enabled','arbor-c3-direct.service',check=False).stdout.strip()
    private_json(root/'installation-before.json',{'legacy_active':existing,'legacy_enabled':old_enabled})
    try:
        for name,definition in definitions.items():(units/name).write_text(definition)
        systemctl('daemon-reload')
        if existing:systemctl('stop','arbor-c3-direct.service')
        if old_enabled=='enabled':systemctl('disable','arbor-c3-direct.service')
        for name in definitions:systemctl('enable','--now',name)
        for name in definitions:
            if systemctl('is-active',name,check=False).stdout.strip()!='active':raise RuntimeError('Setup service did not start')
        trust=ssl.create_default_context(cafile=cfg['tls_cert'])
        for attempt in range(20):
            try:
                with socket.create_connection(('127.0.0.1',cfg.get('port',18443)),timeout=2) as connection:
                    with trust.wrap_socket(connection,server_hostname='arbor.device.rit.edu'):pass
                break
            except (OSError,ssl.SSLError):
                if attempt==19:raise RuntimeError('Reader TLS listener did not become ready')
                time.sleep(.25)
    except Exception:
        for name in definitions:systemctl('disable','--now',name,check=False)
        if old_enabled=='enabled':systemctl('enable','arbor-c3-direct.service',check=False)
        if existing:systemctl('start','arbor-c3-direct.service',check=False)
        raise
    print(json.dumps({'installed':True,'gateway':'connected','legacyProfilePreserved':bool(legacy and legacy.exists()),'bigReaderServiceChanged':False}))


if __name__=='__main__':main()
