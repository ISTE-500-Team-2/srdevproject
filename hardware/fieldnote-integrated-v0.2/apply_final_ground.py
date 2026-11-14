"""Finish isolated ground returns; defaults to a separate copied candidate.

--apply BOARD updates only the named failed GND items, two explicitly approved
USB-control via diameters/drills, and the deterministic GND additions below.
No footprint, signal-track, zone constraint, RF, power, or silk edits occur.
Run native DRC after application, because future routing may alter clearances.
"""
from pathlib import Path
import argparse, json, math, shutil, uuid
import pcbnew as k
import wx
from apply_silkscreen_cleanup import immutable
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output/final-ground-candidate'
BAD={
 '528bddc4-3da1-4a74-956e-50990865360f',
 'f95f846e-26fd-412d-9cfc-50fcfbf79934',
 'b21fc11e-960f-4f17-847e-6d1d31dbac71',
 '8d8a1b3e-d178-4713-a2ad-c9db7d9c1063',
 'bc9a6cb6-b251-4c97-ba63-19c66396091b',
 'eb669d3d-3c13-41a1-a8ce-d970832231a0',
}
RESIZE={
 '8cdfb8db-2a40-430e-b85f-9b5666920008':('CC2',(41.7463,5.7073)),
 '1dbc9ce5-f62b-4cb4-822c-944c2cab1aa7':('USB_VBUS_DET',(42.6799,6.4973)),
}
VIAS={
 'SW2-3':(37.6,2.4),'SW2-4':(40.65,2.4),'U5-2':(52.9,7.5),
 'C20-2':(41.6,20.25),'U6-3':(42.025,6.325),'U6-10-11':(43.025,2.675),
}
PATHS={
 'C20-2':[(42.275,20),(41.6,20.25)],
 'U6-3':[(42.4,5.75),(42.4,5.95),(42.025,6.325)],
 'U6-11':[(42.8,4.25),(43,4.05),(43.1,3.95),(43.1,2.95),(43.025,2.675)],
 'U6-10':[(43.2,4.25),(43,4.05)],
}
def uid(key):return str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-v0.2-final-ground:'+key))
def xy(v):return (round(k.ToMM(v.x)-60,6),round(k.ToMM(v.y)-50,6))
def vec(p):return k.VECTOR2I(k.FromMM(p[0]+60),k.FromMM(p[1]+50))
def owned_ids():return {uid('via:'+s) for s in VIAS}|{uid('track:'+s+':'+str(i)) for s,pts in PATHS.items() for i in range(len(pts)-1)}
def stable(b):
 # Ignore only the authorized mutable IDs. All other native tracks/pads,
 # placements, footprint identifiers, zone outlines and edges must match.
 p,t,z,e=immutable(b)
 return (p,[a for a in t if a[0] not in BAD|set(RESIZE)|owned_ids()],z,e)
def apply(b):
 before=stable(b);tracks=list(b.GetTracks());fps=list(b.GetFootprints());report={'removed':[],'resized':[],'new_vias':[],'new_tracks':[]}
 for t in tracks:
  ident=str(t.m_Uuid.AsString())
  if ident in BAD:
   assert t.GetNetname()=='GND',(ident,t.GetNetname());b.Remove(t);report['removed'].append(ident)
  elif ident in owned_ids():
   assert t.GetNetname()=='GND';b.Remove(t)
  elif ident in RESIZE:
   net,pos=RESIZE[ident];assert isinstance(t,k.PCB_VIA) and t.GetNetname()==net and math.dist(xy(t.GetPosition()),pos)<1e-5
   old=(k.ToMM(t.GetWidth(k.F_Cu)),k.ToMM(t.GetDrillValue()));assert old in [(.6,.3),(.5,.2)],(ident,old)
   t.SetWidth(k.FromMM(.5));t.SetDrill(k.FromMM(.2))
   report['resized'].append({'uuid':ident,'net':net,'position':pos,'old_diameter_drill_mm':old,'new_diameter_drill_mm':[.5,.2],'annular_ring_mm':.15})
 assert len(report['resized'])==2,'Expected USB-control vias missing'
 # Every new drill is completely outside each SMT pad. A tented annulus may
 # attach the same-net land edge; C20 has 0.125mm drill-to-land separation.
 for name,pos in VIAS.items():
  separations=[]
  for f in fps:
   for pad in f.Pads():
    if pad.GetAttribute()!=k.PAD_ATTRIB_SMD:continue
    bb=pad.GetBoundingBox();a=xy(bb.GetOrigin());c=(a[0]+k.ToMM(bb.GetWidth()),a[1]+k.ToMM(bb.GetHeight()))
    separation=math.hypot(max(a[0]-pos[0],0,pos[0]-c[0]),max(a[1]-pos[1],0,pos[1]-c[1]))-.1
    assert separation>=.025-1e-6,('Drill overlaps/approaches SMT land',name,f.GetReference(),pad.GetNumber(),separation)
    separations.append(separation)
  v=k.PCB_VIA(b);v.SetUuid(k.KIID(uid('via:'+name)));v.SetPosition(vec(pos));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2));v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet('GND'));v.SetLocked(True);v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(v)
  report['new_vias'].append({'uuid':uid('via:'+name),'purpose':name,'position':pos,'diameter_mm':.5,'drill_mm':.2,'min_drill_to_SMT_land_bbox_mm':round(min(separations),6),'tented_front_back':True})
 for name,points in PATHS.items():
  for i,(a,c) in enumerate(zip(points,points[1:])):
   ident=uid('track:'+name+':'+str(i));t=k.PCB_TRACK(b);t.SetUuid(k.KIID(ident));t.SetStart(vec(a));t.SetEnd(vec(c));t.SetLayer(k.F_Cu);t.SetWidth(k.FromMM(.15));t.SetNet(b.FindNet('GND'));t.SetLocked(True);b.Add(t)
   report['new_tracks'].append({'uuid':ident,'purpose':name,'start':a,'end':c,'width_mm':.15,'layer':'F.Cu'})
 assert stable(b)==before,'Unrelated board geometry changed'
 b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones())
 assert stable(b)==before,'Refill changed unrelated copper/pad/placement/zone constraints'
 # Native connectivity assigns free vias by touched copper, so explicitly
 # verify all additions retained GND after fill.
 for t in b.GetTracks():
  if str(t.m_Uuid.AsString()) in owned_ids():assert t.GetNetname()=='GND',('Ground addition reassigned',str(t.m_Uuid.AsString()),t.GetNetname())
 report['unrelated_tracks_pads_placements_edges_zone_constraints_unchanged']=True
 report['ground_zone_island_removal_modes']=[{'zone':z.GetZoneName(),'mode':z.GetIslandRemovalMode()} for z in b.Zones() if z.GetNetname()=='GND' and not z.GetIsRuleArea()]
 return report
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--apply',type=Path);args=parser.parse_args();app=wx.App(False);OUT.mkdir(parents=True,exist_ok=True)
 target=args.apply.resolve() if args.apply else OUT/'fieldnote.kicad_pcb'
 if not args.apply:
  for pattern in ['*.kicad_sch','fieldnote.kicad_pro','Fieldnote.kicad_sym','sym-lib-table','fp-lib-table']:
   for source in ROOT.glob(pattern):shutil.copyfile(source,OUT/source.name)
  shutil.copytree(ROOT/'Fieldnote.pretty',OUT/'Fieldnote.pretty',dirs_exist_ok=True);shutil.copyfile(ROOT/'fieldnote.kicad_pcb',target)
 b=k.LoadBoard(str(target));report=apply(b);k.SaveBoard(str(target),b);report['board']=str(target)
 (OUT/'ground-patch.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'board':str(target),'removed':len(report['removed']),'resized':len(report['resized']),'ground_vias':len(report['new_vias']),'ground_tracks':len(report['new_tracks']),'unrelated_geometry_preserved':True}))
if __name__=='__main__':main()
