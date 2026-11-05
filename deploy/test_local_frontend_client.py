"""Real executor ordering with mocked process boundaries; never contacts prod."""
from contextlib import contextmanager, redirect_stdout
import io
import os
from pathlib import Path
import tempfile
import threading
import time
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import local_frontend as client

SHA = 'a' * 40
TREE = 'b' * 40


class ClientOrderingTests(unittest.TestCase):
    def exercise(self, fail):
        started = threading.Event(); prepared = threading.Event(); lock = threading.Lock()
        local_count = 0; remote_calls = []
        @contextmanager
        def bridge(_host):
            self.assertTrue(started.wait(2), 'Local checks must already run while connection setup starts')
            yield
        def run(command, **kwargs):
            nonlocal local_count
            if command[0] == 'npm':
                with lock:
                    local_count += 1
                    if local_count == 3: started.set()
                kwargs['stdout'].write(b'fixture verification output\n')
                return SimpleNamespace(returncode=1 if fail and 'test:integration' in command else 0)
            self.assertEqual(command[0], 'ssh')
            remote_calls.append(command[-1])
            if '--prepare' in command[-1]:
                time.sleep(0.03)
                prepared.set()
            if '--abort-prewarm' in command[-1]:
                self.assertTrue(prepared.is_set(), 'Cleanup must wait until preparation settles')
            return SimpleNamespace(returncode=0)
        def output(*args, **_kwargs):
            if args[0] == 'node': return 'v24.22.1'
            return TREE if 'HEAD^{tree}' in args else SHA
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            argv = ['local_frontend.py', '--source', str(root / 'source'),
                    '--evidence-dir', str(root / 'evidence'), '--rehearse']
            with patch.object(sys, 'argv', argv), \
                 patch.dict(os.environ, {'PGHOST': '127.0.0.1', 'DATABASE_URL': ''}), \
                 patch.object(client, 'output', side_effect=output), \
                 patch.object(client, 'pristine', return_value=SHA), \
                 patch.object(client.platform, 'system', return_value='Darwin'), \
                 patch.object(client.platform, 'machine', return_value='arm64'), \
                 patch.object(client, 'github_bridge', bridge), \
                 patch.object(client.subprocess, 'run', side_effect=run), redirect_stdout(io.StringIO()):
                if fail:
                    with self.assertRaises(RuntimeError): client.main()
                else:
                    client.main()
            if fail:
                self.assertTrue(any('--abort-prewarm' in c for c in remote_calls))
                self.assertFalse(any('--accept-evidence' in c for c in remote_calls))
            else:
                self.assertTrue(any('--accept-evidence' in c for c in remote_calls))
                self.assertFalse(any('--abort-prewarm' in c for c in remote_calls))
            self.assertEqual(local_count, 3)

    def test_checks_start_before_network_setup(self):
        self.exercise(False)

    def test_failed_checks_settle_preparation_before_cleanup_and_never_activate(self):
        self.exercise(True)


if __name__ == '__main__':
    unittest.main()
