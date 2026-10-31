"""Operator status/wait tests; no live server, network or deployment invocation."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import arbor_site as cli

SHA='a'*40


class SiteCommandTests(unittest.TestCase):
    def test_status_excludes_unrelated_operator_fields_and_uses_actual_route(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'auto-deploy').mkdir();(root/'routing').mkdir()
            (root/'auto-deploy/status.json').write_text(json.dumps({'phase':'waiting-for-ci','candidateSha':SHA,'deployedSha':'wrong','password':'must not print'}))
            (root/'routing/active.json').write_text(json.dumps({'release':'b'*40}))
            with patch.object(cli,'ROOT',root):state=cli.read_status()
            self.assertEqual(state['liveSha'],'b'*40)
            self.assertNotIn('password',json.dumps(state))

    def test_wait_requires_route_and_success_not_merely_a_started_process(self):
        waiting={'liveSha':'b'*40,'deployedSha':'b'*40,'candidateSha':SHA,'phase':'deploying','stage':'verifying-live-website'}
        success={**waiting,'liveSha':SHA,'deployedSha':SHA,'phase':'deployed'}
        with patch.object(cli,'read_status',side_effect=[waiting,success]),patch.object(cli.time,'sleep') as sleep,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.wait_for(SHA,10),0);sleep.assert_called_once()
        for state in [waiting|{'phase':'blocked'},waiting|{'phase':'paused'},waiting|{'candidateSha':'c'*40},
                      waiting|{'phase':'waiting-for-ci','ci':{'checks':[{'name':'verify','status':'completed','conclusion':'failure'}]}},
                      waiting|{'phase':'deployed','liveSha':SHA,'candidateSha':'c'*40}]:
            with patch.object(cli,'read_status',return_value=state),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.wait_for(SHA,10),2)

    def test_wait_timeout_does_not_change_or_cancel_the_deployment(self):
        with patch.object(cli,'read_status',return_value={'liveSha':'b'*40,'candidateSha':SHA,'phase':'waiting-for-ci'}),patch.object(cli.time,'monotonic',side_effect=[0,11]),patch.object(cli.subprocess,'run') as run,contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.wait_for(SHA,10),2);run.assert_not_called()

    def test_update_wait_uses_only_existing_gated_deployer_and_exact_requested_sha(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'auto-deploy').mkdir();(root/'auto-deploy/auto_release.py').write_text('# inert')
            values=[subprocess.CompletedProcess([],0,stdout=SHA+'\trefs/heads/main\n'),subprocess.CompletedProcess([],0)]
            with patch.object(cli,'ROOT',root),patch.object(cli.sys,'argv',['arbor-site','update','--wait']),patch.object(cli.subprocess,'run',side_effect=values) as run,patch.object(cli,'wait_for',return_value=0) as wait,contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(),0)
                self.assertEqual(run.call_args_list[1].args[0],[cli.sys.executable,str(root/'auto-deploy/auto_release.py'),'--root',str(root),'--retry'])
                wait.assert_called_once_with(SHA,600)


if __name__=='__main__':unittest.main()
