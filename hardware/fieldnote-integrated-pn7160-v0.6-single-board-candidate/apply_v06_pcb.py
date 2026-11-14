#!/usr/bin/env python3
"""v0.6 single-board layout on top of the routed v0.5 board (source-v05/fieldnote.kicad_pcb).

Phases (KiCad python apply_v06_pcb.py <phase>):
  surgery - remove J6 (each pad becomes a same-net via so all v0.5 routes stay connected), rename IO_INT ->
            WG_D1_SRC, import the 63 new footprints, sync every pad net with design-data.
  place   - pack the new parts into fixed regions of the right-edge extension (top side; SW3 on the back).
  route   - automatic: per net, a minimum spanning tree over new pads plus the nearest existing copper,
            routed with the repo A* router; then local GND vias for every new GND pad.
  finish  - zone refill, attributes, reference text size.
The outline growth is a text edit (grow_outline_v06.py) because pcbnew's API path segfaulted in v0.5.
"""
from pathlib import Path
import hashlib, json, math, sys
import wx
import pcbnew as k
import route_pn7160 as r
import build_design as g
import apply_v05_pcb as A

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
V05_BOARD = '1c64f9903f6d2f3be6b658038252d0359edbaed5345d4fb8ba7a5826ac9e5167'
A.ROOT = ROOT; A.OUT = OUT
BOUNDS = [1.0, .5, 109.65, 44.7]


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def data(): return json.loads((ROOT / 'design-data.json').read_text())


def add_via(b, net, p, key, dia=.5, drill=.2):
    v = k.PCB_VIA(b); v.SetUuid(A.ident('v06:' + key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(dia)); v.SetDrill(k.FromMM(drill))
    v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet(net)); v.SetLocked(True)
    v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v); return v


def add_track(b, net, layer, a, c, w, key):
    t = k.PCB_TRACK(b); t.SetUuid(A.ident('v06:' + key)); t.SetStart(r.vec(a)); t.SetEnd(r.vec(c)); t.SetLayer(layer)
    t.SetNet(b.FindNet(net)); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t)


def surgery():
    assert sha(ROOT / 'source-v05' / 'fieldnote.kicad_pcb') == V05_BOARD
    assert sha(ROOT / 'fieldnote.kicad_pcb') == V05_BOARD, 'working board is not the v0.5 baseline'
    app, b = A.load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    rep = {'j6_vias': [], 'imported': []}
    for name in {n for p in d['parts'] for n in p['nets'].values() if n}:
        A.net(b, name)
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    j6 = fps.pop('J6')
    for pd in j6.Pads():
        net = pd.GetNetname(); net = 'WG_D1_SRC' if net == 'IO_INT' else net; p = r.xy(pd.GetPosition())
        add_via(b, net, p, 'j6via:' + pd.GetNumber(), *((.6, .3) if net == '5V_FIELD' else (.5, .2)))
        rep['j6_vias'].append({'pad': pd.GetNumber(), 'net': net, 'xy': p})
    b.Remove(j6)
    n = 0
    for t in b.GetTracks():
        if t.GetNetname() == 'IO_INT': t.SetNet(b.FindNet('WG_D1_SRC')); n += 1
    rep['renamed_IO_INT_items'] = n
    for p in d['parts']:
        if p['ref'] in fps: continue
        f = k.FootprintLoad(str(ROOT / 'Fieldnote.pretty'), p['fp']); assert f, p['fp']
        f.SetReference(p['ref']); f.SetUuid(k.KIID(g.uid(p['ref']))); f.SetFPID(k.LIB_ID('Fieldnote', p['fp'])); b.Add(f)
        f.SetPosition(r.vec([-40, -40]))
        if p.get('side') == 'B': f.Flip(f.GetPosition(), k.FLIP_DIRECTION_LEFT_RIGHT)
        f.SetPath(k.KIID_PATH('/' + g.ROOT_UUID + '/' + g.uid('sheetfield-interface') + '/' + g.uid(p['ref'])))
        f.Reference().SetTextSize(k.VECTOR2I(k.FromMM(.8), k.FromMM(.8))); f.Reference().SetTextThickness(k.FromMM(.15)); f.Value().SetVisible(False)
        if p['ref'].startswith('JP'): f.SetExcludedFromBOM(True); f.SetExcludedFromPosFiles(True)
        fps[p['ref']] = f; rep['imported'].append(p['ref'])
    for p in d['parts']:
        f = fps[p['ref']]
        f.SetValue(p['value']); f.SetField('MPN', p['mpn']); f.GetField('MPN').SetVisible(False); f.SetDNP(p['dnp'])
        for pd in f.Pads():
            num = pd.GetNumber()
            if not num or num not in p['nets']: continue
            nn = p['nets'][num]; name = p['names'].get(num, num)
            nn = nn or ('unconnected-(' + p['ref'] + '-' + ('' if name == num else name + '-') + 'Pad' + num + ')')
            pd.SetNet(A.net(b, nn)); pd.SetPinFunction(name)
    for item in b.GetDrawings():
        if isinstance(item, k.PCB_TEXT) and item.GetText().startswith('FIELDNOTE PN7160 v0.5'):
            item.SetText('FIELDNOTE PN7160 v0.6 - SINGLE BOARD REVIEW')
    A.save(b); rep['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v06-surgery.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({'j6_vias': len(rep['j6_vias']), 'imported': len(rep['imported']), 'renamed': n}))


# ---------------- placement ----------------
FIXED = {  # ref: (center, angle or None=choose so that pad 'MP' lies right of pad '1' i.e. opening faces +x)
    'J5': ([100.6, 23.1], 'opening_right'),
    'BZ1': ([83.5, 38.2], 90),
    'SW3': ([82.0, 21.0], 0),
}
REGIONS = [
    ('field power', ['U12', 'L4', 'D5', 'D6', 'F1', 'C44', 'C48', 'C49', 'C45', 'C46', 'C47', 'R38', 'R39', 'R40', 'R41', 'R42'], [(74.3, 0.6, 103.7, 14.4)]),
    ('expander', ['U15', 'C54', 'R45'], [(74.3, 15.0, 86.0, 26.8)]),
    ('wiegand', ['U16', 'Q1', 'Q2', 'D8', 'C55', 'R46', 'R47', 'R48', 'R49'], [(86.2, 15.0, 97.2, 26.8)]),
    ('rs485', ['U14', 'U19', 'D7', 'C53', 'C60', 'R43', 'R44', 'R60', 'JP3'], [(90.2, 27.0, 97.2, 37.0), (97.4, 31.9, 103.7, 37.2)]),
    ('osdp uart', ['U13', 'Y2', 'C50', 'C51', 'C52'], [(65.6, 26.6, 73.9, 36.6), (74.3, 27.0, 90.0, 31.7)]),
    ('buzzer driver', ['U17', 'U18', 'C56', 'C57', 'C58', 'C59', 'R55', 'R56', 'R57', 'R58', 'R59'], [(90.2, 37.3, 103.7, 44.6), (97.4, 31.9, 103.7, 37.2)]),
    ('inputs + tamper', ['Q3', 'D11', 'D12', 'D9', 'D10', 'R50', 'R51', 'R52', 'R53', 'R54'], [(74.3, 27.0, 90.0, 31.7), (65.6, 19.0, 73.9, 26.4), (65.6, 26.6, 73.9, 36.6)]),
]
OVERFLOW = [(65.6, 19.0, 73.9, 36.6), (74.3, 15.0, 97.2, 31.7), (90.2, 27.0, 103.7, 44.6)]
MARGIN = .5
GAP = .15   # required clearance between courtyards (they already include the part's own margin)


def court(f):
    lay = k.B_CrtYd if f.GetLayer() == k.B_Cu else k.F_CrtYd
    boxes = [i.GetBoundingBox() for i in f.GraphicalItems() if i.GetLayer() == lay] or [p.GetBoundingBox() for p in f.Pads()]
    return [min(k.ToMM(bb.GetX()) - 60 for bb in boxes), min(k.ToMM(bb.GetY()) - 50 for bb in boxes),
            max(k.ToMM(bb.GetX() + bb.GetWidth()) - 60 for bb in boxes), max(k.ToMM(bb.GetY() + bb.GetHeight()) - 50 for bb in boxes)]


def place():
    app, b = A.load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    new = [p['ref'] for p in d['parts'] if p.get('group') == 'Interface' and p['ref'] not in ('R37',)] + []
    new = [ref for ref in new if ref in {x for _, refs, _r in REGIONS for x in refs} | set(FIXED)]
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    for ref in new: fps[ref].SetPosition(r.vec([-40, -40]))
    courts = {'F': [], 'B': []}
    for f in b.GetFootprints():
        if f.GetReference() not in new: courts['B' if f.GetLayer() == k.B_Cu else 'F'].append(court(f))
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
        if x0 < 65.55 or y0 < .55 or x1 > 103.85 or y1 > 44.85: return False
        if x0 < 76.6 and y1 > 36.85: return False           # antenna clearance notch
        return True
    def clash(f):
        side = 'B' if f.GetLayer() == k.B_Cu else 'F'; box = court(f)
        if not inside(box): return 'outside'
        if any(not (box[2] <= o[0] + .01 or box[0] >= o[2] - .01 or box[3] <= o[1] + .01 or box[1] >= o[3] - .01) for o in courts[side]): return 'courtyard'
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for L, u, v, ur, un in obstacles:
                if not pd.IsOnLayer(L) or (un == pd.GetNetname() and un): continue
                if r.segment_distance(a, c, u, v) < rad + ur + A.CLEAR: return 'copper ' + un
        return None
    def commit(f):
        side = 'B' if f.GetLayer() == k.B_Cu else 'F'; courts[side].append(court(f))
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for L in (k.F_Cu, k.B_Cu):
                if pd.IsOnLayer(L): obstacles.append((L, a, c, rad, pd.GetNetname()))
    res, unplaced = {}, []
    for ref, (c, ang) in FIXED.items():
        f = fps[ref]
        if ang == 'opening_right':
            for a in (0, 90, 180, 270):
                f.SetOrientationDegrees(a); f.SetPosition(r.vec(c))
                p1 = r.xy(next(p for p in f.Pads() if p.GetNumber() == '1').GetPosition()); mp = r.xy(next(p for p in f.Pads() if p.GetNumber() == 'MP').GetPosition())
                if mp[0] > p1[0] + 1: ang = a; break
        f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
        why = clash(f); res[ref] = {'xy': c, 'angle': ang, 'problem': why, 'courtyard': [round(v, 2) for v in court(f)]}; commit(f)
        parts[ref]['xy'] = c; parts[ref]['angle'] = ang
    def scan(f, rects):
        for X0, Y0, X1, Y1 in rects:
            for ang in (0, 90):
                f.SetOrientationDegrees(ang); f.SetPosition(r.vec([0, 0])); bx = court(f); w, h = bx[2] - bx[0], bx[3] - bx[1]
                if w > X1 - X0 + 1e-6 or h > Y1 - Y0 + 1e-6: continue
                y = Y0
                while y + h <= Y1 + 1e-6:
                    x = X0
                    while x + w <= X1 + 1e-6:
                        f.SetPosition(r.vec([x - bx[0], y - bx[1]]))
                        box = court(f); side = 'B' if f.GetLayer() == k.B_Cu else 'F'
                        if not any(not (box[2] + GAP <= o[0] or box[0] >= o[2] + GAP or box[3] + GAP <= o[1] or box[1] >= o[3] + GAP) for o in courts[side]):
                            if clash(f) is None:
                                return [round(x - bx[0], 3), round(y - bx[1], 3)], ang
                        x += .25
                    y += .25
        return None, None
    for name, refs, rects in REGIONS:
        big = sorted(refs, key=lambda ref: -(lambda b_: (b_[2] - b_[0]) * (b_[3] - b_[1]))(court(fps[ref])))
        for ref in big:
            f = fps[ref]; xy, ang = scan(f, rects)
            if xy is None: xy, ang = scan(f, OVERFLOW)
            if xy is None:
                unplaced.append(ref); f.SetPosition(r.vec([-40, -40])); continue
            f.SetOrientationDegrees(ang); f.SetPosition(r.vec(xy)); commit(f)
            res[ref] = {'xy': xy, 'angle': ang, 'region': name}; parts[ref]['xy'] = xy; parts[ref]['angle'] = ang
    A.save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (OUT / 'v06-placement.json').write_text(json.dumps({'placed': res, 'unplaced': unplaced}, indent=2) + '\n')
    print(json.dumps({'placed': len(res), 'unplaced': unplaced, 'fixed': {k_: v['problem'] for k_, v in res.items() if k_ in FIXED}}))


# ---------------- routing ----------------
WIDTH = {'VIN_RAW': .6, 'VIN_FUSED': .6, 'VIN_PROT': .6, 'SW_BUCK': .6, '5V_FIELD': .5, '3V3': .3, 'NFC_SDA': .15, 'NFC_SCL': .15}
ORDER_FIRST = ['VIN_RAW', 'VIN_FUSED', 'VIN_PROT', 'SW_BUCK', 'BUCK_BOOT', '5V_FIELD', 'BUCK_FB', 'BUCK_EN', 'BUCK_VCC', 'FIELD_PG']


def route():
    app, b = A.load(); d = data(); before = r.track_snapshot(b); pre = set(before)
    newrefs = {p['ref'] for p in d['parts'] if p.get('group') == 'Interface' and p['ref'] != 'R37'}
    pads_by_net = {}; seen = set()
    r_layers = lambda pd: [l for l in (k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu) if pd.IsOnLayer(l)]
    for f in b.GetFootprints():
        if f.GetReference() not in newrefs: continue
        for pd in f.Pads():
            n = pd.GetNetname()
            if not n or n == 'GND' or n.startswith('unconnected') or not pd.GetNumber() or pd.GetNumber() == 'MP': continue
            key = f'{f.GetReference()}.{pd.GetNumber()}'
            if key in seen: continue
            seen.add(key); xy = r.xy(pd.GetPosition())
            pads_by_net.setdefault(n, []).append(({'xy': xy, 'layers': [b.GetLayerName(l) for l in r_layers(pd)], 'name': key}, xy))
    existing = {}
    for t in b.GetTracks():
        n = t.GetNetname()
        if n in pads_by_net and t.m_Uuid.AsString() in pre:
            if isinstance(t, k.PCB_VIA): existing.setdefault(n, []).append(({'xy': r.xy(t.GetPosition()), 'layers': r.ALL_COPPER}, r.xy(t.GetPosition())))
            else:
                a, c = r.xy(t.GetStart()), r.xy(t.GetEnd()); m = max(1, int(math.dist(a, c) / .5))
                for i in range(m + 1):
                    p = [round(a[0] + (c[0] - a[0]) * i / m, 4), round(a[1] + (c[1] - a[1]) * i / m, 4)]
                    existing.setdefault(n, []).append(({'xy': p, 'layers': [b.GetLayerName(t.GetLayer())]}, p))
    for f in b.GetFootprints():
        if f.GetReference() in newrefs: continue
        for pd in f.Pads():
            if pd.GetNetname() in pads_by_net and pd.GetNumber():
                existing.setdefault(pd.GetNetname(), []).append(({'xy': r.xy(pd.GetPosition()), 'layers': [b.GetLayerName(l) for l in r_layers(pd)], 'name': f'{f.GetReference()}.{pd.GetNumber()}'}, r.xy(pd.GetPosition())))
    edges = []
    for n, terms in pads_by_net.items():
        nodes = list(terms); inside = [nodes[0]]; rest = nodes[1:]
        while rest:
            best = min(((math.dist(a[1], c[1]), a, c) for a in inside for c in rest), key=lambda x: x[0])
            edges.append((n, best[1][0], best[2][0], best[0])); inside.append(best[2]); rest.remove(best[2])
        if n in existing:
            cands = sorted(existing[n], key=lambda e: min(math.dist(e[1], t[1]) for t in terms))[:12]
            edges.append((n, 'EXISTING', cands, min(math.dist(cands[0][1], t[1]) for t in terms)))
    def prio(e):
        n = e[0]; return (0 if n in ORDER_FIRST else 1, ORDER_FIRST.index(n) if n in ORDER_FIRST else 0, e[3] if e[1] != 'EXISTING' else 1e3 + e[3])
    edges.sort(key=prio)
    log = {'routes': [], 'failed': [], 'ground': []}
    for i, (n, s, e, dist) in enumerate(edges):
        w = WIDTH.get(n, .2)
        if s == 'EXISTING':
            starts = [t for t, _ in pads_by_net[n]]; starts.sort(key=lambda sp: min(math.dist(sp['xy'], c[1]) for c in e))
            pairs = [(sp, c[0]) for c in e[:6] for sp in starts[:2]]
        else:
            pairs = [(s, e)]
        done = False; err = ''
        for sp, ep in pairs:
            a, sl = r.endpoint(b, sp, n); c, el = r.endpoint(b, ep, n)
            for ww in ([w, .3, .2] if w > .3 else [w]):
                try:
                    legs, vias, visited = r.path(b, n, a, c, ww, ['F.Cu', 'B.Cu', 'In2.Cu'], sl, el, BOUNDS,
                                                 max_vias=4 if s == 'EXISTING' else 2, max_states=700000 if s == 'EXISTING' else 300000, step=.1)
                except RuntimeError as ex:
                    err = str(ex)[:160]; continue
                for vi, p in enumerate(vias): add_via(b, n, p, f'r{i}:via{vi}')
                for li, (L, pts) in enumerate(legs):
                    for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                        if math.dist(x, y) > 1e-8: add_track(b, n, b.GetLayerID(L), x, y, ww, f'r{i}:{li}:{ti}')
                L_ = sum(math.dist(x, y) for _, pts in legs for x, y in zip(pts, pts[1:]))
                log['routes'].append({'i': i, 'net': n, 'from': sp.get('name', sp['xy']), 'to': ep.get('name', ep['xy']), 'w': ww, 'len': round(L_, 2), 'vias': len(vias)})
                print(json.dumps(log['routes'][-1]), flush=True); done = True; break
            if done: break
        if not done:
            log['failed'].append({'i': i, 'net': n, 'from': s.get('name') if isinstance(s, dict) else s, 'to': e.get('name') if isinstance(e, dict) else 'EXISTING', 'err': err}); print(json.dumps({'failed': log['failed'][-1]}), flush=True)
    for f in b.GetFootprints():
        if f.GetReference() not in newrefs: continue
        for pd in f.Pads():
            if pd.GetNetname() != 'GND' or not pd.GetNumber() or pd.GetNumber() == 'MP' and f.GetReference() != 'J5': continue
            if pd.GetAttribute() == k.PAD_ATTRIB_PTH: continue
            spec = f'{f.GetReference()}.{pd.GetNumber()}'; p = r.xy(pd.GetPosition()); sl = ['F.Cu' if pd.IsOnLayer(k.F_Cu) else 'B.Cu']
            L = sl[0]; checks = [r.collision_test(b, 'GND', .5, l, True) for l in r.ALL_COPPER]; stub = r.collision_test(b, 'GND', .25, L)
            for dd, c in sorted((math.hypot(ix * .1, iy * .1), [round(p[0] + ix * .1, 3), round(p[1] + iy * .1, 3)]) for ix in range(-18, 19) for iy in range(-18, 19)):
                if not .55 <= dd <= 1.8 or not (BOUNDS[0] <= c[0] <= BOUNDS[2] and BOUNDS[1] <= c[1] <= BOUNDS[3]): continue
                if c[0] < 76.8 and c[1] > 36.6 and c[0] > 65.4: continue
                if all(ch(c, c) for ch in checks) and stub(p, c):
                    add_via(b, 'GND', c, 'gnd:' + spec + str(p)); add_track(b, 'GND', b.GetLayerID(L), p, c, .25, 'gndt:' + spec + str(p))
                    log['ground'].append({'pad': spec, 'via': c}); break
            else:
                log['failed'].append({'net': 'GND', 'from': spec, 'err': 'NO_LOCAL_GROUND_VIA'})
    now = r.track_snapshot(b); log['preexisting_copper_unchanged'] = all(now.get(u) == v for u, v in before.items())
    A.save(b); log['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v06-routing.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'routed': len(log['routes']), 'edges': len(edges), 'ground': len(log['ground']), 'failed': len(log['failed']), 'preserved': log['preexisting_copper_unchanged']}))


def finish():
    app, b = A.load()
    src = k.LoadBoard(str(ROOT / 'source-v05' / 'fieldnote.kicad_pcb')); orig = {f.GetReference(): f for f in src.GetFootprints()}
    for f in b.GetFootprints():
        o = orig.get(f.GetReference())
        if o: f.SetExcludedFromBOM(o.IsExcludedFromBOM()); f.SetExcludedFromPosFiles(o.IsExcludedFromPosFiles())
    k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b); print(json.dumps({'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}))


if __name__ == '__main__':
    if sys.argv[1] != 'place2': {'surgery': surgery, 'place': place, 'route': route, 'finish': finish}[sys.argv[1]]()


# ---------------- placement v2: anchors + connectivity-driven passives ----------------
ANCHORS = {  # ref: (center, angle)
    'J5': ([106.6, 23.1], 90), 'BZ1': ([83.5, 38.2], 90), 'SW3': ([82.0, 21.0], 0),
    'U12': ([91.0, 5.5], 0), 'L4': ([99.5, 4.6], 0), 'F1': ([106.3, 11.6], 0),
    'U15': ([79.6, 19.6], 0), 'U13': ([79.6, 29.0], 0),
    'U14': ([96.6, 19.4], 90), 'U16': ([95.0, 27.0], 0),
    'U17': ([97.0, 39.6], 0), 'U18': ([103.4, 39.6], 0),
}
POWER_NETS = {'GND', '3V3', '5V_FIELD'}


def place2():
    app, b = A.load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    new = [ref for _, refs, _r in REGIONS for ref in refs] + list(FIXED)
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    for ref in new: fps[ref].SetPosition(r.vec([-40, -40]))
    courts = {'F': [], 'B': []}
    for f in b.GetFootprints():
        if f.GetReference() not in new: courts['B' if f.GetLayer() == k.B_Cu else 'F'].append(court(f))
    obstacles = []
    for t in b.GetTracks():
        for L in ([k.F_Cu, k.B_Cu] if isinstance(t, k.PCB_VIA) else [t.GetLayer()]):
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
        if x0 < 65.55 or y0 < .55 or x1 > 109.85 or y1 > 44.85: return False
        if x0 < 76.6 and y1 > 36.85: return False
        if x0 < 74.2 and y0 < 26.5: return False          # keep the v0.5 strip parts' surroundings free
        return True
    def legal(f):
        side = 'B' if f.GetLayer() == k.B_Cu else 'F'; box = court(f)
        if not inside(box): return False
        if any(not (box[2] + GAP <= o[0] or box[0] >= o[2] + GAP or box[3] + GAP <= o[1] or box[1] >= o[3] + GAP) for o in courts[side]): return False
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for L, u, v, ur, un in obstacles:
                if not pd.IsOnLayer(L) or (un == pd.GetNetname() and un): continue
                if abs(u[0] - a[0]) > 6 and abs(v[0] - a[0]) > 6: continue
                if r.segment_distance(a, c, u, v) < rad + ur + A.CLEAR: return False
        return True
    def commit(f):
        side = 'B' if f.GetLayer() == k.B_Cu else 'F'; courts[side].append(court(f))
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for L in (k.F_Cu, k.B_Cu):
                if pd.IsOnLayer(L): obstacles.append((L, a, c, rad, pd.GetNetname()))
    placed = set(); res = {}; unplaced = []
    def spiral(f, target, angles=(0, 90, 180, 270), rmax=14.0):
        cands = sorted(((math.hypot(ix * .25, iy * .25), ix, iy) for ix in range(-int(rmax * 4), int(rmax * 4) + 1) for iy in range(-int(rmax * 4), int(rmax * 4) + 1)
                        if math.hypot(ix * .25, iy * .25) <= rmax))
        for dist, ix, iy in cands:
            for ang in angles:
                f.SetOrientationDegrees(ang); f.SetPosition(r.vec([target[0] + ix * .25, target[1] + iy * .25]))
                if legal(f): return [round(target[0] + ix * .25, 3), round(target[1] + iy * .25, 3)], ang, dist
        return None, None, None
    for ref, (c, ang) in ANCHORS.items():
        f = fps[ref]; xy, a_, dist = spiral(f, c, (ang,), 6.0)
        if xy is None: unplaced.append(ref); continue
        commit(f); placed.add(ref); res[ref] = {'xy': xy, 'angle': a_, 'moved': round(dist, 2), 'anchor': True}; parts[ref]['xy'] = xy; parts[ref]['angle'] = a_
    net_pads = {}
    for f in b.GetFootprints():
        for pd in f.Pads():
            if pd.GetNetname(): net_pads.setdefault(pd.GetNetname(), []).append((f.GetReference(), pd))
    rest = [ref for ref in new if ref not in placed]
    while rest:
        def score(ref):
            nets = {pd.GetNetname() for pd in fps[ref].Pads()} - POWER_NETS
            return -sum(1 for n in nets for (rr, _) in net_pads.get(n, []) if rr != ref and (rr in placed or rr not in new))
        rest.sort(key=score); ref = rest.pop(0); f = fps[ref]
        pts = []
        for pd in f.Pads():
            n = pd.GetNetname()
            if not n or n in POWER_NETS: continue
            for rr, q in net_pads.get(n, []):
                if rr != ref and (rr in placed or rr not in new): pts.append(r.xy(q.GetPosition()))
        if not pts:
            pts = [r.xy(q.GetPosition()) for pd in f.Pads() for rr, q in net_pads.get(pd.GetNetname(), []) if rr != ref and rr in placed and pd.GetNetname() != 'GND'][:4] or [[88.0, 22.0]]
        target = [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)]
        xy, a_, dist = spiral(f, target)
        if xy is None: unplaced.append(ref); f.SetPosition(r.vec([-40, -40])); continue
        commit(f); placed.add(ref); res[ref] = {'xy': xy, 'angle': a_, 'from_target_mm': round(dist, 2)}; parts[ref]['xy'] = xy; parts[ref]['angle'] = a_
    A.save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    far = {k_: v['from_target_mm'] for k_, v in res.items() if v.get('from_target_mm', 0) > 4}
    (OUT / 'v06-placement.json').write_text(json.dumps({'placed': res, 'unplaced': unplaced, 'far_from_target': far}, indent=2) + '\n')
    print(json.dumps({'placed': len(res), 'unplaced': unplaced, 'far_from_target': far}))


if __name__ == '__main__' and sys.argv[1] == 'place2':
    place2()
