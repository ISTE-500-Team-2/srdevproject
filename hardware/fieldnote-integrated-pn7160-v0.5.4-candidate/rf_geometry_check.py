#!/usr/bin/env python3
"""Read-only check that the NFC antenna surroundings in v0.5.4 against v0.5.3 (v0.5.3 = v0.5.2 RF geometry, the one nfc-antenna-study modelled).

Compares, for the frozen v0.5.3 board (source-v053/, RF geometry = v0.5.2) and the v0.5.4 board (both with saved zone fills):
  * ANT1 coil copper (footprint shapes + pads);
  * every copper item of any net inside a band 3 mm around the coil (tracks, vias, pads, filled zones incl. teardrops),
    per layer: area and the XOR area between the versions;
  * the clearance from the coil copper to the GND fill on each layer and to the board edge.
Writes output/v054-rf-geometry-check.json. KiCad python: rf_geometry_check.py
"""
from pathlib import Path
import json, math, sys
import pcbnew as k

ROOT = Path(__file__).resolve().parent
OLD, NEW = ROOT / 'source-v053' / 'fieldnote.kicad_pcb', Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'fieldnote.kicad_pcb'
LAYERS = [k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu]
BAND = 3.0
mm = lambda v: k.ToMM(v)


def coil_poly(b, layer):
    a = next(f for f in b.GetFootprints() if f.GetReference() == 'ANT1')
    ps = k.SHAPE_POLY_SET()
    for it in list(a.GraphicalItems()) + list(a.Pads()):
        if it.IsOnLayer(layer):
            it.TransformShapeToPolygon(ps, layer, 0, k.FromMM(.002), k.ERROR_INSIDE)
    ps.Simplify()
    return ps


def coil_all(b):
    ps = k.SHAPE_POLY_SET()
    for L in LAYERS: ps.BooleanAdd(coil_poly(b, L))
    return ps


def band_poly(coil):
    bb = coil.BBox(); ps = k.SHAPE_POLY_SET(); ps.NewOutline()
    g = k.FromMM(BAND)
    for x, y in ((bb.GetLeft() - g, bb.GetTop() - g), (bb.GetRight() + g, bb.GetTop() - g),
                 (bb.GetRight() + g, bb.GetBottom() + g), (bb.GetLeft() - g, bb.GetBottom() + g)):
        ps.Append(int(x), int(y))
    return ps


def copper_in_band(b, layer, band, gnd_fill_only=False):
    ps = k.SHAPE_POLY_SET()
    ant = next(f for f in b.GetFootprints() if f.GetReference() == 'ANT1')
    for z in b.Zones():
        if z.GetIsRuleArea() or not z.IsOnLayer(layer): continue
        if gnd_fill_only and (z.GetNetname() != 'GND' or z.IsTeardropArea()): continue
        ps.BooleanAdd(k.SHAPE_POLY_SET(z.GetFilledPolysList(layer)))
    if not gnd_fill_only:
        for t in b.GetTracks():
            if t.IsOnLayer(layer): t.TransformShapeToPolygon(ps, layer, 0, k.FromMM(.002), k.ERROR_INSIDE)
        for f in b.GetFootprints():
            if f.GetReference() == 'ANT1': continue
            for p in f.Pads():
                if p.IsOnLayer(layer): p.TransformShapeToPolygon(ps, layer, 0, k.FromMM(.002), k.ERROR_INSIDE)
    ps.Simplify(); ps.BooleanIntersection(band)
    return ps


def min_dist(a, b_, hi=6.0):
    """Smallest clearance between two polygon sets (0.005 mm resolution, capped at hi)."""
    if a.OutlineCount() == 0 or b_.OutlineCount() == 0: return None
    if not a.Collide(b_, k.FromMM(hi)): return f'> {hi}'
    lo, up = 0., hi
    while up - lo > .005:
        m = (lo + up) / 2
        if a.Collide(b_, k.FromMM(m)): up = m
        else: lo = m
    return round(up, 3)


def edge_poly(b):
    ps = k.SHAPE_POLY_SET()
    for d in b.GetDrawings():
        if d.GetLayer() == k.Edge_Cuts: d.TransformShapeToPolygon(ps, k.Edge_Cuts, 0, k.FromMM(.002), k.ERROR_INSIDE)
    return ps


def main():
    bo, bn = k.LoadBoard(str(OLD)), k.LoadBoard(str(NEW))
    rep = {'old_board': str(OLD.relative_to(ROOT)), 'new_board': NEW.name, 'band_mm': BAND, 'layers': {}}
    co, cn = coil_all(bo), coil_all(bn)
    x = k.SHAPE_POLY_SET(co); x.BooleanXor(cn)
    rep['coil_copper_area_mm2'] = [round(co.Area() / 1e12, 4), round(cn.Area() / 1e12, 4)]
    rep['coil_copper_xor_mm2'] = round(x.Area() / 1e12, 6)
    band = band_poly(co)
    bb = co.BBox(); rep['coil_bbox_design_mm'] = [round(mm(bb.GetLeft()) - 60, 2), round(mm(bb.GetTop()) - 50, 2), round(mm(bb.GetRight()) - 60, 2), round(mm(bb.GetBottom()) - 50, 2)]
    for L in LAYERS:
        n = bo.GetLayerName(L)
        ao, an = copper_in_band(bo, L, band), copper_in_band(bn, L, band)
        xo = k.SHAPE_POLY_SET(ao); xo.BooleanXor(an)
        go, gn = copper_in_band(bo, L, band, True), copper_in_band(bn, L, band, True)
        xg = k.SHAPE_POLY_SET(go); xg.BooleanXor(gn)
        rep['layers'][n] = {'all_copper_in_band_mm2': [round(ao.Area() / 1e12, 3), round(an.Area() / 1e12, 3)],
                            'all_copper_xor_mm2': round(xo.Area() / 1e12, 4),
                            'gnd_fill_in_band_mm2': [round(go.Area() / 1e12, 3), round(gn.Area() / 1e12, 3)],
                            'gnd_fill_xor_mm2': round(xg.Area() / 1e12, 4),
                            'coil_to_gnd_fill_mm_plan_view': [min_dist(co, go), min_dist(cn, gn)]}
        near = {}
        for d in (.5, 1.0, 2.0, 3.0):          # where the GND-fill change sits, by plan-view distance from the coil copper
            ring = k.SHAPE_POLY_SET(co); ring.Inflate(k.FromMM(d), k.CORNER_STRATEGY_ROUND_ALL_CORNERS, k.FromMM(.01))
            q = k.SHAPE_POLY_SET(xg); q.BooleanIntersection(ring); near[f'within_{d}mm'] = round(q.Area() / 1e12, 4)
        rep['layers'][n]['gnd_fill_xor_by_distance_mm2'] = near
        if xg.OutlineCount():
            pieces = []
            for i in range(xg.OutlineCount()):
                s_ = k.SHAPE_POLY_SET(); s_.AddOutline(xg.Outline(i)); a_ = s_.Area() / 1e12
                if a_ > .05:
                    bb_ = s_.BBox(); pieces.append([round(a_, 3), [round(mm(bb_.GetLeft()) - 60, 2), round(mm(bb_.GetTop()) - 50, 2), round(mm(bb_.GetRight()) - 60, 2), round(mm(bb_.GetBottom()) - 50, 2)]])
            rep['layers'][n]['gnd_fill_xor_pieces_gt_0.05mm2'] = sorted(pieces, reverse=True)[:12]
    rep['coil_to_board_edge_mm'] = [min_dist(co, edge_poly(bo)), min_dist(cn, edge_poly(bn))]
    xo_ = k.SHAPE_POLY_SET(edge_poly(bo)); xo_.BooleanIntersection(band); xn_ = k.SHAPE_POLY_SET(edge_poly(bn)); xn_.BooleanIntersection(band)
    xe = k.SHAPE_POLY_SET(xo_); xe.BooleanXor(xn_)
    rep['board_edge_in_band_changed'] = xe.Area() > 0
    if rep['board_edge_in_band_changed']:
        xb = xe.BBox(); rep['board_edge_change_bbox_design_mm'] = [round(mm(xb.GetLeft()) - 60, 2), round(mm(xb.GetTop()) - 50, 2), round(mm(xb.GetRight()) - 60, 2), round(mm(xb.GetBottom()) - 50, 2)]
    if len(sys.argv) <= 2: (ROOT / 'output' / 'v054-rf-geometry-check.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps(rep))


if __name__ == '__main__':
    main()
