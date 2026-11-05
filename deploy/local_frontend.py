#!/usr/bin/env python3
"""Run warm local frontend checks and immediately invoke the SSH release gate."""
import argparse
import base64
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import subprocess
import tempfile
import time

from local_frontend_release import COMMANDS, revision
from local_github_api import github_bridge

SERVER_SCRIPT = '/srv/arbor-full/auto-deploy/local-frontend-tools/local_frontend_release.py'


def output(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def pristine(source):
    if output('git', '-C', str(source), 'status', '--porcelain', '--untracked-files=all'):
        raise RuntimeError('Use a pristine checkout of the exact merged main revision')
    return revision(output('git', '-C', str(source), 'rev-parse', 'HEAD'))


def remote(host, *args):
    if args[:2] == ('python3', SERVER_SCRIPT):
        args = (*args, '--local-github')
    return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host,
            shlex.join(args)]


@contextmanager
def cleanup_failed_check(host, sha):
    try:
        yield
    except BaseException:
        try:
            subprocess.run(remote(host, 'python3', SERVER_SCRIPT, '--sha', sha, '--abort-prewarm'),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        except subprocess.SubprocessError:
            pass  # Protected prewarm record remains available for safe operator cleanup.
        raise


@contextmanager
def settle_pool_before_cleanup(pool):
    try:
        yield
    finally:
        pool.shutdown(wait=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--host', default='arbor-rles-new')
    parser.add_argument('--evidence-dir', type=Path, help='Private logs/receipt directory outside the checkout')
    parser.add_argument('--rehearse', action='store_true', help='Check/build without changing running applications')
    parser.add_argument('--redeploy', action='store_true', help='Explicit already-live revision benchmark')
    args = parser.parse_args()
    started = time.monotonic()
    os.umask(0o077)
    source = args.source.resolve()
    sha = pristine(source)
    if output('git', '-C', str(source), 'rev-parse', 'origin/main') != sha:
        raise RuntimeError('Check out the exact merged origin/main revision, not a PR head')
    tree = output('git', '-C', str(source), 'rev-parse', 'HEAD^{tree}')
    node = output('node', '--version')
    if node != 'v24.22.1' or platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('The trusted local profile requires macOS arm64 and pinned Node24.22.1')
    if os.environ.get('PGHOST') not in ('127.0.0.1', 'localhost') or os.environ.get('DATABASE_URL'):
        raise RuntimeError('Provide explicit loopback isolated test PostgreSQL, never production DATABASE_URL')
    release_script = SERVER_SCRIPT
    evidence = args.evidence_dir.resolve() if args.evidence_dir else Path(tempfile.mkdtemp(prefix='arbor-local-frontend-'))
    if evidence == source or source in evidence.parents:
        raise RuntimeError('Keep verification evidence outside the checked source tree')
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    evidence.chmod(0o700)
    print('Protected verification logs:', evidence, flush=True)
    directory = evidence
    def lane(name, command):
        stamp = time.monotonic()
        with (directory / (name + '.log')).open('wb') as stream:
            result = subprocess.run(command, cwd=source, stdout=stream, stderr=subprocess.STDOUT, timeout=240)
        if result.returncode:
            raise RuntimeError(name + ' failed; no production activation requested')
        return {'command': command, 'exitCode': result.returncode,
                'sha256': hashlib.sha256((directory / (name + '.log')).read_bytes()).hexdigest(),
                'seconds': round(time.monotonic() - stamp, 3)}
    def prepare():
        with (directory / 'prepare.log').open('wb') as stream:
            flags = ['--rehearse'] if args.rehearse else []
            subprocess.run(remote(args.host, 'python3', release_script, '--sha', sha, '--prepare', *flags),
                           stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=1200)
    # CPU checks start immediately, while the authenticated SSH bridge opens.
    # Settle preparation before failed-check cleanup, even on exceptions.
    with ThreadPoolExecutor(max_workers=4) as pool:
        checks = {name: pool.submit(lane, name, cmd) for name, cmd in COMMANDS.items()}
        with github_bridge(args.host), cleanup_failed_check(args.host, sha), settle_pool_before_cleanup(pool):
            bridge_ready_seconds = time.monotonic() - started
            preparation = pool.submit(prepare)
            results = {name: future.result() for name, future in checks.items()}
            preparation.result()
            if pristine(source) != sha or output('git', '-C', str(source), 'rev-parse', 'HEAD^{tree}') != tree:
                raise RuntimeError('Source changed while checking; results discarded')
            receipt = {'version': 1, 'revision': sha, 'tree': tree, 'node': node,
                       'platform': 'Darwin-arm64', 'completedAt': time.time(), 'checks': results}
            (directory / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            bundle = {'receipt': receipt, 'logs': {n: base64.b64encode((directory / (n + '.log')).read_bytes()).decode()
                                                  for n in COMMANDS}}
            subprocess.run(remote(args.host, 'python3', release_script, '--sha', sha, '--accept-evidence'),
                           input=json.dumps(bundle).encode(), check=True)
            checked_seconds = time.monotonic() - started
            flags = ['--rehearse'] if args.rehearse else ['--redeploy'] if args.redeploy else []
            subprocess.run(remote(args.host, 'python3', release_script, '--sha', sha, *flags), check=True)
            timing = {'revision': sha, 'rehearsal': args.rehearse,
                      'bridgeReadySeconds': round(bridge_ready_seconds, 3),
                      'checkAndPreparationSeconds': round(checked_seconds, 3),
                      'totalIncludingChecksSeconds': round(time.monotonic() - started, 3),
                      'lanes': {n: item['seconds'] for n, item in results.items()}}
            (directory / 'timing.json').write_text(json.dumps(timing, indent=2) + '\n')
            print(json.dumps(timing))


if __name__ == '__main__':
    main()
