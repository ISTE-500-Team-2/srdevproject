#!/usr/bin/env python3
"""Prepare the PN532 gate circuit from its own frozen source; never rebuild copper."""
from pathlib import Path
import copy, hashlib, importlib.util, json, shutil

ROOT=Path(__file__).resolve().parent
GATE=ROOT.parent/'fieldnote-integrated-pn7160-v0.4-boot-gate-candidate/output/native-review-candidate-v4'
GATE_MANIFEST_SHA='6ca3ef5e8965fc5ae825eb91d888495a798e3f244567cd15b86ca2523bcb4eaa'
NEW=('U8','C38','R29','R30','JP1')

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
 assert sha(GATE/'native-freeze-manifest.json')==GATE_MANIFEST_SHA
 freeze=json.loads((GATE/'native-freeze-manifest.json').read_text())
 for item in freeze['files']:assert sha(GATE/item['path'])==item['sha256'],item['path']
 seed=ROOT/'source-v02';ident=json.loads((seed/'seed-identity.json').read_text())
 for name,digest in ident['files'].items():assert sha(seed/name)==digest,name
 # Source PN532 helper retains its own PN532 electrical pin definitions.
 code=(seed/'build_design.py').read_text()
 code=code.replace('0.2 - ENGINEERING DRAFT','0.3-boot-gate-candidate')
 old="inbom='no' if p['ref'].startswith('TP') or p['ref']=='ANT1' else 'yes'"
 assert code.count(old)==2
 code=code.replace(old,"inbom='no' if p['ref'].startswith('TP') or p['ref'] in ('ANT1','JP1') else 'yes'")
 old="            elif p['ref']=='U7':\n                typ='power_in' if k in ['3','5'] else ('output' if k=='4' else 'input')"
 assert code.count(old)==1
 code=code.replace(old,old+"\n            elif p.get('pin_types'):\n                typ=p['pin_types'].get(k,'passive')")
 # Remove stale draft wording only in the separate candidate schematic generator.
 code=code.replace('GLOBAL LABELS CONNECT ACROSS SHEETS. Review draft; routing and CAD ERC/DRC pending.',
   'GLOBAL LABELS CONNECT ACROSS SHEETS. USB boot-gate candidate; physical power and NFC qualification pending.')
 code=code.replace('REVIEW DRAFT: not routed or released for fabrication.',
   'BOOT-GATE CANDIDATE: native routing review; not released for fabrication.')
 (ROOT/'build_design.py').write_text(code)
 for p in seed.iterdir():
  if p.is_file() and (p.suffix in ('.kicad_sch','.kicad_sym','.kicad_pro') or p.name in ('sym-lib-table','fp-lib-table')):
   shutil.copyfile(p,ROOT/p.name)
 shutil.copytree(seed/'Fieldnote.pretty',ROOT/'Fieldnote.pretty',dirs_exist_ok=True)
 for name in ('TI_DBV0006A.kicad_mod','Permit_Selector_3_Bridged12.kicad_mod'):
  shutil.copyfile(GATE/'Fieldnote.pretty'/name,ROOT/'Fieldnote.pretty'/name)
 # Root-approved TI NSMD repair: positive 0.05 mm relief on all six U8 lands.
 lib=ROOT/'Fieldnote.pretty/TI_DBV0006A.kicad_mod';s=lib.read_text()
 assert s.count('(roundrect_rratio 0.0833333333)')==6
 lib.write_text(s.replace('(roundrect_rratio 0.0833333333)',
   '(roundrect_rratio 0.0833333333) (solder_mask_margin 0.05)'))
 spec=importlib.util.spec_from_file_location('candidate_build',ROOT/'build_design.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
 d=json.loads((seed/'design-data.json').read_text());p={a['ref']:a for a in d['parts']}
 gd=json.loads((GATE/'design-data.json').read_text());gp={a['ref']:a for a in gd['parts']}
 assert all(ref not in p for ref in NEW)
 for ref in ('R12','C9','SW1','J4'):
  p[ref]['nets']={key:('ESP_RESET_RC' if net=='ESP_EN' else net)for key,net in p[ref]['nets'].items()}
 p['R12']['nets']['2']='POWER_PERMIT'
 p['R12']['note']='47k reset RC pullup to POWER_PERMIT. Cold empty-C9 delay follows USB permission; retained C9 charge may shorten replug delay. BQ input-mode settling and full startup remain unqualified.'
 p['C9']['note']='Reset RC input capacitor. RESET switch and recovery header act on this input, never on the push-pull gate output.'
 p['SW1']['names']['1']=p['SW1']['names']['2']='RESET_RC';p['J4']['names']['5']='RESET_RC'
 p['J4']['note']='DNP recovery header. Pin 5 pulls ESP_RESET_RC only. Qualified USB required in NORMAL; service setting requires cutting the default copper bridge before soldering the other side.'
 p['R2'].update(value='10k 1%',mpn='RC0603FR-0710KL',note='USB_HIGH_CURRENT/BQ EN2 pulldown. Valid-logic leakage screen only; arbitrary power ramp and simultaneous Wi-Fi/NFC power remain unqualified.')
 for ref in NEW:d['parts'].append(copy.deepcopy(gp[ref]))
 d['variant']='PN532 v0.3 USB boot-gate candidate'
 d['engineering_status']='HOLD_NATIVE_REVIEW_POWER_RF_MECHANICAL_AND_PHYSICAL_QUALIFICATION_PENDING'
 d['usb_boot_gate_profile']=copy.deepcopy(gd['usb_boot_gate_profile'])
 d['usb_boot_gate_profile']['future_battery']='Charger, battery connector and NTC footprint retained. NORMAL requires USB permission. SERVICE permits experimental battery boot but does not qualify cell protection, charging, PN532 supply/radio behavior or transient power.'
 d['gate_circuit_reference']={'source_manifest_sha256':GATE_MANIFEST_SHA,'source_board_sha256':freeze['board_sha256'],
  'scope':'Circuit and exact two new footprint libraries only; PN532 original board/routing retained and freshly rerouted.'}
 g.PARTS=d['parts'];g.schematic();g.write_tables([])
 (ROOT/'design-data.json').write_text(json.dumps(d,indent=2)+'\n')
 for path in ROOT.glob('*.kicad_sch'):
  s=path.read_text().replace('(rev "0.2 - ENGINEERING DRAFT")','(rev "0.3-boot-gate-candidate")').replace('(date "2026-10-03")','(date "2026-10-04")')
  path.write_text(s)
 report={'status':'CIRCUIT_PREPARED_NATIVE_BOARD_NOT_YET_IMPORTED','source_seed_members':len(ident['files']),
  'source_members_unchanged':True,'gate_reference_manifest_sha256':GATE_MANIFEST_SHA,
  'new_library_hashes':{name:sha(ROOT/'Fieldnote.pretty'/name)for name in ('TI_DBV0006A.kicad_mod','Permit_Selector_3_Bridged12.kicad_mod')},
  'schematic_helper_delta':['Add explicit U8 pin types without changing old PN532 U2 types','Exclude PCB-only JP1 from schematic BOM','Candidate revision/status text'],
  'new_parts':list(NEW),'parts':len(d['parts']),'source_metadata_sha256':sha(seed/'design-data.json'),
  'candidate_metadata_sha256':sha(ROOT/'design-data.json')}
 (ROOT/'output/circuit-preparation.json').write_text(json.dumps(report,indent=2)+'\n')
 for name,digest in ident['files'].items():assert sha(seed/name)==digest,name
 print(json.dumps(report))

if __name__=='__main__':main()
