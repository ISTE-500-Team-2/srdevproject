#!/usr/bin/env python3
"""Targeted GND repairs after v0.5b routing: R5.2 island via, J6.3/J6.4 links to nearest GND via."""
import math, json, sys
import wx, pcbnew as k
import route_pn7160 as r, apply_v05_pcb as A
app, b = A.load(); log = []
def via(p, key):
    v = k.PCB_VIA(b); v.SetUuid(A.ident(key)); v.SetPosition(r.vec(p)); v.SetWidth(k.FromMM(.5)); v.SetDrill(k.FromMM(.2))
    v.SetViaType(k.VIATYPE_THROUGH); v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetNet(b.FindNet('GND')); v.SetLocked(True)
    v.SetFrontTentingMode(k.TENTING_MODE_TENTED); v.SetBackTentingMode(k.TENTING_MODE_TENTED); b.Add(v)
def track(L, a, c, w, key):
    t = k.PCB_TRACK(b); t.SetUuid(A.ident(key)); t.SetStart(r.vec(a)); t.SetEnd(r.vec(c)); t.SetLayer(L)
    t.SetNet(b.FindNet('GND')); t.SetWidth(k.FromMM(w)); t.SetLocked(True); b.Add(t)
# pad ground vias: 0.6-2.2 mm from the pad, joined by a straight front stub
PADS = sys.argv[1:] or ['R5.2']
for spec in PADS:
  p, _ = r.endpoint(b, spec, 'GND')
  checks = [r.collision_test(b, 'GND', .5, L, True) for L in r.ALL_COPPER]; stub = r.collision_test(b, 'GND', .25, 'F.Cu')
  for d, c in sorted((math.hypot(ix * .05, iy * .05), [round(p[0] + ix * .05, 3), round(p[1] + iy * .05, 3)]) for ix in range(-44, 45) for iy in range(-44, 45)):
    if not .6 <= d <= 2.2: continue
    if all(ch(c, c) for ch in checks) and stub(p, c):
        via(c, f'gndfix:{spec}:via'); track(k.F_Cu, p, c, .25, f'gndfix:{spec}:trk'); log.append({spec: c}); break
  else: log.append({spec: 'FAILED'})
if sys.argv[1:]:
    k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b); print(json.dumps(log)); sys.exit(0)
# J6 ground pins: short link to nearest GND via on any outer layer
gv = [r.xy(t.GetPosition()) for t in b.GetTracks() if isinstance(t, k.PCB_VIA) and t.GetNetname() == 'GND']
for spec in ('J6.3', 'J6.4'):
    a, sl = r.endpoint(b, spec, 'GND'); ok = False
    for vp in sorted(gv, key=lambda v: math.dist(v, a))[:10]:
        try:
            legs, vias, _ = r.path(b, 'GND', a, vp, .25, ['F.Cu', 'B.Cu'], sl, ['F.Cu', 'B.Cu'], [1, .5, 73.65, 44.7], max_vias=0, max_states=150000, step=.05)
        except RuntimeError: continue
        for li, (L, pts) in enumerate(legs):
            for ti, (x, y) in enumerate(zip(pts, pts[1:])): track(b.GetLayerID(L), x, y, .25, f'gndfix:{spec}:{li}:{ti}')
        log.append({spec: {'via': vp, 'len': round(sum(math.dist(x, y) for _, pts in legs for x, y in zip(pts, pts[1:])), 2)}}); ok = True; break
    if not ok: log.append({spec: 'FAILED'})
k.ZONE_FILLER(b).Fill(b.Zones()); A.save(b); print(json.dumps(log))
