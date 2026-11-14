#!/usr/bin/env python3
"""Apply the U15 port remap to the routed board (pad nets only), route the three moved signals, and add GND vias
at the two isolated ground pads (C50.2, U15.12)."""
import json, math
import wx, pcbnew as k
import route_pn7160 as r, apply_v05_pcb as A, apply_v06_pcb as V
app, b = A.load(); log = {'remap': [], 'routes': [], 'failed': [], 'gnd': []}
u15 = next(f for f in b.GetFootprints() if f.GetReference() == 'U15')
newmap = {'6': None, '7': None, '8': None, '14': 'BZR_EN', '15': 'LED_SENSE', '16': 'BZR_SENSE'}
for pd in u15.Pads():
    if pd.GetNumber() in newmap:
        n = newmap[pd.GetNumber()] or f'unconnected-(U15-{pd.GetPinFunction()}-Pad{pd.GetNumber()})'
        log['remap'].append([pd.GetNumber(), pd.GetNetname(), n]); pd.SetNet(A.net(b, n))
b.BuildConnectivity()
ALL = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
def pads(ref, num): return [p for f in b.GetFootprints() if f.GetReference() == ref for p in f.Pads() if p.GetNumber() == num]
for net, far, near in (('BZR_EN', ('R57', '1'), ('U15', '14')), ('LED_SENSE', ('R50', '2'), ('U15', '15')), ('BZR_SENSE', ('R51', '2'), ('U15', '16'))):
    a = r.xy(pads(*near)[0].GetPosition()); targets = [r.xy(pads(*far)[0].GetPosition())]
    targets += [r.xy(t.GetStart()) for t in b.GetTracks() if t.GetNetname() == net and not isinstance(t, k.PCB_VIA)]
    targets.sort(key=lambda c: math.dist(a, c)); ok = False
    for c in targets[:6]:
        try:
            legs, vias, _ = r.path(b, net, a, c, .15, ['F.Cu', 'B.Cu', 'In2.Cu'], ['F.Cu'], ['F.Cu'], V.BOUNDS, max_vias=4, max_states=900000, step=.1)
        except RuntimeError as ex:
            err = str(ex)[:100]; continue
        for vi, p in enumerate(vias): V.add_via(b, net, p, f'remap:{net}:v{vi}')
        for li, (L, pts) in enumerate(legs):
            for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                if math.dist(x, y) > 1e-8: V.add_track(b, net, b.GetLayerID(L), x, y, .15, f'remap:{net}:{li}:{ti}')
        log['routes'].append({'net': net, 'len': round(sum(math.dist(x, y) for _, p in legs for x, y in zip(p, p[1:])), 2), 'vias': len(vias)}); ok = True; break
    if not ok: log['failed'].append({'net': net, 'err': err})
for ref, num in (('C50', '2'), ('U15', '12')):
    p = r.xy(pads(ref, num)[0].GetPosition()); checks = [r.collision_test(b, 'GND', .5, l, True) for l in ALL]; stub = r.collision_test(b, 'GND', .2, 'F.Cu')
    for d, c in sorted((math.hypot(ix * .05, iy * .05), [round(p[0] + ix * .05, 3), round(p[1] + iy * .05, 3)]) for ix in range(-60, 61) for iy in range(-60, 61)):
        if not .55 <= d <= 3.0: continue
        if all(ch(c, c) for ch in checks) and stub(p, c):
            V.add_via(b, 'GND', c, f'remapgnd:{ref}{num}'); V.add_track(b, 'GND', k.F_Cu, p, c, .2, f'remapgndt:{ref}{num}'); log['gnd'].append({ref + '.' + num: c}); break
    else: log['failed'].append({'gnd': ref + '.' + num})
k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b)
(V.OUT / 'v06-remap.json').write_text(json.dumps(log, indent=2) + '\n'); print(json.dumps(log))
