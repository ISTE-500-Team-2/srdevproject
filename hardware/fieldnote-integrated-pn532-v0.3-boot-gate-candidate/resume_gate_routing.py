#!/usr/bin/env python3
"""Resume only unrouted new gate connections; old copper remains immutable."""
from pathlib import Path
import hashlib,json,math,uuid,shutil
import wx,pcbnew as k,route_local as r
ROOT=Path(__file__).resolve().parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def ident(key):return k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-pn532-boot-gate-v03:'+key)))
def main():
 app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')))
 old=r.track_snapshot(b);before=sha(ROOT/'fieldnote.kicad_pcb');report=json.loads((ROOT/'output/routing-report.json').read_text())
 hist=ROOT/'output/history';hist.mkdir(exist_ok=True)
 shutil.copyfile(ROOT/'output/routing-report.json',hist/'initial-routing-report.json')
 added=[];more=[];failed=[]
 # Allow more finite search states only for the witnessed long output route.
 plan=list(report['plan']);already=len(report['routes'])
 if len(plan)<13:
  plan.append({'net':'GND','start':'U8.1','end':'U8.2','width':.2,'purpose':'AND truth-selection ground'})
 for row in report['ground_vias']:
  entry={'net':'GND','start':row['pad'],'end':{'xy':row['xy'],'layers':r.ALL_COPPER},'width':.2,'purpose':'Local ground return'}
  if entry not in plan:plan.append(entry)
 for ri,row in enumerate(plan[already:],already):
  net=row['net'];a,sl=r.endpoint(b,row['start'],net);c,el=r.endpoint(b,row['end'],net);width=row['width']
  print(json.dumps({'routing':ri,'net':net,'max_states':1500000}),flush=True)
  try:legs,vias,visited=r.path(b,net,a,c,width,['F.Cu','B.Cu','In2.Cu'],sl,el,[1.0,.5,65.15,44.7],max_vias=6 if math.dist(a,c)>10 else 2,max_states=1500000,step=.1)
  except RuntimeError as ex:failed.append({'connection_index':ri,'plan':row,'error':str(ex)});break
  for vi,p in enumerate(vias):
   v=k.PCB_VIA(b);v.SetUuid(ident(f'route:{ri}:via:{vi}'));v.SetPosition(r.vec(p));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2));v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet(net));v.SetLocked(True);v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(v);added.append(v.m_Uuid.AsString())
  for li,(layer,points)in enumerate(legs):
   for ti,(x,y)in enumerate(zip(points,points[1:])):
    if math.dist(x,y)<1e-8:continue
    t=k.PCB_TRACK(b);t.SetUuid(ident(f'route:{ri}:leg:{li}:track:{ti}'));t.SetStart(r.vec(x));t.SetEnd(r.vec(y));t.SetLayer(b.GetLayerID(layer));t.SetNet(b.FindNet(net));t.SetWidth(k.FromMM(width));t.SetLocked(True);b.Add(t);added.append(t.m_Uuid.AsString())
  more.append({**row,'legs':legs,'vias':vias,'visited_states':visited,'length_mm':sum(math.dist(x,y)for _,pts in legs for x,y in zip(pts,pts[1:]))})
  print(json.dumps({'routed':ri,'length_mm':more[-1]['length_mm'],'vias':len(vias),'visited':visited}),flush=True)
  b.BuildConnectivity();k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v02/fieldnote.kicad_pro').read_bytes())
 now=r.track_snapshot(b);assert all(now.get(ui)==geometry for ui,geometry in old.items())
 report['resume_source_board_sha256']=before;report['plan']=plan;report['routes']+=more;report['failed']=failed
 report['added_copper'].update({ui:now[ui]for ui in added});report['candidate_board_sha256']=sha(ROOT/'fieldnote.kicad_pcb')
 report['status']='ROUTED_REQUIRES_NATIVE_DRC'if not failed else'PARTIAL_ROUTING_WITH_WITNESS'
 (ROOT/'output/routing-report.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'status':report['status'],'routes':len(report['routes']),'new_tracks_vias':len(report['added_copper']),'failed':failed}),flush=True)
if __name__=='__main__':main()
