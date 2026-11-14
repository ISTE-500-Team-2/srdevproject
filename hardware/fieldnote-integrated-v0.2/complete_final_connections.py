"""Finish native routed revision; never relax fabrication constraints."""
from pathlib import Path
import json,math
import pcbnew as k
import wx
ROOT=Path(__file__).resolve().parent
def vec(p):return k.VECTOR2I(k.FromMM(p[0]+60),k.FromMM(p[1]+50))
def xy(p):return (k.ToMM(p.x)-60,k.ToMM(p.y)-50)
def distance(p,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1];den=dx*dx+dy*dy
    t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)) if den else 0
    return math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)
def route(b,net,points,layer,width=.15):
    for a,c in zip(points,points[1:]):
        t=k.PCB_TRACK(b);t.SetStart(vec(a));t.SetEnd(vec(c));t.SetLayer(layer);t.SetWidth(k.FromMM(width));t.SetNet(b.FindNet(net));t.SetLocked(True);b.Add(t)
def via(b,net,p):
    t=k.PCB_VIA(b);t.SetPosition(vec(p));t.SetWidth(k.FromMM(.5));t.SetDrill(k.FromMM(.2));t.SetViaType(k.VIATYPE_THROUGH);t.SetLayerPair(k.F_Cu,k.B_Cu);t.SetNet(b.FindNet(net));t.SetLocked(True);t.SetFrontTentingMode(k.TENTING_MODE_TENTED);t.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(t)
def main():
    app=wx.App(False);path=ROOT/'fieldnote.kicad_pcb';b=k.LoadBoard(str(path))
    tracks=list(b.GetTracks());fps=list(b.GetFootprints())
    assert not any(t.GetNetname()=='NFC_OSCOUT' and isinstance(t,k.PCB_VIA) for t in tracks), 'Apply once to the cleaned session import; this stage already exists.'
    old=(41.05,28.65);new=(41.4,28.85)
    for t in tracks:
        if t.GetNetname()=='GND' and not isinstance(t,k.PCB_VIA) and math.dist(xy(t.GetStart()),(41.55,27.9375))<1e-5 and math.dist(xy(t.GetEnd()),(41.55,28.45))<1e-5:b.Remove(t)
        if t.GetNetname()!='PN3V':continue
        if isinstance(t,k.PCB_VIA):
            if math.dist(xy(t.GetPosition()),old)<1e-5:t.SetPosition(vec(new))
        else:
            if math.dist(xy(t.GetStart()),old)<1e-5:t.SetStart(vec(new))
            if math.dist(xy(t.GetEnd()),old)<1e-5:t.SetEnd(vec(new))
            if t.m_Uuid.AsString()=='9408aa23-ceb1-4952-9519-db4b6f4f9208':b.Remove(t)
    route(b,'PN3V',[(41.05,28.85),new],k.F_Cu)
    route(b,'PN3V',[(38.65,26.25),(40.3,27.9),(41.4,27.9),new],k.In2_Cu,.2)
    via(b,'NFC_OSCOUT',(40.55,28.55));via(b,'NFC_OSCOUT',(43.4,33.6))
    route(b,'NFC_OSCOUT',[(40.55,27.9375),(40.55,28.55)],k.F_Cu)
    route(b,'NFC_OSCOUT',[(40.55,28.55),(40.65,28.65),(40.65,32.25),(41.2,32.8),(43.4,32.8),(43.4,33.6)],k.B_Cu)
    route(b,'NFC_OSCOUT',[(43.4,33.6),(43.1267,33.625)],k.F_Cu)
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones())
    zones={z.GetLayer():z for z in b.Zones() if z.GetNetname()=='GND' and not z.GetIsRuleArea()}
    z=zones[k.F_Cu];poly=z.GetFilledPolysList(k.F_Cu)
    pads=[p for f in fps for p in f.Pads() if p.IsOnLayer(k.F_Cu)]
    current=list(b.GetTracks());chosen=[];skipped=[]
    def free(p):
        if not all(poly.Contains(vec((p[0]+dx,p[1]+dy))) for dx,dy in [(0,0),(.35,0),(-.35,0),(0,.35),(0,-.35)]):return False
        if not zones[k.In1_Cu].HitTestFilledArea(k.In1_Cu,vec(p)):return False
        for pad in pads:
            bb=pad.GetBoundingBox();a=xy(bb.GetOrigin());c=(a[0]+k.ToMM(bb.GetWidth()),a[1]+k.ToMM(bb.GetHeight()))
            if math.hypot(max(a[0]-p[0],0,p[0]-c[0]),max(a[1]-p[1],0,p[1]-c[1]))<.4:return False
        for t in current:
            if isinstance(t,k.PCB_VIA):
                if math.dist(p,xy(t.GetPosition())) < .25+k.ToMM(t.GetWidth(k.F_Cu))/2+.15:return False
            elif t.GetNetname()!='GND':
                if distance(p,xy(t.GetStart()),xy(t.GetEnd()))<.25+k.ToMM(t.GetWidth())/2+.15:return False
        return not any(math.dist(p,c)<.65 for c in chosen)
    for i in range(poly.OutlineCount()):
        o=poly.COutline(i);bb=o.BBox();a=xy(bb.GetOrigin());w,h=k.ToMM(bb.GetWidth()),k.ToMM(bb.GetHeight())
        anchors=[t.GetPosition() for t in current if isinstance(t,k.PCB_VIA) and t.GetNetname()=='GND']
        anchors += [p.GetPosition() for p in pads if p.GetAttribute()==k.PAD_ATTRIB_PTH and p.GetNetname()=='GND']
        if any(o.PointInside(p) for p in anchors):continue
        candidates=[]
        for ix in range(math.ceil(w/.2)):
            for iy in range(math.ceil(h/.2)):
                p=(round(a[0]+.1+ix*.2,4),round(a[1]+.1+iy*.2,4))
                if o.PointInside(vec(p)) and free(p):candidates.append((math.dist(p,(a[0]+w/2,a[1]+h/2)),p))
        if candidates:
            p=min(candidates)[1];via(b,'GND',p);chosen.append(p)
        else:skipped.append(dict(outline=i,bbox=[a,w,h]))
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones());k.SaveBoard(str(path),b)
    (ROOT/'output/final-connection-fixes.json').write_text(json.dumps(dict(ground_vias=chosen,polygons_without_available_site=skipped),indent=2)+'\n')
    print(json.dumps(dict(ground_vias=chosen,skipped=skipped)))
if __name__=='__main__':main()
