"""Replace generated footprints with native KiCad instances before routing.

Run with the KiCad-bundled Python. Native transforms include embedded antenna
and switch keepouts, which must use board coordinates in a saved PCB.
Never run this over a routed board without preserving the routed revision.
"""
from pathlib import Path
import json
import pcbnew as k

ROOT = Path(__file__).resolve().parent

def main():
    path = ROOT / 'fieldnote.kicad_pcb'
    board = k.LoadBoard(str(path))
    assert not list(board.GetTracks()), 'Rebuild only the generated, unrouted board'
    old_by_ref = {f.GetReference(): f for f in board.GetFootprints()}
    parts = json.loads((ROOT / 'design-data.json').read_text())['parts']
    report = []
    for part in parts:
        old = old_by_ref[part['ref']]
        fp = k.FootprintLoad(str(ROOT / 'Fieldnote.pretty'), part['fp'])
        assert fp is not None, part['ref']
        fp.SetReference(part['ref'])
        fp.SetValue(part['value'])
        fp.SetFPID(old.GetFPID())
        fp.SetUuid(old.m_Uuid)
        fp.SetPath(old.GetPath())
        fp.SetAttributes(old.GetAttributes())
        fp.SetField('MPN', part['mpn'])
        fp.GetField('MPN').SetVisible(False)
        fp.SetOrientationDegrees(part['angle'])
        fp.SetPosition(old.GetPosition())
        nets = {p.GetNumber(): p.GetNetname() for p in old.Pads() if p.GetNumber()}
        for pad in fp.Pads():
            if pad.GetNumber() in nets:
                pad.SetNet(board.FindNet(nets[pad.GetNumber()]))
        # Reference fields are annotated after routing, using the finished CAD.
        fp.Reference().SetTextSize(k.VECTOR2I(k.FromMM(.8), k.FromMM(.8)))
        fp.Reference().SetTextThickness(k.FromMM(.12))
        board.Remove(old)
        board.Add(fp)
        zones = []
        for z in fp.Zones():
            poly = z.Outline()
            points = [[k.ToMM(poly.CVertex(i).x), k.ToMM(poly.CVertex(i).y)]
                      for i in range(poly.TotalVertices())]
            zones.append(points)
        report.append(dict(ref=part['ref'], zones=zones))
    k.SaveBoard(str(path), board)
    (ROOT / 'output/native-footprints.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(dict(footprints_rebuilt=len(parts), board=str(path))))

if __name__ == '__main__':
    main()
