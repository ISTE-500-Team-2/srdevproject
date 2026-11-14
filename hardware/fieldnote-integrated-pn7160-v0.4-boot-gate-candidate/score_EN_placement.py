#!/usr/bin/env python3
from pathlib import Path
import json,math,hashlib,itertools
import pcbnew as k
import wx
import route_pn7160 as r
import build_design as g
ROOT=Path(__file__).resolve().parent
NEW=['U8','C38','R29','R30','JP1']
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 app=wx.App(False);manager=k.GetSettingsManager();manager.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(manager.GetProject(str(ROOT/'fieldnote.kicad_pro')))
 before=sha(ROOT/'fieldnote.kicad_pcb');fs={f.GetReference():f for f in b.GetFootprints()};data=json.loads((ROOT/'design-data.json').read_text());parts={p['ref']:p for p in data['parts']}
 for ref in NEW:fs[ref].SetPosition(r.vec([-50,-50]));fs[ref].Reference().SetVisible(False)
 added=json.loads((ROOT/'output/routing-report.json').read_text())['added_copper'];
 retained_tracks=list(b.GetTracks())
 for track in retained_tracks:
  if track.m_Uuid.AsString() in added:b.Remove(track)
 target,_=r.endpoint(b,'U1.8','ESP_EN')
 courts={ref:r.courtyard(f) for ref,f in fs.items() if ref not in NEW}
 copper=[]
 for t in b.GetTracks():
  if t.IsOnLayer(k.F_Cu):copper.append((r.xy(t.GetStart()),r.xy(t.GetEnd()),k.ToMM(t.GetWidth(k.F_Cu) if isinstance(t,k.PCB_VIA) else t.GetWidth())/2,t.GetNetname(),isinstance(t,k.PCB_VIA)))
 for f in b.GetFootprints():
  if f.GetReference() in NEW:continue
  for shape in f.GraphicalItems():
   if shape.IsOnLayer(k.F_Cu) and isinstance(shape,k.PCB_SHAPE) and shape.GetShape()==k.SHAPE_T_SEGMENT:
    copper.append((r.xy(shape.GetStart()),r.xy(shape.GetEnd()),k.ToMM(shape.GetWidth())/2,'<footprint-copper>',False))
 polygons=[]
 for z in b.Zones():
  if z.GetIsRuleArea() and z.IsOnLayer(k.F_Cu) and (z.GetDoNotAllowPads() or z.GetDoNotAllowTracks() or z.GetDoNotAllowVias()):
   for i in range(z.Outline().OutlineCount()):ol=z.Outline().Outline(i);polygons.append([r.xy(ol.CPoint(i)) for i in range(ol.PointCount())])
 outline=data['outline']
 def legal(ref):
  f=fs[ref];cb=r.courtyard(f)
  if cb and not all(r.inside(v,outline) for v in [[cb[0],cb[1]],[cb[2],cb[1]],[cb[2],cb[3]],[cb[0],cb[3]]]):return False
  contacts=json.loads((ROOT/'source-v03/retention-parameters.json').read_text())['contact_centers_board_mm']
  if cb and any(r.inside(v,poly) for poly in polygons for v in [[cb[0],cb[1]],[cb[2],cb[1]],[cb[2],cb[3]],[cb[0],cb[3]]]):return False
  if cb and any(not (cb[2]<cx-2.2 or cb[0]>cx+2.2 or cb[3]<cy-2.2 or cb[1]>cy+2.2) for cx,cy in contacts):return False
  if cb and any(other and not(cb[2]+.015<other[0] or cb[0]-.015>other[2] or cb[3]+.015<other[1] or cb[1]-.015>other[3]) for other in courts.values()):return False
  for pad in f.Pads():
   bb=pad.GetBoundingBox();a=r.xy(bb.GetPosition());c=r.xy(k.VECTOR2I(bb.GetX()+bb.GetWidth(),bb.GetY()+bb.GetHeight()));vs=[a,[c[0],a[1]],c,[a[0],c[1]]]
   if not all(r.inside(v,outline) for v in vs):return False
   if any(r.inside(v,poly) for poly in polygons for v in vs):return False
   for u,v,radius,net,is_via in copper:
    if net==pad.GetNetname() and not is_via:continue
    margin=radius+(.05 if net==pad.GetNetname() and is_via else .165)
    if max(u[0],v[0])+margin<a[0] or min(u[0],v[0])-margin>c[0] or max(u[1],v[1])+margin<a[1] or min(u[1],v[1])-margin>c[1]:continue
    if any(a[0]<=q[0]<=c[0] and a[1]<=q[1]<=c[1] for q in (u,v)):return False
    if any(r.segment_distance(u,v,q,rr)<margin-1e-8 for q,rr in zip(vs,vs[1:]+vs[:1])):return False
  return True
 solved={}
 # Newparts only; old positions/copper are immutable obstacles. Prefer requested location and front-side sites.
 for ref in ['U8']:
  desired=parts[ref]['xy']
  if ref=='C38':
   u8=fs['U8'];vcc=next(p for p in u8.Pads() if p.GetNumber()=='5');desired=r.xy(vcc.GetPosition());desired=[desired[0],desired[1]]
  if ref=='R30':desired=[solved['U8']['xy'][0],solved['U8']['xy'][1]+2.5]
  candidates=[]
  for angle in ([0,90,180,-90] if ref!='JP1' else [0,180,90,-90]):
   for ix in range(4,260):
    x=ix*.25
    for iy in range(3,177):
     y=iy*.25
     if x<32.9 and y>11.5:continue
     theta=math.radians(angle);ox=1.3*math.cos(theta)+.95*math.sin(theta);oy=-1.3*math.sin(theta)+.95*math.cos(theta);distance=math.hypot(x+ox-target[0],y+oy-target[1]);anglepenalty=0
     candidates.append((distance+anglepenalty,x,y,angle))
  candidates.sort()
  legal_sites=[]
  for tested,(score,x,y,angle) in enumerate(candidates):
   fs[ref].SetPosition(r.vec([x,y]));fs[ref].SetOrientationDegrees(angle)
   if legal(ref):
    output,_=r.endpoint(b,'U8.4','ESP_EN');legal_sites.append({'xy':[x,y],'angle':angle,'output_pad':output,'direct_output_distance_mm':math.dist(output,target),'courtyard':r.courtyard(fs[ref])})
    if len(legal_sites)>=30:break
  print(json.dumps({'target_U1_EN':target,'legal_sites':legal_sites[:12],'tested':tested+1},indent=2));(ROOT/'output/read-only-EN-placement-score.json').write_text(json.dumps({'status':'READ_ONLY_LEGAL_U8_PROPOSALS_WITH_R2_CONTACT_RESERVE_NOT_ROUTED','target_U1_EN':target,'legal_sites':legal_sites,'tested':tested+1,'old_copper_exclusion':'Only109previouslyaddedcandidateitemsremovedinmemory; noCADwrites','source_board_sha256':before},indent=2)+'\n')
  return
 k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v03/fieldnote.kicad_pro').read_bytes())
 (ROOT/'design-data.json').write_text(json.dumps(data,indent=2)+'\n');(ROOT/'output/placement-search.json').write_text(json.dumps({'source_board_sha256':before,'candidate_board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'scope':'Only new5footprints moved; preservedoldcourtyards/pads/frontcopper/keepouts; nativeDRCrequired','solved':solved},indent=2)+'\n')
if __name__=='__main__':main()
