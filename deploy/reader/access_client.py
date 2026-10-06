"""Signed application client and fail-closed relay lease controller.

Adapter-neutral: existing PN532 firmware/receiver stays intact. The Pi adapter must
provide an actually verified relay callback; no unverified GPIO pin is assumed.
"""
from __future__ import annotations
import hashlib
import hmac
import json
import threading
import time
import uuid
import urllib.request
from datetime import datetime, timezone


class AccessClient:
    def __init__(self, base_url, reader_id, secret, opener=urllib.request.urlopen):
        if not base_url.startswith('https://'):
            raise ValueError('Reader transport requires HTTPS')
        if len(secret) < 32:
            raise ValueError('Reader secret must have at least 32 characters')
        self.url = base_url.rstrip('/') + '/api/devices/decision'
        self.reader_id, self.secret, self.opener = reader_id, secret, opener

    def decide(self, uid, check_in=False):
        event = str(uuid.uuid4())
        body = json.dumps({'uid': uid, 'eventId': event, 'checkIn': check_in}, separators=(',', ':')).encode()
        stamp = str(int(time.time()*1000))
        signature = hmac.new(self.secret.encode(), stamp.encode()+b'\n'+body, hashlib.sha256).hexdigest()
        request = urllib.request.Request(self.url, data=body, headers={
            'Content-Type': 'application/json', 'X-Reader-ID': self.reader_id,
            'X-Reader-Timestamp': stamp, 'X-Reader-Signature': signature}, method='POST')
        started = time.monotonic()
        with self.opener(request, timeout=1.8) as response:
            data = json.loads(response.read(16384))['data']
        if data.get('eventId') != event or data.get('readerId') != self.reader_id:
            raise ValueError('Mismatched reader decision')
        if time.monotonic()-started >= 1.8:
            raise TimeoutError('Late reader decision')
        if data.get('allowed') is not True:
            return 0.0
        expiry = datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00'))
        remaining = (expiry-datetime.now(timezone.utc)).total_seconds()
        # Bound both the server lease and the signed response's absolute expiry.
        return max(0.0, min(5.0, remaining, float(data['leaseSeconds'])))


class RelayLease:
    """De-energize on every failure, expired lease, startup and close.

    A hardware watchdog/fail-secure circuit remains necessary for host power loss.
    Callback True authorizes access; adapter defines safe electrical polarity.
    """
    def __init__(self, set_relay):
        self.set_relay = set_relay
        self._lock = threading.RLock()
        self._timer = None
        self._generation = 0
        self._closed = False
        set_relay(False)

    def _off(self, generation):
        with self._lock:
            if generation == self._generation:
                self.set_relay(False)

    def apply(self, seconds):
        with self._lock:
            if self._closed:
                raise RuntimeError('Relay controller closed')
            self._generation += 1
            if self._timer:
                self._timer.cancel()
            self.set_relay(False)
            if not isinstance(seconds, (int, float)) or not 0 < seconds <= 5:
                return
            self.set_relay(True)
            self._timer = threading.Timer(seconds, self._off, [self._generation])
            self._timer.daemon = True
            self._timer.start()

    def authorize(self, client, uid, check_in=False):
        try:
            seconds = client.decide(uid, check_in)
            self.apply(seconds)
            return seconds > 0
        except Exception:
            with self._lock:
                self.set_relay(False)
            return False

    def close(self):
        with self._lock:
            self._generation += 1
            self._closed = True
            if self._timer:
                self._timer.cancel()
            self.set_relay(False)


class RenewingAccessSession:
    """Revalidate an active machine/door lease once per second.

    First request records the physical scan; renewal never adds duplicate visits.
    Stop permanently after a denial/network failure; a new scan starts a new session.
    """
    def __init__(self, client, relay, uid):
        self.client, self.relay, self.uid = client, relay, uid
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread is not None or self._stop.is_set():
            raise RuntimeError('Session already started or stopped')
        if not self.relay.authorize(self.client, self.uid, check_in=True):
            self.close()
            return False
        self._thread = threading.Thread(target=self._renew, daemon=True)
        self._thread.start()
        return True

    def _renew(self):
        while not self._stop.wait(1):
            if not self.relay.authorize(self.client, self.uid):
                self._stop.set()
                self.relay.close()
                self.uid = None
                return

    def close(self):
        self._stop.set()
        self.relay.close()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)
        self.uid = None
