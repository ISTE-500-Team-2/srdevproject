#!/usr/bin/env python3
"""Existing RLES stack: pull CI-green main, never migrate/seed/delete data."""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import urllib.error
import urllib.request

REPO = 'ISTE-500-Team-2/srdevproject'
REQUIRED = {'verify', 'sponsor-rehearsal', 'launcher-docker',
            'launcher-unit (ubuntu-latest)', 'launcher-unit (macos-latest)',
            'launcher-unit (windows-latest)'}
APPS = ('arbor-email-app', 'arbor-mvc-current')
DATABASES = (('arbor-email-db', 'arbor_email', 'arbor_email_dev'),
             ('arbor-mvc-db-1', 'arbor_mvc', 'arbor_mvc_dev'))


def write_json(path, value):
    temporary = path.with_suffix('.next')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def run(*args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop('timeout', 120), **kwargs)


def output(*args):
    return run(*args, stdout=subprocess.PIPE, text=True).stdout.strip()


def main_sha():
    value = output('git', 'ls-remote', 'https://github.com/' + REPO + '.git', 'refs/heads/main')
    sha, ref = value.split()
    if ref != 'refs/heads/main' or not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('Invalid main reference')
    return sha


def api(path):
    request = urllib.request.Request('https://api.github.com/repos/' + REPO + '/' + path,
        headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'ARBOR-production-deployer'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def green_checks(sha, checks, workflows):
    """Exact revision, GitHub Actions identity, latest attempt, main push only."""
    latest = {}
    for check in checks:
        if check.get('head_sha') == sha and check.get('app', {}).get('slug') == 'github-actions':
            name = check['name']
            if name not in latest or check['id'] > latest[name]['id']:
                latest[name] = check
    for name in REQUIRED:
        if name not in latest or latest[name].get('status') != 'completed' or latest[name].get('conclusion') != 'success':
            return False
    # PR checks on a SHA must not substitute for main-branch push workflows.
    for path in ('.github/workflows/mvc-verify.yml', '.github/workflows/dev-setup.yml', '.github/workflows/sponsor-hosting.yml'):
        runs = [r for r in workflows if r.get('head_sha') == sha and r.get('head_branch') == 'main'
                and r.get('event') == 'push' and r.get('path') == path]
        latest_run = max(runs, key=lambda r: r['id']) if runs else {}
        if latest_run.get('status') != 'completed' or latest_run.get('conclusion') != 'success':
            return False
    return True


def ready(sha):
    checks = api('commits/' + sha + '/check-runs?per_page=100')['check_runs']
    runs = api('actions/runs?head_sha=' + sha + '&event=push&branch=main&per_page=100')['workflow_runs']
    return green_checks(sha, checks, runs)


def compose(file, *args):
    project = 'arbor-auto-canary' if file.name == 'canary.json' else 'arbor-full'
    run('docker', 'compose', '-p', project, '-f', str(file), *args, timeout=180)


def request(origin, path, data=None, token=None):
    headers = {'Origin': 'https://collaboratory.webdev.gccis.rit.edu'}
    if data is not None:
        data = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    with urllib.request.urlopen(urllib.request.Request(origin + path, data=data, headers=headers), timeout=20) as response:
        return json.load(response)


def verify(root, origin, demo=False):
    health = request(origin, '/api/health')['data']
    assert health.get('status') == 'ok' and health.get('database') == 'connected', 'Database health failed'
    credentials = {'role': 'admin'} if demo else json.loads((root / 'admin.private.json').read_text())
    login = request(origin, '/api/auth/demo' if demo else '/api/auth/login', credentials)
    token = login['data']['accessToken']
    for path in ('/api/auth/session', '/api/admin/users', '/api/training/catalog', '/api/classes'):
        assert 'data' in request(origin, path, token=token), path
    # Fetch assets without logging credentials or member records.
    with urllib.request.urlopen(origin + '/', timeout=20) as response:
        html = response.read().decode()
    assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
    assert assets, 'Frontend assets missing'
    for asset in assets:
        with urllib.request.urlopen(origin + asset, timeout=20) as response:
            assert response.status == 200, asset
    try:
        request(origin, '/api/admin/users')
        raise AssertionError('Anonymous admin access allowed')
    except urllib.error.HTTPError as error:
        assert error.code == 401, 'Anonymous admin access did not fail closed'
    print('Verified', 'demo' if demo else 'public', 'health/login/admin APIs/assets/access denial', flush=True)


def candidates(original, image):
    """Only app images change; never adopt another stack or replace DB volumes."""
    if any(name not in original.get('services', {}) for name in APPS):
        raise ValueError('Expected existing public/demo stack is missing')
    candidate = copy.deepcopy(original)
    for name in APPS:
        candidate['services'][name]['image'] = image
    canary = {'services': {}, 'networks': {name: {'external': True, 'name': value.get('name', name)}
                                        for name, value in original.get('networks', {}).items()}}
    for name, port in zip(APPS, (18082, 18081)):
        service = copy.deepcopy(candidate['services'][name])
        service.pop('depends_on', None)
        service['container_name'] = name + '-auto-canary'
        service['ports'] = ['127.0.0.1:%s:8080' % port]
        service['environment'] = {**service.get('environment', {}), 'EMAIL_ENABLED': 'false'}
        service['restart'] = 'no'
        canary['services'][name] = service
    return candidate, canary


def deploy(root, sha):
    release = root / 'auto-deploy/releases' / sha
    release.mkdir(parents=True, exist_ok=True, mode=0o700)
    source = release / 'source'
    if not source.exists():
        run('git', 'init', str(source))
    run('git', '-C', str(source), 'fetch', '--depth=1', 'https://github.com/' + REPO + '.git', sha)
    assert output('git', '-C', str(source), 'rev-parse', 'FETCH_HEAD') == sha
    run('git', '-C', str(source), 'checkout', '--detach', sha)
    tag = 'arbor:auto-' + sha
    run('docker', 'build', '--pull', '--label', 'org.opencontainers.image.revision=' + sha,
        '-t', tag, str(source), timeout=1200)
    image = json.loads(output('docker', 'image', 'inspect', tag))[0]['Id']
    original = json.loads((root / 'compose.json').read_text())
    write_json(release / 'previous-compose.json', original)
    candidate, canary = candidates(original, image)
    candidate_file, canary_file = release / 'candidate.json', release / 'canary.json'
    write_json(candidate_file, candidate)
    write_json(canary_file, canary)
    compose(candidate_file, 'config', '--quiet')
    # Read-only migration/checksum gates use the protected original app environment.
    for name in APPS:
        compose(canary_file, 'run', '--rm', '--no-deps', '--entrypoint', 'node', name,
                'backend/dist/scripts/verify-migrations.js')
    # Backups must succeed and be readable before any running app is replaced.
    for container, user, database in DATABASES:
        backup = release / (database + '.dump')
        with backup.open('wb') as stream:
            backup.chmod(0o600)
            run('docker', 'exec', container, 'pg_dump', '-U', user, '-d', database,
                '--format=custom', '--no-owner', stdout=stream)
        assert backup.stat().st_size > 0, 'Empty backup'
        with backup.open('rb') as stream:
            run('docker', 'exec', '-i', container, 'pg_restore', '--list', stdin=stream, stdout=subprocess.DEVNULL)
    switched = False
    try:
        compose(canary_file, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '90')
        verify(root, 'http://127.0.0.1:18082')
        verify(root, 'http://127.0.0.1:18081', demo=True)
        if json.loads((root / 'compose.json').read_text()) != original:
            raise RuntimeError('Live configuration changed while preparing release')
        if (root / 'auto-deploy/PAUSED').exists() or main_sha() != sha:
            raise RuntimeError('Deployment paused or main changed during build; reevaluate')
        # CI reruns may have been started while the image was building.
        if not ready(sha):
            raise RuntimeError('Required CI changed during build; reevaluate')
        switched = True
        write_json(root / 'compose.json', candidate)
        compose(root / 'compose.json', 'up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '90', *APPS)
        verify(root, 'http://127.0.0.1:8082')
        verify(root, 'http://127.0.0.1:8081', demo=True)
        verify(root, 'https://collaboratory.webdev.gccis.rit.edu')
    except BaseException:
        if switched:
            write_json(root / 'compose.json', original)
            compose(root / 'compose.json', 'up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '90', *APPS)
        raise
    finally:
        compose(canary_file, 'stop')
    return {'deployedSha': sha, 'image': image, 'releaseDirectory': str(release), 'phase': 'deployed', 'failedSha': None}


def tick(root, retry=False):
    directory = root / 'auto-deploy'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_file = directory / 'status.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    state['lastCheck'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if (directory / 'PAUSED').exists():
        state['phase'] = 'paused'
        write_json(state_file, state)
        return
    sha = main_sha()
    state['candidateSha'] = sha
    if sha == state.get('deployedSha'):
        state['phase'] = 'deployed'
    elif sha == state.get('failedSha') and not retry:
        state['phase'] = 'blocked'
    elif not ready(sha):
        state['phase'] = 'waiting-for-ci'
    else:
        state.update(phase='deploying', reason=None)
        write_json(state_file, state)
        try:
            state.update(deploy(root, sha))
        except Exception as error:
            # Do not serialize exception output: a failed command may include secret-bearing context.
            state.update(phase='blocked', failedSha=sha, reason=type(error).__name__ + ': see protected release log')
            write_json(state_file, state)
            raise
    write_json(state_file, state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/srv/arbor-full'))
    parser.add_argument('--retry', action='store_true', help='Operator retry after resolving the recorded block')
    args = parser.parse_args()
    os.umask(0o077)
    def interrupted(_number, _frame):
        raise RuntimeError('Deployment interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    with (args.root / 'deployment.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another deployment owns the lock; leaving it unchanged')
            return
        tick(args.root, args.retry)


if __name__ == '__main__':
    main()
