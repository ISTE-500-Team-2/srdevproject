"""CI gate and rollout fault injection. No real Docker, SSH, network or member data."""
import copy
import io
import hashlib
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import auto_release as release

SHA = 'a' * 40
IMAGE = 'sha256:' + 'b' * 64
REFUND_MIGRATION = '053_checkout_refund_reconciliation.sql'
REGISTRATION_MIGRATION = '055_pending_registration_password_confirmation.sql'
PATHS = ['.github/workflows/mvc-verify.yml', '.github/workflows/dev-setup.yml', '.github/workflows/sponsor-hosting.yml']


def checks():
    return [dict(id=i, name=name, head_sha=SHA, app={'slug': 'github-actions'},
                 status='completed', conclusion='success') for i, name in enumerate(sorted(release.REQUIRED), 1)]


def workflows():
    return [dict(id=i, head_sha=SHA, head_branch='main', event='push', path=path,
                 status='completed', conclusion='success', run_attempt=1) for i, path in enumerate(PATHS, 1)]


def config():
    service = dict(image='old:retained', container_name='fixture', env_file='/protected/env',
                   environment={'EXISTING': 'preserve'}, volumes=['/protected/key:/key:ro'],
                   ports=['127.0.0.1:8082:8080'], networks=['existing'], depends_on=['db'])
    return {'services': {**{n: copy.deepcopy(service) for n in release.APPS},
                         'gateway': {'image': 'patched-node', 'network_mode': 'host'},
                         'db': {'image': 'existing-db', 'volumes': ['persistent:/var/lib/postgresql/data']}},
            'networks': {'existing': {'name': 'existing-network', 'internal': True}}}


class GateTests(unittest.TestCase):
    def test_ci_details_never_turn_partial_success_into_release_permission(self):
        candidate = checks(); candidate[-1]['status'] = 'in_progress'; candidate[-1]['conclusion'] = None
        detail = {}
        with patch.object(release, 'api', side_effect=[{'check_runs': candidate}, {'workflow_runs': workflows()}]):
            self.assertFalse(release.ready(SHA, detail))
        self.assertEqual(detail['passed'], len(release.REQUIRED)-1)
        self.assertEqual(detail['revision'], SHA)

    def test_cached_image_is_immutable_and_requires_pristine_exact_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); directory=root/'auto-deploy/releases'/SHA; directory.mkdir(parents=True)
            release.write_json(directory/'prepared-image.json', {'version':1,'revision':SHA,'image':IMAGE})
            def output(*args):
                if 'rev-parse' in args:return SHA
                if 'status' in args:return ''
                return json.dumps([{'Id':IMAGE,'Config':{'Labels':{'org.opencontainers.image.revision':SHA}}}])
            with patch.object(release,'output',output),patch.object(release,'run') as build:
                self.assertEqual(release.prepare_artifact(root,SHA),(directory,directory/'source',IMAGE))
                build.assert_not_called()
            for bad in ('dirty','wrong-head','wrong-label','missing-image'):
                def changed(*args):
                    if bad=='dirty' and 'status' in args:return ' M Dockerfile'
                    if bad=='wrong-head' and 'rev-parse' in args:return 'c'*40
                    if 'inspect' in args:
                        if bad=='missing-image':raise subprocess.CalledProcessError(1,args)
                        if bad=='wrong-label':return json.dumps([{'Id':IMAGE,'Config':{'Labels':{'org.opencontainers.image.revision':'c'*40}}}])
                    return output(*args)
                with patch.object(release,'output',changed):self.assertIsNone(release.cached_artifact(root,SHA),bad)
            release.write_json(directory/'prepared-image.json',{'version':1,'revision':'c'*40,'image':IMAGE})
            self.assertIsNone(release.cached_artifact(root,SHA))

    def test_modified_source_is_not_rebuilt_and_mislabelled_as_reviewed_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            def output(*args):return ' M Dockerfile' if 'status' in args else SHA
            with patch.object(release,'output',output),patch.object(release,'run') as run:
                with self.assertRaisesRegex(RuntimeError,'not pristine'):
                    release.prepare_artifact(Path(temporary),SHA)
                self.assertFalse(any('docker' in call.args for call in run.call_args_list))

    def test_restrictive_checkout_remains_runnable_without_exposing_private_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            private = Path(temporary)
            private.chmod(0o700)
            source = private / 'source'; source.mkdir(mode=0o700)
            subprocess.run(['git', 'init', '-q', str(source)], check=True)
            backend = source / 'backend'; backend.mkdir(mode=0o700)
            package = backend / 'package.json'; package.write_text('{"type":"module"}'); package.chmod(0o600)
            launcher = source / 'arbor.sh'; launcher.write_text('#!/bin/sh\n'); launcher.chmod(0o700)
            secret = source / '.operator.private.env'; secret.write_text('fixture only'); secret.chmod(0o600)
            subprocess.run(['git', '-C', str(source), 'add', 'backend/package.json', 'arbor.sh'], check=True)
            release.prepare_source_permissions(source)
            self.assertEqual(package.stat().st_mode & 0o777, 0o644)
            self.assertEqual(launcher.stat().st_mode & 0o777, 0o755)
            self.assertEqual(backend.stat().st_mode & 0o777, 0o755)
            self.assertEqual(source.stat().st_mode & 0o777, 0o755)
            self.assertEqual(secret.stat().st_mode & 0o777, 0o600)
            self.assertEqual(private.stat().st_mode & 0o777, 0o700)
            subprocess.run(['git', '-C', str(source), 'diff', '--exit-code'], check=True)

    def test_source_permissions_do_not_follow_links_outside_private_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            private = Path(temporary); source = private / 'source'; source.mkdir()
            outside = private / 'outside.private'; outside.write_text('fixture'); outside.chmod(0o600)
            link = source / 'link'; link.symlink_to(outside)
            # Real symlink index entries are skipped; a forged regular path fails closed.
            record = '120000 ' + 'a' * 40 + ' 0\tlink\0'
            with patch.object(release, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=record)):
                release.prepare_source_permissions(source)
            self.assertEqual(outside.stat().st_mode & 0o777, 0o600)
            with patch.object(release, 'run', return_value=subprocess.CompletedProcess([], 0, stdout=record.replace('120000', '100644'))):
                with self.assertRaises(ValueError):
                    release.prepare_source_permissions(source)
            self.assertEqual(outside.stat().st_mode & 0o777, 0o600)

    def test_demo_smoke_does_not_send_public_origin_to_private_auth(self):
        with patch.object(release.urllib.request, 'urlopen', return_value=io.BytesIO(b'{}')) as opener:
            release.request('http://127.0.0.1:8081', '/api/auth/demo', {'role': 'admin'})
            self.assertIsNone(opener.call_args[0][0].get_header('Origin'))
        with patch.object(release.urllib.request, 'urlopen', return_value=io.BytesIO(b'{}')) as opener:
            release.request('https://example.invalid', '/api/auth/login', {}, origin_header='https://example.invalid')
            self.assertEqual(opener.call_args[0][0].get_header('Origin'), 'https://example.invalid')

    def test_all_required_exact_sha_main_push_workflows_succeed(self):
        self.assertTrue(release.green_checks(SHA, checks(), workflows()))

    def test_missing_failed_pending_skipped_and_wrong_app_or_sha_block(self):
        self.assertFalse(release.green_checks(SHA, checks()[1:], workflows()))
        for change in ({'conclusion': 'failure'}, {'status': 'in_progress'}, {'conclusion': 'skipped'},
                       {'app': {'slug': 'other-app'}}, {'head_sha': 'c' * 40}):
            candidate = checks(); candidate[0].update(change)
            self.assertFalse(release.green_checks(SHA, candidate, workflows()))

    def test_newer_rerun_blocks_an_older_success(self):
        candidate = checks(); newer = dict(candidate[0], id=99, status='queued', conclusion=None)
        self.assertFalse(release.green_checks(SHA, candidate + [newer], workflows()))

    def test_pr_checks_cannot_substitute_for_successful_main_workflows(self):
        for change in ({'event': 'pull_request'}, {'head_branch': 'feature'}, {'head_sha': 'c' * 40},
                       {'status': 'in_progress'}, {'conclusion': 'failure'}):
            candidate = workflows(); candidate[0].update(change)
            self.assertFalse(release.green_checks(SHA, checks(), candidate))

    def test_shared_selection_keeps_newest_exact_sha_actions_check_and_main_push_run(self):
        older = checks()[0]; newer = dict(older, id=99, conclusion='failure')
        other_app = dict(older, id=100, app={'slug': 'other-app'})
        other_sha = dict(older, id=101, head_sha='c' * 40)
        self.assertEqual(release.latest_checks(SHA, [newer, older, other_app, other_sha]), {older['name']: newer})
        self.assertEqual(release.latest_checks(SHA, [other_app, other_sha]), {})
        runs = workflows(); retry = dict(runs[0], id=50, conclusion='failure')
        pull_request = dict(runs[0], id=60, event='pull_request')
        self.assertIs(release.latest_main_push_run(SHA, runs + [retry, pull_request], PATHS[0]), retry)
        self.assertEqual(release.latest_main_push_run(SHA, [pull_request], PATHS[0]), {})
        self.assertEqual(list(release.MAIN_PUSH_WORKFLOWS), PATHS)

    def test_candidate_only_changes_app_images_and_canaries_cannot_send_email(self):
        original = config(); candidate, canary = release.candidates(original, IMAGE)
        for name in release.APPS:
            expected = dict(original['services'][name], image=IMAGE)
            self.assertEqual(candidate['services'][name], expected)
            self.assertEqual(canary['services'][name]['environment']['EMAIL_ENABLED'], 'false')
            self.assertTrue(canary['services'][name]['ports'][0].startswith('127.0.0.1:180'))
        self.assertEqual(candidate['services']['db'], original['services']['db'])
        self.assertEqual(candidate['services']['gateway'], original['services']['gateway'])
        self.assertEqual(set(canary['services']), set(release.APPS))

    def test_migration_gate_uses_exact_existing_checksums_without_live_ddl(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); directory = root / 'database/migrations'; directory.mkdir(parents=True)
            (directory / '001_fixture.sql').write_text('SELECT 1;')
            rows = [{'name':'001_fixture.sql','checksum':hashlib.sha256(b'SELECT 1;').hexdigest()}]
            release.verify_migrations(root, rows)
            with self.assertRaisesRegex(RuntimeError, 'required before rollout'):
                release.verify_migrations(root, [])
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                release.verify_migrations(root, [{'name':'001_fixture.sql','checksum':'wrong'}])


class RolloutTests(unittest.TestCase):
    def exercise(self, failure=None, *, blue_green=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); original = config()
        (root / 'auto-deploy').mkdir(); release.write_json(root / 'compose.json', original)
        if blue_green:
            (root / 'auto-deploy/blue-green.enabled').touch()
            (root / 'routing').mkdir()
            release.write_json(root / 'routing/active.json', {'version': 1, 'release': 'c' * 40, 'publicPort': 8082})
        with_online_migrations = failure in ('online', 'guard', 'registration-validation')
        if with_online_migrations:
            migrations = root / 'auto-deploy/releases' / SHA / 'source/database/migrations'
            migrations.mkdir(parents=True)
            (migrations / REFUND_MIGRATION).write_text('SELECT 1;')
            (migrations / REGISTRATION_MIGRATION).write_text('SELECT 2;')
        calls = []

        def run(*args, **kwargs):
            calls.append(('run', args))
            if blue_green and 'compose' in args and 'up' in args:
                raise RuntimeError('Fixture reached standby startup')
            if 'pg_dump' in args:
                if failure == 'backup':
                    raise RuntimeError('Backup failed')
                kwargs['stdout'].write(b'PGDMP fixture')

        def compose(file, *args):
            calls.append(('compose', args, json.loads(file.read_text())))
            if file.name == 'compose.json' and 'up' in args and failure == 'health':
                if json.loads(file.read_text())['services'][release.APPS[0]]['image'] == IMAGE:
                    raise RuntimeError('New container health failed')

        def verify(_root, origin, demo=False):
            calls.append(('verify', origin))
            if failure == 'smoke' and origin == 'http://127.0.0.1:8082':
                raise RuntimeError('Live smoke failed')

        def output(*args):
            calls.append(('output', args))
            if 'app_pending_registration_password_confirmation' in args[-1]:
                self.assertIn('convalidated', args[-1])
                return 'f' if failure == 'registration-validation' and release.DATABASES[1][2] in args else 't'
            if 'pg_constraint' in args[-1]:
                return 'f' if failure == 'guard' else 't'
            if 'app_migration' in args[-1] and with_online_migrations:
                checksum = hashlib.sha256(b'SELECT 1;').hexdigest()
                rows = [
                    {'name': REFUND_MIGRATION, 'checksum': checksum},
                    {'name': REGISTRATION_MIGRATION, 'checksum': hashlib.sha256(b'SELECT 2;').hexdigest()},
                ]
                if failure != 'online':
                    rows.append({'name': 'online:' + REFUND_MIGRATION, 'checksum': checksum})
                return json.dumps(rows)
            if 'rev-parse' in args:return SHA
            if 'status' in args:return ''
            return json.dumps([{'Id': IMAGE,'Config':{'Labels':{'org.opencontainers.image.revision':SHA}}}])

        def migration_gate(_source, _rows):
            if failure == 'migration':
                raise RuntimeError('Missing reviewed migration')
            if with_online_migrations:
                original_gate(_source, _rows)

        original_gate = release.verify_migrations

        with patch.object(release, 'run', run), patch.object(release, 'output', output), \
             patch.object(release, 'prepare_source_permissions'), \
             patch.object(release, 'compose', compose), patch.object(release, 'verify', verify), \
             patch.object(release, 'verify_migrations', migration_gate), \
             patch.object(release, 'main_sha', return_value=SHA), \
             patch.object(release, 'ready', return_value=(failure != 'ci-changed')):
            try:
                result = release.deploy(root, SHA)
            except RuntimeError as error:
                calls.append(('error', str(error)))
                result = None
        return root, original, calls, result

    def test_missing_migration_or_failed_backup_never_replaces_apps(self):
        for failure in ('migration', 'backup'):
            root, original, calls, result = self.exercise(failure)
            self.assertIsNone(result)
            self.assertEqual(json.loads((root / 'compose.json').read_text()), original)
            self.assertFalse(any(c[0] == 'compose' and 'up' in c[1] for c in calls))

    def test_blue_green_requires_online_completion_before_starting_standby(self):
        for failure in ('online', 'guard', 'registration-validation'):
            with self.subTest(failure=failure):
                root, original, calls, result = self.exercise(failure, blue_green=True)
                self.assertIsNone(result)
                self.assertEqual(json.loads((root / 'compose.json').read_text()), original)
                self.assertEqual(json.loads((root / 'routing/active.json').read_text())['publicPort'], 8082)
                self.assertFalse(any('up' in c[1] or 'pg_dump' in c[1] for c in calls if c[0] in ('run', 'compose')))
                self.assertTrue(any(c[0] == 'error' and 'online migration phase' in c[1] for c in calls))
                if failure == 'registration-validation':
                    checked = [call[1][call[1].index('-d') + 1] for call in calls
                               if call[0] == 'output' and 'app_pending_registration_password_confirmation' in call[1][-1]]
                    self.assertEqual(checked, [database for _, _, database in release.DATABASES])
                    self.assertTrue(any(c[0] == 'error' and 'pending registration constraint' in c[1] for c in calls))

    def test_health_or_live_smoke_failure_restores_prior_compose(self):
        for failure in ('health', 'smoke'):
            root, original, calls, result = self.exercise(failure)
            self.assertIsNone(result)
            self.assertEqual(json.loads((root / 'compose.json').read_text()), original)
            ups = [c for c in calls if c[0] == 'compose' and 'up' in c[1] and c[1][-2:] == release.APPS]
            self.assertEqual([c[2]['services'][release.APPS[0]]['image'] for c in ups], [IMAGE, 'old:retained'])

    def test_ci_change_after_build_blocks_cutover(self):
        root, original, calls, result = self.exercise('ci-changed')
        self.assertIsNone(result)
        self.assertEqual(json.loads((root / 'compose.json').read_text()), original)

    def test_success_saves_backups_and_never_resets_db_or_gateway(self):
        root, original, calls, result = self.exercise()
        self.assertEqual(result['deployedSha'], SHA)
        observed = json.loads((root / 'compose.json').read_text())
        self.assertEqual(observed['services']['db'], original['services']['db'])
        self.assertEqual(observed['services']['gateway'], original['services']['gateway'])
        self.assertEqual(len(list((root / 'auto-deploy/releases' / SHA).glob('*.dump'))), 2)
        self.assertFalse(any('down' in c[1] or '--volumes' in c[1] for c in calls if c[0] in ('run', 'compose')))

    def test_pause_failed_sha_and_deployed_sha_do_not_redeploy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); directory = root / 'auto-deploy'; directory.mkdir()
            for initial in ({'deployedSha': SHA}, {'failedSha': SHA}):
                release.write_json(directory / 'status.json', initial)
                with patch.object(release, 'main_sha', return_value=SHA), patch.object(release, 'deploy') as deploy:
                    release.tick(root)
                    deploy.assert_not_called()
            (directory / 'PAUSED').touch()
            with patch.object(release, 'main_sha') as remote:
                release.tick(root)
                remote.assert_not_called()

    def test_opt_in_prebuild_never_deploys_before_ci_and_reuses_exact_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); directory=root/'auto-deploy'; directory.mkdir()
            release.write_json(directory/'status.json',{'deployedSha':'c'*40})
            with patch.object(release,'main_sha',return_value=SHA),patch.object(release,'ready',return_value=False),patch.object(release,'prepare_artifact') as build,patch.object(release,'deploy') as deploy,patch.object(release,'CI_POLL_SECONDS',0):
                release.tick(root);build.assert_not_called();deploy.assert_not_called()
                (directory/'prebuild.enabled').touch()
                release.tick(root);build.assert_called_once_with(root,SHA);deploy.assert_not_called()
                state=json.loads((directory/'status.json').read_text())
                self.assertEqual(state['preparedSha'],SHA)
                self.assertEqual(state['deployedSha'],'c'*40)
                self.assertEqual(state['phase'],'waiting-for-ci')

    def test_prebuild_failure_or_unavailable_ci_cannot_block_or_replace_current_site(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); directory=root/'auto-deploy'; directory.mkdir()
            release.write_json(directory/'status.json',{'deployedSha':'c'*40})
            (directory/'prebuild.enabled').touch()
            poll_at_once=patch.object(release,'CI_POLL_SECONDS',0);poll_at_once.start();self.addCleanup(poll_at_once.stop)
            with patch.object(release,'main_sha',return_value=SHA),patch.object(release,'ready',return_value=False),patch.object(release,'prepare_artifact',side_effect=RuntimeError('PRIVATE must not enter status')) as build,patch.object(release,'deploy') as deploy:
                release.tick(root);release.tick(root)
                build.assert_called_once();deploy.assert_not_called()
                state=json.loads((directory/'status.json').read_text())
                self.assertNotIn('failedSha',state)
                self.assertEqual(state['deployedSha'],'c'*40)
                self.assertNotIn('PRIVATE',json.dumps(state))
            with patch.object(release,'main_sha',return_value=SHA),patch.object(release,'ready',side_effect=RuntimeError('API unavailable')),patch.object(release,'deploy') as deploy:
                release.tick(root);deploy.assert_not_called()
                self.assertEqual(json.loads((directory/'status.json').read_text())['stage'],'ci-status-unavailable')

    def test_waiting_revision_rechecks_github_at_most_every_few_minutes(self):
        # Unauthenticated GitHub reads are limited to 60 an hour and each check makes two.
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); directory=root/'auto-deploy'; directory.mkdir()
            release.write_json(directory/'status.json',{'deployedSha':'c'*40})
            clock=[1000.0]
            with patch.object(release,'main_sha',return_value=SHA),patch.object(release,'ready',return_value=False) as ready,patch.object(release,'deploy') as deploy,patch.object(release.time,'time',side_effect=lambda:clock[0]):
                for _ in range(3): release.tick(root)
                self.assertEqual(ready.call_count,1)
                self.assertEqual(json.loads((directory/'status.json').read_text())['phase'],'waiting-for-ci')
                clock[0]+=release.CI_POLL_SECONDS-1;release.tick(root)
                self.assertEqual(ready.call_count,1)
                clock[0]+=1;release.tick(root)
                self.assertEqual(ready.call_count,2)
                release.tick(root,retry=True)
                self.assertEqual(ready.call_count,3,'an operator retry checks at once')
                self.assertLessEqual(2*len(range(0,3600,release.CI_POLL_SECONDS)),60)
            with patch.object(release,'main_sha',return_value='d'*40),patch.object(release,'ready',side_effect=RuntimeError('rate limited')) as ready,patch.object(release,'deploy') as deploy,patch.object(release.time,'time',side_effect=lambda:clock[0]):
                release.tick(root);release.tick(root)
                self.assertEqual(ready.call_count,1,'a new revision checks at once; an unavailable API backs off too')
                state=json.loads((directory/'status.json').read_text())
                self.assertEqual((state['candidateSha'],state['stage']),('d'*40,'ci-status-unavailable'))
            deploy.assert_not_called()

    def test_failed_ci_never_starts_speculative_image_build(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); directory=root/'auto-deploy';directory.mkdir();(directory/'prebuild.enabled').touch()
            def failed(sha,detail):detail['checks']=[{'name':'verify','conclusion':'failure'}];return False
            with patch.object(release,'main_sha',return_value=SHA),patch.object(release,'ready',failed),patch.object(release,'prepare_artifact') as build,patch.object(release,'deploy') as deploy:
                release.tick(root);build.assert_not_called();deploy.assert_not_called()

    def test_low_disk_holds_prebuild_without_deleting_retained_releases(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);directory=root/'auto-deploy';directory.mkdir();(directory/'prebuild.enabled').touch()
            with patch.object(release,'main_sha',return_value=SHA),patch.object(release,'ready',return_value=False),patch.object(release.shutil,'disk_usage',return_value=type('Disk',(),{'free':0})()),patch.object(release,'prepare_artifact') as build:
                release.tick(root);build.assert_not_called()
                state=json.loads((directory/'status.json').read_text())
                self.assertIn('no automatic deletion',state['reason'])


if __name__ == '__main__':
    unittest.main()
