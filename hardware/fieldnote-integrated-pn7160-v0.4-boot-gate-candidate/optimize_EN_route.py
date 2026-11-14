from pathlib import Path
import json,hashlib,math,uuid
import wx,pcbnew as k,route_pn7160 as r
ROOT=Path(__file__).resolve().parent
app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')))
def uid(key):return str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-boot-gate-v04:'+key))
old=json.loads((ROOT/'output/routing-report.json').read_text());rt=old['routes'][11];remove=set()
for vi,_ in enumerate(rt['vias']):remove.add(uid(f'route:11:via:{vi}'))
for li,(_,points) in enumerate(rt['legs']):
 for ti,_ in enumerate(zip(points,points[1:])):remove.add(uid(f'route:11:leg:{li}:track:{ti}'))
items=list(b.GetTracks());seen=set()
for track in items:
 ui=track.m_Uuid.AsString()
 if ui in remove:b.Remove(track);seen.add(ui)
assert seen==remove
r.VIA_COST=.6;a,sl=r.endpoint(b,'U8.4','ESP_EN');c,el=r.endpoint(b,'U1.8','ESP_EN')
print(json.dumps({'status':'READ_ONLY_OUTPUT_ROUTE_OPTIMIZATION','removed_candidate_output_items':len(remove),'via_cost':r.VIA_COST,'start':a,'end':c}),flush=True)
try:
 legs,vias,visited=r.path(b,'ESP_EN',a,c,.15,['F.Cu','B.Cu','In2.Cu'],sl,el,[1.0,.5,65.15,38.3],max_vias=6,max_states=1000000,step=.1)
 report={'status':'READ_ONLY_SHORTER_ROUTE_PROPOSAL','source_board_sha256':hashlib.sha256((ROOT/'fieldnote.kicad_pcb').read_bytes()).hexdigest(),'removed_only_candidate_output_items':sorted(remove),'via_cost':r.VIA_COST,'legs':legs,'vias':vias,'visited':visited,'length_mm':sum(math.dist(x,y)for _,pts in legs for x,y in zip(pts,pts[1:])),'old_length_mm':rt['length_mm'],'forbidden_layers':['In1.Cu'],'native_save':False,'electrical_scope':'Track/via geometriccollisionclearance only; no edge/rise/overshoot/noise physical acceptance.'}
except RuntimeError as ex:report={'status':'READ_ONLY_NO_PATH_WITNESS','error':str(ex),'native_save':False}
(ROOT/'output/read-only-shorter-EN-route.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items()if k not in('legs','removed_only_candidate_output_items')},indent=2),flush=True)
