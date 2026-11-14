#!/usr/bin/env python3
"""v0.5.4 matching check with the antenna study's own nodal model (../nfc-antenna-study/scripts/matching.py, unchanged).

Fitted BOM (study section 7): C1 = C26/C27 120 pF, C2 = C28/C29 330 pF + C34/C35 15 pF, RQ = R22/R23 1.0 ohm.
Coil: 'before' = the study's FastHenry value (543.6 nH, 0.461 ohm, v0.5.2/v0.5.3 copper); 'after' = study value + the change
FastHenry computes between the v0.5.3 and v0.5.4 boards with the same plane model (strip-grid planes from the real copper, antenna_fasthenry.py).
Routed RF parasitics: the study's rf-routes.json (v0.5.4 extraction is identical; checked in run_v054.sh).
If the shift is material (|dL| >= 1 %, i.e. about 23 mA of ITVDD per the study), the stocked trim / C1 that restores the study's
operating point is searched; otherwise the BOM stays.
Usage: PYTHONPATH=tools/pylibs python3 antenna_matching.py output/antenna/fasthenry-*.json ...
"""
import json, math, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'nfc-antenna-study' / 'scripts'))
import matching as m          # noqa: E402

FIT = dict(C1=120e-12, C2=330e-12, Ctrim=15e-12, RQ=1.0)
STUDY = (543.6e-9, 0.461)


def point(L, R, extra=None):
    p = dict(FIT, Lcoil=L, Rcoil=R, **(extra or {}))
    s = m.solve(p); f = m.solve(dict(p, ro=0.65))
    hump = max(m.solve(dict(p, Lcoil=L * sc))['Itvdd'] for sc in np.arange(0.90, 1.041, 0.01))
    hump_fast = max(m.solve(dict(p, ro=0.65, Lcoil=L * sc))['Itvdd'] for sc in np.arange(0.90, 1.041, 0.01))
    tq = m.transfer_q(p)
    return {'L_nH': round(L * 1e9, 2), 'R_ohm': round(R, 4), 'Z_ohm': [round(s['Zvna'].real, 2), round(s['Zvna'].imag, 2)],
            'Itvdd_mA': round(s['Itvdd'] * 1e3, 1), 'Itvdd_fast_driver_mA': round(f['Itvdd'] * 1e3, 1),
            'Itvdd_bound_any_L_mA': round(hump * 1e3, 1), 'Itvdd_bound_any_L_fast_mA': round(hump_fast * 1e3, 1),
            'Icoil_mA_rms': round(s['Icoil_rms'] * 1e3, 1), 'Q_calc': round(s['Q_calc'], 2),
            'transfer_Q': round(tq['Q'], 2) if tq.get('Q') else None, 'peak_MHz': round(tq['peak_MHz'], 3)}


def main(files):
    rows = {r['case']: r for f in files for r in json.loads(Path(f).read_text())}
    for r in rows.values():
        assert r['R_ohm'] > 0.2 and 400 < r['L_nH'] < 700, ('FastHenry result not plausible', r)
    out = {'fasthenry': {k: {a: r[a] for a in ('L_nH', 'R_ohm', 'Q')} for k, r in rows.items()}}   # solver wall time left out: not reproducible
    base, new = rows['grid_board_v053'], rows['grid_board_v054']
    dl, dr = new['L_nH'] - base['L_nH'], new['R_ohm'] - base['R_ohm']
    out['delta_v053_to_v054'] = {'dL_nH': round(dl, 2), 'dL_pct': round(dl / base['L_nH'] * 100, 3), 'dR_ohm': round(dr, 4)}
    st, gr = rows.get('study_model_planes_y10.7'), rows.get('grid_rect_y10.7')
    if st and gr:
        out['grid_method_validation'] = {'study_planes_nH': st['L_nH'], 'same_geometry_as_strip_grid_nH': gr['L_nH'],
                                         'difference_pct': round((gr['L_nH'] - st['L_nH']) / st['L_nH'] * 100, 2)}
    if 'study_model_planes_y9.6' in rows and 'grid_rect_y9.6' in rows and st and gr:
        out['band_effect_pct'] = {'study_planes': round((rows['study_model_planes_y9.6']['L_nH'] / st['L_nH'] - 1) * 100, 3),
                                  'strip_grid': round((rows['grid_rect_y9.6']['L_nH'] / gr['L_nH'] - 1) * 100, 3)}
    out['board_vs_rect_model_on_v053_pct'] = round((base['L_nH'] / gr['L_nH'] - 1) * 100, 2) if gr else None
    L54 = STUDY[0] + dl * 1e-9; R54 = STUDY[1] + dr
    out['before'] = point(*STUDY)
    out['after'] = point(L54, R54)
    if 'study_model_planes_y9.6' in rows:
        b = rows['study_model_planes_y9.6']; out['cross_check_study_model_band'] = point(b['L_nH'] * 1e-9, b['R_ohm'])
    material = abs(out['delta_v053_to_v054']['dL_pct']) >= 1.0
    out['material_shift'] = material
    if material:
        target = m.solve(dict(FIT, Lcoil=STUDY[0], Rcoil=STUDY[1]))['Zvna']
        best = None
        for c1 in (110, 120, 150):
            for c2 in (270, 330, 390):
                for t in (0, 12, 13, 15, 24, 27, 30, 33, 36, 47):
                    z = m.solve(dict(C1=c1 * 1e-12, C2=c2 * 1e-12, Ctrim=t * 1e-12, RQ=1.0, Lcoil=L54, Rcoil=R54), harmonics=1)['Zvna']
                    cost = abs(z - target)
                    if best is None or cost < best[0]: best = (cost, c1, c2, t)
        out['corrected'] = {'C1_pF': best[1], 'C2_pF': best[2], 'trim_pF': best[3],
                            **point(L54, R54, dict(C1=best[1] * 1e-12, C2=best[2] * 1e-12, Ctrim=best[3] * 1e-12))}
    (HERE / 'output' / 'v054-antenna-revalidation.json').write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main(sys.argv[1:])
