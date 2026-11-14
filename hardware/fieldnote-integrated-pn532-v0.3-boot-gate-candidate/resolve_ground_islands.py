#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,uuid,math
import wx,pcbnew as k,route_local as r
ROOT=Path(__file__).resolve().parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')))
 before=sha(ROOT/'fieldnote.kicad_pcb');old=r.track_snapshot(b)
 fg=next(z for z in b.Zones()if not z.GetIsRuleArea()and z.IsOnLayer(k.F_Cu)and z.GetNetname()=='GND')
 ig=next(z for z in b.Zones()if not z.GetIsRuleArea()and z.IsOnLayer(k.In1_Cu)and z.GetNetname()=='GND')
 checks=[r.collision_test(b,'GND',.5,l,True)for l in r.ALL_COPPER];stitches=[]
 for cause,desired in [('LED-side front pour isolated by new gate routing',[31.5,3.0]),('ESP-side front pour isolated by new gate routing',[51.5,32.7])]:
  candidates=[]
  for ix in range(-20,21):
   for iy in range(-20,21):candidates.append((math.hypot(ix,iy),[round(desired[0]+ix*.1,6),round(desired[1]+iy*.1,6)]))
  candidates.sort()
  for _,p in candidates:
   if not fg.GetFilledPolysList(k.F_Cu).Collide(r.vec(p))or not ig.GetFilledPolysList(k.In1_Cu).Collide(r.vec(p)):continue
   if not all(c(p,p)for c in checks):continue
   if any(math.dist(p,s['position_board_mm'])<.47for s in stitches):continue
   v=k.PCB_VIA(b);v.SetUuid(k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-pn532-boot-gate-v03:ground-stitch:'+cause))));v.SetPosition(r.vec(p));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2));v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet('GND'));v.SetLocked(True);v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(v)
   stitches.append({'uuid':v.m_Uuid.AsString(),'position_board_mm':p,'diameter_mm':.5,'drill_mm':.2,'front_and_back_tented':True,'cause':cause,'prefill_F_and_In1_ground_coverage':True});break
  else:raise RuntimeError(('NO_STITCH_SITE',cause))
 changed=[]
 for t in b.GetDrawings():
  if isinstance(t,k.PCB_TEXT)and t.GetText()=='SVC':
   changed.append({'uuid':t.m_Uuid.AsString(),'before_position':r.xy(t.GetPosition()),'after_position':[26.25,10.0]});t.SetPosition(r.vec([26.25,10.0]))
 now=r.track_snapshot(b);assert all(now.get(ui)==row for ui,row in old.items())
 b.BuildConnectivity();filler=k.ZONE_FILLER(b);filler.Fill(b.Zones());k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v02/fieldnote.kicad_pro').read_bytes())
 report={'status':'NEW_GROUND_STITCHES_NATIVE_DRC_REQUIRED','source_board_sha256':before,'candidate_board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'new_ground_stitches':stitches,'selector_legend_changes':changed,'all_previous_copper_preserved':True,'scope':'Ground plane connectivity and silk separation only; no signal-integrity or physical power acceptance.'}
 (ROOT/'output/ground-island-repair.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
if __name__=='__main__':main()
