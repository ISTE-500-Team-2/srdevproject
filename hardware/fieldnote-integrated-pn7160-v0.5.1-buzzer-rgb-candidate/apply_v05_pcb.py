#!/usr/bin/env python3
"""v0.5 PCB: copper surgery, back-side placement and routing of only the new circuitry.

Phases (each saves the board and a JSON report under output/):
  surgery  - split VBUS -> VIN_SEL island, USB_HIGH_CURRENT -> SOURCE_QUALIFIED, rename BAT_ADC -> IO_INT,
             prune the resulting dangling stubs, import new footprints, sync all pad nets with design-data.
  place    - search legal back-side sites for the new parts (existing parts never move).
  route    - route the new connections with the repo A* router; existing copper is never modified.
Run: KiCad python apply_v05_pcb.py surgery|place|route
"""
from pathlib import Path
import hashlib, json, math, sys, uuid
import wx
import pcbnew as k
import route_pn7160 as r
import build_design as g

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
V4C_BOARD = '6ed6056d35972376a55a58faac274b82d1fa07bdd6ae1436a3bf3f270341b616'
SHEET_OF_GROUP = {'USB': 'usb-power', 'Power': 'usb-power', 'MCU': 'esp32-leds', 'Indicators': 'esp32-leds',
                  'NFC': 'pn7160', 'Test': 'pn7160', 'RF': 'nfc-rf', 'Interface': 'field-interface'}
CUT_SEGMENTS = {('VBUS', (63.129, 3.39), (58.822, 3.39)), ('USB_HIGH_CURRENT', (38.675, 9.673), (40.951, 11.949))}
CLEAR = 0.2
PRUNE_AT_SURGERY = {'VBUS', 'VIN_SEL', 'USB_HIGH_CURRENT', 'SOURCE_QUALIFIED'}


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def ident(key): return k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL, 'fieldnote-v05-reader-interface:' + key)))
def close(a, b, tol=2e-3): return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol


def load():
    app = wx.App(False)
    m = k.GetSettingsManager(); m.LoadProject(str(ROOT / 'fieldnote.kicad_pro'))
    b = k.LoadBoard(str(ROOT / 'fieldnote.kicad_pcb')); b.SetProject(m.GetProject(str(ROOT / 'fieldnote.kicad_pro')))
    return app, b


def save(b):
    b.BuildConnectivity(); k.SaveBoard(str(ROOT / 'fieldnote.kicad_pcb'), b)


def data(): return json.loads((ROOT / 'design-data.json').read_text())


def net(b, name):
    n = b.FindNet(name)
    if n is None:
        n = k.NETINFO_ITEM(b, name); b.Add(n)
    return n


def pad_touches(pad, p, layer):
    if not pad.IsOnLayer(layer): return False
    bb = pad.GetBoundingBox(); a = r.xy(bb.GetOrigin()); c = r.xy(bb.GetEnd())
    return a[0] - 1e-3 <= p[0] <= c[0] + 1e-3 and a[1] - 1e-3 <= p[1] <= c[1] + 1e-3


def island(b, netname, seed_pad):
    """Tracks/vias of netname electrically reachable from seed_pad through copper items only."""
    items = [t for t in b.GetTracks() if t.GetNetname() == netname]
    pads = [p for f in b.GetFootprints() for p in f.Pads() if p.GetNetname() == netname]
    def ends(t):
        if isinstance(t, k.PCB_VIA): return [(r.xy(t.GetPosition()), None)]
        return [(r.xy(t.GetStart()), t.GetLayer()), (r.xy(t.GetEnd()), t.GetLayer())]
    def touch(e1, e2):
        (p1, l1), (p2, l2) = e1, e2
        return close(p1, p2) and (l1 is None or l2 is None or l1 == l2)
    pk = lambda pd: (pd.GetParentFootprint().GetReference(), pd.GetNumber())
    reached, frontier, reached_pads = set(), [], {pk(seed_pad)}
    for t in items:
        if any(l is not None and pad_touches(seed_pad, p, l) or l is None and seed_pad.HitTest(r.vec(p)) for p, l in ends(t)):
            reached.add(t.m_Uuid.AsString()); frontier.append(t)
    while frontier:
        t = frontier.pop()
        for u in items:
            ui = u.m_Uuid.AsString()
            if ui in reached: continue
            if any(touch(e1, e2) for e1 in ends(t) for e2 in ends(u)):
                reached.add(ui); frontier.append(u)
        for pd in pads:
            if pk(pd) not in reached_pads and any(l is not None and pad_touches(pd, p, l) for p, l in ends(t)):
                reached_pads.add(pk(pd))
                for u in items:
                    ui = u.m_Uuid.AsString()
                    if ui not in reached and any(l is not None and pad_touches(pd, p, l) for p, l in ends(u)):
                        reached.add(ui); frontier.append(u)
    return reached, reached_pads


def prune_dangling(b, netnames):
    removed = []
    while True:
        changed = False
        for t in list(b.GetTracks()):
            if isinstance(t, k.PCB_VIA) or t.GetNetname() not in netnames: continue
            for p in (r.xy(t.GetStart()), r.xy(t.GetEnd())):
                tid = t.m_Uuid.AsString()
                others = [u for u in b.GetTracks() if u.m_Uuid.AsString() != tid and u.GetNetname() == t.GetNetname() and (
                    (isinstance(u, k.PCB_VIA) and close(r.xy(u.GetPosition()), p)) or
                    (not isinstance(u, k.PCB_VIA) and u.GetLayer() == t.GetLayer() and (close(r.xy(u.GetStart()), p) or close(r.xy(u.GetEnd()), p))))]
                on_pad = any(pd.GetNetname() == t.GetNetname() and pad_touches(pd, p, t.GetLayer()) for f in b.GetFootprints() for pd in f.Pads())
                if not others and not on_pad:
                    removed.append({'net': t.GetNetname(), 'layer': b.GetLayerName(t.GetLayer()), 'start': r.xy(t.GetStart()), 'end': r.xy(t.GetEnd()), 'uuid': t.m_Uuid.AsString()})
                    b.Remove(t); changed = True; break
        if not changed: return removed


def surgery():
    assert sha(ROOT / 'source-v04c' / 'fieldnote.kicad_pcb') == V4C_BOARD
    assert sha(ROOT / 'fieldnote.kicad_pcb') == V4C_BOARD, 'working board is not the v4c baseline; refusing to redo surgery'
    app, b = load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    report = {'base_board_sha256': V4C_BOARD, 'cut': [], 'renamed': {}, 'pruned': [], 'imported': []}
    for name in ('VIN_SEL', 'SOURCE_QUALIFIED', 'IO_INT', '5V_FIELD', 'FIELD_PG', 'PWR_SRC', 'MUX_PR1', 'MUX_CP2', 'MUX_ILM', 'MUX_SS'):
        net(b, name)
    for t in list(b.GetTracks()):
        if isinstance(t, k.PCB_VIA): continue
        for netname, a, c in CUT_SEGMENTS:
            s, e = r.xy(t.GetStart()), r.xy(t.GetEnd())
            if t.GetNetname() == netname and ((close(s, a) and close(e, c)) or (close(s, c) and close(e, a))):
                report['cut'].append({'net': netname, 'start': s, 'end': e, 'uuid': t.m_Uuid.AsString()}); b.Remove(t)
    assert len(report['cut']) == 2, report['cut']
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    def pad(spec):
        ref, num = spec.split('.'); return next(p for p in fps[ref].Pads() if p.GetNumber() == num)
    for old, new, seed in (('VBUS', 'VIN_SEL', 'U3.13'), ('USB_HIGH_CURRENT', 'SOURCE_QUALIFIED', 'R2.1')):
        ids, _ = island(b, old, pad(seed))
        for t in b.GetTracks():
            if t.m_Uuid.AsString() in ids: t.SetNet(net(b, new))
        report['renamed'][f'{old}->{new}'] = sorted(ids)
    n = 0
    for t in b.GetTracks():
        if t.GetNetname() == 'BAT_ADC': t.SetNet(net(b, 'IO_INT')); n += 1
    report['renamed']['BAT_ADC->IO_INT'] = n
    # Import new footprints at a parking spot; placement phase finds real sites.
    for p in d['parts']:
        if p['ref'] in fps: continue
        f = k.FootprintLoad(str(ROOT / 'Fieldnote.pretty'), p['fp']); assert f, p['fp']
        f.SetReference(p['ref']); f.SetUuid(k.KIID(g.uid(p['ref']))); b.Add(f)
        f.SetFPID(k.LIB_ID('Fieldnote', p['fp']))
        f.SetPosition(r.vec([-40, -40]))
        if p.get('side') == 'B': f.Flip(f.GetPosition(), k.FLIP_DIRECTION_LEFT_RIGHT)
        f.SetPath(k.KIID_PATH('/' + g.ROOT_UUID + '/' + g.uid('sheet' + SHEET_OF_GROUP[p['group']]) + '/' + g.uid(p['ref'])))
        f.Reference().SetTextSize(k.VECTOR2I(k.FromMM(.6), k.FromMM(.6))); f.Reference().SetTextThickness(k.FromMM(.1))
        f.Value().SetVisible(False)
        if p['ref'].startswith('JP'):
            f.SetExcludedFromBOM(True); f.SetExcludedFromPosFiles(True)
        fps[p['ref']] = f; report['imported'].append(p['ref'])
    # Sync every pad net/pin function and part fields with design-data (renets + new parts).
    for p in d['parts']:
        f = fps[p['ref']]
        f.SetValue(p['value']); f.SetField('MPN', p['mpn']); f.GetField('MPN').SetVisible(False); f.SetDNP(p['dnp'])
        if p['dnp']: f.SetExcludedFromBOM(True); f.SetExcludedFromPosFiles(True)
        for pd in f.Pads():
            num = pd.GetNumber()
            if not num or num not in p['nets']: continue
            nn = p['nets'][num]; name = p['names'].get(num, num)
            nn = nn or ('unconnected-(' + p['ref'] + '-' + ('' if name == num else name + '-') + 'Pad' + num + ')')
            pd.SetNet(net(b, nn)); pd.SetPinFunction(name)
    report['pruned'] = prune_dangling(b, PRUNE_AT_SURGERY)
    for item in b.GetDrawings():
        if isinstance(item, k.PCB_TEXT) and item.GetText().startswith('FIELDNOTE PN7160 v0.4'):
            report['revision_text'] = item.GetText(); item.SetText('FIELDNOTE PN7160 v0.5 - READER INTERFACE REVIEW')
    save(b); report['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v05-surgery.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'cut': len(report['cut']), 'pruned': len(report['pruned']), 'imported': report['imported'],
                      'renamed': {kk: (len(v) if isinstance(v, list) else v) for kk, v in report['renamed'].items()}}))


# ---------------- placement ----------------
def rect_of(item):
    bb = item.GetBoundingBox(); a = r.xy(bb.GetOrigin()); c = r.xy(bb.GetEnd()); return a, c


def pad_segment(pad):
    a, c = rect_of(pad); w, h = c[0] - a[0], c[1] - a[1]; m = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
    if w >= h: return (a[0] + h / 2, m[1]), (c[0] - h / 2, m[1]), h / 2
    return (m[0], a[1] + w / 2), (m[0], c[1] - w / 2), w / 2


def courtyard_b(f):
    boxes = [i.GetBoundingBox() for i in f.GraphicalItems() if i.GetLayer() == k.B_CrtYd]
    if not boxes: boxes = [p.GetBoundingBox() for p in f.Pads()]
    return [min(k.ToMM(bb.GetX()) - 60 for bb in boxes), min(k.ToMM(bb.GetY()) - 50 for bb in boxes),
            max(k.ToMM(bb.GetX() + bb.GetWidth()) - 60 for bb in boxes), max(k.ToMM(bb.GetY() + bb.GetHeight()) - 50 for bb in boxes)]


def allowed(box):
    x0, y0, x1, y1 = box
    if x0 < 1.0 or y0 < 0.6 or x1 > 65.0 or y1 > 44.6: return False
    if x0 < 33.4 and y1 > 10.35: return False          # NFC coil region (all layers)
    if x1 > 32.8 and y1 > 38.4: return False           # Wi-Fi antenna clearance
    if x0 < 11.8 and x1 > 2.7 and y0 < 1.9: return False  # case notch cutout
    return True


def place():
    app, b = load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    new = [p['ref'] for p in d['parts'] if p.get('side') == 'B']
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    obstacles = []  # (a, c, radius, net) on B.Cu
    for t in b.GetTracks():
        if not t.IsOnLayer(k.B_Cu): continue
        if isinstance(t, k.PCB_VIA):
            p = r.xy(t.GetPosition()); obstacles.append((p, p, k.ToMM(t.GetWidth(k.B_Cu)) / 2, t.GetNetname()))
        else: obstacles.append((r.xy(t.GetStart()), r.xy(t.GetEnd()), k.ToMM(t.GetWidth()) / 2, t.GetNetname()))
    for f in b.GetFootprints():
        if f.GetReference() in new: continue
        for pd in f.Pads():
            if pd.IsOnLayer(k.B_Cu) or pd.GetAttribute() in (k.PAD_ATTRIB_PTH, k.PAD_ATTRIB_NPTH):
                a, c, rad = pad_segment(pd); obstacles.append((a, c, rad + .05, pd.GetNetname()))
    courts = [courtyard_b(f) for f in b.GetFootprints() if f.GetReference() not in new and f.GetLayer() == k.B_Cu]
    def legal(f):
        box = courtyard_b(f)
        if not allowed(box): return False
        if any(not (box[2] <= o[0] or box[0] >= o[2] or box[3] <= o[1] or box[1] >= o[3]) for o in courts): return False
        for pd in f.Pads():
            a, c, rad = pad_segment(pd)
            for u, v, ur, un in obstacles:
                if un == pd.GetNetname() and un != '': continue
                if r.segment_distance(a, c, u, v) < rad + ur + CLEAR: return False
        return True
    order = sorted(new, key=lambda ref: -len(list(fps[ref].Pads())))
    solved = {}
    for ref in order:
        f = fps[ref]; want = parts[ref]['xy']; cands = []
        for ix in range(4, 262):
            for iy in range(3, 178):
                x, y = ix * .25, iy * .25
                dist = math.hypot(x - want[0], y - want[1])
                if dist < 22: cands.append((dist, x, y))
        cands.sort(); done = False
        for tested, (dist, x, y) in enumerate(cands):
            for ang in ((0, 90, 180, 270) if ref != 'J6' else (0, 90)):
                f.SetOrientationDegrees(ang); f.SetPosition(r.vec([x, y]))
                if legal(f):
                    box = courtyard_b(f); courts.append(box)
                    for pd in f.Pads():
                        a, c, rad = pad_segment(pd); obstacles.append((a, c, rad, pd.GetNetname()))
                    solved[ref] = {'xy': [x, y], 'angle': ang, 'tested': tested + 1, 'distance_from_intent': round(dist, 3), 'courtyard': [round(v, 3) for v in box]}
                    parts[ref]['xy'] = [x, y]; parts[ref]['angle'] = ang
                    print(json.dumps({'placed': ref, **solved[ref]}), flush=True); done = True; break
            if done: break
        if not done:
            f.SetPosition(r.vec([-40, -40])); solved[ref] = {'failed': True}; print(json.dumps({'failed': ref}), flush=True)
    save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (OUT / 'v05-placement.json').write_text(json.dumps({'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb'), 'solved': solved}, indent=2) + '\n')


# Hand placement of the mux cluster (back side). (center, pad, desired pad xy): angle chosen so that pad lands nearest.
MANUAL = {
    'U10': ([22.0, 5.2], '7', [21.325, 5.55]),
    'R35': ([20.075, 2.2], '1', [20.9, 2.2]), 'C39': ([23.1, 2.2], '1', [22.325, 2.2]),
    'R36': ([18.9, 3.75], '1', [19.725, 3.75]), 'C42': ([19.0, 5.6], '1', [19.775, 5.6]),
    'R31': ([20.4, 8.6], '2', [20.4, 7.775]), 'R32': ([18.8, 8.6], '1', [18.8, 7.775]), 'JP2': ([16.75, 8.4], '1', [16.75, 7.75]),
    'R33': ([23.6, 8.6], '2', [23.6, 7.775]), 'R34': ([25.2, 8.6], '1', [25.2, 7.775]),
    'C41': ([25.2, 5.5], '1', [24.425, 5.5]), 'C40': ([26.4, 3.5], '1', [25.45, 3.5]),
    'R37': ([14.25, 8.5], '1', [14.25, 9.325]), 'J6': ([9.0, 5.75], '1', [7.05, 8.29]),
}


def manual():
    app, b = load(); d = data(); parts = {p['ref']: p for p in d['parts']}
    fps = {f.GetReference(): f for f in b.GetFootprints()}
    for ref in MANUAL: fps[ref].SetPosition(r.vec([-40, -40]))
    courts = [courtyard_b(f) for f in b.GetFootprints() if f.GetLayer() == k.B_Cu and f.GetReference() not in MANUAL]
    res = {}
    for ref, (c, padnum, want) in MANUAL.items():
        f = fps[ref]; best = None
        for ang in (0, 90, 180, 270):
            f.SetOrientationDegrees(ang); f.SetPosition(r.vec(c))
            pp = r.xy(next(p for p in f.Pads() if p.GetNumber() == padnum).GetPosition())
            dd = math.dist(pp, want)
            if best is None or dd < best[0]: best = (dd, ang)
        f.SetOrientationDegrees(best[1]); f.SetPosition(r.vec(c)); box = courtyard_b(f)
        clash = [i for i, o in enumerate(courts) if not (box[2] <= o[0] or box[0] >= o[2] or box[3] <= o[1] or box[1] >= o[3])]
        res[ref] = {'xy': c, 'angle': best[1], 'pad_error_mm': round(best[0], 3), 'allowed': allowed(box), 'courtyard_clash': bool(clash), 'courtyard': [round(v, 3) for v in box]}
        courts.append(box); parts[ref]['xy'] = c; parts[ref]['angle'] = best[1]
        print(json.dumps({ref: res[ref]}))
    save(b); (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (OUT / 'v05-manual-placement.json').write_text(json.dumps(res, indent=2) + '\n')


# ---------------- routing ----------------
POWER = .4
FANOUT = [
    ('MUX_ILM', 'U10.10', 'R35.1', .2), ('MUX_SS', 'U10.11', 'C39.1', .2), ('PWR_SRC', 'U10.9', 'R36.1', .2),
    ('MUX_PR1', 'U10.6', 'R31.2', .2), ('MUX_CP2', 'U10.3', 'R33.2', .2), ('GND', 'U10.4', 'U10.5', .2),
    ('VIN_SEL', 'U10.1', 'U10.8', .3), ('VBUS', 'U10.2', 'C41.1', POWER), ('5V_FIELD', 'U10.7', 'C42.1', POWER),
    ('VIN_SEL', 'U10.1', 'C40.1', POWER),
]
REMOTE = [
    ('VIN_SEL', 'C40.1', {'xy': [61.45, 7.4], 'layers': ['F.Cu']}, POWER),
    ('VBUS', 'C41.1', {'xy': [58.822, 3.2], 'layers': ['F.Cu']}, POWER),
    ('SOURCE_QUALIFIED', 'U11.4', 'R2.1', .2), ('USB_HIGH_CURRENT', 'U11.1', 'U7.4', .2),
    ('NFC_SCL', 'J6.8', 'R21.1', .15), ('NFC_SDA', 'J6.7', 'R20.1', .15), ('IO_INT', 'J6.9', 'R10.2', .15),
    ('FIELD_PG', 'J6.6', 'U11.2', .2),
    ('3V3', 'U11.5', 'C43.1', .25), ('3V3', 'C43.1', 'U7.5', .25),
    ('3V3', 'J6.5', {'xy': [27.4, 7.25], 'layers': ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']}, .25),
]
REST = [
    ('MUX_PR1', 'R31.2', 'R32.1', .2), ('MUX_PR1', 'R32.1', 'JP2.1', .2), ('MUX_CP2', 'R33.2', 'R34.1', .2),
    ('VBUS', 'R33.1', 'C41.1', .25), ('5V_FIELD', 'R31.1', 'C42.1', .25),
    ('5V_FIELD', 'J6.1', 'J6.2', POWER), ('5V_FIELD', 'J6.2', 'C42.1', POWER),
    ('PWR_SRC', 'R36.1', 'J6.10', .2), ('3V3', 'R36.2', 'J6.5', .25), ('FIELD_PG', 'J6.6', 'R37.1', .2),
]
GROUND_PADS = ['U10.4', 'U10.12', 'R32.2', 'R34.2', 'R35.2', 'C39.2', 'C40.2', 'C41.2', 'C42.2', 'JP2.2', 'J6.3', 'J6.4', 'R37.2', 'U11.3', 'C43.2']


def route():
    app, b = load(); added, routes, failed, ground = [], [], [], []
    before = r.track_snapshot(b)
    def via(netname, p, key):
        v = k.PCB_VIA(b); v.SetUuid(ident(key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(.5)); v.SetDrill(k.FromMM(.2))
        v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet(netname)); v.SetLocked(True)
        v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v); added.append(v.m_Uuid.AsString())
    def connect(ri, netname, start, end, width, purpose, vias_allowed):
        a, sl = r.endpoint(b, start, netname); c, el = r.endpoint(b, end, netname)
        for w in ([width, .3, .25] if width > .3 else [width]) if width >= .25 else [width]:
            try:
                legs, vias, visited = r.path(b, netname, a, c, w, ['B.Cu', 'F.Cu', 'In2.Cu'], sl, el, [1.0, .5, 65.15, 44.7],
                                             max_vias=vias_allowed, max_states=1500000, step=.1)
                break
            except RuntimeError as ex:
                err = str(ex)
        else:
            failed.append({'index': ri, 'net': netname, 'start': start if isinstance(start, str) else start['xy'], 'end': end if isinstance(end, str) else end['xy'], 'error': err})
            print(json.dumps({'failed': failed[-1]}), flush=True); return
        for vi, p in enumerate(vias): via(netname, p, f'route:{ri}:via:{vi}')
        for li, (layer, pts) in enumerate(legs):
            for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                if math.dist(x, y) < 1e-8: continue
                t = k.PCB_TRACK(b); t.SetUuid(ident(f'route:{ri}:leg:{li}:track:{ti}')); t.SetStart(r.vec(x)); t.SetEnd(r.vec(y))
                t.SetLayer(b.GetLayerID(layer)); t.SetNet(b.FindNet(netname)); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t)
                added.append(t.m_Uuid.AsString())
        length = sum(math.dist(x, y) for _, pts in legs for x, y in zip(pts, pts[1:]))
        routes.append({'index': ri, 'net': netname, 'width': w, 'length_mm': round(length, 3), 'vias': len(vias), 'purpose': purpose})
        print(json.dumps({'routed': ri, 'net': netname, 'w': w, 'len': round(length, 2), 'vias': len(vias), 'visited': visited}), flush=True)
    n = 0
    for phase, lst, nv in (('fanout', FANOUT, 2), ('remote', REMOTE, 6), ('local', REST, 3)):
        for netname, st, en, w in lst:
            connect(n, netname, st, en, w, phase, nv); n += 1
    # Local return vias to the In1 GND plane for every new back-side ground pad.
    for spec in GROUND_PADS:
        p, sl = r.endpoint(b, spec, 'GND'); checks = [r.collision_test(b, 'GND', .5, layer, True) for layer in r.ALL_COPPER]
        cands = sorted((math.hypot(ix * .1, iy * .1), [round(p[0] + ix * .1, 4), round(p[1] + iy * .1, 4)]) for ix in range(-18, 19) for iy in range(-18, 19) if .6 <= math.hypot(ix * .1, iy * .1) <= 1.8)
        for dist, vp in cands:
            if not (1 <= vp[0] <= 65.15 and .5 <= vp[1] <= 44.7) or (vp[0] < 33.3 and vp[1] > 10.5): continue
            if all(ch(vp, vp) for ch in checks):
                via('GND', vp, 'gnd:' + spec)
                try:
                    legs, vias, _ = r.path(b, 'GND', p, vp, .25, ['B.Cu'], sl, ['B.Cu'], [1.0, .5, 65.15, 44.7], max_vias=0, max_states=20000, step=.05)
                except RuntimeError:
                    b.Remove(b.GetItem(ident('gnd:' + spec))) if hasattr(b, 'GetItem') else None; continue
                for li, (layer, pts) in enumerate(legs):
                    for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                        if math.dist(x, y) < 1e-8: continue
                        t = k.PCB_TRACK(b); t.SetUuid(ident(f'gnd:{spec}:{li}:{ti}')); t.SetStart(r.vec(x)); t.SetEnd(r.vec(y)); t.SetLayer(k.B_Cu)
                        t.SetNet(b.FindNet('GND')); t.SetWidth(k.FromMM(.25)); t.SetLocked(True); b.Add(t); added.append(t.m_Uuid.AsString())
                ground.append({'pad': spec, 'via': vp, 'distance': round(dist, 3)}); break
        else:
            failed.append({'net': 'GND', 'start': spec, 'error': 'NO_LOCAL_GROUND_VIA'})
    now = r.track_snapshot(b)
    preserved = all(now.get(ui) == geom for ui, geom in before.items())
    filler = k.ZONE_FILLER(b); filler.Fill(b.Zones()); save(b)
    rep = {'board_sha256': sha(ROOT / 'fieldnote.kicad_pcb'), 'preexisting_copper_unchanged': preserved, 'routes': routes, 'ground_vias': ground, 'failed': failed, 'added_items': len(added)}
    (OUT / 'v05-routing.json').write_text(json.dumps(rep, indent=2) + '\n')
    print(json.dumps({'routed': len(routes), 'ground': len(ground), 'failed': len(failed), 'preserved': preserved}))



# ---------------- targeted repair of failed long links ----------------
def repair():
    app, b = load(); report = {'added': [], 'failed': []}
    before = r.track_snapshot(b)
    ALL = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
    def add_via(netname, p, key):
        v = k.PCB_VIA(b); v.SetUuid(ident(key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(.5)); v.SetDrill(k.FromMM(.2))
        v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet(netname)); v.SetLocked(True)
        v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v)
    def add_legs(netname, legs, vias, w, key):
        for vi, p in enumerate(vias): add_via(netname, p, f'{key}:via:{vi}')
        for li, (layer, pts) in enumerate(legs):
            for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                if math.dist(x, y) < 1e-8: continue
                t = k.PCB_TRACK(b); t.SetUuid(ident(f'{key}:{li}:{ti}')); t.SetStart(r.vec(x)); t.SetEnd(r.vec(y)); t.SetLayer(b.GetLayerID(layer))
                t.SetNet(b.FindNet(netname)); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t)
        return sum(math.dist(x, y) for _, pts in legs for x, y in zip(pts, pts[1:]))
    def same_net_points(netname, xmin, ymin, xmax, ymax, layer='F.Cu'):
        pts = []
        for t in b.GetTracks():
            if t.GetNetname() != netname or isinstance(t, k.PCB_VIA) or b.GetLayerName(t.GetLayer()) != layer: continue
            a, c = r.xy(t.GetStart()), r.xy(t.GetEnd()); n = max(1, int(math.dist(a, c) / .2))
            for i in range(n + 1):
                p = [round(a[0] + (c[0] - a[0]) * i / n, 4), round(a[1] + (c[1] - a[1]) * i / n, 4)]
                if xmin <= p[0] <= xmax and ymin <= p[1] <= ymax: pts.append(p)
        return pts
    def anchor_via(netname, island_pts, key, width):
        """Legal via within 1.6 mm of the net's copper, joined to it with a short front track."""
        checks = [r.collision_test(b, netname, .5, l, True) for l in ALL]
        cands = sorted(((math.dist([x / 10, y / 10], q), [x / 10, y / 10], q) for q in island_pts
                        for x in range(int(q[0] * 10) - 16, int(q[0] * 10) + 17, 2) for y in range(int(q[1] * 10) - 16, int(q[1] * 10) + 17, 2)
                        if .55 <= math.dist([x / 10, y / 10], q) <= 1.6), key=lambda c: c[0])
        clear = r.collision_test(b, netname, width, 'F.Cu')
        for d, vp, q in cands:
            if all(ch(vp, vp) for ch in checks) and clear(vp, q):
                add_via(netname, vp, key + ':anchor'); add_legs(netname, [['F.Cu', [vp, q]]], [], width, key + ':stub')
                return vp
        return None
    jobs = [('VIN_SEL', 'C40.1', same_net_points('VIN_SEL', 58.0, 5.0, 61.5, 7.5), POWER),
            ('NFC_SCL', 'J6.8', same_net_points('NFC_SCL', 40, 14, 50, 24) + same_net_points('NFC_SCL', 40, 14, 50, 24, 'B.Cu'), .15)]
    for netname, start, island_pts, w in jobs:
        key = 'repair:' + netname
        vp = anchor_via(netname, [p for p in island_pts], key, min(w, .3))
        if vp is None:
            report['failed'].append({'net': netname, 'error': 'NO_ANCHOR_VIA'}); continue
        a, sl = r.endpoint(b, start, netname); done = False
        for ww in ([w, .3, .25] if w > .3 else [w]):
            try:
                legs, vias, visited = r.path(b, netname, a, vp, ww, ['B.Cu', 'F.Cu', 'In2.Cu'], sl, ALL, [1.0, .5, 65.15, 44.7], max_vias=6, max_states=1500000, step=.1)
            except RuntimeError as ex:
                err = str(ex); continue
            L = add_legs(netname, legs, vias, ww, key); done = True
            report['added'].append({'net': netname, 'anchor_via': vp, 'width': ww, 'length_mm': round(L, 2), 'vias': len(vias) + 1, 'visited': visited})
            print(json.dumps(report['added'][-1]), flush=True); break
        if not done:
            report['failed'].append({'net': netname, 'anchor_via': vp, 'error': err}); print(json.dumps(report['failed'][-1]), flush=True)
    now = r.track_snapshot(b); report['preexisting_copper_unchanged'] = all(now.get(ui) == geom for ui, geom in before.items())
    filler = k.ZONE_FILLER(b); filler.Fill(b.Zones()); save(b); report['board_sha256'] = sha(ROOT / 'fieldnote.kicad_pcb')
    (OUT / 'v05-repair.json').write_text(json.dumps(report, indent=2) + '\n'); print(json.dumps({'repaired': len(report['added']), 'failed': len(report['failed'])}))


if __name__ == '__main__':
    {'surgery': surgery, 'place': place, 'manual': manual, 'route': route, 'repair': repair}[sys.argv[1]]()
