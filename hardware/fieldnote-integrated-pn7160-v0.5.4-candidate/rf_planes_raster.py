#!/usr/bin/env python3
"""Rasterise the copper around the NFC coil for the FastHenry plane model (KiCad python, read only).

For each copper layer: union of zone fills, tracks, vias and pads, EXCLUDING the 12 RF nets of the antenna study and the ANT1
footprint (the study models the coil and its feed leads explicitly). Sampled at the nodes of the study's plane grid
(coil_fasthenry.py: x0 0.1, y0 0.2, h 0.375 mm, 120 x 120 cells -> x 0.1-45.1, y 0.2-45.2, design coordinates).
Every copper item is a floating conductor in the model (eddy currents only), as in the study.

Usage: KiCad-python rf_planes_raster.py BOARD OUT.json [gnd_only]
"""
import json, sys
import pcbnew as k

RF_NETS = {'NFC_TX1', 'NFC_TX2', 'RF1_FILTER', 'RF2_FILTER', 'RF1_MATCH', 'RF2_MATCH', 'ANT_A', 'ANT_B',
           'RF_RXP_COUPLED', 'RF_RXN_COUPLED', 'NFC_RXP', 'NFC_RXN'}
X0, Y0, H, N = 0.1, 0.2, 0.375, 120
LAYERS = {'F': k.F_Cu, 'In1': k.In1_Cu, 'In2': k.In2_Cu, 'B': k.B_Cu}


def main(board, out, gnd_only=False):
    b = k.LoadBoard(board)
    k.ZONE_FILLER(b).Fill(b.Zones()) if not any(z.IsFilled() for z in b.Zones() if not z.GetIsRuleArea()) else None
    res = {'board': board, 'grid': {'x0': X0, 'y0': Y0, 'h': H, 'n': N}, 'gnd_only': gnd_only, 'layers': {}, 'counts': {}}
    keep = lambda net: (net == 'GND') if gnd_only else (net not in RF_NETS)
    for name, lid in LAYERS.items():
        ps = k.SHAPE_POLY_SET()
        for z in b.Zones():
            if z.GetIsRuleArea() or not z.IsOnLayer(lid) or not keep(z.GetNetname()): continue
            ps.Append(z.GetFilledPolysList(lid))
        n_items = 0
        for t in b.GetTracks():
            if not t.IsOnLayer(lid) or not keep(t.GetNetname()): continue
            t.TransformShapeToPolygon(ps, lid, 0, k.FromMM(.005), k.ERROR_INSIDE); n_items += 1
        for f in b.GetFootprints():
            if f.GetReference() == 'ANT1': continue
            for pd in f.Pads():
                if not pd.IsOnLayer(lid) or not pd.GetNetname() or not keep(pd.GetNetname()): continue
                pd.TransformShapeToPolygon(ps, lid, 0, k.FromMM(.005), k.ERROR_INSIDE); n_items += 1
        ps.Simplify()
        rows = []
        for j in range(N + 1):
            y = Y0 + j * H
            rows.append(''.join('1' if ps.Contains(k.VECTOR2I(k.FromMM(X0 + i * H + 60), k.FromMM(y + 50))) else '0' for i in range(N + 1)))
        res['layers'][name] = rows
        res['counts'][name] = {'items': n_items, 'copper_nodes': sum(r.count('1') for r in rows)}
    json.dump(res, open(out, 'w'))
    print(json.dumps(res['counts']))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], len(sys.argv) > 3 and sys.argv[3] == 'gnd_only')
