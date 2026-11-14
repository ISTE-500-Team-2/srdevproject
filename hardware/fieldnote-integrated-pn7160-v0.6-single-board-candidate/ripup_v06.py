#!/usr/bin/env python3
"""Rip up NEW (v0.6-only) XTAL1/XTAL2/PWR_SRC copper around U15/C50, connect the boxed GND pads first,
then reroute the three nets. Never touches copper that exists in source-v05."""
import json, math
import wx, pcbnew as k
import route_pn7160 as r, apply_v05_pcb as A, apply_v06_pcb as V
app, b = A.load()
src = k.LoadBoard(str(V.ROOT / 'source-v05' / 'fieldnote.kicad_pcb')); keep = {t.m_Uuid.AsString() for t in src.GetTracks()}
removed = 'text-edit (output/v06-ripup-uuids.json)'
b.BuildConnectivity(); log = {'removed': removed, 'routes': [], 'failed': []}
def pads(ref, num): return [p for f in b.GetFootprints() if f.GetReference() == ref for p in f.Pads() if p.GetNumber() == num]
def go(net, a, sl, targets, w, key, nv=2, layers=('F.Cu', 'B.Cu', 'In2.Cu')):
    for c, el in targets:
        try: legs, vias, _ = r.path(b, net, a, c, w, list(layers), sl, el, V.BOUNDS, max_vias=nv, max_states=600000, step=.05 if net == 'GND' else .1)
        except RuntimeError: continue
        for vi, p in enumerate(vias): V.add_via(b, net, p, f'{key}:v{vi}')
        for li, (L, pts) in enumerate(legs):
            for ti, (x, y) in enumerate(zip(pts, pts[1:])):
                if math.dist(x, y) > 1e-8: V.add_track(b, net, b.GetLayerID(L), x, y, w, f'{key}:{li}:{ti}')
        log['routes'].append({'key': key, 'len': round(sum(math.dist(x, y) for _, p in legs for x, y in zip(p, p[1:])), 2), 'vias': len(vias)}); return True
    log['failed'].append(key); return False
ALL = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
gv = [r.xy(t.GetPosition()) for t in b.GetTracks() if isinstance(t, k.PCB_VIA) and t.GetNetname() == 'GND']
for ref, num in (('U15', '12'), ('C50', '2'), ('C51', '2'), ('Y2', '2'), ('Y2', '4')):
    a = r.xy(pads(ref, num)[0].GetPosition())
    go('GND', a, ['F.Cu'], [(v, ALL) for v in sorted(gv, key=lambda v: math.dist(v, a))[:10]], .25, f'rip:gnd:{ref}{num}', nv=1)
def pad_target(ref, num): p = pads(ref, num)[0]; return (r.xy(p.GetPosition()), ['F.Cu'])
for net, chain in (('XTAL1', [('U13', '15'), ('Y2', '1'), ('C50', '1')]), ('XTAL2', [('U13', '16'), ('Y2', '3'), ('C51', '1')])):
    for (r1, n1), (r2, n2) in zip(chain, chain[1:]):
        a, sl = pad_target(r1, n1); go(net, a, sl, [pad_target(r2, n2)], .2, f'rip:{net}:{r1}{n1}-{r2}{n2}')
a, sl = pad_target('U15', '10')
ex = sorted(((r.xy(t.GetStart()), [b.GetLayerName(t.GetLayer())]) for t in b.GetTracks() if t.GetNetname() == 'PWR_SRC' and not isinstance(t, k.PCB_VIA)), key=lambda c: math.dist(c[0], a))
ex += [pad_target('U11', '3'), pad_target('R36', '1')]
go('PWR_SRC', a, sl, ex[:10], .2, 'rip:PWR_SRC', nv=3)
k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b); (V.OUT / 'v06-ripup.json').write_text(json.dumps(log, indent=2) + '\n'); print(json.dumps(log))
