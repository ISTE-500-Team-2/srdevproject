from pathlib import Path
import json,hashlib,shutil,datetime,importlib.util
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'output';OLD=OUT/'native-review-candidate-v4';NEW=OUT/'native-review-candidate-v4a'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
proof=json.loads((OUT/'mask-only-repair-v4a.json').read_text());assert sha(ROOT/'fieldnote.kicad_pcb')==proof['candidate_board_sha256']
assert all(sha(OLD/row['path'])==row['sha256']for row in proof['prior_v4_preserved']['v4_snapshot_files']);assert sha(OUT/'fieldnote-pn7160-v0.4-native-review-HOLD.zip')==proof['prior_v4_preserved']['v4_zip_sha256']
oldmanifest=json.loads((OLD/'native-freeze-manifest.json').read_text());assert all(sha(OLD/row['path'])==row['sha256']for row in oldmanifest['files'])
seed=json.loads((ROOT/'source-v03/seed-identity.json').read_text());assert all(sha(Path(row['path']))==row['sha256']for row in seed['files'])
for name in ('native-drc-saved-v4a.json','native-drc-refill-v4a.json'):
 d=json.loads((OUT/name).read_text());assert not any(d[key]for key in ('violations','unconnected_items','schematic_parity'))
audit=json.loads((OUT/'final-native-pin-audit-v4a.json').read_text());assert not audit['errors'];assert audit['footprints_checked']==104
spec=importlib.util.spec_from_file_location('audit',ROOT/'manufacturing/audit_native_pins.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
libpath=Path('Fieldnote.pretty/TI_DBV0006A.kicad_mod');oldlib=a.sexpr((OLD/libpath).read_text());newlib=a.sexpr((ROOT/libpath).read_text());assert oldlib==[([x for x in item if not(isinstance(x,list)and x and x[0]=='solder_mask_margin')]if isinstance(item,list)and item and item[0]=='pad'else item)for item in newlib]
unchanged_native=['design-data.json','fieldnote.kicad_pro','Fieldnote.kicad_sym','fp-lib-table','sym-lib-table']+[p.name for p in ROOT.glob('*.kicad_sch')]
assert all((ROOT/name).read_bytes()==(OLD/name).read_bytes()for name in unchanged_native)
source=json.loads((OLD/'source-revision.json').read_text());source.update({'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'candidate_revision':'v4a explicit U8 50um NSMD mask repair','board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'parent_v4_board_sha256':proof['prior_board_sha256'],'parent_v4_manifest_sha256':sha(OLD/'native-freeze-manifest.json'),'mask_only_proof_sha256':sha(OUT/'mask-only-repair-v4a.json'),'U8_mask_library_sha256':sha(ROOT/libpath),'source_seed_files_reverified_unchanged':43,'revision_scope':'Only explicit0.05mm solder_mask_margin on six U8 native/library pads, plus helper generated clause. All copper/paste/courtyard/pose/net/MPN/count/filled-plane geometry unchanged.','native_checks':{'DRC_saved':{'violations':0,'unconnected':0,'schematic_parity':0,'fresh_for':'v4a'},'DRC_refill':{'violations':0,'unconnected':0,'schematic_parity':0,'fresh_for':'v4a'},'native_mask':{'pads':6,'native_library_match':True,'nominal_margin_mm':.05},'pin_audit':{'footprints':104,'physical_numbered_pads':369,'unique_pairs':357,'errors':0,'fresh_for':'v4a'},'ERC':{'violations':0,'inherited_from_identical_v4_schematic_project_bytes':True,'report_sha256':sha(OLD/'native-erc.json')}},'inherited_geometry_report_binding':{'prior_board_sha256':proof['prior_board_sha256'],'new_board_sha256':proof['candidate_board_sha256'],'proof_sha256':sha(OUT/'mask-only-repair-v4a.json'),'scope':'Prior routing/isolation/cleanup/EN reference and placement reports remain identified to v4. Only unchanged physical/copper/paste/net/plane scope rebinds by strict six-mask-node equality; no new startup, SI, RF or physical qualification claim.'}})
(ROOT/'source-revision.json').write_text(json.dumps(source,indent=2)+'\n')
contract=json.loads((OLD/'assembly-export-contract.json').read_text());contract.update({'board_sha256':source['board_sha256'],'parent_v4_board_sha256':proof['prior_board_sha256'],'mask_only_proof_sha256':sha(OUT/'mask-only-repair-v4a.json'),'U8_mask_margin_mm':.05,'U8_library_sha256':sha(ROOT/libpath),'BOM_CPL_unchanged_by_exact_native_pose_MPN_and_metadata_proof':True})
(OUT/'assembly-export-contract-v4a.json').write_text(json.dumps(contract,indent=2)+'\n')
assert not NEW.exists();NEW.mkdir()
for row in oldmanifest['files']:
 p=Path(row['path']);dest=NEW/p;dest.parent.mkdir(parents=True,exist_ok=True)
 if p==Path('fieldnote.kicad_pcb')or p==libpath or p==Path('source-revision.json'):src=ROOT/p
 elif p==Path('native-drc-saved.json'):src=OUT/'native-drc-saved-v4a.json'
 elif p==Path('native-drc-refill.json'):src=OUT/'native-drc-refill-v4a.json'
 elif p==Path('final-native-pin-audit.json'):src=OUT/'final-native-pin-audit-v4a.json'
 elif p==Path('assembly-export-contract.json'):src=OUT/'assembly-export-contract-v4a.json'
 else:src=OLD/p
 shutil.copy2(src,dest)
for p in (OUT/'mask-only-repair-v4a.json',OUT/'U8-native-mask-check-v4a.json',ROOT/'prepare_boot_gate.py'):shutil.copy2(p,NEW/p.name)
manifest={key:source[key]for key in ('status','created_utc','board_sha256','design_data_sha256','project_sha256','native_netlist_sha256')};manifest.update({'candidate_revision':source['candidate_revision'],'parent_v4_manifest_sha256':source['parent_v4_manifest_sha256'],'source_revision_sha256':sha(ROOT/'source-revision.json'),'mask_only_proof_sha256':sha(OUT/'mask-only-repair-v4a.json'),'files':[{'path':str(p.relative_to(NEW)),'size':p.stat().st_size,'sha256':sha(p)}for p in sorted(NEW.rglob('*'))if p.is_file()]})
(NEW/'native-freeze-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(OUT/'candidate-cost-binding-v4a.json').write_text(json.dumps({**contract,'source_revision_sha256':sha(ROOT/'source-revision.json'),'native_freeze_manifest_sha256':sha(NEW/'native-freeze-manifest.json'),'native_freeze_path':str(NEW.resolve()),'native_review_archive_created':False,'prior_v4_archive_sha256_preserved':proof['prior_v4_preserved']['v4_zip_sha256'],'component_costs_unchanged_by_mask_only_repair':True},indent=2)+'\n')
assert all(sha(OLD/row['path'])==row['sha256']for row in proof['prior_v4_preserved']['v4_snapshot_files']);assert sha(OUT/'fieldnote-pn7160-v0.4-native-review-HOLD.zip')==proof['prior_v4_preserved']['v4_zip_sha256']
result={'snapshot':str(NEW.resolve()),'board_sha256':source['board_sha256'],'design_data_sha256':source['design_data_sha256'],'project_sha256':source['project_sha256'],'source_revision_sha256':sha(ROOT/'source-revision.json'),'netlist_sha256':source['native_netlist_sha256'],'manifest_sha256':sha(NEW/'native-freeze-manifest.json'),'mask_only_proof_sha256':sha(OUT/'mask-only-repair-v4a.json'),'U8_library_sha256':sha(ROOT/libpath),'members':len(manifest['files']),'v4_snapshot_and_zip_unchanged':True}
(OUT/'owner-handoff-v4a.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
