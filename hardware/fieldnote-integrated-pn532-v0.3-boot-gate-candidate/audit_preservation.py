#!/usr/bin/env python3
"""Exact PN532 original-to-candidate native geometry/circuit delta audit."""
from pathlib import Path
import copy,hashlib,json
import build_design as g
ROOT=Path(__file__).resolve().parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def named(t,kind):return {g.unq(g.child(n,'uuid')[1]):n for n in g.children(t,kind)}
def ref(fp):return g.unq(next(n for n in g.children(fp,'property')if g.unq(n[1])=='Reference')[2])
def main():
 seed=ROOT/'source-v02';ids=json.loads((seed/'seed-identity.json').read_text());sources=[]
 for name,digest in ids['files'].items():
  original=ROOT.parent/'fieldnote-integrated-v0.2'/name
  sources.append({'path':str(original.resolve()),'seed_path':str((seed/name).resolve()),'sha256':digest,
     'original_unchanged':sha(original)==digest,'seed_identical':sha(seed/name)==digest})
 assert len(sources)==43 and all(n['original_unchanged']and n['seed_identical']for n in sources)
 source=g.readsex((seed/'fieldnote.kicad_pcb').read_text());new=g.readsex((ROOT/'fieldnote.kicad_pcb').read_text())
 orig_copper={**named(source,'segment'),**named(source,'via')};new_copper={**named(new,'segment'),**named(new,'via')}
 isolation=json.loads((ROOT/'output/isolation-report.json').read_text());removed={a['uuid']for a in isolation['removed_copper']}
 assert len(removed)==11 and set(orig_copper)-set(new_copper)==removed
 changed=[];renamed=[]
 for ui,node in orig_copper.items():
  if ui in removed:continue
  expect=copy.deepcopy(node)
  if g.unq(g.child(expect,'net')[1])=='ESP_EN':g.child(expect,'net')[1]=g.q('ESP_RESET_RC');renamed.append(ui)
  if new_copper[ui]!=expect:changed.append(ui)
 assert not changed,('OLD_COPPER_CHANGED',changed)
 original_fp={ref(n):n for n in g.children(source,'footprint')};candidate_fp={ref(n):n for n in g.children(new,'footprint')}
 assert set(candidate_fp)-set(original_fp)=={'U8','C38','R29','R30','JP1'}
 parts={p['ref']:p for p in json.loads((ROOT/'design-data.json').read_text())['parts']}
 errors=[];pad_changes=[]
 for name,old in original_fp.items():
  current=candidate_fp[name]
  if old[1]!=current[1]or g.child(old,'at')!=g.child(current,'at')or g.child(old,'layer')!=g.child(current,'layer'):
   errors.append({'ref':name,'error':'FOOTPRINT_POSE_OR_LIBRARY_CHANGED'})
  for kind in ('fp_line','fp_arc','fp_poly','fp_rect','fp_circle','model','zone'):
   if g.children(old,kind)!=g.children(current,kind):errors.append({'ref':name,'error':'FOOTPRINT_GRAPHIC_CHANGED','kind':kind})
  pads={g.unq(g.child(p,'uuid')[1]):p for p in g.children(current,'pad')}
  for p in g.children(old,'pad'):
   ui=g.unq(g.child(p,'uuid')[1]);assert ui in pads
   expected=copy.deepcopy(p);pin=g.unq(p[1])
   if name in ('R12','C9','SW1','J4')and pin:
    desired=parts[name]['nets'][pin]
    net=g.child(expected,'net')
    if net and g.unq(net[1])!=desired:
     pad_changes.append({'ref':name,'pin':pin,'from_net':g.unq(net[1]),'to_net':desired});net[1]=g.q(desired)
    fun=g.child(expected,'pinfunction')
    if fun:fun[1]=g.q(parts[name]['names'].get(pin,pin))
   if pads[ui]!=expected:errors.append({'ref':name,'pin':pin,'error':'OLD_PAD_GEOMETRY_OR_UNAUTHORIZED_NET_CHANGED'})
  assert len(g.children(old,'pad'))==len(g.children(current,'pad'))
 assert not errors,errors
 outline=lambda tree:[n for n in tree if isinstance(n,list)and n and n[0].startswith('gr_')and g.child(n,'layer')and g.unq(g.child(n,'layer')[1])=='Edge.Cuts']
 assert outline(source)==outline(new)
 old_zones=named(source,'zone');new_zones=named(new,'zone');assert set(old_zones)==set(new_zones)
 zone=lambda z:[n for n in z if not(isinstance(n,list)and n and n[0]in('filled_polygon','fill_segments'))]
 assert all(zone(old_zones[ui])==zone(new_zones[ui])for ui in old_zones)
 original_parts={p['ref']:p for p in json.loads((seed/'design-data.json').read_text())['parts']}
 allowed={'R2':{'value','mpn','note'},'R12':{'nets','note'},'C9':{'nets','note'},'SW1':{'nets','names'},'J4':{'nets','names','note'}}
 metadata_changes=[]
 for name,part in original_parts.items():
  delta={key:{'from':part.get(key),'to':parts[name].get(key)}for key in set(part)|set(parts[name])if part.get(key)!=parts[name].get(key)}
  assert set(delta)<=allowed.get(name,set()),('OLD_METADATA_CHANGED',name,delta)
  if delta:metadata_changes.append({'ref':name,'changes':delta})
 libraries=[]
 for name,digest in ids['files'].items():
  if name.startswith('Fieldnote.pretty/'):
   assert sha(ROOT/name)==digest
   libraries.append({'path':name,'sha256':digest})
 u8=candidate_fp['U8'];lib=g.readsex((ROOT/'Fieldnote.pretty/TI_DBV0006A.kicad_mod').read_text())
 for pad in g.children(u8,'pad'):
  lp=next(p for p in g.children(lib,'pad')if p[1]==pad[1]);assert g.child(pad,'solder_mask_margin')==['solder_mask_margin','0.05']
  for key in('at','size','roundrect_rratio','solder_mask_margin'):
   a=g.child(pad,key);b=g.child(lp,key)
   assert len(a)==len(b)and all(abs(float(x)-float(y))<1e-10 for x,y in zip(a[1:],b[1:])),('U8_LIBRARY_GEOMETRY',key)
 assert set(g.child(candidate_fp['JP1'],'net_tie_pad_groups')[1:])=={g.q('1,2')}
 assert 'exclude_from_pos_files'in g.child(candidate_fp['JP1'],'attr')and 'exclude_from_bom'in g.child(candidate_fp['JP1'],'attr')
 assert len(g.children(candidate_fp['JP1'],'fp_poly'))==1
 extra=set(new_copper)-set(orig_copper);route=json.loads((ROOT/'output/routing-report.json').read_text());ground=json.loads((ROOT/'output/ground-island-repair.json').read_text())
 assert extra==set(route['added_copper'])|{s['uuid']for s in ground['new_ground_stitches']}
 report={'status':'PASS_EXACT_NATIVE_PN532_PRESERVATION_AND_DECLARED_GATE_DELTA','board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),
  'metadata_sha256':sha(ROOT/'design-data.json'),'project_sha256':sha(ROOT/'fieldnote.kicad_pro'),'source_board_sha256':sha(seed/'fieldnote.kicad_pcb'),
  'source_seed_members':sources,'source_seed_member_count':43,'old_footprints_pose_and_pad_geometry_preserved':len(original_fp),
  'original_copper_count':len(orig_copper),'removed_copper':isolation['removed_copper'],'retained_original_copper':len(orig_copper)-len(removed),
  'retained_reset_copper_renamed':renamed,'new_tracks_vias':len(extra),'new_copper_uuids':sorted(extra),
  'declared_pad_net_changes':pad_changes,'metadata_delta':metadata_changes,'source_footprint_libraries_unchanged':libraries,
  'original_outline_and_all_zone_definitions_preserved':True,'rule_areas':sum(g.child(z,'keepout')is not None for z in g.children(new,'zone')),
  'U8_mask_margin_six_native_library_pads_mm':.05,'JP1_default_1_2_bridge_and_export_exclusion':True,
  'limitations':['Native geometry/circuit preservation only; new power and RF/case/assembly binding reviews remain required.',
   'Full USB attach/startup and Wi-Fi/NFC activity transient path remains unverified.',
   '53.537 mm gate output and reset/permission input routes require signal-integrity/noise and physical qualification.',
   'Normal operation requires a USB-C source advertising at least 1.5 A; future battery hardware is retained but not qualified.',
   'Original PN532 R19 100k pulldown to GND is retained; complete pre-permission startup/current and arbitrary rail ramp behavior remain unqualified.']}
 assert sha(ROOT/'fieldnote.kicad_pro')==sha(seed/'fieldnote.kicad_pro')
 (ROOT/'output/preservation-audit.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items()if k not in('source_seed_members','removed_copper','new_copper_uuids','metadata_delta','source_footprint_libraries_unchanged','retained_reset_copper_renamed')},indent=2))
if __name__=='__main__':main()
