"""Internal faults stay fail-closed but are logged by class and stage, never hidden.

Simulated clients only; no USB device, network, backend or reader is touched.
"""
from concurrent.futures import ThreadPoolExecutor
import contextlib
import hashlib
import hmac
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

from setup_agent import Agent, Task
from wireless.direct_gateway import PollProtocol
from wireless.reader_bridge import BridgeError

KEY = bytes(range(32))


def logged(output):
    return [json.loads(line) for line in output.getvalue().splitlines()]


class FastStop(threading.Event):
    def wait(self, timeout=None):
        return super().wait(0.01)


class SetupAgentFaultTests(unittest.TestCase):
    def test_task_join_logs_a_failure_without_raising_or_leaking_its_message(self):
        with ThreadPoolExecutor(max_workers=1) as executor:
            def fail():
                raise KeyError('private-ssid')
            failed = Task(executor.submit(fail))
            succeeded = Task(executor.submit(lambda: None))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                failed.join(2)
                succeeded.join(2)
            self.assertEqual(logged(output), [{'setupFault': 'KeyError', 'stage': 'task'}])
            self.assertNotIn('private-ssid', output.getvalue())

    def test_task_join_timeout_or_cancellation_is_not_reported_as_a_failure(self):
        with ThreadPoolExecutor(max_workers=1) as executor:
            release = threading.Event()
            running = Task(executor.submit(release.wait, 2))
            queued = executor.submit(lambda: None); queued.cancel()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                running.join(0.01)
                Task(queued).join(0.01)
            release.set(); running.join(2)
            self.assertEqual(output.getvalue(), '')

    def run_agent(self, poll_errors):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = MagicMock()
            agent = Agent({'state_dir': str(root / 'state'), 'profiles': str(root / 'profiles'),
                           'backend_url': 'https://backend.example'}, client=client)
            agent.network = MagicMock(); agent.network.devices.return_value = []
            agent.stop = FastStop()
            errors = list(poll_errors)
            def poll(*_):
                if not errors:
                    agent.stop.set()
                    return []
                raise errors.pop(0)
            client.poll.side_effect = poll
            output = io.StringIO()
            with patch('setup_agent.usb_devices', return_value={}), contextlib.redirect_stdout(output):
                agent.run()
            return logged(output)

    def test_internal_poll_fault_is_logged_once_and_the_loop_keeps_failing_closed(self):
        lines = self.run_agent([KeyError('jobs'), KeyError('jobs'), TypeError('x')])
        self.assertEqual(lines, [{'setupFault': 'KeyError', 'stage': 'poll'},
                                 {'setupService': 'gateway_unavailable'},
                                 {'setupFault': 'TypeError', 'stage': 'poll'},
                                 {'setupService': 'connected'}])

    def test_expected_transport_faults_are_ordinary_gateway_outages(self):
        lines = self.run_agent([urllib.error.URLError('offline'), TimeoutError(), ValueError('Invalid setup response')])
        self.assertEqual(lines, [{'setupService': 'gateway_unavailable'}, {'setupService': 'connected'}])


class GatewayFaultTests(unittest.TestCase):
    def poll(self, backend):
        with tempfile.TemporaryDirectory() as directory:
            protocol = PollProtocol(KEY, backend, str(Path(directory) / 'status.json'))
            raw = json.dumps({'type': 'reader_poll', 'session': '1234abcd', 'nonce': 'f' * 32, 'counter': 1,
                              'scan_id': 3, 'uptime_ms': 100, 'reader_ready': True, 'pending': True,
                              'uid': '01020304'}, separators=(',', ':')).encode()
            signature = hmac.new(KEY, b'reader-poll\n' + raw, hashlib.sha256).hexdigest()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                reply = json.loads(protocol.poll(raw, signature))
            return reply, protocol, logged(output)

    def test_decision_faults_fail_closed_and_only_internal_ones_are_logged(self):
        for error, expected in [(BridgeError('backend_decision_invalid'), []),
                                (urllib.error.URLError('offline'), []),
                                (TypeError('01020304'), [{'gatewayFault': 'TypeError', 'stage': 'decision'}])]:
            backend = MagicMock(); backend.health.return_value = True; backend.decide.side_effect = error
            reply, protocol, lines = self.poll(backend)
            with self.subTest(type(error).__name__):
                self.assertFalse(reply['ready'])
                self.assertEqual(reply['reason'], 'authorization_failed')
                self.assertNotIn('command', reply)
                self.assertFalse(protocol.healthy)
                self.assertEqual(lines, expected)

    def test_health_faults_fail_closed_and_only_internal_ones_are_logged(self):
        for error, expected in [(BridgeError('backend_heartbeat_invalid'), []),
                                (OSError('offline'), []),
                                (AttributeError('x'), [{'gatewayFault': 'AttributeError', 'stage': 'health'}])]:
            backend = MagicMock(); backend.health.side_effect = error
            reply, _protocol, lines = self.poll(backend)
            with self.subTest(type(error).__name__):
                self.assertFalse(reply['ready'])
                self.assertEqual(reply['reason'], 'backend_unavailable')
                backend.decide.assert_not_called()
                self.assertEqual(lines, expected)


if __name__ == '__main__':
    unittest.main()
