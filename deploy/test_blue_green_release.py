"""Fault-injected public promotion/rollback, without Docker, network or real data."""
import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import auto_release as release
import blue_green_release as blue

OLD = 'a' * 40
NEW = 'b' * 40
IMAGE = 'sha256:' + 'c' * 64


def config():
    return {'services': {
        'arbor-email-app': {'image': 'old-image', 'container_name': 'arbor-email-app',
            'environment': {'ACCESS_READERS_JSON': 'private fixture', 'EMAIL_ENABLED': 'true'},
            'env_file': '/protected/public.env', 'volumes': ['/protected/key:/key:ro'],
            'ports': ['127.0.0.1:8082:8080'], 'networks': ['existing'], 'depends_on': ['db']},
        'arbor-mvc-current': {'image': 'old-image', 'ports': ['127.0.0.1:8081:8080'],
            'environment': {'DATABASE_URL': 'separate-demo-fixture'}},
        'db': {'image': 'db', 'volumes': ['persistent:/db']},
        'gateway': {'image': 'pinned-node', 'network_mode': 'host'},
    }, 'networks': {'existing': {'name': 'existing-network'}}}


class PromotionTests(unittest.TestCase):
    def test_startup_probe_is_faster_without_weakening_health_or_operator_policy(self):
        service = {'healthcheck': {'test': ['CMD', 'node', 'health.js'], 'interval': '5s',
                                  'timeout': '3s', 'retries': 20}}
        result = blue.startup_healthcheck(service)
        self.assertEqual(result['healthcheck'], {**service['healthcheck'],
                         'start_period': '10s', 'start_interval': '500ms'})
        self.assertNotIn('start_period', service['healthcheck'])
        custom = {'healthcheck': {**service['healthcheck'], 'start_period': '0s', 'start_interval': '2s'}}
        self.assertEqual(blue.startup_healthcheck(custom), custom)
        for health in ({'disable': True}, {'test': ['NONE']}, {}):
            self.assertEqual(blue.startup_healthcheck({'healthcheck': health}), {'healthcheck': health})

    def fixture(self, failure=None):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / 'routing').mkdir(); (root / 'auto-deploy').mkdir()
        old_route = {'version': 1, 'release': OLD, 'publicPort': 8082}
        release.write_json(root / 'routing/active.json', old_route)
        original = config(); release.write_json(root / 'compose.json', original)
        directory = root / 'auto-deploy/releases' / NEW; directory.mkdir(parents=True)
        calls = []
        def backup(*_):
            calls.append('backup')
            if failure == 'backup': raise RuntimeError('Unreadable backup')
        def verify(_root, origin, demo=False):
            calls.append(('verify', origin, copy.deepcopy(blue.read_route(root / 'routing/active.json'))))
            if failure == 'standby' and origin.endswith(':18082'): raise RuntimeError('Standby unhealthy')
        def compose(file, *args):
            calls.append(('demo', json.loads(file.read_text())['services']['arbor-mvc-current']['image']))
            if failure == 'demo' and calls[-1][1] == IMAGE: raise RuntimeError('Demo startup failed')
        ops = SimpleNamespace(prepare_artifact=lambda *_: (directory, directory / 'source', IMAGE),
            backup_databases=backup, write_json=release.write_json, verify=verify, compose=compose,
            run=lambda *args, **kwargs: calls.append(('run', args)),
            main_sha=lambda: NEW, ready=lambda _: failure != 'ci')
        return root, original, old_route, ops, calls

    def test_standby_has_exact_public_config_not_demo_or_disabled_email(self):
        original = config()
        candidate = blue.slot_config(original, IMAGE, 18082)
        s = candidate['services']['arbor-email-app']
        for key in ('environment', 'env_file', 'volumes', 'networks'):
            self.assertEqual(s[key], original['services']['arbor-email-app'][key])
        self.assertEqual(s['ports'], ['127.0.0.1:18082:8080'])
        self.assertEqual(candidate['networks']['existing'], {'external': True, 'name': 'existing-network'})
        self.assertEqual(original, config())

    def test_success_prepares_before_atomic_public_switch_and_keeps_old_warm(self):
        root, original, old_route, ops, calls = self.fixture()
        def live_check(_ops, _root, sha):
            self.assertEqual(blue.read_route(root / 'routing/active.json')['release'], NEW)
            self.assertIn('backup', calls)
            self.assertIn(('demo', IMAGE), calls)
        with patch.object(blue, 'verify_route', side_effect=live_check):
            result = blue.deploy_blue_green(root, NEW, ops)
        self.assertEqual(result['publicPort'], 18082)
        self.assertEqual(result['previousPublicPort'], 8082)
        self.assertTrue(result['retirementScheduled'])
        after = json.loads((root / 'compose.json').read_text())
        for name in original['services']:
            expected = dict(original['services'][name])
            if name in release.APPS: expected['image'] = IMAGE
            self.assertEqual(after['services'][name], expected)
        self.assertFalse(any(c[0] == 'run' and 'stop' in c[1] for c in calls if isinstance(c, tuple)))
        self.assertEqual(json.loads((root / 'auto-deploy/activation.json').read_text())['phase'], 'committed')
        self.assertGreaterEqual(result['cutoverSeconds'], 0)
        before_recovery_calls = len(calls)
        recovered = blue.recover_activation(root, ops)
        self.assertEqual(recovered['deployedSha'], NEW)
        self.assertEqual(recovered['publicPort'], 18082)
        self.assertEqual(len(calls), before_recovery_calls, 'durable success is reconciled without redeploying')

    def test_backup_standby_demo_and_ci_failures_keep_public_and_data_unchanged(self):
        for failure in ('backup', 'standby', 'demo', 'ci'):
            with self.subTest(failure=failure):
                root, original, old_route, ops, calls = self.fixture(failure)
                with self.assertRaises(RuntimeError): blue.deploy_blue_green(root, NEW, ops)
                self.assertEqual(blue.read_route(root / 'routing/active.json'), old_route)
                self.assertEqual(json.loads((root / 'compose.json').read_text()), original)

    def test_failed_live_verification_restores_route_before_demo_rollback(self):
        root, original, old_route, ops, calls = self.fixture()
        def demo_rollback(file, *_args):
            if json.loads(file.read_text()) == original:
                self.assertEqual(blue.read_route(root / 'routing/active.json'), old_route)
        ops.compose = demo_rollback
        with patch.object(blue, 'verify_route', side_effect=RuntimeError('Public smoke failed')):
            with self.assertRaises(RuntimeError): blue.deploy_blue_green(root, NEW, ops)
        self.assertEqual(blue.read_route(root / 'routing/active.json'), old_route)
        self.assertEqual(json.loads((root / 'compose.json').read_text()), original)

    def test_frontend_only_release_keeps_private_demo_image_and_process_untouched(self):
        root, original, old_route, ops, calls = self.fixture()
        with patch.object(blue, 'verify_route'):
            result = blue.deploy_blue_green(root, NEW, ops, update_demo=False)
        self.assertTrue(result['demoPreserved'])
        self.assertFalse(any(c[0] == 'demo' for c in calls if isinstance(c, tuple)))
        self.assertTrue(any(c[0] == 'verify' and c[1].endswith(':8081') for c in calls if isinstance(c, tuple)))
        after = json.loads((root / 'compose.json').read_text())
        self.assertEqual(after['services']['arbor-mvc-current'], original['services']['arbor-mvc-current'])
        self.assertEqual(after['services']['arbor-email-app']['image'], IMAGE)
        self.assertFalse(json.loads((root / 'auto-deploy/activation.json').read_text())['updateDemo'])

    def test_frontend_only_failure_restores_public_without_replacing_private_demo(self):
        for failure in ('demo', 'ci', 'live'):
            root, original, old_route, ops, calls = self.fixture('ci' if failure == 'ci' else None)
            original_verify = ops.verify
            def verify(_root, origin, demo=False):
                if demo and failure == 'demo': raise RuntimeError('Preserved demo unhealthy')
                return original_verify(_root, origin, demo)
            ops.verify = verify
            with patch.object(blue, 'verify_route', side_effect=RuntimeError('Public smoke failed') if failure == 'live' else None):
                with self.assertRaises(RuntimeError):
                    blue.deploy_blue_green(root, NEW, ops, update_demo=False)
            self.assertEqual(blue.read_route(root / 'routing/active.json'), old_route)
            self.assertEqual(json.loads((root / 'compose.json').read_text()), original)
            self.assertFalse(any(c[0] == 'demo' for c in calls if isinstance(c, tuple)))

    def test_interrupted_pending_switch_is_recovered_before_next_release(self):
        root, original, old_route, ops, calls = self.fixture()
        candidate = copy.deepcopy(original)
        for name in release.APPS: candidate['services'][name]['image'] = IMAGE
        new_route = {'version': 1, 'release': NEW, 'publicPort': 18082, 'previousPublicPort': 8082}
        release.write_json(root / 'compose.json', candidate)
        release.write_json(root / 'routing/active.json', new_route)
        release.write_json(root / 'auto-deploy/activation.json', {'phase': 'pending',
            'oldRoute': old_route, 'newRoute': new_route, 'previousCompose': original,
            'candidateCompose': candidate, 'releaseDirectory': str(root / 'auto-deploy/releases' / NEW)})
        result = blue.recover_activation(root, ops)
        self.assertEqual(result['deployedSha'], OLD)
        self.assertEqual(result['failedSha'], NEW)
        self.assertEqual(blue.read_route(root / 'routing/active.json'), old_route)
        self.assertIsNone(blue.recover_activation(root, ops))

    def test_invalid_route_never_targets_demo(self):
        root, *_ = self.fixture()
        for port in (8081, 18081, 28081, True, '18082'):
            release.write_json(root / 'routing/active.json', {'version': 1, 'release': OLD, 'publicPort': port})
            with self.assertRaises(ValueError): blue.read_route(root / 'routing/active.json')

    def test_retirement_cannot_stop_active_or_reused_slot(self):
        root, original, old_route, ops, calls = self.fixture()
        release.write_json(root / 'auto-deploy/activation.json', {'phase': 'committed',
            'oldRoute': {'version': 1, 'release': OLD, 'publicPort': 18082}, 'newRoute': old_route})
        ops.output = lambda *_: json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': NEW}}}])
        self.assertFalse(blue.retire_previous(root, 8082, OLD, ops))
        self.assertFalse(blue.retire_previous(root, 18082, OLD, ops))
        self.assertFalse(calls)
        ops.output = lambda *_: json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': OLD}}}])
        self.assertTrue(blue.retire_previous(root, 18082, OLD, ops))
        self.assertEqual(calls[-1], ('run', ('docker', 'stop', 'arbor-email-app-green')))

    def test_pending_activation_never_retires_its_rollback_target(self):
        root, original, old_route, ops, calls = self.fixture()
        new_route = {'version': 1, 'release': NEW, 'publicPort': 18082, 'previousPublicPort': 8082}
        release.write_json(root / 'routing/active.json', new_route)
        release.write_json(root / 'auto-deploy/activation.json', {'phase': 'pending',
            'oldRoute': old_route, 'newRoute': new_route})
        ops.output = lambda *_: json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': OLD}}}])
        self.assertFalse(blue.retire_previous(root, 8082, OLD, ops))
        self.assertFalse(calls, 'a crash before commit must keep the old public process alive')

    def test_committed_recovery_does_not_erase_a_later_failed_release(self):
        root, original, old_route, ops, calls = self.fixture()
        with patch.object(blue, 'verify_route'):
            blue.deploy_blue_green(root, NEW, ops)
        failed = 'd' * 40
        (root / 'auto-deploy/blue-green.enabled').write_text('fixture')
        release.write_json(root / 'auto-deploy/status.json', {
            'deployedSha': NEW, 'failedSha': failed, 'phase': 'blocked'})
        with patch.object(release, 'main_sha', return_value=failed), \
             patch.object(release, 'ready', return_value=True), \
             patch.object(release, 'deploy') as deploy:
            release.tick(root)
            deploy.assert_not_called()
        status = json.loads((root / 'auto-deploy/status.json').read_text())
        self.assertEqual(status['failedSha'], failed)
        self.assertEqual(status['phase'], 'blocked')


if __name__ == '__main__':
    unittest.main()
