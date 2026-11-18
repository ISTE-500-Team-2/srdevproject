"""Gateways report reader link health in the signed heartbeat.
Simulated openers and clocks only; no reader hardware or backend is contacted.
"""
import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from wireless.direct_gateway import PollProtocol
from wireless.reader_bridge import BackendClient, health_report

SECRET = 'x' * 32
KEY = b'k' * 32


class Response:
    def __init__(self, raw): self.raw = raw
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, limit): return self.raw[:limit]


def heartbeat_server(sent):
    def opener(request, timeout):
        body = json.loads(request.data)
        sent.append(body)
        return Response(json.dumps({'data': {
            'eventId': body['eventId'], 'readerId': 'reader-1', 'mode': 'access', 'allowed': False,
            'reason': 'HEARTBEAT', 'expiresAt': None, 'leaseSeconds': 0}}).encode())
    return opener


class HealthReportTests(unittest.TestCase):
    def test_reachable_reader_forwards_only_well_formed_values(self):
        state = {'reader_ready': True, 'state': 'locked', 'uptime_ms': 1234, 'version': '1.8.0-classic-pi',
                 'wifi_rssi': -78, 'uid': 'AABBCCDD', 'session': '0123abcd'}
        self.assertEqual(health_report(True, 412.7, state, '129.21.41.118'), {'reader': {
            'reachable': True, 'lastContactMs': 412, 'ready': True, 'doorState': 'locked', 'uptimeMs': 1234,
            'firmware': '1.8.0-classic-pi', 'rssi': -78, 'address': '129.21.41.118'}})

    def test_malformed_values_are_omitted_not_guessed(self):
        state = {'reader_ready': 'yes', 'state': 'open', 'uptime_ms': -1, 'version': 'bad version!',
                 'wifi_rssi': 5}
        self.assertEqual(health_report(True, None, state, 'nfc-reader.local'), {'reader': {'reachable': True}})
        self.assertEqual(health_report(True, -3, {'wifi_rssi': True}), {'reader': {'reachable': True}})

    def test_unreachable_reader_reports_no_stale_state(self):
        state = {'reader_ready': True, 'state': 'locked', 'wifi_rssi': -60}
        self.assertEqual(health_report(False, 21_000, state, '129.21.41.118'),
                         {'reader': {'reachable': False, 'lastContactMs': 21000}})

    def test_heartbeat_signs_the_health_report_with_the_body(self):
        sent = []
        client = BackendClient('https://backend.example', 'reader-1', SECRET, heartbeat_server(sent))
        self.assertTrue(client.health(health_report(False, 5000)))
        self.assertTrue(client.health())
        self.assertEqual(sent[0]['action'], 'heartbeat')
        self.assertEqual(sent[0]['health'], {'reader': {'reachable': False, 'lastContactMs': 5000}})
        self.assertNotIn('health', sent[1])


class DirectGatewayHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.backend = MagicMock()
        self.backend.health.return_value = True
        self.protocol = PollProtocol(KEY, self.backend, str(Path(self.temp.name) / 'status.json'))
        self.counter = 0

    def tearDown(self):
        self.temp.cleanup()

    def poll(self, peer='129.21.40.212', **change):
        self.counter += 1
        body = json.dumps({'type': 'reader_poll', 'session': '0123abcd', 'nonce': 'a' * 32,
                           'counter': self.counter, 'scan_id': 0, 'pending': False,
                           'reader_ready': True, 'uptime_ms': 5000, **change}).encode()
        return self.protocol.poll(body, hmac.new(KEY, b'reader-poll\n' + body, hashlib.sha256).hexdigest(), peer)

    def test_poll_reports_the_reader_reachable_with_its_address(self):
        with patch('wireless.direct_gateway.time.monotonic', return_value=100.0):
            self.poll()
        self.backend.health.assert_called_once_with({'reader': {
            'reachable': True, 'lastContactMs': 0, 'ready': True, 'uptimeMs': 5000, 'address': '129.21.40.212'}})

    def test_silent_reader_is_reported_unreachable_then_announced_back_at_once(self):
        clock = [100.0]
        with patch('wireless.direct_gateway.time.monotonic', side_effect=lambda: clock[0]):
            self.protocol.started = 0
            self.poll()
            self.backend.health.reset_mock()
            clock[0] = 103.0
            self.protocol.report_offline()  # Still within the 4 s window.
            self.backend.health.assert_not_called()
            clock[0] = 111.0
            self.protocol.report_offline()
            self.backend.health.assert_called_once_with({'reader': {'reachable': False, 'lastContactMs': 11000}})
            clock[0] = 115.0
            self.protocol.report_offline()  # Heartbeat rate, not every watchdog tick.
            self.assertEqual(self.backend.health.call_count, 1)
            clock[0] = 116.0
            self.poll()  # Returning reader: reported reachable without waiting 10 s.
            self.assertEqual(self.backend.health.call_count, 2)
            self.assertTrue(self.backend.health.call_args[0][0]['reader']['reachable'])

    def test_fresh_gateway_waits_for_its_reader_before_reporting_it_offline(self):
        with patch('wireless.direct_gateway.time.monotonic', return_value=self.protocol.started + 6):
            self.protocol.report_offline()
        self.backend.health.assert_not_called()

    def test_backend_failure_while_offline_never_raises(self):
        self.backend.health.side_effect = OSError('network down')
        self.protocol.started = 0
        with patch('wireless.direct_gateway.time.monotonic', return_value=500.0):
            self.protocol.report_offline()
        self.backend.health.assert_called_once()


if __name__ == '__main__':
    unittest.main()
