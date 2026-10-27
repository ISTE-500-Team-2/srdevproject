"""Prewarm public releases; atomically route website and NFC together.

The legacy public container/DB/keys stay intact. Demo remains on 8081 and can
never be a production upstream. No schema changes, seeding or volume removal.
"""
import copy
import json
import re
import time
import urllib.request

SLOTS = {18082: ('green', 'arbor-email-app-green'),
         28082: ('blue', 'arbor-email-app-blue')}
PUBLIC_PORTS = {8082, *SLOTS}


def read_route(path):
    route = json.loads(path.read_text())
    if (route.get('version') != 1 or
            not isinstance(route.get('release'), str) or
            not re.fullmatch('[a-f0-9]{40}', route['release']) or
            type(route.get('publicPort')) is not int or route['publicPort'] not in PUBLIC_PORTS or
            (route.get('previousPublicPort') is not None and
             (type(route['previousPublicPort']) is not int or
              route['previousPublicPort'] not in PUBLIC_PORTS or
              route['previousPublicPort'] == route['publicPort']))):
        raise ValueError('Invalid production route')
    return route


def slot_config(original, image, port):
    if port not in SLOTS or any(name not in original.get('services', {})
                                for name in ('arbor-email-app', 'arbor-mvc-current')):
        raise ValueError('Expected public/demo stack is missing')
    slot, container = SLOTS[port]
    service = copy.deepcopy(original['services']['arbor-email-app'])
    service.pop('depends_on', None)
    service.update(image=image, container_name=container, ports=[f'127.0.0.1:{port}:8080'])
    # Preserve real public DB, JWT keys, reader config and notification policy.
    # Outbox row leases/dedupe and policy advisory locks already coordinate
    # multiple public processes. Never create a second scheduler implementation.
    return {'services': {'arbor-email-app': service},
            'networks': {name: {'external': True, 'name': value.get('name', name)}
                         for name, value in original.get('networks', {}).items()}}


def slot_compose(ops, file, port, *args):
    ops.run('docker', 'compose', '-p', 'arbor-public-' + SLOTS[port][0],
            '-f', str(file), *args, timeout=180)


def verify_route(ops, root, sha):
    origin = 'https://collaboratory.webdev.gccis.rit.edu'
    # The existing authenticated smoke covers DB, session, staff APIs, assets
    # and anonymous denial. Also prove the real gateway selected this revision.
    ops.verify(root, origin)
    with urllib.request.urlopen(origin + '/api/health', timeout=5) as response:
        if response.headers.get('X-Arbor-Release') != sha:
            raise RuntimeError('Public gateway revision mismatch')


def rollback(root, journal, ops):
    # Route rollback is first: the previous healthy public process is still up.
    ops.write_json(root / 'routing/active.json', journal['oldRoute'])
    current = json.loads((root / 'compose.json').read_text())
    if current not in (journal['previousCompose'], journal['candidateCompose']):
        raise RuntimeError('Operator configuration changed; public routing restored, demo rollback requires review')
    ops.write_json(root / 'compose.json', journal['previousCompose'])
    ops.compose(root / 'compose.json', 'up', '-d', '--no-deps', '--no-build',
                '--wait', '--wait-timeout', '90', 'arbor-mvc-current')


def recover_activation(root, ops):
    path = root / 'auto-deploy/activation.json'
    if not path.exists():
        return None
    journal = json.loads(path.read_text())
    if journal.get('phase') != 'pending':
        return None
    rollback(root, journal, ops)
    port = journal['newRoute']['publicPort']
    slot_compose(ops, root / journal['releaseDirectory'] / 'public-slot.json', port, 'stop')
    journal['phase'] = 'recovered'
    ops.write_json(path, journal)
    return {'deployedSha': journal['oldRoute']['release'],
            'failedSha': journal['newRoute']['release'], 'phase': 'blocked',
            'image': journal['previousCompose']['services']['arbor-email-app']['image'],
            'publicPort': journal['oldRoute']['publicPort'],
            'publicContainer': SLOTS.get(journal['oldRoute']['publicPort'], ('legacy', 'arbor-email-app'))[1],
            'reason': 'Interrupted activation rolled back to previous public release'}


def retire_previous(root, port, expected_sha, ops):
    """Timer holds the deployment lock; stale timers cannot stop a reused slot."""
    if port not in PUBLIC_PORTS or not re.fullmatch('[a-f0-9]{40}', expected_sha):
        raise ValueError('Invalid retirement target')
    if read_route(root / 'routing/active.json')['publicPort'] == port:
        return False
    name = SLOTS.get(port, ('legacy', 'arbor-email-app'))[1]
    inspected = json.loads(ops.output('docker', 'inspect', name))[0]
    if inspected['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != expected_sha:
        return False
    ops.run('docker', 'stop', name)
    return True


def deploy_blue_green(root, sha, ops):
    if not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('Invalid release revision')
    started = time.monotonic()
    old_route = read_route(root / 'routing/active.json')
    port = 28082 if old_route['publicPort'] == 18082 else 18082
    release, source, image = ops.prepare_artifact(root, sha)
    original = json.loads((root / 'compose.json').read_text())
    ops.write_json(release / 'previous-compose.json', original)
    candidate = copy.deepcopy(original)
    for name in ('arbor-email-app', 'arbor-mvc-current'):
        candidate['services'][name]['image'] = image
    file = release / 'public-slot.json'
    ops.write_json(file, slot_config(original, image, port))
    ops.write_json(release / 'candidate.json', candidate)
    # Complete schema checks and fresh readable backups before any replacement.
    ops.backup_databases(release, source)
    new_route = {'version': 1, 'release': sha, 'publicPort': port,
                 'previousPublicPort': old_route['publicPort']}
    journal = {'phase': 'pending', 'oldRoute': old_route, 'newRoute': new_route,
               'previousCompose': original, 'candidateCompose': candidate,
               'releaseDirectory': str(release)}
    journal_path = root / 'auto-deploy/activation.json'
    pending = False
    try:
        slot_compose(ops, file, port, 'up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '90')
        ops.verify(root, f'http://127.0.0.1:{port}')
        if json.loads((root / 'compose.json').read_text()) != original:
            raise RuntimeError('Live configuration changed while preparing public release')
        ops.write_json(journal_path, journal)
        pending = True
        ops.write_json(root / 'compose.json', candidate)
        # Demo startup does not extend public traffic cutover. It remains fully
        # separate, with its own DB/key and its original loopback endpoint.
        ops.compose(root / 'compose.json', 'up', '-d', '--no-deps', '--no-build',
                    '--wait', '--wait-timeout', '90', 'arbor-mvc-current')
        ops.verify(root, 'http://127.0.0.1:8081', demo=True)
        if (json.loads((root / 'compose.json').read_text()) != candidate or
                read_route(root / 'routing/active.json') != old_route):
            raise RuntimeError('Live configuration or public route changed during preparation')
        if (root / 'auto-deploy/PAUSED').exists() or ops.main_sha() != sha or not ops.ready(sha):
            raise RuntimeError('Main/CI/pause gate changed; refusing public promotion')
        prepared_seconds = time.monotonic() - started
        switch_started = time.monotonic()
        ops.write_json(root / 'routing/active.json', new_route)
        verify_route(ops, root, sha)
        cutover_seconds = time.monotonic() - switch_started
        journal.update(phase='committed', prepareSeconds=round(prepared_seconds, 3),
                       cutoverSeconds=round(cutover_seconds, 3))
        ops.write_json(journal_path, journal)
        ops.write_json(release / 'activation-metrics.json', {
            'release': sha, 'preparedSeconds': round(prepared_seconds, 3),
            'cutoverAndVerificationSeconds': round(cutover_seconds, 3),
            'totalSeconds': round(time.monotonic() - started, 3),
            'publicPort': port, 'previousPublicPort': old_route['publicPort'],
        })
    except BaseException:
        if pending:
            rollback(root, journal, ops)
            journal['phase'] = 'rolled-back'
            ops.write_json(journal_path, journal)
        # No proxy or database deletion. A failed standby must stop processing
        # jobs; keep the live/previous public processes and all data untouched.
        slot_compose(ops, file, port, 'stop')
        raise
    # Keep old in-flight requests/rollback warm briefly, then drain the previous
    # process and its background workers. The timer rechecks route + image under
    # the deployment lock, so a rapid later release cannot retire a reused slot.
    retirement_scheduled = True
    try:
        ops.run('systemd-run', '--user', '--collect',
                '--unit=arbor-retire-' + old_route['release'][:12] + '-' + str(old_route['publicPort']),
                '--on-active=30s', '/usr/bin/python3', str(root / 'auto-deploy/blue_green_release.py'),
                '--root', str(root), '--retire-port', str(old_route['publicPort']),
                '--retire-sha', old_route['release'])
    except Exception:
        retirement_scheduled = False
        print('Previous public release retained: retirement scheduling needs attention', flush=True)
    return {'deployedSha': sha, 'image': image, 'releaseDirectory': str(release),
            'phase': 'deployed', 'failedSha': None,
            'publicContainer': SLOTS[port][1], 'publicPort': port,
            'previousPublicPort': old_route['publicPort'],
            'cutoverSeconds': round(cutover_seconds, 3),
            'preparedSeconds': round(prepared_seconds, 3),
            'retirementScheduled': retirement_scheduled}


if __name__ == '__main__':
    import argparse
    import fcntl
    from pathlib import Path
    import auto_release
    parser = argparse.ArgumentParser(description='Retire a previous public slot without deleting it')
    parser.add_argument('--root', type=Path, default=Path('/srv/arbor-full'))
    parser.add_argument('--retire-port', type=int, required=True)
    parser.add_argument('--retire-sha', required=True)
    args = parser.parse_args()
    with (args.root / 'deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print('Retired previous public slot:', retire_previous(args.root, args.retire_port, args.retire_sha, auto_release))
