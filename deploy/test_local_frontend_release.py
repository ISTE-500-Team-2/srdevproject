"""Local alternative gate failures; no Docker, network, credentials or live data."""
import copy
import base64
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import local_frontend_release as local
from test_auto_release import checks as full_checks, workflows as full_workflows

SHA = 'a' * 40
BASE = 'b' * 40
TREE = 'c' * 40


class LocalGateTests(unittest.TestCase):
    def test_failed_checks_cleanup_never_stops_active_or_reused_slot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); release = root / 'auto-deploy/releases' / SHA
            release.mkdir(parents=True); (root / 'routing').mkdir()
            image = 'sha256:' + 'd' * 64
            local.ops.write_json(release / 'prewarm.json', {'revision': SHA, 'port': 18082, 'image': image})
            route = root / 'routing/active.json'
            local.ops.write_json(route, {'version': 1, 'release': SHA, 'publicPort': 18082})
            inspected = [{'Image': image, 'Config': {'Labels': {'org.opencontainers.image.revision': SHA}}}]
            with patch.object(local.ops, 'output', return_value=json.dumps(inspected)), patch.object(local.ops, 'run') as run:
                self.assertFalse(local.abort_prewarm(root, SHA))
                run.assert_not_called()
                local.ops.write_json(route, {'version': 1, 'release': BASE, 'publicPort': 28082})
                self.assertTrue(local.abort_prewarm(root, SHA))
                run.assert_called_once_with('docker', 'stop', 'arbor-email-app-green')
                run.reset_mock(); inspected[0]['Image'] = 'different'
                with patch.object(local.ops, 'output', return_value=json.dumps(inspected)):
                    self.assertFalse(local.abort_prewarm(root, SHA))
                run.assert_not_called()

    def test_preparation_cannot_route_unchecked_frontend_or_touch_private_demo(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); release = root / 'auto-deploy/releases' / SHA
            release.mkdir(parents=True); (root / 'routing').mkdir()
            (root / 'auto-deploy/local-frontend-prewarm.enabled').touch()
            route = root / 'routing/active.json'
            original_route = {'version': 1, 'release': BASE, 'publicPort': 28082}
            original_config = {'services': {'arbor-email-app': {'image': 'old'}, 'arbor-mvc-current': {'image': 'private'}}}
            local.ops.write_json(route, original_route); local.ops.write_json(root / 'compose.json', original_config)
            with patch.object(local, 'inherited_checks', return_value=True), \
                 patch.object(local.ops, 'backup_databases') as backup, \
                 patch.object(local, 'slot_compose') as compose:
                local.prewarm_frontend(root, SHA, BASE, release, release / 'source', 'new-immutable-image')
                backup.assert_called_once()
                compose.assert_called_once()
                self.assertEqual(json.loads(route.read_text()), original_route)
                self.assertEqual(json.loads((root / 'compose.json').read_text()), original_config)
                config = json.loads((release / 'prewarm-slot.json').read_text())
                self.assertEqual(set(config['services']), {'arbor-email-app'})
                compose.reset_mock()
                with patch.object(local, 'inherited_checks', return_value=False):
                    with self.assertRaises(RuntimeError):
                        local.prewarm_frontend(root, SHA, BASE, release, release / 'source', 'image')
                compose.assert_not_called()

    def test_only_queued_mac_may_use_real_local_mac_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); directory = root / 'auto-deploy/releases' / SHA
            directory.mkdir(parents=True)
            evidence = dict(version=1, revision=SHA, tree=TREE, node='24.22.1', platform='Darwin-arm64',
                            ownerAuthorizedLocalReplacement='queued macOS launcher check only',
                            launcherTestsPassed=6, launcherTestsFailed=0, missingKeyExit=1, checksums={})
            for name in ('local-macos-launcher.log', 'local-missing-key.log'):
                data = b'fixture local Mac output'; (directory / name).write_bytes(data)
                evidence['checksums'][name] = hashlib.sha256(data).hexdigest()
            (directory / 'local-macos-evidence.json').write_text(json.dumps(evidence))
            checks = full_checks(); runs = full_workflows()
            for c in checks:
                if c['name'] == 'launcher-unit (macos-latest)':
                    c.update(status='queued', conclusion=None)
            for r in runs:
                if r['path'].endswith('dev-setup.yml'):
                    r.update(status='in_progress', conclusion=None)
            def output(*args):
                return ('' if 'status' in args else TREE if 'HEAD^{tree}' in args else
                        local.MAC_WORKFLOW_BLOB if any(a.endswith(':.github/workflows/dev-setup.yml') for a in args) else SHA)
            with patch.object(local.ops, 'output', side_effect=output):
                self.assertTrue(local.baseline_green(root, SHA, checks, runs))
                # A workflow added to the controller's shared list is required here too.
                extra = local.ops.MAIN_PUSH_WORKFLOWS + ('.github/workflows/new-required.yml',)
                with patch.object(local.ops, 'MAIN_PUSH_WORKFLOWS', extra):
                    self.assertFalse(local.baseline_green(root, SHA, checks, runs))
                for name in local.ops.REQUIRED:
                    bad = [{**c, 'conclusion': 'failure', 'status': 'completed'} if c['name'] == name else c for c in checks]
                    self.assertFalse(local.baseline_green(root, SHA, bad, runs), name)
                self.assertFalse(local.baseline_green(root, SHA, [], runs))
                for path in [r['path'] for r in runs]:
                    bad = [{**r, 'conclusion': 'failure', 'status': 'completed'} if r['path'] == path else r for r in runs]
                    self.assertFalse(local.baseline_green(root, SHA, checks, bad))
                (directory / 'local-missing-key.log').write_text('changed')
                self.assertFalse(local.baseline_green(root, SHA, checks, runs))

    def test_release_refuses_an_older_controller_module_before_any_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            older = type('OlderAutoRelease', (), {})()
            with patch.object(local, 'ops', older), \
                 patch.object(local.sys, 'argv', ['local_frontend_release.py', '--root', str(root), '--sha', SHA]):
                with self.assertRaisesRegex(RuntimeError, 'matching auto_release.py'):
                    local.main()
            self.assertEqual(list(root.iterdir()), [])

    def test_scoped_checkout_never_builds_or_executes_a_changed_dockerfile(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); source = root / 'auto-deploy/releases' / SHA / 'source'
            source.mkdir(parents=True)
            def output(*args):
                return '' if 'status' in args else 'commit' if 'cat-file' in args else SHA
            before = {'Dockerfile': ('100644', 'blob', 'safe')}
            after = {'Dockerfile': ('100644', 'blob', 'changed')}
            with patch.object(local.ops, 'output', side_effect=output), \
                 patch.object(local, 'tree_files', side_effect=[before, after]), \
                 patch.object(local.ops, 'run') as run:
                with self.assertRaises(ValueError):
                    local.scoped_source(root, SHA, BASE)
                run.assert_not_called()

    def receipt(self, directory):
        receipt = dict(version=1, revision=SHA, tree=TREE, node='v24.22.1',
                       platform='Darwin-arm64', completedAt=1000, checks={})
        for name, cmd in local.COMMANDS.items():
            data = b'fixture: successful verification output\n'
            (directory / (name + '.log')).write_bytes(data)
            receipt['checks'][name] = dict(command=cmd, exitCode=0, sha256=hashlib.sha256(data).hexdigest())
        return receipt

    def test_scope_never_reuses_backend_or_build_policy_checks_after_changes(self):
        before = {'frontend/src/style.css': ('100644', 'blob', 'old')}
        after = {'frontend/src/style.css': ('100644', 'blob', 'new')}
        self.assertEqual(local.check_scope(before, after), ['frontend/src/style.css'])
        for name in ('backend/src/auth.ts', 'frontend/package-lock.json', 'frontend/vite.config.ts',
                     'database/migrations/101.sql', '.github/workflows/mvc-verify.yml',
                     'Dockerfile', '.nvmrc', 'deploy/auto_release.py', 'package.json', 'scripts/dev.mjs'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                local.check_scope(before, {**after, name: ('100644', 'blob', 'new')})
        for mode in ('120000', '100755', '160000'):
            with self.assertRaises(ValueError):
                local.check_scope(before, {'frontend/src/style.css': (mode, 'blob', 'new')})
        with self.assertRaises(ValueError):
            local.check_scope(before, before)
        # Renaming a server file into the frontend also deletes a forbidden path.
        with self.assertRaises(ValueError):
            local.check_scope({**before, 'backend/a.ts': ('100644', 'blob', 'x')}, after)

    def test_receipt_identity_expiry_commands_results_and_tamper_are_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            good = self.receipt(directory)
            local.validate_receipt(good, directory, SHA, TREE, now=1001)
            for field, value in [('version', 2), ('revision', BASE), ('tree', BASE), ('node', 'v26.0.0'),
                                 ('platform', 'Linux'), ('completedAt', 1002), ('completedAt', 0)]:
                bad = {**good, field: value}
                with self.subTest(field=field), self.assertRaises(ValueError):
                    local.validate_receipt(bad, directory, SHA, TREE, now=1001)
            for name in local.COMMANDS:
                for key, value in [('exitCode', 1), ('exitCode', False), ('command', ['true']), ('sha256', '0' * 64)]:
                    bad = copy.deepcopy(good); bad['checks'][name][key] = value
                    with self.subTest(name=name, key=key), self.assertRaises(ValueError):
                        local.validate_receipt(bad, directory, SHA, TREE, now=1001)
            bad = copy.deepcopy(good); bad['checks'].pop('frontend-integration')
            with self.assertRaises(ValueError):
                local.validate_receipt(bad, directory, SHA, TREE, now=1001)
            (directory / 'frontend-check.log').write_text('tampered')
            with self.assertRaises(ValueError):
                local.validate_receipt(good, directory, SHA, TREE, now=1001)

    def test_latest_failed_skipped_cancelled_and_timed_out_ci_cannot_be_overridden(self):
        check = dict(name='verify', id=1, head_sha=SHA, app={'slug': 'github-actions'}, conclusion='success')
        self.assertFalse(local.candidate_failures([check], SHA))
        self.assertFalse(local.candidate_failures([{**check, 'conclusion': None}], SHA))
        for outcome in ('failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required'):
            self.assertTrue(local.candidate_failures([check, {**check, 'id': 2, 'conclusion': outcome}], SHA))
        self.assertTrue(local.candidate_failures([{**check, 'conclusion': 'failure'},
                        {**check, 'head_sha': BASE, 'id': 2}], SHA))

    def test_ssh_bundle_accepts_only_valid_fixed_logs_and_publishes_receipt_last(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); release = root / 'auto-deploy/releases' / SHA
            release.mkdir(parents=True); stage = root / 'fixture'; stage.mkdir()
            receipt = self.receipt(stage); receipt['completedAt'] = local.time.time()
            bundle = {'receipt': receipt, 'logs': {n: base64.b64encode((stage / (n + '.log')).read_bytes()).decode()
                                                for n in local.COMMANDS}}
            with patch.object(local.ops, 'output', return_value=TREE):
                local.accept_evidence(root, SHA, io.BytesIO(json.dumps(bundle).encode()))
                directory = release / 'local-frontend'
                local.validate_receipt(json.loads((directory / 'receipt.json').read_text()), directory, SHA, TREE)
                saved = (directory / 'receipt.json').read_bytes()
                for bad in ({**bundle, 'unexpected': True},
                            {**bundle, 'logs': {**bundle['logs'], '../escape': 'Zg=='}},
                            {**bundle, 'logs': {**bundle['logs'], 'frontend-build': 'not base64'}}):
                    with self.assertRaises((ValueError, TypeError)):
                        local.accept_evidence(root, SHA, io.BytesIO(json.dumps(bad).encode()))
                    self.assertEqual((directory / 'receipt.json').read_bytes(), saved)

    def test_ready_requires_green_baseline_pristine_source_and_valid_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); directory = root / 'evidence'; directory.mkdir()
            receipt = self.receipt(directory); receipt['completedAt'] = local.time.time()
            (directory / 'receipt.json').write_text(json.dumps(receipt))
            gate = local.LocalFrontendOps(root, SHA, BASE, directory)
            before = {'frontend/src/a.ts': ('100644', 'blob', 'before')}
            after = {'frontend/src/a.ts': ('100644', 'blob', 'after')}
            def output(*args):
                return '' if 'status' in args else TREE if 'HEAD^{tree}' in args else SHA
            with patch.object(local.ops, 'output', side_effect=output), \
                 patch.object(local, 'tree_files', side_effect=lambda _s, sha: before if sha == BASE else after), \
                 patch.object(local.ops, 'green_checks', return_value=True) as baseline, \
                 patch.object(local.ops, 'api', return_value={'check_runs': [], 'workflow_runs': []}):
                self.assertTrue(gate.ready(SHA))
                self.assertFalse(gate.ready(BASE))
                baseline.return_value = False
                self.assertFalse(gate.ready(SHA))
                self.assertTrue(gate.validate_evidence(SHA), 'Local proof alone is not public promotion permission')
                baseline.return_value = True
                with patch.object(local.ops, 'output', return_value='dirty'):
                    self.assertFalse(gate.ready(SHA))


if __name__ == '__main__':
    unittest.main()
