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
                json.loads(result.stdout)
            except ValueError:
                self.send_error(503, 'Invalid GitHub status response')
                return
            body = result.stdout
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
    tunnel = subprocess.Popen(['ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
                               '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
                               '-o', 'ExitOnForwardFailure=yes', '-R',
                               f'127.0.0.1:{PORT}:127.0.0.1:{server.server_port}', host],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        # A real remote read proves tunnel readiness; process launch alone is
        # not treated as a working channel. Never expose a public listener.
        probe = ("import urllib.request,json;v=json.load(urllib.request.urlopen("
                 f"'http://127.0.0.1:{PORT}/health',timeout=2));"
                 "assert v=={'provider':'owner-local-gh','repo':'ISTE-500-Team-2/srdevproject'}")
        import shlex
        deadline = time.monotonic() + 8
        while True:
            if tunnel.poll() is not None:
                raise RuntimeError('Cannot open the private local GitHub-status SSH tunnel')
            ready = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', host,
                                    'python3 -c ' + shlex.quote(probe)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Local GitHub-status tunnel did not become ready')
            time.sleep(0.1)
        yield
    finally:
        tunnel.terminate()
        try:
            tunnel.wait(timeout=5)
        except subprocess.TimeoutExpired:
            tunnel.kill(); tunnel.wait(timeout=5)
        server.shutdown(); server.server_close()
