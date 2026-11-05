"""Fresh, narrowly scoped GitHub status reads through the owner's local gh login.

No token is read, printed, copied to RLES or placed in a URL/argument. The
temporary SSH reverse listener binds only loopback and has no write endpoints.
"""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import subprocess
import threading
import time
import urllib.request

REPO = 'ISTE-500-Team-2/srdevproject'
PORT = 39393


def allowed(path):
    return bool(re.fullmatch(r'(commits/[a-f0-9]{40}/check-runs\?per_page=100|'
                             r'actions/runs\?head_sha=[a-f0-9]{40}&event=push&branch=main&per_page=100)', path))


def read_local_status(path):
    if not allowed(path):
        raise ValueError('Only exact project CI-status reads are allowed')
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/' + path, timeout=25) as response:
        return json.load(response)


def compact_status(path, value):
    """Preserve every gate input/record; omit unused logos, URLs and repo copies."""
    if not allowed(path) or not isinstance(value, dict):
        raise ValueError('Invalid status response')
    key = 'check_runs' if path.startswith('commits/') else 'workflow_runs'
    if not isinstance(value.get(key), list):
        raise ValueError('Status records missing')
    fields = (('id', 'name', 'head_sha', 'status', 'conclusion') if key == 'check_runs'
              else ('id', 'head_sha', 'head_branch', 'event', 'path', 'status', 'conclusion', 'run_attempt'))
    records = []
    for original in value[key]:
        if not isinstance(original, dict):
            raise ValueError('Invalid status record')
        record = {name: original[name] for name in fields if name in original}
        if key == 'check_runs' and 'app' in original:
            if not isinstance(original['app'], dict):
                raise ValueError('Invalid provider identity')
            record['app'] = {'slug': original['app'].get('slug')}
        records.append(record)
    return {key: records, **({'total_count': value['total_count']} if 'total_count' in value else {})}


class StatusHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        path = self.path.removeprefix('/')
        if path == 'health':
            body = b'{"provider":"owner-local-gh","repo":"ISTE-500-Team-2/srdevproject"}'
        elif allowed(path):
            try:
                result = subprocess.run(['gh', 'api', '--hostname', 'github.com', 'repos/' + REPO + '/' + path],
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
            except subprocess.SubprocessError:
                self.send_error(503, 'GitHub status read unavailable')
                return
            if result.returncode:
                self.send_error(503, 'GitHub status read failed')
                return
            try:
                data = compact_status(path, json.loads(result.stdout))
            except ValueError:
                self.send_error(503, 'Invalid GitHub status response')
                return
            body = json.dumps(data, separators=(',', ':')).encode()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@contextmanager
def github_bridge(host):
    server = ThreadingHTTPServer(('127.0.0.1', 0), StatusHandler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    forward = f'127.0.0.1:{PORT}:127.0.0.1:{server.server_port}'
    ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
    forwarded = False
    try:
        # Reuse the owner's established SSH connection, but explicitly acquire
        # and cancel OUR forwarding rule. Never terminate a shared SSH master.
        subprocess.run([*ssh, host, 'true'], check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
        subprocess.run([*ssh, '-o', 'ExitOnForwardFailure=yes', '-O', 'forward', '-R', forward, host],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        forwarded = True
        probe = ("import urllib.request,json;v=json.load(urllib.request.urlopen("
                 f"'http://127.0.0.1:{PORT}/health',timeout=3));"
                 "assert v=={'provider':'owner-local-gh','repo':'ISTE-500-Team-2/srdevproject'}")
        import shlex
        subprocess.run([*ssh, host, 'python3 -c ' + shlex.quote(probe)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        yield
    finally:
        try:
            if forwarded:
                subprocess.run([*ssh, '-O', 'cancel', '-R', forward, host], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        finally:
            server.shutdown(); server.server_close()
