#!/usr/bin/env python3
"""Targeted repairs after v0.6 auto-routing: boxed-in expander pins (escape via + route), SW3 duplicate pads,
and GND islands (via at isolated pads). Existing copper is never modified."""
import json, math, sys
import wx, pcbnew as k
import route_pn7160 as r, apply_v05_pcb as A, apply_v06_pcb as V
app, b = A.load(); log = {'routes': [], 'failed': [], 'vias': []}
ALL = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
def pad(ref, num):
    f = next(f for f in b.GetFootprints() if f.GetReference() == ref); return [p for p in f.Pads() if p.GetNumber() == num]
def layers(p): return [b.GetLayerName(l) for l in (k.F_Cu, k.B_Cu) if p.IsOnLayer(l)]
def put(net, legs, vias, w, key):
    for vi, p in enumerate(vias): V.add_via(b, net, p, f'{key}:v{vi}')
    for li, (L, pts) in enumerate(legs):
        for ti, (x, y) in enumerate(zip(pts, pts[1:])):
            if math.dist(x, y) > 1e-8: V.add_track(b, net, b.GetLayerID(L), x, y, w, f'{key}:{li}:{ti}')
def escape_via(net, p, L, key, rmin=.6, rmax=2.4):
    checks = [r.collision_test(b, net, .5, l, True) for l in ALL]; stub = r.collision_test(b, net, .15, L)
    for d, c in sorted((math.hypot(ix * .05, iy * .05), [round(p[0] + ix * .05, 3), round(p[1] + iy * .05, 3)]) for ix in range(-50, 51) for iy in range(-50, 51)):
        if not rmin <= d <= rmax: continue
        if all(ch(c, c) for ch in checks) and stub(p, c):
            V.add_via(b, net, c, key + ':esc'); V.add_track(b, net, b.GetLayerID(L), p, c, .15, key + ':esct'); return c
    return None
# 1. expander pins boxed in: escape via at the U15 pin, then route the far end to that via on any layer
for net, far, near in (('LED_SENSE', ('R50', '2'), ('U15', '7')), ('BZR_SENSE', ('R51', '2'), ('U15', '8')), ('BZR_EN', ('R57', '1'), ('U15', '6'))):
    pn = pad(*near)[0]; pf = pad(*far)[0]; a = r.xy(pn.GetPosition()); c = r.xy(pf.GetPosition())
    ev = escape_via(net, a, 'F.Cu', 'rep:' + net)
    if ev is None: log['failed'].append({'net': net, 'err': 'NO_ESCAPE_VIA'}); continue
    try:
        legs, vias, _ = r.path(b, net, c, ev, .15, ['F.Cu', 'B.Cu', 'In2.Cu'], layers(pf), ALL, V.BOUNDS, max_vias=4, max_states=1500000, step=.1)
        put(net, legs, vias, .15, 'rep:' + net); log['routes'].append({'net': net, 'escape_via': ev, 'len': round(sum(math.dist(x, y) for _, p_ in legs for x, y in zip(p_, p_[1:])), 2), 'vias': len(vias) + 1})
    except RuntimeError as ex:
        log['failed'].append({'net': net, 'escape_via': ev, 'err': str(ex)[:120]})
# 2. SW3 has two pads per pin: join each pair on its own layer
for num in ('1', '2'):
    ps = pad('SW3', num); net = ps[0].GetNetname(); L = layers(ps[0])[0]
    a, c = r.xy(ps[0].GetPosition()), r.xy(ps[1].GetPosition())
    try:
        legs, vias, _ = r.path(b, net, a, c, .25, [L, 'In2.Cu'], [L], [L], V.BOUNDS, max_vias=2, max_states=300000, step=.05)
        put(net, legs, vias, .25, 'rep:SW3:' + num); log['routes'].append({'net': net, 'sw3_pin': num})
    except RuntimeError as ex:
        log['failed'].append({'net': net, 'sw3_pin': num, 'err': str(ex)[:120]})
# 3. ground: via next to every new GND pad that has none within 2.5 mm (islands / starved thermals)
gv = [r.xy(t.GetPosition()) for t in b.GetTracks() if isinstance(t, k.PCB_VIA) and t.GetNetname() == 'GND']
d = V.data(); new = {p['ref'] for p in d['parts'] if p.get('group') == 'Interface' and p['ref'] != 'R37'}
for f in b.GetFootprints():
    if f.GetReference() not in new: continue
    for p in f.Pads():
        if p.GetNetname() != 'GND' or p.GetAttribute() == k.PAD_ATTRIB_PTH or not p.GetNumber(): continue
        xy = r.xy(p.GetPosition())
        if any(math.dist(xy, v) < 2.5 for v in gv): continue
        L = layers(p)[0]; c = escape_via('GND', xy, L, f'repgnd:{f.GetReference()}.{p.GetNumber()}:{xy}', .55, 2.0)
        if c: gv.append(c); log['vias'].append({'pad': f'{f.GetReference()}.{p.GetNumber()}', 'via': c})
k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b)
(V.OUT / 'v06-repair.json').write_text(json.dumps(log, indent=2) + '\n'); print(json.dumps({'routes': len(log['routes']), 'gnd_vias': len(log['vias']), 'failed': log['failed']}))
