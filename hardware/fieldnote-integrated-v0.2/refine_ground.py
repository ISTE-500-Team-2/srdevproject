"""Repair local return paths and keep tiny necks above the fabrication minimum."""
from pathlib import Path
import pcbnew as k
import wx
from finish_ground import route,via
ROOT=Path(__file__).resolve().parent
def main():
    app=wx.App(False);p=ROOT/'fieldnote.kicad_pcb';b=k.LoadBoard(str(p))
    fs=list(b.GetFootprints());fps={f.GetReference():f for f in fs};ts=list(b.GetTracks())
    for t in ts:
        if t.GetNetname() in ['ANT_A','RF1_MATCH']:
            if isinstance(t,k.PCB_VIA):
                x,y=k.ToMM(t.GetPosition().x)-60,k.ToMM(t.GetPosition().y)-50
                if t.GetNetname()=='ANT_A' and abs(x-36)<.001 and abs(y-26.8)<.001:
                    t.SetPosition(k.VECTOR2I(k.FromMM(95.1),k.FromMM(76.4)))
            elif t.GetLayer()==k.B_Cu:
                # Replace only the freshly added antenna-test/match branches.
                a,c=t.GetStart(),t.GetEnd();pa=(k.ToMM(a.x)-60,k.ToMM(a.y)-50);pc=(k.ToMM(c.x)-60,k.ToMM(c.y)-50)
                if t.IsLocked() and t.GetNetname()=='ANT_A':b.Remove(t)
                elif t.IsLocked() and t.GetNetname()=='RF1_MATCH':b.Remove(t)
        if not isinstance(t,k.PCB_VIA) and t.GetNetname()=='USB_DP':
            for setter,getter in [(t.SetStart,t.GetStart),(t.SetEnd,t.GetEnd)]:
                v=getter()
                if (abs(k.ToMM(v.x)-113.35)<.00001 and abs(k.ToMM(v.y)-54.9219)<.00001) or \
                   (abs(k.ToMM(v.x)-113.0752)<.00001 and abs(k.ToMM(v.y)-55.1967)<.00001):
                    setter(k.VECTOR2I(v.x,v.y+k.FromMM(.04)))
    route(b,'ANT_A',[(34.9,22.1),(35.5,22.7),(35.5,26),(35.1,26.4)],.2,k.B_Cu)
    route(b,'ANT_A',[(35.1,26.4),(35.5,26.8),(36,26.8)],.2)
    route(b,'RF1_MATCH',[(34.7,25.5),(33.7,24.5),(33.7,20.9),(34.9,19.7)],.2,k.B_Cu)
    for f in fs:
        if f.GetReference().startswith('U') or f.GetReference() in ['J1','C35']:
            for pad in f.Pads():
                if pad.GetNetname()=='GND':pad.SetLocalZoneConnection(k.ZONE_CONNECTION_FULL)
    # PN532 ground pins join the exposed ground land through top copper.
    for pts in [[(37.8625,22.75),(38.85,22.75),(39.3,23.2),(40.8,25)],
                [(37.8625,23.75),(40.8,23.75)],[(37.8625,25.75),(40.8,25.75)],
                [(38.55,27.9375),(38.55,27.45),(39.1,26.9),(40.8,26.5)],
                [(41.55,27.9375),(41.55,26.5)],[(42.05,27.9375),(42.05,26.5)]]:
        route(b,'GND',pts,.2)
    route(b,'GND',[(41.55,27.9375),(41.55,28.45),(41.8,28.7)],.2);via(b,'GND',(41.8,28.7))
    route(b,'GND',[(57.75,10.2),(57.75,9.8),(58,8.8)],.2)
    route(b,'GND',[(57.75,10.2),(57.75,11.25)],.25);via(b,'GND',(57.75,11.25))
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones());k.SaveBoard(str(p),b)
    assert k.ExportSpecctraDSN(b,str(ROOT/'output/fieldnote-ground.dsn'))
    print('Saved local corrections and exported a ground-plane routing input.')
if __name__=='__main__':main()
