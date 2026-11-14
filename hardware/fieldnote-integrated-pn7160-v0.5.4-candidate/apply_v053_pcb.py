#!/usr/bin/env python3
"""v0.5.3 layout on top of the routed v0.5.2 board (source-v052/fieldnote.kicad_pcb).

Phases (KiCad python apply_v053_pcb.py <phase>):
  textprep - text edit of the frozen source board (pcbnew deletion in a loop is unreliable). The rip list is selected with
             pcbnew (read only) and then removed as text blocks:
               * the v0.5.1 LED supply spur (VSYS D5.2 -> FB1, 26 mm F.Cu + 2.2 mm In1 hop, v0.5.1 output/v051-vsys.json);
               * all copper of the nine RGB channel nets (LEDx_K / LEDx_D / LEDx_GATE), routed as 2-via runs in v0.5.1;
               * UART_TX (service-only, J4.3 -> U1.31), to free In2 for the LED supply;
               * the v0.5.2 supervisor / buzzer links: SUP_RESET_N, ESP_RESET_RC (R46 -> C9, 4 vias), BOOT_IO8 (C45 -> R14, 3 vias),
                 3V3 (C46 -> U12, R44 -> J6 area, 2 vias) and the U12/C46 ground stubs;
               * Edge.Cuts (outline redrawn in surgery), the top-left case notch in the four GND pour outlines;
               * stackup: black solder mask, white silkscreen (ENIG unchanged).
  surgery  - new outline (notch removed, 1 mm convex corner radius), import D8 / R47, sync pad nets, values and MPN fields.
  place    - legality-checked placement: D8 at J1, R47 on IO_INT, U12 / R46 / C46 >= 1.5 mm from the J6 pads.
  route    - 45-degree router (route45.py): LED supply, RGB channels, UART_TX, CC taps, supervisor, buzzer links, GND vias.
  teardrops- straight teardrop zones on the new/rerouted copper (outside the RF matching area).
  finish   - silkscreen: every reference visible, 0.8 mm, 0/90 deg, clear of pads; board title; zone refill.
  audit    - track/via diff against the frozen source, In1 track check, GND island check.
"""
from pathlib import Path
import hashlib, json, math, re, sys, uuid
import wx
import pcbnew as k
import route_pn7160 as r
import route45 as R
import apply_v05_pcb as A

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
A.ROOT = ROOT; A.OUT = OUT
SRC = ROOT / 'source-v052' / 'fieldnote.kicad_pcb'
V052_BOARD = '78e671b38e97363926ec36fa88dac2a63df54d59f413ac996088c911dc2716e6'
V051_VSYS = json.loads('''[[21.325,3.725],[21.4,3.7],[21.9,3.7],[22.1,3.9],[22.8,3.9],[22.9,4.0],[23.2,4.0],[23.3,4.1],[27.5,4.1],[27.6,4.2],
 [33.0,4.2],[33.2,4.4],[33.6,4.4],[33.7,4.5],[39.0,4.5],[39.4,4.9],[39.4,5.9],[39.8,6.3],[40.0,6.3],[40.5,6.8],[40.5,6.9],[40.6,7.0],
 [40.6,7.5],[41.0,7.9],[41.0,8.3],[42.8,10.1],[42.8,10.8],[43.0,11.0],[45.2,11.0],[46.4,11.0],[47.8,12.4],[47.9,12.4],[49.1,13.6],
 [49.2,13.6],[49.5,13.9]]''')      # v0.5.1 output/v051-vsys.json legs (the LED spur only)
LED_NETS = ['LEDR_K', 'LEDG_K', 'LEDB_K', 'LEDR_D', 'LEDG_D', 'LEDB_D', 'LEDR_GATE', 'LEDG_GATE', 'LEDB_GATE']
RIP_NETS = LED_NETS + ['UART_TX']
V052_ROUTES = {9: 'BOOT_IO8', 10: 'SUP_RESET_N', 11: '3V3', 12: '3V3', 13: '3V3', 14: 'ESP_RESET_RC'}
V052_GND = ['U12.1', 'C46.2']
NEW = ['D8', 'D9', 'R47']
LED_MOVE = ['Q1', 'Q2', 'Q3', 'R38', 'R39', 'R40', 'R41', 'R42', 'R43']
# Outline, board mm (design coordinates). v0.5.2 had a 3-11.5 x 0-1.6 notch for the old case lip: removed.
OUTLINE = [[0, 0], [47, 0], [47, -2], [60, -2], [60, 0], [74, 0], [74, 37], [65.5, 37], [65.5, 45.2], [61.5, 45.2],
           [61.5, 38.7], [48.1, 38.7], [48.1, 45.2], [0, 45.2]]
CORNER_R = 1.0
NOTCH_TXT = '(xy 60 50) (xy 63 50) (xy 63 51.6) (xy 71.5 51.6) (xy 71.5 50) (xy 107 50)'
BOUNDS = [.6, -1.6, 73.4, 44.6]
RF_BOX = (33.0, 21.0, 42.5, 38.0)        # PN7160, crystal and matching network: no teardrops, no new copper
RESERVE = []        # PN7160 / matching network area: no teardrops, no new copper
EDGE_CLEAR = .3


def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def data(): return json.loads((ROOT / 'design-data.json').read_text())
def ident(key): return k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL, 'fieldnote-v053:' + key)))
def v052_id(key): return str(uuid.uuid5(uuid.NAMESPACE_URL, 'fieldnote-v052:' + key))


def add_via(b, net, p, key, dia=.5, drill=.2):
    v = k.PCB_VIA(b); v.SetUuid(ident(key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(dia)); v.SetDrill(k.FromMM(drill))
    v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet(net)); v.SetLocked(True)
    v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v); return v


def snap(b, net, p):
    """Exact (nm) position of a via of `net` at p, so a new track ends on the via centre (else KiCad warns)."""
    for v in b.GetTracks():
        if isinstance(v, k.PCB_VIA) and v.GetNetname() == net and math.dist(r.xy(v.GetPosition()), p) < 2e-3: return v.GetPosition()
    return r.vec(p)


def add_track(b, net, layer, a, c, w, key):
    t = k.PCB_TRACK(b); t.SetUuid(ident(key)); t.SetStart(snap(b, net, a)); t.SetEnd(snap(b, net, c))
    t.SetLayer(layer if isinstance(layer, int) else b.GetLayerID(layer))
    t.SetNet(b.FindNet(net)); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t); return t


def load():
    return A.load()


def save(b):
    A.save(b)


# ---------------------------------------------------------------- textprep ---------------------------------------------------
def rip_selection():
    """UUIDs of every copper item to rip, selected on the frozen source with pcbnew (read only)."""
    app = wx.App(False)
    b = k.LoadBoard(str(SRC))
    spur = {(round(p[0], 3), round(p[1], 3)) for p in V051_VSYS}
    keys52 = {v052_id(f'r{i}:{li}:{ti}'): n for i, n in V052_ROUTES.items() for li in range(8) for ti in range(60)}
    keys52 |= {v052_id(f'r{i}:via{vi}'): n for i, n in V052_ROUTES.items() for vi in range(8)}
    keys52 |= {v052_id(kind + spec + sfx): 'GND' for spec in V052_GND for kind in ('gnd:', 'gndt:') for sfx in [''] + [f':{t}' for t in range(8)]}
    led_gnd = [pd for f in b.GetFootprints() if f.GetReference() in LED_MOVE for pd in f.Pads() if pd.GetNetname() == 'GND']
    stub_vias = set()
    for t in b.GetTracks():
        if t.GetNetname() == 'GND' and not isinstance(t, k.PCB_VIA):
            for e1, e2 in ((t.GetStart(), t.GetEnd()), (t.GetEnd(), t.GetStart())):
                if any(pd.HitTest(e1) for pd in led_gnd): stub_vias.add((round(r.xy(e2)[0], 3), round(r.xy(e2)[1], 3)))
    sel = {}
    for t in b.GetTracks():
        u = t.m_Uuid.AsString(); n = t.GetNetname()
        pts = [r.xy(t.GetPosition())] if isinstance(t, k.PCB_VIA) else [r.xy(t.GetStart()), r.xy(t.GetEnd())]
        why = None
        if n == 'VSYS' and all((round(p[0], 3), round(p[1], 3)) in spur for p in pts): why = 'v0.5.1 LED supply spur'
        elif n == 'GND' and not isinstance(t, k.PCB_VIA) and any(pd.HitTest(t.GetStart()) or pd.HitTest(t.GetEnd()) for pd in led_gnd): why = 'LED part GND stub (part re-placed)'
        elif n == 'GND' and isinstance(t, k.PCB_VIA) and (round(pts[0][0], 3), round(pts[0][1], 3)) in stub_vias: why = 'LED part GND stub (part re-placed)'
        elif n in RIP_NETS: why = 'reroute ' + n
        elif u in keys52:
            assert keys52[u] == n, (u, n, keys52[u]); why = 'v0.5.2 supervisor/buzzer link'
        if why:
            sel[u] = {'net': n, 'kind': 'via' if isinstance(t, k.PCB_VIA) else 'track', 'layer': b.GetLayerName(t.GetLayer()),
                      'pts': pts, 'why': why, 'len': 0 if isinstance(t, k.PCB_VIA) else round(k.ToMM(t.GetLength()), 3)}
    return sel


def textprep():
    assert sha(SRC) == V052_BOARD
    sel = rip_selection()
    t = SRC.read_text()
    blocks = re.findall(r'\n\t\((?:segment|via|arc)\n(?:\t\t.*\n)*?\t\)', t)
    removed = 0
    for blk in blocks:
        m = re.search(r'\(uuid "([0-9a-f-]+)"\)', blk)
        if m and m.group(1) in sel:
            t = t.replace(blk, '', 1); removed += 1
    assert removed == len(sel), (removed, len(sel))
    # Edge.Cuts: every outline segment (redrawn in surgery)
    edges = [blk for blk in re.findall(r'\n\t\(gr_line\n(?:\t\t.*\n)*?\t\)', t) if '(layer "Edge.Cuts")' in blk]
    assert len(edges) == 18, len(edges)
    for blk in edges: t = t.replace(blk, '', 1)
    # GND pours: drop the notch from the outline, drop stale fills (refilled later)
    assert t.count(NOTCH_TXT) == 4
    t = t.replace(NOTCH_TXT, '(xy 60 50) (xy 107 50)')
    zones = re.findall(r'\n\t\(zone\n(?:\t\t.*\n)*?\t\)', t)
    for z in zones:
        z2 = re.sub(r'\n\t\t\(filled_polygon\n(?:\t\t\t.*\n)*?\t\t\)', '', z)
        if z2 != z: t = t.replace(z, z2, 1)
    # the bare "USB" silk mark at J1 (119.6, 51.4) is replaced in finish by "USB-C 5V >=1.5A" (owner request)
    usb = re.findall(r'\n\t\(gr_text "USB"\n\t\t\(at 119\.6 51\.4 0\)\n(?:\t\t.*\n)*?\t\)', t)
    assert len(usb) == 1, len(usb)
    t = t.replace(usb[0], '', 1)
    # stackup colours
    for lay, typ, col in (('F.SilkS', 'Top Silk Screen', 'White'), ('B.SilkS', 'Bottom Silk Screen', 'White'),
                          ('F.Mask', 'Top Solder Mask', 'Black'), ('B.Mask', 'Bottom Solder Mask', 'Black')):
        old = f'\t\t\t(layer "{lay}"\n\t\t\t\t(type "{typ}")\n'
        assert t.count(old) == 1, lay
        t = t.replace(old, old + f'\t\t\t\t(color "{col}")\n')
    assert '(copper_finish "ENIG")' in t
    (ROOT / 'fieldnote.kicad_pcb').write_text(t)
    by = {}
    for u, s in sel.items():
        key = (s['why'], s['net']); by.setdefault(key, {'tracks': 0, 'vias': 0, 'len_mm': 0.})
        by[key]['vias' if s['kind'] == 'via' else 'tracks'] += 1; by[key]['len_mm'] = round(by[key]['len_mm'] + s['len'], 2)
    rep = {'source_board_sha256': V052_BOARD, 'ripped': sel, 'summary': [{'why': a, 'net': n, **v} for (a, n), v in sorted(by.items())],
           'in1_tracks_ripped': [u for u, s in sel.items() if s['layer'] == 'In1.Cu'], 'edge_cuts_removed': len(edges),
           'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v053-textprep.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({'ripped': len(sel), 'summary': rep['summary']}))


# ---------------------------------------------------------------- surgery ----------------------------------------------------
def outline_shapes():
    """Lines + tangent arcs for OUTLINE with CORNER_R on every convex corner (polygon is clockwise on screen)."""
    n = len(OUTLINE); pts = OUTLINE
    cross = lambda a, b_, c: (b_[0] - a[0]) * (c[1] - b_[1]) - (b_[1] - a[1]) * (c[0] - b_[0])
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    sgn = 1 if area > 0 else -1
    corners = []
    for i in range(n):
        a, b_, c = pts[i - 1], pts[i], pts[(i + 1) % n]
        if cross(a, b_, c) * sgn > 0:           # convex
            u = [(a[0] - b_[0]) / math.dist(a, b_), (a[1] - b_[1]) / math.dist(a, b_)]
            v = [(c[0] - b_[0]) / math.dist(c, b_), (c[1] - b_[1]) / math.dist(c, b_)]
            p1 = [b_[0] + u[0] * CORNER_R, b_[1] + u[1] * CORNER_R]; p2 = [b_[0] + v[0] * CORNER_R, b_[1] + v[1] * CORNER_R]
            ctr = [b_[0] + (u[0] + v[0]) * CORNER_R, b_[1] + (u[1] + v[1]) * CORNER_R]
            mid = [ctr[0] - (u[0] + v[0]) * CORNER_R / math.sqrt(2), ctr[1] - (u[1] + v[1]) * CORNER_R / math.sqrt(2)]
            corners.append(('arc', p1, mid, p2))
        else:
            corners.append(('pt', b_))
    shapes = []
    for i in range(n):
        cur, nxt = corners[i], corners[(i + 1) % n]
        if cur[0] == 'arc': shapes.append(('arc', cur[1], cur[2], cur[3]))
        a = cur[3] if cur[0] == 'arc' else cur[1]
        c = nxt[1]
        shapes.append(('line', a, c))
    return shapes


def outline_polygon(step_deg=10):
    poly = []
    for s in outline_shapes():
        if s[0] == 'line':
            poly.append(s[1])
        else:
            p1, mid, p2 = s[1], s[2], s[3]
            # centre from three points
            ax, ay = p1; bx, by = mid; cx, cy = p2
            d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
            ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
            uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
            a0 = math.atan2(ay - uy, ax - ux); a1 = math.atan2(cy - uy, cx - ux); am = math.atan2(by - uy, bx - ux)
            da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
            m = max(2, int(abs(math.degrees(da)) / step_deg))
            for j in range(m):
                ang = a0 + da * j / m; poly.append([ux + CORNER_R * math.cos(ang), uy + CORNER_R * math.sin(ang)])
    return poly


def surgery():
    app, b = load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    import build_design as g
    for name in sorted({n for p in d['parts'] for n in p['nets'].values() if n}):
        A.net(b, name)
    # outline
    for si, s in enumerate(outline_shapes()):
        sh = k.PCB_SHAPE(b); sh.SetLayer(k.Edge_Cuts); sh.SetWidth(k.FromMM(.05)); sh.SetUuid(ident(f'edge:{si}'))
        if s[0] == 'line':
            sh.SetShape(k.SHAPE_T_SEGMENT); sh.SetStart(r.vec(s[1])); sh.SetEnd(r.vec(s[2]))
        else:
            sh.SetShape(k.SHAPE_T_ARC); sh.SetArcGeometry(r.vec(s[1]), r.vec(s[2]), r.vec(s[3]))
        b.Add(sh)
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    sheet = {'D8': 'sheetusb-power', 'D9': 'sheetusb-power', 'R47': 'sheetesp32-leds'}
    for ref in NEW:
        p = parts[ref]
        f = k.FootprintLoad(str(ROOT / 'Fieldnote.pretty'), p['fp']); assert f, p['fp']
        f.SetReference(ref); f.SetUuid(k.KIID(g.uid(ref))); f.SetFPID(k.LIB_ID('Fieldnote', p['fp'])); b.Add(f)
        f.SetPosition(r.vec([-40, -40]))
        f.SetPath(k.KIID_PATH('/' + g.ROOT_UUID + '/' + g.uid(sheet[ref]) + '/' + g.uid(ref)))
        f.SetValue(p['value']); f.SetField('MPN', p['mpn']); f.GetField('MPN').SetVisible(False); f.Value().SetVisible(False)
        for i, item in enumerate(list(f.GetFields()) + list(f.Pads()) + list(f.GraphicalItems()) + list(f.Zones())):
            item.SetUuid(ident(f'{ref}:sub{i}'))
        fps[ref] = f
    changed = []
    for p in d['parts']:
        f = fps[p['ref']]
        if f.GetValue() != p['value']: changed.append([p['ref'], 'value', f.GetValue(), p['value']]); f.SetValue(p['value'])
        if bool(f.IsDNP()) != bool(p['dnp']): changed.append([p['ref'], 'dnp', bool(f.IsDNP()), bool(p['dnp'])]); f.SetDNP(bool(p['dnp']))
        if f.GetFieldText('MPN') != p['mpn'] and p['ref'] not in NEW:
            changed.append([p['ref'], 'MPN', f.GetFieldText('MPN'), p['mpn']]); f.SetField('MPN', p['mpn'])
        for pd in f.Pads():
            num = pd.GetNumber()
            if not num or num not in p['nets']: continue
            nn = p['nets'][num]; name = p['names'].get(num, num)
            nn = nn or ('unconnected-(' + p['ref'] + '-' + ('' if name == num else name + '-') + 'Pad' + num + ')')
            if pd.GetNetname() != nn and p['ref'] not in NEW: changed.append([p['ref'], num, pd.GetNetname(), nn])
            pd.SetNet(A.net(b, nn)); pd.SetPinFunction(name)
    for item in b.GetDrawings():
        if isinstance(item, k.PCB_TEXT) and item.GetText().startswith('FIELDNOTE PN7160 v0.5.2'):
            item.SetText('FIELDNOTE PN7160 v0.5.3 - 2026-11-13 - BLACK MASK / WHITE SILK / ENIG')
    save(b)
    rep = {'imported': NEW, 'changed': changed, 'outline_shapes': len(outline_shapes()), 'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v053-surgery.json').write_text(json.dumps(rep, indent=2) + '\n'); print(json.dumps(rep))



# ---------------------------------------------------------------- geometry -----------------------------------------------------
_POLY = []


def poly():
    if not _POLY: _POLY.extend(outline_polygon(5))
    return _POLY


def edge_distance(p):
    q = poly(); return min(r.point_segment(p, a, c) for a, c in zip(q, q[1:] + q[:1]))


def in_rf(p): return RF_BOX[0] <= p[0] <= RF_BOX[2] and RF_BOX[1] <= p[1] <= RF_BOX[3]


def via_forbidden(c):
    if c[0] < 33.4 and c[1] > 10.35: return True          # NFC copper-free region
    if c[0] > 32.9 and c[1] > 36.4: return True           # Wi-Fi antenna clearance / board step
    if in_rf(c): return True
    return not r.inside(c, poly()) or edge_distance(c) < .55


def outline_ok(a, c, w):
    q = poly()
    return r.inside(a, q) and r.inside(c, q) and all(r.segment_distance(a, c, u, v) >= w / 2 + .25 + .03 for u, v in zip(q, q[1:] + q[:1]))


def court(f):
    lay = k.F_CrtYd if f.GetLayer() == k.F_Cu else k.B_CrtYd
    boxes = [i.GetBoundingBox() for i in f.GraphicalItems() if i.GetLayer() == lay] or [p.GetBoundingBox() for p in f.Pads()]
    return [min(k.ToMM(bb.GetX()) - 60 for bb in boxes), min(k.ToMM(bb.GetY()) - 50 for bb in boxes),
            max(k.ToMM(bb.GetX() + bb.GetWidth()) - 60 for bb in boxes), max(k.ToMM(bb.GetY() + bb.GetHeight()) - 50 for bb in boxes)]


def cpoly(f):
    f.BuildCourtyardCaches()
    return k.SHAPE_POLY_SET(f.GetCourtyard(k.F_CrtYd if f.GetLayer() == k.F_Cu else k.B_CrtYd))


class Grid:
    """1 mm bucket index of (a, c, radius, net) capsules."""
    def __init__(self): self.cells = {}; self.items = []
    def add(self, a, c, rad, net):
        i = len(self.items); self.items.append((a, c, rad, net))
        for ix in range(math.floor(min(a[0], c[0]) - rad), math.floor(max(a[0], c[0]) + rad) + 1):
            for iy in range(math.floor(min(a[1], c[1]) - rad), math.floor(max(a[1], c[1]) + rad) + 1):
                self.cells.setdefault((ix, iy), []).append(i)
    def near(self, a, c, rad):
        seen = set()
        for ix in range(math.floor(min(a[0], c[0]) - rad - 1), math.floor(max(a[0], c[0]) + rad + 1) + 1):
            for iy in range(math.floor(min(a[1], c[1]) - rad - 1), math.floor(max(a[1], c[1]) + rad + 1) + 1):
                for i in self.cells.get((ix, iy), ()):
                    if i not in seen: seen.add(i); yield self.items[i]


def legality(b, movable, ignore_tracks_of=()):
    """Courtyard (real polygons), outline, keepout and front-copper legality for footprints being placed (v0.5.2 rules)."""
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
                    holes.append((f.GetReference(), c, h))
    obst = Grid()
    for t in b.GetTracks():
        if isinstance(t, k.PCB_VIA):
            p = r.xy(t.GetPosition()); obst.add(p, p, k.ToMM(t.GetWidth(k.F_Cu)) / 2, t.GetNetname())
        elif t.GetLayer() == k.F_Cu and t.GetNetname() not in ignore_tracks_of:
            obst.add(r.xy(t.GetStart()), r.xy(t.GetEnd()), k.ToMM(t.GetWidth()) / 2, t.GetNetname())
    for f in b.GetFootprints():
        if f.GetReference() in movable: continue
        for pd in f.Pads():
            if pd.IsOnLayer(k.F_Cu):
                a, c, rad = A.pad_segment(pd); obst.add(a, c, rad + .05, pd.GetNetname())
    keep = []
    for z in b.Zones():
        if z.GetIsRuleArea() and z.IsOnLayer(k.F_Cu) and (z.GetDoNotAllowTracks() or z.GetDoNotAllowPads()):
            ol = z.Outline().Outline(0); keep.append([r.xy(ol.CPoint(i)) for i in range(ol.PointCount())])
    q = poly()

    def legal(f):
        cb = court(f)
        if not (BOUNDS[0] <= cb[0] and BOUNDS[1] <= cb[1] and cb[2] <= BOUNDS[2] and cb[3] <= BOUNDS[3]): return 'outside board'
        corners = ([cb[0], cb[1]], [cb[2], cb[1]], [cb[2], cb[3]], [cb[0], cb[3]])
        if not all(r.inside(p, q) for p in corners): return 'outside outline'
        if any(in_rf(p) for p in corners): return 'rf area'
        if any(not (cb[2] <= x0 or cb[0] >= x1 or cb[3] <= y0 or cb[1] >= y1) for x0, y0, x1, y1 in RESERVE): return 'reserved corridor'
        if any(r.segment_distance(a, c, u, v) < EDGE_CLEAR for a, c in zip(corners, corners[1:] + corners[:1]) for u, v in zip(q, q[1:] + q[:1])): return 'edge'
        mine = None
        for ref, (o, op) in courts.items():
            if cb[2] + .02 <= o[0] or cb[0] >= o[2] + .02 or cb[3] + .02 <= o[1] or cb[1] >= o[3] + .02: continue
            mine = mine or cpoly(f)
            if mine.Collide(op, k.FromMM(.02)): return 'courtyard ' + ref
        for ref, c, h in holes:
            if c[0] < cb[0] - 1 or c[0] > cb[2] + 1 or c[1] < cb[1] - 1 or c[1] > cb[3] + 1: continue
            mine = mine or cpoly(f)
            if mine.Collide(h, k.FromMM(.1)): return 'hole ' + ref
        if any(r.inside(p, poly_) for poly_ in keep for p in corners): return 'keepout'
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd)
            for u, v, ur, un in obst.near(a, c, rad + .6):
                if un and un == pd.GetNetname(): continue
                if r.segment_distance(a, c, u, v) < rad + ur + A.CLEAR: return 'copper ' + un
        return None

    def commit(f):
        courts[f.GetReference()] = (court(f), cpoly(f))
        for pd in f.Pads():
            a, c, rad = A.pad_segment(pd); obst.add(a, c, rad, pd.GetNetname())
    return legal, commit


# ---------------------------------------------------------------- connectivity ----------------------------------------------
def net_items(b, net):
    pads = [(f.GetReference() + '.' + pd.GetNumber(), pd) for f in b.GetFootprints() for pd in f.Pads() if pd.GetNetname() == net and pd.GetNumber()]
    tracks = [t for t in b.GetTracks() if t.GetNetname() == net]
    return pads, tracks


def clusters(b, net):
    """Union-find of a net's pads, tracks and vias by copper contact. Returns {item_key: root} and item geometry."""
    pads, tracks = net_items(b, net)
    par = {}
    def find(x):
        while par[x] != x: par[x] = par[par[x]]; x = par[x]
        return x
    def union(a, c): par[find(a)] = find(c)
    geo = {}
    for name, pd in pads:
        key = ('pad', name); par[key] = key
        geo[key] = ('pad', pd)
    for t in tracks:
        key = ('trk', t.m_Uuid.AsString()); par[key] = key; geo[key] = ('via' if isinstance(t, k.PCB_VIA) else 'trk', t)
    keys = list(geo)
    def layers(item):
        kind, o = item
        if kind == 'pad': return {l for l in (k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu) if o.IsOnLayer(l)}
        if kind == 'via': return {k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu}
        return {o.GetLayer()}
    def pts(item):
        kind, o = item
        if kind == 'pad': return [r.xy(o.GetPosition())]
        if kind == 'via': return [r.xy(o.GetPosition())]
        return [r.xy(o.GetStart()), r.xy(o.GetEnd())]
    def touch(i1, i2):
        (k1, o1), (k2, o2) = i1, i2
        common = layers(i1) & layers(i2)
        if not common: return False
        if k1 == 'pad' and k2 == 'pad': return False
        if k1 == 'pad' or k2 == 'pad':
            pd, other = (o1, i2) if k1 == 'pad' else (o2, i1)
            return any(any(pd.HitTest(r.vec(p)) and pd.IsOnLayer(l) for l in common) for p in pts(other)) or \
                (other[0] == 'via' and pd.HitTest(r.vec(pts(other)[0])))
        if k1 == 'via' or k2 == 'via':
            v, other = (o1, i2) if k1 == 'via' else (o2, i1)
            vp = r.xy(v.GetPosition()); rad = k.ToMM(v.GetWidth(k.F_Cu)) / 2
            if other[0] == 'via': return math.dist(vp, pts(other)[0]) < 1e-3
            return any(math.dist(vp, p) <= rad for p in pts(other))
        a1, c1 = pts(i1); a2, c2 = pts(i2)
        return any(r.point_segment(p, a2, c2) < 2e-3 for p in (a1, c1)) or any(r.point_segment(p, a1, c1) < 2e-3 for p in (a2, c2))
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            if touch(geo[keys[i]], geo[keys[j]]): union(keys[i], keys[j])
    return {x: find(x) for x in keys}, geo


def goal_points(geo, keys):
    """Goal points of a net's copper: pad centres, via centres and track samples every 0.1 mm. Track samples inside a via's
    copper are dropped (a new track must end on the via centre, not off-centre: KiCad 'track not centred on via')."""
    out, vias = [], []
    for key in keys:
        kind, o = geo[key]
        if kind == 'via': vias.append((r.xy(o.GetPosition()), k.ToMM(o.GetWidth(k.F_Cu)) / 2))
    for key in keys:
        kind, o = geo[key]
        if kind == 'pad':
            out.append((r.xy(o.GetPosition()), [n for n, l in zip(r.ALL_COPPER, (k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu)) if o.IsOnLayer(l)]))
        elif kind == 'via':
            out.append((r.xy(o.GetPosition()), list(r.ALL_COPPER)))
        else:
            a, c = r.xy(o.GetStart()), r.xy(o.GetEnd()); m = max(1, int(math.dist(a, c) / .1))
            L = o.GetBoard().GetLayerName(o.GetLayer())
            for i in range(m + 1):
                q = [round(a[0] + (c[0] - a[0]) * i / m, 4), round(a[1] + (c[1] - a[1]) * i / m, 4)]
                if any(math.dist(q, v) < rv + .1 for v, rv in vias): continue
                out.append((q, [L]))
    return out


def pad_of(b, spec):
    ref, num = spec.rsplit('.', 1)
    return next(pd for f in b.GetFootprints() if f.GetReference() == ref for pd in f.Pads() if pd.GetNumber() == num)


# ---------------------------------------------------------------- place ------------------------------------------------------
J6_MIN = 1.5            # pad copper of U12 / R46 / C46 to the J6 THT pads (hand-soldered on the top side)
SUP = ['U12', 'R46', 'C46']
# Hand-placed top-left strip (board mm, deg), legality-checked. Supervisor group moved here from beside J6 (no legal SOT-23 site
# >= 1.5 mm from the J6 pads exists on the right half). Around D5 the cathode order (B top-left, G bottom-left, R bottom-right)
# does not match the gate-resistor order along the strip (R16 G, R17 B, R18 R), so one channel (blue gate) crosses on B.Cu.
FIXED = {'U12': ([2.6, 3.0], 180), 'R46': ([5.6, 2.05], 0), 'C46': ([2.6, 5.4], 0),
         'R42': ([7.4, 2.4], 270), 'Q2': ([10.2, 2.6], 0), 'R40': ([18.05, 2.6], 180),
         'R39': ([18.05, 4.675], 180), 'Q1': ([14.25, 6.25], 0), 'R41': ([10.7, 5.5], 180),
         'R38': ([23.55, 4.675], 0), 'Q3': ([27.15, 4.15], 180), 'R43': ([30.0, 4.2], 90),
         # CC ESD at J1, in the column between J4 and the J1 courtyard. D9 (CC2) beside J1: one via onto the CC2 In2 run.
         # D8 (CC1) below the VBUS F.Cu diagonal: one via, then straight up B.Cu onto the CC1 run. GND pads -> J1 shell / In1.
         'D8': ([46.7, 5.6], 270), 'D9': ([47.3, 2.4], 270)}
PLACE = [   # ref, search box (board mm), angles, targets [(pad, 'net:NAME' | 'pad:REF.N', weight)]
    ('R47', (57.5, 17.5, 68.4, 30.5), (0, 90, 180, 270), [('1', 'net:IO_INT', 1), ('2', 'net:3V3', 1)]),
]


class Nearest:
    def __init__(self, pts):
        self.cells = {}
        for p in pts: self.cells.setdefault((math.floor(p[0] * 2), math.floor(p[1] * 2)), []).append(p)
    def dist(self, p):
        cx, cy = math.floor(p[0] * 2), math.floor(p[1] * 2); best = 1e9
        for rad in range(0, 200):
            for ix in range(cx - rad, cx + rad + 1):
                for iy in ((cy - rad, cy + rad) if abs(ix - cx) != rad else range(cy - rad, cy + rad + 1)):
                    for q in self.cells.get((ix, iy), ()):
                        best = min(best, math.dist(p, q))
            if best <= rad * .5: return best
        return best


def j6_distance(b, f):
    j6 = [pd for g_ in b.GetFootprints() if g_.GetReference() == 'J6' for pd in g_.Pads()]
    out = 9e9
    for pd in f.Pads():
        a, c, rad = A.pad_segment(pd)
        for q in j6:
            qc = r.xy(q.GetPosition()); out = min(out, r.segment_distance(a, c, qc, qc) - rad - k.ToMM(q.GetSize(k.F_Cu).x) / 2)
    return out


def net_points(b, net, exclude_refs=()):
    pts = []
    for t in b.GetTracks():
        if t.GetNetname() != net: continue
        if isinstance(t, k.PCB_VIA): pts.append(r.xy(t.GetPosition()))
        else:
            a, c = r.xy(t.GetStart()), r.xy(t.GetEnd()); m = max(1, int(math.dist(a, c) / .2))
            pts += [[a[0] + (c[0] - a[0]) * i / m, a[1] + (c[1] - a[1]) * i / m] for i in range(m + 1)]
    for f in b.GetFootprints():
        if f.GetReference() in exclude_refs: continue
        pts += [r.xy(pd.GetPosition()) for pd in f.Pads() if pd.GetNetname() == net]
    return pts


def place():
    app, b = load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    moving = list(FIXED) + [x[0] for x in PLACE]
    before = {ref: [r.xy(fps[ref].GetPosition()), fps[ref].GetOrientationDegrees()] for ref in moving}
    j6_before = {ref: round(j6_distance(b, fps[ref]), 3) for ref in SUP}
    for ref in moving: fps[ref].SetPosition(r.vec([-40, -40]))
    rip = {'SUP_RESET_N'}            # no copper left on these nets near the group
    legal, commit = legality(b, set(moving), rip)
    cache = {}
    res = {}
    for ref, (c, ang) in FIXED.items():
        f = fps[ref]; f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
        why = legal(f) or (j6_distance(b, f) < J6_MIN and 'J6')
        commit(f); parts[ref]['xy'] = c; parts[ref]['angle'] = ang
        res[ref] = {'xy': c, 'angle': ang, 'problem': why, 'was': before[ref]}
        if ref in SUP: res[ref]['J6_pad_clearance_mm'] = [j6_before[ref], round(j6_distance(b, f), 3)]
        print(ref, res[ref], flush=True)
    for ref, box, angles, targets in PLACE:
        f = fps[ref]
        tg = []
        for pad, spec, wgt in targets:
            if spec.startswith('net:'):
                key = spec
                if key not in cache: cache[key] = net_points(b, spec[4:], exclude_refs=moving)
                tg.append((pad, cache[key], wgt))
            else:
                pd = pad_of(b, spec[4:]); tg.append((pad, [r.xy(pd.GetPosition())], wgt))
        if box is None:
            anchor = r.xy(fps['U12'].GetPosition()); box = (anchor[0] - 4, anchor[1] - 4, anchor[0] + 4, anchor[1] + 4)
        cands = []
        idx = [(pn, Nearest(pts), w) for pn, pts, w in tg if pts]
        for ang in angles:
            f.SetOrientationDegrees(ang); f.SetPosition(r.vec([0, 0]))
            rel = {pd.GetNumber(): r.xy(pd.GetPosition()) for pd in f.Pads()}
            nx, ny = int(round((box[2] - box[0]) / .1)), int(round((box[3] - box[1]) / .1))
            for ix in range(nx + 1):
                for iy in range(ny + 1):
                    c = [round(box[0] + ix * .1, 2), round(box[1] + iy * .1, 2)]
                    s = sum(w * nd.dist([c[0] + rel[pn][0], c[1] + rel[pn][1]]) for pn, nd, w in idx)
                    cands.append((round(s, 4), ang, c))
        cands.sort()
        best = None
        for s, ang, c in cands:
            f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
            if j6_distance(b, f) < J6_MIN + .05: continue
            if legal(f): continue
            best = (s, c, ang); break
        assert best, ref
        f.SetOrientationDegrees(best[2]); f.SetPosition(r.vec(best[1])); commit(f)
        parts[ref]['xy'] = best[1]; parts[ref]['angle'] = best[2]
        res[ref] = {'xy': best[1], 'angle': best[2], 'score_mm': round(best[0], 2), 'was': before[ref]}
        if ref in SUP: res[ref]['J6_pad_clearance_mm'] = [j6_before[ref], round(j6_distance(b, f), 3)]
        print(ref, res[ref], flush=True)
    save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (OUT / 'v053-placement.json').write_text(json.dumps(res, indent=2) + '\n')
    bad = {k_: v['problem'] for k_, v in res.items() if v.get('problem')}
    print(json.dumps({'placed': len(res), 'problems': bad})); assert not bad, bad


# ---------------------------------------------------------------- route ------------------------------------------------------
FB = ['F.Cu', 'B.Cu']
FBI = ['F.Cu', 'B.Cu', 'In2.Cu']
# (net, start pad, widths, layers, max vias, step, margin mm)  - each connects the start pad's copper to the rest of the net
ROUTES = [
    ('LEDR_K', 'R38.1', (.25, .2), FB, 0, .05, 3), ('LEDG_K', 'R39.1', (.25, .2), FB, 0, .05, 3), ('LEDB_K', 'R40.1', (.25, .2), FB, 0, .05, 3),
    ('LEDR_D', 'Q3.3', (.25, .2), FB, 0, .05, 3), ('LEDG_D', 'Q1.3', (.25, .2), FB, 0, .05, 3), ('LEDB_D', 'Q2.3', (.25, .2), FB, 0, .05, 3),
    ('VSYS', 'D5.2', (.3, .25, .2), FBI, 3, .1, 8, {'states': 4_000_000, 'direct': False, 'bounds': [15, .5, 52, 16]}),
    ('LEDR_GATE', 'R43.1', (.2,), FB, 0, .05, 3), ('LEDR_GATE', 'R18.2', (.2,), FB, 0, .05, 4),
    ('LEDG_GATE', 'R41.1', (.2,), FB, 0, .05, 3), ('LEDG_GATE', 'R16.2', (.2,), FB, 0, .05, 4),
    ('LEDB_GATE', 'R42.1', (.2,), FB, 0, .05, 3),
    ('SUP_RESET_N', 'R46.1', (.2,), FB, 0, .05, 3), ('3V3', 'C46.1', (.3, .25), FB, 0, .05, 3),
    ('LEDB_GATE', 'R17.2', (.2,), FB, 2, .1, 6),
    ('ESP_RESET_RC', 'R46.2', (.2,), FBI, 2, .1, 6),
    ('3V3', 'U12.3', (.3, .25), FBI, 2, .1, 6),
    ('UART_TX', 'J4.3', (.15,), FBI, 3, .1, 6, {'states': 4_000_000, 'bounds': [39, 1, 55, 40]}),
    ('CC1', 'D8.1', (.2, .15), FBI, 2, .05, 3), ('CC2', 'D9.1', (.2, .15), FBI, 2, .05, 3),
    ('IO_INT', 'R47.1', (.2, .15), FBI, 2, .05, 3), ('3V3', 'R47.2', (.25, .2), FBI, 2, .05, 3),
    ('BOOT_IO8', 'C45.1', (.2,), FBI, 2, .05, 4),
    ('3V3', 'R44.1', (.3, .25), FBI, 2, .05, 4),
]
GND_PADS = ['D8.2', 'D9.2', 'U12.1', 'C46.2', 'Q1.2', 'Q2.2', 'Q3.2', 'R41.2', 'R42.2', 'R43.2']


def connect(b, net, start, widths, layers, max_vias, step, margin, key, log, opts=None):
    opts = opts or {}
    cl, geo = clusters(b, net)
    sk = ('pad', start)
    assert sk in cl, (net, start)
    mine = cl[sk]
    others = [x for x in cl if cl[x] != mine]
    if not others:
        log.append({'net': net, 'from': start, 'skipped': 'already connected'}); return True
    goals = goal_points(geo, others)
    pd = pad_of(b, start); sxy = r.xy(pd.GetPosition())
    slay = [n for n, l in zip(r.ALL_COPPER, (k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu)) if pd.IsOnLayer(l)]
    near = min(goals, key=lambda g_: math.dist(g_[0], sxy))[0]
    err = ''
    for m in ((None,) if opts.get('bounds') else (margin, margin * 2.5)):
        bounds = opts.get('bounds') or [max(BOUNDS[0], min(sxy[0], near[0]) - m), max(BOUNDS[1], min(sxy[1], near[1]) - m),
                                        min(BOUNDS[2], max(sxy[0], near[0]) + m), min(BOUNDS[3], max(sxy[1], near[1]) + m)]
        for nv in (sorted({0, max_vias}) if opts.get('direct', True) else [max_vias]):
            for w in widths:
                try:
                    legs, vias, L = R.route(b, net, (sxy, slay), goals, w, layers, bounds, max_vias=nv, step=step, turn=.35, via_cost=2.5,
                                            layer_cost={'In2.Cu': 1.2, 'B.Cu': 1.05}, via_ok=lambda c: not via_forbidden(c),
                                            max_states=int(opts.get('states', 1_500_000)), avoid=[RF_BOX])
                except (RuntimeError, AssertionError) as ex:
                    err = str(ex)[:120]; continue
                if not all(outline_ok(x, y, w) for _, q in legs for x, y in zip(q, q[1:])): err = 'edge'; continue
                for vi, q in enumerate(vias): add_via(b, net, q, f'{key}:via{vi}')
                for li, (Ly, q) in enumerate(legs):
                    for ti, (x, y) in enumerate(zip(q, q[1:])):
                        if math.dist(x, y) > 1e-6: add_track(b, net, Ly, x, y, w, f'{key}:{li}:{ti}')
                log.append({'net': net, 'from': start, 'w': w, 'len': L, 'vias': vias, 'layers': [Ly for Ly, _ in legs],
                            'segments': sum(len(q) - 1 for _, q in legs)})
                print(json.dumps(log[-1]), flush=True)
                return True
    log.append({'net': net, 'from': start, 'failed': err}); print(json.dumps(log[-1]), flush=True)
    return False


def gnd_via(b, spec, log):
    """GND pad -> own via (0.5/0.2) 0.5-2.0 mm away, straight octilinear 0.3 mm stub if possible, else a short routed F.Cu stub to
    a new via or to existing GND copper (via, THT pad such as the J1 shell)."""
    pd = pad_of(b, spec); p = r.xy(pd.GetPosition())
    checks = [r.collision_test(b, 'GND', .5, l, True) for l in r.ALL_COPPER]; stub = r.collision_test(b, 'GND', .3, 'F.Cu')
    cands = sorted((math.hypot(ix * .05, iy * .05), [round(p[0] + ix * .05, 3), round(p[1] + iy * .05, 3)])
                   for ix in range(-40, 41) for iy in range(-40, 41))
    for dd, c in cands:
        if not .5 <= dd <= 2.0 or via_forbidden(c) or not R.octi(p, c): continue
        if stub(p, c) and all(ch(c, c) for ch in checks):
            add_via(b, 'GND', c, 'gnd:' + spec); add_track(b, 'GND', k.F_Cu, p, c, .3, 'gndt:' + spec)
            log.append({'pad': spec, 'via': c}); return True
    existing = [(r.xy(t.GetPosition()), 'via') for t in b.GetTracks() if isinstance(t, k.PCB_VIA) and t.GetNetname() == 'GND'] + \
               [(r.xy(q.GetPosition()), 'tht') for f in b.GetFootprints() for q in f.Pads() if q.GetNetname() == 'GND' and q.GetDrillSize().x]
    opts = [(math.dist(p, e), e, kind) for e, kind in existing if math.dist(p, e) <= 3.0]
    opts += [(dd + .4, c, 'new') for dd, c in cands if .6 <= dd <= 2.0 and not via_forbidden(c)]
    tried = 0
    for dd, c, kind in sorted(opts, key=lambda x: x[0]):
        if kind == 'new' and not all(ch(c, c) for ch in checks): continue
        tried += 1
        if tried > 40: break
        try:
            legs, _, L = R.route(b, 'GND', (p, ['F.Cu']), [(c, ['F.Cu'])], .3 if kind != 'tht' else .3, ['F.Cu'],
                                 [min(p[0], c[0]) - 1.5, min(p[1], c[1]) - 1.5, max(p[0], c[0]) + 1.5, max(p[1], c[1]) + 1.5],
                                 max_vias=0, step=.05, max_states=40000, avoid=[RF_BOX], goal_reach=.05)
        except (RuntimeError, AssertionError):
            continue
        if kind == 'new': add_via(b, 'GND', c, 'gnd:' + spec)
        for ti, (x, y) in enumerate(zip(legs[0][1], legs[0][1][1:])): add_track(b, 'GND', k.F_Cu, x, y, .3, f'gndt:{spec}:{ti}')
        log.append({'pad': spec, 'to': kind, 'at': c, 'stub_len': L}); return True
    log.append({'pad': spec, 'failed': 'no local GND via'}); return False


def route():
    app, b = load(); before = r.track_snapshot(b)
    log = {'routes': [], 'ground': []}
    for i, spec in enumerate(ROUTES):
        net, start, widths, layers, nv, step, margin = spec[:7]
        connect(b, net, start, widths, layers, nv, step, margin, f'r{i}', log['routes'], spec[7] if len(spec) > 7 else None)
    for spec in GND_PADS:
        gnd_via(b, spec, log['ground'])
    now = r.track_snapshot(b)
    log['preexisting_copper_unchanged'] = all(now.get(u) == v for u, v in before.items())
    log['in1_tracks'] = [u for u, v in now.items() if v['kind'] == 'track' and v['layer'] == k.In1_Cu]
    save(b); log['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v053-routing.json').write_text(json.dumps(log, indent=2) + '\n')
    failed = [x for x in log['routes'] + log['ground'] if 'failed' in x]
    print(json.dumps({'routes': len(log['routes']), 'failed': failed, 'in1_tracks': len(log['in1_tracks']),
                      'preserved': log['preexisting_copper_unchanged']}))


# ---------------------------------------------------------------- finish (silkscreen) ------------------------------------------
CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
TXT_H, TXT_T = .8, .15
USB_LABEL = ('USB-C 5V \u22651.5A', 'USB-C 5V\n\u22651.5A')   # one line if it fits, else two; >= glyph checked in a kicad-cli plot
TITLE = [('FIELDNOTE', [16.0, 24.6], 2.4, .36), ('v0.5.3', [16.0, 28.2], 1.2, .2), ('2026-11-13', [16.0, 30.2], 1.0, .18)]
# Board-level silk labels kept (text, xy, size): JP1 positions, USB-C, battery polarity; J6 pin 1 on the top side.
LABELS_KEEP = {'USB', 'SVC', 'BAT', '+', '-'}


def drc_json(b, tag):
    import subprocess, tempfile
    tmp = Path(tempfile.mkdtemp(prefix='fieldnote_drc_')); pcb = tmp / 'fieldnote.kicad_pcb'
    for name in ('fieldnote.kicad_pro', 'fp-lib-table', 'sym-lib-table'):
        (tmp / name).write_bytes((ROOT / name).read_bytes())
    k.SaveBoard(str(pcb), b)
    subprocess.run([CLI, 'pcb', 'drc', '--severity-all', '--format', 'json', '-o', str(tmp / 'drc.json'), str(pcb)], capture_output=True, check=True)
    return json.loads((tmp / 'drc.json').read_text())


def rect(bb, grow=0.):
    return [k.ToMM(bb.GetX()) - 60 - grow, k.ToMM(bb.GetY()) - 50 - grow, k.ToMM(bb.GetRight()) - 60 + grow, k.ToMM(bb.GetBottom()) - 50 + grow]


def text_rect(fld, grow=0.):
    bb = fld.GetEffectiveTextShape().BBox(); w = k.ToMM(fld.GetEffectiveTextPenWidth()) / 2
    return rect(bb, grow + w)


def overlap(a, c):
    return not (a[2] <= c[0] or c[2] <= a[0] or a[3] <= c[1] or c[3] <= a[1])


def silk_flagged(d):
    refs, other = set(), []
    for v in d['violations']:
        if not v['type'].startswith('silk'): continue
        hit = False
        for it in v['items']:
            m = re.match(r'Reference field of (\S+)', it['description'])
            if m: refs.add(m.group(1)); hit = True
        if not hit: other.append([v['type']] + [i['description'] for i in v['items']])
    return refs, other, sum(1 for v in d['violations'] if v['type'].startswith('silk'))


class SilkWorld:
    def __init__(self, b):
        self.b = b; self.pads = Grid(); self.silk = Grid(); self.vias = Grid(); self.courts = {}; self.bodies = {}
        for f in b.GetFootprints():
            for pd in f.Pads():
                if pd.IsOnLayer(k.F_Cu) or pd.IsOnLayer(k.F_Mask):
                    rr = rect(pd.GetBoundingBox()); c = [(rr[0] + rr[2]) / 2, (rr[1] + rr[3]) / 2]
                    self.pads.add([rr[0], c[1]], [rr[2], c[1]], (rr[3] - rr[1]) / 2, ('pad', f.GetReference(), rr))
            for it in f.GraphicalItems():
                if it.GetLayer() == k.F_SilkS and isinstance(it, k.PCB_SHAPE):
                    if it.GetShape() == k.SHAPE_T_SEGMENT:
                        self.silk.add(r.xy(it.GetStart()), r.xy(it.GetEnd()), k.ToMM(it.GetWidth()) / 2, ('seg', f.GetReference()))
                    else:
                        rr = rect(it.GetBoundingBox(), k.ToMM(it.GetWidth()) / 2); c = [(rr[0] + rr[2]) / 2, (rr[1] + rr[3]) / 2]
                        self.silk.add([rr[0], c[1]], [rr[2], c[1]], (rr[3] - rr[1]) / 2, ('rect', f.GetReference(), rr))
            if f.GetLayer() == k.F_Cu and f.GetReference() != 'ANT1':
                self.courts[f.GetReference()] = court(f)
                fab = [rect(it.GetBoundingBox()) for it in f.GraphicalItems() if it.GetLayer() == k.F_Fab and isinstance(it, k.PCB_SHAPE)]
                cb = court(f)
                self.bodies[f.GetReference()] = ([min(x[0] for x in fab), min(x[1] for x in fab), max(x[2] for x in fab), max(x[3] for x in fab)]
                                                 if fab else [cb[0] + .2, cb[1] + .2, cb[2] - .2, cb[3] - .2])
        for t in b.GetTracks():
            if isinstance(t, k.PCB_VIA):
                p = r.xy(t.GetPosition()); self.vias.add(p, p, k.ToMM(t.GetWidth(k.F_Cu)) / 2, ('via',))
        for d in b.GetDrawings():
            if d.GetLayer() == k.F_SilkS:
                rr = text_rect(d) if isinstance(d, k.PCB_TEXT) else rect(d.GetBoundingBox()); self.add_rect(rr, 'board')

    def add_rect(self, rr, owner):
        c = [(rr[0] + rr[2]) / 2, (rr[1] + rr[3]) / 2]
        self.silk.add([rr[0], c[1]], [rr[2], c[1]], (rr[3] - rr[1]) / 2, ('rect', owner, rr))

    @staticmethod
    def rect_hits_capsule(rr, a, c, rad, gap):
        """Text rectangle vs capsule (segment a-c, radius) with a clearance gap."""
        x0, y0, x1, y1 = rr[0] - gap - rad, rr[1] - gap - rad, rr[2] + gap + rad, rr[3] + gap + rad
        if max(a[0], c[0]) < x0 or min(a[0], c[0]) > x1 or max(a[1], c[1]) < y0 or min(a[1], c[1]) > y1: return False
        cx, cy = (rr[0] + rr[2]) / 2, (rr[1] + rr[3]) / 2; hw, hh = (rr[2] - rr[0]) / 2, (rr[3] - rr[1]) / 2
        # distance from segment to rectangle: sample the segment
        m = max(2, int(math.dist(a, c) / .05))
        for i in range(m + 1):
            px = a[0] + (c[0] - a[0]) * i / m; py = a[1] + (c[1] - a[1]) * i / m
            dx = max(abs(px - cx) - hw, 0); dy = max(abs(py - cy) - hh, 0)
            if math.hypot(dx, dy) < rad + gap: return True
        return False

    def clear(self, rr, owner, mp=.12, ms=.1):
        for a, c, rad, info in self.pads.near([rr[0], rr[1]], [rr[2], rr[3]], 1):
            pr = info[2]
            if overlap([rr[0] - mp, rr[1] - mp, rr[2] + mp, rr[3] + mp], pr): return False
        for a, c, rad, info in self.silk.near([rr[0], rr[1]], [rr[2], rr[3]], 1):
            if info[0] == 'rect':
                if info[1] != owner and overlap([rr[0] - ms, rr[1] - ms, rr[2] + ms, rr[3] + ms], info[2]): return False
            elif info[1] != owner and self.rect_hits_capsule(rr, a, c, rad, ms): return False
            elif info[1] == owner and self.rect_hits_capsule(rr, a, c, rad, .04): return False
        if any(ref != owner and overlap(rr, body) for ref, body in self.bodies.items()): return False   # never on another part's body
        q = poly(); corners = [[rr[0], rr[1]], [rr[2], rr[1]], [rr[2], rr[3]], [rr[0], rr[3]]]
        if not all(r.inside(p, q) for p in corners): return False
        if any(r.segment_distance(a, c, u, v) < .3 for a, c in zip(corners, corners[1:] + corners[:1]) for u, v in zip(q, q[1:] + q[:1])): return False
        return True

    def penalty(self, rr, owner):
        pen = 0.
        for a, c, rad, info in self.vias.near([rr[0], rr[1]], [rr[2], rr[3]], .5):
            if self.rect_hits_capsule(rr, a, c, rad, 0): pen += 1.5
        for ref, cb in self.courts.items():
            if ref != owner and overlap(rr, cb): pen += 1.0
        return pen


def place_ref(world, f, fld, relaxed=False, owner=None, cb=None):
    """Best clear spot for a reference: beside the courtyard (0 deg preferred, then 90), nearest first, penalising vias and other
    parts' courtyards. relaxed: smaller margins, wider search and, as a last resort, the part's own body (big parts)."""
    ref = owner or f.GetReference()
    cb = cb or (court(f) if ref != 'ANT1' else rect(f.GetBoundingBox(False, False)))
    ctr = [(cb[0] + cb[2]) / 2, (cb[1] + cb[3]) / 2]
    gaps = (.1, .25, .45, .7, 1.0, 1.4, 2.0) + ((2.6,) if relaxed else ())
    slide = 50 if relaxed in ('tight', 'loose') else (40 if relaxed else 25)
    mp, ms = (.02, .02) if relaxed in ('tight', 'loose') else ((.06, .05) if relaxed else (.12, .1))
    best = None
    for ang in (0, 90):
        fld.SetTextAngleDegrees(ang); fld.SetPosition(r.vec(ctr)); r0 = text_rect(fld)
        w, h = r0[2] - r0[0], r0[3] - r0[1]; off = [ctr[0] - (r0[0] + r0[2]) / 2, ctr[1] - (r0[1] + r0[3]) / 2]
        cands = []
        for gap in gaps:
            for s in [i * .1 for i in range(-slide, slide + 1)]:
                cands.append(([ctr[0] + s, cb[1] - gap - h / 2], 0)); cands.append(([ctr[0] + s, cb[3] + gap + h / 2], 0))
                cands.append(([cb[0] - gap - w / 2, ctr[1] + s], 0)); cands.append(([cb[2] + gap + w / 2, ctr[1] + s], 0))
        if relaxed and (cb[2] - cb[0]) * (cb[3] - cb[1]) > 10:
            cands += [([ctr[0] + dx * .1, ctr[1] + dy * .1], 3.0) for dx in range(-10, 11) for dy in range(-10, 11)]
        own = world.bodies.get(ref)
        rd = lambda p, q: math.hypot(max(q[0] - p[0], 0, p[0] - q[2]), max(q[1] - p[1], 0, p[1] - q[3]))
        for c, extra in cands:
            rr = [c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2]
            if own:      # unambiguous: touching its own courtyard (<= 0.6 mm), or <= 2.5 mm with its own body nearest to the label
                g_ = math.hypot(max(cb[0] - rr[2], rr[0] - cb[2], 0), max(cb[1] - rr[3], rr[1] - cb[3], 0))
                if g_ > (3.0 if relaxed == 'loose' else 2.5): continue
                if g_ > 1.2 and relaxed != 'loose':
                    d_own = rd(c, own)
                    if any(o != ref and rd(c, bd) < d_own - .3 for o, bd in world.bodies.items()): continue
            if not world.clear(rr, ref, mp, ms): continue
            dist = math.dist(c, ctr) - max(cb[2] - cb[0], cb[3] - cb[1]) / 2
            score = dist + world.penalty(rr, ref) + (.4 if ang == 90 else 0) + extra
            if best is None or score < best[0]: best = (score, ang, [c[0] + off[0], c[1] + off[1]])
    if best is None:
        fld.SetVisible(False); return None
    _, ang, pos = best
    fld.SetTextAngleDegrees(ang); fld.SetPosition(r.vec([round(pos[0], 3), round(pos[1], 3)])); fld.SetVisible(True)
    world.add_rect(text_rect(fld), ref)
    return {'ref': ref, 'at': [round(pos[0], 3), round(pos[1], 3)], 'angle': ang, 'score': round(best[0], 2), 'relaxed': relaxed}


def canonical_teardrops(path):
    """KiCad saves teardrop zones without a UUID and gives them random ones on load, so their order in the file changes from
    run to run (content is identical). Re-emit them sorted by content after the last ordinary zone: byte-identical rebuilds."""
    txt = Path(path).read_text()
    zones = re.findall(r'\n\t\(zone\n(?:\t\t.*\n)*?\t\)', txt)
    td = [z for z in zones if '(type padvia)' in z]
    if not td: return 0
    for z in td: txt = txt.replace(z, '', 1)
    others = [z for z in zones if '(type padvia)' not in z]
    anchor = others[-1]; i = txt.rindex(anchor) + len(anchor)
    txt = txt[:i] + ''.join(sorted(td)) + txt[i:]
    Path(path).write_text(txt)
    return len(td)


def place_label_scan(world, fld, texts, cb, owner, reach=3.0):
    """Board label next to a part: 0.1 mm grid scan within `reach` of its courtyard, 0 or 90 deg, each text variant in order;
    nearest clear spot wins (then fewest vias / courtyards under it)."""
    for txt in texts:
        fld.SetText(txt); best = None
        for ang in (0, 90):
            fld.SetTextAngleDegrees(ang); fld.SetPosition(r.vec([0, 0])); r0 = text_rect(fld)
            w, h = r0[2] - r0[0], r0[3] - r0[1]; off = [-(r0[0] + r0[2]) / 2, -(r0[1] + r0[3]) / 2]
            for ix in range(int((cb[2] - cb[0] + 2 * reach + w) / .1) + 1):
                for iy in range(int((cb[3] - cb[1] + 2 * reach + h) / .1) + 1):
                    c = [round(cb[0] - reach - w / 2 + ix * .1, 2), round(cb[1] - reach - h / 2 + iy * .1, 2)]
                    rr = [c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2]
                    g = math.hypot(max(cb[0] - rr[2], rr[0] - cb[2], 0), max(cb[1] - rr[3], rr[1] - cb[3], 0))
                    if g > reach or (best and (round(g, 1), world.penalty(rr, owner)) >= best[0]): continue
                    if not world.clear(rr, owner, .06, .05): continue
                    best = ((round(g, 1), world.penalty(rr, owner)), ang, [c[0] + off[0], c[1] + off[1]])
        if best:
            _, ang, pos = best
            fld.SetTextAngleDegrees(ang); fld.SetPosition(r.vec([round(pos[0], 3), round(pos[1], 3)]))
            world.add_rect(text_rect(fld), owner)
            return {'text': txt, 'at': [round(pos[0], 3), round(pos[1], 3)], 'angle': ang, 'gap_mm': best[0][0]}
    return None


def finish():
    app, b = load(); log = {'refs': [], 'unplaced': [], 'labels': []}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    # board title and kept labels
    for d in list(b.GetDrawings()):
        if isinstance(d, k.PCB_TEXT) and d.GetLayer() == k.F_SilkS:
            log['labels'].append({'text': d.GetText(), 'at': r.xy(d.GetPosition())})
    for i, (txt, xy, hgt, th) in enumerate(TITLE):
        tx = k.PCB_TEXT(b); tx.SetText(txt); tx.SetLayer(k.F_SilkS); tx.SetPosition(r.vec(xy)); tx.SetUuid(ident(f'title:{i}'))
        tx.SetTextSize(k.VECTOR2I(k.FromMM(hgt), k.FromMM(hgt))); tx.SetTextThickness(k.FromMM(th)); b.Add(tx)
    # references: 0.8 mm / 0.15 mm, start hidden; front parts are placed, J6 (back side) keeps its bottom-silk reference
    todo = []
    for f in b.GetFootprints():
        fld = f.Reference()
        fld.SetTextSize(k.VECTOR2I(k.FromMM(TXT_H), k.FromMM(TXT_H))); fld.SetTextThickness(k.FromMM(TXT_T)); fld.SetKeepUpright(True)
        if f.GetLayer() == k.B_Cu: fld.SetVisible(True); continue
        fld.SetLayer(k.F_SilkS); fld.SetMirrored(False); fld.SetVisible(False); todo.append(f)
    world = SilkWorld(b)
    # USB-C supply label next to J1 (owner request): the board only boots from a >= 1.5 A USB-C source (deliberate boot gate)
    usbl = k.PCB_TEXT(b); usbl.SetLayer(k.F_SilkS); usbl.SetUuid(ident('usblabel'))
    usbl.SetTextSize(k.VECTOR2I(k.FromMM(TXT_H), k.FromMM(TXT_H))); usbl.SetTextThickness(k.FromMM(TXT_T)); b.Add(usbl)
    res = place_label_scan(world, usbl, USB_LABEL, court(fps['J1']), 'USBlabel')
    assert res, 'USB-C label: no clear spot'
    log['labels'].append({'text': usbl.GetText(), 'placed': res})
    def dens(f):
        cb = court(f) if f.GetReference() != 'ANT1' else [0, 0, 1, 1]
        return -sum(1 for _ in world.pads.near([cb[0] - 1.5, cb[1] - 1.5], [cb[2] + 1.5, cb[3] + 1.5], 0))
    order = sorted(todo, key=lambda f: (dens(f), f.GetReference()))
    left = []
    for f in order:
        res = place_ref(world, f, f.Reference())
        if res: log['refs'].append(res)
        else: left.append(f)
    left2 = []
    for f in left:
        res = place_ref(world, f, f.Reference(), relaxed=True)
        if res: log['refs'].append(res)
        else: left2.append(f)
    left3 = []
    for f in left2:
        res = place_ref(world, f, f.Reference(), relaxed='tight')
        if res: log['refs'].append(res)
        else: left3.append(f)
    for f in left3:              # last resort: within 3 mm of its own courtyard even if another part is nearer (listed in README)
        res = place_ref(world, f, f.Reference(), relaxed='loose')
        if res: log['refs'].append(res)
        else: log['unplaced'].append(f.GetReference())
    # KiCad check: anything still flagged is hidden and reported (expected none)
    # J6 (back-side header, hand-soldered from the top): top-side name and pin-1 mark
    j6 = fps['J6']; p1 = pad_of(b, 'J6.1'); pr = rect(p1.GetBoundingBox())
    jb = [min(rect(q.GetBoundingBox())[0] for q in j6.Pads()), min(rect(q.GetBoundingBox())[1] for q in j6.Pads()),
          max(rect(q.GetBoundingBox())[2] for q in j6.Pads()), max(rect(q.GetBoundingBox())[3] for q in j6.Pads())]
    for i, (txt, box) in enumerate((('J6', jb), ('1', pr))):
        tx = k.PCB_TEXT(b); tx.SetText(txt); tx.SetLayer(k.F_SilkS); tx.SetUuid(ident(f'j6label:{i}'))
        tx.SetTextSize(k.VECTOR2I(k.FromMM(TXT_H), k.FromMM(TXT_H))); tx.SetTextThickness(k.FromMM(TXT_T)); b.Add(tx)
        res = place_ref(world, j6, tx, relaxed=(i == 1), owner=f'J6label{i}', cb=box)
        log['labels'].append({'text': txt, 'placed': res})
    for rnd in range(8):
        d = drc_json(b, f'silk{rnd}'); flagged, other, n = silk_flagged(d)
        log[f'drc_round{rnd}'] = {'silk_warnings': n, 'refs': sorted(flagged), 'other': other}
        if not flagged: break
        fps[sorted(flagged)[0]].Reference().SetVisible(False); log['unplaced'].append(sorted(flagged)[0] + ' (hidden after DRC)')
    k.ZONE_FILLER(b).Fill(b.Zones()); save(b)
    d = drc_json(b, 'after'); log['silk_after'] = silk_flagged(d)[2]; log['silk_other'] = silk_flagged(d)[1]
    log['teardrop_blocks_canonicalised'] = canonical_teardrops(ROOT / 'fieldnote.kicad_pcb')
    log['hidden'] = sorted(f.GetReference() for f in b.GetFootprints() if not f.Reference().IsVisible())
    log['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v053-finish.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'placed': len(log['refs']), 'unplaced': log['unplaced'], 'hidden': log['hidden'], 'silk_after': log['silk_after'],
                      'silk_other': log['silk_other'][:10]}))


# ---------------------------------------------------------------- teardrops ----------------------------------------------------
RF_NETS = {'NFC_TX1', 'NFC_TX2', 'RF1_FILTER', 'RF2_FILTER', 'RF1_MATCH', 'RF2_MATCH', 'ANT_A', 'ANT_B',
           'RF_RXP_COUPLED', 'RF_RXN_COUPLED', 'NFC_RXP', 'NFC_RXN'}     # the 12 nets of nfc-antenna-study extract_rf_routes.py
TD_SKIP_NETS = {'GND'} | RF_NETS    # GND ends sit in the GND pours; RF copper stays exactly as the antenna study modelled it
TD_TYPE_VIAPAD = 2                 # KiCad TEARDROP_TYPE::TD_VIAPAD


def td_targets(b):
    vias = {}
    for t in b.GetTracks():
        if isinstance(t, k.PCB_VIA):
            p = r.xy(t.GetPosition()); vias.setdefault(t.GetNetname(), []).append((p, k.ToMM(t.GetWidth(k.F_Cu))))
    pads = {}
    for f in b.GetFootprints():
        if f.GetReference() == 'ANT1': continue
        for pd in f.Pads():
            if pd.GetNetname(): pads.setdefault(pd.GetNetname(), []).append(pd)
    return vias, pads


def teardrops():
    """Straight teardrops where a track ends on a via or an SMD/THT pad: from the pad (90 % of its size across the track) to a
    point 0.5 x pad size (max 1 mm) along the track. Each is a KiCad teardrop zone (priority above the GND pours), so the zone
    filler clips it to the clearance rules. Not applied in the RF matching / PN7160 area (RF_BOX) or on GND."""
    app, b = load(); vias, pads = td_targets(b); made = []
    for t in sorted((t for t in b.GetTracks() if not isinstance(t, k.PCB_VIA)), key=lambda x: x.m_Uuid.AsString()):
        net = t.GetNetname(); w = k.ToMM(t.GetWidth()); L = t.GetLayer()
        if net in TD_SKIP_NETS: continue
        a, c = r.xy(t.GetStart()), r.xy(t.GetEnd()); n_ = math.dist(a, c)
        if n_ < .3: continue
        for e, o in ((a, c), (c, a)):
            if in_rf(e): continue
            u = [(o[0] - e[0]) / n_, (o[1] - e[1]) / n_]; nv = [-u[1], u[0]]
            tgt = None
            for p, dia in vias.get(net, []):
                if math.dist(p, e) < 1e-3: tgt = ('via', dia / 2, dia / 2); break
            if not tgt:
                for pd in pads.get(net, []):
                    if pd.IsOnLayer(L) and pd.HitTest(r.vec(e)) and math.dist(r.xy(pd.GetPosition()), e) < .05:
                        sx, sy = k.ToMM(pd.GetSize(L).x), k.ToMM(pd.GetSize(L).y)
                        ang = math.radians(pd.GetOrientationDegrees())
                        # pad half-extent along u and across u (rectangle in pad frame)
                        ux, uy = u[0] * math.cos(ang) + u[1] * math.sin(ang), -u[0] * math.sin(ang) + u[1] * math.cos(ang)
                        along = min(sx / 2 / max(abs(ux), 1e-9), sy / 2 / max(abs(uy), 1e-9))
                        across = min(sx / 2 / max(abs(uy), 1e-9), sy / 2 / max(abs(ux), 1e-9))
                        tgt = ('pad', along, across); break
            if not tgt: continue
            kind, along, across = tgt
            hh = .9 * across
            if w >= 1.8 * hh: continue                    # track already as wide as the pad
            ld = min(along * 2 * .5, 1.0)
            d = along + ld
            if d > n_ - .05: d = n_ - .05
            if d - along < .15: continue
            A = [e[0] + u[0] * d, e[1] + u[1] * d]; B_ = [e[0] + u[0] * along * .5, e[1] + u[1] * along * .5]
            pts = [[A[0] + nv[0] * w / 2, A[1] + nv[1] * w / 2], [B_[0] + nv[0] * hh, B_[1] + nv[1] * hh], [e[0] + nv[0] * hh, e[1] + nv[1] * hh],
                   [e[0] - nv[0] * hh, e[1] - nv[1] * hh], [B_[0] - nv[0] * hh, B_[1] - nv[1] * hh], [A[0] - nv[0] * w / 2, A[1] - nv[1] * w / 2]]
            if any(in_rf(q) for q in pts): continue
            z = k.ZONE(b); z.SetLayer(L); z.SetNet(b.FindNet(net)); z.SetAssignedPriority(30000 + len(made))   # unique: stable fill order
            z.SetUuid(ident(f'td:{t.m_Uuid.AsString()}:{0 if e is a else 1}'))
            z.SetZoneName('$teardrop_padvia$'); z.SetPadConnection(k.ZONE_CONNECTION_FULL); z.SetLocalClearance(k.FromMM(0))
            z.SetMinThickness(k.FromMM(.1)); z.SetIslandRemovalMode(k.ISLAND_REMOVAL_MODE_ALWAYS)
            ol = z.Outline(); ol.NewOutline()
            for q in pts: ol.Append(k.FromMM(q[0] + 60), k.FromMM(q[1] + 50))
            b.Add(z); made.append({'net': net, 'layer': b.GetLayerName(L), 'at': e, 'to': kind})
    save(b)
    # KiCad 10's Python API does not expose TEARDROP_TYPE: mark the zones as pad/via teardrops in the file, then reload and fill
    txt = (ROOT / 'fieldnote.kicad_pcb').read_text(); n_marked = 0
    for z in re.findall(r'\n\t\(zone\n(?:\t\t.*\n)*?\t\)', txt):
        if '(name "$teardrop_padvia$")' in z and '(teardrop' not in z:
            z2 = z.replace('\t\t(name "$teardrop_padvia$")\n', '\t\t(name "$teardrop_padvia$")\n\t\t(attr\n\t\t\t(teardrop\n\t\t\t\t(type padvia)\n\t\t\t)\n\t\t)\n', 1)
            txt = txt.replace(z, z2, 1); n_marked += 1
    (ROOT / 'fieldnote.kicad_pcb').write_text(txt)
    b = k.LoadBoard(str(ROOT / 'fieldnote.kicad_pcb'))
    b.SetProject(k.GetSettingsManager().GetProject(str(ROOT / 'fieldnote.kicad_pro')))
    k.ZONE_FILLER(b).Fill(b.Zones()); save(b); canonical_teardrops(ROOT / 'fieldnote.kicad_pcb')
    assert n_marked == len(made), (n_marked, len(made))
    assert sum(1 for z in b.Zones() if z.IsTeardropArea()) == len(made)
    rep = {'count': len(made), 'by_kind': {x: sum(1 for m in made if m['to'] == x) for x in ('via', 'pad')}, 'items': made,
           'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v053-teardrops.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({k_: v for k_, v in rep.items() if k_ != 'items'}))


# ---------------------------------------------------------------- audit --------------------------------------------------------
STITCH = []        # (label, xy) GND stitch vias for pour islands cut loose by new copper (from the audit), added in route


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
        if z.GetIsRuleArea() or z.GetNetname() != 'GND' or z.IsTeardropArea(): continue
        for li in z.GetLayerSet().Seq():
            if li == k.In1_Cu: continue
            fp = z.GetFilledPolysList(li)
            for i in range(fp.OutlineCount()):
                sub = k.SHAPE_POLY_SET(); sub.AddOutline(fp.Outline(i))
                ok = False
                for a in anchors:
                    if a[0] == 'c' and sub.Collide(a[1], int(a[2])): ok = True; break
                    if a[0] == 's' and a[3] == li and sub.Collide(k.SEG(a[1], a[2]), 0): ok = True; break
                if not ok:
                    bb = fp.Outline(i).BBox()
                    out.append({'zone': z.GetZoneName(), 'layer': b.GetLayerName(li), 'bbox': rect(bb), 'area_mm2': round(sub.Area() / 1e12, 3)})
    return out


def audit():
    import collections
    app, b = load(); src = k.LoadBoard(str(SRC))
    s0, s1 = r.track_snapshot(src), r.track_snapshot(b)
    ripped = set(json.loads((OUT / 'v053-textprep.json').read_text())['ripped'])
    removed = sorted(set(s0) - set(s1)); added = sorted(set(s1) - set(s0))
    changed = [u for u in s0 if u in s1 and s0[u] != s1[u]]
    rep = {'source_board_sha256': sha(SRC), 'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    rep['removed'] = {'count': len(removed), 'all_in_textprep_rip_list': set(removed) == ripped}
    rep['changed_preexisting'] = changed
    by_net = {}
    for u in added:
        by_net.setdefault(s1[u]['net'], {'tracks': 0, 'vias': 0, 'len_mm': 0.})
        x = by_net[s1[u]['net']]
        if s1[u]['kind'] == 'via': x['vias'] += 1
        else: x['tracks'] += 1; x['len_mm'] = round(x['len_mm'] + math.dist(s1[u]['start'], s1[u]['end']), 2)
    rep['added'] = {'count': len(added), 'by_net': by_net}
    rep['in1_tracks'] = [u for u, v in s1.items() if v['kind'] == 'track' and v['layer'] == k.In1_Cu]
    rep['non_octilinear_new_segments'] = [u for u in added if s1[u]['kind'] == 'track' and not R.octi(s1[u]['start'], s1[u]['end'], 1e-3)]
    f0 = {f.GetReference(): (r.xy(f.GetPosition()), f.GetOrientationDegrees(), f.GetValue()) for f in src.GetFootprints()}
    f1 = {f.GetReference(): (r.xy(f.GetPosition()), f.GetOrientationDegrees(), f.GetValue()) for f in b.GetFootprints()}
    rep['footprints'] = {'added': sorted(set(f1) - set(f0)), 'removed': sorted(set(f0) - set(f1)),
                         'moved': sorted(x for x in f0 if x in f1 and (f0[x][0] != f1[x][0] or f0[x][1] != f1[x][1])),
                         'value_changed': {x: [f0[x][2], f1[x][2]] for x in f0 if x in f1 and f0[x][2] != f1[x][2]}}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    rep['J6_pad_clearance_mm'] = {x: round(j6_distance(b, fps[x]), 2) for x in SUP + NEW}
    rep['rf_area_footprints_moved'] = [x for x in rep['footprints']['moved'] if in_rf(f0[x][0])]
    rep['rf_area_copper_changed'] = [u for u in removed + added if any(in_rf(p) for p in ((s0.get(u) or s1.get(u))['start'], (s0.get(u) or s1.get(u))['end']))]
    rf0 = sorted((v['kind'], v['net'], v['layer'], tuple(v['start']), tuple(v['end']), v.get('width'), v.get('diameter')) for v in s0.values() if v['net'] in RF_NETS)
    rf1 = sorted((v['kind'], v['net'], v['layer'], tuple(v['start']), tuple(v['end']), v.get('width'), v.get('diameter')) for v in s1.values() if v['net'] in RF_NETS)
    rep['rf_nets_copper_identical_to_v052'] = rf0 == rf1
    rep['rf_nets_items'] = len(rf1)
    rep['teardrops_on_rf_nets'] = sum(1 for z in b.Zones() if z.IsTeardropArea() and z.GetNetname() in RF_NETS)
    a0 = next(f for f in src.GetFootprints() if f.GetReference() == 'ANT1'); a1 = fps['ANT1']
    geo = lambda f: sorted((it.GetShapeStr(), r.xy(it.GetStart()), r.xy(it.GetEnd()), k.ToMM(it.GetWidth()), it.GetLayer()) for it in f.GraphicalItems() if isinstance(it, k.PCB_SHAPE))
    rep['ant1_identical_to_v052'] = (r.xy(a0.GetPosition()), a0.GetOrientationDegrees(), geo(a0), [(p.GetNumber(), r.xy(p.GetPosition())) for p in a0.Pads()]) == \
                                    (r.xy(a1.GetPosition()), a1.GetOrientationDegrees(), geo(a1), [(p.GetNumber(), r.xy(p.GetPosition())) for p in a1.Pads()])
    rep['teardrop_zones'] = sum(1 for z in b.Zones() if z.IsTeardropArea())
    rep['gnd_islands_without_via_or_track'] = anchored_islands(b)
    rep['hidden_references'] = sorted(f.GetReference() for f in b.GetFootprints() if not f.Reference().IsVisible())
    drc = json.loads((OUT / 'v053-drc.json').read_text())
    rep['drc'] = {'errors': sum(1 for v in drc['violations'] if v['severity'] == 'error'),
                  'warnings': dict(collections.Counter(v['type'] for v in drc['violations'] if v['severity'] == 'warning')),
                  'unconnected': len(drc['unconnected_items']), 'parity': len(drc['schematic_parity'])}
    (OUT / 'v053-audit.json').write_text(json.dumps(rep, indent=2, default=str) + '\n')
    print(json.dumps({k_: v for k_, v in rep.items() if k_ not in ('changed_preexisting',)} | {'changed_preexisting': len(changed)}, default=str))


# ---------------------------------------------------------------- necks ------------------------------------------------------
NECK_NETS = ['VBUS', 'VIN_SEL']


def necks():
    """Remaining 0.30-0.35 mm VBUS / VIN_SEL segments: widen in place to the widest legal width (0.4-0.6 mm) where clearance,
    the board edge and the pad they land on allow (a track is never made wider than the smallest SMD pad it touches)."""
    app, b = load(); log = []
    pads = [pd for f in b.GetFootprints() for pd in f.Pads()]
    for net in NECK_NETS:
        tracks = sorted((t for t in b.GetTracks() if t.GetNetname() == net and not isinstance(t, k.PCB_VIA) and .299 <= k.ToMM(t.GetWidth()) <= .351),
                        key=lambda x: x.m_Uuid.AsString())
        for t in tracks:
            L = b.GetLayerName(t.GetLayer()); w0 = round(k.ToMM(t.GetWidth()), 3); a, c = r.xy(t.GetStart()), r.xy(t.GetEnd())
            touched = [pd for pd in pads if pd.GetNetname() == net and not pd.GetDrillSize().x and (A.pad_touches(pd, a, t.GetLayer()) or A.pad_touches(pd, c, t.GetLayer()))]
            cap = min([min(k.ToMM(pd.GetSize(k.F_Cu).x), k.ToMM(pd.GetSize(k.F_Cu).y)) for pd in touched] or [9])
            new = None
            for w in (.6, .55, .5, .45, .4):
                if w <= w0 + 1e-6 or w > cap + 1e-6: continue
                if outline_ok(a, c, w) and r.collision_test(b, net, w, L)(a, c): new = w; break
            entry = {'uuid': t.m_Uuid.AsString(), 'net': net, 'layer': L, 'len': round(math.dist(a, c), 3), 'from': w0, 'pad_cap': cap}
            if new: t.SetWidth(k.FromMM(new)); entry['to'] = new
            else: entry['to'] = w0; entry['why'] = 'pad width' if cap <= w0 + .05 else 'clearance'
            log.append(entry)
    save(b)
    rep = {'segments': log, 'widened': [x for x in log if x['to'] > x['from']],
           'left_mm': {n: round(sum(x['len'] for x in log if x['net'] == n and x['to'] <= .351), 2) for n in NECK_NETS},
           'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb')}
    (OUT / 'v053-necks.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({'checked': len(log), 'widened': len(rep['widened']), 'left_mm': rep['left_mm']}))

if __name__ == '__main__':
    PHASES = {'textprep': textprep, 'surgery': surgery, 'place': place, 'route': route, 'finish': finish, 'teardrops': teardrops, 'audit': audit, 'necks': necks}
    PHASES[sys.argv[1]]()
