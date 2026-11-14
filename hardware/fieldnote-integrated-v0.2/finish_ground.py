"""Finish native ground pours and the already-printed antenna return.

Apply once to the saved first routing pass. Keep the original in snapshots.
"""
from pathlib import Path
import shutil,json
import pcbnew as k
import wx
ROOT=Path(__file__).resolve().parent

def vec(xy):return k.VECTOR2I(k.FromMM(xy[0]+60),k.FromMM(xy[1]+50))
def route(b,net,pts,w=.2,layer=k.F_Cu):
    for a,c in zip(pts,pts[1:]):
        t=k.PCB_TRACK(b);t.SetStart(vec(a));t.SetEnd(vec(c));t.SetWidth(k.FromMM(w));t.SetLayer(layer)
        t.SetNet(b.FindNet(net));t.SetLocked(True);b.Add(t)
def via(b,net,xy):
    v=k.PCB_VIA(b);v.SetPosition(vec(xy));v.SetWidth(k.FromMM(.6));v.SetDrill(k.FromMM(.3))
    v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet(net));v.SetLocked(True);b.Add(v)
def polygon(z,pts):
    o=z.Outline();o.NewOutline()
    for pt in pts:o.Append(vec(pt))
def keepout(b,name,pts,tracks):
    z=k.ZONE(b);z.SetLayer(k.B_Cu);z.SetIsRuleArea(True);z.SetZoneName(name)
    z.SetDoNotAllowTracks(tracks);z.SetDoNotAllowVias(tracks);z.SetDoNotAllowPads(False)
    z.SetDoNotAllowFootprints(False);z.SetDoNotAllowZoneFills(True);polygon(z,pts);b.Add(z)
def main():
    app=wx.App(False)
    path=ROOT/'fieldnote.kicad_pcb'
    snap=ROOT/'output/routing-snapshots';snap.mkdir(exist_ok=True)
    if (snap/'first-route.kicad_pcb').exists():
        assert path.read_bytes()==(snap/'first-route.kicad_pcb').read_bytes(), 'Restore snapshot explicitly for a rerun'
    else:shutil.copyfile(path,snap/'first-route.kicad_pcb')
    b=k.LoadBoard(str(path));removed=0;widened=0
    fps={f.GetReference():f for f in b.GetFootprints()}
    tracks=list(b.GetTracks())  # Keep detached SWIG proxies alive through save.
    for t in tracks:
        if t.GetNetname()=='GND' and not t.IsLocked():b.Remove(t);removed+=1
        elif not isinstance(t,k.PCB_VIA) and t.GetWidth()<k.FromMM(.15):t.SetWidth(k.FromMM(.15));widened+=1
        # Move the antenna test-pad branch off the top matching-network path.
        elif not isinstance(t,k.PCB_VIA) and t.GetNetname()=='ANT_A' and t.GetLayer()==k.F_Cu:
            a,c=t.GetStart(),t.GetEnd()
            if max(a.x,c.x)>=k.FromMM(95):b.Remove(t)
    ant=fps['ANT1']
    for g in list(ant.GraphicalItems()):
        if g.GetLayer()==k.B_Cu:ant.Remove(g)
    # Explicit track equals the footprint's old copper graphic: no change to
    # physical antenna copper. Native DRC now sees the two pin-2 lands joined.
    route(b,'ANT_B',[(29.8,28.8),(33.9,26.2)],.8,k.B_Cu)
    for z in b.Zones():
        if z.GetZoneName()=='NFC copper-free region':
            ls=k.LSET()
            for layer in [k.F_Cu,k.In1_Cu,k.In2_Cu]:ls.AddLayer(layer)
            z.SetLayerSet(ls)
    keepout(b,'NFC back-side pour exclusion',[(1.5,10.7),(33.1,10.7),(33.1,45.2),(1.5,45.2)],False)
    keepout(b,'NFC back-side track exclusion',[(1.5,10.7),(33.1,10.7),(33.1,25.95),
        (29.2,28.35),(29.2,29.4),(30.4,29.4),(33.1,27.7),(33.1,45.2),(1.5,45.2)],True)
    via(b,'ANT_A',(34.9,22.1));route(b,'ANT_A',[(34,22.8375),(34.9,22.1)],.2)
    via(b,'ANT_A',(36,26.8));route(b,'ANT_A',[(34.9,22.1),(36.5,23.7),(36.5,26.3),(36,26.8)],.2,k.B_Cu)
    # Connect the isolated matching-resistor land without crossing ANT_A.
    via(b,'RF1_MATCH',(34.7,25.5));route(b,'RF1_MATCH',[(34,24.6625),(34.7,25.3625),(34.7,25.5)],.15)
    via(b,'RF1_MATCH',(34.9,19.7));route(b,'RF1_MATCH',[(34,19.725),(34.875,19.725),(34.9,19.7)],.15)
    route(b,'RF1_MATCH',[(34.7,25.5),(34.7,19.9),(34.9,19.7)],.2,k.B_Cu)
    outline=json.loads((ROOT/'design-data.json').read_text())['outline']
    for layer in [k.F_Cu,k.In1_Cu,k.In2_Cu,k.B_Cu]:
        z=k.ZONE(b);z.SetLayer(layer);z.SetNet(b.FindNet('GND'));z.SetZoneName('GND '+b.GetLayerName(layer))
        z.SetLocalClearance(k.FromMM(.2));z.SetMinThickness(k.FromMM(.15))
        z.SetPadConnection(k.ZONE_CONNECTION_THERMAL);z.SetThermalReliefGap(k.FromMM(.2))
        z.SetThermalReliefSpokeWidth(k.FromMM(.2));polygon(z,outline);b.Add(z)
    b.BuildConnectivity();filler=k.ZONE_FILLER(b);assert filler.Fill(b.Zones())
    k.SaveBoard(str(path),b)
    print(json.dumps(dict(ground_tracks_removed=removed,tracks_widened=widened,zones=len(list(b.Zones())))))
if __name__=='__main__':main()
