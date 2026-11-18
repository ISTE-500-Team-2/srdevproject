"""Daily backup: release-lock and pause guards, retention and failure handling.
Never connects to Docker or a real database.
"""
import configparser
import fcntl
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import auto_release as release
import daily_backup as daily

DEPLOY = Path(__file__).resolve().parent


class DailyBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='arbor-daily-backup-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'auto-deploy').mkdir(mode=0o700)
        self.daily = self.root / 'auto-deploy/daily-backups'
        self.calls = []
        self.timeouts = []

    def fake_run(self, failure=None):
        def run(*args, **kwargs):
            self.calls.append(args)
            self.timeouts.append((args, kwargs.get('timeout')))
            if 'pg_dump' in args:
                if failure and failure in args:
                    raise release.subprocess.CalledProcessError(1, args)
                kwargs['stdout'].write(b'PGDMP fixture ' + args[args.index('-d') + 1].encode())
            if 'pg_restore' in args:
                assert kwargs['stdin'].read().startswith(b'PGDMP')
        return run

    def backup(self, *extra, failure=None, free=10 * 1024**3):
        disk = type('Disk', (), {'free': free})()
        with patch.object(release, 'run', self.fake_run(failure)), \
                patch.object(daily.shutil, 'disk_usage', return_value=disk), \
                patch.object(daily, 'log'):
            return daily.main(['--root', str(self.root), '--wait', '0', *extra])

    def completed(self):
        return sorted(p.name for p in self.daily.iterdir() if daily.STAMP.match(p.name)) if self.daily.exists() else []

    def old_backups(self, count):
        self.daily.mkdir(parents=True, exist_ok=True)
        names = ['202601%02dT033000Z' % day for day in range(1, count + 1)]
        for name in names:
            (self.daily / name).mkdir()
            (self.daily / name / 'arbor_mvc_dev.dump').write_bytes(b'PGDMP old')
        return names

    def status(self):
        return json.loads((self.root / 'auto-deploy/daily-backup.json').read_text())

    def test_backs_up_every_release_database_with_the_release_dump_check(self):
        self.assertEqual(self.backup(), 0)
        [name] = self.completed()
        folder = self.daily / name
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        for _, _, database in release.DATABASES:
            dump = folder / (database + '.dump')
            self.assertEqual(dump.read_bytes(), b'PGDMP fixture ' + database.encode())
            self.assertEqual(dump.stat().st_mode & 0o777, 0o600)
        dumps = [c for c in self.calls if 'pg_dump' in c]
        self.assertEqual([c[2] for c in dumps], [container for container, _, _ in release.DATABASES])
        self.assertTrue(all('--format=custom' in c for c in dumps))
        self.assertEqual(len([c for c in self.calls if 'pg_restore' in c]), len(release.DATABASES))
        # A large dump gets its own longer limit; the archive check keeps run()'s default.
        self.assertEqual({t for c, t in self.timeouts if 'pg_dump' in c}, {release.DUMP_TIMEOUT_SECONDS})
        self.assertEqual({t for c, t in self.timeouts if 'pg_restore' in c}, {None})
        self.assertEqual(self.status()['lastSuccess'], name)
        self.assertFalse(any(p.name.endswith('.partial') for p in self.daily.iterdir()))

    def test_keeps_only_the_newest_daily_backups_and_nothing_else(self):
        old = self.old_backups(15)
        (self.daily / 'operator-copy').mkdir()
        releases = self.root / 'auto-deploy/releases' / ('a' * 40)
        releases.mkdir(parents=True)
        (releases / 'arbor_mvc_dev.dump').write_bytes(b'PGDMP release')
        self.assertEqual(self.backup('--keep', '14'), 0)
        kept = self.completed()
        self.assertEqual(len(kept), 14)
        self.assertEqual(kept[:13], old[-13:])
        self.assertTrue((self.daily / 'operator-copy').is_dir())
        self.assertTrue((releases / 'arbor_mvc_dev.dump').exists())
        self.assertEqual(self.status()['kept'], kept)

    def test_failed_dump_keeps_every_older_backup_and_leaves_no_partial_folder(self):
        old = self.old_backups(14)
        self.assertEqual(self.backup(failure=release.DATABASES[1][0]), 1)
        self.assertEqual(self.completed(), old)
        self.assertFalse(any(p.name.endswith('.partial') for p in self.daily.iterdir()))
        self.assertIn('Failed: CalledProcessError', self.status()['lastProblem'])

    def test_empty_dump_is_a_failure(self):
        def run(*args, **kwargs):
            self.calls.append(args)
        disk = type('Disk', (), {'free': 10 * 1024**3})()
        with patch.object(release, 'run', run), patch.object(daily, 'log'), \
                patch.object(daily.shutil, 'disk_usage', return_value=disk):
            self.assertEqual(daily.main(['--root', str(self.root), '--wait', '0']), 1)
        self.assertEqual(self.completed(), [])

    def test_refuses_while_a_release_holds_the_deployment_lock(self):
        old = self.old_backups(14)
        with (self.root / 'deployment.lock').open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.backup(), daily.EXIT_SKIPPED)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.completed(), old)
        self.assertIn('deployment lock', self.status()['lastProblem'])

    def test_waits_for_a_running_release_to_finish(self):
        held = (self.root / 'deployment.lock').open('a')
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)

        def release_finishes(_seconds):
            held.close()
        with patch.object(daily.time, 'sleep', release_finishes):
            self.assertEqual(self.backup('--wait', '60'), 0)
        self.assertEqual(len(self.completed()), 1)

    def test_release_deployer_leaves_the_backup_alone(self):
        with (self.root / 'deployment.lock').open('a') as lock:
            daily.acquire(lock, 0)
            with patch.object(release, 'tick') as tick, \
                    patch('sys.argv', ['auto_release.py', '--root', str(self.root)]), \
                    patch('builtins.print'):
                release.main()
            tick.assert_not_called()

    def test_refuses_while_releases_are_paused(self):
        (self.root / 'auto-deploy/PAUSED').touch()
        self.assertEqual(self.backup(), daily.EXIT_SKIPPED)
        self.assertEqual(self.calls, [])
        self.assertIn('paused', self.status()['lastProblem'])

    def test_low_disk_refuses_without_deleting_anything(self):
        old = self.old_backups(15)
        self.assertEqual(self.backup(free=1024**3), daily.EXIT_SKIPPED)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.completed(), old)

    def test_unfinished_backup_from_a_crash_is_removed(self):
        self.daily.mkdir(parents=True)
        (self.daily / '20260101T033000Z.partial').mkdir()
        self.assertEqual(self.backup(), 0)
        self.assertFalse((self.daily / '20260101T033000Z.partial').exists())

    def test_keep_must_be_positive(self):
        with patch('sys.stderr'), self.assertRaises(SystemExit):
            daily.main(['--root', str(self.root), '--keep', '0'])

    def test_units_follow_the_auto_release_install(self):
        service = configparser.ConfigParser(strict=False, interpolation=None)
        service.read(DEPLOY / 'arbor-daily-backup.service')
        release_service = configparser.ConfigParser(strict=False, interpolation=None)
        release_service.read(DEPLOY / 'arbor-auto-release.service')
        self.assertEqual(service['Service']['Type'], 'oneshot')
        self.assertEqual(service['Service']['UMask'], release_service['Service']['UMask'])
        self.assertIn('/srv/arbor-full/auto-deploy/daily_backup.py', service['Service']['ExecStart'])
        self.assertIn('/srv/arbor-full/auto-deploy/', service['Service']['StandardOutput'])
        timer = configparser.ConfigParser(strict=False, interpolation=None)
        timer.read(DEPLOY / 'arbor-daily-backup.timer')
        self.assertTrue(timer['Timer']['OnCalendar'])
        self.assertEqual(timer['Timer']['Persistent'], 'true')
        self.assertEqual(timer['Install']['WantedBy'], 'timers.target')


if __name__ == '__main__':
    unittest.main()
