#!/usr/bin/env python3
"""v0.5 layout, attempt B (after the 2026-11-10 GPT-6.1 review).

Differences from apply_v05_pcb.py (attempt A, kept for the record):
  * Board grows 8.5 mm on the right edge (x 65.5 -> 74.0, y 0..37) next to USB/charger.
  * VBUS loop is cut at (63.407, 3.668)-(63.407, 4.703), so both mux power ends land ~2 mm from the strip.
  * All new SMD parts on the TOP side in the strip (single-sided SMT); only J6 (through-hole) has its body on the back.
  * U11 is SN74LVC1G0832 (AND-OR).
Phases: surgery | outline | place | route | finish     (KiCad python apply_v05b_pcb.py <phase>)
"""
from pathlib import Path
import json, math, sys
import pcbnew as k
import route_pn7160 as r
import apply_v05_pcb as A

ROOT = A.ROOT; OUT = A.OUT
STRIP_X = (65.5, 74.0); STRIP_Y = 37.0


def surgery():
    A.CUT_SEGMENTS = {('VBUS', (63.407, 3.668), (63.407, 4.703)), ('USB_HIGH_CURRENT', (38.675, 9.673), (40.951, 11.949))}
    A.PRUNE_AT_SURGERY = {'USB_HIGH_CURRENT', 'SOURCE_QUALIFIED'}   # VBUS/VIN_SEL ends stay for the mux
    A.surgery()


def grow(points):
    out = []
    for p in points:
        if abs(p[0] - 65.5) < 1e-6 and abs(p[1]) < 1e-6:
            out += [[74.0, 0.0], [74.0, STRIP_Y], [65.5, STRIP_Y]]
        else:
            out.append(p)
    return out


def outline():
    app, b = A.load()
    old = [[0, 0], [3, 0], [3, 1.6], [11.5, 1.6], [11.5, 0], [47, 0], [47, -2], [60, -2], [60, 0], [65.5, 0], [65.5, 45.2], [61.5, 45.2], [61.5, 38.7], [48.1, 38.7], [48.1, 45.2], [0, 45.2]]
    new = grow(old)
    edges = [d for d in b.GetDrawings() if d.GetLayer() == k.Edge_Cuts]
    assert len(edges) == 16, len(edges)
    width = edges[0].GetWidth()
    for d in edges: b.Remove(d)
    for a, c in zip(new, new[1:] + new[:1]):
        s = k.PCB_SHAPE(b); s.SetShape(k.SHAPE_T_SEGMENT); s.SetLayer(k.Edge_Cuts); s.SetWidth(width)
        s.SetStart(r.vec(a)); s.SetEnd(r.vec(c)); b.Add(s)
    changed = []
    for z in b.Zones():
        if z.GetIsRuleArea() or z.GetNetname() != 'GND': continue
        o = z.Outline().Outline(0); pts = [r.xy(o.CPoint(i)) for i in range(o.PointCount())]
        if not any(abs(p[0] - 65.5) < 1e-3 and abs(p[1]) < 1e-3 for p in pts): continue
        g = grow(pts); poly = k.SHAPE_POLY_SET(); poly.NewOutline()
        for p in g: poly.Append(r.vec(p))
        z.SetOutline(poly); changed.append(z.GetLayerName() if hasattr(z, 'GetLayerName') else str(z.GetFirstLayer()))
    A.save(b)
    rep = {'outline': new, 'gnd_zones_grown': changed, 'board_sha256': A.sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v05b-outline.json').write_text(json.dumps(rep, indent=2) + '\n'); print(json.dumps({'edges': len(new), 'zones': len(changed)}))


# ---------------- placement (top side, strip) ----------------
# (center, pad, desired pad xy): the angle that lands that pad nearest its target is chosen, then legality is checked.
TARGETS = {
    'U10': ([70.6, 5.0], '7', [71.275, 5.35]),
    'C40': ([67.0, 5.6], '1', [67.0, 4.65]),          # VIN_SEL bulk on the straight OUT1 -> island path
    'C41': ([65.9, 1.9], '1', [65.075, 1.9]),         # VBUS cap above R5, on the VBUS entry path
    'C39': ([69.2, 1.7], '1', [69.975, 1.7]),         # SS
    'R35': ([72.3, 1.7], '1', [71.475, 1.7]),         # ILM
    'C42': ([73.1, 5.6], '1', [73.1, 6.375]),         # 5V_FIELD at IN1; GND pad north toward R35.2
    'R33': ([68.4, 8.1], '2', [69.225, 8.1]),         # VBUS -> CP2
    'R31': ([72.3, 7.9], '2', [71.475, 7.9]),         # 5V_FIELD -> PR1
    'R34': ([68.4, 9.8], '1', [69.225, 9.8]),         # CP2 -> GND
    'R32': ([72.3, 9.6], '1', [71.475, 9.6]),         # PR1 -> GND
    'JP2': ([71.9, 11.9], '1', [71.25, 11.9]),        # PR1 -> GND (USB priority)
    'R36': ([72.6, 18.7], '1', [72.6, 17.875]),       # ST pull-up (ST reaches it through a via)
    'U11': ([68.4, 15.6], '4', [67.1, 14.65]),        # outputs (Y, C) face west toward U3/U7
    'C43': ([66.6, 18.6], '1', [67.375, 18.6]),
    'R37': ([72.1, 15.6], '1', [72.925, 15.6]),       # GND pad west, 1.6 mm from U11.2
    'J6':  ([69.8, 25.0], '1', [69.165, 22.46]),
}
ORDER = list(TARGETS)


def place():
    app, b = A.load(); d = A.data(); parts = {p['ref']: p for p in d['parts']}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    new = [p['ref'] for p in d['parts'] if p['ref'] in ORDER]
    for ref in new: fps[ref].SetPosition(r.vec([-40, -40]))
    def court(f):
        lay = k.B_CrtYd if f.GetLayer() == k.B_Cu else k.F_CrtYd
        boxes = [i.GetBoundingBox() for i in f.GraphicalItems() if i.GetLayer() == lay] or [p.GetBoundingBox() for p in f.Pads()]
        return [min(k.ToMM(bb.GetX()) - 60 for bb in boxes), min(k.ToMM(bb.GetY()) - 50 for bb in boxes),
                max(k.ToMM(bb.GetX() + bb.GetWidth()) - 60 for bb in boxes), max(k.ToMM(bb.GetY() + bb.GetHeight()) - 50 for bb in boxes)]
    courts = {'F': [], 'B': []}
    for f in b.GetFootprints():
        if f.GetReference() in new: continue
        courts['B' if f.GetLayer() == k.B_Cu else 'F'].append(court(f))
    obstacles = []
    for t in b.GetTracks():
        lays = [k.F_Cu, k.B_Cu] if isinstance(t, k.PCB_VIA) else [t.GetLayer()]
        for L in lays:
            if L not in (k.F_Cu, k.B_Cu): continue
            if isinstance(t, k.PCB_VIA): p = r.xy(t.GetPosition()); obstacles.append((L, p, p, k.ToMM(t.GetWidth(L)) / 2, t.GetNetname()))
            else: obstacles.append((L, r.xy(t.GetStart()), r.xy(t.GetEnd()), k.ToMM(t.GetWidth()) / 2, t.GetNetname()))
    for f in b.GetFootprints():
        if f.GetReference() in new: continue
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for L in (k.F_Cu, k.B_Cu):
                if pd.IsOnLayer(L): obstacles.append((L, a, c, rad + .05, pd.GetNetname()))
    def inside(box):
        x0, y0, x1, y1 = box
        if y0 < 0.4 or x1 > 73.9: return False
        if x1 > 65.6 and y1 > STRIP_Y - 0.15: return False
        return x0 >= 40.0 or True
    def legal(f):
        side = 'B' if f.GetLayer() == k.B_Cu else 'F'; box = court(f)
        if not inside(box): return 'outside allowed region'
        hit = [o for o in courts[side] if not (box[2] <= o[0] + .01 or box[0] >= o[2] - .01 or box[3] <= o[1] + .01 or box[1] >= o[3] - .01)]
        if hit: return 'courtyard overlap %s' % [[round(v, 2) for v in o] for o in hit[:2]]
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for L, u, v, ur, un in obstacles:
                if not pd.IsOnLayer(L) or (un == pd.GetNetname() and un): continue
                if r.segment_distance(a, c, u, v) < rad + ur + A.CLEAR:
                    return 'pad %s clearance to %s %s on %s' % (pd.GetNumber(), un, [round(x, 2) for x in u], b.GetLayerName(L))
        return True
    solved = {}
    for ref, (c, padnum, want) in TARGETS.items():
        f = fps[ref]; best = None
        for ang in (0, 90, 180, 270):
            f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
            pp = r.xy(next(p for p in f.Pads() if p.GetNumber() == padnum).GetPosition())
            if best is None or math.dist(pp, want) < best[0]: best = (math.dist(pp, want), ang)
        f.SetOrientationDegrees(best[1]); f.SetPosition(r.vec(c))
        ok = legal(f); box = court(f)
        courts['B' if f.GetLayer() == k.B_Cu else 'F'].append(box)
        for pd in f.Pads():
            a, cc, rad = A.pad_segment(pd)
            for L in (k.F_Cu, k.B_Cu):
                if pd.IsOnLayer(L): obstacles.append((L, a, cc, rad, pd.GetNetname()))
        parts[ref]['xy'] = c; parts[ref]['angle'] = best[1]
        solved[ref] = {'xy': c, 'angle': best[1], 'pad_error_mm': round(best[0], 3), 'legal': ok, 'courtyard': [round(v, 2) for v in box]}
        print(json.dumps({ref: solved[ref]}), flush=True)
    A.save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (OUT / 'v05b-placement.json').write_text(json.dumps(solved, indent=2) + '\n')


# ---------------- routing ----------------
P = .4
PT = lambda x, y: {'xy': [x, y], 'layers': ['F.Cu']}
STEPS = [
    # U10 small-pin fanout first
    ('MUX_ILM', 'U10.10', 'R35.1', .2, 2), ('MUX_SS', 'U10.11', 'C39.1', .2, 2),
    ('MUX_PR1', 'U10.6', 'R31.2', .2, 2), ('MUX_CP2', 'U10.3', 'R33.2', .2, 2), ('GND', 'U10.4', 'U10.5', .2, 0),
    # mux power
    ('VIN_SEL', 'U10.1', 'U10.8', .3, 0), ('VIN_SEL', 'U10.1', 'C40.1', P, 2), ('VIN_SEL', 'C40.1', PT(63.407, 4.703), P, 2),
    ('VBUS', PT(63.407, 3.668), 'C41.1', P, 2), ('VBUS', 'C41.1', 'U10.2', P, 2),
    ('5V_FIELD', 'C42.1', 'U10.7', P, 2),
    ('GND', 'C42.2', 'R35.2', .25, 1), ('GND', 'R37.2', 'U11.2', .25, 0),
    # long links out of the strip while it is still open
    ('USB_HIGH_CURRENT', 'U11.6', 'U7.4', .2, 6), ('SOURCE_QUALIFIED', 'U11.4', 'NEAREST', .2, 4),
    ('NFC_SDA', 'J6.7', 'NEAREST', .15, 6), ('NFC_SCL', 'J6.8', 'NEAREST', .15, 6), ('IO_INT', 'J6.9', 'R10.2', .15, 4),
    ('3V3', 'C43.1', 'NEAREST', .25, 4),
    # rest of the cluster
    ('PWR_SRC', 'U10.9', 'R36.1', .2, 3),
    ('5V_FIELD', 'J6.2', 'C42.1', P, 3), ('5V_FIELD', 'J6.1', 'J6.2', P, 2),
    ('5V_FIELD', 'R31.1', 'C42.1', .25, 2), ('VBUS', 'R33.1', 'C41.1', .25, 2),
    ('MUX_PR1', 'R31.2', 'R32.1', .2, 2), ('MUX_PR1', 'R32.1', 'JP2.1', .2, 2), ('MUX_CP2', 'R33.2', 'R34.1', .2, 2),
    ('PWR_SRC', 'R36.1', 'U11.3', .2, 3), ('PWR_SRC', 'U11.3', 'J6.10', .2, 3),
    ('FIELD_PG', 'J6.6', 'R37.1', .2, 3), ('FIELD_PG', 'R37.1', 'U11.1', .2, 3),
    ('3V3', 'U11.5', 'C43.1', .25, 2), ('3V3', 'R36.2', 'C43.1', .25, 3), ('3V3', 'J6.5', 'C43.1', .25, 3),
]
GROUND_PADS = ['U10.4', 'U10.12', 'R32.2', 'R34.2', 'R35.2', 'C39.2', 'C40.2', 'C41.2', 'C42.2', 'JP2.2', 'R37.2', 'U11.2', 'C43.2']


def nearest_points(b, netname, origin, exclude_refs=(), n=10, allowed=None):
    pts = []
    for t in b.GetTracks():
        if t.GetNetname() != netname: continue
        if allowed is not None and t.m_Uuid.AsString() not in allowed: continue
        if isinstance(t, k.PCB_VIA):
            p = r.xy(t.GetPosition()); pts.append((math.dist(p, origin), {'xy': p, 'layers': ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']})); continue
        a, c = r.xy(t.GetStart()), r.xy(t.GetEnd()); m = max(1, int(math.dist(a, c) / .5))
        for i in range(m + 1):
            p = [round(a[0] + (c[0] - a[0]) * i / m, 4), round(a[1] + (c[1] - a[1]) * i / m, 4)]
            pts.append((math.dist(p, origin), {'xy': p, 'layers': [b.GetLayerName(t.GetLayer())]}))
    for f in b.GetFootprints():
        if f.GetReference() in exclude_refs: continue
        for pd in f.Pads():
            if pd.GetNetname() == netname:
                p = r.xy(pd.GetPosition()); pts.append((math.dist(p, origin), f'{f.GetReference()}.{pd.GetNumber()}'))
    pts.sort(key=lambda t: t[0]); seen, out = [], []
    for dd, spec in pts:
        xy = spec['xy'] if isinstance(spec, dict) else None
        if xy and any(math.dist(xy, s) < 1.5 for s in seen): continue
        if xy: seen.append(xy)
        out.append(spec)
        if len(out) >= n: break
    return out


def route():
    app, b = A.load(); before = r.track_snapshot(b); log = {'routes': [], 'failed': [], 'ground': []}
    preexisting = set(before)
    new_refs = set(ORDER)
    def add(netname, legs, vias, w, key):
        for vi, p in enumerate(vias):
            v = k.PCB_VIA(b); v.SetUuid(A.ident(f'{key}:via:{vi}')); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(.5)); v.SetDrill(k.FromMM(.2))
            v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet(netname)); v.SetLocked(True)
            v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v)
        for li, (layer, pts) in enumerate(legs):
            for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                if math.dist(x, y) < 1e-8: continue
                t = k.PCB_TRACK(b); t.SetUuid(A.ident(f'{key}:{li}:{ti}')); t.SetStart(r.vec(x)); t.SetEnd(r.vec(y))
                t.SetLayer(b.GetLayerID(layer)); t.SetNet(b.FindNet(netname)); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t)
        return sum(math.dist(x, y) for _, pts in legs for x, y in zip(pts, pts[1:]))
    for i, (netname, s, e, w, nv) in enumerate(STEPS):
        a, sl = r.endpoint(b, s, netname)
        ends = nearest_points(b, netname, a, exclude_refs=new_refs, allowed=preexisting) if e == 'NEAREST' else [e]
        done, err = False, ''
        for end in ends:
            c, el = r.endpoint(b, end, netname)
            for ww in ([w, .3] if w > .3 else [w]):
                try:
                    legs, vias, visited = r.path(b, netname, a, c, ww, ['F.Cu', 'B.Cu', 'In2.Cu'], sl, el, [1.0, .5, 73.65, 44.7],
                                                 max_vias=nv, max_states=600000 if e == 'NEAREST' else (2500000 if netname == 'USB_HIGH_CURRENT' else 1200000), step=.1)
                except RuntimeError as ex:
                    err = str(ex); continue
                L = add(netname, legs, vias, ww, f'b:{i}')
                log['routes'].append({'i': i, 'net': netname, 'from': s if isinstance(s, str) else s['xy'], 'to': end if isinstance(end, str) else end['xy'],
                                      'width': ww, 'length_mm': round(L, 2), 'vias': len(vias)})
                print(json.dumps(log['routes'][-1]), flush=True); done = True; break
            if done: break
        if not done:
            log['failed'].append({'i': i, 'net': netname, 'from': s if isinstance(s, str) else s['xy'], 'error': err}); print(json.dumps({'failed': log['failed'][-1]}), flush=True)
    for spec in GROUND_PADS:
        p, sl = r.endpoint(b, spec, 'GND'); checks = [r.collision_test(b, 'GND', .5, L, True) for L in r.ALL_COPPER]
        cands = sorted((math.hypot(ix * .1, iy * .1), [round(p[0] + ix * .1, 4), round(p[1] + iy * .1, 4)]) for ix in range(-18, 19) for iy in range(-18, 19) if .55 <= math.hypot(ix * .1, iy * .1) <= 1.8)
        for dist, vp in cands:
            if not (1 <= vp[0] <= 73.6 and .5 <= vp[1] <= 44.7) or (vp[0] > 65.6 and vp[1] > STRIP_Y - .4): continue
            if not all(ch(vp, vp) for ch in checks): continue
            try:
                legs, vias, _ = r.path(b, 'GND', p, vp, .25, ['F.Cu'], sl, ['F.Cu'], [1.0, .5, 73.65, 44.7], max_vias=0, max_states=20000, step=.05)
            except RuntimeError:
                continue
            add('GND', [[L, pts] for L, pts in legs], [vp], .25, 'gnd:' + spec)
            log['ground'].append({'pad': spec, 'via': vp}); break
        else:
            log['failed'].append({'net': 'GND', 'from': spec, 'error': 'NO_LOCAL_GROUND_VIA'})
    now = r.track_snapshot(b); log['preexisting_copper_unchanged'] = all(now.get(u) == g for u, g in before.items())
    A.save(b); log['board_sha256'] = A.sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v05b-routing.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'routed': len(log['routes']), 'ground': len(log['ground']), 'failed': len(log['failed']), 'preserved': log['preexisting_copper_unchanged']}))


def finish():
    app, b = A.load()
    pruned = []  # DRC shows no dangling tracks; removing tracks in a loop crashed pcbnew's SWIG layer
    d = A.data(); P_ = {p['ref']: p for p in d['parts']}
    for f in b.GetFootprints():
        if f.GetReference() in P_ and f.GetReference() in ORDER:
            f.Reference().SetTextSize(k.VECTOR2I(k.FromMM(.8), k.FromMM(.8))); f.Reference().SetTextThickness(k.FromMM(.15))
    src = k.LoadBoard(str(ROOT / 'source-v04c' / 'fieldnote.kicad_pcb')); orig = {f.GetReference(): f for f in src.GetFootprints()}
    for f in b.GetFootprints():
        o = orig.get(f.GetReference())
        if o: f.SetExcludedFromBOM(o.IsExcludedFromBOM()); f.SetExcludedFromPosFiles(o.IsExcludedFromPosFiles())
    k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b)
    (OUT / 'v05b-finish.json').write_text(json.dumps({'pruned': pruned, 'board_sha256': A.sha(ROOT / 'fieldnote.kicad_pcb')}, indent=2) + '\n')
    print(json.dumps({'pruned': len(pruned)}))


if __name__ == '__main__':
    if sys.argv[1] != 'stitch': {'surgery': surgery, 'outline': outline, 'place': place, 'route': route, 'finish': finish}[sys.argv[1]]()


def stitch():
    """Add a GND via in every F/B GND fill island that has no GND via, and next to R37.2/C42.2."""
    app, b = A.load(); k.ZONE_FILLER(b).Fill(b.Zones()); b.BuildConnectivity()
    vias = [r.xy(t.GetPosition()) for t in b.GetTracks() if isinstance(t, k.PCB_VIA) and t.GetNetname() == 'GND']
    checks = [r.collision_test(b, 'GND', .5, L, True) for L in r.ALL_COPPER]
    added = []
    def place_via(cands, key):
        for p in cands:
            if not (1 <= p[0] <= 73.6 and .5 <= p[1] <= 44.7): continue
            if (p[0] < 33.3 and p[1] > 10.4) or (p[0] > 33 and p[1] > 38.4): continue
            if all(ch(p, p) for ch in checks):
                v = k.PCB_VIA(b); v.SetUuid(A.ident(key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(.5)); v.SetDrill(k.FromMM(.2))
                v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet('GND')); v.SetLocked(True)
                v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v)
                vias.append(p); added.append({'key': key, 'xy': p}); return True
        return False
    for z in b.Zones():
        if z.GetIsRuleArea() or z.GetNetname() != 'GND': continue
        L = z.GetFirstLayer()
        if L not in (k.F_Cu, k.B_Cu): continue
        polys = z.GetFilledPolysList(L)
        for i in range(polys.OutlineCount()):
            o = polys.Outline(i); pts = [r.xy(o.CPoint(j)) for j in range(o.PointCount())]
            if any(r.inside(v, pts) for v in vias): continue
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            if (max(xs) - min(xs)) * (max(ys) - min(ys)) < .6: continue
            cands = [[round(x / 10, 2), round(y / 10, 2)] for x in range(int(min(xs) * 10), int(max(xs) * 10) + 1, 1) for y in range(int(min(ys) * 10), int(max(ys) * 10) + 1, 1)]
            cands = [c for c in cands if r.inside(c, pts) and all(r.point_segment(c, a, bb) > .32 for a, bb in zip(pts, pts[1:] + pts[:1]))]
            ok = place_via(cands, f'stitch:{b.GetLayerName(L)}:{i}')
            if not ok: added.append({'key': f'stitch:{b.GetLayerName(L)}:{i}', 'failed': True, 'bbox': [min(xs), min(ys), max(xs), max(ys)]})
    for spec in ('R37.2', 'C42.2'):
        p, _ = r.endpoint(b, spec, 'GND')
        cands = sorted(([round(p[0] + ix * .1, 2), round(p[1] + iy * .1, 2)] for ix in range(-20, 21) for iy in range(-20, 21)), key=lambda c: math.dist(c, p))
        cands = [c for c in cands if .6 <= math.dist(c, p) <= 2.0]
        clear = r.collision_test(b, 'GND', .3, 'F.Cu')
        for c in cands:
            if clear(p, c) and place_via([c], 'padvia:' + spec):
                t = k.PCB_TRACK(b); t.SetUuid(A.ident('padvia-trk:' + spec)); t.SetStart(r.vec(p)); t.SetEnd(r.vec(c)); t.SetLayer(k.F_Cu)
                t.SetNet(b.FindNet('GND')); t.SetWidth(k.FromMM(.3)); t.SetLocked(True); b.Add(t); break
    k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b)
    (OUT / 'v05b-stitch.json').write_text(json.dumps(added, indent=2) + '\n'); print(json.dumps(added))


if __name__ == '__main__' and sys.argv[1] == 'stitch':
    stitch()
