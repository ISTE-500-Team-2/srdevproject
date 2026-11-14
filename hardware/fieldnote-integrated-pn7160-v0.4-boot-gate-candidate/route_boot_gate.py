#!/usr/bin/env python3
"""Route only explicit new reset-control connections; preserve all other copper."""
from pathlib import Path
import hashlib,json,math,uuid,shutil
import wx
import pcbnew as k
import route_pn7160 as r
ROOT=Path(__file__).resolve().parent

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def ident(key):return k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-boot-gate-v04:'+key)))
def main():
 app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')))
 before=sha(ROOT/'fieldnote.kicad_pcb');old=r.track_snapshot(b);refs={f.GetReference():f for f in b.GetFootprints()};added=[];routes=[];failed=[];ground=[]
 def save():
  b.BuildConnectivity();k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v03/fieldnote.kicad_pro').read_bytes())
 def via(net,p,key):
  v=k.PCB_VIA(b);v.SetUuid(ident(key));v.SetPosition(r.vec(p));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2));v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet(net));v.SetLocked(True);v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(v);added.append(v.m_Uuid.AsString());return v
 # Local explicitreturns to preserved groundplanes; no vias in SMTlands.
 for spec in ('U8.2','C38.2','R29.2','R30.2'):
  p,sl=r.endpoint(b,spec,'GND');checks=[r.collision_test(b,'GND',.5,layer,True)for layer in r.ALL_COPPER]
  candidates=[]
  for ix in range(-16,17):
   for iy in range(-16,17):
    delta=[ix*.1,iy*.1];dist=math.hypot(*delta)
    if .7<=dist<=1.6:candidates.append((dist,[round(p[0]+delta[0],6),round(p[1]+delta[1],6)]))
  candidates.sort()
  for dist,vp in candidates:
   if not(1<=vp[0]<=65.15 and .5<=vp[1]<=44.7):continue
   if all(check(vp,vp) for check in checks):via('GND',vp,'local-ground:'+spec);ground.append({'pad':spec,'xy':vp,'distance_mm':dist});break
  else:raise RuntimeError(('NO_LOCAL_GROUND_VIA',spec,p))
 connections=[
  ('3V3',{'xy':[59.0,26.684],'layers':r.ALL_COPPER},'C7.1',.25,'Reconnect original3V3 transit after removing R12 padjunction'),
  ('ESP_RESET_RC',{'xy':[59.65,29.5047],'layers':r.ALL_COPPER},'C9.1',.15,'Retain original resetRC/input network with C9'),
  ('ESP_EN','U1.8','R29.1',.15,'Output pulldown at CHIP_EN'),
  ('3V3','U8.5','C38.1',.25,'Local gate decoupling supply'),
  ('3V3','C38.1','U1.3',.25,'Gate supply from preserved ESP3V3 supply'),
  ('ESP_RESET_RC','U8.3','C9.1',.15,'Manual/recovery resetRCinput'),
  ('POWER_PERMIT','U8.6','R30.1',.15,'Default-low gatepermission'),
  ('POWER_PERMIT','R30.1','JP1.2',.15,'Selector common topermissionpulldown'),
  ('USB_HIGH_CURRENT','JP1.1',{'xy':[41.933,31.4388],'layers':r.ALL_COPPER},.15,'NormalUSBqualified selectorinput; oldU7/BQnet retained'),
  ('3V3','JP1.3','C38.1',.15,'Service-only selectorinput'),
  ('POWER_PERMIT','U8.6','R12.2',.15,'ResetRCpullup begins whenpermissionasserts'),
  ('ESP_EN','U8.4','U1.8',.15,'QualifiedSchmittoutput toESP CHIP_EN'),
  ('GND','U8.1','U8.2',.2,'ANDtruthselection tiedtoGND')]
 for row in ground:connections.append(('GND',row['pad'],{'xy':row['xy'],'layers':r.ALL_COPPER},.2,'Localgroundreturn'))
 plan=[]
 for ri,(net,start,end,width,purpose) in enumerate(connections):
  a,sl=r.endpoint(b,start,net);c,el=r.endpoint(b,end,net);row={'net':net,'start':start,'end':end,'width':width,'purpose':purpose};plan.append(row)
  print(json.dumps({'routing':ri,'net':net,'start':a,'end':c,'purpose':purpose}),flush=True)
  try:legs,vias,visited=r.path(b,net,a,c,width,['F.Cu','B.Cu','In2.Cu'],sl,el,[1.0,.5,65.15,44.7],max_vias=6 if math.dist(a,c)>10 else 2,max_states=600000,step=.1)
  except RuntimeError as ex:
   failed.append({'connection_index':ri,'plan':row,'error':str(ex)});save();(ROOT/'output/routing-failure.json').write_text(json.dumps(failed,indent=2)+'\n');print(json.dumps({'failure':failed[-1]}),flush=True);break
  for vi,p in enumerate(vias):via(net,p,f'route:{ri}:via:{vi}')
  for li,(layer,points) in enumerate(legs):
   for ti,(x,y) in enumerate(zip(points,points[1:])):
    if math.dist(x,y)<1e-8:continue
    t=k.PCB_TRACK(b);t.SetUuid(ident(f'route:{ri}:leg:{li}:track:{ti}'));t.SetStart(r.vec(x));t.SetEnd(r.vec(y));t.SetLayer(b.GetLayerID(layer));t.SetNet(b.FindNet(net));t.SetWidth(k.FromMM(width));t.SetLocked(True);b.Add(t);added.append(t.m_Uuid.AsString())
  routes.append({**row,'legs':legs,'vias':vias,'visited_states':visited,'length_mm':sum(math.dist(x,y)for _,pts in legs for x,y in zip(pts,pts[1:]))});save();print(json.dumps({'routed':ri,'length_mm':routes[-1]['length_mm'],'vias':len(vias),'visited':visited}),flush=True)
 now=r.track_snapshot(b);assert all(now.get(ui)==geom for ui,geom in old.items())
 save();report={'status':'ROUTED_REQUIRES_NATIVE_DRC' if not failed else 'PARTIAL_ROUTING_WITH_WITNESS','source_board_sha256':before,'candidate_board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'plan':plan,'routes':routes,'ground_vias':ground,'added_copper':{ui:now[ui]for ui in added},'inherited_copper_count':len(old),'inherited_copper_preserved':True,'failed':failed}
 (ROOT/'output/routing-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'status':report['status'],'routes':len(routes),'added_tracks_vias':len(added)}),flush=True)
if __name__=='__main__':main()
