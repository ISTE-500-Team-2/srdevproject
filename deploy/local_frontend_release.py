#!/usr/bin/env python3
"""Owner-invoked frontend-only release. Not an alternative gate for server changes.

Local receipts are trusted operator inputs, delivered over authenticated SSH,
not public uploads, GitHub statuses, or an HTTP authorization mechanism.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import tempfile
import time

import auto_release as ops
from blue_green_release import deploy_blue_green, recover_activation, read_route, slot_config, slot_compose, SLOTS

COMMANDS = {
    'frontend-check': ['npm', 'run', 'test', '--prefix', 'frontend', '--', '--maxWorkers=4', '--pool=threads'],
    'frontend-build': ['npm', 'run', 'build', '--prefix', 'frontend'],
    'frontend-integration': ['npm', 'run', 'test:integration', '--prefix', 'frontend', '--', '--maxWorkers=6', '--pool=threads'],
}
ALLOWED = ('frontend/src/', 'frontend/test/')
MAC_WORKFLOW_BLOB = 'a853ff2e818b1a8ebd1055f3ba34757037d3f922'


def revision(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{40}', value):
        raise ValueError('Expected an exact Git revision')
    return value


def tree_files(source, sha):
    """Git object identities include file mode; no local untracked dependencies."""
    raw = ops.output('git', '-C', str(source), 'ls-tree', '-r', '-z', revision(sha))
    result = {}
    for entry in raw.split('\0'):
        if not entry:
            continue
        meta, name = entry.split('\t', 1)
        mode, kind, digest = meta.split()
        result[name] = (mode, kind, digest)
    return result


def check_scope(before, after):
    changed = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
    if not changed:
        raise ValueError('No frontend source changes since the checked baseline')
    if any(not p.startswith(ALLOWED) for p in changed):
        raise ValueError('Changes outside frontend source/tests require the normal full release')
    if any(after.get(p, ('100644',))[0] != '100644' for p in changed):
        raise ValueError('Frontend symlinks, executables and submodules are not eligible')
    return changed


def scoped_source(root, sha, baseline):
    """Check scope BEFORE executing a candidate Dockerfile/build configuration."""
    release = root / 'auto-deploy/releases' / revision(sha)
    release.mkdir(mode=0o700, parents=True, exist_ok=True)
    source = release / 'source'
    if not source.exists():
        ops.run('git', 'init', str(source))
        ops.run('git', '-C', str(source), 'fetch', '--depth=1', 'https://github.com/' + ops.REPO + '.git', sha)
        ops.run('git', '-C', str(source), 'checkout', '--detach', sha)
    if (ops.output('git', '-C', str(source), 'rev-parse', 'HEAD') != sha
            or ops.output('git', '-C', str(source), 'status', '--porcelain', '--untracked-files=all')):
        raise RuntimeError('Source must be the pristine exact main revision')
    try:
        present = ops.output('git', '-C', str(source), 'cat-file', '-t', baseline) == 'commit'
    except subprocess.CalledProcessError:
        present = False
    if not present:
        ops.run('git', '-C', str(source), 'fetch', '--depth=1', 'https://github.com/' + ops.REPO + '.git', baseline)
    check_scope(tree_files(source, baseline), tree_files(source, sha))
    return release, source


def validate_receipt(receipt, directory, sha, tree, now=None):
    now = time.time() if now is None else now
    if (receipt.get('version') != 1 or receipt.get('revision') != revision(sha)
            or receipt.get('tree') != tree or receipt.get('node') != 'v24.22.1'
            or receipt.get('platform') != 'Darwin-arm64'):
        raise ValueError('Local verification identity mismatch')
    timestamp = receipt.get('completedAt')
    if type(timestamp) not in (int, float) or not 0 <= now - timestamp < 900:
        raise ValueError('Local checks expired or from the future')
    if set(receipt.get('checks', {})) != set(COMMANDS):
        raise ValueError('All frontend verification lanes are required')
    for name, command in COMMANDS.items():
        item = receipt['checks'][name]
        path = directory / (name + '.log')
        if (item.get('command') != command or type(item.get('exitCode')) is not int
                or item['exitCode'] != 0 or path.is_symlink() or not path.is_file()
                or not path.stat().st_size
                or hashlib.sha256(path.read_bytes()).hexdigest() != item.get('sha256')):
            raise ValueError('Missing, failed or changed local verification log')


def candidate_failures(checks, sha):
    latest = {}
    for c in checks:
        if c.get('head_sha') == sha and c.get('app', {}).get('slug') == 'github-actions':
            if c['name'] not in latest or c['id'] > latest[c['name']]['id']:
                latest[c['name']] = c
    return any(c.get('conclusion') not in (None, 'success') for c in latest.values())


def baseline_green(root, sha, checks, runs):
    if ops.green_checks(sha, checks, runs):
        return True
    # The owner may run the queued hosted Mac lane on the actual Mac instead.
    # This replaces ONLY that lane, not failures or any application/Docker gate.
    latest = {}
    for c in checks:
        if c.get('head_sha') == sha and c.get('app', {}).get('slug') == 'github-actions':
            if c['name'] not in latest or c['id'] > latest[c['name']]['id']:
                latest[c['name']] = c
    mac = 'launcher-unit (macos-latest)'
    if latest.get(mac, {}).get('conclusion') not in (None, 'success'):
        return False
    if any(latest.get(n, {}).get('status') != 'completed' or latest[n].get('conclusion') != 'success'
           for n in ops.REQUIRED - {mac}):
        return False
    if any(c['name'] != mac and (c.get('status') != 'completed' or c.get('conclusion') != 'success')
           for c in latest.values()):
        return False
    for path in ('.github/workflows/mvc-verify.yml', '.github/workflows/dev-setup.yml', '.github/workflows/sponsor-hosting.yml'):
        matches = [r for r in runs if r.get('head_sha') == sha and r.get('head_branch') == 'main'
                   and r.get('event') == 'push' and r.get('path') == path]
        run = max(matches, key=lambda r: r['id']) if matches else {}
        if path.endswith('dev-setup.yml'):
            if not run or run.get('conclusion') not in (None, 'success'):
                return False
        elif run.get('status') != 'completed' or run.get('conclusion') != 'success':
            return False
    try:
        directory = root / 'auto-deploy/releases' / sha
        evidence = json.loads((directory / 'local-macos-evidence.json').read_text())
        source = directory / 'source'
        if (evidence.get('version') != 1 or evidence.get('revision') != sha
                or evidence.get('platform') != 'Darwin-arm64' or evidence.get('node') != '24.22.1'
                or evidence.get('ownerAuthorizedLocalReplacement') != 'queued macOS launcher check only'
                or evidence.get('launcherTestsPassed') != 6 or evidence.get('launcherTestsFailed') != 0
                or evidence.get('missingKeyExit') != 1
                or ops.output('git', '-C', str(source), 'rev-parse', 'HEAD') != sha
                or ops.output('git', '-C', str(source), 'status', '--porcelain', '--untracked-files=all')
                or ops.output('git', '-C', str(source), 'rev-parse', sha + ':.github/workflows/dev-setup.yml') != MAC_WORKFLOW_BLOB
                or ops.output('git', '-C', str(source), 'rev-parse', 'HEAD^{tree}') != evidence.get('tree')):
            return False
        if set(evidence.get('checksums', {})) != {'local-macos-launcher.log', 'local-missing-key.log'}:
            return False
        for name, digest in evidence['checksums'].items():
            if hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
                return False
        return True
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return False


def accept_evidence(root, sha, stream):
    """Private SSH stdin only. Fixed filenames; validate everything before publish."""
    raw = stream.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError('Evidence exceeds size limit')
    bundle = json.loads(raw)
    if set(bundle) != {'receipt', 'logs'} or set(bundle['logs']) != set(COMMANDS):
        raise ValueError('Unexpected evidence fields')
    release = root / 'auto-deploy/releases' / revision(sha)
    tree = ops.output('git', '-C', str(release / 'source'), 'rev-parse', 'HEAD^{tree}')
    with tempfile.TemporaryDirectory(prefix='receipt-', dir=release) as temp:
        stage = Path(temp)
        for name, encoded in bundle['logs'].items():
            (stage / (name + '.log')).write_bytes(base64.b64decode(encoded, validate=True))
        validate_receipt(bundle['receipt'], stage, sha, tree)
        directory = release / 'local-frontend'
        directory.mkdir(mode=0o700, exist_ok=True)
        for name in COMMANDS:
            (stage / (name + '.log')).replace(directory / (name + '.log'))
        ops.write_json(directory / 'receipt.json', bundle['receipt'])


def inherited_checks(root, baseline, sha):
    with ThreadPoolExecutor(max_workers=3) as pool:
        checks = pool.submit(ops.api, 'commits/' + baseline + '/check-runs?per_page=100')
        runs = pool.submit(ops.api, 'actions/runs?head_sha=' + baseline + '&event=push&branch=main&per_page=100')
        candidate = pool.submit(ops.api, 'commits/' + sha + '/check-runs?per_page=100')
        green = baseline_green(root, baseline, checks.result()['check_runs'], runs.result()['workflow_runs'])
        failed = candidate_failures(candidate.result()['check_runs'], sha)
    return green and not failed


def abort_prewarm(root, sha):
    path = root / 'auto-deploy/releases' / sha / 'prewarm.json'
    if not path.exists():
        return False
    saved = json.loads(path.read_text())
    port = saved.get('port')
    if (saved.get('revision') != sha or port not in SLOTS
            or read_route(root / 'routing/active.json')['publicPort'] == port):
        return False
    try:
        inspected = json.loads(ops.output('docker', 'inspect', SLOTS[port][1]))[0]
    except subprocess.CalledProcessError:
        return False
    if (inspected.get('Image') != saved.get('image')
            or inspected['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != sha):
        return False
    ops.run('docker', 'stop', SLOTS[port][1])
    return True


def prewarm_frontend(root, sha, baseline, release, source, image):
    if not (root / 'auto-deploy/local-frontend-prewarm.enabled').exists():
        return
    route = read_route(root / 'routing/active.json')
    if route['release'] == sha:
        return
    if not inherited_checks(root, baseline, sha):
        raise RuntimeError('Inherited checks changed; no standby started')
    # Scope was checked before build: backend/dependencies/config/schema are
    # IDENTICAL to the green baseline. Unchecked frontend bytes are never routed
    # publicly. Pending local tests cannot authorize promotion or demo changes.
    ops.backup_databases(release, source)
    port = 28082 if route['publicPort'] == 18082 else 18082
    original = json.loads((root / 'compose.json').read_text())
    file = release / 'prewarm-slot.json'
    ops.write_json(file, slot_config(original, image, port))
    ops.write_json(release / 'prewarm.json', {'revision': sha, 'port': port, 'image': image})
    try:
        slot_compose(ops, file, port, 'up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '90')
    except BaseException:
        abort_prewarm(root, sha)
        raise


class LocalFrontendOps:
    def __init__(self, root, sha, baseline, directory):
        self.root, self.sha, self.baseline, self.directory = root, sha, baseline, directory

    def __getattr__(self, name):
        return getattr(ops, name)

    def validate_evidence(self, sha):
        if sha != self.sha:
            return False
        source = self.root / 'auto-deploy/releases' / sha / 'source'
        if (ops.output('git', '-C', str(source), 'rev-parse', 'HEAD') != sha
                or ops.output('git', '-C', str(source), 'status', '--porcelain', '--untracked-files=all')):
            return False
        check_scope(tree_files(source, self.baseline), tree_files(source, sha))
        tree = ops.output('git', '-C', str(source), 'rev-parse', 'HEAD^{tree}')
        validate_receipt(json.loads((self.directory / 'receipt.json').read_text()), self.directory, sha, tree)
        return True

    def ready(self, sha):
        if not self.validate_evidence(sha):
            return False
        # Revalidate unchanged backend/dependencies/build/deployment/launcher
        # inputs against an exact-main, fully green baseline. Re-runs fail closed.
        # Independent provider reads overlap; every response is still required,
        # including another fresh read immediately before public promotion.
        return inherited_checks(self.root, self.baseline, sha)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/srv/arbor-full'))
    parser.add_argument('--sha', type=revision, required=True)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--accept-evidence', action='store_true')
    parser.add_argument('--abort-prewarm', action='store_true')
    parser.add_argument('--local-github', action='store_true', help='Read fresh CI status through owner-local gh over private SSH')
    parser.add_argument('--rehearse', action='store_true', help='Validate gates without changing running apps')
    parser.add_argument('--redeploy', action='store_true', help='Owner benchmark of the already-live revision')
    args = parser.parse_args()
    if args.local_github:
        from local_github_api import read_local_status
        ops.api = read_local_status  # This invocation only; no credentials or GitHub status changes.
    os.umask(0o077)
    root, sha = args.root, args.sha
    if args.accept_evidence:
        accept_evidence(root, sha, sys.stdin.buffer)
        return
    if not args.abort_prewarm and not (root / 'auto-deploy/blue-green.enabled').exists():
        raise RuntimeError('Blue/green release must already be enabled')
    with (root / 'deployment.lock').open('a') as lock:
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Another release still owns the deployment lock; no changes made')
                time.sleep(0.1)
        if args.abort_prewarm:
            print(json.dumps({'stoppedInactivePrewarm': abort_prewarm(root, sha)}))
            return
        baseline = revision((root / 'auto-deploy/local-frontend-baseline').read_text().strip())
        if (root / 'auto-deploy/PAUSED').exists() or ops.main_sha() != sha:
            raise RuntimeError('Paused or not current main')
        if (root / 'auto-deploy/activation.json').exists():
            recovered = recover_activation(root, ops)
            if recovered and recovered.get('phase') == 'blocked':
                raise RuntimeError('Interrupted release needs operator recovery')
        state_file = root / 'auto-deploy/status.json'
        state = json.loads(state_file.read_text())
        if state.get('failedSha') == sha:
            raise RuntimeError('A recorded failed rollout requires normal operator recovery')
        release, source = scoped_source(root, sha, baseline)
        _release, _source, image = ops.prepare_artifact(root, sha)
        if args.prepare:
            if not args.rehearse:
                prewarm_frontend(root, sha, baseline, release, source, image)
            return
        directory = release / 'local-frontend'
        checked = LocalFrontendOps(root, sha, baseline, directory)
        if not checked.validate_evidence(sha):
            raise RuntimeError('Local frontend evidence gate is not satisfied')
        if args.rehearse:
            if not checked.ready(sha):
                raise RuntimeError('Inherited full-check gate is not satisfied')
            print(json.dumps({'phase': 'gates-verified', 'revision': sha, 'baseline': baseline}))
            return
        if state.get('deployedSha') == sha and not args.redeploy:
            print(json.dumps({'phase': 'already-deployed', 'revision': sha}))
            return
        started = time.monotonic()
        state.update(candidateSha=sha, phase='deploying', reason=None)
        ops.write_json(state_file, state)
        try:
            result = deploy_blue_green(root, sha, checked, update_demo=False)
        except Exception:
            state.update(phase='blocked', failedSha=sha, reason='Local release failed: see protected operator log')
            ops.write_json(state_file, state)
            raise
        state.update(json.loads(state_file.read_text()))
        state.update(result, stage='complete', localFrontendBaseline=baseline,
                     localFrontendReceipt=str(directory / 'receipt.json'),
                     localReleaseSeconds=round(time.monotonic() - started, 3))
        ops.write_json(state_file, state)
        print(json.dumps({'phase': 'deployed', 'revision': sha, 'localReleaseSeconds': state['localReleaseSeconds']}))


if __name__ == '__main__':
    main()
