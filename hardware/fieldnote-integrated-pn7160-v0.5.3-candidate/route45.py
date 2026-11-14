"""45-degree router for the v0.5.3 candidate.

Grid A* (8 directions) over F.Cu / B.Cu / In2.Cu with turn and via costs, using the repo collision model
(route_pn7160.collision_test: pads, tracks, vias, rule-area keepouts, ANT1 copper, drill spacing). The grid path is
then rebuilt octilinearly: every leg is greedily replaced by the fewest straight / 45-degree segments that stay clear
(a direct run, or a two-segment dogleg). Nothing here touches existing copper; callers add the returned geometry.
"""
import heapq, math
import pcbnew as k
import route_pn7160 as r

DIRS = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]


def octi(a, c, eps=1e-6):
    dx, dy = c[0] - a[0], c[1] - a[1]
    return abs(dx) < eps or abs(dy) < eps or abs(abs(dx) - abs(dy)) < eps


def doglegs(a, c):
    """The two octilinear two-segment connections a -> m -> c (diagonal first, straight first)."""
    dx, dy = c[0] - a[0], c[1] - a[1]
    d = min(abs(dx), abs(dy)); sx = math.copysign(1, dx); sy = math.copysign(1, dy)
    m1 = [round(a[0] + sx * d, 6), round(a[1] + sy * d, 6)]          # diagonal first
    m2 = [round(c[0] - sx * d, 6), round(c[1] - sy * d, 6)]          # straight first
    return [m1, m2]


def rebuild(points, clear):
    """Greedy octilinear rebuild of one leg (points[0] and points[-1] are fixed)."""
    pts = [list(p) for p in points]
    out, i, n = [pts[0]], 0, len(pts) - 1
    while i < n:
        done = False
        for j in range(n, i, -1):
            a, c = pts[i], pts[j]
            if math.dist(a, c) < 1e-9:
                i = j; done = True; break
            if octi(a, c) and clear(a, c):
                out.append(c); i = j; done = True; break
            for m in doglegs(a, c):
                if math.dist(m, a) > 1e-6 and math.dist(m, c) > 1e-6 and clear(a, m) and clear(m, c):
                    out += [m, c]; i = j; done = True; break
            if done:
                break
        if not done:                                   # cannot happen for grid moves; keep the raw step
            out.append(pts[i + 1]); i += 1
    # merge collinear runs
    res = [out[0]]
    for p in out[1:]:
        if math.dist(p, res[-1]) < 1e-9:
            continue
        if len(res) >= 2:
            a, b_ = res[-2], res[-1]
            if abs((b_[0] - a[0]) * (p[1] - b_[1]) - (b_[1] - a[1]) * (p[0] - b_[0])) < 1e-9 and \
               (b_[0] - a[0]) * (p[0] - b_[0]) + (b_[1] - a[1]) * (p[1] - b_[1]) > 0:
                res[-1] = p; continue
        res.append(p)
    return res


def route(board, net, start, goals, width, layers, bounds, max_vias=2, step=.05, turn=.35, via_cost=2.0,
          layer_cost=None, via_ok=None, max_states=2_000_000, via_size=(.5, .2), goal_reach=.3, avoid=()):
    """start: (xy, [layers]); goals: list of (xy, [layers]). Returns (legs, vias, length) or raises RuntimeError.
    legs = [[layer, [pts...]], ...]; vias = [xy, ...] (via_size)."""
    layer_cost = layer_cost or {}
    base0 = {L: r.collision_test(board, net, width, L) for L in layers}
    # drilled holes (PTH and NPTH): hole clearance 0.25 mm on every layer (NPTH pegs have no copper on inner layers)
    holes = [(r.xy(p.GetPosition()), k.ToMM(min(p.GetDrillSize().x, p.GetDrillSize().y)) / 2)
             for f in board.GetFootprints() for p in f.Pads() if p.GetDrillSize().x > 0 and not (net and p.GetNetname() == net)]

    def hole_ok(a, c, rad):
        return all(r.segment_distance(a, c, h, h) >= hr + .26 + rad for h, hr in holes
                   if not (max(a[0], c[0]) + hr + 1 < h[0] or min(a[0], c[0]) - hr - 1 > h[0] or max(a[1], c[1]) + hr + 1 < h[1] or min(a[1], c[1]) - hr - 1 > h[1]))
    base = {L: (lambda fn: (lambda a, c: hole_ok(a, c, width / 2) and fn(a, c)))(base0[L]) for L in layers}
    inside = lambda p: any(x0 <= p[0] <= x1 and y0 <= p[1] <= y1 for x0, y0, x1, y1 in avoid)

    def mk(fn):
        def ok(a, c):
            if avoid:
                m = max(1, int(math.dist(a, c) / .2))
                if any(inside((a[0] + (c[0] - a[0]) * i / m, a[1] + (c[1] - a[1]) * i / m)) for i in range(m + 1)):
                    return False
            return fn(a, c)
        return ok
    clear = {L: mk(base[L]) for L in layers}
    vclear = [r.collision_test(board, net, via_size[0], L, True) for L in r.ALL_COPPER]
    sxy, sl = start
    P = lambda i, j: (round(sxy[0] + i * step, 6), round(sxy[1] + j * step, 6))
    gl = [(tuple(g[0]), frozenset(g[1])) for g in goals]
    cell = {}
    for gi, (g, _) in enumerate(gl):
        cell.setdefault((math.floor(g[0]), math.floor(g[1])), []).append(gi)
    hcache = {}

    def h(p):
        key = (math.floor(p[0] * 4), math.floor(p[1] * 4))         # 0.25 mm buckets, admissible (-0.36)
        if key not in hcache:
            cx, cy = math.floor(p[0]), math.floor(p[1]); best_ = 1e9
            for rad in range(0, 80):
                for ix in range(cx - rad, cx + rad + 1):
                    for iy in (range(cy - rad, cy + rad + 1) if ix in (cx - rad, cx + rad) else (cy - rad, cy + rad)):
                        for gi in cell.get((ix, iy), ()):
                            best_ = min(best_, math.dist(p, gl[gi][0]))
                if best_ < rad - 1:
                    break
            hcache[key] = max(0., best_ - .36)
        return hcache[key]

    def near_goals(p):
        cx, cy = math.floor(p[0]), math.floor(p[1])
        for ix in (cx - 1, cx, cx + 1):
            for iy in (cy - 1, cy, cy + 1):
                for gi in cell.get((ix, iy), ()):
                    yield gl[gi]
    pq, best, prev = [], {}, {}
    for li, L in enumerate(layers):
        if L in sl:
            s = (li, 0, 0, -1, 0); best[s] = 0.; heapq.heappush(pq, (h(sxy), 0., s))
    ecache, vcache, goal, visited = {}, {}, None, 0
    while pq and visited < max_states:
        f, cst, u = heapq.heappop(pq)
        if cst > best.get(u, 1e99) + 1e-9:
            continue
        visited += 1
        li, i, j, d, nv = u; a = P(i, j); L = layers[li]
        for g, glay in near_goals(a):
            if L in glay and math.dist(a, g) <= goal_reach and clear[L](a, g):
                goal = (u, g); break
        if goal:
            break
        for di, (dx, dy) in enumerate(DIRS):
            if d >= 0:
                t = min((di - d) % 8, (d - di) % 8)
                if t > 2:
                    continue
                tc = 0 if t == 0 else (turn if t == 1 else 2.5 * turn)
            else:
                tc = 0
            ii, jj = i + dx, j + dy; c = P(ii, jj)
            if not (bounds[0] <= c[0] <= bounds[2] and bounds[1] <= c[1] <= bounds[3]):
                continue
            key = (li, min((i, j), (ii, jj)), max((i, j), (ii, jj)))
            if key not in ecache:
                ecache[key] = clear[L](a, c)
            if not ecache[key]:
                continue
            v = (li, ii, jj, di, nv); nc = cst + math.hypot(dx, dy) * step * layer_cost.get(L, 1.) + tc
            if nc < best.get(v, 1e99):
                best[v] = nc; prev[v] = u; heapq.heappush(pq, (nc + h(c), nc, v))
        if nv < max_vias:
            if (i, j) not in vcache:
                vcache[(i, j)] = (via_ok is None or via_ok(a)) and hole_ok(a, a, via_size[0] / 2) and all(fn(a, a) for fn in vclear)
            if vcache[(i, j)]:
                for lj in range(len(layers)):
                    if lj == li:
                        continue
                    v = (lj, i, j, -1, nv + 1); nc = cst + via_cost
                    if nc < best.get(v, 1e99):
                        best[v] = nc; prev[v] = u; heapq.heappush(pq, (nc + h(a), nc, v))
    if goal is None:
        raise RuntimeError(('NO_PATH', net, sxy, visited))
    u, g = goal
    states = [u]
    while states[-1] in prev:
        states.append(prev[states[-1]])
    states.reverse()
    legs, vias = [], []
    cur, pts = layers[states[0][0]], [list(sxy)]
    for s in states[1:]:
        p = list(P(s[1], s[2]))
        if layers[s[0]] != cur:
            legs.append([cur, pts]); vias.append(p); cur, pts = layers[s[0]], [p]
        else:
            pts.append(p)
    pts.append(list(g)); legs.append([cur, pts])
    legs = [[L, rebuild(q, clear[L])] for L, q in legs]
    for L, q in legs:                                       # end segments may start inside an avoid box (pad there)
        assert all(base[L](a, c) for a, c in zip(q, q[1:])), ('REBUILD_COLLISION', net, L)
    length = sum(math.dist(a, c) for _, q in legs for a, c in zip(q, q[1:]))
    return legs, vias, round(length, 3)
