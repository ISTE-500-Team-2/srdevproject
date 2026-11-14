#!/usr/bin/env python3
"""Snapshot and audit frozen PN7160 USB CAD without saving or changing CAD.

Wait for the hardware owner's native routing freeze before calling this.
Supply the adopted native board/project/schematic/library directory and its
expected board hash. Use --metadata-directory only if authoritative final
source/design metadata lives separately from the adopted native candidate.
Physical USB testing is never inferred from geometric/native DRC checks.
"""
from pathlib import Path
import argparse,hashlib,json,subprocess,sys
ROOT=Path(__file__).resolve().parent
BASELINE=ROOT.parent/'fieldnote-integrated-v0.2'/'output/usb-pair-candidate'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def digest(raw):return hashlib.sha256(raw).hexdigest()
def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--source-directory',type=Path,required=True)
    ap.add_argument('--metadata-directory',type=Path)
    ap.add_argument('--board-name',default='fieldnote.kicad_pcb')
    ap.add_argument('--expected-board-sha256',required=True)
    ap.add_argument('--expected-design-sha256')
    ap.add_argument('--expected-project-sha256')
    ap.add_argument('--expected-source-revision-sha256')
    ap.add_argument('--expected-native-freeze-manifest-sha256')
    ap.add_argument('--out',type=Path,default=ROOT/'output/usb-final-audit')
    args=ap.parse_args();source=args.source_directory.resolve();metadata=(args.metadata_directory or source).resolve();out=args.out.resolve();snap=out/'snapshot'
    assert ROOT in out.parents,'Output must be inside the separate PN7160 v0.3 tree'
    assert out!=source and snap!=source,'Use an independent audit output directory'
    board=source/args.board_name;assert board.suffix=='.kicad_pcb' and sha(board)==args.expected_board_sha256
    inputs={args.board_name:board}
    for pattern in ['*.kicad_pro','*.kicad_sch','*.kicad_sym','sym-lib-table','fp-lib-table']:
        for p in source.glob(pattern):inputs[p.name]=p
    for p in (source/'Fieldnote.pretty').rglob('*'):
        if p.is_file():inputs[str(p.relative_to(source))]=p
    for name in ['design-data.json','source-revision.json','placement-lock.json']:
        p=metadata/name;assert p.exists(),('Required metadata missing',p);inputs[name]=p
    native_manifest_path=source/'native-freeze-manifest.json'
    native_manifest=None
    if native_manifest_path.exists():
        native_manifest=json.loads(native_manifest_path.read_text())
        if args.expected_native_freeze_manifest_sha256:assert sha(native_manifest_path)==args.expected_native_freeze_manifest_sha256
        for row in native_manifest['files']:
            relative=Path(row['path']);p=(source/relative).resolve();assert source in p.parents,'Invalid freeze companion path'
            assert sha(p)==row['sha256'],('Adopted freeze companion changed',row['path'])
            if str(relative) in inputs:assert sha(inputs[str(relative)])==row['sha256'],('Metadata differs from adopted freeze',row['path'])
            else:inputs[str(relative)]=p
        inputs['native-freeze-manifest.json']=native_manifest_path
    required=['fieldnote.kicad_pro','fieldnote.kicad_sch','sym-lib-table','fp-lib-table']
    assert all(name in inputs for name in required),('Matching native companions missing',[n for n in required if n not in inputs])
    frozen={name:p.read_bytes() for name,p in inputs.items()};hashes={name:digest(raw) for name,raw in frozen.items()}
    for field,expected in [('design-data.json',args.expected_design_sha256),('fieldnote.kicad_pro',args.expected_project_sha256),('source-revision.json',args.expected_source_revision_sha256)]:
        if expected:assert hashes[field]==expected,('Frozen metadata hash differs',field,hashes[field],expected)
    assert all(sha(p)==hashes[name] for name,p in inputs.items()),'Source changed during freeze capture'
    snap.mkdir(parents=True,exist_ok=True)
    # Remove stale audit snapshot files only; live/native candidates and v0.2
    # inputs are never modified. All final companion content is exact bytes.
    for p in snap.rglob('*'):
        if p.is_file() and str(p.relative_to(snap)) not in frozen:p.unlink()
    for name,raw in frozen.items():
        p=snap/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
    seed_hash=sha(BASELINE/'usb-routes.json');seed_board_hash=sha(BASELINE/'fieldnote.kicad_pcb')
    manifest={'revision':'Frozen PN7160 v0.3 native USB CAD audit','adopted_source_directory':str(source),'metadata_directory':str(metadata),'board_sha256':hashes[args.board_name],'design_metadata_sha256':hashes['design-data.json'],'project_metadata_sha256':hashes['fieldnote.kicad_pro'],'source_revision_sha256':hashes['source-revision.json'],'files':hashes,'comparison_baseline':{'seed_report':str(BASELINE/'usb-routes.json'),'seed_report_sha256':seed_hash,'seed_board':str(BASELINE/'fieldnote.kicad_pcb'),'seed_board_sha256':seed_board_hash}}
    if native_manifest:
        manifest['adopted_native_freeze_manifest_sha256']=hashes['native-freeze-manifest.json']
        manifest['adopted_native_freeze_companion_count']=len(native_manifest['files'])
    (out/'snapshot-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    run=subprocess.run([sys.executable,str(ROOT/'verify_usb_pair.py'),'--board',str(snap/args.board_name),'--out',str(out),'--expected-sha256',hashes[args.board_name]],capture_output=True,text=True)
    if run.returncode:raise RuntimeError('USB verifier failed: '+run.stdout+'\n'+run.stderr)
    assert all(sha(p)==sha(snap/name)==hashes[name] for name,p in inputs.items()),'Frozen source/snapshot changed during audit'
    assert sha(BASELINE/'usb-routes.json')==seed_hash and sha(BASELINE/'fieldnote.kicad_pcb')==seed_board_hash,'Read-only v0.2 comparison input changed'
    audit=json.loads((out/'usb-validation.json').read_text());drc=json.loads((out/'drc.json').read_text())
    for field in ['design_metadata_sha256','project_metadata_sha256','source_revision_sha256']:audit[field]=manifest[field]
    audit['all_source_snapshot_files_match_manifest_after_read_only_audit']=True;audit['manufacturing_release']=(native_manifest or {}).get('manufacturing_release','HOLD');audit['physical_USB_verification']='PENDING: prototypes, enumeration, transfers and USB electrical tests have not been measured by this CAD audit'
    (out/'usb-validation.json').write_text(json.dumps(audit,indent=2)+'\n')
    index={'revision':manifest['revision'],'status':'CAD_AUDIT_PASS_PHYSICAL_USB_PENDING' if audit['checks_pass'] else 'CAD_AUDIT_REQUIRES_REPAIR_PHYSICAL_USB_PENDING','board_sha256':manifest['board_sha256'],'design_metadata_sha256':manifest['design_metadata_sha256'],'project_metadata_sha256':manifest['project_metadata_sha256'],'source_revision_sha256':manifest['source_revision_sha256'],'native_drc_violations':len(drc['violations']),'unconnected_items':len(drc['unconnected_items']),'schematic_parity_issues':len(drc['schematic_parity']),'original_USB_seed_items_preserved':audit['seed_geometry']['preserved_items'],'original_USB_native_pad_positions_unchanged':audit['seed_geometry']['expected_pad_positions_unchanged'],'original_USB_reference_keepouts_unchanged':audit['seed_geometry']['usb_reference_keepouts_unchanged'],'reference_center_samples':audit['reference_center_samples'],'reference_edge_samples':audit['reference_trace_edge_samples'],'unexplained_reference_gaps':len(audit['reference_gaps_outside_normal_via_antipads']),'normal_antipad_sample_sources_by_net':audit['normal_antipad_sample_sources_by_net'],'esd_output_to_series_resistor_mismatch_mm':audit['esd_to_series_resistor_length_difference_mm'],'signal_via_ground_returns':audit['signal_via_ground_returns'],'physical_USB_verification':audit['physical_USB_verification'],'manufacturing_release':audit['manufacturing_release'],'source_and_snapshot_inputs_unchanged_after_audit':True,'snapshot_input_file_count':len(hashes),'artifacts':{name:sha(out/name) for name in ['snapshot-manifest.json','usb-validation.json','copper-geometry.json','reference-antipad-samples.json','drc.json']},'snapshot_board':'snapshot/'+args.board_name,'limitations':audit['limitations']}
    if native_manifest:
        index['adopted_native_freeze_manifest_sha256']=manifest['adopted_native_freeze_manifest_sha256']
        index['adopted_native_freeze_companion_count']=manifest['adopted_native_freeze_companion_count']
    (out/'audit-index.json').write_text(json.dumps(index,indent=2)+'\n')
    print(json.dumps({k:v for k,v in index.items() if k not in ['artifacts','signal_via_ground_returns','limitations']},indent=2))
if __name__=='__main__':main()
