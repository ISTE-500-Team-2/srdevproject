#!/usr/bin/env python3
"""Shortcuts to the existing RLES website deployer; no new deployment logic."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/srv/arbor-full')


def read_status():
    state = json.loads((ROOT/'auto-deploy/status.json').read_text())
    route = json.loads((ROOT/'routing/active.json').read_text())
    return {**{key: state.get(key) for key in ('phase','candidateSha','deployedSha','stage','stageStartedAt','reason','ci')},
            'liveSha': route['release']}


def show_status(state):
    print('Website: https://collaboratory.webdev.gccis.rit.edu')
    print('Live commit:', state['liveSha'])
    print('Observed candidate:', state.get('candidateSha') or 'unknown')
    print('State:', state.get('phase') or 'unknown', '| Stage:', state.get('stage') or 'not reported')
    ci=state.get('ci') or {}
    if ci:
        print('Required CI checks:', str(ci.get('passed',0))+'/'+str(ci.get('required',0)))
        for item in ci.get('checks',[]):
            if item.get('status')!='completed' or item.get('conclusion')!='success':
                print('  Waiting/blocking:',item['name'],item.get('conclusion') or item['status'])
    if state.get('reason'):print('Note:',state['reason'])


def wait_for(target, timeout):
    print('Watching exact candidate:',target,flush=True)
    deadline=time.monotonic()+timeout;last=None
    while True:
        state=read_status()
        snapshot=json.dumps(state,sort_keys=True)
        if snapshot!=last:show_status(state);last=snapshot
        if (state['liveSha']==target and state.get('deployedSha')==target and
                state.get('candidateSha')==target and state.get('phase')=='deployed'):
            print('Verified deployed target:',target);return 0
        if state.get('candidateSha') not in (None,target):
            print('A different main candidate is now being evaluated; not claiming this target deployed.');return 2
        if state.get('phase') in ('paused','blocked'):
            print('Operator action is required; no release gate was bypassed.');return 2
        if (state.get('phase')=='waiting-for-ci' and
                any(c.get('conclusion') not in (None,'success') for c in (state.get('ci') or {}).get('checks',[]))):
            print('Required CI failed or did not succeed; no release gate was bypassed.');return 2
        if time.monotonic()>=deadline:
            print('Timed out waiting; the deployment service keeps its existing state.');return 2
        time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description='Inspect or update the existing ARBOR website. Never updates Ubuntu or migrates the database.')
    parser.add_argument('action', choices=('status', 'source', 'update', 'watch'), nargs='?', default='status')
    parser.add_argument('--wait',action='store_true',help='After update, follow the exact requested main commit until deployed or blocked')
    parser.add_argument('--timeout',type=int,default=600,help='Wait/watch timeout in seconds (10..3600; default 600)')
    parser.add_argument('--json',action='store_true',help='Status only: emit safe structured progress')
    args = parser.parse_args()
    if not 10<=args.timeout<=3600:parser.error('Timeout must be 10..3600 seconds')
    if args.wait and args.action!='update':parser.error('--wait applies to update only')
    if args.json and args.action!='status':parser.error('--json applies to status only')
    if args.action == 'update':
        deployer = ROOT / 'auto-deploy/auto_release.py'
        if not deployer.is_file():
            parser.error('Existing release script is missing; refusing to create or replace the stack.')
        remote=subprocess.run(['git','ls-remote','https://github.com/ISTE-500-Team-2/srdevproject.git','refs/heads/main'],check=True,capture_output=True,text=True,timeout=20).stdout.split()
        if len(remote)!=2 or remote[1]!='refs/heads/main' or len(remote[0])!=40 or any(c not in '0123456789abcdef' for c in remote[0]):
            parser.error('Cannot establish the exact main commit; no update requested')
        target=remote[0]
        print('Requesting exact current main:',target,flush=True)
        print('Using the existing CI-gated deployer. No OS updates, migrations, seeding or CI bypass.', flush=True)
        result=subprocess.run([sys.executable,str(deployer),'--root',str(ROOT),'--retry'])
        if result.returncode:return result.returncode
        if args.wait:return wait_for(target,args.timeout)
        show_status(read_status())
        print('Use ~/arbor-site update --wait to wait for verified completion.');return 0
    if args.action=='watch':
        target=read_status().get('candidateSha')
        if not target:parser.error('No candidate has been observed yet')
        return wait_for(target,args.timeout)
    if args.action=='status':
        state=read_status()
        if args.json:print(json.dumps(state))
        else:show_status(state)
        return 0
    route = json.loads((ROOT/'routing/active.json').read_text())
    sha = route['release']
    if not isinstance(sha, str) or len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
        parser.error('Unexpected live release identifier.')
    source = ROOT/'auto-deploy/releases'/sha/'source'
    if args.action == 'source':
        if not source.is_dir():
            parser.error('Recorded live source directory is missing.')
        print(source)
        print('Immutable deployed source: do not git pull or edit here. Make changes in your own checkout and merge a reviewed PR to main.')
        return


if __name__ == '__main__':
    try:
        sys.exit(main() or 0)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('Cannot inspect the existing deployment:', type(error).__name__, file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
