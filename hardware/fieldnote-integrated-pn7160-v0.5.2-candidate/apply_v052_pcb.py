#!/usr/bin/env python3
"""v0.5.2 layout on top of the routed v0.5.1 board (source-v051/fieldnote.kicad_pcb). Outline unchanged.

Phases (KiCad python apply_v052_pcb.py <phase>):
  textprep - text edit of the source board (pcbnew deletion in a loop is unreliable):
               * rip up the v0.5.1 buzzer-corner copper only (its six routes and three GND vias, found by their
                 deterministic v0.5.1 UUIDs) because the corner is re-packed;
               * extend the three "NFC ..." rule areas from x 1.5 to the left board edge (x 0);
               * add the 4-layer stackup to the board setup.
  surgery  - import the six new footprints, sync every pad net with design-data.
  place    - fixed, legality-checked positions: buzzer corner re-packed (C44 >= 1.5 mm from the edge), supervisor group.
  route    - declared short polylines in the buzzer corner (each segment collision-checked), repo A* router for
             the longer links, local GND vias.
  power    - VBUS / VIN_SEL / 5V_FIELD: widen existing segments in place where clearance allows, add parallel
             copper and parallel vias at the layer changes. Width edits are the only change to pre-existing copper.
  finish   - silkscreen fixes, title text, zone refill.
  audit    - track/via diff against the frozen source, GND island check on the refilled board.
"""
from pathlib import Path
import hashlib, json, math, re, sys, uuid
import wx
import pcbnew as k
import route_pn7160 as r
import build_design as g
import apply_v05_pcb as A

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
A.ROOT = ROOT; A.OUT = OUT
SRC = ROOT / 'source-v051' / 'fieldnote.kicad_pcb'
V051_BOARD = '3fec6983a2fd2b50bad7cfad252955b1100418feadb27d6f56ba4a9e7eabe30d'
BZR_OLD = ['BZ1', 'Q4', 'D6', 'R44', 'C44']
BZR_NEW = ['C45', 'R45', 'D7']
SUP = ['U12', 'R46', 'C46']
NEW = BZR_NEW + SUP
BOUNDS = [1.0, .5, 73.6, 44.7]
BZR_BOX = (65.6, 26.3, 73.55, 36.75)
EDGE_X = 74.0
GAP = .02
# Buzzer corner, hand-packed (board mm). Q4 turned so the drain faces BZ1/D6 and gate/source face up;
# C44 sits 3.5 mm from the edge; gate parts (0402 / SOD-523) fill the strip between C44/R44 and BZ1.
FIXED = {'Q4': ([67.45, 28.35], 270), 'C44': ([70.07, 27.86], 270), 'R44': ([71.85, 28.06], 90),
         'R45': ([70.0, 30.6], 0), 'D7': ([72.25, 30.5], 0), 'C45': ([67.9, 30.83], 0),
         'D6': ([66.6, 32.97], 270), 'BZ1': ([71.05, 33.75], 0)}


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def data(): return json.loads((ROOT / 'design-data.json').read_text())
def ident(key): return k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL, 'fieldnote-v052:' + key)))
def v051_id(key): return str(uuid.uuid5(uuid.NAMESPACE_URL, 'fieldnote-v051:' + key))


def add_via(b, net, p, key, dia=.5, drill=.2):
    v = k.PCB_VIA(b); v.SetUuid(ident(key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(dia)); v.SetDrill(k.FromMM(drill))
    v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet(net)); v.SetLocked(True)
    v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v); return v


def add_track(b, net, layer, a, c, w, key):
    t = k.PCB_TRACK(b); t.SetUuid(ident(key)); t.SetStart(r.vec(a)); t.SetEnd(r.vec(c)); t.SetLayer(layer if isinstance(layer, int) else b.GetLayerID(layer))
    t.SetNet(b.FindNet(net)); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t); return t


STACKUP = '''		(stackup
			(layer "F.SilkS" (type "Top Silk Screen"))
			(layer "F.Paste" (type "Top Solder Paste"))
			(layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))
			(layer "F.Cu" (type "copper") (thickness 0.035))
			(layer "dielectric 1" (type "prepreg") (thickness 0.21) (material "FR4") (epsilon_r 4.4) (loss_tangent 0.02))
			(layer "In1.Cu" (type "copper") (thickness 0.0175))
			(layer "dielectric 2" (type "core") (thickness 1.075) (material "FR4") (epsilon_r 4.6) (loss_tangent 0.02))
			(layer "In2.Cu" (type "copper") (thickness 0.0175))
			(layer "dielectric 3" (type "prepreg") (thickness 0.21) (material "FR4") (epsilon_r 4.4) (loss_tangent 0.02))
			(layer "B.Cu" (type "copper") (thickness 0.035))
			(layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))
			(layer "B.Paste" (type "Bottom Solder Paste"))
			(layer "B.SilkS" (type "Bottom Silk Screen"))
			(copper_finish "ENIG")
			(dielectric_constraints no)
		)
'''


def textprep():
    assert sha(SRC) == V051_BOARD
    t = SRC.read_text()
    # --- rip up the v0.5.1 buzzer-corner copper (routes 0-5 of its route phase and the three GND vias) ---
    ids = {v051_id(f'r{i}:{li}:{ti}') for i in range(6) for li in range(8) for ti in range(40)}
    ids |= {v051_id(f'r{i}:via{vi}') for i in range(6) for vi in range(8)}
    ids |= {v051_id(kind + spec) for kind in ('gnd:', 'gndt:') for spec in ('BZ1.2', 'D6.2', 'C44.2')}
    blocks = re.findall(r'\n\t\((?:segment|via|arc)\n(?:\t\t.*\n)*?\t\)', t)
    drop = []
    for blk in blocks:
        m = re.search(r'\(uuid "([0-9a-f-]+)"\)', blk)
        if m and m.group(1) in ids:
            net = re.search(r'\(net "([^"]*)"\)', blk).group(1)
            assert net in ('BZR_VDD', 'BZR_P', '3V3', 'BOOT_IO8', 'GND'), net
            drop.append({'uuid': m.group(1), 'net': net, 'kind': blk.split('(', 1)[1].split()[0]})
            t = t.replace(blk, '', 1)
    assert len(drop) == 29, len(drop)
    # --- NFC rule areas to the left board edge (KiCad x 61.5 -> 60.0) ---
    zones = re.findall(r'\n\t\(zone\n(?:\t\t.*\n)*?\t\)', t); moved = {}
    for z in zones:
        m = re.search(r'\(name "(NFC [^"]*)"\)', z)
        if not m: continue
        head, sep, tail = z.partition('(polygon')
        poly_end = tail.index('\n\t\t)')
        poly, rest = tail[:poly_end], tail[poly_end:]
        n = len(re.findall(r'\(xy 61\.5 ', poly)); assert n == 2, (m.group(1), n)
        poly = re.sub(r'\(xy 61\.5 ', '(xy 60 ', poly)
        rest = re.sub(r'\n\t\t\(filled_polygon\n(?:\t\t\t.*\n)*?\t\t\)', '', rest)
        t = t.replace(z, head + sep + poly + rest, 1); moved[m.group(1)] = n
    assert len(moved) == 3, moved
    # --- stackup ---
    assert '(stackup' not in t
    t = t.replace('\t(setup\n', '\t(setup\n' + STACKUP, 1)
    (ROOT / 'fieldnote.kicad_pcb').write_text(t)
    rep = {'source_board_sha256': V051_BOARD, 'ripped_v051_buzzer_copper': drop, 'nfc_rule_areas_extended_to_x0': moved,
           'stackup': 'F.Cu 35 um / prepreg 0.21 / In1 17.5 um / core 1.075 / In2 17.5 um / prepreg 0.21 / B.Cu 35 um, 1.6 mm nominal',
           'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v052-textprep.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({'ripped': len(drop), 'nfc_areas': moved, 'stackup': True}))


def surgery():
    app, b = A.load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    for name in sorted({n for p in d['parts'] for n in p['nets'].values() if n}):     # sorted: deterministic net codes
        A.net(b, name)
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    for ref in NEW:
        p = parts[ref]
        f = k.FootprintLoad(str(ROOT / 'Fieldnote.pretty'), p['fp']); assert f, p['fp']
        f.SetReference(ref); f.SetUuid(k.KIID(g.uid(ref))); f.SetFPID(k.LIB_ID('Fieldnote', p['fp'])); b.Add(f)
        f.SetPosition(r.vec([-40, -40]))
        f.SetPath(k.KIID_PATH('/' + g.ROOT_UUID + '/' + g.uid('sheetesp32-leds') + '/' + g.uid(ref)))
        f.Reference().SetTextSize(k.VECTOR2I(k.FromMM(.8), k.FromMM(.8))); f.Reference().SetTextThickness(k.FromMM(.15)); f.Value().SetVisible(False)
        f.SetValue(p['value']); f.SetField('MPN', p['mpn']); f.GetField('MPN').SetVisible(False)
        for i, item in enumerate(list(f.GetFields()) + list(f.Pads()) + list(f.GraphicalItems()) + list(f.Zones())):
            item.SetUuid(ident(f'{ref}:sub{i}'))                       # FootprintLoad gives random sub-item UUIDs
        fps[ref] = f
    changed = []
    for p in d['parts']:
        f = fps[p['ref']]
        for pd in f.Pads():
            num = pd.GetNumber()
            if not num or num not in p['nets']: continue
            nn = p['nets'][num]; name = p['names'].get(num, num)
            nn = nn or ('unconnected-(' + p['ref'] + '-' + ('' if name == num else name + '-') + 'Pad' + num + ')')
            if pd.GetNetname() != nn and p['ref'] not in NEW: changed.append([p['ref'], num, pd.GetNetname(), nn])
            pd.SetNet(A.net(b, nn)); pd.SetPinFunction(name)
    for item in b.GetDrawings():
        if isinstance(item, k.PCB_TEXT) and 'v0.5.1' in item.GetText() and item.GetText().startswith('FIELDNOTE'):
            item.SetText(item.GetText().replace('v0.5.1', 'v0.5.2', 1))
    A.save(b)
    rep = {'imported': NEW, 'existing_pad_nets_changed': changed, 'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v052-surgery.json').write_text(json.dumps(rep, indent=2) + '\n'); print(json.dumps(rep))


def court(f):
    lay = k.F_CrtYd if f.GetLayer() == k.F_Cu else k.B_CrtYd
    boxes = [i.GetBoundingBox() for i in f.GraphicalItems() if i.GetLayer() == lay] or [p.GetBoundingBox() for p in f.Pads()]
    return [min(k.ToMM(bb.GetX()) - 60 for bb in boxes), min(k.ToMM(bb.GetY()) - 50 for bb in boxes),
            max(k.ToMM(bb.GetX() + bb.GetWidth()) - 60 for bb in boxes), max(k.ToMM(bb.GetY() + bb.GetHeight()) - 50 for bb in boxes)]


def cpoly(f):
    f.BuildCourtyardCaches()
    return k.SHAPE_POLY_SET(f.GetCourtyard(k.F_CrtYd if f.GetLayer() == k.F_Cu else k.B_CrtYd))


OUTLINE = [[0, 0], [3, 0], [3, 1.6], [11.5, 1.6], [11.5, 0], [47, 0], [47, -2], [60, -2], [60, 0], [74, 0], [74, 37],
           [65.5, 37], [65.5, 45.2], [61.5, 45.2], [61.5, 38.7], [48.1, 38.7], [48.1, 45.2], [0, 45.2]]   # Edge.Cuts, board mm
EDGE_CLEAR = .3          # courtyard / copper to the routed edge (rule .25)


def edge_distance(p):
    return min(r.point_segment(p, a, c) for a, c in zip(OUTLINE, OUTLINE[1:] + OUTLINE[:1]))


def legality(b, movable):
    """Courtyard (real polygons, GAP margin), board-outline and front-copper legality test for the footprints being placed.
    J6 is a back-side THT header: its back courtyard does not block front parts, but its pads (on every copper layer) are
    copper obstacles and its plated holes must stay outside front courtyards (DRC pth_inside_courtyard)."""
    courts = {f.GetReference(): (court(f), cpoly(f)) for f in b.GetFootprints()
              if f.GetReference() not in movable and f.GetReference() != 'ANT1' and f.GetLayer() == k.F_Cu}
    holes = []
    for f in b.GetFootprints():
        if f.GetLayer() == k.B_Cu:
            for pd in f.Pads():
                if pd.GetDrillSize().x > 0:
                    c = r.xy(pd.GetPosition()); rad = k.ToMM(pd.GetDrillSize().x) / 2; h = k.SHAPE_POLY_SET(); h.NewOutline()
                    for i in range(16):
                        h.Append(int(k.FromMM(c[0] + 60 + rad * math.cos(i * math.pi / 8))), int(k.FromMM(c[1] + 50 + rad * math.sin(i * math.pi / 8))))
                    holes.append((f.GetReference(), h))
    obstacles = []
    for t in b.GetTracks():
        if isinstance(t, k.PCB_VIA):
            p = r.xy(t.GetPosition()); obstacles.append((p, p, k.ToMM(t.GetWidth(k.F_Cu)) / 2, t.GetNetname()))
        elif t.GetLayer() == k.F_Cu:
            obstacles.append((r.xy(t.GetStart()), r.xy(t.GetEnd()), k.ToMM(t.GetWidth()) / 2, t.GetNetname()))
    for f in b.GetFootprints():
        if f.GetReference() in movable: continue
        for pd in f.Pads():
            if pd.IsOnLayer(k.F_Cu):
                a, c, rad = A.pad_segment(pd); obstacles.append((a, c, rad + .05, pd.GetNetname()))
    keep = []
    for z in b.Zones():
        if z.GetIsRuleArea() and z.IsOnLayer(k.F_Cu) and (z.GetDoNotAllowTracks() or z.GetDoNotAllowPads()):
            ol = z.Outline().Outline(0); keep.append([r.xy(ol.CPoint(i)) for i in range(ol.PointCount())])

    def legal(f, box=None):
        cb = court(f); e = 1e-6
        if box and not (cb[0] >= box[0] - e and cb[1] >= box[1] - e and cb[2] <= box[2] + e and cb[3] <= box[3] + e): return 'outside box'
        if not (BOUNDS[0] <= cb[0] and BOUNDS[1] <= cb[1] and cb[2] <= BOUNDS[2] and cb[3] <= BOUNDS[3]): return 'outside board'
        corners = ([cb[0], cb[1]], [cb[2], cb[1]], [cb[2], cb[3]], [cb[0], cb[3]])
        if not all(r.inside(p, OUTLINE) for p in corners): return 'outside outline'
        rect = list(corners)
        if any(r.segment_distance(a, c, u, v) < EDGE_CLEAR for a, c in zip(rect, rect[1:] + rect[:1])
               for u, v in zip(OUTLINE, OUTLINE[1:] + OUTLINE[:1])): return 'edge'
        mine = None
        for ref, (o, op) in courts.items():
            if cb[2] + GAP <= o[0] or cb[0] >= o[2] + GAP or cb[3] + GAP <= o[1] or cb[1] >= o[3] + GAP: continue
            mine = mine or cpoly(f)
            if mine.Collide(op, k.FromMM(GAP)): return 'courtyard ' + ref
        for ref, h in holes:
            mine = mine or cpoly(f)
            if mine.Collide(h, k.FromMM(.1)): return 'hole ' + ref
        if any(r.inside(p, poly) for poly in keep for p in corners): return 'keepout'
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for u, v, ur, un in obstacles:
                if un and un == pd.GetNetname(): continue
                if r.segment_distance(a, c, u, v) < rad + ur + A.CLEAR: return 'copper ' + un
        return None

    def commit(f):
        courts[f.GetReference()] = (court(f), cpoly(f))
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd); obstacles.append((a, c, rad, pd.GetNetname()))
    return legal, commit


# Supervisor group, legality-searched on a 0.05 mm grid (scratch search, see README): the only legal U12 site near the reset RC
# node is between the USB_HIGH_CURRENT F.Cu run and the J6 tails; C46 sits on its VDD pin, R46 left of USB_HIGH_CURRENT.
SUP_FIXED = {'U12': ([67.55, 24.35], 90), 'C46': ([67.75, 21.35], 90), 'R46': ([65.1, 24.9], 90)}


def place():
    app, b = A.load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    moving = list(FIXED) + list(SUP_FIXED)
    before = {ref: [r.xy(fps[ref].GetPosition()), fps[ref].GetOrientationDegrees()] for ref in BZR_OLD}
    for ref in moving: fps[ref].SetPosition(r.vec([-40, -40]))
    legal, commit = legality(b, set(moving))
    res = {}
    for ref, (c, ang) in list(FIXED.items()) + list(SUP_FIXED.items()):
        f = fps[ref]; f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
        why = legal(f, BZR_BOX if ref in FIXED else None); commit(f)
        res[ref] = {'xy': c, 'angle': ang, 'problem': why}
        if ref in before: res[ref]['was'] = before[ref]
        parts[ref]['xy'] = c; parts[ref]['angle'] = ang
    body = fps['C44'].GetBoundingBox(False, False)
    c44 = fps['C44']; cx = r.xy(c44.GetPosition())[0]
    edge = {'C44_body_to_right_edge_mm': round(EDGE_X - (cx + .4), 3),
            'C44_pad_copper_to_right_edge_mm': round(EDGE_X - max(k.ToMM(p.GetBoundingBox().GetRight()) - 60 for p in c44.Pads()), 3),
            'R44_body_to_right_edge_mm': round(EDGE_X - (r.xy(fps['R44'].GetPosition())[0] + .625), 3)}
    A.save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (OUT / 'v052-placement.json').write_text(json.dumps({'placed': res, 'edge_distances': edge}, indent=2) + '\n')
    problems = {k_: v['problem'] for k_, v in res.items() if v['problem']}
    print(json.dumps({'placed': len(res), 'problems': problems, **edge}))
    assert not problems, problems
    assert edge['C44_body_to_right_edge_mm'] >= 1.5



# ---------------------------------------------------------------- power path ----------------------------------------------
POWER_NETS = ['5V_FIELD', 'VBUS', 'VIN_SEL']
SENSE_PADS = {('R1', '1'), ('R33', '1'), ('U5', '5'), ('R31', '1')}     # low-current taps: their stubs keep their width
WIDTHS = [1.0, .9, .8, .7, .6, .55, .5, .45, .4]
NECKS = [.3, .45, .6, .8, 1.0, 1.3]
EXTRA_VIAS = {'VBUS': [[67.025, 3.7], [68.625, 5.3]], '5V_FIELD': [[72.47, 8.8]]}
# Parallel B.Cu copper where the existing run cannot be widened: 5V_FIELD In2 run (boxed in by an In2 neighbour) gets a B.Cu
# twin from its F->In2 via to the J6.2 THT pad; VBUS gets a B.Cu twin of its J1 -> C41 F.Cu run (0.30/0.35 mm, no room).
# J6.2 is fenced on B.Cu by the NFC_SCL run (x 71.85), so the 5V_FIELD twin may drop to F.Cu through one via next to J6.
PARALLEL = [{'net': '5V_FIELD', 'from': [72.47, 8.8], 'to': 'J6.2', 'layers': ['B.Cu', 'F.Cu'], 'max_vias': 1, 'bounds': [66.0, 6.0, 73.7, 26.0]},
            {'net': 'VBUS', 'via_on': ([59.4, 3.3898], [62.9, 3.3898]), 'to': [66.325, 3.65], 'layers': ['B.Cu'], 'bounds': [57.0, .5, 70.0, 8.0]}]


def via_spacing_ok(b, cxy, size, ends_net=None):
    """Hole-to-hole >= 0.25 mm (+10 um) to every drilled hole, and no other track end inside the new via's copper
    (KiCad warns 'track not centred on via')."""
    for tr in b.GetTracks():
        if isinstance(tr, k.PCB_VIA):
            if math.dist(r.xy(tr.GetPosition()), cxy) < size[1] / 2 + k.ToMM(tr.GetDrillValue()) / 2 + .26: return False
        elif any(math.dist(e, cxy) < size[0] / 2 + .02 for e in (r.xy(tr.GetStart()), r.xy(tr.GetEnd()))): return False
    for f in b.GetFootprints():
        for pd in f.Pads():
            if pd.GetDrillSize().x and math.dist(r.xy(pd.GetPosition()), cxy) < size[1] / 2 + k.ToMM(pd.GetDrillSize().x) / 2 + .26: return False
    return True


def parallel_vias(b, net, vp, key, count):
    """Add up to `count` vias 0.7-1.5 mm from the via at vp, each tied to it by 0.5 mm stubs on every layer where the net's
    tracks meet that via. Larger 0.6/0.3 first, 0.5/0.2 where only that fits."""
    layers = sorted({tr.GetLayer() for tr in b.GetTracks() if tr.GetNetname() == net and not isinstance(tr, k.PCB_VIA)
                     and (math.dist(r.xy(tr.GetStart()), vp) < 2e-3 or math.dist(r.xy(tr.GetEnd()), vp) < 2e-3)})
    out, added = [], 0
    cands = sorted((math.hypot(ix * .05, iy * .05), [round(vp[0] + ix * .05, 3), round(vp[1] + iy * .05, 3)]) for ix in range(-30, 31) for iy in range(-30, 31))
    for size in ((.6, .3), (.5, .2)):
        vchk = [r.collision_test(b, net, size[0], l, True) for l in r.ALL_COPPER]
        for dd, cxy in cands:
            if added >= count: return out
            if dd < .7 or dd > 1.5 or via_forbidden(cxy) or not all(ch(cxy, cxy) for ch in vchk): continue
            if not via_spacing_ok(b, cxy, size): continue
            if not all(r.collision_test(b, net, .5, b.GetLayerName(l))(cxy, vp) for l in layers): continue
            add_via(b, net, cxy, f'{key}:{added}', *size)
            for l in layers: add_track(b, net, l, vp, cxy, .5, f'{key}:{added}:{l}')
            out.append({'net': net, 'at': vp, 'new_via': cxy, 'size': list(size), 'stub_layers': [b.GetLayerName(l) for l in layers], 'stub_width': .5})
            added += 1; vchk = [r.collision_test(b, net, size[0], l, True) for l in r.ALL_COPPER]
    return out


def via_forbidden(c):
    if c[0] < 33.4 and c[1] > 10.35: return True        # NFC copper-free region (now to the left edge)
    if c[0] > 32.9 and c[1] > 36.4: return True         # Wi-Fi antenna clearance / board step
    return not (BOUNDS[0] <= c[0] <= BOUNDS[2] and BOUNDS[1] <= c[1] <= BOUNDS[3]) or edge_distance(c) < .55


def ipc2221_amps(width_mm, oz, inner, dt=10.0):
    """IPC-2221 trace current for a temperature rise dt (conservative; IPC-2152 allows more on inner layers)."""
    area_mil2 = width_mm / .0254 * oz * 1.378
    return round((.024 if inner else .048) * dt ** .44 * area_mil2 ** .725, 2)


def copper_graph(b, net):
    """Nodes = connection points (track ends merged per layer, vias and pads join layers); edges = tracks."""
    tracks = [t for t in b.GetTracks() if t.GetNetname() == net and not isinstance(t, k.PCB_VIA)]
    vias = [r.xy(t.GetPosition()) for t in b.GetTracks() if t.GetNetname() == net and isinstance(t, k.PCB_VIA)]
    pads = [(f.GetReference(), pd) for f in b.GetFootprints() for pd in f.Pads() if pd.GetNetname() == net and pd.GetNumber()]
    def node(p, layer):
        for ref, pd in pads:
            if A.pad_touches(pd, p, layer): return ('pad', ref, pd.GetNumber())
        for v in vias:
            if math.dist(v, p) < 2e-3: return ('via', round(v[0], 3), round(v[1], 3))
        return ('pt', layer, round(p[0], 3), round(p[1], 3))
    edges = {}
    for tr in tracks:
        edges[tr.m_Uuid.AsString()] = (node(r.xy(tr.GetStart()), tr.GetLayer()), node(r.xy(tr.GetEnd()), tr.GetLayer()), tr)
    return edges


def branch_tracks(b, net):
    edges = copper_graph(b, net); inc = {}
    for u, (a, c, tr) in edges.items():
        inc.setdefault(a, []).append(u); inc.setdefault(c, []).append(u)
    out = set()
    for a in list(inc):
        if a[0] != 'pad' or (a[1], a[2]) not in SENSE_PADS: continue
        cur, seen = a, set()
        for u in inc[a]:
            if edges[u][0] == edges[u][1] == a: seen.add(u); out.add(u)
        while True:
            nxt = [u for u in inc.get(cur, []) if u not in seen]
            if len(nxt) != 1: break
            u = nxt[0]; seen.add(u); out.add(u)
            e = edges[u]; cur = e[1] if e[0] == cur else e[0]
            if cur[0] == 'pad' or len(inc.get(cur, [])) != 2: break
    return out


def outline_ok(a, c, w):
    return all(r.segment_distance(a, c, u, v) >= w / 2 + .25 + .03 for u, v in zip(OUTLINE, OUTLINE[1:] + OUTLINE[:1])) and r.inside(a, OUTLINE) and r.inside(c, OUTLINE)


def add_parallel(b, net, spec, log):
    if 'via_on' in spec:                             # new via on an existing run, legal on every layer
        (sa, sc), size = spec['via_on'], (.6, .3)
        vchk = [r.collision_test(b, net, size[0], l, True) for l in r.ALL_COPPER]
        n = math.dist(sa, sc); m = int(n / .05)
        pts = [[round(sa[0] + (sc[0] - sa[0]) * i / m, 4), round(sa[1] + (sc[1] - sa[1]) * i / m, 4)] for i in range(m + 1)]
        start = next(q for q in pts if not via_forbidden(q) and all(ch(q, q) for ch in vchk) and via_spacing_ok(b, q, size))
        add_via(b, net, start, f'pp:{net}:via', *size)
    else:
        start = spec['from']
    end, el = r.endpoint(b, spec['to'], net) if isinstance(spec['to'], str) else (spec['to'], r.ALL_COPPER)
    for w in (.8, .7, .6, .5, .4):
        try:
            legs, vias, _ = r.path(b, net, start, end, w, spec['layers'], r.ALL_COPPER, el, spec['bounds'],
                                   max_vias=spec.get('max_vias', 0), max_states=1500000, step=.05)
        except RuntimeError:
            continue
        if any(via_forbidden(q) for q in vias) or not all(outline_ok(x, y, w) for _, q in legs for x, y in zip(q, q[1:])): continue
        for vi, q in enumerate(vias): add_via(b, net, q, f'pp:{net}:v{vi}')            # router-checked 0.5/0.2
        for li, (L, q) in enumerate(legs):
            for ti, (x, y) in enumerate(zip(q, q[1:])): add_track(b, net, b.GetLayerID(L), x, y, w, f'pp:{net}:{li}:{ti}')
        log['parallel'].append({'net': net, 'from': start, 'to': spec['to'], 'route_width': w, 'vias': [list(q) for q in vias],
                                'len': round(sum(math.dist(x, y) for _, q in legs for x, y in zip(q, q[1:])), 2), 'legs': legs})
        for vi, q in enumerate(vias + ([start] if 'via_on' in spec else [])):
            log['vias'] += parallel_vias(b, net, list(q), f'ppv:{net}:{vi}', 1)
        return
    log['parallel'].append({'net': net, 'to': spec['to'], 'failed': True})


def widen(b, net, log, before):
    skip = branch_tracks(b, net); log['skipped_sense_taps'][net] = sorted(skip)
    checks = {}
    def ok(layer, w, a, c):
        key = (layer, w)
        if key not in checks: checks[key] = r.collision_test(b, net, w, layer)
        return outline_ok(a, c, w) and checks[key](a, c)
    tracks = sorted((tr for tr in b.GetTracks() if tr.GetNetname() == net and not isinstance(tr, k.PCB_VIA)), key=lambda x: x.m_Uuid.AsString())
    pad_pts = [pd for f in b.GetFootprints() for pd in f.Pads() if pd.GetNetname() == net and pd.GetNumber()]
    via_pts = [r.xy(v.GetPosition()) for v in b.GetTracks() if isinstance(v, k.PCB_VIA)]
    for tr in tracks:
        uid = tr.m_Uuid.AsString(); L = b.GetLayerName(tr.GetLayer()); w0 = round(k.ToMM(tr.GetWidth()), 4)
        a, c = r.xy(tr.GetStart()), r.xy(tr.GetEnd()); n = math.dist(a, c); new = uid not in before
        if uid in skip or n < 1e-6: continue
        touched = [pd for pd in pad_pts if A.pad_touches(pd, a, tr.GetLayer()) or A.pad_touches(pd, c, tr.GetLayer())]
        cap = min([min(k.ToMM(pd.GetSize(k.F_Cu).x), k.ToMM(pd.GetSize(k.F_Cu).y)) for pd in touched if not pd.GetDrillSize().x] or [9])
        best = next((w for w in WIDTHS if w0 + 1e-6 < w <= cap + 1e-6 and ok(L, w, a, c)), None)
        if best:
            tr.SetWidth(k.FromMM(best)); log['segments'].append({'uuid': uid, 'net': net, 'layer': L, 'from': w0, 'to': best, 'len': round(n, 3), 'new': new}); continue
        # necks: keep the original width for a short length at one or both ends (next to a small pad or a local obstacle)
        # and widen the middle; small pads (cap) force a neck at their end.
        pa = any(min(k.ToMM(pd.GetSize(k.F_Cu).x), k.ToMM(pd.GetSize(k.F_Cu).y)) < 9 and not pd.GetDrillSize().x and A.pad_touches(pd, a, tr.GetLayer()) for pd in pad_pts)
        pc = any(not pd.GetDrillSize().x and A.pad_touches(pd, c, tr.GetLayer()) for pd in pad_pts)
        cfg = None
        for d1 in [0] + NECKS:
            for d2 in [0] + NECKS:
                if d1 == d2 == 0 or d1 + d2 > n - .3: continue
                m1 = [round(a[0] + (c[0] - a[0]) * d1 / n, 4), round(a[1] + (c[1] - a[1]) * d1 / n, 4)]
                m2 = [round(c[0] + (a[0] - c[0]) * d2 / n, 4), round(c[1] + (a[1] - c[1]) * d2 / n, 4)]
                if any(0 < math.dist(m, v) < .35 for m in ([m1] if d1 else []) + ([m2] if d2 else []) for v in via_pts): continue
                lim = min(cap if ((d1 == 0 and pa) or (d2 == 0 and pc)) else 9, 9)
                w = next((w for w in WIDTHS if w0 + .1 - 1e-6 <= w <= lim + 1e-6 and ok(L, w, m1, m2)), None)
                if w and (cfg is None or (w, -(d1 + d2)) > (cfg[0], -(cfg[1] + cfg[2]))): cfg = (w, d1, d2, m1, m2)
        done = cfg is not None
        if done:
            w, d1, d2, m1, m2 = cfg
            pts = [a] + ([m1] if d1 else []) + ([m2] if d2 else []) + [c]
            widths = ([w0] if d1 else []) + [w] + ([w0] if d2 else [])
            tr.SetStart(r.vec(pts[0])); tr.SetEnd(r.vec(pts[1])); tr.SetWidth(k.FromMM(widths[0]))
            for pi, (x, y) in enumerate(zip(pts[1:], pts[2:])):
                add_track(b, net, tr.GetLayer(), x, y, widths[pi + 1], f'pw:{uid}:{pi}')
            log['splits'].append({'uuid': uid, 'net': net, 'layer': L, 'neck_start_mm': d1, 'neck_end_mm': d2, 'neck_width': w0,
                                  'middle_width': w, 'len': round(n, 3), 'new': new})
        if not done: log['segments'].append({'uuid': uid, 'net': net, 'layer': L, 'from': w0, 'to': w0, 'len': round(n, 3), 'new': new, 'note': 'no clearance'})


def power():
    """Per net: parallel vias at the existing layer changes, parallel twin copper where the run cannot widen, then widen every
    segment (original and new) to the widest legal value. Only power-net copper changes."""
    app, b = A.load(); before = r.track_snapshot(b)
    log = {'segments': [], 'splits': [], 'vias': [], 'parallel': [], 'skipped_sense_taps': {}}
    for net in POWER_NETS:
        for vi, vp in enumerate(EXTRA_VIAS.get(net, [])):
            log['vias'] += parallel_vias(b, net, vp, f'pv:{net}:{vi}', 2)
        for spec in PARALLEL:
            if spec['net'] == net: add_parallel(b, net, spec, log)
        widen(b, net, log, before)
    now = r.track_snapshot(b)
    changed = [u for u, v in before.items() if u in now and now[u] != v]
    bad = [u for u in changed if before[u]['net'] not in POWER_NETS] + [u for u in before if u not in now]
    assert not bad, bad
    A.save(b); log['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v052-power.json').write_text(json.dumps(log, indent=2) + '\n')
    widened = [s for s in log['segments'] if s['to'] > s['from']]
    print(json.dumps({'widened': len(widened), 'unchanged': len(log['segments']) - len(widened), 'splits': len(log['splits']), 'vias': len(log['vias']),
                      'parallel': [(x['net'], x.get('route_width'), x.get('len'), x.get('failed')) for x in log['parallel']]}))


# ---------------------------------------------------------------- routing ---------------------------------------------------
GROUP = {**{ref: 'BZR' for ref in BZR_OLD + BZR_NEW}, **{ref: 'SUP' for ref in SUP}}
WIDTH = {'BZR_VDD': .3, 'BZR_P': .3, '3V3': .3}
ORDER_FIRST = ['BZR_P', 'BZR_VDD', 'BZR_GATE', 'BOOT_IO8', 'SUP_RESET_N', '3V3', 'ESP_RESET_RC']


def route_bounds(pts):
    x0 = max(BOUNDS[0], min(p[0] for p in pts) - 6); x1 = min(BOUNDS[2], max(p[0] for p in pts) + 6)
    y0 = max(BOUNDS[1], min(p[1] for p in pts) - 6); y1 = min(BOUNDS[3], max(p[1] for p in pts) + 6)
    if x1 > 65.2: y1 = min(y1, 36.6)
    return [x0, y0, x1, y1]


def route():
    app, b = A.load(); before = r.track_snapshot(b)
    r_layers = lambda pd: [l for l in (k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu) if pd.IsOnLayer(l)]
    terms = {}
    for f in b.GetFootprints():
        ref = f.GetReference()
        if ref not in GROUP: continue
        for pd in f.Pads():
            n = pd.GetNetname()
            if not n or n == 'GND' or n.startswith('unconnected') or not pd.GetNumber(): continue
            xy = r.xy(pd.GetPosition())
            terms.setdefault((n, GROUP[ref]), []).append(({'xy': xy, 'layers': [b.GetLayerName(l) for l in r_layers(pd)], 'name': f'{ref}.{pd.GetNumber()}'}, xy))
    existing = {}
    for tr in b.GetTracks():
        n = tr.GetNetname()
        if not any(n == key[0] for key in terms): continue
        if isinstance(tr, k.PCB_VIA): existing.setdefault(n, []).append(({'xy': r.xy(tr.GetPosition()), 'layers': r.ALL_COPPER}, r.xy(tr.GetPosition())))
        else:
            a, c = r.xy(tr.GetStart()), r.xy(tr.GetEnd()); m = max(1, int(math.dist(a, c) / .5))
            for i in range(m + 1):
                q = [round(a[0] + (c[0] - a[0]) * i / m, 4), round(a[1] + (c[1] - a[1]) * i / m, 4)]
                existing.setdefault(n, []).append(({'xy': q, 'layers': [b.GetLayerName(tr.GetLayer())]}, q))
    for f in b.GetFootprints():
        if f.GetReference() in GROUP: continue
        for pd in f.Pads():
            if any(pd.GetNetname() == key[0] for key in terms) and pd.GetNumber():
                existing.setdefault(pd.GetNetname(), []).append(({'xy': r.xy(pd.GetPosition()), 'layers': [b.GetLayerName(l) for l in r_layers(pd)],
                                                                  'name': f'{f.GetReference()}.{pd.GetNumber()}'}, r.xy(pd.GetPosition())))
    edges = []
    for (n, grp), nodes in sorted(terms.items()):
        inside, rest = [nodes[0]], list(nodes[1:])
        while rest:
            best = min(((math.dist(a[1], c[1]), a, c) for a in inside for c in rest), key=lambda x: x[0])
            edges.append((n, grp, best[1][0], best[2][0], best[0])); inside.append(best[2]); rest.remove(best[2])
        if n in existing:
            cands = sorted(existing[n], key=lambda e: min(math.dist(e[1], t_[1]) for t_ in nodes))[:12]
            edges.append((n, grp, 'EXISTING', cands, min(math.dist(cands[0][1], t_[1]) for t_ in nodes)))
    prio = lambda e: (ORDER_FIRST.index(e[0]) if e[0] in ORDER_FIRST else len(ORDER_FIRST), e[4] if e[2] != 'EXISTING' else 1e3 + e[4])
    edges.sort(key=prio)
    log = {'routes': [], 'failed': [], 'ground': []}
    for i, (n, grp, s, e, dist) in enumerate(edges):
        w = WIDTH.get(n, .2)
        if s == 'EXISTING':
            starts = [t_ for t_, _ in terms[(n, grp)]]; starts.sort(key=lambda sp: min(math.dist(sp['xy'], c[1]) for c in e))
            pairs = [(sp, c[0]) for c in e[:6] for sp in starts[:2]]
        else:
            pairs = [(s, e)]
        done, err = False, ''
        for sp, ep in pairs:
            a, sl = r.endpoint(b, sp, n); c, el = r.endpoint(b, ep, n)
            for ww in ([w, .2] if w > .2 else [w]):
                try:
                    legs, vias, visited = r.path(b, n, a, c, ww, ['F.Cu', 'B.Cu', 'In2.Cu'], sl, el, route_bounds([a, c]),
                                                 max_vias=4 if s == 'EXISTING' else 2, max_states=1500000 if s == 'EXISTING' else 400000, step=.05)
                except RuntimeError as ex:
                    err = str(ex)[:160]; continue
                if any(via_forbidden(q) for q in vias): err = 'via in forbidden region'; continue
                if not all(outline_ok(x, y, ww) for _, pts in legs for x, y in zip(pts, pts[1:])): err = 'edge clearance'; continue
                for vi, q in enumerate(vias): add_via(b, n, q, f'r{i}:via{vi}')
                for li, (L, pts) in enumerate(legs):
                    for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                        if math.dist(x, y) > 1e-8: add_track(b, n, b.GetLayerID(L), x, y, ww, f'r{i}:{li}:{ti}')
                L_ = sum(math.dist(x, y) for _, pts in legs for x, y in zip(pts, pts[1:]))
                log['routes'].append({'i': i, 'net': n, 'group': grp, 'from': sp.get('name', sp['xy']), 'to': ep.get('name', ep['xy']), 'w': ww,
                                      'len': round(L_, 2), 'vias': [list(q) for q in vias], 'layers': [L for L, _ in legs]})
                print(json.dumps(log['routes'][-1]), flush=True); done = True; break
            if done: break
        if not done:
            log['failed'].append({'i': i, 'net': n, 'group': grp, 'from': s.get('name') if isinstance(s, dict) else s,
                                  'to': e.get('name') if isinstance(e, dict) else 'EXISTING', 'err': err})
            print(json.dumps({'failed': log['failed'][-1]}), flush=True)
    for f in b.GetFootprints():
        if f.GetReference() not in GROUP: continue
        for pd in f.Pads():
            if pd.GetNetname() != 'GND' or not pd.GetNumber(): continue
            spec = f'{f.GetReference()}.{pd.GetNumber()}'; p = r.xy(pd.GetPosition())
            checks = [r.collision_test(b, 'GND', .5, l, True) for l in r.ALL_COPPER]; stub = r.collision_test(b, 'GND', .25, 'F.Cu')
            for dd, c in sorted((math.hypot(ix * .05, iy * .05), [round(p[0] + ix * .05, 3), round(p[1] + iy * .05, 3)]) for ix in range(-36, 37) for iy in range(-36, 37)):
                if not .45 <= dd <= 1.8 or via_forbidden(c): continue
                if all(ch(c, c) for ch in checks) and stub(p, c):
                    add_via(b, 'GND', c, 'gnd:' + spec); add_track(b, 'GND', k.F_Cu, p, c, .25, 'gndt:' + spec)
                    log['ground'].append({'pad': spec, 'via': c}); break
            else:
                for dd, c in sorted((math.hypot(ix * .05, iy * .05), [round(p[0] + ix * .05, 3), round(p[1] + iy * .05, 3)]) for ix in range(-64, 65) for iy in range(-64, 65)):
                    if not 1.0 <= dd <= 3.2 or via_forbidden(c) or not all(ch(c, c) for ch in checks): continue
                    try:
                        legs, _, _ = r.path(b, 'GND', p, c, .25, ['F.Cu'], ['F.Cu'], ['F.Cu'], route_bounds([p, c]), max_vias=0, max_states=60000, step=.05)
                    except RuntimeError:
                        continue
                    add_via(b, 'GND', c, 'gnd:' + spec)
                    for ti, (x, y) in enumerate(zip(legs[0][1], legs[0][1][1:])): add_track(b, 'GND', k.F_Cu, x, y, .25, f'gndt:{spec}:{ti}')
                    log['ground'].append({'pad': spec, 'via': c, 'routed_stub': legs[0][1]}); break
                else:
                    log['failed'].append({'net': 'GND', 'from': spec, 'err': 'NO_LOCAL_GROUND_VIA'})
    for spec, c in STITCH:
        add_via(b, 'GND', c, 'stitch:' + spec); log['ground'].append({'stitch': spec, 'via': c})
    now = r.track_snapshot(b); log['preexisting_copper_unchanged'] = all(now.get(u) == v for u, v in before.items())
    A.save(b); log['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v052-routing.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'routed': len(log['routes']), 'edges': len(edges), 'ground': len(log['ground']), 'failed': log['failed'], 'preserved': log['preexisting_copper_unchanged']}))


STITCH = []      # (label, xy) GND stitch vias for pour islands cut loose by new copper; filled from the audit


# ---------------------------------------------------------------- finish / audit -------------------------------------------
CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'


def drc_json(b, tag):
    import subprocess, tempfile
    tmp = Path(tempfile.mkdtemp(prefix='fieldnote_drc_')); pcb = tmp / 'fieldnote.kicad_pcb'
    for name in ('fieldnote.kicad_pro', 'fp-lib-table', 'sym-lib-table'):
        (tmp / name).write_bytes((ROOT / name).read_bytes())
    k.SaveBoard(str(pcb), b)
    subprocess.run([CLI, 'pcb', 'drc', '--severity-all', '--format', 'json', '-o', str(tmp / 'drc.json'), str(pcb)], capture_output=True, check=True)
    return json.loads((tmp / 'drc.json').read_text())


def silk_refs(d):
    refs = set()
    for v in d['violations']:
        if v['type'].startswith('silk'):
            for it in v['items']:
                m = re.match(r'Reference field of (\S+)', it['description'])
                if m: refs.add(m.group(1))
    return refs, sum(1 for v in d['violations'] if v['type'].startswith('silk'))


def rect(bb, grow=0.):
    return [k.ToMM(bb.GetX()) - 60 - grow, k.ToMM(bb.GetY()) - 50 - grow, k.ToMM(bb.GetRight()) - 60 + grow, k.ToMM(bb.GetBottom()) - 50 + grow]


def text_rect(fld, grow=0.):
    """Stroke extent of a text (GetBoundingBox() of a field adds ~0.5 mm of line spacing)."""
    bb = fld.GetEffectiveTextShape().BBox(); w = k.ToMM(fld.GetEffectiveTextPenWidth()) / 2
    return rect(bb, grow + w)


def overlap(a, c):
    return not (a[2] <= c[0] or c[2] <= a[0] or a[3] <= c[1] or c[3] <= a[1])


def relocate_refs(b, refs, log, max_mm=4.0, fallback='hide'):
    """Move each reference text to the nearest spot (<= 4 mm) clear of pads (+0.1), other silk (+0.05), the board edge (0.3)
    and, if possible, other parts' courtyards. Conservative bounding-box tests; the caller re-checks with KiCad DRC."""
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    pads = [rect(pd.GetBoundingBox(), .1) for f in b.GetFootprints() for pd in f.Pads() if pd.IsOnLayer(k.F_Cu)]
    courts_ = {f.GetReference(): court(f) for f in b.GetFootprints() if f.GetLayer() == k.F_Cu}
    def silk_items(skip):
        out = []
        for f in b.GetFootprints():
            for it in f.GraphicalItems():
                if it.GetLayer() == k.F_SilkS:
                    if isinstance(it, k.PCB_SHAPE) and it.GetShape() == k.SHAPE_T_SEGMENT:
                        out.append(('seg', r.xy(it.GetStart()), r.xy(it.GetEnd()), k.ToMM(it.GetWidth()) / 2 + .05))
                    else:
                        out.append(('rect', rect(it.GetBoundingBox(), .05)))
            for fld in (f.Reference(), f.Value()):
                if fld.IsVisible() and fld.GetLayer() == k.F_SilkS and not (f.GetReference() == skip and fld.GetText() == skip):
                    out.append(('rect', text_rect(fld, .05)))
        for it in b.GetDrawings():
            if it.GetLayer() == k.F_SilkS:
                out.append(('rect', text_rect(it, .05) if isinstance(it, k.PCB_TEXT) else rect(it.GetBoundingBox(), .05)))
        return out
    def clear(rr, silk, own, strict):
        if any(overlap(rr, q) for q in pads): return False
        corners = [[rr[0], rr[1]], [rr[2], rr[1]], [rr[2], rr[3]], [rr[0], rr[3]]]
        if not all(r.inside(q, OUTLINE) for q in corners): return False
        if any(r.segment_distance(a, c, u, v) < .3 for a, c in zip(corners, corners[1:] + corners[:1]) for u, v in zip(OUTLINE, OUTLINE[1:] + OUTLINE[:1])): return False
        for s in silk:
            if s[0] == 'rect' and overlap(rr, s[1]): return False
            if s[0] == 'seg':
                mid = [(rr[0] + rr[2]) / 2, (rr[1] + rr[3]) / 2]; hw, hh = (rr[2] - rr[0]) / 2, (rr[3] - rr[1]) / 2
                if r.segment_distance(s[1], s[2], [rr[0], mid[1]], [rr[2], mid[1]]) < hh + s[3] or \
                   r.segment_distance(s[1], s[2], [mid[0], rr[1]], [mid[0], rr[3]]) < hw + s[3]: return False
        if strict and any(overlap(rr, cb) for ref, cb in courts_.items() if ref != own): return False
        if strict and own in courts_:                # the label must read as its own part's: nearest courtyard is its own
            box_d = lambda q: math.hypot(max(q[0] - mid_[0], 0, mid_[0] - q[2]), max(q[1] - mid_[1], 0, mid_[1] - q[3]))
            mid_ = [(rr[0] + rr[2]) / 2, (rr[1] + rr[3]) / 2]; mine = box_d(courts_[own])
            if mine > 1.2 or any(box_d(cb) < mine for ref, cb in courts_.items() if ref != own): return False
        return True
    for ref in sorted(refs):
        f = fps[ref]; fld = f.Reference(); silk = silk_items(ref); p0 = r.xy(fld.GetPosition()); r0 = text_rect(fld); a0 = fld.GetTextAngleDegrees()
        if clear(r0, silk, ref, False):
            log.append({'ref': ref, 'action': 'kept', 'at': p0}); continue
        n_ = int(max_mm * 10)
        cands = sorted((math.hypot(ix * .1, iy * .1), ix * .1, iy * .1) for ix in range(-n_, n_ + 1) for iy in range(-n_, n_ + 1) if math.hypot(ix, iy) <= n_)
        done = False
        for strict in (True,):
            for ang in (fld.GetTextAngleDegrees(), (fld.GetTextAngleDegrees() + 90) % 180):
                fld.SetTextAngleDegrees(ang); fld.SetPosition(r.vec(p0)); r1 = text_rect(fld)
                for dd, dx, dy in cands:
                    rr = [r1[0] + dx, r1[1] + dy, r1[2] + dx, r1[3] + dy]
                    if clear(rr, silk, ref, strict):
                        fld.SetPosition(r.vec([round(p0[0] + dx, 3), round(p0[1] + dy, 3)]))
                        log.append({'ref': ref, 'action': 'moved', 'from': p0, 'to': r.xy(fld.GetPosition()), 'angle': ang, 'mm': round(dd, 2),
                                    'over_other_courtyard': not strict}); done = True; break
                if done: break
            if done: break
        if not done:
            fld.SetTextAngleDegrees(a0); fld.SetPosition(r.vec(p0))
            if fallback == 'hide':
                fld.SetVisible(False); log.append({'ref': ref, 'action': f'hidden (no clear spot within {max_mm} mm)'})
            else:
                log.append({'ref': ref, 'action': f'left unchanged (inherited; no clear spot within {max_mm} mm)'})


def finish():
    app, b = A.load(); log = {'silk': []}
    # New silk problems (the six v0.5.2 parts, and JP1 whose text sits on the v0.5.1 R38 pad): move <= 4 mm clear of other
    # parts, else hide like v0.5.1 did for its small new parts. Inherited v0.5 warnings: move only into a clean spot <= 2.5 mm.
    d0 = drc_json(b, 'pre'); refs, n0 = silk_refs(d0); log['silk_warnings_before'] = n0; log['refs_flagged'] = sorted(refs)
    relocate_refs(b, refs & (set(NEW) | {'JP1'}), log['silk'], 4.0, 'hide')
    d1 = drc_json(b, 'mid'); left, _ = silk_refs(d1)
    relocate_refs(b, left - set(NEW) - {'JP1'}, log['silk'], 2.5, 'keep')
    d1 = drc_json(b, 'post'); left, n1 = silk_refs(d1)
    for ref in sorted(left & (set(NEW) | {'JP1'})):  # last resort for new parts only: hide what KiCad still flags
        f = next(f for f in b.GetFootprints() if f.GetReference() == ref); f.Reference().SetVisible(False)
        log['silk'].append({'ref': ref, 'action': 'hidden (KiCad still flagged it)'})
    d2 = drc_json(b, 'final'); log['silk_warnings_after'] = silk_refs(d2)[1]
    log['residual_silk_warnings'] = [[v['type']] + [i['description'] for i in v['items']] for v in d2['violations'] if v['type'].startswith('silk')]
    log['silk_warning_types_after'] = sorted({v['type'] for v in d2['violations'] if v['type'].startswith('silk')})
    k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b); log['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v052-finish.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'silk_before': n0, 'silk_after': log['silk_warnings_after'], 'moved': sum(1 for x in log['silk'] if x['action'] == 'moved'),
                      'hidden': [x['ref'] for x in log['silk'] if x['action'].startswith('hidden')], 'board_sha256': log['board_sha256']}))


ALLOWED_NEW_NETS = {'BZR_VDD', 'BZR_P', 'BZR_GATE', 'BOOT_IO8', 'SUP_RESET_N', 'ESP_RESET_RC', '3V3', 'GND'} | set(POWER_NETS)


def anchored_islands(b):
    """GND fill polygons on F/In2/B that touch no GND via, plated GND hole or GND track (In1 is the solid plane)."""
    anchors = []
    for t_ in b.GetTracks():
        if t_.GetNetname() != 'GND': continue
        if isinstance(t_, k.PCB_VIA): anchors.append(('c', t_.GetPosition(), t_.GetWidth(k.F_Cu) // 2, None))
        else: anchors.append(('s', t_.GetStart(), t_.GetEnd(), t_.GetLayer()))
    for f in b.GetFootprints():
        for pd in f.Pads():
            if pd.GetNetname() == 'GND' and pd.GetDrillSize().x: anchors.append(('c', pd.GetPosition(), pd.GetDrillSize().x // 2, None))
    out = []
    for z in b.Zones():
        if z.GetIsRuleArea() or z.GetNetname() != 'GND': continue
        for li in z.GetLayerSet().Seq():
            if li == k.In1_Cu: continue
            fp = z.GetFilledPolysList(li)
            for i in range(fp.OutlineCount()):
                sub = k.SHAPE_POLY_SET(); sub.AddOutline(fp.Outline(i))
                ok = False
                for a in anchors:
                    if a[0] == 'c' and sub.Collide(a[1], int(a[2])): ok = True; break
                    if a[0] == 's' and a[3] == li and k.SEG(a[1], a[2]) is not None and sub.Collide(k.SEG(a[1], a[2]), 0): ok = True; break
                if not ok:
                    bb = fp.Outline(i).BBox()
                    out.append({'zone': z.GetZoneName(), 'layer': b.GetLayerName(li), 'bbox': rect(bb), 'area_mm2': round(sub.Area() / 1e12, 3)})
    return out


def audit():
    app, b = A.load(); src = k.LoadBoard(str(SRC))
    s0, s1 = r.track_snapshot(src), r.track_snapshot(b)
    ripped = {x['uuid'] for x in json.loads((OUT / 'v052-textprep.json').read_text())['ripped_v051_buzzer_copper']}
    removed = sorted(set(s0) - set(s1)); added = sorted(set(s1) - set(s0))
    changed = [u for u in s0 if u in s1 and s0[u] != s1[u]]
    rep = {'source_board_sha256': sha(SRC), 'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    rep['removed'] = {'count': len(removed), 'all_are_the_ripped_v051_buzzer_copper': set(removed) == ripped}
    ch = []
    for u in changed:
        a, c = s0[u], s1[u]
        kind = 'width' if {k_ for k_ in a if a[k_] != c[k_]} <= {'width'} else 'width+shortened (neck split)'
        ch.append({'uuid': u, 'net': a['net'], 'layer': a['layer'], 'width': [a.get('width'), c.get('width')], 'kind': kind})
    rep['changed'] = {'count': len(ch), 'nets': sorted({x['net'] for x in ch}), 'only_power_nets': all(x['net'] in POWER_NETS for x in ch), 'items': ch}
    by_net = {}
    for u in added:
        by_net.setdefault(s1[u]['net'], {'tracks': 0, 'vias': 0})[('vias' if s1[u]['kind'] == 'via' else 'tracks')] += 1
    far = [u for u in added if s1[u]['net'] in ('3V3', 'GND', 'BOOT_IO8', 'ESP_RESET_RC')
           and not all(60 <= q[0] <= 74 and 17 <= q[1] <= 37 for q in (s1[u]['start'], s1[u]['end']))]
    rep['added'] = {'count': len(added), 'by_net': by_net, 'only_expected_nets': set(by_net) <= ALLOWED_NEW_NETS,
                    'shared_net_items_outside_buzzer_supervisor_corner': far}
    # footprints: only the buzzer group moved; new parts are the six v0.5.2 parts
    f0 = {f.GetReference(): (r.xy(f.GetPosition()), f.GetOrientationDegrees(), f.GetValue()) for f in src.GetFootprints()}
    f1 = {f.GetReference(): (r.xy(f.GetPosition()), f.GetOrientationDegrees(), f.GetValue()) for f in b.GetFootprints()}
    rep['footprints'] = {'added': sorted(set(f1) - set(f0)), 'removed': sorted(set(f0) - set(f1)),
                         'moved': sorted(ref for ref in f0 if ref in f1 and (f0[ref][0] != f1[ref][0] or f0[ref][1] != f1[ref][1])),
                         'value_changed': sorted(ref for ref in f0 if ref in f1 and f0[ref][2] != f1[ref][2])}
    led = ['D5', 'Q1', 'Q2', 'Q3', 'R16', 'R17', 'R18', 'R38', 'R39', 'R40', 'R41', 'R42', 'R43']
    rep['led_parts_unchanged'] = all(f0[x] == f1[x] for x in led if x in f0)
    e0 = sorted((tuple(r.xy(d.GetStart())), tuple(r.xy(d.GetEnd()))) for d in src.GetDrawings() if d.GetLayer() == k.Edge_Cuts)
    e1 = sorted((tuple(r.xy(d.GetStart())), tuple(r.xy(d.GetEnd()))) for d in b.GetDrawings() if d.GetLayer() == k.Edge_Cuts)
    rep['outline_unchanged'] = e0 == e1
    z0 = {(z.GetZoneName(), z.GetNetname(), tuple(z.GetLayerSet().Seq())): [r.xy(z.Outline().Outline(0).CPoint(i)) for i in range(z.Outline().Outline(0).PointCount())] for z in src.Zones()}
    z1 = {(z.GetZoneName(), z.GetNetname(), tuple(z.GetLayerSet().Seq())): [r.xy(z.Outline().Outline(0).CPoint(i)) for i in range(z.Outline().Outline(0).PointCount())] for z in b.Zones()}
    rep['zone_outlines_changed'] = sorted(key[0] for key in z0 if z0[key] != z1.get(key))
    rep['zones_added_or_removed'] = [list(map(str, x)) for x in set(z0) ^ set(z1)]
    c44 = next(f for f in b.GetFootprints() if f.GetReference() == 'C44')
    rep['C44_pad_copper_to_edge_mm'] = round(min(edge_distance(q) for pd in c44.Pads() for q in (lambda bb: [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]])(rect(pd.GetBoundingBox()))), 3)
    rep['C44_body_to_edge_mm'] = round(min(edge_distance(q) for q in (lambda bb: [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]])(court(c44))) , 3)
    # NFC keepout: no GND (or any) copper fill left in x < 1.5 next to the coil
    def box_poly(x0, y0, x1, y1):
        s_ = k.SHAPE_POLY_SET(); s_.NewOutline()
        for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)): s_.Append(int(k.FromMM(x + 60)), int(k.FromMM(y + 50)))
        return s_
    nfc = next(z for z in b.Zones() if z.GetZoneName() == 'NFC copper-free region').Outline().BBox()
    strip_box = box_poly(0, k.ToMM(nfc.GetY()) - 50, 1.5, k.ToMM(nfc.GetBottom()) - 50)   # old grounded strip beside the coil
    def copper_in(box):
        out = {}
        for z in b.Zones():
            if z.GetIsRuleArea(): continue
            for li in z.GetLayerSet().Seq():
                fp = k.SHAPE_POLY_SET(z.GetFilledPolysList(li)); fp.BooleanIntersection(box)
                if fp.Area() > 0: out[f'{z.GetZoneName()}@{b.GetLayerName(li)}'] = round(fp.Area() / 1e12, 4)
        for t_ in b.GetTracks():
            if box.Collide(t_.GetPosition() if isinstance(t_, k.PCB_VIA) else t_.GetStart()) or (not isinstance(t_, k.PCB_VIA) and box.Collide(t_.GetEnd())):
                out.setdefault('tracks', []).append(t_.GetNetname())
        return out
    rep['nfc_edge_strip_copper_mm2'] = copper_in(strip_box)
    src_fill = k.LoadBoard(str(SRC))
    rep['nfc_edge_strip_copper_mm2_in_v051'] = {k_: round((lambda s_: (s_.BooleanIntersection(strip_box), s_.Area() / 1e12)[1])(k.SHAPE_POLY_SET(z.GetFilledPolysList(li))), 3)
                                                for z in src_fill.Zones() if not z.GetIsRuleArea() for li in z.GetLayerSet().Seq()
                                                for k_ in [f'{z.GetZoneName()}@{src_fill.GetLayerName(li)}']
                                                if (lambda s_: (s_.BooleanIntersection(strip_box), s_.Area())[1])(k.SHAPE_POLY_SET(z.GetFilledPolysList(li))) > 0}
    rep['gnd_islands_without_via_or_track'] = anchored_islands(b)
    drc = json.loads((OUT / 'v052-drc.json').read_text())
    import collections
    rep['drc'] = {'errors': sum(1 for v in drc['violations'] if v['severity'] == 'error'), 'warnings': dict(collections.Counter(v['type'] for v in drc['violations'] if v['severity'] == 'warning')),
                  'unconnected': len(drc['unconnected_items']), 'parity': len(drc['schematic_parity'])}
    (OUT / 'v052-audit.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({k_: v for k_, v in rep.items() if k_ not in ('changed',)} | {'changed': {x: rep['changed'][x] for x in ('count', 'nets', 'only_power_nets')}}, default=str))


if __name__ == '__main__':
    {'textprep': textprep, 'surgery': surgery, 'place': place, 'power': power, 'route': route, 'finish': finish, 'audit': audit}[sys.argv[1]]()
