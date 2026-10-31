"""Exercise the actual required-check shell against failed/skipped lane results."""
import itertools
import os
from pathlib import Path
import re
import subprocess
import textwrap
import unittest


class WorkflowGateTests(unittest.TestCase):
    def test_aggregate_cannot_skip_or_hide_a_failed_lane(self):
        source=(Path(__file__).resolve().parents[1]/'.github/workflows/mvc-verify.yml').read_text()
        self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}",source)
        gate=source.split('\n  verify:\n',1)[1]
        self.assertIn('if: ${{ always() }}',gate)
        self.assertIn('needs: [backend, frontend, deployment]',gate)
        script=textwrap.dedent(gate.split('        run: |\n',1)[1])
        names=['BACKEND_RESULT','FRONTEND_RESULT','DEPLOYMENT_RESULT']
        for result in itertools.product(['success','failure','cancelled','skipped'],repeat=3):
            observed=subprocess.run(['bash','-e','-o','pipefail','-c',script],env={**os.environ,**dict(zip(names,result))},capture_output=True).returncode
            self.assertEqual(observed==0,all(r=='success' for r in result),result)
        # No original verification step was dropped while splitting runners.
        for required in ['npm run check --prefix backend','npm run check --prefix frontend',
                         'npm run test:integration --prefix backend','npm run test:integration --prefix frontend',
                         'Verify reader onboarding and fail-closed access','node --test deploy/rles-edge.test.mjs',
                         'python3 deploy/test_auto_release.py','python3 deploy/test_blue_green_release.py',
                         'node backend/test/container-auth.mjs']:
            self.assertIn(required,source)


if __name__=='__main__':unittest.main()
