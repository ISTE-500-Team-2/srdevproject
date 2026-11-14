#!/usr/bin/env python3
"""v0.5.4 layout on top of the frozen v0.5.3 board (source-v053/fieldnote.kicad_pcb, SHA-256 200afafc...).

Phases (KiCad python apply_v054_pcb.py <phase>):
  textprep  - text edit of the frozen board (pcbnew deletion in a loop is unreliable). Selected with pcbnew (read only):
                * the footprints of the removed parts (field power, JP1, RGB LED driver);
                * all copper of the nets that disappear or are re-routed whole (VIN_SEL, USB_HIGH_CURRENT, the field nets, the
                  RGB nets, LED_GREEN/BLUE/RED, SUP_RESET_N);
                * every branch left dangling by a removed part or by a part that moves (U12/R46/C46/R30): leaf pruning,
                  per net, until each remaining track end touches live copper (GND stubs only when they led to a dead pad);
                * all teardrop zones (regenerated for the whole board) and all fills (refilled);
                * the JP1 / J6 / old-LED board labels; IO_INT copper renamed BAT_ADC.
  surgery   - import the new footprints (LED bar, U13, SW3, passives), sync pad nets / values / MPN / DNP from
              design-data.json, add the NFC top-edge no-copper band (rule area, all four layers).
  place     - fixed, legality-checked placement.
  route     - hand-drawn regular copper (LED rail / stubs / chain, U13 local) checked against the collision model, then the
              45-degree A* router (route45.py on route_pn7160.collision_test, which honours rule areas) and GND vias.
  necks     - widen the remaining VBUS segments where legal.
  teardrops - straight teardrop zones on every non-GND, non-RF track end (as v0.5.3).
  finish    - silkscreen: references, RUN/SVC, board title v0.5.4; zone refill. (Mounting holes: item dropped by the owner.)
  audit     - track/via diff against the frozen source, In1 track check, GND island check, RF copper identity.
"""
from pathlib import Path
import hashlib, json, math, re, sys, uuid
import wx
import pcbnew as k
import route_pn7160 as r
import route45 as R
import apply_v05_pcb as A
import apply_v053_pcb as V3          # helper library (legality, silk, teardrops, islands); its v0.5.3 constants are not used

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
A.ROOT = ROOT; A.OUT = OUT; V3.ROOT = ROOT; V3.OUT = OUT
SRC = ROOT / 'source-v053' / 'fieldnote.kicad_pcb'
V053_BOARD = '200afafc5739c0ff028bbf5e4ac5cbdd6387b6d1bd80c1f6bd4134b442f18ac5'
PCB = ROOT / 'fieldnote.kicad_pcb'

REMOVE = ['J6', 'U10', 'U11', 'JP2', 'R31', 'R32', 'R33', 'R34', 'R35', 'R36', 'R37', 'C39', 'C40', 'C41', 'C42', 'C43', 'R47',
          'JP1', 'D5', 'Q1', 'Q2', 'Q3', 'R38', 'R39', 'R40', 'R41', 'R42', 'R43', 'R16', 'R17', 'R18']
MOVE = ['U12', 'R46', 'C46', 'R30']
VBUS_KEEP = {'d96073a5', '9e645d52', 'c6a62903', '60e95c3e', 'bf6828c1'}   # J1 left-pad / R1 link via the top run, re-joined at (58.822, 3.72)
VBUS_THIN = {'cdf0986b', '6af503d0', 'd16afc48'}     # (55.55,5.318)-(56.85)-(57.223,5.318)-(58.822,3.72)
RIP_NETS = {'CHG_ISET', 'VIN_SEL', 'USB_HIGH_CURRENT', '5V_FIELD', 'FIELD_PG', 'PWR_SRC', 'MUX_CP2', 'MUX_PR1', 'MUX_ILM', 'MUX_SS',
            'LED_GREEN', 'LED_BLUE', 'LED_RED', 'LEDR_K', 'LEDG_K', 'LEDB_K', 'LEDR_D', 'LEDG_D', 'LEDB_D', 'LEDR_GATE',
            'LEDG_GATE', 'LEDB_GATE', 'SUP_RESET_N'}
LABELS_DROP = [('USB', '83.7 58.65'), ('SVC', '86.2 58.65'), ('J6', '128.367 71.898'), ('1', '128.821 75.038'),
               ('G', '70.7 51.2'), ('A', '80.7 51.2'), ('R', '90.7 51.2')]
LED_N = 10
LED_X0, LED_PITCH, LED_Y = 30.95, 3.1, 4.2
LEDS = [(f'D{10 + i}', round(LED_X0 - LED_PITCH * i, 3)) for i in range(LED_N)]
CAPS = [f'C{47 + i}' for i in range(LED_N)]
BAND = (0.0, 9.6, 33.1, 10.7)            # NFC top-edge no-copper band: 2.0 mm above the coil outer-turn copper (y 11.6)
RF_NETS = V3.RF_NETS


def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def data(): return json.loads((ROOT / 'design-data.json').read_text())
def ident(key): return k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL, 'fieldnote-v054:' + key)))
def load(): return A.load()
def save(b): A.save(b)
def LN(b, l): return b.GetLayerName(l)


def add_via(b, net, p, key, dia=.5, drill=.2):
    v = k.PCB_VIA(b); v.SetUuid(ident(key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(dia)); v.SetDrill(k.FromMM(drill))
    v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet(net)); v.SetLocked(True)
    v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v); return v


def add_track(b, net, layer, a, c, w, key):
    t = k.PCB_TRACK(b); t.SetUuid(ident(key)); t.SetStart(V3.snap(b, net, a)); t.SetEnd(V3.snap(b, net, c))
    t.SetLayer(layer if isinstance(layer, int) else b.GetLayerID(layer))
    t.SetNet(b.FindNet(net)); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t); return t


# ---------------------------------------------------------------- textprep ---------------------------------------------------
def rip_selection():
    """UUIDs of every copper item to rip, selected on the frozen source with pcbnew (read only).
    Non-GND nets: graph of the net's surviving tracks/vias and live pads (pads of removed or moving parts are dead). Any
    connected piece without a live pad, and any piece hanging off a single articulation item without a live pad (dangling
    branch or dead-end loop, e.g. the VBUS F.Cu/B.Cu mesh to the old TPS2121), is ripped. GND: leaf pruning only (stubs and
    stub vias that led to a dead pad), because GND copper also connects through the pours."""
    app = wx.App(False)
    b = k.LoadBoard(str(SRC))
    dead_fp = set(REMOVE) | set(MOVE)
    items = {t.m_Uuid.AsString(): t for t in b.GetTracks()}
    sel = {u: 'net ' + t.GetNetname() for u, t in items.items() if t.GetNetname() in RIP_NETS}
    for u, t in items.items():
        if u[:8] in VBUS_THIN: assert t.GetNetname() == 'VBUS'; sel[u] = 'VBUS 0.35-0.45 mm J1 to BQ path (re-drawn 0.8 mm)'
    via = lambda t: isinstance(t, k.PCB_VIA)
    bynet, padsof = {}, {}
    for u, t in items.items():
        if u not in sel: bynet.setdefault(t.GetNetname(), []).append(u)
    for f in b.GetFootprints():
        for i, pd in enumerate(f.Pads()):
            if pd.GetNetname(): padsof.setdefault(pd.GetNetname(), []).append((f'{f.GetReference()}.{pd.GetNumber()}#{i}', f.GetReference(), pd))
    def ends(t): return [r.xy(t.GetPosition())] if via(t) else [r.xy(t.GetStart()), r.xy(t.GetEnd())]
    def touch(t1, t2):
        if via(t1) and via(t2): return math.dist(ends(t1)[0], ends(t2)[0]) < 1e-3
        if via(t1) or via(t2):
            v, o = (t1, t2) if via(t1) else (t2, t1); c = ends(v)[0]; rad = k.ToMM(v.GetWidth(k.F_Cu)) / 2
            return any(math.dist(c, e) <= rad + 1e-4 for e in ends(o)) or r.point_segment(c, *ends(o)) < 2e-3
        if t1.GetLayer() != t2.GetLayer(): return False
        return any(r.point_segment(e, *ends(t2)) < 2e-3 for e in ends(t1)) or any(r.point_segment(e, *ends(t1)) < 2e-3 for e in ends(t2))
    def touch_pad(pd, t):
        if via(t): return pd.HitTest(r.vec(ends(t)[0]))
        return pd.IsOnLayer(t.GetLayer()) and any(pd.HitTest(r.vec(e)) for e in ends(t))
    for net, us in sorted(bynet.items()):
        npads = padsof.get(net, [])
        nodes = list(sorted(us)) + [name for name, ref, pd in npads if ref not in dead_fp]
        livepads = {name: pd for name, ref, pd in npads if ref not in dead_fp}
        adj = {n: set() for n in nodes}
        for i, a in enumerate(us):
            for c in us[i + 1:]:
                if touch(items[a], items[c]): adj[a].add(c); adj[c].add(a)
            for name, pd in livepads.items():
                if touch_pad(pd, items[a]): adj[a].add(name); adj[name].add(a)
        alive = set(nodes)
        def comps(skip):
            seen, out = set(skip), []
            for n in sorted(alive):
                if n in seen: continue
                stack, comp = [n], set()
                while stack:
                    x = stack.pop()
                    if x in seen or x not in alive: continue
                    seen.add(x); comp.add(x); stack += [y for y in adj[x] if y in alive and y not in seen]
                out.append(comp)
            return out
        deadtouch = {u for u in us if any(ref in dead_fp and touch_pad(pd, items[u]) for _, ref, pd in npads)}
        anchors = {u for u in us if u[:8] in VBUS_KEEP}
        def removable(comp):
            if comp & (set(livepads) | anchors): return False
            return net != 'GND' or bool(comp & deadtouch)
        def free_end(u):
            t = items[u]
            if via(t) or u in anchors: return False
            for e in ends(t):
                if any(pd.IsOnLayer(t.GetLayer()) and pd.HitTest(r.vec(e)) for pd in livepads.values()): continue
                ok = False
                for x in adj[u]:
                    if x not in alive or x not in items: continue
                    o = items[x]
                    if via(o): ok = math.dist(e, ends(o)[0]) <= k.ToMM(o.GetWidth(k.F_Cu)) / 2 + 1e-4
                    else: ok = r.point_segment(e, *ends(o)) < 2e-3
                    if ok: break
                if not ok: return True
            return False
        changed = True
        while changed:
            changed = False
            if net != 'GND':
                for u in sorted(x for x in alive if x in items):
                    if free_end(u): alive.discard(u); sel[u] = 'dangling ' + net; changed = True
                if changed: continue
            for comp in comps(()):
                if removable(comp):
                    for x in comp: alive.discard(x); sel[x] = ('island ' if net != 'GND' else 'dead stub ') + net
                    changed = True
            if changed: continue
            for v in sorted(alive):
                parts = comps((v,))
                if len(parts) < 2: continue
                for comp in parts:
                    if removable(comp):
                        for x in comp: alive.discard(x); sel[x] = ('dead branch ' if net != 'GND' else 'dead stub ') + net
                        changed = True
                if changed: break
    assert not [u for u in sel if u in items and items[u].GetNetname() in RF_NETS], 'RF copper selected'
    out = {}
    for u, why in sel.items():
        if u not in items: continue
        t = items[u]
        out[u] = {'net': t.GetNetname(), 'kind': 'via' if via(t) else 'track', 'layer': b.GetLayerName(t.GetLayer()), 'pts': ends(t),
                  'why': why, 'len': 0 if via(t) else round(k.ToMM(t.GetLength()), 3)}
    return out


def blocks(t, kind):
    return re.findall(r'\n\t\(' + kind + r'\n(?:\t\t.*\n)*?\t\)', t)


def textprep():
    assert sha(SRC) == V053_BOARD
    sel = rip_selection()
    t = SRC.read_text()
    removed = 0
    for blk in blocks(t, '(?:segment|via|arc)'):
        m = re.search(r'\(uuid "([0-9a-f-]+)"\)', blk)
        if m and m.group(1) in sel:
            t = t.replace(blk, '', 1); removed += 1
    assert removed == len(sel), (removed, len(sel))
    fps = []
    for blk in blocks(t, 'footprint "[^"]+"'):
        m = re.search(r'\(property "Reference" "([^"]+)"', blk)
        if m and m.group(1) in REMOVE:
            t = t.replace(blk, '', 1); fps.append(m.group(1))
    assert sorted(fps) == sorted(REMOVE), set(REMOVE) ^ set(fps)
    tds = 0
    for z in blocks(t, 'zone'):
        if '(teardrop' in z:
            t = t.replace(z, '', 1); tds += 1; continue
        z2 = re.sub(r'\n\t\t\(filled_polygon\n(?:\t\t\t.*\n)*?\t\t\)', '', z)
        if z2 != z: t = t.replace(z, z2, 1)
    labels = []
    for txt, at in LABELS_DROP:
        found = [blk for blk in blocks(t, 'gr_text "' + re.escape(txt) + '"') if f'(at {at} ' in blk]
        assert len(found) == 1, (txt, at, len(found))
        t = t.replace(found[0], '', 1); labels.append(txt)
    n_io = t.count('(net "IO_INT")')
    t = t.replace('(net "IO_INT")', '(net "BAT_ADC")')
    PCB.write_text(t)
    by = {}
    for u, s in sel.items():
        key = (s['why'], s['net']); by.setdefault(key, {'tracks': 0, 'vias': 0, 'len_mm': 0.})
        by[key]['vias' if s['kind'] == 'via' else 'tracks'] += 1; by[key]['len_mm'] = round(by[key]['len_mm'] + s['len'], 2)
    rep = {'source_board_sha256': V053_BOARD, 'ripped': sel, 'summary': [{'why': a, 'net': n, **v} for (a, n), v in sorted(by.items())],
           'footprints_removed': sorted(fps), 'teardrops_removed': tds, 'labels_removed': labels, 'io_int_renamed_items': n_io,
           'board_sha256': sha(PCB)}
    (OUT / 'v054-textprep.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({'ripped': len(sel), 'footprints': len(fps), 'teardrops': tds, 'renamed': n_io}))


# ---------------------------------------------------------------- surgery ----------------------------------------------------
SHEET = {'Indicators': 'esp32-leds', 'MCU': 'esp32-leds', 'Power': 'usb-power', 'USB': 'usb-power'}


def surgery():
    app, b = load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    import build_design as g
    for name in sorted({n for p in d['parts'] for n in p['nets'].values() if n}):
        A.net(b, name)
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    new = sorted(set(parts) - set(fps))
    for ref in new:
        p = parts[ref]
        f = k.FootprintLoad(str(ROOT / 'Fieldnote.pretty'), p['fp']); assert f, p['fp']
        f.SetReference(ref); f.SetUuid(k.KIID(g.uid(ref))); f.SetFPID(k.LIB_ID('Fieldnote', p['fp'])); b.Add(f)
        f.SetPosition(r.vec([-40, -40]))
        f.SetPath(k.KIID_PATH('/' + g.ROOT_UUID + '/' + g.uid('sheet' + SHEET[p['group']]) + '/' + g.uid(ref)))
        f.SetValue(p['value']); f.SetField('MPN', p['mpn']); f.GetField('MPN').SetVisible(False); f.Value().SetVisible(False)
        for i, item in enumerate(list(f.GetFields()) + list(f.Pads()) + list(f.GraphicalItems()) + list(f.Zones())):
            item.SetUuid(ident(f'{ref}:sub{i}'))
        fps[ref] = f
    changed = []
    for p in d['parts']:
        f = fps[p['ref']]
        if f.GetValue() != p['value']: changed.append([p['ref'], 'value', f.GetValue(), p['value']]); f.SetValue(p['value'])
        if bool(f.IsDNP()) != bool(p['dnp']): changed.append([p['ref'], 'dnp', bool(f.IsDNP()), bool(p['dnp'])]); f.SetDNP(bool(p['dnp']))
        if f.GetFieldText('MPN') != p['mpn'] and p['ref'] not in new:
            changed.append([p['ref'], 'MPN', f.GetFieldText('MPN'), p['mpn']]); f.SetField('MPN', p['mpn'])
        for pd in f.Pads():
            num = pd.GetNumber()
            if not num:
                pd.SetNet(b.FindNet('')) if False else None
                continue
            nn = p['nets'][num]; name = p['names'].get(num, num)
            nn = nn or ('unconnected-(' + p['ref'] + '-' + ('' if name == num else name + '-') + 'Pad' + num + ')')
            if pd.GetNetname() != nn and p['ref'] not in new: changed.append([p['ref'], num, pd.GetNetname(), nn])
            pd.SetNet(A.net(b, nn)); pd.SetPinFunction(name)
    # NFC top-edge band: deliberate no-copper rule area on all four layers, 2.0 mm above the coil outer turn
    z = k.ZONE(b); z.SetUuid(ident('nfc-band')); z.SetIsRuleArea(True); z.SetZoneName('NFC top-edge no-copper band')
    ls = k.LSET(); [ls.AddLayer(l) for l in (k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu)]; z.SetLayerSet(ls)
    z.SetDoNotAllowTracks(True); z.SetDoNotAllowVias(True); z.SetDoNotAllowPads(True); z.SetDoNotAllowZoneFills(True)
    z.SetDoNotAllowFootprints(False)
    ol = z.Outline(); ol.NewOutline()
    for x, y in ((BAND[0], BAND[1]), (BAND[2], BAND[1]), (BAND[2], BAND[3]), (BAND[0], BAND[3])): ol.Append(k.FromMM(x + 60), k.FromMM(y + 50))
    b.Add(z)
    for item in b.GetDrawings():
        if isinstance(item, k.PCB_TEXT) and item.GetText().startswith('FIELDNOTE PN7160 v0.5.3'):
            item.SetText('FIELDNOTE PN7160 v0.5.4 - 2026-11-13 - BLACK MASK / WHITE SILK / ENIG')
    save(b)
    rep = {'imported': new, 'changed': changed, 'band': BAND, 'board_sha256': sha(PCB)}
    (OUT / 'v054-surgery.json').write_text(json.dumps(rep, indent=2) + '\n'); print(json.dumps({'imported': len(rep['imported']), 'changed': len(changed)}))


# ---------------------------------------------------------------- place ------------------------------------------------------
# Light bar: D10 (first in the chain, data enters here) at the right end, pitch 3.1 mm, axis y 4.2 (old light-guide axis);
# every LED in the JLC orientation (DO / VDD on the top row, GND / DI on the bottom row), so each DO -> DI hop is one 45-degree
# 1.56 mm run between neighbours. Decoupling 0402 above each LED (pad 1 on the VDD side), U13 / C57-C59 / R50 under D10-D12.
FIXED = {**{ref: ([x, LED_Y], 0) for ref, x in LEDS}, **{CAPS[i]: ([LEDS[i][1], 2.25], 180) for i in range(LED_N)},
         'U13': ([29.85, 7.7], 90), 'C59': ([27.3, 6.88], 270), 'C58': ([26.3, 9.0], 180), 'C57': ([24.5, 7.4], 180),
         'R50': ([32.4, 6.6], 270),
         # service switch on the right edge: knob 0.5 mm past the board edge (x 74), knob up = RUN, down = SVC
         'SW3': ([71.35, 17.0], 270), 'R30': ([67.4, 16.25], 180),
         # supervisor group, moved from the top-left strip into the area freed by J6 / U10 / U11
         'U12': ([67.5, 23.4], 0)}
PLACE = [   # ref, search box (board mm), angles, targets [(pad, 'net:NAME' | 'pad:REF.N', weight)]
    ('R46', (63.0, 23.0, 70.0, 26.2), (0, 90, 180, 270), [('1', 'pad:U12.2', 1), ('2', 'net:ESP_RESET_RC', 1)]),
    ('C46', (64.0, 20.5, 70.5, 26.2), (0, 90, 180, 270), [('1', 'pad:U12.3', 1), ('2', 'pad:U12.1', .3)]),
    # R48 stays out of the U1 / R12 / C4 pocket above GPIO1 (only one of its pads can escape there)
    ('R48', (54.0, 17.0, 62.0, 24.6), (0, 90, 180, 270), [('1', 'pad:U1.13', 1), ('2', 'pad:U13.3', .02)]),
]
OVERHANG = {'SW3'}          # knob courtyard deliberately past the board edge


def place():
    app, b = load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    moving = list(FIXED) + [x[0] for x in PLACE]
    before = {ref: [r.xy(fps[ref].GetPosition()), fps[ref].GetOrientationDegrees()] for ref in moving}
    for ref in moving: fps[ref].SetPosition(r.vec([-40, -40]))
    legal, commit = V3.legality(b, set(moving), set())
    res = {}
    for ref, (c, ang) in FIXED.items():
        f = fps[ref]; f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
        why = legal(f)
        if ref in OVERHANG and why in ('outside board', 'outside outline', 'edge'):
            why = overhang_check(b, f)
        if ref == 'U13' and why == 'keepout':          # courtyard reaches into the band (footprints allowed); pads checked here
            why = None if all(r.xy(pd.GetPosition())[1] + k.ToMM(pd.GetBoundingBox().GetHeight()) / 2 <= BAND[1] - .03 for pd in f.Pads()) else 'band'
        commit(f); parts[ref]['xy'] = c; parts[ref]['angle'] = ang
        res[ref] = {'xy': c, 'angle': ang, 'problem': why, 'was': before[ref]}
    for ref, box, angles, targets in PLACE:
        f = fps[ref]; tg = []
        for pad, spec, wgt in targets:
            if spec.startswith('net:'): tg.append((pad, V3.net_points(b, spec[4:], exclude_refs=moving), wgt))
            else: pd = V3.pad_of(b, spec[4:]); tg.append((pad, [r.xy(pd.GetPosition())], wgt))
        idx = [(pn, V3.Nearest(pts), w) for pn, pts, w in tg if pts]
        cands = []
        for ang in angles:
            f.SetOrientationDegrees(ang); f.SetPosition(r.vec([0, 0]))
            rel = {pd.GetNumber(): r.xy(pd.GetPosition()) for pd in f.Pads()}
            nx, ny = int(round((box[2] - box[0]) / .1)), int(round((box[3] - box[1]) / .1))
            for ix in range(nx + 1):
                for iy in range(ny + 1):
                    c = [round(box[0] + ix * .1, 2), round(box[1] + iy * .1, 2)]
                    sc = sum(w * nd.dist([c[0] + rel[pn][0], c[1] + rel[pn][1]]) for pn, nd, w in idx)
                    cands.append((round(sc, 4), ang, c))
        cands.sort(); best = None
        for sc, ang, c in cands:
            f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
            if legal(f): continue
            best = (sc, c, ang); break
        assert best, ref
        f.SetOrientationDegrees(best[2]); f.SetPosition(r.vec(best[1])); commit(f)
        parts[ref]['xy'] = best[1]; parts[ref]['angle'] = best[2]
        res[ref] = {'xy': best[1], 'angle': best[2], 'score_mm': round(best[0], 2), 'was': before[ref]}
    save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (OUT / 'v054-placement.json').write_text(json.dumps(res, indent=2) + '\n')
    bad = {k_: v['problem'] for k_, v in res.items() if v.get('problem')}
    print(json.dumps({'placed': len(res), 'problems': bad})); assert not bad, bad


def overhang_check(b, f):
    """Edge-overhanging part (SW3 knob): every pad >= 0.5 mm inside the outline; courtyard against all other front courtyards."""
    q = V3.poly()
    for pd in f.Pads():
        bb = V3.rect(pd.GetBoundingBox())
        for p in ([bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]):
            if not r.inside(p, q) or V3.edge_distance(p) < .5: return 'pad near edge'
    mine = V3.cpoly(f)
    for g_ in b.GetFootprints():
        if g_.GetReference() == f.GetReference() or g_.GetLayer() != k.F_Cu or g_.GetReference() in ('ANT1',) or g_.GetPosition().x < 0: continue
        if mine.Collide(V3.cpoly(g_), k.FromMM(.02)): return 'courtyard ' + g_.GetReference()
    return None


# ---------------------------------------------------------------- route ------------------------------------------------------
def via_forbidden(c):
    if c[0] < 33.4 and c[1] > BAND[1] - .3: return True        # NFC band + copper-free region
    if c[0] > 32.9 and c[1] > 36.4: return True                  # Wi-Fi antenna clearance / board step
    if V3.in_rf(c): return True
    return not r.inside(c, V3.poly()) or V3.edge_distance(c) < .55


V3.via_forbidden = via_forbidden; V3.add_via = add_via; V3.add_track = add_track


def led_copper():
    """Regular light-bar copper (net, layer, points, width) and vias (net, xy). Coordinates follow from FIXED."""
    segs, vias = [], []
    for i, (ref, x) in enumerate(LEDS):
        segs.append(('VSYS', 'F.Cu', [[x + .48, 1.0], [x + .48, 2.25]], .4))                    # rail -> cap pad 1
        segs.append(('VSYS', 'F.Cu', [[x + .48, 2.25], [x + .915, 2.685], [x + .915, 3.65]], .3))  # cap pad 1 -> VDD (pin 4)
        segs.append(('GND', 'F.Cu', [[x - .48, 2.25], [x - 1.23, 2.25]], .3)); vias.append(('GND', [x - 1.23, 2.25]))
        segs.append(('GND', 'F.Cu', [[x - .915, 4.75], [x - .915, 5.4]], .3)); vias.append(('GND', [x - .915, 5.4]))
        if i < LED_N - 1:                                                                         # DO -> next DI (left)
            segs.append((f'LED_D{i + 2}', 'F.Cu', [[x - .915, 3.65], [x - 2.015, 4.75], [x - 2.185, 4.75]], .2))
    segs.append(('VSYS', 'F.Cu', [[LEDS[-1][1] + .48, 1.0], [32.3, 1.0]], .6)); vias.append(('VSYS', [32.3, 1.0]))
    segs.append(('VSYS', 'In2.Cu', [[32.3, 1.0], [32.3, 5.0], [30.9, 6.4], [28.1, 6.4]], .6)); vias.append(('VSYS', [28.1, 6.4]))
    segs.append(('VSYS', 'F.Cu', [[27.3, 6.4], [28.1, 6.4], [28.9, 6.4]], .4))                    # C59.1 - via - U13.6 VCCB (vertex on the via)
    segs.append(('VSYS', 'F.Cu', [[25.45, 7.4], [25.45, 6.4], [27.3, 6.4]], .5))                 # C57.1 bulk
    segs.append(('LED_DIN', 'F.Cu', [[30.8, 6.4], [30.8, 5.75], [31.8, 4.75], [31.865, 4.75]], .2))  # U13.4 B -> D10 DI
    segs.append(('LED_DIN', 'F.Cu', [[30.8, 5.75], [32.4, 5.75], [32.4, 6.09]], .2))           # R50 first-DIN pulldown
    segs.append(('3V3', 'F.Cu', [[29.85, 6.4], [29.85, 7.0], [29.2, 7.65]], .2))                 # DIR -> VCCA
    segs.append(('3V3', 'F.Cu', [[28.9, 9.0], [28.9, 7.95], [29.2, 7.65]], .3))                # VCCA
    segs.append(('3V3', 'F.Cu', [[26.78, 9.0], [28.9, 9.0]], .3))                               # C58.1
    segs.append(('GND', 'F.Cu', [[29.85, 9.0], [29.85, 8.3], [30.45, 7.7]], .3)); vias.append(('GND', [30.45, 7.7]))
    segs.append(('GND', 'F.Cu', [[27.3, 7.36], [27.3, 8.1]], .3)); vias.append(('GND', [27.3, 8.1]))
    segs.append(('GND', 'F.Cu', [[25.82, 9.0], [25.0, 9.0]], .3)); vias.append(('GND', [25.0, 9.0]))
    segs.append(('GND', 'F.Cu', [[23.55, 7.4], [23.55, 8.65]], .5)); vias.append(('GND', [23.55, 8.65]))
    return segs, vias


def vbus_copper():
    """J1 right VBUS pad pair -> BQ24074 IN (pin 13) and C1: 0.8 mm F.Cu, 0.3 mm only for the last 0.75 mm into the 0.24 mm
    QFN land. The left pad pair / R1 / U5 link (kept) joins the bus at x 58.82. C1 tap 0.5 mm between the R6 pads (no DC)."""
    return [('VBUS', 'F.Cu', [[55.55, 5.318], [55.55, 5.6], [61.5, 5.6]], .8),
            ('VBUS', 'F.Cu', [[58.0, 5.6], [58.75, 6.35]], .8),
            ('VBUS', 'F.Cu', [[58.75, 6.35], [58.75, 7.4]], .3),
            ('VBUS', 'F.Cu', [[61.5, 5.6], [61.5, 8.75]], .5),
            ('VBUS', 'F.Cu', [[58.822, 3.72], [58.822, 5.6]], .6)], []


def hand(b, segs, vias, tag, log):
    bad = []
    for vi, (net, c) in enumerate(vias):
        ok = not via_forbidden(c) and all(r.collision_test(b, net, .5, L, True)(c, c) for L in r.ALL_COPPER)
        if not ok: bad.append(['via', net, c])
        add_via(b, net, c, f'{tag}:via{vi}')
    for si, (net, L, pts, w) in enumerate(segs):
        test = r.collision_test(b, net, w, L)
        for ti, (a, c) in enumerate(zip(pts, pts[1:])):
            if not test(a, c) or not V3.outline_ok(a, c, w) or not R.octi(a, c, 1e-6): bad.append(['seg', net, L, a, c, w])
            add_track(b, net, L, a, c, w, f'{tag}:{si}:{ti}')
    log.append({'group': tag, 'segments': sum(len(x[2]) - 1 for x in segs), 'vias': len(vias), 'problems': bad})
    print(json.dumps(log[-1]), flush=True)
    return not bad


def connect(b, net, start, widths, layers, max_vias, step, margin, key, log, opts=None):
    """v0.5.3 connect() with goals optionally restricted to copper near given points (opts['near'] = ([xy...], radius))."""
    opts = opts or {}
    cl, geo = V3.clusters(b, net)
    sk = ('pad', start); assert sk in cl, (net, start)
    mine = cl[sk]; others = [x for x in cl if cl[x] != mine]
    if not others:
        log.append({'net': net, 'from': start, 'skipped': 'already connected'}); return True
    goals = V3.goal_points(geo, others)
    if opts.get('near'):
        pts, rad = opts['near']; goals = [g_ for g_ in goals if any(math.dist(g_[0], p) <= rad for p in pts)]
        assert goals, (net, start, 'no goal near')
    pd = V3.pad_of(b, start); sxy = r.xy(pd.GetPosition())
    slay = [n for n, l in zip(r.ALL_COPPER, (k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu)) if pd.IsOnLayer(l)]
    if opts.get('from_via'): sxy, slay = opts['from_via'], list(layers)
    near = min(goals, key=lambda g_: math.dist(g_[0], sxy))[0]
    err = ''
    for m in ((None,) if opts.get('bounds') else (margin, margin * 2.5)):
        bounds = opts.get('bounds') or [max(V3.BOUNDS[0], min(sxy[0], near[0]) - m), max(V3.BOUNDS[1], min(sxy[1], near[1]) - m),
                                        min(V3.BOUNDS[2], max(sxy[0], near[0]) + m), min(V3.BOUNDS[3], max(sxy[1], near[1]) + m)]
        for nv in (sorted({0, max_vias}) if opts.get('direct', True) else [max_vias]):
            for w in widths:
                try:
                    legs, vias, L = R.route(b, net, (sxy, slay), goals, w, layers, bounds, max_vias=nv, step=step, turn=.35, via_cost=2.5,
                                            layer_cost=opts.get('layer_cost', {'In2.Cu': 1.2, 'B.Cu': 1.05}), via_ok=lambda c: not via_forbidden(c),
                                            max_states=int(opts.get('states', 1_500_000)), avoid=[V3.RF_BOX])
                except (RuntimeError, AssertionError) as ex:
                    err = str(ex)[:120]; continue
                if not all(V3.outline_ok(x, y, w) for _, q in legs for x, y in zip(q, q[1:])): err = 'edge'; continue
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


FB = ['F.Cu', 'B.Cu']
FBI = ['F.Cu', 'B.Cu', 'In2.Cu']
C3_NODE = ([[53.3, 16.0], [53.032, 14.75]], 1.6)      # VSYS at the BQ OUT bulk capacitor C3 (BQ OUT B.Cu trunk ends here)
ROUTES = [
    ('CHG_ISET', 'U3.16', (.2, .15), FBI, 2, .05, 4),
    ('LED_DATA', 'R48.1', (.2,), FBI, 3, .05, 6, {'states': 3_000_000}),
    ('LED_DATA_3V3', 'U13.3', (.2, .15), FBI, 4, .1, 8, {'states': 6_000_000, 'bounds': [26, 1, 64, 32], 'direct': False}),
    ('VSYS', 'U13.6', (.8, .7, .6), ['In2.Cu', 'B.Cu', 'F.Cu'], 4, .1, 8,
     {'near': C3_NODE, 'from_via': [28.1, 6.4], 'states': 6_000_000, 'bounds': [27, 1, 56, 20], 'direct': False,
      'layer_cost': {'In2.Cu': 1.0, 'B.Cu': 1.1, 'F.Cu': 1.3}}),
    ('SOURCE_QUALIFIED', 'U7.4', (.2, .15), FBI, 2, .05, 4),
    ('SOURCE_QUALIFIED', 'SW3.3', (.2,), FBI, 3, .1, 6, {'states': 3_000_000}),
    ('POWER_PERMIT', 'R30.1', (.2,), FBI, 2, .05, 3),
    ('POWER_PERMIT', 'SW3.2', (.2,), FBI, 3, .1, 6, {'near': ([[59.825, 26.5]], 4.0), 'states': 4_000_000, 'bounds': [55, 12, 73, 30]}),
    ('3V3', 'SW3.1', (.25, .2), FBI, 3, .1, 6, {'states': 3_000_000}),
    ('SUP_RESET_N', 'U12.2', (.2,), FB, 0, .05, 3),
    ('ESP_RESET_RC', 'R46.2', (.2,), FBI, 2, .1, 6),
    ('3V3', 'U12.3', (.3, .25), FBI, 2, .1, 6),
    ('3V3', 'C46.1', (.3, .25), FBI, 2, .05, 3),
    ('3V3', 'U13.1', (.3, .25), FBI, 3, .1, 6, {'states': 3_000_000}),
    ('PLACE_R49',),
    ('LED_DATA_3V3', 'R49.1', (.2,), FBI, 1, .05, 3),
]
GND_PADS = ['R50.2', 'R30.2', 'U12.1', 'C46.2', 'R49.2']


def place_late(b, ref, targets, box):
    """Search placement after routing (R49 sits on the LED_DATA_3V3 run, which exists only now)."""
    d = data(); parts = {p['ref']: p for p in d['parts']}
    f = next(x for x in b.GetFootprints() if x.GetReference() == ref)
    f.SetPosition(r.vec([-40, -40]))
    legal, commit = V3.legality(b, {ref}, set())
    idx = [(pn, V3.Nearest(V3.net_points(b, spec[4:], exclude_refs=[ref])), w) for pn, spec, w in targets]
    cands = []
    for ang in (0, 90, 180, 270):
        f.SetOrientationDegrees(ang); f.SetPosition(r.vec([0, 0]))
        rel = {pd.GetNumber(): r.xy(pd.GetPosition()) for pd in f.Pads()}
        for ix in range(0, int(round((box[2] - box[0]) / .1)) + 1):
            for iy in range(int(round((box[3] - box[1]) / .1)) + 1):
                c = [round(box[0] + ix * .1, 2), round(box[1] + iy * .1, 2)]
                if V3.in_rf(c): continue
                cands.append((round(sum(w * nd.dist([c[0] + rel[pn][0], c[1] + rel[pn][1]]) for pn, nd, w in idx), 4), ang, c))
    cands.sort()
    for sc, ang, c in cands:
        f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
        if not legal(f):
            commit(f); parts[ref]['xy'] = c; parts[ref]['angle'] = ang
            (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
            print(json.dumps({'late_place': ref, 'xy': c, 'angle': ang, 'score': sc}), flush=True)
            return {'xy': c, 'angle': ang, 'score_mm': sc}
    raise AssertionError(ref)


def route():
    app, b = load(); before = r.track_snapshot(b)
    log = {'hand': [], 'routes': [], 'ground': []}
    hand(b, *led_copper(), 'led', log['hand'])
    hand(b, *vbus_copper(), 'vbus', log['hand'])
    for i, spec in enumerate(ROUTES):
        if spec[0] == 'PLACE_R49':
            log['r49'] = place_late(b, 'R49', [('1', 'net:LED_DATA_3V3', 1)], (34.0, 8.0, 62.0, 27.6)); continue
        net, start, widths, layers, nv, step, margin = spec[:7]
        connect(b, net, start, widths, layers, nv, step, margin, f'r{i}', log['routes'], spec[7] if len(spec) > 7 else None)
    for spec in GND_PADS:
        V3.gnd_via(b, spec, log['ground'])
    # split nets left by the removals (e.g. R44's 3V3 used to reach the network through the J6.5 pad): connect every extra
    # copper cluster to the rest of its net
    log['repair'] = []
    for net in sorted({pd.GetNetname() for f in b.GetFootprints() for pd in f.Pads()} - {'GND', ''}):
        if net.startswith('unconnected-'): continue
        for attempt in range(4):
            cl, geo = V3.clusters(b, net)
            roots = {}
            for key, root in cl.items(): roots.setdefault(root, []).append(key)
            if len(roots) < 2: break
            small = min(roots.values(), key=lambda ks: (len(ks), sorted(map(str, ks))))
            pads = sorted(k_[1] for k_ in small if k_[0] == 'pad')
            if not pads: break
            ok = connect(b, net, pads[0], (.3, .25, .2), FBI, 4, .1, 10, f'fix:{net}:{attempt}', log['repair'], {'states': 3_000_000})
            if not ok: break
    now = r.track_snapshot(b)
    log['preexisting_copper_unchanged'] = all(now.get(u) == v for u, v in before.items())
    log['in1_tracks'] = [u for u, v in now.items() if v['kind'] == 'track' and v['layer'] == k.In1_Cu]
    save(b); log['board_sha256'] = sha(PCB)
    (OUT / 'v054-routing.json').write_text(json.dumps(log, indent=2) + '\n')
    failed = [x for x in log['routes'] + log['ground'] + log['repair'] if 'failed' in x] + [x for x in log['hand'] if x['problems']]
    print(json.dumps({'routes': len(log['routes']), 'failed': failed, 'in1_tracks': len(log['in1_tracks']),
                      'preserved': log['preexisting_copper_unchanged']}))


# ---------------------------------------------------------------- necks ------------------------------------------------------
NECK_NETS = ['VBUS', 'VSYS']


def necks():
    """Remaining 0.30-0.45 mm VBUS / VSYS segments (pre-existing copper): widen in place to the widest legal width (0.5-0.8 mm)
    where clearance, the board edge and the pads they land on allow (never wider than the smallest SMD pad touched)."""
    app, b = load(); log = []
    pads = [pd for f in b.GetFootprints() for pd in f.Pads()]
    for net in NECK_NETS:
        tracks = sorted((t for t in b.GetTracks() if t.GetNetname() == net and not isinstance(t, k.PCB_VIA) and .299 <= k.ToMM(t.GetWidth()) <= .451),
                        key=lambda x: x.m_Uuid.AsString())
        for t in tracks:
            L = b.GetLayerName(t.GetLayer()); w0 = round(k.ToMM(t.GetWidth()), 3); a, c = r.xy(t.GetStart()), r.xy(t.GetEnd())
            touched = [pd for pd in pads if pd.GetNetname() == net and not pd.GetDrillSize().x and (A.pad_touches(pd, a, t.GetLayer()) or A.pad_touches(pd, c, t.GetLayer()))]
            cap = min([min(k.ToMM(pd.GetSize(k.F_Cu).x), k.ToMM(pd.GetSize(k.F_Cu).y)) for pd in touched] or [9])
            new = None
            for w in (.8, .7, .6, .55, .5):
                if w <= w0 + 1e-6 or w > cap + 1e-6: continue
                if V3.outline_ok(a, c, w) and r.collision_test(b, net, w, L)(a, c): new = w; break
            entry = {'uuid': t.m_Uuid.AsString(), 'net': net, 'layer': L, 'len': round(math.dist(a, c), 3), 'from': w0, 'pad_cap': cap}
            if new: t.SetWidth(k.FromMM(new)); entry['to'] = new
            else: entry['to'] = w0; entry['why'] = 'pad width' if cap <= w0 + .05 else 'clearance'
            log.append(entry)
    save(b)
    rep = {'segments': log, 'widened': [x for x in log if x['to'] > x['from']],
           'left_mm': {n: round(sum(x['len'] for x in log if x['net'] == n and x['to'] <= .451), 2) for n in NECK_NETS},
           'board_sha256': sha(PCB)}
    (OUT / 'v054-necks.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({'checked': len(log), 'widened': len(rep['widened']), 'left_mm': rep['left_mm']}))


# ---------------------------------------------------------------- teardrops ----------------------------------------------------
def teardrops():
    """v0.5.3 teardrop generator (apply_v053_pcb.teardrops) on the whole v0.5.4 board: straight teardrop zones where a track ends
    on a via or pad; not on GND, not on the 12 RF nets, not in the RF matching box."""
    app, b = load(); vias, pads = V3.td_targets(b); made = []
    for t in sorted((t for t in b.GetTracks() if not isinstance(t, k.PCB_VIA)), key=lambda x: x.m_Uuid.AsString()):
        net = t.GetNetname(); w = k.ToMM(t.GetWidth()); L = t.GetLayer()
        if net in V3.TD_SKIP_NETS: continue
        a, c = r.xy(t.GetStart()), r.xy(t.GetEnd()); n_ = math.dist(a, c)
        if n_ < .3: continue
        for e, o in ((a, c), (c, a)):
            if V3.in_rf(e): continue
            u = [(o[0] - e[0]) / n_, (o[1] - e[1]) / n_]; nv = [-u[1], u[0]]
            tgt = None
            for p_, dia in vias.get(net, []):
                if math.dist(p_, e) < 1e-3: tgt = ('via', dia / 2, dia / 2); break
            if not tgt:
                for pd in pads.get(net, []):
                    if pd.IsOnLayer(L) and pd.HitTest(r.vec(e)) and math.dist(r.xy(pd.GetPosition()), e) < .05:
                        sx, sy = k.ToMM(pd.GetSize(L).x), k.ToMM(pd.GetSize(L).y)
                        ang = math.radians(pd.GetOrientationDegrees())
                        ux, uy = u[0] * math.cos(ang) + u[1] * math.sin(ang), -u[0] * math.sin(ang) + u[1] * math.cos(ang)
                        along = min(sx / 2 / max(abs(ux), 1e-9), sy / 2 / max(abs(uy), 1e-9))
                        across = min(sx / 2 / max(abs(uy), 1e-9), sy / 2 / max(abs(ux), 1e-9))
                        tgt = ('pad', along, across); break
            if not tgt: continue
            kind, along, across = tgt
            hh = .9 * across
            if w >= 1.8 * hh: continue
            ld = min(along * 2 * .5, 1.0); d_ = along + ld
            if d_ > n_ - .05: d_ = n_ - .05
            if d_ - along < .15: continue
            P = [e[0] + u[0] * d_, e[1] + u[1] * d_]; B_ = [e[0] + u[0] * along * .5, e[1] + u[1] * along * .5]
            pts = [[P[0] + nv[0] * w / 2, P[1] + nv[1] * w / 2], [B_[0] + nv[0] * hh, B_[1] + nv[1] * hh], [e[0] + nv[0] * hh, e[1] + nv[1] * hh],
                   [e[0] - nv[0] * hh, e[1] - nv[1] * hh], [B_[0] - nv[0] * hh, B_[1] - nv[1] * hh], [P[0] - nv[0] * w / 2, P[1] - nv[1] * w / 2]]
            if any(V3.in_rf(q) for q in pts): continue
            z = k.ZONE(b); z.SetLayer(L); z.SetNet(b.FindNet(net)); z.SetAssignedPriority(30000 + len(made))
            z.SetUuid(ident(f'td:{t.m_Uuid.AsString()}:{0 if e is a else 1}'))
            z.SetZoneName('$teardrop_padvia$'); z.SetPadConnection(k.ZONE_CONNECTION_FULL); z.SetLocalClearance(k.FromMM(0))
            z.SetMinThickness(k.FromMM(.1)); z.SetIslandRemovalMode(k.ISLAND_REMOVAL_MODE_ALWAYS)
            ol = z.Outline(); ol.NewOutline()
            for q in pts: ol.Append(k.FromMM(q[0] + 60), k.FromMM(q[1] + 50))
            b.Add(z); made.append({'net': net, 'layer': b.GetLayerName(L), 'at': e, 'to': kind})
    save(b)
    txt = PCB.read_text(); n_marked = 0
    for z in blocks(txt, 'zone'):
        if '(name "$teardrop_padvia$")' in z and '(teardrop' not in z:
            z2 = z.replace('\t\t(name "$teardrop_padvia$")\n', '\t\t(name "$teardrop_padvia$")\n\t\t(attr\n\t\t\t(teardrop\n\t\t\t\t(type padvia)\n\t\t\t)\n\t\t)\n', 1)
            txt = txt.replace(z, z2, 1); n_marked += 1
    PCB.write_text(txt)
    b = k.LoadBoard(str(PCB)); b.SetProject(k.GetSettingsManager().GetProject(str(ROOT / 'fieldnote.kicad_pro')))
    k.ZONE_FILLER(b).Fill(b.Zones()); save(b); V3.canonical_teardrops(PCB)
    assert n_marked == len(made), (n_marked, len(made))
    rep = {'count': len(made), 'by_kind': {x: sum(1 for m in made if m['to'] == x) for x in ('via', 'pad')}, 'items': made, 'board_sha256': sha(PCB)}
    (OUT / 'v054-teardrops.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({k_: v for k_, v in rep.items() if k_ != 'items'}))


# ---------------------------------------------------------------- finish (silkscreen) ------------------------------------------
TXT_H, TXT_T = .8, .15
KEEP_LABELS = {'BAT', '+', '-', 'USB-C 5V\n≥1.5A', 'FIELDNOTE', '2026-11-13'}


def finish():
    """v0.5.3 silkscreen procedure (apply_v053_pcb.finish): every front reference 0.8 mm / 0.15 mm at 0 or 90 deg, clear of pads,
    other bodies and the edge, nearest first; DRC silk loop hides what KiCad still flags. Plus: title v0.5.4, RUN / SVC at the
    SW3 knob ends."""
    app, b = load(); log = {'refs': [], 'unplaced': [], 'labels': []}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    for d in list(b.GetDrawings()):
        if isinstance(d, k.PCB_TEXT) and d.GetLayer() == k.F_SilkS:
            if d.GetText() == 'v0.5.3': d.SetText('v0.5.4')
            log['labels'].append({'text': d.GetText(), 'at': r.xy(d.GetPosition())})
    todo = []
    for f in b.GetFootprints():
        fld = f.Reference()
        fld.SetTextSize(k.VECTOR2I(k.FromMM(TXT_H), k.FromMM(TXT_H))); fld.SetTextThickness(k.FromMM(TXT_T)); fld.SetKeepUpright(True)
        if f.GetLayer() == k.B_Cu: fld.SetVisible(True); continue
        fld.SetLayer(k.F_SilkS); fld.SetMirrored(False); fld.SetVisible(False); todo.append(f)
    world = V3.SilkWorld(b)
    # SW3 knob labels: knob slides along y at the right edge; up (pin 3 side) = RUN, down (pin 1 side) = SVC
    sw = fps['SW3']; p1, p3 = r.xy(V3.pad_of(b, 'SW3.1').GetPosition()), r.xy(V3.pad_of(b, 'SW3.3').GetPosition())
    cb = V3.court(sw)
    for i, (txt, end) in enumerate((('RUN', 'top'), ('SVC', 'bottom'))):
        tx = k.PCB_TEXT(b); tx.SetText(txt); tx.SetLayer(k.F_SilkS); tx.SetUuid(ident(f'swlabel:{i}'))
        tx.SetTextSize(k.VECTOR2I(k.FromMM(TXT_H), k.FromMM(TXT_H))); tx.SetTextThickness(k.FromMM(TXT_T)); b.Add(tx)
        box = [cb[0], cb[1] - .1, min(cb[2], 73.3), cb[1] + .1] if end == 'top' else [cb[0], cb[3] - .1, min(cb[2], 73.3), cb[3] + .1]
        res = V3.place_label_scan(world, tx, [txt], box, f'SW3label{i}', reach=1.6)
        assert res, txt
        log['labels'].append({'text': txt, 'placed': res})

    def dens(f):
        cb_ = V3.court(f) if f.GetReference() != 'ANT1' else [0, 0, 1, 1]
        return -sum(1 for _ in world.pads.near([cb_[0] - 1.5, cb_[1] - 1.5], [cb_[2] + 1.5, cb_[3] + 1.5], 0))
    left = sorted(todo, key=lambda f: (dens(f), f.GetReference()))
    for relaxed in (False, True, 'tight', 'loose'):
        nxt = []
        for f in left:
            res = V3.place_ref(world, f, f.Reference(), relaxed=relaxed)
            if res: log['refs'].append(res)
            else: nxt.append(f)
        left = nxt
    log['unplaced'] = [f.GetReference() for f in left]
    for rnd in range(10):
        d = V3.drc_json(b, f'silk{rnd}'); flagged, other, n = V3.silk_flagged(d)
        log[f'drc_round{rnd}'] = {'silk_warnings': n, 'refs': sorted(flagged), 'other': other}
        if not flagged: break
        fps[sorted(flagged)[0]].Reference().SetVisible(False); log['unplaced'].append(sorted(flagged)[0] + ' (hidden after DRC)')
    k.ZONE_FILLER(b).Fill(b.Zones()); save(b)
    d = V3.drc_json(b, 'after'); log['silk_after'] = V3.silk_flagged(d)[2]; log['silk_other'] = V3.silk_flagged(d)[1]
    log['teardrop_blocks_canonicalised'] = V3.canonical_teardrops(PCB)
    log['hidden'] = sorted(f.GetReference() for f in b.GetFootprints() if not f.Reference().IsVisible())
    log['board_sha256'] = sha(PCB)
    (OUT / 'v054-finish.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'placed': len(log['refs']), 'unplaced': log['unplaced'], 'hidden': log['hidden'], 'silk_after': log['silk_after'],
                      'silk_other': log['silk_other'][:10]}))


# ---------------------------------------------------------------- audit --------------------------------------------------------
def audit():
    import collections
    app, b = load(); src = k.LoadBoard(str(SRC))
    s0, s1 = r.track_snapshot(src), r.track_snapshot(b)
    tp = json.loads((OUT / 'v054-textprep.json').read_text()); ripped = set(tp['ripped'])
    removed = sorted(set(s0) - set(s1)); added = sorted(set(s1) - set(s0))
    changed = [u for u in s0 if u in s1 and s0[u] != s1[u]]
    nk = {x['uuid'] for x in json.loads((OUT / 'v054-necks.json').read_text())['widened']}
    rep = {'source_board_sha256': sha(SRC), 'board_sha256': sha(PCB)}
    rep['removed'] = {'count': len(removed), 'equals_textprep_rip_list': set(removed) == ripped}
    def kind(u):
        a_, b_ = dict(s0[u]), dict(s1[u])
        if a_.get('net') == 'IO_INT' and b_.get('net') == 'BAT_ADC': a_['net'] = 'BAT_ADC'; tag = 'net rename IO_INT -> BAT_ADC'
        else: tag = ''
        if a_ == b_: return tag
        if {x: v for x, v in a_.items() if x != 'width'} == {x: v for x, v in b_.items() if x != 'width'} and u in nk: return (tag + ' + ' if tag else '') + 'neck widening'
        return 'OTHER'
    kinds = {u: kind(u) for u in changed}
    rep['changed_preexisting'] = {'count': len(changed), 'by_kind': dict(collections.Counter(kinds.values())),
                                  'by_net': dict(collections.Counter(s1[u]['net'] for u in changed)),
                                  'unexpected': [u for u, v in kinds.items() if v == 'OTHER']}
    by_net = {}
    for u in added:
        by_net.setdefault(s1[u]['net'], {'tracks': 0, 'vias': 0, 'len_mm': 0.})
        x = by_net[s1[u]['net']]
        if s1[u]['kind'] == 'via': x['vias'] += 1
        else: x['tracks'] += 1; x['len_mm'] = round(x['len_mm'] + math.dist(s1[u]['start'], s1[u]['end']), 2)
    rep['added'] = {'count': len(added), 'by_net': dict(sorted(by_net.items()))}
    rep['in1_tracks'] = [u for u, v in s1.items() if v['kind'] == 'track' and v['layer'] == k.In1_Cu]
    rep['non_octilinear_new_segments'] = [u for u in added if s1[u]['kind'] == 'track' and not R.octi(s1[u]['start'], s1[u]['end'], 1e-3)]
    f0 = {f.GetReference(): (r.xy(f.GetPosition()), f.GetOrientationDegrees(), f.GetValue()) for f in src.GetFootprints()}
    f1 = {f.GetReference(): (r.xy(f.GetPosition()), f.GetOrientationDegrees(), f.GetValue()) for f in b.GetFootprints()}
    rep['footprints'] = {'added': sorted(set(f1) - set(f0)), 'removed': sorted(set(f0) - set(f1)),
                         'moved': sorted(x for x in f0 if x in f1 and (f0[x][0] != f1[x][0] or f0[x][1] != f1[x][1])),
                         'value_changed': {x: [f0[x][2], f1[x][2]] for x in f0 if x in f1 and f0[x][2] != f1[x][2]}}
    rep['rf_area_footprints_moved'] = [x for x in rep['footprints']['moved'] if V3.in_rf(f0[x][0])]
    rf0 = sorted((v['kind'], v['net'], v['layer'], tuple(v['start']), tuple(v['end']), v.get('width'), v.get('diameter')) for v in s0.values() if v['net'] in RF_NETS)
    rf1 = sorted((v['kind'], v['net'], v['layer'], tuple(v['start']), tuple(v['end']), v.get('width'), v.get('diameter')) for v in s1.values() if v['net'] in RF_NETS)
    rep['rf_nets_copper_identical_to_v053'] = rf0 == rf1; rep['rf_nets_items'] = len(rf1)
    rep['teardrops_on_rf_nets'] = sum(1 for z in b.Zones() if z.IsTeardropArea() and z.GetNetname() in RF_NETS)
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    a0 = next(f for f in src.GetFootprints() if f.GetReference() == 'ANT1'); a1 = fps['ANT1']
    geo = lambda f: sorted((it.GetShapeStr(), r.xy(it.GetStart()), r.xy(it.GetEnd()), k.ToMM(it.GetWidth()), it.GetLayer()) for it in f.GraphicalItems() if isinstance(it, k.PCB_SHAPE))
    rep['ant1_identical_to_v053'] = (r.xy(a0.GetPosition()), a0.GetOrientationDegrees(), geo(a0), [(p.GetNumber(), r.xy(p.GetPosition())) for p in a0.Pads()]) == \
                                    (r.xy(a1.GetPosition()), a1.GetOrientationDegrees(), geo(a1), [(p.GetNumber(), r.xy(p.GetPosition())) for p in a1.Pads()])
    rep['rf_parts_unchanged'] = {x: f0[x] == f1[x] for x in ('L1', 'L2', 'C24', 'C25', 'C26', 'C27', 'C28', 'C29', 'C34', 'C35', 'R22', 'R23', 'R24', 'R25', 'C31', 'C37', 'U2')}
    rep['teardrop_zones'] = sum(1 for z in b.Zones() if z.IsTeardropArea())
    rep['gnd_islands_without_via_or_track'] = V3.anchored_islands(b)
    rep['copper_in_nfc_band'] = [u for u, v in s1.items() if any(BAND[0] <= p_[0] <= BAND[2] and BAND[1] <= p_[1] <= BAND[3] for p_ in (v['start'], v['end']))]
    rep['hidden_references'] = sorted(f.GetReference() for f in b.GetFootprints() if not f.Reference().IsVisible())
    drc = json.loads((OUT / 'v054-drc.json').read_text())
    rep['drc'] = {'errors': sum(1 for v in drc['violations'] if v['severity'] == 'error'),
                  'warnings': dict(collections.Counter(v['type'] for v in drc['violations'] if v['severity'] == 'warning')),
                  'unconnected': len(drc['unconnected_items']), 'parity': len(drc['schematic_parity'])}
    (OUT / 'v054-audit.json').write_text(json.dumps(rep, indent=2, default=str) + '\n')
    print(json.dumps({k_: v for k_, v in rep.items() if k_ not in ('rf_parts_unchanged',)}, default=str)[:3000])


if __name__ == '__main__':
    PHASES = {'textprep': textprep, 'surgery': surgery, 'place': place, 'route': route, 'necks': necks, 'teardrops': teardrops,
              'finish': finish, 'audit': audit}
    PHASES[sys.argv[1]]()
