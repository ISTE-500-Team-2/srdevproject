"""Apply documented exact-part land patterns without regenerating routing."""
from pathlib import Path
import json
import pcbnew as k
import wx
ROOT=Path(__file__).resolve().parent
def patch(f,proposal):
    position=f.GetPosition();angle=f.GetOrientationDegrees()
    f.SetOrientationDegrees(0);f.SetPosition(k.VECTOR2I(0,0))
    ps=list(f.Pads())
    if 'pads' in proposal:
        bynum={p.GetNumber():p for p in ps}
        for c in proposal['pads']:
            p=bynum[c['number']];p.SetPosition(k.VECTOR2I(*[k.FromMM(v) for v in c['at_mm']]))
            p.SetSize(k.VECTOR2I(*[k.FromMM(v) for v in c['size_mm']]))
    else:
        c=proposal['replace'];select=proposal['select_pads']
        for p in ps:
            if p.GetNumber()==select['number'] and abs(k.ToMM(p.GetPosition().y)-select['local_y_mm'])<1e-4:
                p.SetSize(k.VECTOR2I(*[k.FromMM(v) for v in c['size_mm']]))
                p.SetDrillSize(k.VECTOR2I(*[k.FromMM(v) for v in c['drill_mm']]))
    f.SetPosition(position);f.SetOrientationDegrees(angle)
def main():
    app=wx.App(False);path=ROOT/'fieldnote.kicad_pcb';b=k.LoadBoard(str(path))
    fs=list(b.GetFootprints());fps={f.GetReference():f for f in fs}
    d=json.loads((ROOT/'manufacturing/audit-footprint-corrections.json').read_text())
    for c in d['proposals']:
        lib=k.FootprintLoad(str(ROOT/'Fieldnote.pretty'),c['footprint']);assert lib
        patch(lib,c);k.FootprintSave(str(ROOT/'Fieldnote.pretty'),lib)
        for ref in c['references']:patch(fps[ref],c)
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones());k.SaveBoard(str(path),b)
    (ROOT/'output/applied-footprint-corrections.json').write_text(json.dumps(dict(status='APPLIED_REQUIRES_FINAL_NATIVE_DRC',proposals=d['proposals']),indent=2)+'\n')
    print('Applied four documented manufacturer-pattern corrections to native CAD and local libraries.')
if __name__=='__main__':main()
