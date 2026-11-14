import pcbnew as k,wx,route_pn7160 as r
from pathlib import Path
root=Path(__file__).resolve().parent
app=wx.App(False);b=k.LoadBoard(str(root/'fieldnote.kicad_pcb'))
for spec in ['R30.1','JP1.2']:
 p,l=r.endpoint(b,spec,'POWER_PERMIT');print(spec,p,l)
 for layer in ['F.Cu','B.Cu','In2.Cu']:
  f=r.collision_test(b,'POWER_PERMIT',.15,layer);print(layer,f(p,p),[(dy,f(p,[p[0],p[1]+dy]))for dy in [-1,-.5,-.2,.2,.5,1]])
