"""Synchronize native part fields/population without touching routed geometry."""
from pathlib import Path
import argparse, hashlib, json
import pcbnew as k
import wx
from apply_silkscreen_cleanup import immutable

ROOT = Path(__file__).resolve().parent

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--board', type=Path, default=ROOT/'fieldnote.kicad_pcb')
    args = ap.parse_args()
    app = wx.App(False)
    board = k.LoadBoard(str(args.board))
    before = immutable(board)
    source_sha = hashlib.sha256(args.board.read_bytes()).hexdigest()
    parts = {p['ref']:p for p in json.loads((ROOT/'design-data.json').read_text())['parts']}
    footprints = list(board.GetFootprints())
    assert set(parts) == {f.GetReference() for f in footprints}
    changed = []
    for fp in footprints:
        part = parts[fp.GetReference()]
        old = (fp.GetValue(), fp.GetField('MPN').GetText(), bool(fp.GetAttributes() & k.FP_DNP))
        fp.SetValue(part['value'])
        fp.SetField('MPN', part['mpn'])
        fp.GetField('MPN').SetVisible(False)
        attrs = fp.GetAttributes()
        fp.SetAttributes((attrs | k.FP_DNP) if part['dnp'] else (attrs & ~k.FP_DNP))
        new = (fp.GetValue(), fp.GetField('MPN').GetText(), bool(fp.GetAttributes() & k.FP_DNP))
        if old != new: changed.append({'ref':fp.GetReference(), 'before':old, 'after':new})
    assert immutable(board) == before, 'Routed geometry changed'
    k.SaveBoard(str(args.board), board)
    report = {'source_sha256':source_sha, 'board_sha256':hashlib.sha256(args.board.read_bytes()).hexdigest(),
              'design_data_sha256':hashlib.sha256((ROOT/'design-data.json').read_bytes()).hexdigest(),
              'changed':changed, 'routed_geometry_preserved':True}
    (ROOT/'output/component-selection-sync.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))

if __name__ == '__main__': main()
