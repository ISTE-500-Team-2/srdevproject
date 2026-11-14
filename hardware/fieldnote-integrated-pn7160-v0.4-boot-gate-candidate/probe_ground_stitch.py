from pathlib import Path
import json
import wx,pcbnew as k,route_pn7160 as r
ROOT=Path(__file__).resolve().parent
app=wx.App(False);b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'))
checks=[r.collision_test(b,'GND',.5,l,True)for l in r.ALL_COPPER]
z=next(z for z in b.Zones() if not z.GetIsRuleArea() and z.IsOnLayer(k.F_Cu))
poly=z.GetFilledPolysList(k.F_Cu)
rows=[]
for oi in (3,5):
 ol=poly.Outline(oi);vs=[r.xy(ol.CPoint(i))for i in range(ol.PointCount())]
 xs=[p[0]for p in vs];ys=[p[1]for p in vs]
 choices=[]
 for ix in range(int(min(xs)*10)+1,int(max(xs)*10)):
  for iy in range(int(min(ys)*10)+1,int(max(ys)*10)):
   p=[ix/10,iy/10]
   if r.inside(p,vs) and poly.Collide(r.vec(p)) and all(c(p,p)for c in checks):choices.append(p)
 rows.append({'outline':oi,'candidates':choices})
print(json.dumps(rows));(ROOT/'output/ground-stitch-probe.json').write_text(json.dumps(rows,indent=2)+'\n')
