#!/usr/bin/env python3
"""Fieldnote interface board v0.1 - first-pass PLACEMENT ONLY (not routed).

Coordinates are the reader's (Fieldnote v0.5) board coordinates, viewed from above through the stack, so the
interface board drops straight under the reader. Outline: x 34.0-74.0, y 1.0-37.5 mm, i.e. behind the
reader's electronics half and right-edge strip, clear of the NFC coil (x < 33.1) and the Wi-Fi antenna (y > 38.7).
J2 socket and low-profile parts are on the TOP side (facing the reader, ~6 mm gap). Tall/power parts, the tamper
switch, SWD pads and the RS-485 termination jumper are on the BOTTOM side (facing the wall). Run with KiCad's python.
"""
from pathlib import Path
import json, uuid
import wx
import pcbnew as k
import build_design as g

ROOT = Path(__file__).resolve().parent
OFF = (60.0, 50.0)                      # same file offset convention as the reader
OUTLINE = [(34.0, 1.0), (74.0, 1.0), (74.0, 37.5), (34.0, 37.5)]
J2_CENTER, J2_ANGLE = (70.435, 22.46), 180   # socket contacts under reader J6 pins (pin1 at 69.8, 25.0)
MARGIN = 0.6
# (name, side, refs, [rects]) - rects are filled in order; side 'F' faces the reader (low-profile only, gap ~6 mm),
# side 'B' faces the wall (tall/power parts, tamper switch against the back plate, SWD pads, RS-485 termination jumper).
REGIONS = [
    ('field power', 'B', ['U1', 'L1', 'C1', 'C5', 'C6', 'D1', 'D2', 'F1', 'C2', 'C3', 'C4', 'R1', 'R2', 'R3', 'R4', 'R5'], [(34.6, 1.6, 57.0, 22.0)]),
    ('buzzer', 'B', ['BZ1'], [(58.5, 1.6, 73.0, 15.5)]),
    ('wall side', 'B', ['J3', 'SW1', 'JP1'], [(58.5, 16.5, 66.4, 30.0), (34.6, 22.5, 57.0, 30.0)]),
    ('field connector', 'B', ['J1'], [(46.0, 30.6, 73.2, 37.4)]),
    ('coprocessor', 'F', ['U2', 'C8', 'C9', 'C10', 'R6'], [(45.0, 1.6, 57.5, 12.0)]),  # clear of U1 thermal vias
    ('rs485', 'F', ['U4', 'D3', 'C12', 'R8', 'R9', 'C7', 'R18', 'R19'], [(34.6, 12.6, 57.5, 21.0)]),
    ('panel io', 'F', ['Q1', 'Q2', 'Q3', 'D4', 'D5', 'D6', 'D7', 'D8', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R17'],
     [(34.6, 21.6, 57.5, 37.0), (58.5, 27.5, 73.0, 37.0)]),
]


# J1 side-entry: rotated so the cable opening faces the board edge (y = 37.5), not the board interior.
ANGLE = {'J1': 180}
SIDE = {ref: side for _, side, refs, _r in REGIONS for ref in refs}


def vec(p): return k.VECTOR2I(round((p[0] + OFF[0]) * 1e6), round((p[1] + OFF[1]) * 1e6))
def mm(v): return (k.ToMM(v.x) - OFF[0], k.ToMM(v.y) - OFF[1])


def bbox(f):
    lay = k.B_CrtYd if f.GetLayer() == k.B_Cu else k.F_CrtYd
    boxes = [i.GetBoundingBox() for i in f.GraphicalItems() if i.GetLayer() == lay] or [p.GetBoundingBox() for p in f.Pads()]
    xs = [k.ToMM(bb.GetX()) for bb in boxes] + [k.ToMM(bb.GetX() + bb.GetWidth()) for bb in boxes]
    ys = [k.ToMM(bb.GetY()) for bb in boxes] + [k.ToMM(bb.GetY() + bb.GetHeight()) for bb in boxes]
    return min(xs) - OFF[0], min(ys) - OFF[1], max(xs) - OFF[0], max(ys) - OFF[1]


def main():
    app = wx.App(False)
    d = json.loads((ROOT / 'design-data.json').read_text()); parts = {p['ref']: p for p in d['parts']}
    sheet_of = {'Power': 'field-power', 'Link': 'reader-link', 'Interface': 'panel-interface'}
    b = k.BOARD(); b.SetCopperLayerCount(2)
    b.GetDesignSettings().SetBoardThickness(k.FromMM(1.6))
    for a, c in zip(OUTLINE, OUTLINE[1:] + OUTLINE[:1]):
        s = k.PCB_SHAPE(b); s.SetShape(k.SHAPE_T_SEGMENT); s.SetLayer(k.Edge_Cuts); s.SetWidth(k.FromMM(.1)); s.SetStart(vec(a)); s.SetEnd(vec(c)); b.Add(s)
    nets = {}
    for p in d['parts']:
        for n in p['nets'].values():
            if n and n not in nets: nets[n] = k.NETINFO_ITEM(b, n); b.Add(nets[n])
    fps = {}
    for p in d['parts']:
        f = k.FootprintLoad(str(ROOT / 'Fieldnote.pretty'), p['fp']); assert f, p['fp']
        f.SetReference(p['ref']); f.SetValue(p['value']); f.SetFPID(k.LIB_ID('Fieldnote', p['fp']))
        f.SetUuid(k.KIID(g.uid(p['ref'])))
        f.SetPath(k.KIID_PATH('/' + g.ROOT_UUID + '/' + g.uid('sheet' + sheet_of[p['group']]) + '/' + g.uid(p['ref'])))
        f.SetField('MPN', p['mpn']); f.GetField('MPN').SetVisible(False); f.Value().SetVisible(False)
        b.Add(f); f.SetPosition(vec((0, -30)))
        for pd in f.Pads():
            n = p['nets'].get(pd.GetNumber())
            if n: pd.SetNet(nets[n])
        if SIDE.get(p['ref']) == 'B': f.Flip(f.GetPosition(), k.FLIP_DIRECTION_LEFT_RIGHT)
        if p['ref'].startswith('JP') or p['ref'] == 'J3': f.SetExcludedFromBOM(True); f.SetExcludedFromPosFiles(True)
        fps[p['ref']] = f
    fps['J2'].SetOrientationDegrees(J2_ANGLE); fps['J2'].SetPosition(vec(J2_CENTER))
    placed = {'J2': {'xy': J2_CENTER, 'side': 'top'}}; unplaced = []
    for name, side, refs, rects in REGIONS:
        ri = 0; x0, y0, x1, y1 = rects[0]; cx, cy, rowh = x0, y0, 0.0
        for ref in refs:
            f = fps[ref]; f.SetOrientationDegrees(ANGLE.get(ref, 0)); f.SetPosition(vec((0, 0)))
            bx = bbox(f); w, h = bx[2] - bx[0], bx[3] - bx[1]
            while True:
                if cx + w > x1: cx, cy, rowh = x0, cy + rowh + MARGIN, 0.0
                if cy + h <= y1 and cx + w <= x1: break
                ri += 1
                if ri >= len(rects): break
                x0, y0, x1, y1 = rects[ri]; cx, cy, rowh = x0, y0, 0.0
            if ri >= len(rects): unplaced.append(ref); ri = len(rects) - 1; continue
            f.SetPosition(vec((cx - bx[0], cy - bx[1])))
            placed[ref] = {'xy': [round(cx - bx[0], 3), round(cy - bx[1], 3)], 'side': 'reader-facing' if side == 'F' else 'wall-facing', 'region': name}
            cx += w + MARGIN; rowh = max(rowh, h)
    k.SaveBoard(str(ROOT / 'fieldnote-interface.kicad_pcb'), b)
    (ROOT / 'output' / 'placement.json').write_text(json.dumps({'outline': OUTLINE, 'placed': placed, 'unplaced': unplaced,
        'status': 'PLACEMENT_ONLY_NOT_ROUTED'}, indent=2) + '\n')
    print(json.dumps({'placed': len(placed), 'unplaced': unplaced}))


if __name__ == '__main__':
    main()
