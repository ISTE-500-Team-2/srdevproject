"""Route explicit connections on a PN7160 seed into a separate candidate.

Uses KiCad's bundled Python 3.9 / pcbnew. The JSON plan lists reviewed pad or
coordinate endpoints; this helper never changes components, pad nets, or old
copper. Native KiCad DRC, schematic parity and RF bench validation remain
separate acceptance gates. Run native CLI DRC with --refill-zones afterward.
"""
from pathlib import Path
import argparse
import hashlib
import heapq
import json
import math
import re
import shutil
import uuid
import pcbnew as k
import wx

ROOT = Path(__file__).resolve().parent
GRID = .1
GUARD = .16  # project clearance .15 mm plus a 10 um routing guard
VIA_DIAMETER = .5
VIA_DRILL = .2
ALL_COPPER = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']
MOVABLE = {'U2', 'Y1', 'L1', 'L2', 'FB1', 'R19', 'R22', 'R23', 'R24', 'R25', 'R27', 'R28',
           'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19',
           'C22', 'C23', 'C24', 'C25', 'C26', 'C27', 'C28', 'C29', 'C30', 'C31',
           'C34', 'C35', 'C37', 'TP2', 'TP4', 'TP5'}


def xy(v):
    return [round(k.ToMM(v.x) - 60, 6), round(k.ToMM(v.y) - 50, 6)]


def vec(p):
    return k.VECTOR2I(k.FromMM(p[0] + 60), k.FromMM(p[1] + 50))


def point_segment(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    vv = dx * dx + dy * dy
    t = max(0., min(1., ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / vv)) if vv else 0.
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def segment_distance(a, b, c, d):
    def cross(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0:
        return 0.
    return min(point_segment(a, c, d), point_segment(b, c, d),
               point_segment(c, a, b), point_segment(d, a, b))


def inside(p, polygon):
    yes = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[1] > p[1]) != (b[1] > p[1]):
            x = (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
            if p[0] < x:
                yes = not yes
    return yes


def collision_test(board, net, width, layer, via=False):
    li = board.GetLayerID(layer)
    segments, rectangles, polygons = [], [], []
    for track in board.GetTracks():
        if via and isinstance(track, k.PCB_VIA):
            # Drill spacing applies even to conductors on the same net.
            hole_guard = VIA_DRILL / 2 + k.ToMM(track.GetDrillValue()) / 2 + .26
            p = xy(track.GetPosition())
            segments.append((p, p, hole_guard))
        if track.GetNetname() == net or not track.IsOnLayer(li):
            continue
        tw = k.ToMM(track.GetWidth(li)) if isinstance(track, k.PCB_VIA) else k.ToMM(track.GetWidth())
        a, c = xy(track.GetStart()), xy(track.GetEnd())
        clocks = net in ['NFC_OSCIN', 'NFC_OSCOUT'] and track.GetNetname() in ['NFC_OSCIN', 'NFC_OSCOUT']
        if clocks:
            # Adjacent QFN clock lands have only .5 mm pitch. Apply NXP's .5 mm
            # track separation outside the first .85 mm of that fixed fanout.
            count = max(1, math.ceil(math.dist(a, c) / .1))
            parts = [[a[0] + (c[0] - a[0]) * i / count,
                      a[1] + (c[1] - a[1]) * i / count] for i in range(count + 1)]
            clock_pads = [xy(p.GetPosition()) for f in board.GetFootprints() if f.GetReference() == 'U2'
                          for p in f.Pads() if p.GetNumber() in ['29', '30']]
            for u, v in zip(parts, parts[1:]):
                mid = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2]
                guard = GUARD if any(math.dist(mid, p) < .85 for p in clock_pads) else .5
                segments.append((u, v, tw / 2 + width / 2 + guard))
        else:
            segments.append((a, c, tw / 2 + width / 2 + GUARD))
    for footprint in board.GetFootprints():
        for pad in footprint.Pads():
            if not pad.IsOnLayer(li) or (pad.GetNetname() == net and not via):
                continue
            bb = pad.GetBoundingBox()
            a = xy(bb.GetPosition())
            c = xy(k.VECTOR2I(bb.GetX() + bb.GetWidth(), bb.GetY() + bb.GetHeight()))
            rectangles.append((a, c))
            # A same-net via may approach the pad but may not drill an SMT land.
            guard = .05 if via and pad.GetNetname() == net else GUARD
            radius = width / 2 + guard
            vertices = [a, [c[0], a[1]], c, [a[0], c[1]]]
            segments.extend((p, q, radius) for p, q in zip(vertices, vertices[1:] + vertices[:1]))
    for zone in board.Zones():
        if not zone.GetIsRuleArea() or not zone.IsOnLayer(li):
            continue
        if not (zone.GetDoNotAllowVias() if via else zone.GetDoNotAllowTracks()):
            continue
        poly = zone.Outline()
        for oi in range(poly.OutlineCount()):
            outline = poly.Outline(oi)
            vertices = [xy(outline.CPoint(i)) for i in range(outline.PointCount())]
            polygons.append(vertices)
            segments.extend((p, q, width / 2) for p, q in zip(vertices, vertices[1:] + vertices[:1]))

    # A uniform spatial index keeps the 0.1 mm search responsive on a board
    # retaining more than a thousand old conductors. Obstacle bounding boxes
    # include the required radius, so skipping distant buckets is conservative.
    def cells(x0, y0, x1, y1):
        return ((ix, iy) for ix in range(math.floor(x0), math.floor(x1) + 1)
                for iy in range(math.floor(y0), math.floor(y1) + 1))
    segment_grid, rectangle_grid = {}, {}
    for si, (p, q, radius) in enumerate(segments):
        for cell in cells(min(p[0], q[0]) - radius, min(p[1], q[1]) - radius,
                          max(p[0], q[0]) + radius, max(p[1], q[1]) + radius):
            segment_grid.setdefault(cell, []).append(si)
    for ri, (p, q) in enumerate(rectangles):
        for cell in cells(p[0], p[1], q[0], q[1]):
            rectangle_grid.setdefault(cell, []).append(ri)

    def clear(a, c):
        for ri in rectangle_grid.get((math.floor(a[0]), math.floor(a[1])), []):
            p, q = rectangles[ri]
            if p[0] <= a[0] <= q[0] and p[1] <= a[1] <= q[1]:
                return False
        if any(inside(a, poly) or inside(c, poly) for poly in polygons):
            return False
        nearby = set()
        for cell in cells(min(a[0], c[0]), min(a[1], c[1]), max(a[0], c[0]), max(a[1], c[1])):
            nearby.update(segment_grid.get(cell, []))
        for si in nearby:
            p, q, radius = segments[si]
            if (max(a[0], c[0]) + radius < min(p[0], q[0]) or
                    min(a[0], c[0]) - radius > max(p[0], q[0]) or
                    max(a[1], c[1]) + radius < min(p[1], q[1]) or
                    min(a[1], c[1]) - radius > max(p[1], q[1])):
                continue
            if segment_distance(a, c, p, q) < radius - 1e-8:
                return False
        return True
    return clear


def collapse(points):
    result = [points[0]]
    for i in range(1, len(points) - 1):
        a, c, d = result[-1], points[i], points[i + 1]
        if abs((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) > 1e-8:
            result.append(c)
    result.append(points[-1])
    return result


def path(board, net, start, end, width, layers, start_layers, end_layers, bounds,
         max_vias=2, max_states=250000, step=GRID):
    clear = {layer: collision_test(board, net, width, layer) for layer in layers}
    via_clear = [collision_test(board, net, VIA_DIAMETER, layer, True) for layer in ALL_COPPER]
    for layer in layers:
        if layer in start_layers and layer in end_layers and clear[layer](start, end):
            return [[layer, [start, end]]], [], 0
    point = lambda u: (round(start[0] + u[1] * step, 6), round(start[1] + u[2] * step, 6))
    queue, best, previous, edge_cache, via_cache = [], {}, {}, {}, {}
    for li, layer in enumerate(layers):
        if layer in start_layers:
            state = (li, 0, 0, 0)
            best[state] = 0.
            heapq.heappush(queue, (math.dist(start, end), 0., state))
    goal, visited = None, 0
    while queue and visited < max_states:
        _, cost, u = heapq.heappop(queue)
        if cost > best[u] + 1e-8:
            continue
        visited += 1
        a, layer = point(u), layers[u[0]]
        if layer in end_layers and math.dist(a, end) <= .22 and clear[layer](a, end):
            goal = u
            break
        options = []
        for dx, dy in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]:
            v = (u[0], u[1] + dx, u[2] + dy, u[3])
            c = point(v)
            if not (bounds[0] <= c[0] <= bounds[2] and bounds[1] <= c[1] <= bounds[3]):
                continue
            pair = (u[0], tuple(sorted([(u[1], u[2]), (v[1], v[2])])))
            if pair not in edge_cache:
                edge_cache[pair] = clear[layer](a, c)
            if edge_cache[pair]:
                # Favor the front RF route without making an impossible barrier.
                factor = 1. if layer == 'F.Cu' else 1.025
                options.append((v, math.hypot(dx, dy) * step * factor))
        if u[3] < max_vias:
            key = u[1:3]
            if key not in via_cache:
                via_cache[key] = all(fn(a, a) for fn in via_clear)
            if via_cache[key]:
                options.extend(((li, u[1], u[2], u[3] + 1), 2.5)
                               for li in range(len(layers)) if li != u[0])
        for v, added in options:
            next_cost = cost + added
            if next_cost < best.get(v, 1e99):
                best[v], previous[v] = next_cost, u
                heapq.heappush(queue, (next_cost + math.dist(point(v), end), next_cost, v))
    if goal is None:
        raise RuntimeError(('NO_PATH', net, start, end, layers, visited))
    states = [goal]
    while goal in previous:
        goal = previous[goal]
        states.append(goal)
    states.reverse()
    legs, vias, points, layer = [], [], [start], layers[states[0][0]]
    for u in states[1:]:
        p, next_layer = point(u), layers[u[0]]
        if next_layer != layer:
            legs.append([layer, collapse(points)])
            vias.append(p)
            layer, points = next_layer, [p]
        else:
            points.append(p)
    points.append(end)
    legs.append([layer, collapse(points)])
    for layer, points in legs:
        simplified, i = [points[0]], 0
        while i < len(points) - 1:
            for j in range(len(points) - 1, i, -1):
                if clear[layer](points[i], points[j]):
                    simplified.append(points[j])
                    i = j
                    break
            else:
                raise RuntimeError(('SMOOTHING_LOST_VALID_EDGE', net, layer, i))
        points[:] = simplified
    return legs, vias, visited


def track_snapshot(board):
    result = {}
    for t in board.GetTracks():
        row = {'net': t.GetNetname(), 'start': xy(t.GetStart()), 'end': xy(t.GetEnd()),
               'layer': t.GetLayer(), 'locked': t.IsLocked()}
        if isinstance(t, k.PCB_VIA):
            row.update(kind='via', diameter=k.ToMM(t.GetWidth(k.F_Cu)), drill=k.ToMM(t.GetDrillValue()))
        else:
            row.update(kind='track', width=k.ToMM(t.GetWidth()))
        result[t.m_Uuid.AsString()] = row
    return result


def endpoint(board, spec, net):
    if isinstance(spec, str):
        ref, num = spec.rsplit('.', 1)
        found = [p for f in board.GetFootprints() if f.GetReference() == ref
                 for p in f.Pads() if p.GetNumber() == num]
        if len(found) != 1 or found[0].GetNetname() != net:
            raise ValueError(('BAD_PAD_ENDPOINT', spec, net, [p.GetNetname() for p in found]))
        return xy(found[0].GetPosition()), [board.GetLayerName(li) for li in
                                          [k.F_Cu, k.In1_Cu, k.In2_Cu, k.B_Cu] if found[0].IsOnLayer(li)]
    return spec['xy'], spec.get('layers', ['F.Cu'])


def courtyard(footprint):
    boxes = [item.GetBoundingBox() for item in footprint.GraphicalItems() if item.GetLayer() == k.F_CrtYd]
    if not boxes:
        boxes = [pad.GetBoundingBox() for pad in footprint.Pads() if pad.IsOnLayer(k.F_Cu)]
        if not boxes:
            return None
        return [min(k.ToMM(bb.GetX()) - 60 for bb in boxes) - .25,
                min(k.ToMM(bb.GetY()) - 50 for bb in boxes) - .25,
                max(k.ToMM(bb.GetX() + bb.GetWidth()) - 60 for bb in boxes) + .25,
                max(k.ToMM(bb.GetY() + bb.GetHeight()) - 50 for bb in boxes) + .25]
    return [min(k.ToMM(bb.GetX()) - 60 for bb in boxes), min(k.ToMM(bb.GetY()) - 50 for bb in boxes),
            max(k.ToMM(bb.GetX() + bb.GetWidth()) - 60 for bb in boxes),
            max(k.ToMM(bb.GetY() + bb.GetHeight()) - 50 for bb in boxes)]


def placement_search(board, requested):
    """Search NFC-only positions against native courtyards and old front copper."""
    refs = {f.GetReference(): f for f in board.GetFootprints()}
    for ref in requested:
        refs[ref].SetPosition(vec([-50, -50]))
    courts = {ref: courtyard(f) for ref, f in refs.items() if ref not in requested}
    old_copper = []
    for t in board.GetTracks():
        if not t.IsOnLayer(k.F_Cu):
            continue
        is_via = isinstance(t, k.PCB_VIA)
        width = k.ToMM(t.GetWidth(k.F_Cu)) if is_via else k.ToMM(t.GetWidth())
        old_copper.append([xy(t.GetStart()), xy(t.GetEnd()), width / 2, t.GetNetname(), is_via])
    keepouts = []
    for z in board.Zones():
        if z.GetIsRuleArea() and z.IsOnLayer(k.F_Cu) and z.GetDoNotAllowPads():
            for oi in range(z.Outline().OutlineCount()):
                ol = z.Outline().Outline(oi)
                keepouts.append([xy(ol.CPoint(i)) for i in range(ol.PointCount())])

    def legal(ref):
        f = refs[ref]
        cb = courtyard(f)
        if cb and any(other and not (cb[2] + .01 < other[0] or cb[0] - .01 > other[2] or
                                     cb[3] + .01 < other[1] or cb[1] - .01 > other[3])
                      for other in courts.values()):
            return False
        for p in f.Pads():
            if not p.IsOnLayer(k.F_Cu):
                continue
            bb = p.GetBoundingBox()
            a = xy(bb.GetPosition())
            c = xy(k.VECTOR2I(bb.GetX() + bb.GetWidth(), bb.GetY() + bb.GetHeight()))
            if not (33.2 <= a[0] and c[0] <= 49.5 and 10.8 <= a[1] and c[1] <= 38.55):
                return False
            vertices = [a, [c[0], a[1]], c, [a[0], c[1]]]
            if any(inside(v, poly) for poly in keepouts for v in vertices):
                return False
            for u, v, radius, net, is_via in old_copper:
                if net == p.GetNetname():
                    # Retained thermal vias in the QFN exposed ground pad are
                    # intentional. Ordinary capacitor/resistor lands stay clear.
                    if not is_via or (ref == 'U2' and p.GetNumber() == '41'):
                        continue
                    margin = radius + .05
                else:
                    margin = radius + .16
                if (max(u[0], v[0]) + margin < a[0] or min(u[0], v[0]) - margin > c[0] or
                        max(u[1], v[1]) + margin < a[1] or min(u[1], v[1]) - margin > c[1]):
                    continue
                if any(a[0] <= q[0] <= c[0] and a[1] <= q[1] <= c[1] for q in [u, v]):
                    return False
                if any(segment_distance(u, v, q, r) < margin - 1e-8
                       for q, r in zip(vertices, vertices[1:] + vertices[:1])):
                    return False
        return True

    desired_order = ['C25', 'U2', 'L1', 'L2', 'Y1', 'C22', 'C23', 'C14', 'C13', 'C17', 'C18',
                     'C12', 'C15', 'C16', 'C30', 'C31', 'C37', 'R24', 'R25', 'C19', 'R19',
                     'R27', 'R28', 'TP2', 'TP4', 'TP5']
    order = [ref for ref in desired_order if ref in requested] + sorted(set(requested) - set(desired_order))
    offsets = sorted([(ix * .25, iy * .25) for ix in range(-24, 25) for iy in range(-24, 25)],
                     key=lambda p: (math.hypot(*p), abs(p[0]) + abs(p[1])))
    solved = {}
    for ref in order:
        row = requested[ref]
        angles = row.get('search_angles', [row.get('angle', refs[ref].GetOrientationDegrees())])
        candidates = [(math.hypot(dx, dy) + ai * .15, row['xy'][0] + dx, row['xy'][1] + dy, angle)
                      for ai, angle in enumerate(angles) for dx, dy in ([(0, 0)] if row.get('fixed') else offsets)]
        candidates.sort(key=lambda t: t[0])
        found = False
        for tested, (_, x, y, angle) in enumerate(candidates):
            refs[ref].SetOrientationDegrees(angle)
            refs[ref].SetPosition(vec([x, y]))
            if legal(ref):
                courts[ref] = courtyard(refs[ref])
                solved[ref] = {'xy': [x, y], 'angle': angle}
                print(json.dumps({'placed': ref, 'xy': [x, y], 'angle': angle, 'proposals_tested': tested + 1}), flush=True)
                found = True
                break
        if not found:
            raise RuntimeError(('NO_LEGAL_NFC_PLACEMENT', ref, row))
    return solved


def connections_from_drc(board, filename):
    """Turn native missing-connection pairs into inspectable routing tasks."""
    drc = json.loads(Path(filename).read_text())
    tracks = {t.m_Uuid.AsString(): t for t in board.GetTracks()}
    result = []

    def locate(item, other):
        desc = item['description']
        match = re.search(r'pad\s+(\S+)\s+\[([^]]+)\]\s+of\s+(\S+)', desc, re.I)
        if match:
            return match.group(3) + '.' + match.group(1), match.group(2)
        track = tracks[item['uuid']]
        net = track.GetNetname()
        if isinstance(track, k.PCB_VIA):
            return {'xy': xy(track.GetPosition()), 'layers': ALL_COPPER}, net
        a, c = xy(track.GetStart()), xy(track.GetEnd())
        p = [other['pos']['x'] - 60, other['pos']['y'] - 50]
        vx, vy = c[0] - a[0], c[1] - a[1]
        vv = vx * vx + vy * vy
        t = max(0., min(1., ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / vv)) if vv else 0.
        point = [round(a[0] + t * vx, 6), round(a[1] + t * vy, 6)]
        return {'xy': point, 'layers': [board.GetLayerName(track.GetLayer())]}, net

    priority = {'NFC_TX1': 1, 'NFC_TX2': 1, 'RF1_FILTER': 2, 'RF2_FILTER': 2,
                'RF1_MATCH': 3, 'RF2_MATCH': 3, 'ANT_A': 4, 'ANT_B': 4,
                'NFC_OSCIN': 0, 'NFC_OSCOUT': 0, 'PN_TX_LDO': 5, 'NFC_VBAT': 5, 'VSYS': 5,
                'PN_1V8': 6, 'NFC_VMID': 6, '3V3': 6, 'RF_RXP_COUPLED': 7,
                'RF_RXN_COUPLED': 7, 'NFC_RXP': 7, 'NFC_RXN': 7, 'GND': 8}
    for pair in drc.get('unconnected_items', []):
        left, right = pair['items']
        if all('[GND]' in item['description'] for item in [left, right]):
            # Filled-zone origins are not electrical anchors. Ground islands
            # and local cap/QFN returns are stitched in the grounding pass.
            continue
        start, net = locate(left, right)
        end, second_net = locate(right, left)
        if net != second_net:
            raise ValueError(('NATIVE_UNCONNECTED_NET_MISMATCH', pair))
        if net == 'VSYS' and 'a484fcd3-f9da-42e3-8a25-403cf4bd7830' in tracks:
            # The relocated ferrite must consume its old free feed terminal,
            # not leave a protected dangling stub by tapping the closest rail.
            feed = tracks['a484fcd3-f9da-42e3-8a25-403cf4bd7830']
            start = dict(xy=xy(feed.GetStart()), layers=['F.Cu'])
            end = 'FB1.1'
        a, sl = endpoint(board, start, net)
        c, el = endpoint(board, end, net)
        width = {'NFC_VBAT': .35, 'VSYS': .45, 'PN_TX_LDO': .30, 'PN_1V8': .25, '3V3': .20,
                 'NFC_TX1': .25, 'NFC_TX2': .25, 'RF1_FILTER': .3, 'RF2_FILTER': .3,
                 'RF1_MATCH': .3, 'RF2_MATCH': .3, 'ANT_A': .3, 'ANT_B': .3}.get(net, .15)
        result.append(dict(net=net, start=start, end=end, width=width,
                           layers=(['F.Cu'] if net in ['NFC_OSCIN', 'NFC_OSCOUT'] else
                                   ['F.Cu', 'B.Cu'] if net in ['NFC_TX1', 'NFC_TX2', 'RF1_FILTER', 'RF2_FILTER',
                                                              'RF1_MATCH', 'RF2_MATCH', 'ANT_A', 'ANT_B'] else
                                   ['F.Cu', 'B.Cu', 'In2.Cu']),
                           bounds=([33.3, 10.3, 49.65, 37.7] if net == 'VSYS' else
                                   [31.85, 1.2, 64.8, 38.5]),
                           max_vias=(0 if net in ['NFC_OSCIN', 'NFC_OSCOUT'] else
                                     4 if math.dist(a, c) > 10 else 2),
                           native_pair_uuids=[left['uuid'], right['uuid']],
                           priority=priority.get(net, 9), direct_distance_mm=math.dist(a, c)))
    def route_order(row):
        if row['net'] in ['NFC_OSCIN', 'NFC_OSCOUT']:
            main = any(isinstance(v, str) and v.startswith('U2.') for v in [row['start'], row['end']])
            return (0, (0 if row['net'] == 'NFC_OSCOUT' else 1) if main else
                    (2 if row['net'] == 'NFC_OSCOUT' else 3), row['direct_distance_mm'])
        return (row['priority'], row['net'], row['direct_distance_mm'])
    result.sort(key=route_order)
    return result


def reserve_qfn_escapes(board, connections, excluded=()):
    """Reserve narrow outward QFN stubs before any wider cross-board route.

    This keeps later power/RF routes from surrounding still-unrouted fine-pitch
    signal lands. The explicit list and .15 mm neckdowns remain reviewable.
    """
    f = next(f for f in board.GetFootprints() if f.GetReference() == 'U2')
    center = xy(f.GetPosition())
    pads = {p.GetNumber(): p for p in f.Pads()}
    needed = {v for row in connections for v in [row['start'], row['end']]
              if isinstance(v, str) and v.startswith('U2.') and
              v not in excluded and
              row['net'] not in ['NFC_OSCIN', 'NFC_OSCOUT', 'GND']}
    stubs, substitutions = [], {}
    for spec in sorted(needed, key=lambda v: int(v.split('.')[1])):
        pad = pads[spec.split('.')[1]]
        net, start = pad.GetNetname(), xy(pad.GetPosition())
        delta = [start[0] - center[0], start[1] - center[1]]
        axis = 0 if abs(delta[0]) > abs(delta[1]) else 1
        direction = 1 if delta[axis] > 0 else -1
        check = collision_test(board, net, .15, 'F.Cu')
        choices = []
        for distance in [.45, .5, .55, .6, .65, .7, .75, .8, .85, .9]:
            end = start.copy()
            end[axis] = round(end[axis] + direction * distance, 6)
            if check(start, end):
                choices.append(end)
        if not choices:
            continue
        end = choices[-1]
        endpoint_spec = dict(xy=end, layers=['F.Cu'])
        substitutions[spec] = endpoint_spec
        stubs.append(dict(net=net, start=spec, end=endpoint_spec, width=.15,
                          layers=['F.Cu'], points=[start, end], max_vias=0,
                          purpose='Short fine-pitch QFN fanout before wider routing'))
    main = []
    for row in connections:
        copy = row.copy()
        for key in ['start', 'end']:
            if isinstance(copy[key], str) and copy[key] in substitutions:
                copy[key] = substitutions[copy[key]]
        main.append(copy)
    clocks = [row for row in main if row['net'] in ['NFC_OSCIN', 'NFC_OSCOUT']]
    other = [row for row in main if row['net'] not in ['NFC_OSCIN', 'NFC_OSCOUT']]
    return stubs + clocks + other


def audit_native_candidate(source, out):
    """Compare reloaded post-refill copper against the immutable route input."""
    report = json.loads((out / 'routing-report.json').read_text())
    if hashlib.sha256(source.read_bytes()).hexdigest() != report['source_sha256']:
        raise ValueError('Routing source changed since report was made')
    source_board = k.LoadBoard(str(source))
    target = out / 'fieldnote.kicad_pcb'
    candidate = k.LoadBoard(str(target))
    expected = track_snapshot(source_board)
    for row in report.get('removed_added_copper', []):
        expected.pop(row['uuid'])
    for row in report.get('seed_net_corrections', []):
        expected[row['uuid']] = row['after']
    final = track_snapshot(candidate)
    differences = [{'uuid': ident, 'expected': geometry, 'actual': final.get(ident)}
                   for ident, geometry in expected.items() if final.get(ident) != geometry]
    added_differences = [{'uuid': ident, 'expected': geometry, 'actual': final.get(ident)}
                         for ident, geometry in report.get('new_copper_geometry', {}).items()
                         if final.get(ident) != geometry]
    declared_moves = report.get('moved_nfc_footprints', {})
    source_positions = {f.GetReference(): [xy(f.GetPosition()), f.GetOrientationDegrees()]
                        for f in source_board.GetFootprints()}
    final_positions = {f.GetReference(): [xy(f.GetPosition()), f.GetOrientationDegrees()]
                       for f in candidate.GetFootprints()}
    position_differences = []
    for ref, position in source_positions.items():
        required = declared_moves[ref]['after'] if ref in declared_moves else position
        if final_positions.get(ref) != required:
            position_differences.append(dict(ref=ref, expected=required, actual=final_positions.get(ref)))
    check = dict(status=('PASS_NATIVE_POST_REFILL_INVARIANCE' if not
                         (differences or added_differences or position_differences) else 'FAIL_NATIVE_POST_REFILL_INVARIANCE'),
                 source_path=str(source), source_sha256=report['source_sha256'],
                 candidate_path=str(target), candidate_sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                 retained_copper_count=len(expected), retained_copper_differences=differences,
                 added_copper_differences=added_differences, footprint_position_differences=position_differences,
                 declared_seed_net_corrections=report.get('seed_net_corrections', []))
    (out / 'post-refill-invariance.json').write_text(json.dumps(check, indent=2) + '\n')
    report['post_refill_candidate_sha256'] = check['candidate_sha256']
    report['post_refill_invariance_status'] = check['status']
    (out / 'routing-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: check[key] for key in ['status', 'candidate_sha256', 'retained_copper_count']}), flush=True)
    return check['status'].startswith('PASS')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', type=Path, required=True)
    ap.add_argument('--plan', type=Path, required=True)
    ap.add_argument('--output', type=Path, default=ROOT / 'output' / 'pn7160-routed-candidate')
    ap.add_argument('--search-placement', action='store_true')
    ap.add_argument('--allow-partial', action='store_true')
    ap.add_argument('--from-drc', type=Path)
    ap.add_argument('--audit-only', action='store_true')
    args = ap.parse_args()
    app = wx.App(False)
    source = args.source.resolve()
    out = args.output.resolve()
    if ROOT / 'output' not in out.parents:
        raise ValueError('Candidate must be inside the PN7160 variant output directory')
    if out == source.parent:
        raise ValueError('Refusing to overwrite seed directory')
    if args.audit_only:
        if not audit_native_candidate(source, out):
            raise RuntimeError('Post-refill invariance failed; inspect JSON differences')
        return
    before = source.read_bytes()
    digest = hashlib.sha256(before).hexdigest()
    plan = json.loads(args.plan.read_text())
    if plan.get('source_sha256') and plan['source_sha256'] != digest:
        raise ValueError('Seed changed since routing plan review')
    board = k.LoadBoard(str(source))
    retained_native_tracks = list(board.GetTracks())
    retained_native_footprints = list(board.GetFootprints())
    retained = track_snapshot(board)
    removed_added = []
    if plan.get('remove_added_copper'):
        protected_board = k.LoadBoard(str(ROOT / 'output' / 'pn7160-seed' / 'fieldnote.kicad_pcb'))
        protected = track_snapshot(protected_board)
        for row in plan['remove_added_copper']:
            if row['uuid'] in protected:
                raise ValueError(('REFUSING_REMOVAL_OF_INHERITED_COPPER', row))
            old = next(t for t in retained_native_tracks if t.m_Uuid.AsString() == row['uuid'])
            removed_added.append(dict(uuid=row['uuid'], geometry=retained.pop(row['uuid']),
                                      reason=row['reason']))
            board.Remove(old)
    seed_net_corrections = []
    by_id = {t.m_Uuid.AsString(): t for t in retained_native_tracks}
    for row in plan.get('seed_net_corrections', []):
        t = by_id[row['uuid']]
        if t.GetNetname() != row['from_net']:
            raise ValueError(('SEED_NET_CORRECTION_MISMATCH', row))
        before_geometry = retained[row['uuid']].copy()
        t.SetNet(board.FindNet(row['to_net']))
        retained[row['uuid']]['net'] = row['to_net']
        seed_net_corrections.append(dict(uuid=row['uuid'], before=before_geometry,
                                        after=retained[row['uuid']], reason=row['reason']))
    placements = {f.GetReference(): [xy(f.GetPosition()), f.GetOrientationDegrees()]
                  for f in board.GetFootprints()}
    refs = {f.GetReference(): f for f in retained_native_footprints}
    requested_moves = plan.get('placements', {})
    if set(requested_moves) - MOVABLE:
        raise ValueError(('UNAUTHORIZED_FOOTPRINT_MOVE', sorted(set(requested_moves) - MOVABLE)))
    if args.search_placement:
        requested_moves = placement_search(board, requested_moves)
        plan['placements'] = requested_moves
    for ref, row in requested_moves.items():
        refs[ref].SetOrientationDegrees(row.get('angle', refs[ref].GetOrientationDegrees()))
        refs[ref].SetPosition(vec(row['xy']))
        if plan.get('hide_moved_component_labels'):
            refs[ref].Reference().SetVisible(False)
            refs[ref].Value().SetVisible(False)
    expected_placements = {f.GetReference(): [xy(f.GetPosition()), f.GetOrientationDegrees()]
                           for f in retained_native_footprints}
    if args.from_drc:
        plan['connections'] = connections_from_drc(board, args.from_drc)
        native_drc = json.loads(args.from_drc.read_text())
        plan['deferred_ground_pairs'] = [pair for pair in native_drc.get('unconnected_items', [])
                                        if all('[GND]' in item['description'] for item in pair['items'])]
    if plan.get('reserve_qfn_escapes'):
        plan['connections'] = reserve_qfn_escapes(board, plan.get('connections', []),
                                                plan.get('qfn_escape_exclusions', []))
    added, routes, new_native_items, failed = [], [], [], []

    def uid(key):
        return k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL, 'fieldnote-pn7160-route:' + digest + ':' + key)))

    def via(net, p, key):
        v = k.PCB_VIA(board)
        v.SetUuid(uid(key))
        v.SetPosition(vec(p))
        v.SetWidth(k.FromMM(VIA_DIAMETER))
        v.SetDrill(k.FromMM(VIA_DRILL))
        v.SetViaType(k.VIATYPE_THROUGH)
        v.SetLayerPair(k.F_Cu, k.B_Cu)
        v.SetNet(board.FindNet(net))
        v.SetLocked(True)
        v.SetFrontTentingMode(k.TENTING_MODE_TENTED)
        v.SetBackTentingMode(k.TENTING_MODE_TENTED)
        board.Add(v)
        new_native_items.append(v)
        added.append(v.m_Uuid.AsString())

    def add_declared_vias():
        for vi, row in enumerate(plan.get('vias', [])):
            if not all(collision_test(board, row['net'], VIA_DIAMETER, li, True)(row['xy'], row['xy'])
                       for li in ALL_COPPER):
                raise RuntimeError(('DECLARED_VIA_COLLISION', vi, row))
            via(row['net'], row['xy'], 'extra-via:%d' % vi)
    if plan.get('vias_before_routes'):
        add_declared_vias()
    for ri, row in enumerate(plan.get('connections', [])):
        net = row['net']
        start, sl = endpoint(board, row['start'], net)
        end, el = endpoint(board, row['end'], net)
        width = row.get('width', .15)
        layers = row.get('layers', ['F.Cu', 'B.Cu', 'In2.Cu'])
        bounds = row.get('bounds', [33.2, 1.2, 64.8, 38.5])
        print(json.dumps({'routing': ri, 'net': net, 'start': start, 'end': end}), flush=True)
        if 'points' in row:
            if math.dist(row['points'][0], start) > 1e-6 or math.dist(row['points'][-1], end) > 1e-6:
                raise ValueError(('DECLARED_PATH_ENDPOINT_MISMATCH', ri, net))
            legs, vias, visited = [[layers[0], row['points']]], [], 0
            check = collision_test(board, net, width, layers[0])
            if not all(check(a, c) for a, c in zip(row['points'], row['points'][1:])):
                raise RuntimeError(('DECLARED_PATH_COLLISION', ri, net))
        else:
            try:
                legs, vias, visited = path(board, net, start, end, width, layers, sl, el, bounds,
                                           row.get('max_vias', 2), row.get('max_states', 250000), row.get('step', GRID))
            except RuntimeError as exc:
                if not args.allow_partial:
                    raise
                failure = {'connection_index': ri, 'connection': row, 'error': str(exc)}
                failed.append(failure)
                print(json.dumps({'unrouted': failure}), flush=True)
                continue
        for vi, p in enumerate(vias):
            via(net, p, '%d:via:%d' % (ri, vi))
        for li, (layer, points) in enumerate(legs):
            for ti, (a, c) in enumerate(zip(points, points[1:])):
                if math.dist(a, c) < 1e-7:
                    continue
                t = k.PCB_TRACK(board)
                t.SetUuid(uid('%d:leg:%d:track:%d' % (ri, li, ti)))
                t.SetStart(vec(a))
                t.SetEnd(vec(c))
                t.SetNet(board.FindNet(net))
                t.SetLayer(board.GetLayerID(layer))
                t.SetWidth(k.FromMM(width))
                t.SetLocked(True)
                board.Add(t)
                new_native_items.append(t)
                added.append(t.m_Uuid.AsString())
        routes.append(dict(net=net, start=start, end=end, width=width, legs=legs, vias=vias,
                           visited_states=visited, length_mm=sum(math.dist(a, c) for _, points in legs
                                                                 for a, c in zip(points, points[1:]))))
    if not plan.get('vias_before_routes'):
        add_declared_vias()
    widening = []
    for old in list(new_native_items):
        if isinstance(old, k.PCB_VIA):
            continue
        net = old.GetNetname()
        wanted = plan.get('widen_new_tracks', {}).get(net)
        current = k.ToMM(old.GetWidth())
        if not wanted or wanted <= current:
            continue
        a, c = xy(old.GetStart()), xy(old.GetEnd())
        length = math.dist(a, c)
        count = max(1, math.ceil(length / .4))
        points = [[a[0] + (c[0] - a[0]) * i / count,
                   a[1] + (c[1] - a[1]) * i / count] for i in range(count + 1)]
        layer = board.GetLayerName(old.GetLayer())
        clear = collision_test(board, net, wanted, layer)
        widths = [wanted if clear(u, v) else current for u, v in zip(points, points[1:])]
        if max(widths) <= current:
            continue
        ident = old.m_Uuid.AsString()
        board.Remove(old)
        added.remove(ident)
        parts = []
        for i, (u, v, w) in enumerate(zip(points, points[1:], widths)):
            t = k.PCB_TRACK(board)
            t.SetUuid(uid('widen:' + ident + ':' + str(i)))
            t.SetStart(vec(u))
            t.SetEnd(vec(v))
            t.SetNet(board.FindNet(net))
            t.SetLayer(old.GetLayer())
            t.SetWidth(k.FromMM(w))
            t.SetLocked(True)
            board.Add(t)
            new_native_items.append(t)
            added.append(t.m_Uuid.AsString())
            parts.append(dict(uuid=t.m_Uuid.AsString(), width_mm=w,
                              length_mm=math.dist(u, v)))
        widening.append(dict(net=net, replaced_new_track_uuid=ident,
                             requested_width_mm=wanted, parts=parts))
    now = track_snapshot(board)
    assert all(now.get(ident) == geometry for ident, geometry in retained.items())
    assert expected_placements == {f.GetReference(): [xy(f.GetPosition()), f.GetOrientationDegrees()]
                                   for f in board.GetFootprints()}
    assert all(placements[ref] == expected_placements[ref] for ref in placements if ref not in requested_moves)
    assert source.read_bytes() == before
    board.BuildConnectivity()
    out.mkdir(parents=True, exist_ok=True)
    (out / 'routing-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    for p in source.parent.iterdir():
        if p.is_file() and (p.suffix in ['.kicad_pro', '.kicad_sch', '.kicad_sym', '.kicad_dru'] or
                            p.name in ['fp-lib-table', 'sym-lib-table']):
            shutil.copy2(p, out / p.name)
    for name in ['Fieldnote.pretty', 'fieldnote.pretty']:
        if (source.parent / name).exists():
            shutil.copytree(source.parent / name, out / name, dirs_exist_ok=True)
    target = out / 'fieldnote.kicad_pcb'
    k.SaveBoard(str(target), board)
    report = dict(status=('PARTIALLY_ROUTED_REQUIRES_COMPLETION' if failed else
                          'ROUTED_CANDIDATE_REQUIRES_NATIVE_DRC_AND_RF_VALIDATION'),
                  source_path=str(source), source_sha256=digest, candidate_path=str(target),
                  candidate_sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                  preserved_seed_copper_count=len(retained), source_copper_geometry_preserved=True,
                  seed_copper_exactly_preserved=not (seed_net_corrections or removed_added),
                  source_copper_preserved_except_listed_net_corrections=True,
                  seed_net_corrections=seed_net_corrections,
                  removed_added_copper=removed_added,
                  unaffected_footprint_placement_preserved=True,
                  moved_nfc_footprints={ref: {'before': placements[ref], 'after': expected_placements[ref]}
                                        for ref in requested_moves if placements[ref] != expected_placements[ref]},
                  final_nfc_placements={ref: {'xy': expected_placements[ref][0], 'angle': expected_placements[ref][1]}
                                        for ref in MOVABLE if ref in expected_placements},
                  added_copper_count=len(added),
                  touched_nets=sorted({r['net'] for r in routes} | {r['net'] for r in plan.get('vias', [])}),
                  new_copper_uuids=added, routes=routes,
                  new_copper_geometry={ident: now[ident] for ident in added},
                  widened_new_tracks=widening,
                  failed_connections=failed,
                  clearance_guard_mm=GUARD, through_via_diameter_mm=VIA_DIAMETER,
                  through_via_drill_mm=VIA_DRILL, layers_excluded_from_signal_routing=['In1.Cu'])
    (out / 'routing-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ['status', 'candidate_path', 'preserved_seed_copper_count',
                                                 'seed_copper_exactly_preserved', 'added_copper_count']}), flush=True)


if __name__ == '__main__':
    main()
