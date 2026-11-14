#!/usr/bin/env python3
"""Plan or freeze a new explicit PN7160 review index; no CAD/build/export work.

Default is read-only planning. Writing requires frozen hashes and no pending
required evidence groups, rejects changed bytes, and never overwrites an index.
"""
import argparse,collections,datetime,hashlib,itertools,json
from pathlib import Path
sha=lambda data:hashlib.sha256(data).hexdigest()
CLASSES={'CAD','conditional_model','sensitivity','physical_unverified','source'}

def pointer(obj,p):
    for k in p.lstrip('/').split('/') if p else []:obj=obj[int(k)] if isinstance(obj,list) else obj[k.replace('~1','/').replace('~0','~')]
    return obj

def gather(root,plan_path):
    plan_bytes=plan_path.read_bytes();plan=json.loads(plan_bytes);frozen={};records={};checks=[];errors=[];excluded=[];external=[];retained_reads={}
    def verify_retained(path,expected,size):
        data=path.read_bytes()
        if sha(data)!=expected or len(data)!=size:raise ValueError('Retained external/excluded input changed: '+str(path))
        retained_reads[str(path)]=(expected,size)
        return data
    def add(name,expected=None,size=None,cls='source',label='',scope='Exact source identity; no physical qualification'):
        p=Path(name)
        if p.is_absolute() or '..' in p.parts or p.as_posix()!=name or p.suffix.lower() in {'.npz','.zip','.tar','.gz','.bz2','.xz'}:raise ValueError('Unsafe/excluded evidence member: '+name)
        q=root/p
        if q.is_symlink() or not q.resolve().is_relative_to(root):raise ValueError('Escaping evidence member: '+name)
        data=q.read_bytes()
        if cls not in CLASSES:raise ValueError('Unknown evidence class: '+cls)
        if expected and sha(data)!=expected:raise ValueError('Stale evidence hash: '+name)
        if size is not None and len(data)!=size:raise ValueError('Evidence byte length differs: '+name)
        if name in frozen and frozen[name]!=data:raise ValueError('Evidence changed during capture: '+name)
        frozen[name]=data
        records[name]={'sha256':sha(data),'bytes':len(data),'validation_class':cls,'label':label,'scope':scope}
        return data
    for key in ['authoritative_board','authoritative_metadata']:
        row=plan[key];add(row['path'],row['sha256'],label=key)
    for group in plan['manifest_groups']:
        try:
            name=group['manifest_path'];manifest=json.loads(add(name,group['expected_manifest_sha256'],label=group['label']))
            members=pointer(manifest,group['member_pointer'])
            if len(members)!=group['expected_member_count']:raise ValueError('Manifest count differs: '+name)
            rows=[dict(path=n,sha256=v if isinstance(v,str) else v['sha256']) for n,v in members.items()] if isinstance(members,dict) else members
            names=[]
            for row in rows:
                member=group.get('member_path_overrides',{}).get(row['path'],(Path(group['base_directory'])/row['path']).as_posix())
                names.append(member)
                if row['path'] in group.get('excluded_member_paths',[]):
                    verify_retained(root/member,row['sha256'],row.get('bytes',row.get('size')))
                    excluded.append({'path':str(root/member),'sha256':row['sha256'],'bytes':row.get('bytes',row.get('size')),'archive_member':False,'scope':'Original binary waveform retained externally; exact arrays preserved in indexed round-trip CSV evidence'})
                else:add(member,row['sha256'],row.get('bytes',row.get('size')),label=group['label']+': '+member,scope=group['scope'])
            if len(set(names))!=len(names):raise ValueError('Duplicate manifest member: '+name)
            checks.append({'path':name,'verified_members':len(names),'status':'HASH_LENGTH_MATCH'})
        except (ValueError,OSError,KeyError,TypeError) as exc:errors.append(str(exc))
    for group in plan.get('absolute_input_manifests',[]):
        try:
            report=json.loads(frozen[group['path']]);rows=pointer(report,group['pointer'])
            if len(rows)!=group['expected_count']:raise ValueError('Absolute source inventory count differs: '+group['path'])
            for row in rows:
                original=Path(row['path']);verify_retained(original,row['sha256'],row['bytes'])
                if original.suffix.lower()=='.npz':
                    excluded.append(dict(row,archive_member=False,scope='Original binary waveform retained externally; full-resolution CSV conversion of identical diagnostic waveform is indexed'))
                elif str(original) in group.get('mirrors',{}):
                    add(group['mirrors'][str(original)],row['sha256'],row['bytes'],label='Exact mirrored external manufacturer source')
                elif original.is_relative_to(root):
                    name=original.relative_to(root).as_posix();add(name,row['sha256'],row['bytes'],label='Exact absolute power-evidence source: '+name)
                elif original.suffix.lower() in {'.dylib','.cm'}:
                    external.append(dict(row,archive_member=False,scope='Verified original ngspice runtime dependency retained externally; not bundled',reproduction_note='Provide compatible ngspice shared runtime/code models at the recorded paths or deliberately adjust paths and regenerate evidence. Review archive is not standalone simulation reproduction.'))
                else:raise ValueError('Unmapped external review source: '+str(original))
            checks.append({'path':group['path'],'absolute_inputs_verified':len(rows),'status':'HASH_LENGTH_MATCH'})
        except (ValueError,OSError,KeyError,TypeError) as exc:errors.append(str(exc))
    for row in plan['additional_evidence']:
        try:add(row['path'],row.get('expected_sha256'),cls=row['validation_class'],label=row.get('label',row['path']),scope=row.get('scope','Declared report scope; matching identity is not physical validation'))
        except (ValueError,OSError,KeyError,TypeError) as exc:errors.append(str(exc))
    for binding in plan.get('report_bindings',[]):
        try:
            data=json.loads(frozen[binding['report']] if binding['report'] in frozen else add(binding['report']))
            expected=sha(frozen[binding['source']] if binding['source'] in frozen else add(binding['source']))
            if pointer(data,binding['pointer'])!=expected:raise ValueError('Stale report source binding: '+binding['report']+' '+binding['pointer'])
        except (ValueError,OSError,KeyError,TypeError) as exc:errors.append(str(exc))
    try:
        design=json.loads(frozen[plan['authoritative_metadata']['path']]);fitted={p['ref']:p for p in design['parts'] if not p.get('dnp') and not p['ref'].startswith(('TP','ANT'))}
        dims=json.loads(frozen['manufacturing/v03-placement-clearance-dimensions.json']);rows={p['ref']:p for p in dims['parts']}
        if len(fitted)!=78 or len(rows)!=78 or len(dims['parts'])!=78 or set(rows)!=set(fitted) or len({p['mpn'] for p in fitted.values()})!=42:raise ValueError('Exact78 fitted/42MPN dimension coverage differs')
        for ref,row in rows.items():
            p=fitted[ref]
            if (row['mpn'],row['footprint'],row['native_center_board_mm'],row['native_angle_deg'])!=(p['mpn'],p['fp'],p['xy'],p['angle']):raise ValueError('Dimension part/pose identity differs: '+ref)
        body=json.loads(frozen['manufacturing/v03-placement-clearance-review.json']);pairs=[tuple(sorted(p['refs'])) for p in body['all_pairs']]
        if len(pairs)!=3003 or set(pairs)!=set(itertools.combinations(sorted(fitted),2)) or body['manufacturer_max_overlap_pairs'] or body['assumed_placement_overlap_pairs']:raise ValueError('Component pair coverage/overlap differs')
        case=json.loads(frozen['mechanical/freeze-refresh.json'])
        if case['fitted_component_count']!=78 or not case['all_manufacturer_maxima_contained']:raise ValueError('Mechanical complete78-body coverage differs')
        for s in ['native_screen','assumed_screen']:
            for k,n in [('stack_sweep_cases',243),('continuous_XY_pose_envelope_cases',27),('continuous_pad_bulge_envelope_cases',27),('rigid_collision_cases',0),('continuous_XY_pose_collision_cases',0),('pad_bulge_component_collision_cases',0),('continuous_pad_bulge_component_collision_cases',0)]:
                if case[s][k]!=n:raise ValueError('Mechanical declared screen differs: '+s+' '+k)
        checks.append({'check':'exact_fitted_parts_and_unique_pairs_and_case_screens','fitted_refs':78,'MPNs':42,'pairs':3003,'assembler_capability_measured':False,'status':'MATCH'})
    except (ValueError,KeyError,TypeError) as exc:errors.append(str(exc))
    for name,data in frozen.items():
        if (root/name).read_bytes()!=data:errors.append('Evidence changed after capture: '+name)
    for name,(expected,size) in list(retained_reads.items()):
        try:verify_retained(Path(name),expected,size)
        except (ValueError,OSError) as exc:errors.append(str(exc))
    if plan_path.read_bytes()!=plan_bytes:errors.append('Selection plan changed during capture')
    for p in [plan_path,Path(__file__).resolve()]:add(p.relative_to(root).as_posix(),label='Explicit selection/builder source')
    summary={'native_CAD':'Source-bound zero finding checks remain distinct from ignored rules and model claims','models':'Conditional/sensitivity only within selected profiles and assumptions; no inherited PN532 pass','physical_bench_validated':False,'production_authorized':False,'self_contained_rerunnable':False,'external_dependencies':'Original NPZ and ngspice runtime binaries are externally retained; full-resolution CSV conversions preserve every original float64 array. See power/RF evidence for model hashes, absolute paths and nativeKiCad/ngspice/NumPy/FastHenry dependencies.','pending_required_groups':plan['pending_required_groups']}
    summary.update(plan.get('validation_summary',{}))
    result={'schema_version':1,'status':'PN7160 ENGINEERING REVIEW / PRODUCTION HOLD','created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'summary':summary,'manifest_checks':checks,'excluded_binary_waveform_sources':excluded,'external_runtime_dependencies':external,'files':dict(sorted(records.items()))}
    return result,errors,plan

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--plan',type=Path,default=Path(__file__).with_name('pn7160-engineering-package-plan.json'));p.add_argument('--out',type=Path);p.add_argument('--frozen-board-sha256');p.add_argument('--frozen-design-sha256');a=p.parse_args();root=a.root.resolve();result,errors,plan=gather(root,a.plan.resolve())
    if not a.out:print(json.dumps({'mode':'PLAN_ONLY_NO_INDEX_WRITTEN','selected_files':len(result['files']),'errors':errors,'pending_required_groups':plan['pending_required_groups'],'manifest_checks':result['manifest_checks']},indent=2))
    else:
        if a.frozen_board_sha256!=plan['authoritative_board']['sha256'] or a.frozen_design_sha256!=plan['authoritative_metadata']['sha256']:raise SystemExit('Full frozen board/metadata hashes required')
        if errors or plan['pending_required_groups']:raise SystemExit(json.dumps({'status':'REFUSED_STALE_OR_PENDING_EVIDENCE','errors':errors,'pending':plan['pending_required_groups']}))
        out=(root/a.out).resolve()
        if not out.is_relative_to(root/'output') or out.exists():raise SystemExit('New immutable output/index path required')
        with out.open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
        print(json.dumps({'path':str(out),'sha256':sha(out.read_bytes()),'files':len(result['files']),'status':result['status']},indent=2))
