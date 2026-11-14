#!/usr/bin/env python3
"""Generic rip-up-and-reroute for NEW (v0.6-only) copper on given nets.
usage: KiCad python reroute_v06.py list NET...      -> writes output/v06-reroute-uuids.json (new copper on those nets)
       python3 reroute_v06.py strip                  -> removes those blocks from the board text (pcbnew deletion crashes)
       KiCad python reroute_v06.py route GNDPAD... -- NET...   -> ground the given pads first, then MST-route the nets."""
import json, math, re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent; OUT = ROOT / 'output'
if sys.argv[1] == 'strip':
    ids = set(json.load(open(OUT / 'v06-reroute-uuids.json'))); p = ROOT / 'fieldnote.kicad_pcb'; t = p.read_text(); out, last, n = [], 0, 0
    for m in re.finditer(r'\t\((segment|via|arc)\n.*?\n\t\)\n', t, re.S):
        u = re.search(r'\(uuid "([^"]+)"\)', m.group(0))
        if u and u.group(1) in ids: out.append(t[last:m.start()]); last = m.end(); n += 1
    out.append(t[last:]); p.write_text(''.join(out)); print(json.dumps({'stripped': n})); sys.exit(0)
import wx, pcbnew as k
import route_pn7160 as r, apply_v05_pcb as A, apply_v06_pcb as V
if sys.argv[1] == 'list':
    nets = set(sys.argv[2:]); b = k.LoadBoard(str(ROOT / 'fieldnote.kicad_pcb')); src = k.LoadBoard(str(ROOT / 'source-v05' / 'fieldnote.kicad_pcb'))
    keep = {t.m_Uuid.AsString() for t in src.GetTracks()}
    ids = [t.m_Uuid.AsString() for t in b.GetTracks() if t.GetNetname() in nets and t.m_Uuid.AsString() not in keep]
    json.dump(ids, open(OUT / 'v06-reroute-uuids.json', 'w')); print(json.dumps({'to_strip': len(ids)})); sys.exit(0)
args = sys.argv[2:]; gpads = args[:args.index('--')]; nets = args[args.index('--') + 1:]
app, b = A.load(); log = {'gnd': [], 'routes': [], 'failed': []}; ALL = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
def padobj(spec):
    ref, num = spec.split('.'); return next(p for f in b.GetFootprints() if f.GetReference() == ref for p in f.Pads() if p.GetNumber() == num)
def lay(p): return [b.GetLayerName(l) for l in (k.F_Cu, k.B_Cu) if p.IsOnLayer(l)]
def put(net, legs, vias, w, key):
    for vi, p in enumerate(vias): V.add_via(b, net, p, f'{key}:v{vi}')
    for li, (L, pts) in enumerate(legs):
        for ti, (x, y) in enumerate(zip(pts, pts[1:])):
            if math.dist(x, y) > 1e-8: V.add_track(b, net, b.GetLayerID(L), x, y, w, f'{key}:{li}:{ti}')
    return round(sum(math.dist(x, y) for _, p in legs for x, y in zip(p, p[1:])), 2)
for spec in gpads:
    pd = padobj(spec); p = r.xy(pd.GetPosition()); L = lay(pd)[0]
    checks = [r.collision_test(b, 'GND', .6, l, True) for l in ALL]; stub = r.collision_test(b, 'GND', .3, L); ok = False
    for d, c in sorted((math.hypot(ix * .05, iy * .05), [round(p[0] + ix * .05, 3), round(p[1] + iy * .05, 3)]) for ix in range(-50, 51) for iy in range(-50, 51)):
        if not .6 <= d <= 2.5 or c[0] > 109.3: continue
        if all(ch(c, c) for ch in checks) and stub(p, c):
            V.add_via(b, 'GND', c, f'rr:gnd:{spec}', .6, .3); V.add_track(b, 'GND', b.GetLayerID(L), p, c, .3, f'rr:gndt:{spec}'); log['gnd'].append({spec: c}); ok = True; break
    if not ok: log['failed'].append({'gnd': spec})
for n in nets:
    terms = []; seen = set()
    for f in b.GetFootprints():
        for pd in f.Pads():
            key = f'{f.GetReference()}.{pd.GetNumber()}'
            if pd.GetNetname() == n and pd.GetNumber() and key not in seen:
                seen.add(key); terms.append(({'xy': r.xy(pd.GetPosition()), 'layers': lay(pd) or ALL, 'name': key}, r.xy(pd.GetPosition())))
    inside = [terms[0]]; rest = terms[1:]; w = V.WIDTH.get(n, .2)
    while rest:
        dd, a, c = min(((math.dist(x[1], y[1]), x, y) for x in inside for y in rest), key=lambda t: t[0])
        ok = False
        for ww in ([w, .3, .2] if w > .3 else [w]):
            try: legs, vias, _ = r.path(b, n, a[0]['xy'], c[0]['xy'], ww, ['F.Cu', 'B.Cu', 'In2.Cu'], a[0]['layers'], c[0]['layers'], V.BOUNDS, max_vias=3, max_states=800000, step=.1)
            except RuntimeError: continue
            L_ = put(n, legs, vias, ww, f'rr:{n}:{a[0]["name"]}-{c[0]["name"]}'); log['routes'].append({'net': n, 'edge': [a[0]['name'], c[0]['name']], 'w': ww, 'len': L_, 'vias': len(vias)}); ok = True; break
        if not ok: log['failed'].append({'net': n, 'edge': [a[0]['name'], c[0]['name']]})
        inside.append(c); rest.remove(c)
k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b); (OUT / 'v06-reroute.json').write_text(json.dumps(log, indent=2) + '\n')
print(json.dumps({'gnd': log['gnd'], 'routes': len(log['routes']), 'failed': log['failed']}))
