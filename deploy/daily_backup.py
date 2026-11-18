#!/usr/bin/env python3
"""Daily public/demo database backup on the RLES stack, with a retention count (NFR-006).

Uses the release deployer's own dump and check (auto_release.dump_database) and its deployment
lock, so a backup never runs during a release. Never migrates, restores or deletes data; it
removes only its own older daily backup folders, and only after a new backup has succeeded.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import time

import auto_release as ops

# A completed day's folder is a UTC stamp; anything else under daily-backups is left alone.
STAMP = re.compile(r'^\d{8}T\d{6}Z$')
PARTIAL = re.compile(r'^\d{8}T\d{6}Z\.partial$')
# The same floor the deployer uses before an optional image build.
MIN_FREE_BYTES = 2 * 1024**3
EXIT_SKIPPED = 75  # EX_TEMPFAIL: not a broken backup, but no backup was taken either.


class Skipped(RuntimeError):
    """A release, pause or low disk means no backup was taken this time."""


def log(*message):
    print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), *message, flush=True)


def acquire(lock, wait_seconds, poll_seconds=15):
    """Hold the deployment lock, waiting up to wait_seconds for a running release to finish."""
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise Skipped('A release still holds the deployment lock')
            log('A release holds the deployment lock; waiting before the backup')
            time.sleep(poll_seconds)


def prune(directory, keep):
    """Keep the newest `keep` completed daily backups. Release dumps live elsewhere and stay."""
    completed = sorted(p for p in directory.iterdir() if p.is_dir() and not p.is_symlink() and STAMP.match(p.name))
    for old in completed[:-keep]:
        shutil.rmtree(old)
        log('Removed old daily backup', old.name)
    return completed[-keep:]


def backup(root, keep):
    """Take one dated backup of every configured database. Caller holds the deployment lock."""
    directory = root / 'auto-deploy'
    if (directory / 'PAUSED').exists():
        # Operators pause releases for migrations; a dump would hold locks they need.
        raise Skipped('Releases are paused (auto-deploy/PAUSED); an operator is working on the databases')
    daily = directory / 'daily-backups'
    daily.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(daily).free < MIN_FREE_BYTES:
        raise Skipped('Less than 2 GiB free; nothing was deleted to make room')
    # A crash leaves a .partial folder; it was never a usable backup.
    for stale in daily.iterdir():
        if stale.is_dir() and not stale.is_symlink() and PARTIAL.match(stale.name):
            shutil.rmtree(stale)
            log('Removed unfinished backup', stale.name)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    partial = daily / (stamp + '.partial')
    partial.mkdir(mode=0o700)
    try:
        for container, user, database in ops.DATABASES:
            log('Backing up', database)
            ops.dump_database(container, user, database, partial / (database + '.dump'))
            log('Backed up', database, (partial / (database + '.dump')).stat().st_size, 'bytes; pg_restore can read it')
        finished = daily / stamp
        partial.rename(finished)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise
    kept = prune(daily, keep)
    ops.write_json(directory / 'daily-backup.json', {
        'lastSuccess': stamp, 'directory': str(finished), 'kept': [p.name for p in kept]})
    log('Daily backup complete:', finished, '- keeping', len(kept), 'of at most', keep)
    return finished


def record_problem(root, message):
    path = root / 'auto-deploy/daily-backup.json'
    try:
        state = json.loads(path.read_text()) if path.exists() else {}
        state.update(lastProblem=message, lastProblemAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
        ops.write_json(path, state)
    except (OSError, ValueError):
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/srv/arbor-full'))
    parser.add_argument('--keep', type=int, default=14, help='Daily backups to keep (default 14)')
    parser.add_argument('--wait', type=int, default=2400,
                        help='Seconds to wait for a running release to finish (default 2400)')
    args = parser.parse_args(argv)
    if args.keep < 1:
        parser.error('--keep must be at least 1')
    os.umask(0o077)

    def interrupted(_number, _frame):
        raise RuntimeError('Backup interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    try:
        with (args.root / 'deployment.lock').open('a') as lock:
            acquire(lock, args.wait)
            backup(args.root, args.keep)
        return 0
    except Skipped as reason:
        log('Daily backup skipped:', reason)
        record_problem(args.root, 'Skipped: ' + str(reason))
        return EXIT_SKIPPED
    except Exception as error:
        # Command output can carry connection details; keep only the error type in the status file.
        log('Daily backup FAILED:', type(error).__name__, error)
        record_problem(args.root, 'Failed: ' + type(error).__name__ + ' (see daily-backup.log)')
        return 1


if __name__ == '__main__':
    sys.exit(main())
