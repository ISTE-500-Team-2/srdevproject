"""Complete fine-pitch PN532 fanout with manufacturable through vias."""
from pathlib import Path
import json
import pcbnew as k
import wx
from finish_ground import route,via,vec
ROOT=Path(__file__).resolve().parent
def xy(v):return (round(k.ToMM(v.x)-60,5),round(k.ToMM(v.y)-50,5))
def main():
    app=wx.App(False);path=ROOT/'fieldnote.kicad_pcb'
    b=k.LoadBoard(str(ROOT/'output/routing-snapshots/resume-route.kicad_pcb'))
    fs=list(b.GetFootprints());fps={f.GetReference():f for f in fs};ts=list(b.GetTracks())
    for t in ts:
        if not isinstance(t,k.PCB_VIA) and t.GetNetname()=='PN3V' and t.GetLayer()==k.F_Cu:
            a,c=xy(t.GetStart()),xy(t.GetEnd())
            if min(a[0],c[0])>44 and min(a[1],c[1])>=22.9 and max(a[1],c[1])<=25.6:b.Remove(t)
        if t.GetNetname()=='NFC_RSTOUT':
            if isinstance(t,k.PCB_VIA) and xy(t.GetPosition())==(44.85,24.5):t.SetPosition(vec((45.7,24.5)))
            elif not isinstance(t,k.PCB_VIA):
                for setter,getter in [(t.SetStart,t.GetStart),(t.SetEnd,t.GetEnd)]:
                    if xy(getter())==(44.85,24.5):setter(vec((45.7,24.5)))
    for ref in ['C14','C15']:fps[ref].SetPosition(vec((46.25,23 if ref=='C14' else 25.5)))
    # Seed each power/signal escape before the final adaptive routing pass.
    via(b,'PN3V',(38.25,21.05));route(b,'PN3V',[(39.05,22.0625),(39.05,21.6),(38.8,21.35),(38.55,21.35),(38.25,21.05)],.15)
    via(b,'PN3V',(37.1,26.25));route(b,'PN3V',[(37.8625,26.25),(37.1,26.25)],.15)
    route(b,'PN3V',[(41.05,27.9375),(41.05,28.65),(41.7,29.3),(41.7,30.8),(41.475,31.025),(41,31.025)],.15)
    via(b,'PN3V',(47.65,23));route(b,'PN3V',[(46.75,23),(47.65,23)],.2)
    via(b,'PN3V',(47.5,25.5));route(b,'PN3V',[(46.675,25.5),(47.5,25.5)],.2)
    via(b,'NFC_SDA',(44.75,22.85));route(b,'NFC_SDA',[(43.7375,23.75),(44.6,23.75),(44.8,23.55),(44.8,22.9),(44.75,22.85)],.15)
    via(b,'NFC_SCL',(44.8,24));route(b,'NFC_SCL',[(43.7375,24.25),(44.55,24.25),(44.8,24)],.15)
    via(b,'NFC_IRQ',(44.8,25.25));route(b,'NFC_IRQ',[(43.7375,25.25),(44.8,25.25)],.15)
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones());k.SaveBoard(str(path),b)
    placement=json.loads((ROOT/'placement-lock.json').read_text())
    print(type(placement).__name__)
    (ROOT/'output/pn-fanout-placement.json').write_text(json.dumps({ref:[46.25,23 if ref=='C14' else 25.5] for ref in ['C14','C15']},indent=2)+'\n')
    print('Saved PN532 fanout candidate; native DRC is required before completion.')
if __name__=='__main__':main()
