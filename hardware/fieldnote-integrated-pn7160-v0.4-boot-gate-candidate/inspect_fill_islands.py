from pathlib import Path
import json,math
import wx,pcbnew as k,route_pn7160 as r
ROOT=Path(__file__).resolve().parent
app=wx.App(False);b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'))
contacts=[]
for f in b.GetFootprints():
 for pad in f.Pads():
  if pad.GetNetname()=='GND' and pad.IsOnLayer(k.F_Cu):contacts.append((f.GetReference()+'.'+pad.GetNumber(),r.xy(pad.GetPosition())))
for t in b.GetTracks():
 if t.GetNetname()=='GND' and isinstance(t,k.PCB_VIA):contacts.append(('via:'+t.m_Uuid.AsString(),r.xy(t.GetPosition())))
rows=[]
for z in b.Zones():
 if z.GetIsRuleArea() or not z.IsOnLayer(k.F_Cu):continue
 poly=z.GetFilledPolysList(k.F_Cu)
 for oi in range(poly.OutlineCount()):
  ol=poly.Outline(oi);vs=[r.xy(ol.CPoint(i)) for i in range(ol.PointCount())]
  xs=[p[0]for p in vs];ys=[p[1]for p in vs];area=abs(sum(a[0]*c[1]-c[0]*a[1]for a,c in zip(vs,vs[1:]+vs[:1])))/2
  hit=[{'ref':ref,'xy':p}for ref,p in contacts if r.inside(p,vs)]
  row={'outline':oi,'bounds':[min(xs),min(ys),max(xs),max(ys)],'area_mm2':area,'vertices':len(vs),'ground_contacts_at_centers':hit}
  rows.append(row)
print(json.dumps(rows,indent=2));(ROOT/'output/fill-island-inspection.json').write_text(json.dumps(rows,indent=2)+'\n')
