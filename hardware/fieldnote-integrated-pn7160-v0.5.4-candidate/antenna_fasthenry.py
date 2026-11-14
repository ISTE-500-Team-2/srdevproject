#!/usr/bin/env python3
"""FastHenry coil extraction for v0.5.4 (antenna-study method, final_fine_4planes settings: 13.56 MHz, coil mesh 11 x 3,
plane pitch 0.375 mm, coil + feed leads from ../nfc-antenna-study/scripts/coil_fasthenry.py with the unchanged RF geometry).

Cases:
  study            the study's own rectangle 'g' planes (F/In1/In2/B, fills stop at x 33.1 / y 10.7): reproduces 543.6 nH.
  band             the same model with the top plane edge at y 9.6 (the v0.5.4 no-copper band, 2.0 mm from the outer turn).
  gridrect:<y>     the study rectangle geometry with top edge <y>, but each plane written as an explicit grid of 0.375 mm
                   strips between adjacent nodes (what FastHenry builds internally for a plane, without its hole logic).
                   Validates the grid method against 'study' / 'band'.
  grid:<name>=<mask.json>   the real board copper of every layer (rf_planes_raster.py: all non-RF copper incl. the LED-bar
                   copper, sampled at the plane nodes) as the same strip grid. Every copper island is a floating conductor.
                   The study's two conventions are kept: nothing inside the NFC region (x < 33.1, y > 10.7; no copper there
                   anyway) and the F/B pour fragments in the feed / matching area treated as holes.
FastHenry's own plane holes cannot represent real pour shapes (islands inside holes, 1-node necks: 'multiple boundaries
found around one hole region', preconditioner failure), hence the strip grid.
Usage: PYTHONPATH=tools/pylibs python3 antenna_fasthenry.py OUTDIR case [case ...]
"""
import json, os, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'nfc-antenna-study' / 'scripts'))
os.environ.setdefault('FASTHENRY_EXE', str(HERE / 'tools' / 'fasthenry' / 'fasthenry'))
import coil_fasthenry as cf          # noqa: E402
cf.EXE = os.environ['FASTHENRY_EXE']

H, X0, Y0, N = 0.375, 0.1, 0.2, 120
EPS = 0.05
LAYS = ('F', 'In1', 'In2', 'B')


def plane_rect(lay, edge_x=33.1, edge_y=10.7):
    """Study rectangle model (coil_fasthenry.build plane block), edges as parameters."""
    x1, y1 = X0 + N * H, Y0 + N * H; z = cf.Z[lay]
    holes = [(X0 - 1, edge_y + EPS, edge_x - EPS, y1 + 1), (edge_x - EPS, 38.7 + EPS, x1 + 1, y1 + 1)]
    if lay in ('F', 'B'):
        holes.append((edge_x - EPS, 21.25, 39.25, 33.25))
    out = [f'g{lay} x1={X0} y1={Y0} z1={z} x2={x1} y2={Y0} z2={z} x3={x1} y3={y1} z3={z}',
           f'+ thick={cf.T[lay]} seg1={N} seg2={N} nhinc=1']
    for ax, ay, bx, by in holes:
        ax, bx = max(ax, X0 + 1e-3), min(bx, x1 - 1e-3); ay, by = max(ay, Y0 + 1e-3), min(by, y1 - 1e-3)
        out.append(f'+ hole rect ({ax:.4f},{ay:.4f},{z},{bx:.4f},{by:.4f},{z})')
    return out


def node_xy(i, j): return X0 + i * H, Y0 + j * H


def mask_rect(lay, edge_y):
    """Node mask equal to the study rectangle geometry (same holes as plane_rect)."""
    m = [[True] * (N + 1) for _ in range(N + 1)]
    for j in range(N + 1):
        for i in range(N + 1):
            x, y = node_xy(i, j)
            if (x < 33.1 - EPS and y > edge_y + EPS) or (x > 33.1 - EPS and y > 38.7 + EPS) or \
               (lay in ('F', 'B') and 33.1 - EPS <= x <= 39.25 and 21.25 <= y <= 33.25):
                m[j][i] = False
    return m


def mask_board(lay, rows):
    m = [[c == '1' for c in row] for row in rows]
    for j in range(N + 1):
        for i in range(N + 1):
            x, y = node_xy(i, j)
            if (x < 33.1 - EPS and y > 10.7 + EPS) or (lay in ('F', 'B') and 33.1 - EPS <= x <= 39.25 and 21.25 <= y <= 33.25):
                m[j][i] = False
    return m


def plane_grid(lay, m):
    """Explicit strip grid: a node per copper sample, a segment (width H, layer thickness) between 4-adjacent copper nodes."""
    tag = 'ABCD'[LAYS.index(lay)]; z = cf.Z[lay]; t = cf.T[lay]
    name = lambda i, j: f'N{tag}{j:03d}{i:03d}'
    used = set(); segs = []
    for j in range(N + 1):
        for i in range(N + 1):
            if not m[j][i]: continue
            if i < N and m[j][i + 1]: segs.append(((i, j), (i + 1, j), 'x'))
            if j < N and m[j + 1][i]: segs.append(((i, j), (i, j + 1), 'y'))
    for a, b, _ in segs: used.add(a); used.add(b)
    out = [f'{name(i, j)} x={node_xy(i, j)[0]:.4f} y={node_xy(i, j)[1]:.4f} z={z}' for i, j in sorted(used, key=lambda p: (p[1], p[0]))]
    for k_, (a, b, d) in enumerate(segs):
        wv = 'wx=0 wy=1 wz=0' if d == 'x' else 'wx=1 wy=0 wz=0'
        out.append(f'E{tag}{k_} {name(*a)} {name(*b)} w={H} h={t} nwinc=1 nhinc=1 {wv}')
    return out, {'nodes': len(used), 'segments': len(segs)}


def deck(planes):
    base = cf.build(leads=True, planes=(), h_plane=H, plane_xmax=X0 + N * H, nw_coil=11, nh_coil=3)
    lines = base.splitlines()
    i = next(n for n, l in enumerate(lines) if l.startswith('.external'))
    lines[0] = '* Fieldnote v0.5.4 ANT1 + feeds + board copper (antenna_fasthenry.py on the study coil_fasthenry.py model)'
    return '\n'.join(lines[:i] + planes + lines[i:]) + '\n'


def main(outdir, cases):
    rows = []
    for case in cases:
        meta = {}
        if case in ('study', 'band'):
            ey = 10.7 if case == 'study' else 9.6
            pl = [l for lay in LAYS for l in plane_rect(lay, edge_y=ey)]
            name = f'study_model_planes_y{ey}'
        elif case.startswith('gridrect:'):
            ey = float(case.split(':')[1]); pl = []
            for lay in LAYS:
                block, meta[lay] = plane_grid(lay, mask_rect(lay, ey)); pl += block
            name = f'grid_rect_y{ey}'
        else:
            name, path = case.split(':', 1)[1].split('=', 1)
            mask = json.loads(Path(path).read_text()); pl = []
            for lay in LAYS:
                block, meta[lay] = plane_grid(lay, mask_board(lay, mask['layers'][lay])); pl += block
            name = 'grid_board_' + name
        res = cf.run(name, deck(pl), outdir)
        log = (Path(outdir) / name / 'solver.log').read_text()
        assert 'Error on' not in log and 'Warning' not in log, (name, 'FastHenry reported a problem')
        assert 0.2 < res['R_ohm'] < 2 and 400 < res['L_nH'] < 700, (name, 'implausible', res)
        res['grid'] = meta
        rows.append(res)
    Path(outdir, 'fasthenry-' + '-'.join(r['case'] for r in rows) + '.json').write_text(json.dumps(rows, indent=1))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2:])
