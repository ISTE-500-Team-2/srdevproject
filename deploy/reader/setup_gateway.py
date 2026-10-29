"""One existing TLS listener, independent HMAC/backend identity per reader.

Private profile files are installed only after USB pairing. An unauthenticated
LAN advertisement never receives credentials or an access decision.
"""
import argparse
import hashlib
import hmac
import json
from pathlib import Path
import re
import signal
import ssl
import threading
import time

from wireless.direct_gateway import PollProtocol, Server
from wireless.reader_bridge import BackendClient


class Profiles:
    def __init__(self, root, backend_url):
        self.root, self.backend_url = Path(root), backend_url
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock, self.entries = threading.Lock(), {}

    def refresh(self):
        files = list(self.root.glob('usb-*.json'))[:32]
        live = set()
        for path in files:
            if not re.fullmatch(r'usb-[a-f0-9]{24}\.json', path.name): continue
            try:
                raw = path.read_bytes()
                if len(raw)>8192 or path.is_symlink(): continue
                cfg = json.loads(raw)
                if (cfg.get('backendUrl')!=self.backend_url or not re.fullmatch('[a-f0-9]{64}', cfg.get('linkKey',''))
                    or not re.fullmatch('[a-f0-9]{64}',cfg.get('readerSecret',''))
                    or not re.fullmatch('[a-zA-Z0-9_-]{1,64}',cfg.get('readerId',''))): continue
                key = bytes.fromhex(cfg['linkKey'])
                digest = hashlib.sha256(raw).hexdigest()
                live.add(path.stem)
                previous = self.entries.get(path.stem)
                if previous and previous[0]==digest: continue
                if previous and previous[1].key==key and previous[1].backend.reader_id==cfg['readerId'] and previous[1].backend.secret==cfg['readerSecret']:
                    # Activation refreshes backend mode promptly, preserving replay state.
                    previous[1].health_at = 0
                    self.entries[path.stem] = digest, previous[1]
                    continue
                client = BackendClient(self.backend_url,cfg['readerId'],cfg['readerSecret'],check_in=True)
                protocol = PollProtocol(key,client,str(self.root/(path.stem+'.status')))
                protocol.profile_generation=hashlib.sha256(key).hexdigest()
                self.entries[path.stem] = digest, protocol
            except (OSError, ValueError, TypeError, KeyError):
                continue
        for key in set(self.entries)-live:
            self.entries.pop(key,None)

    def signed_poll(self, raw, signature):
        with self.lock:
            self.refresh()
            protocols = [entry[1] for entry in self.entries.values()]
        for protocol in protocols:
            if hmac.compare_digest(protocol.mac(b'reader-poll',raw),signature):
                body = protocol.poll(raw,signature)
                return body, protocol.mac(b'gateway-reply',body)
        raise ValueError('unauthorized')

    def watchdog(self, stop):
        from wireless.reader_bridge import write_status
        while not stop.wait(1):
            with self.lock:
                self.refresh()
                protocols = [entry[1] for entry in self.entries.values()]
            for protocol in protocols:
                with protocol.lock:
                    if time.monotonic()-protocol.last_seen>4:
                        write_status(protocol.status_file,False,False,'reader_offline',None,protocol.last_result)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',required=True)
    cfg=json.loads(Path(parser.parse_args().config).read_text())
    protocols=Profiles(cfg['profiles'],cfg['backend_url'])
    server=Server(('0.0.0.0',cfg.get('port',18443)),protocols)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version=ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cfg['tls_cert'],cfg['tls_key'])
    server.socket=context.wrap_socket(server.socket,server_side=True,do_handshake_on_connect=False)
    stop=threading.Event()
    threading.Thread(target=protocols.watchdog,args=(stop,),daemon=True).start()
    def close(*_):
        stop.set()
        threading.Thread(target=server.shutdown,daemon=True).start()
    for sig in (signal.SIGINT,signal.SIGTERM):signal.signal(sig,close)
    try:server.serve_forever(poll_interval=.2)
    finally:
        stop.set();server.server_close();server.pool.shutdown(wait=True)


if __name__=='__main__':main()
