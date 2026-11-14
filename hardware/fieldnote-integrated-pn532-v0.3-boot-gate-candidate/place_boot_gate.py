#!/usr/bin/env python3
from pathlib import Path
import json,math,hashlib,itertools
import pcbnew as k
import wx
import route_local as r
import build_design as g
ROOT=Path(__file__).resolve().parent
NEW=['U8','C38','R29','R30','JP1']
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 app=wx.App(False);manager=k.GetSettingsManager();manager.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(manager.GetProject(str(ROOT/'fieldnote.kicad_pro')))
 before=sha(ROOT/'fieldnote.kicad_pcb');fs={f.GetReference():f for f in b.GetFootprints()};data=json.loads((ROOT/'design-data.json').read_text());parts={p['ref']:p for p in data['parts']}
 for ref in NEW:fs[ref].SetPosition(r.vec([-50,-50]));fs[ref].Reference().SetVisible(False)
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
  if z.GetIsRuleArea() and z.IsOnLayer(k.F_Cu) and z.GetDoNotAllowPads():
   for i in range(z.Outline().OutlineCount()):ol=z.Outline().Outline(i);polygons.append([r.xy(ol.CPoint(i)) for i in range(ol.PointCount())])
 outline=data['outline']
 def legal(ref):
  f=fs[ref];cb=r.courtyard(f)
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
 for ref in NEW:
  desired=parts[ref]['xy']
  if ref=='NEVER_C38_DYNAMIC':
   u8=fs['U8'];vcc=next(p for p in u8.Pads() if p.GetNumber()=='5');desired=r.xy(vcc.GetPosition());desired=[desired[0],desired[1]]
  if ref=='NEVER_R30_DYNAMIC':desired=[solved['U8']['xy'][0],solved['U8']['xy'][1]+2.5]
  candidates=[]
  for angle in ([0,90,180,-90] if ref!='JP1' else [0,180,90,-90]):
   for ix in range(4,260):
    x=ix*.25
    for iy in range(3,177):
     y=iy*.25
     if x<32.9 and y>11.5:continue
     distance=math.hypot(x-desired[0],y-desired[1]);anglepenalty=0 if angle==parts[ref]['angle'] else .25
     candidates.append((distance+anglepenalty,x,y,angle))
  candidates.sort()
  for tested,(_,x,y,angle) in enumerate(candidates):
   fs[ref].SetPosition(r.vec([x,y]));fs[ref].SetOrientationDegrees(angle)
   if legal(ref):
    solved[ref]={'xy':[x,y],'angle':angle,'candidates_tested':tested+1,'courtyard':r.courtyard(fs[ref])};courts[ref]=solved[ref]['courtyard'];parts[ref]['xy']=[x,y];parts[ref]['angle']=angle
    print(json.dumps({'placed':ref,**solved[ref]}),flush=True);break
  else:raise RuntimeError(('NO_NEW_PART_PLACEMENT',ref))
 k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v02/fieldnote.kicad_pro').read_bytes())
 (ROOT/'design-data.json').write_text(json.dumps(data,indent=2)+'\n');(ROOT/'output/placement-search.json').write_text(json.dumps({'source_board_sha256':before,'candidate_board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'scope':'Only new5footprints moved; preservedoldcourtyards/pads/frontcopper/keepouts; nativeDRCrequired','solved':solved},indent=2)+'\n')
if __name__=='__main__':main()
