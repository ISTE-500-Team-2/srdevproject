"""Native KiCad seed routes. Critical switching loops remain locked.

Coordinates use the mechanical board origin (60,50 in the KiCad canvas).
Remaining routes and filled zones are validated by KiCad, not by this script.
"""
from pathlib import Path
import json
import pcbnew as k

ROOT = Path(__file__).resolve().parent
def vec(xy): return k.VECTOR2I(k.FromMM(xy[0]+60),k.FromMM(xy[1]+50))
def main():
    b = k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'))
    assert not list(b.GetTracks()), 'Seed only a fresh normalized board'
    fps = {f.GetReference():f for f in b.GetFootprints()}
    def pin(ref,num):
        p=next(p for p in fps[ref].Pads() if p.GetNumber()==str(num))
        v=p.GetPosition();return (k.ToMM(v.x)-60,k.ToMM(v.y)-50)
    def route(net,points,width=.2,layer=k.F_Cu):
        for a,c in zip(points,points[1:]):
            t=k.PCB_TRACK(b);t.SetStart(vec(a));t.SetEnd(vec(c));t.SetWidth(k.FromMM(width))
            t.SetLayer(layer);t.SetNet(b.FindNet(net));t.SetLocked(True);b.Add(t)
    def via(net,xy):
        v=k.PCB_VIA(b);v.SetPosition(vec(xy));v.SetWidth(k.FromMM(.6));v.SetDrill(k.FromMM(.3))
        v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu)
        v.SetNet(b.FindNet(net));v.SetLocked(True);b.Add(v)
    # Short top-copper switch loops, tapering from 0.25 mm at IC lands.
    for net,pad,fan,target in [('SW_L1',4,(55.05,23.5),(54.58,23.97)),
                               ('SW_L2',2,(55.05,22.5),(53.98,21.43))]:
        route(net,[pin('U4',pad),fan],.25)
        route(net,[fan,target,pin('L3',1 if pad==4 else 2)],.5)
    route('3V3',[pin('U4',1),(55.65,20.7),pin('C6',1)],.35)
    route('3V3',[pin('U4',10),(57.95,20.7),(56.75,19.5),pin('C6',1)],.15)
    route('VSYS',[pin('U4',5),(55.65,25.7),pin('C4',1)],.35)
    route('VSYS',[pin('U4',7),pin('U4',8),(58.4,23),(58.65,22.75),(58.65,21.075),pin('C5',1)],.25)
    # Ground ties/return vias are outside the exposed solder lands.
    route('GND',[pin('U4',3),pin('U4',11)],.25)
    route('GND',[pin('U4',9),(57.55,22.5),(57.3,22.25),(56.8,22.25),pin('U4',11)],.25)
    route('GND',[pin('U4',11),(56.8,21.2)],.5);via('GND',(56.8,21.2))
    for ref,xy in [('C4',(53.55,27)),('C6',(52.55,18.4)),('C5',(61.8,20.5)),('C7',(61.1,22.05))]:
        route('GND',[pin(ref,2),xy],.4);via('GND',xy)
    # Separate backside input connection leaves the switch loop on top.
    route('VSYS',[pin('C4',1),(55.45,27)],.5);via('VSYS',(55.45,27))
    route('VSYS',[pin('C5',1),(59.225,19.5)],.4);via('VSYS',(59.225,19.5))
    route('VSYS',[(55.45,27),(55.45,24.8),(59.225,21.025),(59.225,19.5)],.6,k.B_Cu)
    # Antenna feed passes only through the explicit notch in the keepout.
    route('ANT_A',[pin('R22',2),(33.36,22.838),pin('ANT1',1)],.35)
    route('ANT_B',[pin('R23',2),(33.9,27.0875),(33.9,26.2)],.35)
    route('ANT_A',[pin('R22',2),(35.0,23.8375),(35.0,25.8),pin('TP11',1)],.2)
    route('ANT_B',[pin('R23',2),(35.0,27.1875),pin('TP12',1)],.2)
    # Crystal routing is checked separately after remaining signal routing.
    k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b)
    assert k.ExportSpecctraDSN(b,str(ROOT/'output/fieldnote-seed.dsn'))
    print(json.dumps(dict(locked_tracks=len(list(b.GetTracks())),dsn='output/fieldnote-seed.dsn')))
if __name__=='__main__':main()
