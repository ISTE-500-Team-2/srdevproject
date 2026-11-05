"""Private status bridge boundary: real local HTTP, mocked gh, no tokens or SSH."""
from http.server import ThreadingHTTPServer
import json
from types import SimpleNamespace
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import local_github_api as bridge
import auto_release
import local_frontend_release
from test_auto_release import checks, workflows

SHA = 'a' * 40


class StatusBridgeTests(unittest.TestCase):
    def test_compaction_preserves_all_gate_results_and_unexpected_failures(self):
        check_path = 'commits/' + SHA + '/check-runs?per_page=100'
        run_path = 'actions/runs?head_sha=' + SHA + '&event=push&branch=main&per_page=100'
        for conclusion in ('success', 'failure', 'cancelled', 'skipped', None):
            original = checks(); original[0].update(conclusion=conclusion,
                status='completed' if conclusion else 'in_progress')
            original.append({'id': 99999, 'name': 'unexpected future gate', 'head_sha': SHA,
                             'app': {'slug': 'github-actions'}, 'status': 'completed', 'conclusion': 'failure'})
            runs = workflows()
            for c in original: c['unused_logo_and_metadata'] = 'x' * 10000
            for r in runs: r['unused_repository_metadata'] = 'x' * 10000
            compact = bridge.compact_status(check_path, {'total_count': len(original), 'check_runs': original})
            compact_runs = bridge.compact_status(run_path, {'workflow_runs': runs})
            self.assertEqual(len(compact['check_runs']), len(original))
            self.assertEqual(auto_release.green_checks(SHA, original, runs),
                             auto_release.green_checks(SHA, compact['check_runs'], compact_runs['workflow_runs']))
            self.assertEqual(local_frontend_release.candidate_failures(original, SHA),
                             local_frontend_release.candidate_failures(compact['check_runs'], SHA))
            self.assertTrue(local_frontend_release.candidate_failures(compact['check_runs'], SHA))
            self.assertLess(len(json.dumps(compact)), len(json.dumps(original)) / 20)
            self.assertNotIn('unused_logo_and_metadata', compact['check_runs'][0])
            for key in ('id', 'head_sha', 'head_branch', 'event', 'path', 'status', 'conclusion'):
                self.assertEqual(compact_runs['workflow_runs'][0][key], runs[0][key])
        for bad in ({}, {'check_runs': None}, {'check_runs': ['bad']}, {'check_runs': [{'app': None}]}):
            with self.assertRaises(ValueError): bridge.compact_status(check_path, bad)

    def test_only_owned_forward_is_cancelled_on_success_or_error(self):
        for fail in (False, True):
            with patch.object(bridge.subprocess, 'Popen') as spawn, \
                 patch.object(bridge.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as run:
                try:
                    with bridge.github_bridge('fixture-host'):
                        if fail: raise RuntimeError('fixture check failed')
                except RuntimeError:
                    self.assertTrue(fail)
                commands = [call.args[0] for call in run.call_args_list]
                start = next(c for c in commands if 'forward' in c)
                stop = next(c for c in commands if 'cancel' in c)
                self.assertEqual(start[start.index('-R') + 1], stop[stop.index('-R') + 1])
                self.assertTrue(start[start.index('-R') + 1].startswith('127.0.0.1:'))
                self.assertFalse(any('exit' in c for c in commands))
                spawn.assert_not_called()

    def test_only_fixed_readonly_project_status_endpoints_reach_gh(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.StatusHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        origin = 'http://127.0.0.1:' + str(server.server_port)
        with patch.object(bridge.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'{"check_runs":[]}')) as run:
            path = 'commits/' + SHA + '/check-runs?per_page=100'
            with urllib.request.urlopen(origin + '/' + path) as response:
                self.assertEqual(json.load(response), {'check_runs': []})
            command = run.call_args.args[0]
            self.assertEqual(command, ['gh', 'api', '--hostname', 'github.com', 'repos/' + bridge.REPO + '/' + path])
            run.reset_mock()
            for bad in ('user', 'repos/another/private/secrets', '../user', path + '&other=1',
                        'actions/runs?head_sha=' + SHA + '&event=pull_request&branch=main&per_page=100'):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(origin + '/' + bad)
                self.assertEqual(caught.exception.code, 404)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(urllib.request.Request(origin + '/' + path, data=b'{}', method='POST'))
            self.assertEqual(caught.exception.code, 501)
            run.assert_not_called()
            with urllib.request.urlopen(origin + '/health') as response:
                self.assertEqual(json.load(response)['repo'], bridge.REPO)
            run.assert_not_called()
            run.return_value = SimpleNamespace(returncode=1, stdout=b'')
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(origin + '/' + path)
            self.assertEqual(caught.exception.code, 503)
        with patch.object(bridge.urllib.request, 'urlopen') as open_url:
            for bad in ('https://other.invalid/', '../user', 'commits/not-a-sha/check-runs?per_page=100'):
                with self.assertRaises(ValueError):
                    bridge.read_local_status(bad)
            open_url.assert_not_called()


if __name__ == '__main__':
    unittest.main()
