"""CI gate and rollout fault injection. No real Docker, SSH, network or member data."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import auto_release as release

SHA = 'a' * 40
IMAGE = 'sha256:' + 'b' * 64
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


class RolloutTests(unittest.TestCase):
    def exercise(self, failure=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); original = config()
        (root / 'auto-deploy').mkdir(); release.write_json(root / 'compose.json', original)
        calls = []

        def run(*args, **kwargs):
            calls.append(('run', args))
            if 'pg_dump' in args:
                if failure == 'backup':
                    raise RuntimeError('Backup failed')
                kwargs['stdout'].write(b'PGDMP fixture')

        def compose(file, *args):
            calls.append(('compose', args, json.loads(file.read_text())))
            if 'verify-migrations.js' in ' '.join(args) and failure == 'migration':
                raise RuntimeError('Missing reviewed migration')
            if file.name == 'compose.json' and 'up' in args and failure == 'health':
                if json.loads(file.read_text())['services'][release.APPS[0]]['image'] == IMAGE:
                    raise RuntimeError('New container health failed')

        def verify(_root, origin, demo=False):
            calls.append(('verify', origin))
            if failure == 'smoke' and origin == 'http://127.0.0.1:8082':
                raise RuntimeError('Live smoke failed')

        def output(*args):
            return SHA if 'rev-parse' in args else json.dumps([{'Id': IMAGE}])

        with patch.object(release, 'run', run), patch.object(release, 'output', output), \
             patch.object(release, 'compose', compose), patch.object(release, 'verify', verify), \
             patch.object(release, 'main_sha', return_value=SHA), \
             patch.object(release, 'ready', return_value=(failure != 'ci-changed')):
            try:
                result = release.deploy(root, SHA)
            except RuntimeError:
                result = None
        return root, original, calls, result

    def test_missing_migration_or_failed_backup_never_replaces_apps(self):
        for failure in ('migration', 'backup'):
            root, original, calls, result = self.exercise(failure)
            self.assertIsNone(result)
            self.assertEqual(json.loads((root / 'compose.json').read_text()), original)
            self.assertFalse(any(c[0] == 'compose' and 'up' in c[1] for c in calls))

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


if __name__ == '__main__':
    unittest.main()
