"""Prepare the seven remaining signals for a routing pass with ground planes.

Choose ordinary ground stitching sites with copper and solder-land clearance.
BQ24074 thermal vias are a deliberate exception: through-vias in its thermal
land, with assembly stencil/tenting notes to be confirmed by the assembler.
"""
from pathlib import Path
import math,json
import pcbnew as k
import wx
from finish_ground import via,route,vec
ROOT=Path(__file__).resolve().parent
def line_distance(x,y,a,c):
    dx,dy=c[0]-a[0],c[1]-a[1];den=dx*dx+dy*dy
    t=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/den)) if den else 0
    return math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)
def main():
    app=wx.App(False);path=ROOT/'fieldnote.kicad_pcb';b=k.LoadBoard(str(path))
    fs=list(b.GetFootprints());fps={f.GetReference():f for f in fs};ts=list(b.GetTracks())
    # Replace the manually trialled USB fanout as part of a later paired route.
    for t in ts:
        if t.GetNetname() in ['USB_DP','USB_DM','MCU_USB_DP','MCU_USB_DM']:b.Remove(t)
        elif t.GetNetname()=='GND':
            if isinstance(t,k.PCB_VIA):
                xy=(round(k.ToMM(t.GetPosition().x)-60,3),round(k.ToMM(t.GetPosition().y)-50,3))
                if xy in [(41.8,28.7),(57.75,11.25)]:b.Remove(t)
            else:
                a,c=t.GetStart(),t.GetEnd()
                ends={(round(k.ToMM(v.x)-60,3),round(k.ToMM(v.y)-50,3)) for v in [a,c]}
                if (41.8,28.7) in ends or (57.75,11.25) in ends:b.Remove(t)
    # Conventional 0.3 mm plated through thermal vias, back mask tented.
    # No paste aperture crosses a hole; assembler must review this stencil.
    for xy in [(58,8.3),(58,9.3)]+[(40.8+x,25+y) for x in [-.685,.685] for y in [-.685,.685]]:
        via(b,'GND',xy)
    for t in list(b.GetTracks()):
        if isinstance(t,k.PCB_VIA):t.SetBackTentingMode(k.TENTING_MODE_TENTED)
    # PN532: nine 1.0 mm windows = 53.5% before rounded corners. A 0.25 mm
    # hole/paste separation circle fits in each four-window junction.
    for p in fps['U2'].Pads():
        if p.IsOnLayer(k.F_Paste) and not p.IsOnLayer(k.F_Cu):p.SetSize(k.VECTOR2I(k.FromMM(1),k.FromMM(1)))
    # BQ24074: notch four 0.7 mm windows to clear each drill by 0.10 mm.
    old_paste=[p for p in fps['U3'].Pads() if p.IsOnLayer(k.F_Paste) and not p.IsOnLayer(k.F_Cu)]
    for p in old_paste:fps['U3'].Remove(p)
    window=[(.07,.07),(.77,.07),(.77,.77),(.07,.77),(.07,.75),(.25,.75),(.25,.25),(.07,.25)]
    for sx in [-1,1]:
        for sy in [-1,1]:
            p=k.PAD(fps['U3']);p.SetNumber('');p.SetAttribute(k.PAD_ATTRIB_SMD);p.SetShape(k.PAD_SHAPE_CUSTOM)
            p.SetSize(k.VECTOR2I(k.FromMM(.05),k.FromMM(.05)));p.SetPosition(fps['U3'].GetPosition())
            layers=k.LSET();layers.AddLayer(k.F_Paste);p.SetLayerSet(layers)
            poly=k.SHAPE_POLY_SET();poly.NewOutline()
            for x,y in window:poly.Append(k.VECTOR2I(k.FromMM(x*sx),k.FromMM(y*sy)))
            p.AddPrimitivePoly(k.F_Paste,poly,0,True);fps['U3'].Add(p)
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones())
    # Conservative via-site screen; pad rectangles include assembly lands.
    pads=[p for f in fs for p in f.Pads() if any(p.IsOnLayer(layer) for layer in [k.F_Cu,k.In1_Cu,k.In2_Cu,k.B_Cu])]
    tracks=list(b.GetTracks())
    ground_zone=next(z for z in b.Zones() if z.GetZoneName()=='GND F.Cu')
    chosen=[]
    def free(x,y,why=False):
        if x<33.6 or y>38.1 or not ground_zone.HitTestFilledArea(k.F_Cu,vec((x,y))):return False
        ax,ay=x+60,y+50
        for p in pads:
            bb=p.GetBoundingBox();lx,ly=k.ToMM(bb.GetX()),k.ToMM(bb.GetY())
            hx,hy=lx+k.ToMM(bb.GetWidth()),ly+k.ToMM(bb.GetHeight())
            dist=math.hypot(max(lx-ax,0,ax-hx),max(ly-ay,0,ay-hy))
            # Keep drill holes outside GND solder lands by 0.15 mm as well.
            if dist < (.3 if p.GetNetname()=='GND' else .451):
                if why: print('PAD',x,y,p.GetParentFootprint().GetReference(),p.GetNumber(),p.GetNetname(),dist,lx,ly,hx,hy)
                return False
        for t in tracks:
            if isinstance(t,k.PCB_VIA):
                v=t.GetPosition();dist=math.hypot(ax-k.ToMM(v.x),ay-k.ToMM(v.y))
                if dist < .76:
                    if why: print('VIA',x,y,t.GetNetname(),dist,k.ToMM(v.x)-60,k.ToMM(v.y)-50)
                    return False
            elif t.GetNetname()!='GND':
                a,c=t.GetStart(),t.GetEnd()
                if line_distance(ax,ay,(k.ToMM(a.x),k.ToMM(a.y)),(k.ToMM(c.x),k.ToMM(c.y))) < .451+k.ToMM(t.GetWidth())/2:
                    if why: print('TRACK',x,y,t.GetNetname(),k.ToMM(a.x)-60,k.ToMM(a.y)-50,k.ToMM(c.x)-60,k.ToMM(c.y)-50)
                    return False
        if any(math.hypot(x-a,y-c)<.8 for a,c in chosen):return False
        return True
    for center in [(58,8.8),(56.8,23)]:
        candidates=[]
        for ix in range(-50,51):
            for iy in range(-50,51):
                x,y=round(center[0]+ix*.1,4),round(center[1]+iy*.1,4)
                r=math.hypot(ix*.1,iy*.1)
                if r<=5:candidates.append((r,x,y))
        site=next(((x,y) for _,x,y in sorted(candidates) if free(x,y)),None)
        if not site:
            print('No additional exterior stitching site within 5 mm',center)
            continue
        via(b,'GND',site);chosen.append(site)
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones());k.SaveBoard(str(path),b)
    assert k.ExportSpecctraDSN(b,str(ROOT/'output/fieldnote-ground-complete.dsn'))
    (ROOT/'output/ground-via-sites.json').write_text(json.dumps(chosen,indent=2)+'\n')
    print(json.dumps(dict(ground_stitch_sites=chosen)))
if __name__=='__main__':main()
