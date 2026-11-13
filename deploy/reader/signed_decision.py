"""Signed reader-decision transport and canonical backend response checks.

Shared by AccessClient (relay adapter) and the wireless BackendClient. Hardware
adapters, lease policy and each client's own exception types stay with the
client. This module signs a request to /api/devices/decision and validates the
response the backend returns for it.
"""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import time
import urllib.request
import uuid

DECISION_PATH = '/api/devices/decision'
DEADLINE_SECONDS = 1.8
MAX_RESPONSE_BYTES = 16384
MODES = ('access', 'enroll', 'disabled')


class ProtocolError(ValueError):
    """A response failed a canonical check. args[0] is a fixed code, never data."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def canonical_json(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()


def read_bounded(response):
    raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ProtocolError('response_too_large')
    return raw


def exchange(opener, url, reader_id, secret, payload):
    """POST one signed decision request; return (data, started, received).

    The HMAC covers the timestamp and the exact body, which carries a fresh
    event ID. The reply must echo that event and reader, checked before the
    deadline. Times are time.monotonic() readings.
    """
    event = str(uuid.uuid4())
    body = canonical_json({**payload, 'eventId': event})
    stamp = str(int(time.time() * 1000))
    signature = hmac.new(secret.encode(), stamp.encode() + b'\n' + body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(url, data=body, headers={
        'Content-Type': 'application/json', 'X-Reader-ID': reader_id,
        'X-Reader-Timestamp': stamp, 'X-Reader-Signature': signature}, method='POST')
    started = time.monotonic()
    with opener(request, timeout=DEADLINE_SECONDS) as response:
        raw = read_bounded(response)
    try:
        envelope = json.loads(raw)
    except ValueError:
        raise ProtocolError('response_invalid') from None
    data = envelope.get('data') if isinstance(envelope, dict) else None
    if not isinstance(data, dict):
        raise ProtocolError('response_invalid')
    received = time.monotonic()
    if data.get('eventId') != event or data.get('readerId') != reader_id:
        raise ProtocolError('identity_mismatch')
    if received - started >= DEADLINE_SECONDS:
        raise ProtocolError('late')
    return data, started, received


def heartbeat_mode(data):
    """A signed heartbeat never grants access: it only reports the reader mode."""
    if (data.get('allowed') is not False or data.get('reason') != 'HEARTBEAT'
            or data.get('leaseSeconds') != 0 or data.get('mode') not in MODES):
        raise ProtocolError('heartbeat_invalid')
    return data['mode']


def decision_outcome(data):
    """Return (allowed, reason). allowed must be a JSON boolean."""
    if type(data.get('allowed')) is not bool:
        raise ProtocolError('decision_invalid')
    reason = data.get('reason', 'UNKNOWN')
    if not isinstance(reason, str) or len(reason) > 100:
        raise ProtocolError('reason_invalid')
    return data['allowed'], reason


def lease_seconds(data):
    """The server lease as a finite JSON number. Its range is client policy."""
    lease = data.get('leaseSeconds')
    if type(lease) not in (int, float) or not math.isfinite(lease):
        raise ProtocolError('lease_invalid')
    return lease


def expiry_remaining(data):
    """Seconds until the response's absolute expiry, which must name its zone."""
    value = data.get('expiresAt')
    if not isinstance(value, str):
        raise ProtocolError('expiry_invalid')
    try:
        expiry = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ProtocolError('expiry_invalid') from None
    if expiry.tzinfo is None:
        raise ProtocolError('expiry_invalid')
    return (expiry - datetime.now(timezone.utc)).total_seconds()
