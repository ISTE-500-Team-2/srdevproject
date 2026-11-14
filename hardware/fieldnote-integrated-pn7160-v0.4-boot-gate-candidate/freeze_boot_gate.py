from pathlib import Path
import json,hashlib,csv,shutil,datetime,importlib.util,collections
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'output';FROZEN=OUT/'native-review-candidate-v4'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(ROOT/'fieldnote.kicad_pcb')=='95543eecbfa9c0feb23ca7445aae5526d0a1fbaba78326112d9eebe811cc3d55'
seed=json.loads((ROOT/'source-v03/seed-identity.json').read_text());assert all(sha(Path(row['path']))==row['sha256']for row in seed['files'])
for name in ('native-drc-saved.json','native-drc-refill.json'):
 d=json.loads((OUT/name).read_text());assert not any(d[x]for x in ('violations','unconnected_items','schematic_parity'))
erc=json.loads((OUT/'native-erc.json').read_text());assert not any(s.get('violations',[])for s in erc.get('sheets',[]))
audit=json.loads((OUT/'final-native-pin-audit.json').read_text());assert not audit['errors'] and audit['footprints_checked']==104
spec=importlib.util.spec_from_file_location('audit',ROOT/'manufacturing/audit_native_pins.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
d=json.loads((ROOT/'design-data.json').read_text());parts={p['ref']:p for p in d['parts']};fitted={ref:p for ref,p in parts.items()if p.get('mpn')and p['mpn']!='PCB copper'and not p['dnp']};assert len(fitted)==82 and len({p['mpn']for p in fitted.values()})==43
board=a.sexpr((ROOT/'fieldnote.kicad_pcb').read_text());native={next(x[2]for x in a.children(fp,'property')if x[1]=='Reference'):fp for fp in a.children(board,'footprint')};assert 'exclude_from_pos_files'in a.child(native['JP1'],'attr')and 'exclude_from_bom'in a.child(native['JP1'],'attr')
rows=list(csv.DictReader((OUT/'positions-native-front-all.csv').open()));assert {row['Ref']for row in rows}==set(fitted)and len(rows)==82
for row in rows:
 at=a.child(native[row['Ref']],'at');assert abs(float(row['PosX'])-float(at[1]))<1e-6 and abs(float(row['PosY'])+float(at[2]))<1e-6 and abs((float(row['Rot'])-float(at[3]if len(at)>3 else 0))%360)<1e-6 and row['Side']=='top'
shutil.copy2(OUT/'positions-native-front-all.csv',OUT/'CPL-native-front82.csv')
with (OUT/'BOM-fitted82.csv').open('w',newline='')as f:
 w=csv.writer(f);w.writerow(['Reference','Value','Footprint','Manufacturer Part Number','Quantity','Notes'])
 for ref,p in sorted(fitted.items(),key=lambda t:(t[0].rstrip('0123456789'),int(''.join(c for c in t[0]if c.isdigit())))):w.writerow([ref,p['value'],'Fieldnote:'+p['fp'],p['mpn'],1,p.get('note','')])
groups=collections.defaultdict(list)
for ref,p in fitted.items():groups[(p['mpn'],p['fp'])].append(ref)
assert len(groups)==43
with(OUT/'BOM-grouped43.csv').open('w',newline='')as f:
 w=csv.writer(f);w.writerow(['References','Value','Footprint','Manufacturer Part Number','Quantity'])
 for (mpn,fp),refs in sorted(groups.items()):w.writerow([','.join(sorted(refs)),' / '.join(sorted({parts[ref]['value']for ref in refs})),'Fieldnote:'+fp,mpn,len(refs)])
delta={'status':'EXACT_FITTED_DELTA_NOT_ASSEMBLER_QUOTE','added':[{k:parts[ref][k]for k in ('ref','mpn','value','fp','xy','angle','nets')}for ref in ('U8','C38','R29','R30')],'modified':[{'ref':'R2','from_mpn':'RC0603FR-07100KL','to_mpn':parts['R2']['mpn'],'to_value':parts['R2']['value'],'net_unchanged':True},{'ref':'R12','mpn_unchanged':parts['R12']['mpn'],'high_side_from':'3V3','high_side_to':'POWER_PERMIT'}],'pcb_only_selector':parts['JP1'],'fitted_count':82,'unique_mpn_count':43,'CPL_convention':'KiCad native front CSV: absolute PCB editor coordinates in mm; +X right, +Y up=-editorY; native front rotations; J1 PTH included, native DNP and position exclusions applied. Manufacturer centroid/rotation acceptance remains HOLD.'}
(OUT/'assembly-delta.json').write_text(json.dumps(delta,indent=2)+'\n')
source={'status':'HOLD_NATIVE_RULE_CHECKS_PASS_PHYSICAL_POWER_SIGNAL_INTEGRITY_AND_MANUFACTURER_QUALIFICATION_PENDING','created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'variant':d['variant'],'board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'design_data_sha256':sha(ROOT/'design-data.json'),'project_sha256':sha(ROOT/'fieldnote.kicad_pro'),'native_netlist_sha256':sha(OUT/'fieldnote.net'),'v03_seed_board_sha256':seed['files'][0]['sha256'],'preserved_v03_seed_files':seed['files'],'source_files_verified_unchanged':True,'native_checks':{'DRC_saved':{'violations':0,'unconnected':0,'schematic_parity':0},'DRC_refill':{'violations':0,'unconnected':0,'schematic_parity':0},'ERC':{'violations':0},'pin_audit':{'footprints':104,'physical_numbered_pads':369,'unique_pairs':357,'errors':0}},'retained_source_copper_count':1174,'declared_source_copper_removals':11,'original_footprints_preserved':99,'new_fitted_parts':4,'new_PCB_only_selector':1,'new_tracks_vias':110,'engineering_disposition':'HOLD: reset long-route reference geometry screen and full startup transients remain unqualified; no claim of readiness for production.'}
(ROOT/'source-revision.json').write_text(json.dumps(source,indent=2)+'\n')
export={'board_sha256':source['board_sha256'],'design_data_sha256':source['design_data_sha256'],'project_sha256':source['project_sha256'],'bom_fitted_sha256':sha(OUT/'BOM-fitted82.csv'),'bom_grouped_sha256':sha(OUT/'BOM-grouped43.csv'),'cpl_sha256':sha(OUT/'CPL-native-front82.csv'),'fitted_refs':sorted(fitted),'fitted_count':82,'unique_mpn_count':43,'JP1_excluded_in_native_and_exports':True,'CPL_convention':delta['CPL_convention']}
(OUT/'assembly-export-contract.json').write_text(json.dumps(export,indent=2)+'\n')
assert not FROZEN.exists();FROZEN.mkdir()
inputs=[ROOT/'fieldnote.kicad_pcb',ROOT/'fieldnote.kicad_pro',ROOT/'design-data.json',ROOT/'Fieldnote.kicad_sym',ROOT/'fp-lib-table',ROOT/'sym-lib-table',ROOT/'source-revision.json']+sorted(ROOT.glob('*.kicad_sch'))+sorted((ROOT/'Fieldnote.pretty').glob('*.kicad_mod'))
for p in inputs:
 dest=FROZEN/p.relative_to(ROOT);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
for name in ('fieldnote.net','native-drc-saved.json','native-drc-refill.json','native-erc.json','final-native-pin-audit.json','BOM-fitted82.csv','BOM-grouped43.csv','CPL-native-front82.csv','assembly-export-contract.json','assembly-delta.json','routing-report.json','isolation-report.json','cleanup-report.json','EN-reference-screen.json','read-only-EN-placement-score.json','read-only-shorter-EN-route.json'):
 shutil.copy2(OUT/name,FROZEN/name)
manifest={k:source[k]for k in ('status','created_utc','board_sha256','design_data_sha256','project_sha256','native_netlist_sha256')};manifest['source_revision_sha256']=sha(ROOT/'source-revision.json');manifest['files']=[{'path':str(p.relative_to(FROZEN)),'size':p.stat().st_size,'sha256':sha(p)}for p in sorted(FROZEN.rglob('*'))if p.is_file()]
(FROZEN/'native-freeze-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(OUT/'candidate-cost-binding.json').write_text(json.dumps({**export,'source_revision_sha256':sha(ROOT/'source-revision.json'),'native_freeze_manifest_sha256':sha(FROZEN/'native-freeze-manifest.json'),'native_freeze_path':str(FROZEN.resolve())},indent=2)+'\n')
print(json.dumps({'frozen_path':str(FROZEN.resolve()),'board':source['board_sha256'],'design':source['design_data_sha256'],'project':source['project_sha256'],'source_revision':sha(ROOT/'source-revision.json'),'netlist':source['native_netlist_sha256'],'manifest':sha(FROZEN/'native-freeze-manifest.json'),'BOM':str((FROZEN/'BOM-fitted82.csv').resolve()),'CPL':str((FROZEN/'CPL-native-front82.csv').resolve())},indent=2))
