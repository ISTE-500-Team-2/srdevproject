import unittest
import time
import json
import hmac
import hashlib
from datetime import datetime, timezone, timedelta
from access_client import AccessClient, RelayLease, RenewingAccessSession

class Response:
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, limit): return json.dumps({'data': self.data}).encode()

class Tests(unittest.TestCase):
    def test_signed_payload_and_bounded_lease(self):
        def open_request(req, timeout):
            stamp=req.get_header('X-reader-timestamp')
            expected=hmac.new(b'x'*32,stamp.encode()+b'\n'+req.data,hashlib.sha256).hexdigest()
            self.assertEqual(req.get_header('X-reader-signature'),expected)
            self.assertEqual(timeout,1.8)
            body=json.loads(req.data)
            return Response({'eventId':body['eventId'],'readerId':'test','allowed':True,'leaseSeconds':100,
                'expiresAt':(datetime.now(timezone.utc)+timedelta(seconds=3)).isoformat()})
        c=AccessClient('https://example.invalid','test','x'*32,open_request)
        self.assertTrue(0<c.decide('01020304')<=3)
    def test_expired_or_mismatched_decisions_do_not_grant(self):
        def opener(req,timeout):
            body=json.loads(req.data)
            return Response({'eventId':body['eventId'],'readerId':'test','allowed':True,'leaseSeconds':5,
                'expiresAt':(datetime.now(timezone.utc)-timedelta(seconds=1)).isoformat()})
        self.assertEqual(AccessClient('https://example.invalid','test','x'*32,opener).decide('01020304'),0)
        c=AccessClient('https://example.invalid','test','x'*32,lambda req,timeout:Response({'eventId':'wrong','readerId':'test','allowed':True}))
        with self.assertRaises(ValueError):c.decide('01020304')
    def test_relay_expires_and_network_failure_is_immediate_off(self):
        states=[];relay=RelayLease(states.append);self.assertEqual(states, [False])
        relay.apply(0.04);self.assertEqual(states[-1],True);time.sleep(0.08);self.assertEqual(states[-1],False)
        class Offline:
            def decide(self,*args):raise TimeoutError()
        relay.apply(5);self.assertFalse(relay.authorize(Offline(),'01020304'));self.assertFalse(states[-1]);relay.close()
    def test_old_timer_cannot_revoke_new_lease_and_close_stays_off(self):
        states=[];r=RelayLease(states.append);r.apply(.05);r.apply(.15);time.sleep(.08);self.assertTrue(states[-1]);r.close();time.sleep(.1);self.assertFalse(states[-1])
        with self.assertRaises(RuntimeError):r.apply(1)
    def test_active_session_rechecks_and_denial_terminates_relay(self):
        calls=[]
        class Revoked:
            def decide(self, uid, check_in=False):
                calls.append(check_in)
                return 5 if len(calls)==1 else 0
        states=[];session=RenewingAccessSession(Revoked(),RelayLease(states.append),'01020304')
        self.assertTrue(session.start())
        time.sleep(1.1)
        self.assertEqual(calls,[True,False]);self.assertFalse(states[-1]);self.assertIsNone(session.uid)
        session.close()
    def test_refuses_insecure_transport(self):
        with self.assertRaises(ValueError):AccessClient('http://example.invalid','test','x'*32)
if __name__=='__main__':unittest.main()
