"""Fault-injection tests: rollout ordering, backup gate, rollback and scope guard.
Never connects to Docker, SSH or a real database.
"""
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest
SCRIPT=Path(__file__).with_name('deploy-arbor.sh').resolve()
OLD='ghcr.io/example/arbor@sha256:'+'a'*64
NEW='ghcr.io/example/arbor@sha256:'+'b'*64
FAKE='''#!/usr/bin/env python3
import os,sys,json
args=sys.argv[1:]
with open(os.environ['CALLS'],'a') as f:f.write(json.dumps({'args':args,'image':os.environ.get('ARBOR_RELEASE_IMAGE')})+'\\n')
if any('pg_dump' in arg for arg in args):
 if os.environ.get('FAIL')=='backup':sys.exit(1)
 sys.stdout.write('PGDMP isolated fixture')
if 'pg_restore' in args and not sys.stdin.read().startswith('PGDMP'):sys.exit(1)
if 'backend/dist/scripts/verify-migrations.js' in args and os.environ.get('FAIL')=='migration':sys.exit(1)
if 'up' in args and os.environ.get('FAIL')=='health' and os.environ['ARBOR_RELEASE_IMAGE']==os.environ['NEW']:sys.exit(1)
'''
class DeployTests(unittest.TestCase):
 def run_release(self, fail='', previous=True):
  with tempfile.TemporaryDirectory(prefix='arbor-release-test-') as temporary:
   root=Path(temporary);(root/'bin').mkdir();(root/'releases').mkdir();(root/'compose.release.yml').write_text('services: {}');(root/'env').write_text('PGDATABASE=fixture');
   (root/'bin/docker').write_text(FAKE);(root/'bin/docker').chmod(0o700);(root/'bin/flock').write_text('#!/bin/sh\nexit 0\n');(root/'bin/flock').chmod(0o700)
   if previous:(root/'releases/current-image').write_text(OLD)
   env={**os.environ,'PATH':str(root/'bin')+':'+os.environ['PATH'],'CALLS':str(root/'calls'),'FAIL':fail,'NEW':NEW}
   result=subprocess.run(['bash',str(SCRIPT),'staging',NEW,str(root),str(root/'env'),'existing-db','8082'],env=env,capture_output=True,text=True)
   calls=[json.loads(line) for line in (root/'calls').read_text().splitlines()] if (root/'calls').exists() else []
   saved=(root/'releases/current-image').read_text().strip() if (root/'releases/current-image').exists() else None
   backups=len(list((root/'backups').glob('*.dump')))
   return result,calls,saved,backups
 def test_first_release_requires_operator_registration(self):
  result,calls,saved,backups=self.run_release(previous=False);self.assertNotEqual(result.returncode,0);self.assertFalse(calls)
 def test_backup_failure_never_rolls_app(self):
  result,calls,saved,_=self.run_release('backup');self.assertNotEqual(result.returncode,0);self.assertEqual(saved,OLD);self.assertFalse(any('up' in c['args'] for c in calls))
 def test_missing_migration_blocks_rollout_without_app_changes(self):
  result,calls,saved,_=self.run_release('migration');self.assertNotEqual(result.returncode,0);self.assertEqual(saved,OLD);self.assertFalse(any('up' in c['args'] for c in calls))
 def test_health_failure_restores_prior_image_without_touching_database(self):
  result,calls,saved,backups=self.run_release('health');self.assertNotEqual(result.returncode,0);self.assertEqual(saved,OLD);ups=[c for c in calls if 'up' in c['args']];self.assertEqual([c['image'] for c in ups],[NEW,OLD]);self.assertEqual(backups,1);self.assertFalse(any('down' in c['args'] or '--volumes' in c['args'] for c in calls))
 def test_success_retains_backup_and_records_digest(self):
   result,calls,saved,backups=self.run_release();self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(saved,NEW);self.assertEqual(backups,1);dump=next(i for i,c in enumerate(calls) if any('pg_dump' in a for a in c['args']));up=next(i for i,c in enumerate(calls) if 'up' in c['args']);self.assertLess(dump,up)
 def test_backup_uses_database_url_without_putting_it_in_arguments(self):
  self.check_connection({'DATABASE_URL':'postgresql://fixture:fake-password@db:5432/arbor','PGDATABASE':'wrong'},'postgresql://fixture:fake-password@db:5432/arbor')
 def test_backup_preserves_individual_libpq_configuration(self):
  self.check_connection({'PGDATABASE':'arbor','PGHOST':'db','PGUSER':'fixture'},'arbor')
 def check_connection(self, settings, expected):
  command=re.search(r"^backup_command='(.*)'$",SCRIPT.read_text(),re.M).group(1)
  with tempfile.TemporaryDirectory(prefix='arbor-backup-connection-') as temporary:
   root=Path(temporary);dump=root/'pg_dump'
   dump.write_text('#!/usr/bin/env python3\nimport json,os,sys\nprint(json.dumps({"database":os.environ.get("PGDATABASE"),"host":os.environ.get("PGHOST"),"args":sys.argv[1:]}))\n');dump.chmod(0o700)
   env={k:v for k,v in os.environ.items() if not k.startswith('PG') and k!='DATABASE_URL'}
   env.update(settings);env['PATH']=str(root)+':'+env['PATH']
   result=subprocess.run(['sh','-eu','-c',command],env=env,capture_output=True,text=True,check=True)
   observed=json.loads(result.stdout);self.assertEqual(observed['database'],expected);self.assertEqual(observed['args'],['--format=custom','--no-owner'])
   if 'PGHOST' in settings:self.assertEqual(observed['host'],settings['PGHOST'])
if __name__=='__main__':unittest.main()
