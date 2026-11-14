#!/usr/bin/env python3
"""Freeze a source-preserving native PN532 candidate; no manufacturing release."""
from pathlib import Path
import collections,csv,datetime,hashlib,importlib.util,json,shutil
import build_design as g
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'output';FROZEN=OUT/'native-review-candidate-v3a'
BOARD_SHA='ec26844bde40460eef573b657122b681c1986c7adb280baaf4e145a23afbbfb4'
META_SHA='d9f40576f5ab2021e07cd6281d4b80f1a14171db0fb9c127ca3c51b47fef1aa8'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def ref(fp):return g.unq(next(p for p in g.children(fp,'property')if g.unq(p[1])=='Reference')[2])
def main():
 assert sha(ROOT/'fieldnote.kicad_pcb')==BOARD_SHA and sha(ROOT/'design-data.json')==META_SHA
 preservation=json.loads((OUT/'preservation-audit.json').read_text());assert preservation['board_sha256']==BOARD_SHA and preservation['metadata_sha256']==META_SHA
 assert preservation['source_seed_member_count']==43 and preservation['retained_original_copper']==1082
 for row in preservation['source_seed_members']:assert sha(Path(row['path']))==row['sha256']==sha(Path(row['seed_path']))
 for name in ('native-drc-saved.json','native-drc-refill.json'):
  report=json.loads((OUT/name).read_text());assert not any(report[key]for key in ('violations','unconnected_items','schematic_parity'))
 erc=json.loads((OUT/'native-erc.json').read_text());assert not any(sheet.get('violations',[])for sheet in erc.get('sheets',[]))
 audit=json.loads((OUT/'final-native-pin-audit.json').read_text());assert not audit['errors']and audit['footprints_checked']==103 and audit['numbered_physical_pads_checked']==367 and audit['unique_ref_pin_pairs']==355
 assert audit['inputs']['board']['sha256']==BOARD_SHA and audit['inputs']['metadata']['sha256']==META_SHA and audit['inputs']['netlist']['sha256']==sha(OUT/'fieldnote.net')
 d=json.loads((ROOT/'design-data.json').read_text());parts={p['ref']:p for p in d['parts']};fitted={name:p for name,p in parts.items()if p.get('mpn')and p['mpn']!='PCB copper'and not p['dnp']}
 assert len(fitted)==84 and len({p['mpn']for p in fitted.values()})==42
 board=g.readsex((ROOT/'fieldnote.kicad_pcb').read_text());native={ref(fp):fp for fp in g.children(board,'footprint')}
 rows=list(csv.DictReader((OUT/'positions-native-front-all.csv').open()));assert len(rows)==84 and {row['Ref']for row in rows}==set(fitted)
 for row in rows:
  at=g.child(native[row['Ref']],'at');angle=float(at[3]if len(at)>3 else 0)
  assert abs(float(row['PosX'])-float(at[1]))<1e-6 and abs(float(row['PosY'])+float(at[2]))<1e-6 and min((float(row['Rot'])-angle)%360,(angle-float(row['Rot']))%360)<1e-6 and row['Side']=='top'
 shutil.copyfile(OUT/'positions-native-front-all.csv',OUT/'CPL-native-front84.csv')
 with(OUT/'BOM-fitted84.csv').open('w',newline='')as f:
  w=csv.writer(f);w.writerow(['Reference','Value','Footprint','Manufacturer Part Number','Quantity','Notes'])
  for name,p in sorted(fitted.items()):w.writerow([name,p['value'],'Fieldnote:'+p['fp'],p['mpn'],1,p.get('note','')])
 groups=collections.defaultdict(list)
 for name,p in fitted.items():groups[(p['mpn'],p['fp'])].append(name)
 assert len(groups)==42
 with(OUT/'BOM-grouped42.csv').open('w',newline='')as f:
  w=csv.writer(f);w.writerow(['References','Value','Footprint','Manufacturer Part Number','Quantity'])
  for(mpn,fp),names in sorted(groups.items()):w.writerow([','.join(sorted(names)),' / '.join(sorted({parts[name]['value']for name in names})),'Fieldnote:'+fp,mpn,len(names)])
 convention='KiCad native front CSV: absolute PCB editor coordinates in mm; +X right, +Y up equals negative editor Y; native front rotations; J1 PTH included. Native DNP/position exclusions applied. Assembler centroid and rotation acceptance remain pending.'
 delta={'status':'EXACT_CANDIDATE_FITTED_DELTA_NOT_ASSEMBLER_QUOTE','added':[{key:parts[name][key]for key in ('ref','value','mpn','fp','xy','angle','nets')}for name in ('U8','C38','R29','R30')],
  'modified':[{'ref':'R2','from_mpn':'RC0603FR-07100KL','to_mpn':parts['R2']['mpn'],'to_value':parts['R2']['value'],'net_unchanged':True},{'ref':'R12','high_side_from':'3V3','high_side_to':'POWER_PERMIT','mpn_unchanged':True}],
  'pcb_only_selector':parts['JP1'],'JP1_excluded_from_native_BOM_and_CPL':True,'fitted_count':84,'exact_mpn_count':42,'CPL_convention':convention}
 (OUT/'assembly-delta.json').write_text(json.dumps(delta,indent=2)+'\n')
 status='HOLD_NATIVE_RULE_CHECKS_PASS_COMPLETE_POWER_RF_CASE_ASSEMBLY_AND_PHYSICAL_QUALIFICATION_PENDING'
 source={'status':status,'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'variant':d['variant'],'board_sha256':BOARD_SHA,'design_data_sha256':META_SHA,'project_sha256':sha(ROOT/'fieldnote.kicad_pro'),
  'native_netlist_sha256':sha(OUT/'fieldnote.net'),'source_v02_board_sha256':preservation['source_board_sha256'],'preserved_source_members':preservation['source_seed_members'],
  'native_checks':{'DRC_saved':{'violations':0,'unconnected':0,'schematic_parity':0},'DRC_refill':{'violations':0,'unconnected':0,'schematic_parity':0},'ERC':{'violations':0},'pin_audit':{'footprints':103,'numbered_physical_pads':367,'unique_pairs':355,'errors':0}},
  'fitted_parts':84,'unique_MPNs':42,'native_tracks':len(g.children(board,'segment')),'native_vias':len(g.children(board,'via')),
  'original_footprints_preserved':98,'declared_old_copper_removals':11,'retained_original_copper':1082,'new_tracks_vias':136,
  'output_route_length_mm':53.537077191072505,'output_route_vias':2,'U8_six_land_mask_margin_mm':.05,'U8_library_sha256':sha(ROOT/'Fieldnote.pretty/TI_DBV0006A.kicad_mod'),
  'gate_reference':d['gate_circuit_reference'],'limitations':preservation['limitations'],'manufacturing_released':False}
 (ROOT/'source-revision.json').write_text(json.dumps(source,indent=2)+'\n')
 export={'board_sha256':BOARD_SHA,'design_data_sha256':META_SHA,'project_sha256':source['project_sha256'],'bom_fitted_sha256':sha(OUT/'BOM-fitted84.csv'),'bom_grouped_sha256':sha(OUT/'BOM-grouped42.csv'),'cpl_sha256':sha(OUT/'CPL-native-front84.csv'),
  'fitted_refs':sorted(fitted),'fitted_count':84,'unique_mpn_count':42,'JP1_excluded_in_native_and_exports':True,'CPL_convention':convention}
 (OUT/'assembly-export-contract.json').write_text(json.dumps(export,indent=2)+'\n')
 assert not FROZEN.exists();FROZEN.mkdir()
 files=[ROOT/'fieldnote.kicad_pcb',ROOT/'fieldnote.kicad_pro',ROOT/'design-data.json',ROOT/'Fieldnote.kicad_sym',ROOT/'fp-lib-table',ROOT/'sym-lib-table',ROOT/'source-revision.json',ROOT/'README.md',*sorted(ROOT.glob('*.kicad_sch')),*sorted((ROOT/'Fieldnote.pretty').glob('*.kicad_mod'))]
 for p in files:
  dest=FROZEN/p.relative_to(ROOT);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest)
 reports=('fieldnote.net','native-drc-saved.json','native-drc-refill.json','native-erc.json','final-native-pin-audit.json','BOM-fitted84.csv','BOM-grouped42.csv','CPL-native-front84.csv',
  'assembly-export-contract.json','assembly-delta.json','preservation-audit.json','routing-report.json','isolation-report.json','placement-search.json','circuit-preparation.json','mask-and-annotation-repair.json','ground-island-repair.json','old-pad-annotation-restoration.json','EN-reference-screen.json','document-revision-repair.json')
 for name in reports:shutil.copyfile(OUT/name,FROZEN/name)
 manifest={key:source[key]for key in ('status','created_utc','board_sha256','design_data_sha256','project_sha256','native_netlist_sha256')};manifest['source_revision_sha256']=sha(ROOT/'source-revision.json')
 manifest['files']=[{'path':str(p.relative_to(FROZEN)),'size':p.stat().st_size,'sha256':sha(p)}for p in sorted(FROZEN.rglob('*'))if p.is_file()]
 (FROZEN/'native-freeze-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 (OUT/'candidate-cost-binding.json').write_text(json.dumps({**export,'source_revision_sha256':sha(ROOT/'source-revision.json'),'native_freeze_manifest_sha256':sha(FROZEN/'native-freeze-manifest.json'),'native_freeze_path':str(FROZEN.resolve())},indent=2)+'\n')
 for row in manifest['files']:assert sha(FROZEN/row['path'])==row['sha256']
 print(json.dumps({'frozen_path':str(FROZEN.resolve()),'board_sha256':BOARD_SHA,'design_sha256':META_SHA,'source_revision_sha256':sha(ROOT/'source-revision.json'),'manifest_sha256':sha(FROZEN/'native-freeze-manifest.json'),'counts':{key:source[key]for key in('fitted_parts','unique_MPNs','native_tracks','native_vias')},'review_member_count':len(manifest['files'])},indent=2))
if __name__=='__main__':main()
