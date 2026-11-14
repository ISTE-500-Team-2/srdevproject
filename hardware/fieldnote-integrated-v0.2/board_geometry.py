"""Export the routed copper geometry for inspectable engineering plots."""
from pathlib import Path
import json
import pcbnew as k
ROOT=Path(__file__).resolve().parent
def xy(v):return [round(k.ToMM(v.x)-60,6),round(k.ToMM(v.y)-50,6)]
def main():
    b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));pads=[]
    fs=list(b.GetFootprints());ts=list(b.GetTracks())
    for f in fs:
        for p in f.Pads():
            if not any(p.IsOnLayer(l) for l in [k.F_Cu,k.In1_Cu,k.In2_Cu,k.B_Cu]):continue
            bb=p.GetBoundingBox()
            pads.append(dict(ref=f.GetReference(),num=p.GetNumber(),net=p.GetNetname(),pos=xy(p.GetPosition()),
                size=[k.ToMM(p.GetSize().x),k.ToMM(p.GetSize().y)],angle=p.GetOrientationDegrees(),
                bounds=[xy(bb.GetPosition()),xy(k.VECTOR2I(bb.GetX()+bb.GetWidth(),bb.GetY()+bb.GetHeight()))],
                layers=[b.GetLayerName(l) for l in [k.F_Cu,k.In1_Cu,k.In2_Cu,k.B_Cu] if p.IsOnLayer(l)]))
    tracks=[]
    for t in ts:
        if isinstance(t,k.PCB_VIA):tracks.append(dict(net=t.GetNetname(),via=xy(t.GetPosition()),width=k.ToMM(t.GetWidth(k.F_Cu)),drill=k.ToMM(t.GetDrillValue())))
        else:tracks.append(dict(net=t.GetNetname(),a=xy(t.GetStart()),b=xy(t.GetEnd()),width=k.ToMM(t.GetWidth()),layer=b.GetLayerName(t.GetLayer()),locked=t.IsLocked()))
    (ROOT/'output/copper-geometry.json').write_text(json.dumps(dict(pads=pads,tracks=tracks),indent=2)+'\n')
    print(len(pads),len(tracks))
if __name__=='__main__':main()
