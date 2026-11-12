"""Release/smoke checks must fail closed even under python -O. No real Docker or network."""
import ast
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import auto_release as release

HERE = Path(__file__).resolve().parent
SHA = 'a' * 40


def http_error(code):
    return urllib.error.HTTPError('http://fixture/api/admin/users', code, 'fixture', {}, io.BytesIO(b'{}'))


class Response(io.BytesIO):
    def __init__(self, body=b'', status=200):
        super().__init__(body)
        self.status = status


def fake_request(health=None, data=True, anonymous=None):
    def request(origin, path, data_=None, token=None, origin_header=None):
        if path == '/api/health':
            return {'data': health or {'status': 'ok', 'database': 'connected'}}
        if path == '/api/auth/demo':
            return {'data': {'accessToken': 'fixture'}}
        if token is None and path == '/api/admin/users':
            if anonymous is None:
                raise http_error(401)
            if isinstance(anonymous, int):
                raise http_error(anonymous)
            return anonymous
        return {'data': {}} if data else {}
    return request


def fake_urlopen(html=b'<script src="/assets/app.js"></script>', asset_status=200):
    def urlopen(url, timeout=None):
        if url.endswith('/'):
            return Response(html)
        return Response(b'', asset_status)
    return urlopen


class ReleaseCheckTests(unittest.TestCase):
    def verify(self, request=None, urlopen=None):
        with patch.object(release, 'request', request or fake_request()), \
                patch.object(release.urllib.request, 'urlopen', urlopen or fake_urlopen()):
            release.verify(Path('/nonexistent'), 'http://127.0.0.1:8081', demo=True)

    def test_healthy_fixture_passes(self):
        self.verify()

    def test_each_failed_smoke_check_raises_release_check_error(self):
        cases = {
            'Database health failed': dict(request=fake_request(health={'status': 'ok', 'database': 'down'})),
            '/api/auth/session': dict(request=fake_request(data=False)),
            'Frontend assets missing': dict(urlopen=fake_urlopen(html=b'<html></html>')),
            '/assets/app.js': dict(urlopen=fake_urlopen(asset_status=204)),
            'Anonymous admin access allowed': dict(request=fake_request(anonymous={'data': []})),
            'Anonymous admin access did not fail closed': dict(request=fake_request(anonymous=403)),
        }
        for message, overrides in cases.items():
            with self.subTest(message), self.assertRaises(release.ReleaseCheckError) as raised:
                self.verify(**overrides)
            self.assertEqual(str(raised.exception), message)
            self.assertIsInstance(raised.exception, RuntimeError)

    def test_fetched_revision_mismatch_stops_before_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            def output(*args):
                return 'b' * 40 if 'FETCH_HEAD' in args else ''
            with patch.object(release, 'output', output), patch.object(release, 'run') as run, \
                    self.assertRaisesRegex(release.ReleaseCheckError, 'Fetched release revision mismatch'):
                release.prepare_artifact(Path(temporary), SHA)
            self.assertFalse(any('checkout' in call.args for call in run.call_args_list))

    def test_empty_backup_raises_release_check_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(release, 'output', return_value='[]'), \
                    patch.object(release, 'verify_migrations'), patch.object(release, 'run'), \
                    self.assertRaisesRegex(release.ReleaseCheckError, 'Empty backup'):
                release.backup_databases(Path(temporary), Path(temporary))

    def test_no_assert_statements_remain(self):
        tree = ast.parse((HERE / 'auto_release.py').read_text())
        self.assertEqual([node.lineno for node in ast.walk(tree) if isinstance(node, ast.Assert)], [])

    def test_failed_check_raises_under_python_optimize(self):
        probe = (
            'import sys\n'
            'assert sys.flags.optimize >= 1\n'  # stripped under -O; the flag check below is real
            'if sys.flags.optimize < 1: sys.exit(3)\n'
            'import auto_release as release\n'
            'release.request = lambda *a, **k: {"data": {"status": "ok", "database": "down"}}\n'
            'try:\n'
            '    release.verify(None, "http://127.0.0.1:9", demo=True)\n'
            'except release.ReleaseCheckError as error:\n'
            '    print("raised:", error)\n'
            '    sys.exit(0)\n'
            'sys.exit(4)\n'
        )
        for flag in ('-O', '-OO'):
            with self.subTest(flag):
                result = subprocess.run([sys.executable, flag, '-c', probe], cwd=HERE, capture_output=True,
                                        text=True, timeout=60, env={'PATH': '/usr/bin:/bin', 'PYTHONPATH': str(HERE)})
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('raised: Database health failed', result.stdout)


if __name__ == '__main__':
    unittest.main()
