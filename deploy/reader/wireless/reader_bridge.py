#!/usr/bin/env python3
"""Wireless ESP32 controller and signed project-backend adapter."""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
from pathlib import Path
import re
import signal
import sys
import threading
import time
from urllib.parse import urlsplit
import urllib.request

if not __package__:
    # Run directly as a script: make the sibling reader modules importable.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from signed_decision import (DECISION_PATH, ProtocolError, canonical_json, decision_outcome, exchange,
                             expiry_remaining, heartbeat_mode, lease_seconds, read_bounded)


class BridgeError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def base_url(value, *, backend=False):
    parsed = urlsplit(value)
    schemes = {'https'} if backend else {'http', 'https'}
    if parsed.scheme not in schemes or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Invalid bridge URL')
    return value.rstrip('/')


def open_request(request, timeout):
    return urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)


body_json = canonical_json


def read_response(response):
    try:
        return read_bounded(response)
    except ProtocolError as error:
        raise BridgeError(error.code) from error


def canonical(check, data, code=None):
    """Apply a shared response check, reporting failure as this client's BridgeError."""
    try:
        return check(data)
    except ProtocolError as error:
        raise BridgeError(code or 'backend_' + error.code) from error


class ReaderClient:
    def __init__(self, url, key, opener=open_request):
        self.url = base_url(url)
        if len(key) != 32:
            raise ValueError('Reader link key must contain 32 bytes')
        self.key, self.opener = key, opener
        self.session, self.counter, self.max_scan = None, 0, 0

    def request(self, path, value=None):
        body = None if value is None else body_json(value)
        headers = {'Accept': 'application/json'}
        if body is not None:
            headers.update({'Content-Type': 'application/json', 'X-Arbor-Signature': hmac.new(self.key, body, hashlib.sha256).hexdigest()})
        req = urllib.request.Request(self.url + path, data=body, headers=headers, method='GET' if body is None else 'POST')
        with self.opener(req, timeout=0.8) as response:
            raw = read_response(response)
            signature = response.headers.get('X-Arbor-Signature', '')
        expected = hmac.new(self.key, raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise BridgeError('reader_signature_invalid')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise BridgeError('reader_response_invalid')
        return value

    def state(self):
        value = self.request('/api/controller/state')
        session = value.get('session')
        if value.get('type') != 'reader_state' or not isinstance(session, str) or not re.fullmatch('[0-9a-f]{8}', session):
            raise BridgeError('reader_state_invalid')
        for name in ('scan_id', 'last_counter', 'uptime_ms'):
            if type(value.get(name)) is not int or not 0 <= value[name] <= 0xffffffff:
                raise BridgeError('reader_state_invalid')
        if type(value.get('reader_ready')) is not bool or type(value.get('pending')) is not bool:
            raise BridgeError('reader_state_invalid')
        if self.session != session:
            self.session, self.counter, self.max_scan = session, value['last_counter'], value['scan_id']
        else:
            if value['scan_id'] < self.max_scan:
                raise BridgeError('reader_state_replayed')
            self.max_scan = value['scan_id']
            self.counter = max(self.counter, value['last_counter'])
        value['_received_at'] = time.monotonic()
        return value

    def command(self, state, value):
        if state['session'] != self.session or self.counter >= 0xffffffff:
            raise BridgeError('reader_session_changed')
        self.counter += 1
        message = {'session': self.session, 'counter': self.counter, **value}
        response = self.request('/api/controller/command', message)
        if response.get('type') != 'controller_ack' or response.get('session') != self.session or response.get('counter') != self.counter or type(response.get('accepted')) is not bool:
            raise BridgeError('reader_ack_invalid')
        return response['accepted']


class BackendClient:
    def __init__(self, url, reader_id, secret, opener=open_request, *, check_in=False):
        self.url = base_url(url, backend=True)
        if not re.fullmatch('[a-zA-Z0-9_-]{1,64}', reader_id) or len(secret) < 32:
            raise ValueError('Invalid backend reader credential')
        self.reader_id, self.secret, self.opener = reader_id, secret, opener
        self.check_in = check_in

    def signed(self, payload, invalid):
        try:
            return exchange(self.opener, self.url + DECISION_PATH, self.reader_id, self.secret, payload)
        except ProtocolError as error:
            raise BridgeError(error.code if error.code == 'response_too_large' else invalid) from error

    def health(self):
        # Reachable HTTP health is not proof that this reader is authenticated.
        # The signed idle heartbeat also updates production's last_seen_at and
        # reads staff-controlled enrollment/disable mode, without inventing taps.
        data, _started, _received = self.signed({'action': 'heartbeat'}, 'backend_heartbeat_invalid')
        return canonical(heartbeat_mode, data, 'backend_heartbeat_invalid') != 'disabled'

    def decide(self, uid):
        if not isinstance(uid, str) or not re.fullmatch('(?:[A-Fa-f0-9]{8}|[A-Fa-f0-9]{14}|[A-Fa-f0-9]{20})', re.sub('[: -]', '', uid)):
            raise BridgeError('invalid_uid')
        data, started, now = self.signed({'uid': uid, 'checkIn': self.check_in}, 'backend_decision_invalid')
        allowed, reason = canonical(decision_outcome, data)
        result = {'allowed': allowed, 'reason': reason, 'eventId': data['eventId'], 'decisionId': data.get('decisionId'), 'uidFingerprint': hashlib.sha256(re.sub('[: -]', '', uid).upper().encode()).hexdigest()}
        if result['allowed']:
            if self.check_in:
                member = data.get('member')
                if not isinstance(member, dict) or type(member.get('id')) is not int or member['id'] <= 0 or not isinstance(member.get('name'), str) or not 1 <= len(member['name']) <= 200 or not isinstance(member.get('email'), str) or not 3 <= len(member['email']) <= 254 or '@' not in member['email'] or type(member.get('membership')) is not bool or type(member.get('dayPass')) is not bool:
                    raise BridgeError('backend_identity_invalid')
                result['member'] = {key: member[key] for key in ('id','name','email','membership','dayPass')}
                result['checkInRequested'] = True
            # Unlike the relay client's clamp, the gateway rejects any lease outside (0, 5].
            lease = canonical(lease_seconds, data)
            if not 0 < lease <= 5:
                raise BridgeError('backend_lease_invalid')
            wall_remaining = canonical(expiry_remaining, data)
            # Subtract the entire round trip conservatively, independent of clock skew.
            result['valid_until'] = min(started + lease, now + wall_remaining)
            if result['valid_until'] <= now:
                raise BridgeError('backend_decision_expired')
        return result


def decision_message(state, result, now=None):
    now = time.monotonic() if now is None else now
    message = {'type': 'access_decision', 'scan_id': state['scan_id'], 'decision': 'approved' if result['allowed'] else 'denied'}
    if result['allowed']:
        remaining_ms = int((result['valid_until'] - now) * 1000) - 50
        if remaining_ms <= 0:
            raise BridgeError('backend_decision_expired')
        elapsed_ms = max(0, int((now - state['_received_at']) * 1000))
        grant = min(2000, remaining_ms)
        message.update({'grant_ms': grant, 'valid_until_ms': (state['uptime_ms'] + elapsed_ms + grant) & 0xffffffff})
    return message


def write_status(path, reader_ok, backend_ok, reason, state=None, result=None, proof=None):
    def item(label, detail, status):return {'label': label, 'detail': detail, 'state': status}
    doc = {'updated_at': int(time.time()), 'readerHandlingEnabled': True, 'accessDecisionsEnabled': backend_ok and reader_ok and bool(state and state.get('reader_ready')),
           'esp32': item('Connected' if reader_ok else 'Unavailable', 'Authenticated Wi-Fi channel', 'ready' if reader_ok else 'error'),
           'reader': item('Ready' if state and state.get('reader_ready') else 'Unavailable', 'PN532 state from the ESP32', 'ready' if state and state.get('reader_ready') else 'error'),
           'cloud': item('Authorization ready' if backend_ok else 'Authorization unavailable', reason, 'ready' if backend_ok else 'error'),
           'backendReachable': backend_ok, 'reason': reason}
    if result:doc['last_decision'] = {key: result[key] for key in ('allowed','reason','eventId','decisionId','uidFingerprint','readerSession','scanId') if key in result}
    if proof:doc['pairingProof'] = proof
    target = Path(path);target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix('.tmp');temp.write_text(json.dumps(doc) + '\n');temp.replace(target)


def run(config, stop):
    reader = ReaderClient(config['reader_url'], bytes.fromhex(Path(config['reader_link_key_file']).read_text().strip()))
    secret_path = Path(config['backend_reader_secret_file'])
    backend = BackendClient(config['backend_url'], config['backend_reader_id'], secret_path.read_text().strip()) if secret_path.exists() else None
    future = None;identity = None;handled = None;last_session = None
    heartbeat_at = health_at = 0.0;backend_ok = False;reason = 'backend_credential_missing' if backend is None else 'starting'
    last_result = None;logged = None
    with ThreadPoolExecutor(max_workers=1) as executor:
        while not stop.is_set():
            state = None;reader_ok = False
            try:
                now = time.monotonic()
                if backend and now >= health_at:
                    try:
                        backend_ok = backend.health();reason = 'ready' if backend_ok else 'backend_unhealthy'
                    except Exception:
                        backend_ok = False;reason = 'backend_unavailable'
                    health_at = now + 10
                state = reader.state();reader_ok = True
                if state['session'] != last_session:
                    handled = None;last_session = state['session'];heartbeat_at = 0
                current = (state['session'], state['scan_id'])
                if now >= heartbeat_at:
                    reader.command(state, {'type': 'controller_status', 'ready': backend_ok and state['reader_ready']})
                    heartbeat_at = now + 1
                if future and future.done():
                    try:
                        result = future.result()
                        if identity == current and state['pending'] and backend_ok:
                            accepted = reader.command(state, decision_message(state, result))
                            last_result = result;reason = result['reason'] if accepted else 'decision_not_accepted'
                    except Exception:
                        backend_ok = False;reason = 'authorization_request_failed'
                        reader.command(state, {'type': 'controller_status', 'ready': False})
                    future = None
                if backend and backend_ok and state['reader_ready'] and state['pending'] and current != handled and future is None:
                    handled = current;identity = current
                    future = executor.submit(backend.decide, state.get('uid'))
            except Exception as error:
                reason = error.args[0] if isinstance(error, BridgeError) else type(error).__name__
            write_status(config['status_file'], reader_ok, backend_ok, reason, state, last_result)
            summary = (reader_ok, backend_ok, reason)
            if summary != logged:
                print(json.dumps({'readerConnected': reader_ok, 'authorizationReady': backend_ok and reader_ok and bool(state and state.get('reader_ready')), 'reason': reason}), flush=True);logged = summary
            stop.wait(0.2)


def main():
    parser = argparse.ArgumentParser();parser.add_argument('--config', required=True);args = parser.parse_args()
    config = json.loads(Path(args.config).read_text());stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):signal.signal(sig, lambda *_: stop.set())
    run(config, stop)


if __name__ == '__main__':main()
