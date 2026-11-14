from pathlib import Path
import math,json,hashlib,uuid
import wx,pcbnew as k,route_pn7160 as r
ROOT=Path(__file__).resolve().parent
app=wx.App(False);b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));tracks={t.m_Uuid.AsString():t for t in b.GetTracks()};report=json.loads((ROOT/'output/routing-report.json').read_text());row=report['routes'][11]
assert row['net']=='ESP_EN'
planes={ln:[z.GetFilledPolysList(b.GetLayerID(ln))for z in b.Zones()if not z.GetIsRuleArea()and z.GetNetname()=='GND'and z.IsOnLayer(b.GetLayerID(ln))]for ln in ('In1.Cu','In2.Cu')}
segments=[];totals={}
for li,(layer,pts)in enumerate(row['legs']):
 plane='In1.Cu'if layer=='F.Cu'else'In2.Cu';totals.setdefault(layer,{'length_mm':0.,'samples':0,'centerline_over_saved_ground':0,'full_track_width_over_saved_ground':0});total=totals[layer]
 for ti,(a,c)in enumerate(zip(pts,pts[1:])):
  uid=str(uuid.uuid5(uuid.NAMESPACE_URL,f'fieldnote-boot-gate-v04:route:11:leg:{li}:track:{ti}'));t=tracks[uid];assert r.xy(t.GetStart())==a and r.xy(t.GetEnd())==c
  length=math.dist(a,c);n=max(1,math.ceil(length/.025));perp=[-(c[1]-a[1])/length*.075,(c[0]-a[0])/length*.075];covered=[]
  for i in range(n+1):
   p=[a[0]+(c[0]-a[0])*i/n,a[1]+(c[1]-a[1])*i/n];test=lambda q:any(poly.Collide(r.vec(q))for poly in planes[plane]);center=test(p);band=center and all(test([p[0]+sgn*perp[0],p[1]+sgn*perp[1]])for sgn in (-1,1));covered.append({'xy':p,'center':center,'width':band});total['samples']+=1;total['centerline_over_saved_ground']+=int(center);total['full_track_width_over_saved_ground']+=int(band)
  total['length_mm']+=length;segments.append({'uuid':uid,'layer':layer,'adjacent_reference_plane':plane,'start':a,'end':c,'length_mm':length,'samples':len(covered),'centerline_uncovered_samples':[v['xy']for v in covered if not v['center']],'track_width_uncovered_samples':[v['xy']for v in covered if not v['width']]})
result={'board_sha256':hashlib.sha256((ROOT/'fieldnote.kicad_pcb').read_bytes()).hexdigest(),'status':'READ_ONLY_SAVED_FILL_GEOMETRIC_REFERENCE_SCREEN_NOT_SIGNAL_INTEGRITY_QUALIFICATION','output_length_mm':row['length_mm'],'vias':row['vias'],'tracks':segments,'totals':totals,'method':'Native saved GND polygons sampled every at most0.025mm along trace center and both0.075mm edges. Adjacent In1 for front and In2 for back. Polygon inclusion only; no field solve, return current, edge-rate, overshoot, EMI, or arbitrary supply-ramp result.'}
(ROOT/'output/EN-reference-screen.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'board_sha256':result['board_sha256'],'length':row['length_mm'],'totals':totals}))
