"""Seed locked USB 2.0 routes on a separate candidate or a requested board.

Default never changes the live board. --apply BOARD explicitly adds just these
four USB nets to BOARD, preserving its other routing and component placement.
Run with the bundled KiCad Python runtime; wx is needed for native zone filling.
"""
from pathlib import Path
import argparse, hashlib, json, math, shutil
import pcbnew as k
import wx

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output/usb-pair-candidate'
NETS = ('USB_DP', 'USB_DM', 'MCU_USB_DP', 'MCU_USB_DM')
def vec(p): return k.VECTOR2I(k.FromMM(p[0] + 60), k.FromMM(p[1] + 50))
def xy(v): return [round(k.ToMM(v.x) - 60, 6), round(k.ToMM(v.y) - 50, 6)]

def offset(points, distance):
    """Exact miter intersections for constant-gap parallel 45-degree tracks."""
    norms = []
    for a, b in zip(points, points[1:]):
        dx, dy = b[0]-a[0], b[1]-a[1]
        length = math.hypot(dx, dy)
        norms.append((-dy/length, dx/length))
    result = []
    for i, p in enumerate(points):
        if i == 0: dx,dy = norms[0]
        elif i == len(points)-1: dx,dy = norms[-1]
        else:
            n0,n1 = norms[i-1],norms[i]
            den = 1 + n0[0]*n1[0] + n0[1]*n1[1]
            dx,dy = (n0[0]+n1[0])/den,(n0[1]+n1[1])/den
        result.append((p[0]+distance*dx,p[1]+distance*dy))
    return result

def seed(b):
    fs = list(b.GetFootprints())
    fps = {f.GetReference(): f for f in fs}
    def pin(ref, number):
        return tuple(xy(next(p for p in fps[ref].Pads() if p.GetNumber()==str(number)).GetPosition()))
    expected = {('J1','A6'):(53.35,4.245),('J1','B6'):(52.35,4.245),
                ('J1','A7'):(52.85,4.245),('J1','B7'):(53.85,4.245),
                ('U5','1'):(51.8625,6.55),('U5','3'):(51.8625,8.45),
                ('U5','4'):(54.1375,8.45),('U5','6'):(54.1375,6.55),
                ('R3','1'):(44.925,29.75),('R3','2'):(46.575,29.75),
                ('R4','1'):(44.925,31.5),('R4','2'):(46.575,31.5),
                ('U1','26'):(48.9,29.9),('U1','27'):(48.9,30.7)}
    for key, position in expected.items():
        assert math.dist(pin(*key),position)<1e-5, (key,pin(*key),position)
    assert next(p for p in fps['U5'].Pads() if p.GetNumber()=='2').GetNetname()=='GND'
    assert next(p for p in fps['U5'].Pads() if p.GetNumber()=='5').GetNetname()=='VBUS'
    old = list(b.GetTracks())
    for t in old:
        if t.GetNetname() in NETS: b.Remove(t)
    made = []
    def route(net, points, width=.23, layer=k.F_Cu):
        for a,c in zip(points,points[1:]):
            if math.dist(a,c)<1e-6: continue
            t=k.PCB_TRACK(b); t.SetStart(vec(a)); t.SetEnd(vec(c))
            t.SetWidth(k.FromMM(width)); t.SetLayer(layer); t.SetNet(b.FindNet(net)); t.SetLocked(True)
            b.Add(t); made.append(t)
    def via(net, point):
        v=k.PCB_VIA(b);v.SetPosition(vec(point));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2))
        v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu)
        v.SetNet(b.FindNet(net));v.SetLocked(True)
        v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED)
        b.Add(v);made.append(v)
    # Interleaved Type-C duplicate pads: bridge D+ briefly on the back.
    for number,x,y in [('B6',52.35,5.8),('A6',53.35,5.4)]:
        route('USB_DP',[pin('J1',number),(x,y)],.15);via('USB_DP',(x,y))
    route('USB_DP',[(52.35,5.8),(52.75,5.4),(53.35,5.4),(55.35,7.4),(55.35,8.45)],.15,k.B_Cu)
    via('USB_DP',(55.35,8.45));route('USB_DP',[(55.35,8.45),pin('U5',4)],.15)
    for number,x in [('A7',52.85),('B7',53.85)]:
        route('USB_DM',[pin('J1',number),(x,6.0)],.15)
    route('USB_DM',[(52.85,6.0),(53.85,6.0),(54.1375,6.2875),pin('U5',6)],.15)
    # Board copper joins both same-line ESD pads, with connector input on the
    # right and outgoing line on the left: no ESD branch stubs.
    route('USB_DM',[pin('U5',6),pin('U5',1)],.15)
    route('USB_DP',[pin('U5',4),pin('U5',3)],.15)
    route('USB_DM',[pin('U5',1),(50.85,6.55),(50.85,8.9),(52.1,10.15),(52.1,10.4)])
    route('USB_DP',[pin('U5',3),(51.23,8.45),(51.23,8.58),(52.48,9.83),(52.48,10.4)])
    route('USB_DM',[(52.1,10.4),(52.1,15.9)])
    route('USB_DM',[(52.1,15.9),(51.8,16.2),(51.8,17.25),(52.0,17.45),(52.0,17.75)],.15)
    route('USB_DP',[(52.48,10.4),(52.48,16.6),(52.3,16.78),(52.3,16.8)],.15)
    via('USB_DM',(52.0,17.75));via('USB_DP',(52.3,16.8))
    # Matched ordinary transitions bypass R26 and the locked C6 GND fanout.
    # B.Cu references the ground In2.Cu plane; In1.Cu has no signal tracks.
    lower=[(52.29,18.3),(52.29,22.6),(50.9,23.99),(49.5,23.99)]
    ld,lp=offset(lower,.19),offset(lower,-.19)
    route('USB_DM',[(52.0,17.75),(52.1,17.85),ld[0]],.15,k.B_Cu)
    route('USB_DP',[(52.3,16.8),(52.48,16.98),lp[0]],.15,k.B_Cu)
    route('USB_DM',ld,.23,k.B_Cu);route('USB_DP',lp,.23,k.B_Cu)
    route('USB_DM',[ld[-1],(49.5,23.1),(48.15,23.1),(48.15,23.9)],.15,k.B_Cu)
    route('USB_DP',[lp[-1],(49.2,24.18),(48.85,23.83),(48.85,23.9)],.15,k.B_Cu)
    via('USB_DM',(48.15,23.9));via('USB_DP',(48.85,23.9))
    route('USB_DM',[(48.15,23.9),(48.2,23.95),(48.2,24.5),(48.295,24.595),(48.295,25.0)],.15)
    route('USB_DP',[(48.85,23.9),(48.8,23.95),(48.8,24.6),(48.675,24.725),(48.675,25.0)],.15)
    center=[(48.485,25.0),(48.485,27.0),(47.0,28.485),(45.8,28.485)]
    dm,dp = offset(center,.19),offset(center,-.19)
    route('USB_DM',dm);route('USB_DP',dp)
    route('USB_DM',[dm[-1],(45.2,28.295),(44.925,28.57),pin('R3',1)])
    route('USB_DP',[dp[-1],(45.8,30.5),(44.925,31.375),pin('R4',1)])
    # Short resistor-to-module sections; terminate at native transformed pads.
    route('MCU_USB_DM',[pin('R3',2),(47.55,29.75),(47.70,29.9),pin('U1',26)],.23)
    route('MCU_USB_DP',[pin('R4',2),(46.9,31.5),(47.7,30.7),pin('U1',27)],.23)
    # Ground vias at each connector crossover transition share both GND planes.
    # These are outside every SMT solder land and have no via-in-pad requirement.
    for point in [(51.5,5.5),(54.5,5.5),(55.35,9.2),(54.5,9.2),
                  (53.7,17.3),(51.5,18.65),(47.5,23.7),(48.6,22.6)]:
        existing = any(isinstance(t,k.PCB_VIA) and t.GetNetname()=='GND' and math.dist(xy(t.GetPosition()),point)<1e-5 for t in b.GetTracks())
        if not existing: via('GND',point)
    # Preserve the B.Cu reference by forbidding future In2.Cu signal tracks
    # beneath it. Ground fills and ordinary through-vias remain permitted.
    areas={'USB In2 reference - connector':[(51.9,5.1),(55.8,5.1),(55.8,8.9),(51.9,8.9)],
           'USB In2 reference - power bypass':[(47.5,16.2),(53.1,16.2),(53.1,24.6),(47.5,24.6)]}
    for z in list(b.Zones()):
        if z.GetZoneName() in areas:b.Remove(z)
    for name,points in areas.items():
        z=k.ZONE(b);z.SetLayer(k.In2_Cu);z.SetIsRuleArea(True);z.SetZoneName(name)
        z.SetDoNotAllowTracks(True);z.SetDoNotAllowVias(False);z.SetDoNotAllowPads(False)
        z.SetDoNotAllowFootprints(False);z.SetDoNotAllowZoneFills(False)
        outline=z.Outline();outline.NewOutline()
        for p in points:outline.Append(vec(p))
        b.Add(z)
    return made, expected

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',type=Path)
    args=parser.parse_args();app=wx.App(False)
    OUT.mkdir(parents=True,exist_ok=True)
    if args.apply:
        target=args.apply.resolve()
    else:
        target=OUT/'fieldnote.kicad_pcb'
        for pattern in ['*.kicad_sch','fieldnote.kicad_pro','Fieldnote.kicad_sym','sym-lib-table','fp-lib-table']:
            for source in ROOT.glob(pattern):shutil.copyfile(source,OUT/source.name)
        shutil.copytree(ROOT/'Fieldnote.pretty',OUT/'Fieldnote.pretty',dirs_exist_ok=True)
        shutil.copyfile(ROOT/'fieldnote.kicad_pcb',target)
    b=k.LoadBoard(str(target));made,expected=seed(b)
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones())
    k.SaveBoard(str(target),b)
    tracks=[]
    for t in made:
        d={'net':t.GetNetname(),'width':k.ToMM(t.GetWidth(k.F_Cu) if isinstance(t,k.PCB_VIA) else t.GetWidth()),'locked':t.IsLocked()}
        if isinstance(t,k.PCB_VIA):d.update(via=xy(t.GetPosition()),drill=k.ToMM(t.GetDrillValue()),layers=['F.Cu','B.Cu'])
        else:d.update(a=xy(t.GetStart()),b=xy(t.GetEnd()),layer=b.GetLayerName(t.GetLayer()))
        tracks.append(d)
    report={'board':str(target),'four_usb_nets':list(NETS),'tracks':tracks,
            'expected_pads':{f'{r}:{n}':list(p) for (r,n),p in expected.items()},
            'source_live_sha256':hashlib.sha256((ROOT/'fieldnote.kicad_pcb').read_bytes()).hexdigest(),
            'trace_width_mm':.23,'pair_center_spacing_mm':.38,'main_pair_gap_mm':.15,
            'narrow_escape_width_mm':.15,'ordinary_via_diameter_mm':.5,'ordinary_via_drill_mm':.2,
            'reference':'F.Cu over GND In1.Cu; connector crossover and paired power-fanout bypass B.Cu over GND In2.Cu',
            'no_signal_tracks_on_In1_Cu':not any(not isinstance(t,k.PCB_VIA) and t.GetLayer()==k.In1_Cu for t in b.GetTracks())}
    (OUT/'usb-routes.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'board':str(target),'seed_tracks_and_vias':len(made),'report':str(OUT/'usb-routes.json')}))
if __name__=='__main__':main()
