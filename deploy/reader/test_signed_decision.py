"""Both signed backend clients share one transport and canonical response checks.

Simulated openers only; no reader hardware or backend is contacted.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from access_client import AccessClient
from wireless.reader_bridge import BackendClient, BridgeError

SECRET = 'x' * 32


class Response:
    def __init__(self, raw): self.raw = raw
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, limit): return self.raw[:limit]


def server(shape, sent):
    """Opener answering like /api/devices/decision; shape(body) builds the reply."""
    def opener(request, timeout):
        sent.append((request, timeout))
        reply = shape(json.loads(request.data))
        return Response(reply if isinstance(reply, bytes) else json.dumps(reply).encode())
    return opener


def heartbeat(body, **change):
    return {'data': {'eventId': body['eventId'], 'readerId': 'reader-1', 'mode': 'access',
                     'enrollmentExpiresAt': None, 'allowed': False, 'reason': 'HEARTBEAT',
                     'expiresAt': None, 'leaseSeconds': 0, **change}}


def grant(body, **change):
    expires = (datetime.now(timezone.utc) + timedelta(seconds=4)).isoformat().replace('+00:00', 'Z')
    return {'data': {'eventId': body['eventId'], 'decisionId': 7, 'readerId': 'reader-1', 'mode': 'access',
                     'allowed': True, 'reason': 'ELIGIBLE', 'expiresAt': expires, 'leaseSeconds': 4,
                     'member': None, **change}}


def clients(shape):
    sent = []
    opener = server(shape, sent)
    return (AccessClient('https://backend.example', 'reader-1', SECRET, opener),
            BackendClient('https://backend.example', 'reader-1', SECRET, opener)), sent


class SignedDecisionTests(unittest.TestCase):
    def test_both_clients_sign_the_same_request_contract(self):
        (relay, gateway), sent = clients(heartbeat)
        relay.status()
        gateway.health()
        for request, timeout in sent:
            stamp = request.get_header('X-reader-timestamp')
            expected = hmac.new(SECRET.encode(), stamp.encode() + b'\n' + request.data, hashlib.sha256).hexdigest()
            self.assertEqual(request.get_header('X-reader-signature'), expected)
            self.assertEqual(request.get_header('X-reader-id'), 'reader-1')
            self.assertEqual(request.full_url, 'https://backend.example/api/devices/decision')
            self.assertEqual(request.get_method(), 'POST')
            self.assertEqual(timeout, 1.8)
            self.assertEqual(json.loads(request.data)['action'], 'heartbeat')
        first, second = (json.loads(request.data)['eventId'] for request, _ in sent)
        self.assertNotEqual(first, second)

    def test_canonical_response_failures_are_rejected_by_both_clients(self):
        cases = {
            'identity': lambda body: heartbeat(body, eventId='other'),
            'reader': lambda body: heartbeat(body, readerId='other'),
            'envelope': lambda body: heartbeat(body)['data'],
            'data': lambda body: {'data': []},
            'json': lambda body: b'not json',
            'oversized': lambda body: b' ' * 16385,
        }
        for name, shape in cases.items():
            (relay, gateway), _ = clients(shape)
            with self.subTest(name):
                with self.assertRaises(ValueError):
                    relay.status()
                with self.assertRaises(BridgeError) as raised:
                    gateway.health()
                self.assertEqual(raised.exception.args[0],
                                 'response_too_large' if name == 'oversized' else 'backend_heartbeat_invalid')

    def test_late_reply_keeps_each_clients_error_type(self):
        (relay, gateway), _ = clients(heartbeat)
        with patch('signed_decision.time.monotonic', side_effect=[0, 1.8]):
            with self.assertRaises(TimeoutError):
                relay.status()
        with patch('signed_decision.time.monotonic', side_effect=[0, 1.8]):
            with self.assertRaisesRegex(BridgeError, 'backend_heartbeat_invalid'):
                gateway.health()

    def test_a_heartbeat_that_claims_a_grant_is_rejected_by_both_clients(self):
        for change in ({'allowed': True}, {'leaseSeconds': 5}, {'reason': 'ELIGIBLE'}, {'mode': 'open'}):
            (relay, gateway), _ = clients(lambda body: heartbeat(body, **change))
            with self.subTest(change):
                with self.assertRaises(ValueError):
                    relay.status()
                with self.assertRaisesRegex(BridgeError, 'backend_heartbeat_invalid'):
                    gateway.health()

    def test_both_clients_accept_the_servers_grant_and_bound_it(self):
        (relay, gateway), _ = clients(grant)
        self.assertTrue(0 < relay.decide('01020304') <= 4)
        result = gateway.decide('01020304')
        self.assertTrue(result['allowed'])
        self.assertEqual(result['reason'], 'ELIGIBLE')
        self.assertEqual(result['decisionId'], 7)

    def test_malformed_decision_fields_are_rejected_by_both_clients(self):
        naive = (datetime.now(timezone.utc) + timedelta(seconds=4)).replace(tzinfo=None).isoformat()
        cases = [({'allowed': 'yes'}, 'backend_decision_invalid'),
                 ({'allowed': 1}, 'backend_decision_invalid'),
                 ({'reason': 'R' * 101}, 'backend_reason_invalid'),
                 ({'reason': 5}, 'backend_reason_invalid'),
                 ({'leaseSeconds': True}, 'backend_lease_invalid'),
                 ({'leaseSeconds': float('nan')}, 'backend_lease_invalid'),
                 ({'expiresAt': naive}, 'backend_expiry_invalid'),
                 ({'expiresAt': 'tomorrow'}, 'backend_expiry_invalid'),
                 ({'expiresAt': None}, 'backend_expiry_invalid')]
        for change, code in cases:
            (relay, gateway), _ = clients(lambda body: grant(body, **change))
            with self.subTest(change):
                with self.assertRaises(ValueError):
                    relay.decide('01020304')
                with self.assertRaisesRegex(BridgeError, code):
                    gateway.decide('01020304')

    def test_lease_range_stays_client_policy(self):
        # The relay client clamps a lease to its own 5-second bound; the gateway
        # rejects anything outside (0, 5]. Both fail closed for a zero lease.
        for lease in (0, 6):
            (relay, gateway), _ = clients(lambda body: grant(body, leaseSeconds=lease))
            with self.subTest(lease):
                self.assertLessEqual(relay.decide('01020304'), 5)
                with self.assertRaisesRegex(BridgeError, 'backend_lease_invalid'):
                    gateway.decide('01020304')
        (relay, _gateway), _ = clients(lambda body: grant(body, leaseSeconds=0))
        self.assertEqual(relay.decide('01020304'), 0)

    def test_bridge_still_runs_directly_as_a_script(self):
        script = Path(__file__).resolve().parent / 'wireless' / 'reader_bridge.py'
        result = subprocess.run([sys.executable, str(script), '--help'], capture_output=True, text=True,
                                cwd=Path(script).anchor, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--config', result.stdout)


if __name__ == '__main__':
    unittest.main()
