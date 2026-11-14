#!/usr/bin/env python3
"""v0.5.1 layout on top of the routed v0.5 board (source-v05/fieldnote.kicad_pcb). Outline unchanged.

Phases (KiCad python apply_v051_pcb.py <phase>):
  textprep - text edit of the source board: drop the three R16/R17/R18 -> D1/D2/D3 anode stubs and rename
             LED_AMBER -> LED_BLUE (pcbnew deletion in a loop is unreliable, see v0.6 notes).
  surgery  - remove D1/D2/D3, import the 15 new footprints, sync every pad net with design-data.
  place    - D5 fixed on the middle light-guide axis; other parts by legal spiral search in two boxes
             (LED strip above the coil keepout; empty corner below J6). Existing parts never move.
  vsys     - D5 anode to existing VSYS copper. The LED strip is walled off on F.Cu/B.Cu/In2 (In2 LED GPIO runs,
             B.Cu UART_RX/ESP_EN/ESP_RESET_RC, J4 header column), so this is a weighted grid Dijkstra over F/B/In2 plus
             In1 at 40x cost: the result uses In1 (GND plane) only for one short hop, logged with the nets that cross it.
  route    - repo A* router: per net, MST over new pads plus the nearest existing copper; local GND vias.
  finish   - title text, zone refill.
"""
from pathlib import Path
import hashlib, json, math, re, sys
import wx
import pcbnew as k
import route_pn7160 as r
import build_design as g
import apply_v05_pcb as A

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
A.ROOT = ROOT; A.OUT = OUT
V05_BOARD = '1c64f9903f6d2f3be6b658038252d0359edbaed5345d4fb8ba7a5826ac9e5167'
LED = ['D5', 'Q1', 'Q2', 'Q3', 'R38', 'R39', 'R40', 'R41', 'R42', 'R43']
BZR = ['BZ1', 'Q4', 'D6', 'R44', 'C44']
NEW = LED + BZR
BOUNDS = [1.0, .5, 73.6, 44.7]
# Allowed courtyard boxes (board mm, origin = board top-left). LED strip: above the NFC copper-free region
# (y >= 10.7) and clear of the top-edge notch (x 3-11.5, y < 1.6). Buzzer: below J6, above the y = 37 step.
BOXES = {'LED': [(8.0, 2.0, 32.6, 10.45), (11.8, .55, 32.6, 10.45)], 'BZR': [(65.6, 26.3, 73.55, 36.75)]}
FIXED = {'D5': ([20.7, 4.2], 180),          # case light-guide site [22, 8] minus case_offset [1.3, 3.8]
         # buzzer corner, hand-packed: row 1 Q4 | R44 | C44, row 2 D6 | BZ1
         'Q4': ([67.8, 28.2], 0), 'R44': ([70.9, 28.1], 90), 'C44': ([72.78, 27.95], 90),
         'D6': ([66.75, 32.7], 90), 'BZ1': ([71.05, 33.45], 0)}
ANCHORS = {'R38': ([23.8, 5.4], 0), 'Q1': ([16.2, 4.4], 0), 'Q3': ([25.0, 3.0], 0), 'Q2': ([16.0, 8.4], 0)}
GAP = .15


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def data(): return json.loads((ROOT / 'design-data.json').read_text())
def ident(key): return k.KIID(str(__import__('uuid').uuid5(__import__('uuid').NAMESPACE_URL, 'fieldnote-v051:' + key)))


def add_via(b, net, p, key, dia=.5, drill=.2):
    v = k.PCB_VIA(b); v.SetUuid(ident(key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(dia)); v.SetDrill(k.FromMM(drill))
    v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet(net)); v.SetLocked(True)
    v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v); return v


def add_track(b, net, layer, a, c, w, key):
    t = k.PCB_TRACK(b); t.SetUuid(ident(key)); t.SetStart(r.vec(a)); t.SetEnd(r.vec(c)); t.SetLayer(layer)
    t.SetNet(b.FindNet(net)); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t)


def textprep():
    src = ROOT / 'source-v05' / 'fieldnote.kicad_pcb'; assert sha(src) == V05_BOARD
    t = src.read_text()
    blocks = re.findall(r'\n\t\((?:segment|via|arc)\n(?:\t\t.*\n)*?\t\)', t)
    drop = [blk for blk in blocks if re.search(r'\(net "D[123]_ANODE"\)', blk)]
    for blk in drop: t = t.replace(blk, '', 1)
    renamed = t.count('"LED_AMBER"'); t = t.replace('"LED_AMBER"', '"LED_BLUE"')
    ktext = re.findall(r'\n\t\(gr_text "K"\n\t\t\(at (?:68|78|88)\.1 54\.2 0\)\n(?:\t\t.*\n)*?\t\)', t)   # old D1-D3 cathode marks
    assert len(ktext) == 3, len(ktext)
    for blk in ktext: t = t.replace(blk, '', 1)
    (ROOT / 'fieldnote.kicad_pcb').write_text(t)
    rep = {'dropped_anode_stub_items': len(drop), 'removed_K_silk_marks': len(ktext), 'LED_AMBER_to_LED_BLUE_tokens': renamed, 'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v051-textprep.json').write_text(json.dumps(rep, indent=2) + '\n'); print(json.dumps(rep))


def surgery():
    app, b = A.load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    for name in {n for p in d['parts'] for n in p['nets'].values() if n}:
        A.net(b, name)
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    gone = [fps.pop(ref) for ref in ('D1', 'D2', 'D3')]
    for f in gone: b.Remove(f)
    for ref in NEW:
        p = parts[ref]
        f = k.FootprintLoad(str(ROOT / 'Fieldnote.pretty'), p['fp']); assert f, p['fp']
        f.SetReference(ref); f.SetUuid(k.KIID(g.uid(ref))); f.SetFPID(k.LIB_ID('Fieldnote', p['fp'])); b.Add(f)
        f.SetPosition(r.vec([-40, -40]))
        f.SetPath(k.KIID_PATH('/' + g.ROOT_UUID + '/' + g.uid('sheetesp32-leds') + '/' + g.uid(ref)))
        f.Reference().SetTextSize(k.VECTOR2I(k.FromMM(.8), k.FromMM(.8))); f.Reference().SetTextThickness(k.FromMM(.15)); f.Value().SetVisible(False)
        f.SetValue(p['value']); f.SetField('MPN', p['mpn']); f.GetField('MPN').SetVisible(False)
        fps[ref] = f
    changed = 0
    for p in d['parts']:
        f = fps[p['ref']]
        for pd in f.Pads():
            num = pd.GetNumber()
            if not num or num not in p['nets']: continue
            nn = p['nets'][num]; name = p['names'].get(num, num)
            nn = nn or ('unconnected-(' + p['ref'] + '-' + ('' if name == num else name + '-') + 'Pad' + num + ')')
            if pd.GetNetname() != nn: changed += 1
            pd.SetNet(A.net(b, nn)); pd.SetPinFunction(name)
    for item in b.GetDrawings():
        if isinstance(item, k.PCB_TEXT) and 'v0.5' in item.GetText() and item.GetText().startswith('FIELDNOTE'):
            item.SetText(item.GetText().replace('v0.5', 'v0.5.1', 1))
    A.save(b)
    rep = {'removed': ['D1', 'D2', 'D3'], 'imported': NEW, 'pad_nets_changed': changed, 'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v051-surgery.json').write_text(json.dumps(rep, indent=2) + '\n'); print(json.dumps(rep))


def court(f):
    boxes = [i.GetBoundingBox() for i in f.GraphicalItems() if i.GetLayer() == k.F_CrtYd] or [p.GetBoundingBox() for p in f.Pads()]
    return [min(k.ToMM(bb.GetX()) - 60 for bb in boxes), min(k.ToMM(bb.GetY()) - 50 for bb in boxes),
            max(k.ToMM(bb.GetX() + bb.GetWidth()) - 60 for bb in boxes), max(k.ToMM(bb.GetY() + bb.GetHeight()) - 50 for bb in boxes)]


def place():
    app, b = A.load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    for ref in NEW: fps[ref].SetPosition(r.vec([-40, -40]))
    courts = [court(f) for f in b.GetFootprints() if f.GetReference() not in NEW and f.GetLayer() == k.F_Cu and f.GetReference() != 'ANT1']
    courts += [court(f) for f in b.GetFootprints() if f.GetReference() == 'J6']       # THT: blocks both sides
    obstacles = []
    for t in b.GetTracks():
        if isinstance(t, k.PCB_VIA):
            p = r.xy(t.GetPosition()); obstacles.append((k.F_Cu, p, p, k.ToMM(t.GetWidth(k.F_Cu)) / 2, t.GetNetname()))
        elif t.GetLayer() == k.F_Cu:
            obstacles.append((k.F_Cu, r.xy(t.GetStart()), r.xy(t.GetEnd()), k.ToMM(t.GetWidth()) / 2, t.GetNetname()))
    for f in b.GetFootprints():
        if f.GetReference() in NEW: continue
        for pd in f.Pads():
            if pd.IsOnLayer(k.F_Cu):
                a, c, rad = A.pad_segment(pd); obstacles.append((k.F_Cu, a, c, rad + .05, pd.GetNetname()))
    def inside(box, grp):
        return any(box[0] >= X0 and box[1] >= Y0 and box[2] <= X1 and box[3] <= Y1 for X0, Y0, X1, Y1 in BOXES[grp])
    def legal(f, grp):
        box = court(f)
        if not inside(box, grp): return 'outside'
        if any(not (box[2] + GAP <= o[0] or box[0] >= o[2] + GAP or box[3] + GAP <= o[1] or box[1] >= o[3] + GAP) for o in courts): return 'courtyard'
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for L, u, v, ur, un in obstacles:
                if un and un == pd.GetNetname(): continue
                if r.segment_distance(a, c, u, v) < rad + ur + A.CLEAR: return 'copper ' + un
        return None
    def commit(f):
        courts.append(court(f))
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd); obstacles.append((k.F_Cu, a, c, rad, pd.GetNetname()))
    def spiral(f, grp, target, angles=(0, 90, 180, 270), rmax=12.0):
        cands = sorted((math.hypot(ix * .25, iy * .25), ix, iy) for ix in range(-int(rmax * 4), int(rmax * 4) + 1)
                       for iy in range(-int(rmax * 4), int(rmax * 4) + 1) if math.hypot(ix * .25, iy * .25) <= rmax)
        for dist, ix, iy in cands:
            for ang in angles:
                xy = [round(target[0] + ix * .25, 3), round(target[1] + iy * .25, 3)]
                f.SetOrientationDegrees(ang); f.SetPosition(r.vec(xy))
                if legal(f, grp) is None: return xy, ang, dist
        return None, None, None
    grp_of = {ref: ('LED' if ref in LED else 'BZR') for ref in NEW}
    res, unplaced, placed = {}, [], set()
    for ref, (c, ang) in FIXED.items():
        f = fps[ref]; f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c)); why = legal(f, grp_of[ref])
        commit(f); placed.add(ref); res[ref] = {'xy': c, 'angle': ang, 'fixed': True, 'problem': why}
    for ref, (c, ang) in ANCHORS.items():
        f = fps[ref]; xy, a_, dist = spiral(f, grp_of[ref], c, (ang, (ang + 180) % 360, (ang + 90) % 360, (ang + 270) % 360), 6.0)
        if xy is None: unplaced.append(ref); continue
        commit(f); placed.add(ref); res[ref] = {'xy': xy, 'angle': a_, 'moved': round(dist, 2), 'anchor': True}
    net_pads = {}
    for f in b.GetFootprints():
        for pd in f.Pads():
            if pd.GetNetname(): net_pads.setdefault(pd.GetNetname(), []).append((f.GetReference(), pd))
    rest = [ref for ref in NEW if ref not in placed and ref not in unplaced]
    while rest:
        def score(ref):
            nets = {pd.GetNetname() for pd in fps[ref].Pads()} - {'GND', '3V3', 'VSYS'}
            return -sum(1 for n in nets for (rr, _) in net_pads.get(n, []) if rr != ref and (rr in placed or rr not in NEW))
        rest.sort(key=score); ref = rest.pop(0); f = fps[ref]
        pts = [r.xy(q.GetPosition()) for pd in f.Pads() if pd.GetNetname() not in ('GND', 'VSYS')
               for rr, q in net_pads.get(pd.GetNetname(), []) if rr != ref and (rr in placed or rr not in NEW)]
        target = [sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)] if pts else ([20.7, 7.0] if grp_of[ref] == 'LED' else [69.5, 31.0])
        xy, a_, dist = spiral(f, grp_of[ref], target)
        if xy is None: unplaced.append(ref); f.SetPosition(r.vec([-40, -40])); continue
        commit(f); placed.add(ref); res[ref] = {'xy': xy, 'angle': a_, 'from_target_mm': round(dist, 2)}
    for ref, v in res.items(): parts[ref]['xy'] = v['xy']; parts[ref]['angle'] = v['angle']
    A.save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (OUT / 'v051-placement.json').write_text(json.dumps({'placed': res, 'unplaced': unplaced}, indent=2) + '\n')
    print(json.dumps({'placed': len(res), 'unplaced': unplaced, 'fixed_problem': res.get('D5', {}).get('problem')}))


WIDTH = {'VSYS': .3, '3V3': .3, 'BZR_VDD': .3, 'BZR_P': .3}
ORDER_FIRST = ['BZR_VDD', 'BZR_P', '3V3', 'BOOT_IO8', 'LEDR_K', 'LEDG_K', 'LEDB_K', 'LEDR_D', 'LEDG_D', 'LEDB_D']


def via_forbidden(c):
    if c[0] < 33.4 and c[1] > 10.35: return True        # NFC copper-free region
    if c[0] > 32.9 and c[1] > 36.4: return True         # Wi-Fi antenna clearance / board step
    return not (BOUNDS[0] <= c[0] <= BOUNDS[2] and BOUNDS[1] <= c[1] <= BOUNDS[3])


def vsys():
    import heapq
    app, b = A.load(); before = r.track_snapshot(b)
    W = .2; LAY = ['F.Cu', 'B.Cu', 'In2.Cu', 'In1.Cu']; COST = [1, 1, 1, 40]; VIA = 15
    clear = {L: r.collision_test(b, 'VSYS', W, L) for L in LAY}
    vc = [r.collision_test(b, 'VSYS', .5, l, True) for l in r.ALL_COPPER]
    S = .1; X0, Y0, X1, Y1 = 11.5, .5, 62, 30
    nx, ny = int((X1 - X0) / S) + 1, int((Y1 - Y0) / S) + 1
    P = lambda i, j: [round(X0 + i * S, 3), round(Y0 + j * S, 3)]
    goal = set()
    for t in b.GetTracks():
        if t.GetNetname() == 'VSYS' and not isinstance(t, k.PCB_VIA) and t.GetLayer() == k.F_Cu:
            a, c = r.xy(t.GetStart()), r.xy(t.GetEnd()); m = max(1, int(math.dist(a, c) / .1))
            for n in range(m + 1):
                goal.add((0, round((a[0] + (c[0] - a[0]) * n / m - X0) / S), round((a[1] + (c[1] - a[1]) * n / m - Y0) / S)))
    pad = next(p for f in b.GetFootprints() if f.GetReference() == 'D5' for p in f.Pads() if p.GetNumber() == '2')
    sp = r.xy(pad.GetPosition()); start = (0, round((sp[0] - X0) / S), round((sp[1] - Y0) / S))
    dist = {start: 0.}; prev = {}; pq = [(0., start)]; vcache = {}; end = None
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]: continue
        if u in goal: end = u; break
        li, i, j = u; a = P(i, j)
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            v = (li, i + di, j + dj)
            if not (0 <= v[1] < nx and 0 <= v[2] < ny): continue
            nd = d + COST[li] * math.hypot(di, dj)
            if nd < dist.get(v, 1e18) and clear[LAY[li]](a, P(v[1], v[2])):
                dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
        if (i, j) not in vcache: vcache[(i, j)] = (not via_forbidden(a)) and all(ch(a, a) for ch in vc)
        if vcache[(i, j)]:
            for lj in range(len(LAY)):
                v = (lj, i, j); nd = d + VIA
                if lj != li and nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = u; heapq.heappush(pq, (nd, v))
    assert end is not None, 'VSYS unreachable'
    path = [end]
    while path[-1] in prev: path.append(prev[path[-1]])
    path.reverse()
    legs, vias = [], []
    for u, v in zip(path, path[1:]):
        if u[0] != v[0]: vias.append(P(u[1], u[2])); continue
        if legs and legs[-1][0] == LAY[u[0]] and legs[-1][1][-1] == P(u[1], u[2]): legs[-1][1].append(P(v[1], v[2]))
        else: legs.append([LAY[u[0]], [P(u[1], u[2]), P(v[1], v[2])]])
    legs[0][1][0] = sp
    def straight(pts):
        out = [pts[0]]
        for p in pts[1:]:
            if len(out) >= 2:
                d1 = (out[-1][0] - out[-2][0], out[-1][1] - out[-2][1]); d2 = (p[0] - out[-1][0], p[1] - out[-1][1])
                if abs(d1[0] * d2[1] - d1[1] * d2[0]) < 1e-9 and d1[0] * d2[0] + d1[1] * d2[1] > 0: out[-1] = p; continue
            out.append(p)
        return out
    log = {'legs': [], 'vias': vias, 'in1_crossings': []}
    for vi, p in enumerate(vias): add_via(b, 'VSYS', p, f'vsys:via{vi}')
    for li, (L, pts) in enumerate(legs):
        pts = straight(pts)
        for ti, (x, y) in enumerate(zip(pts, pts[1:])): add_track(b, 'VSYS', b.GetLayerID(L), x, y, W, f'vsys:{li}:{ti}')
        log['legs'].append({'layer': L, 'len': round(sum(math.dist(x, y) for x, y in zip(pts, pts[1:])), 2), 'points': pts})
        if L == 'In1.Cu':
            for t in b.GetTracks():
                if isinstance(t, k.PCB_VIA) or t.GetLayer() == k.In1_Cu: continue
                if any(r.segment_distance(r.xy(t.GetStart()), r.xy(t.GetEnd()), x, y) < .6 for x, y in zip(pts, pts[1:])):
                    log['in1_crossings'].append([b.GetLayerName(t.GetLayer()), t.GetNetname()])
    log['in1_crossings'] = sorted(map(list, {tuple(x) for x in log['in1_crossings']}))
    now = r.track_snapshot(b); log['preexisting_copper_unchanged'] = all(now.get(u) == v for u, v in before.items())
    A.save(b); (OUT / 'v051-vsys.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'legs': [(l['layer'], l['len']) for l in log['legs']], 'vias': len(vias), 'in1_crossings': log['in1_crossings'], 'preserved': log['preexisting_copper_unchanged']}))


def route():
    app, b = A.load(); before = r.track_snapshot(b)
    pads_by_net = {}; seen = set()
    r_layers = lambda pd: [l for l in (k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu) if pd.IsOnLayer(l)]
    for f in b.GetFootprints():
        if f.GetReference() not in NEW: continue
        for pd in f.Pads():
            n = pd.GetNetname()
            if not n or n in ('GND', 'VSYS') or n.startswith('unconnected') or not pd.GetNumber(): continue
            key = f'{f.GetReference()}.{pd.GetNumber()}'
            if key in seen: continue
            seen.add(key); xy = r.xy(pd.GetPosition())
            pads_by_net.setdefault(n, []).append(({'xy': xy, 'layers': [b.GetLayerName(l) for l in r_layers(pd)], 'name': key}, xy))
    existing = {}
    for t in b.GetTracks():
        n = t.GetNetname()
        if n not in pads_by_net: continue
        if isinstance(t, k.PCB_VIA): existing.setdefault(n, []).append(({'xy': r.xy(t.GetPosition()), 'layers': r.ALL_COPPER}, r.xy(t.GetPosition())))
        else:
            a, c = r.xy(t.GetStart()), r.xy(t.GetEnd()); m = max(1, int(math.dist(a, c) / .5))
            for i in range(m + 1):
                p = [round(a[0] + (c[0] - a[0]) * i / m, 4), round(a[1] + (c[1] - a[1]) * i / m, 4)]
                existing.setdefault(n, []).append(({'xy': p, 'layers': [b.GetLayerName(t.GetLayer())]}, p))
    for f in b.GetFootprints():
        if f.GetReference() in NEW: continue
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
    prio = lambda e: (ORDER_FIRST.index(e[0]) if e[0] in ORDER_FIRST else len(ORDER_FIRST), e[3] if e[1] != 'EXISTING' else 1e3 + e[3])
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
            for ww in ([w, .2] if w > .2 else [w]):
                try:
                    legs, vias, visited = r.path(b, n, a, c, ww, ['F.Cu', 'B.Cu', 'In2.Cu'], sl, el, BOUNDS,
                                                 max_vias=4 if s == 'EXISTING' else 2, max_states=1500000 if s == 'EXISTING' else 300000, step=.1)
                except RuntimeError as ex:
                    err = str(ex)[:160]; continue
                if any(via_forbidden(p) for p in vias): err = 'via in forbidden region'; continue
                for vi, p in enumerate(vias): add_via(b, n, p, f'r{i}:via{vi}')
                for li, (L, pts) in enumerate(legs):
                    for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                        if math.dist(x, y) > 1e-8: add_track(b, n, b.GetLayerID(L), x, y, ww, f'r{i}:{li}:{ti}')
                L_ = sum(math.dist(x, y) for _, pts in legs for x, y in zip(pts, pts[1:]))
                log['routes'].append({'i': i, 'net': n, 'from': sp.get('name', sp['xy']), 'to': ep.get('name', ep['xy']), 'w': ww, 'len': round(L_, 2), 'vias': len(vias)})
                print(json.dumps(log['routes'][-1]), flush=True); done = True; break
            if done: break
        if not done:
            log['failed'].append({'i': i, 'net': n, 'from': s.get('name') if isinstance(s, dict) else s, 'to': e.get('name') if isinstance(e, dict) else 'EXISTING', 'err': err})
            print(json.dumps({'failed': log['failed'][-1]}), flush=True)
    stitch = {('R2', '2')}   # its F.Cu pour island is cut off by the new VSYS run; give it its own via
    for f in b.GetFootprints():
        if f.GetReference() not in NEW and not any(f.GetReference() == s[0] for s in stitch): continue
        for pd in f.Pads():
            if pd.GetNetname() != 'GND' or not pd.GetNumber(): continue
            if f.GetReference() not in NEW and (f.GetReference(), pd.GetNumber()) not in stitch: continue
            spec = f'{f.GetReference()}.{pd.GetNumber()}'; p = r.xy(pd.GetPosition())
            checks = [r.collision_test(b, 'GND', .5, l, True) for l in r.ALL_COPPER]; stub = r.collision_test(b, 'GND', .25, 'F.Cu')
            for dd, c in sorted((math.hypot(ix * .1, iy * .1), [round(p[0] + ix * .1, 3), round(p[1] + iy * .1, 3)]) for ix in range(-18, 19) for iy in range(-18, 19)):
                if not .5 <= dd <= 1.8 or via_forbidden(c): continue
                if all(ch(c, c) for ch in checks) and stub(p, c):
                    add_via(b, 'GND', c, 'gnd:' + spec); add_track(b, 'GND', k.F_Cu, p, c, .25, 'gndt:' + spec)
                    log['ground'].append({'pad': spec, 'via': c}); break
            else:
                log['failed'].append({'net': 'GND', 'from': spec, 'err': 'NO_LOCAL_GROUND_VIA (pad still joins the F.Cu GND pour)'})
    now = r.track_snapshot(b); log['preexisting_copper_unchanged'] = all(now.get(u) == v for u, v in before.items())
    A.save(b); log['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v051-routing.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'routed': len(log['routes']), 'edges': len(edges), 'ground': len(log['ground']), 'failed': log['failed'], 'preserved': log['preexisting_copper_unchanged']}))


def finish():
    app, b = A.load()
    for f in b.GetFootprints():          # assembly uses BOM/CPL; silk refdes on these small parts only overlaps pads
        if f.GetReference() in NEW: f.Reference().SetVisible(False)
    k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b); print(json.dumps({'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}))


if __name__ == '__main__':
    {'textprep': textprep, 'surgery': surgery, 'place': place, 'vsys': vsys, 'route': route, 'finish': finish}[sys.argv[1]]()
