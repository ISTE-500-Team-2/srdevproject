"""TLS/HMAC outbound-reader gateway; backend credentials remain on the Pi."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import argparse
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import signal
import socket
import ssl
import threading
import time

from .reader_bridge import BackendClient, body_json, write_status


class PollProtocol:
    def __init__(self, key, backend, status_file, identity_file=None):
        if len(key) != 32:
            raise ValueError('32-byte link key required')
        self.key, self.backend, self.status_file = key, backend, status_file
        self.identity_file = identity_file
        self.lock = threading.Lock()
        self.sessions = OrderedDict()
        self.health_at = 0
        self.healthy = False
        self.last_result = None
        self.last_seen = 0
        self.last_scan = None

    def mac(self, domain, body):
        return hmac.new(self.key, domain + b'\n' + body, hashlib.sha256).hexdigest()

    def poll(self, raw, signature):
        if len(raw) > 2048 or not hmac.compare_digest(self.mac(b'reader-poll', raw), signature):
            raise ValueError('unauthorized')
        v = json.loads(raw)
        if not isinstance(v, dict) or v.get('type') != 'reader_poll':
            raise ValueError('invalid_message')
        if not re.fullmatch('[0-9a-f]{8}', str(v.get('session', ''))) or not re.fullmatch('[0-9a-f]{32}', str(v.get('nonce', ''))):
            raise ValueError('invalid_identity')
        for name in ('counter', 'scan_id', 'uptime_ms'):
            if type(v.get(name)) is not int or not 0 <= v[name] <= 0xffffffff:
                raise ValueError('invalid_counter')
        if v['counter'] == 0 or type(v.get('pending')) is not bool or type(v.get('reader_ready')) is not bool:
            raise ValueError('invalid_state')
        if v['pending'] and (not isinstance(v.get('uid'), str) or not re.fullmatch('(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{14}|[A-Fa-f0-9]{20})', re.sub('[: -]', '', v['uid']))):
            raise ValueError('invalid_uid')
        with self.lock:
            entry = self.sessions.get(v['session'], {'counter': 0, 'scan': -1, 'handled': None})
            if v['counter'] <= entry['counter'] or v['scan_id'] < entry['scan']:
                raise ValueError('replay')
            entry.update(counter=v['counter'], scan=v['scan_id'])
            self.sessions[v['session']] = entry
            self.sessions.move_to_end(v['session'])
            while len(self.sessions) > 64:
                self.sessions.popitem(last=False)
            self.last_seen = time.monotonic()
            now = time.monotonic()
            if now >= self.health_at:
                try:
                    self.healthy = self.backend.health()
                except Exception:
                    self.healthy = False
                self.health_at = time.monotonic() + 10
            reason = 'ready' if self.healthy else 'backend_unavailable'
            reply = {k: v[k] for k in ('session', 'nonce', 'counter')}
            reply.update(type='gateway_reply', ready=self.healthy and v['reader_ready'])
            if reply['ready'] and v['pending'] and entry['handled'] != v['scan_id']:
                entry['handled'] = v['scan_id']
                try:
                    result = self.backend.decide(v['uid'])
                    result.update(readerSession=v['session'], scanId=v['scan_id'])
                    self.last_result = result
                    self.last_scan = {'session': v['session'], 'scan_id': v['scan_id']}
                    if 'member' in result:
                        reply['member'] = result['member']
                        if self.identity_file:
                            target = Path(self.identity_file)
                            proof = {k: result[k] for k in ('eventId','decisionId','uidFingerprint','member','checkInRequested')}
                            proof.update(self.last_scan, observed_at=time.time(), transport='authenticated-outbound-reader-https')
                            temp = target.with_suffix('.tmp')
                            temp.write_text(json.dumps(proof)+'\n')
                            temp.chmod(0o600)
                            temp.replace(target)
                    command = {'type': 'access_decision', 'scan_id': v['scan_id'], 'decision': 'approved' if result['allowed'] else 'denied'}
                    if result['allowed']:
                        remaining = int((result['valid_until'] - time.monotonic()) * 1000) - 50
                        if remaining <= 0:
                            raise ValueError('expired')
                        command['grant_ms'] = min(2000, remaining)
                    reply['command'] = command
                    reason = result['reason']
                except Exception:
                    reply['ready'] = self.healthy = False
                    self.health_at = 0
                    reason = 'authorization_failed'
            reply['reason'] = reason
            write_status(self.status_file, True, reply['ready'], reason, v, self.last_result)
            return body_json(reply)

    def offline_watchdog(self, stop):
        while not stop.wait(1):
            with self.lock:
                if time.monotonic() - self.last_seen > 4:
                    write_status(self.status_file, False, False, 'reader_offline', None, self.last_result)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, protocol):
        self.protocol = protocol
        self.slots = threading.BoundedSemaphore(8)
        self.pool = ThreadPoolExecutor(max_workers=8)
        self.connections = set()
        self.connection_lock = threading.Lock()
        self.stopping = False
        super().__init__(address, Handler)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        with self.connection_lock:
            self.connections.add(request)
        def work():
            try:
                # Handshake off the accept thread; a slow peer cannot block all readers.
                request.settimeout(3)
                request.do_handshake()
                self.finish_request(request, address)
            except Exception:
                pass
            finally:
                self.shutdown_request(request)
                with self.connection_lock:
                    self.connections.discard(request)
                self.slots.release()
        self.pool.submit(work)

    def shutdown(self):
        self.stopping = True
        with self.connection_lock:
            for request in list(self.connections):
                try:
                    request.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        super().shutdown()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass  # Never log UID payloads, signatures or reader IPs.

    def do_POST(self):
        if self.server.stopping:
            self.close_connection = True
            self.send_error(503)
            return
        if self.path != '/v1/poll':
            self.send_error(404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2048 or self.headers.get('Transfer-Encoding'):
                raise ValueError('invalid_size')
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('incomplete')
            body = self.server.protocol.poll(raw, self.headers.get('X-Arbor-Signature', ''))
        except (ValueError, TypeError, KeyError):
            self.send_error(401)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Arbor-Signature', self.server.protocol.mac(b'gateway-reply', body))
        self.end_headers()
        self.wfile.write(body)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--config', required=True)
    args = p.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    backend = BackendClient(cfg['backend_url'], cfg['backend_reader_id'], Path(cfg['backend_reader_secret_file']).read_text().strip(), check_in=cfg.get('record_check_in', False))
    protocol = PollProtocol(bytes.fromhex(Path(cfg['reader_link_key_file']).read_text().strip()), backend, cfg['status_file'], cfg.get('identity_proof_file'))
    server = Server(('0.0.0.0', cfg.get('port', 18443)), protocol)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cfg['tls_cert'], cfg['tls_key'])
    server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    stop = threading.Event()
    threading.Thread(target=protocol.offline_watchdog, args=(stop,), daemon=True).start()
    def halt(*_):
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, halt)
    print(json.dumps({'transport': 'direct-https', 'port': server.server_address[1], 'actuationEnabled': False}), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        stop.set()
        server.server_close()
        server.pool.shutdown(wait=True)


if __name__ == '__main__':
    main()
