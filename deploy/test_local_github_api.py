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

SHA = 'a' * 40


class StatusBridgeTests(unittest.TestCase):
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
