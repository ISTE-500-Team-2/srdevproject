"""Reserve short PN532 analog and fine-pitch escape paths before routing.

0.5/0.2 mm ordinary through-vias retain 0.15 mm annular rings and meet
PCBWay's published standard minimum drill; no blind/buried/microvias.
"""
from pathlib import Path
import json
import pcbnew as k
import wx
from finish_ground import route,vec
ROOT=Path(__file__).resolve().parent
def via(b,net,xy):
    v=k.PCB_VIA(b);v.SetPosition(vec(xy));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2))
    v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet(net));v.SetLocked(True)
    v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(v)
def main():
    app=wx.App(False);b=k.LoadBoard(str(ROOT/'output/routing-snapshots/resume-route.kicad_pcb'))
    fs=list(b.GetFootprints());fps={f.GetReference():f for f in fs};ts=list(b.GetTracks())
    for t in ts:
        if not t.IsLocked():b.Remove(t)
    moves={'C14':([47.45,21.5],90),'C15':([47.5,25.7],90),'C16':([35.95,24.65],90),
        'C17':([41,30.25],270),'C20':([41.5,20],0),'R19':([38.98,19.35],90),
        'C13':([49,18.2],90),'C19':([49.5,25.75],90),'R26':([52,17.75],0),
        'TP1':([52,26.9],0),'TP2':([43.25,18.5],0),'TP3':([49.1,21.3],0)}
    for ref,(pos,angle) in moves.items():
        fps[ref].SetOrientationDegrees(angle);fps[ref].SetPosition(vec(pos))
    # Local power fanout and decoupling paths.
    for net,pos in [('PN3V',(38.25,21.05)),('PN3V',(36.6,24.75)),('PN3V',(37.1,26.25)),
        ('PN3V',(41.05,28.65)),('PN3V',(46.7,22.45)),('PN3V',(46.7,26.475))]:via(b,net,pos)
    route(b,'PN3V',[(39.05,22.0625),(39.05,21.5),(38.6,21.05),(38.25,21.05)],.15)
    route(b,'PN3V',[(37.8625,24.75),(36.6,24.75),(36.4,24.95),(36.4,25.6),(35.95,25.6)],.15)
    route(b,'PN3V',[(37.8625,26.25),(37.1,26.25)],.15)
    route(b,'PN3V',[(41.05,27.9375),(41.05,29.425),(41,29.475)],.15)
    route(b,'PN3V',[(47.45,22.45),(46.7,22.45)],.2)
    route(b,'PN3V',[(47.5,26.475),(46.7,26.475)],.2)
    # Short RF transmitter paths stay reserved; In1.Cu is their return plane.
    for net,positions in [('NFC_TX1',[(37.15,24.25),(37.39,19.9)]),('NFC_TX2',[(37.15,25.25),(37.39,30.85)])]:
        for pos in positions:via(b,net,pos)
    route(b,'NFC_TX1',[(37.8625,24.25),(37.15,24.25)],.15)
    route(b,'NFC_TX1',[(37.39,19.9),(37.39,20.5)],.15)
    route(b,'NFC_TX1',[(37.15,24.25),(36,23.1),(36,21.5),(37.39,20.11),(37.39,19.9)],.15,k.B_Cu)
    route(b,'NFC_TX2',[(37.8625,25.25),(37.15,25.25)],.15)
    route(b,'NFC_TX2',[(37.39,30.25),(37.39,30.85)],.15)
    route(b,'NFC_TX2',[(37.15,25.25),(38,26.1),(38,30.24),(37.39,30.85)],.15,k.B_Cu)
    # Receiver and reference bias use independent short escapes.
    via(b,'NFC_VMID',(37,26.95));route(b,'NFC_VMID',[(37.8625,26.75),(37.2,26.75),(37,26.95)],.15)
    via(b,'NFC_RX',(37.1,27.8));route(b,'NFC_RX',[(37.8625,27.25),(37.65,27.25),(37.1,27.8)],.15)
    via(b,'NFC_RESET_N',(39.35,20.95));route(b,'NFC_RESET_N',[(39.55,22.0625),(39.55,21.5),(39.35,21.3),(39.35,20.95)],.15)
    route(b,'NFC_SVDD',[(40.05,22.0625),(40.05,21.2),(40.725,20.525),(40.725,20)],.15)
    # Right-side signals fan out to staggered conventional through vias.
    for net,pos,pts in [
        ('NFC_SDA',(44.8,23.25),[(43.7375,23.75),(44.3,23.75),(44.8,23.25)]),
        ('NFC_SCL',(45.3,24.25),[(43.7375,24.25),(45.3,24.25)]),
        ('NFC_RSTOUT',(45.8,24.75),[(43.7375,24.75),(45.8,24.75)]),
        ('NFC_IRQ',(44.8,25.75),[(43.7375,25.25),(44.3,25.25),(44.8,25.75)]),
        ('3V3',(45.3,27.25),[(43.7375,26.25),(44.3,26.25),(45.3,27.25)])]:
        via(b,net,pos);route(b,net,pts,.15)
    # Move two measurement/matching branches clear of the local TX decoupler.
    old=list(b.GetTracks())
    for t in old:
        if t.GetNetname()=='ANT_A' and t.IsLocked():
            if isinstance(t,k.PCB_VIA) and t.GetPosition()==vec((35.1,26.4)):b.Remove(t)
            elif not isinstance(t,k.PCB_VIA):
                if t.GetLayer()==k.B_Cu and (t.GetStart()==vec((35.5,26)) or t.GetEnd()==vec((35.1,26.4))):b.Remove(t)
                if t.GetLayer()==k.F_Cu and (t.GetStart()==vec((35.1,26.4)) or t.GetStart()==vec((35.5,26.8))):b.Remove(t)
        if t.GetNetname()=='RF1_MATCH' and t.IsLocked():
            if isinstance(t,k.PCB_VIA) and t.GetPosition()==vec((34.7,25.5)):b.Remove(t)
            elif not isinstance(t,k.PCB_VIA):
                if t.GetLayer()==k.F_Cu and max(t.GetStart().y,t.GetEnd().y)>k.FromMM(74):b.Remove(t)
                if t.GetLayer()==k.B_Cu and t.GetStart()==vec((34.7,25.5)):b.Remove(t)
    via(b,'ANT_A',(35.35,26.6));route(b,'ANT_A',[(35.5,26),(35.35,26.6)],.2,k.B_Cu)
    route(b,'ANT_A',[(35.35,26.6),(35.55,26.8),(36,26.8)],.2)
    via(b,'RF1_MATCH',(34.4,25.2));route(b,'RF1_MATCH',[(34,24.6625),(34.4,25.0625),(34.4,25.2)],.15)
    route(b,'RF1_MATCH',[(34.4,25.2),(33.7,24.5)],.2,k.B_Cu)
    # Preserve the output-cap ground stub while clearing the RC-delay resistor.
    for t in ts:
        if t.GetNetname()=='GND':
            if isinstance(t,k.PCB_VIA) and t.GetPosition()==vec((52.55,18.4)):t.SetPosition(vec((51.5,19.5)))
            elif not isinstance(t,k.PCB_VIA):
                if t.GetStart()==vec((52.55,19.5)) and t.GetEnd()==vec((52.55,18.4)):
                    t.SetEnd(vec((51.5,19.5)))
    for p in fps['TP8'].Pads():p.SetLocalZoneConnection(k.ZONE_CONNECTION_FULL)
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones());k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b)
    (ROOT/'output/final-fanout-placement.json').write_text(json.dumps(moves,indent=2)+'\n')
    print('Saved reserved fine-pitch and analog routes. Native DRC must pass before routing.')
if __name__=='__main__':main()
