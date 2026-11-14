#!/usr/bin/env python3
"""ngspice simulation of the v0.5.2 AC-coupled buzzer gate (fix 1) and the reset RC with the supervisor (fix 2).

Uses the libngspice that ships inside KiCad 10 (no ngspice CLI is installed on this machine):
    /usr/bin/python3 sim/run_sim.py
Writes sim/results.json, sim/*.csv and sim/*.svg.

Models are simple and written here, not vendor models (stated limits of the evidence):
  Q4 AO3401A  - level-1 PMOS, VTO swept over the datasheet window (-0.5 / -0.9 / -1.3 V) plus a hot corner
                (-0.35 V: |Vth| falls ~2 mV/K, so -0.5 V min at 25 C is ~-0.38 V at 85 C), KP 10 A/V^2
                (about 60-85 mOhm at Vgs -2.5 V), Cgs 650 pF, Cgd 150 pF.
  D7 RB520S-30 - Schottky, IS 0.3 uA (about 0.2 V at 1 mA, 0.45 V at 100 mA with RS). Variant: 1N4148.
  BZ1          - 12 ohm in series with 0.5 mH (inductance is an assumption, the KLJ-4020 sheet does not give it).
  GPIO8        - 0 / 3V3 pulse source behind 40 ohm, R14 10k to 3V3.
"""
from pathlib import Path
import ctypes, json, math, os, sys, tempfile

HERE = Path(__file__).resolve().parent
LIB = '/Applications/KiCad/KiCad.app/Contents/PlugIns/sim/libngspice.0.dylib'
ng = ctypes.CDLL(LIB)
LOG = []
PC = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_void_p)
EX = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.c_bool, ctypes.c_bool, ctypes.c_int, ctypes.c_void_p)
_pc = PC(lambda s, i, p: (LOG.append(s.decode(errors='replace')), 0)[1])
_ex = EX(lambda a, b, c, d, e: 0)
ng.ngSpice_Init(_pc, _pc, _ex, None, None, None, None)
ng.ngSpice_Command.argtypes = [ctypes.c_char_p]
TMP = Path(tempfile.mkdtemp(prefix='fieldnote_sim_'))      # ngspice commands cannot take paths with spaces


def cmd(s):
    ng.ngSpice_Command(s.encode())


MODELS = '''
.model PFET PMOS (LEVEL=1 VTO={vto} KP=10 LAMBDA=0.02 CGSO=0 CGDO=0)
.model DSCH D (IS=3e-7 N=1.05 RS=1.2 CJO=12p BV=30 IBV=1e-5)
.model D4148 D (IS=2.52e-9 N=1.752 RS=0.568 CJO=4p BV=100 IBV=1e-7 TT=6n)
'''
CIRCUIT = '''* Fieldnote v0.5.2 buzzer gate
{models}
V3   v33 0 {v33src}
R44  v33 vdd 4.7
C44  vdd 0 10u
Vg   gsrc 0 {gpio}
Rg   gsrc io8 {rgpio}
R14  io8 v33 10k
C45  io8 gate {c45}
R45  gate vdd {r45}
D7   gate vdd {dclamp}
M4   dq gate vdd vdd PFET W=1 L=1
Vq   dq bzp 0
Cgs  gate vdd 650p
Cgd  gate bzp 150p
Lbz  bzp n1 0.5m
Rbz  n1 0 12
D6   0 bzp D4148
.options reltol=1e-4 abstol=1e-10 vntol=1e-6
.tran {tstep} {tstop} 0 {tmax} uic
.end
'''


KEEP = {'stuck'}
R45 = '68k'   # v0.5.2 final value (first pass used 100k: 46.5 ms stuck-on in the hot corner, 24 mA off-phase leakage)


def run(name, cols, **kw):
    p = dict(vto=-0.9, v33src='3.3', rgpio=40, c45='100n', r45=R45, dclamp='DSCH', tstep='1u', tmax='1u')
    p.update(kw); p['models'] = MODELS.format(vto=p['vto'])
    text = CIRCUIT.format(**p)
    if name in KEEP: (HERE / (name + '.cir')).write_text(text)
    out = TMP / (name + '.txt')
    if out.exists(): out.unlink()
    lines = [l.encode() for l in text.splitlines()]
    arr = (ctypes.c_char_p * (len(lines) + 1))(*lines, None)
    cmd('destroy all'); ng.ngSpice_Circ(arr); cmd('run')
    cmd('set wr_singlescale'); cmd('set wr_vecnames')
    cmd(f'wrdata {out} ' + ' '.join(cols))
    if not out.exists(): print('\n'.join(LOG[-40:])); raise SystemExit('ngspice produced no data')
    rows = [list(map(float, l.split())) for l in out.read_text().splitlines()[1:] if l.strip()]
    out.unlink()
    return rows


def pwm(f, duty_low, cycles_from=0):
    per = 1 / f; low = per * duty_low
    # idle high, falling edge starts the on-time (active low)
    return f'PULSE(3.3 0 {cycles_from} 100n 100n {low - 100e-9:.9g} {per:.9g})'


def svg(path, title, series, xlabel='ms', xs=1e3, ylab='V'):
    W, H, L, T, R_, B = 900, 380, 60, 34, 16, 40
    xmin = min(x for _, pts, _ in series for x, _ in pts); xmax = max(x for _, pts, _ in series for x, _ in pts)
    ymin = min(y for _, pts, _ in series for _, y in pts); ymax = max(y for _, pts, _ in series for _, y in pts)
    ymin, ymax = math.floor(ymin * 2) / 2, math.ceil(ymax * 2) / 2
    X = lambda x: L + (x - xmin) / (xmax - xmin) * (W - L - R_); Y = lambda y: T + (ymax - y) / (ymax - ymin) * (H - T - B)
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" font-family="Helvetica,Arial" font-size="12">',
         f'<rect width="{W}" height="{H}" fill="white"/><text x="{L}" y="18" font-size="14">{title}</text>']
    n = int(round((ymax - ymin) / .5))
    for i in range(n + 1):
        y = ymin + i * .5
        s.append(f'<line x1="{L}" x2="{W - R_}" y1="{Y(y):.1f}" y2="{Y(y):.1f}" stroke="#ddd"/><text x="{L - 6}" y="{Y(y) + 4:.1f}" text-anchor="end">{y:g}</text>')
    for i in range(11):
        x = xmin + (xmax - xmin) * i / 10
        s.append(f'<line x1="{X(x):.1f}" x2="{X(x):.1f}" y1="{T}" y2="{H - B}" stroke="#eee"/><text x="{X(x):.1f}" y="{H - B + 16}" text-anchor="middle">{x * xs:.3g}</text>')
    s.append(f'<text x="{(L + W) / 2}" y="{H - 6}" text-anchor="middle">time ({xlabel})</text><text x="14" y="{T - 8}">{ylab}</text>')
    for i, (label, pts, color) in enumerate(series):
        step = max(1, len(pts) // 4000)
        d = ' '.join(f'{X(x):.1f},{Y(y):.2f}' for x, y in pts[::step])
        s.append(f'<polyline fill="none" stroke="{color}" stroke-width="1.3" points="{d}"/>')
        s.append(f'<rect x="{L + 10 + i * 190}" y="{T + 6}" width="14" height="3" fill="{color}"/><text x="{L + 30 + i * 190}" y="{T + 12}">{label}</text>')
    s.append('</svg>'); Path(path).write_text('\n'.join(s))


res = {'models': 'level-1 PMOS / generic diodes written in run_sim.py; buzzer 12 ohm + 0.5 mH (inductance assumed)', 'pwm': [], 'stuck_low': [], 'power_up': {}}
COLS = ['v(gate,vdd)', 'v(io8)', 'lbz#branch', 'v(vdd,bzp)', 'v(vdd)', 'vq#branch']

# ---- 1. PWM steady state: Vgs during the on-time and the off-time ----
for dclamp in ('DSCH', 'D4148'):
    for vto in ((-0.5, -0.9, -1.3) if dclamp == 'DSCH' else (-0.9, -1.3)):
        for f in (2000, 4000, 5000):
            for duty in (.1, .5, .9):
                per = 1 / f; n = 40
                rows = run('pwm', COLS, gpio=pwm(f, duty), tstop=f'{n * per:.9g}', vto=vto, dclamp=dclamp, tstep='0.5u', tmax='0.5u')
                t0 = (n - 1) * per; low = per * duty
                on = [x for x in rows if t0 + 2e-6 <= x[0] <= t0 + low - 2e-6]; off = [x for x in rows if t0 + low + 5e-6 <= x[0] <= t0 + per - 1e-6]
                last = [x for x in rows if x[0] >= t0]
                res['pwm'].append({'clamp': 'RB520S-30' if dclamp == 'DSCH' else '1N4148', 'vto': vto, 'f_hz': f, 'duty_low': duty,
                                   'vgs_on_weakest_v': round(max(x[1] for x in on), 3), 'vgs_on_start_v': round(min(x[1] for x in on), 3),
                                   'vgs_off_v': round(sum(x[1] for x in off) / len(off), 3),
                                   'i_fet_off_phase_mean_ma': round(sum(x[6] for x in off) / len(off) * 1e3, 3),
                                   'vds_on_end_mv': round(on[-1][4] * 1e3, 1), 'i_coil_peak_ma': round(max(x[3] for x in last) * 1e3, 1),
                                   'i_coil_mean_ma': round(sum(x[3] for x in last) / len(last) * 1e3, 1)})
                if dclamp == 'DSCH' and vto == -0.9 and f == 4000 and duty == .5:
                    w = [x for x in rows if x[0] >= (n - 4) * per]
                    svg(HERE / 'pwm_4khz_50pct.svg', 'PWM 4 kHz, 50 % low: Vgs of Q4 (blue), GPIO8 (grey), coil current x10 A (red)',
                        [('Vgs (V)', [(x[0] - w[0][0], x[1]) for x in w], '#1f6fd0'), ('GPIO8 (V)', [(x[0] - w[0][0], x[2]) for x in w], '#999'),
                         ('I coil x10 (A)', [(x[0] - w[0][0], x[3] * 10) for x in w], '#d03a1f')])

# ---- 2. stuck low: 20 ms of 4 kHz 50 %, then GPIO8 stays at 0 V ----
for label, kw in (('typ (Vth -0.9 V, 100nF, 68k)', dict(vto=-0.9)),
                  ('slowest turn-off (Vth -0.5 V, C45 +10 %, R45 +1 %)', dict(vto=-0.5, c45='110n', r45='68.68k')),
                  ('max-threshold FET (Vth -1.3 V, C45 -10 %)', dict(vto=-1.3, c45='90n')),
                  ('hot low-threshold FET (Vth -0.35 V ~ -0.5 V at 85 C, C45 +20 %, R45 +1 %)', dict(vto=-0.35, c45='120n', r45='68.68k')),
                  ('1N4148 clamp, slowest turn-off', dict(vto=-0.5, c45='110n', r45='68.68k', dclamp='D4148'))):
    T0 = 20e-3
    g_ = f'PWL(0 3.3 ' + ' '.join(f'{i * 250e-6 + 1e-7:.9g} 0 {i * 250e-6 + 125e-6:.9g} 0 {i * 250e-6 + 125e-6 + 1e-7:.9g} 3.3 {(i + 1) * 250e-6:.9g} 3.3' for i in range(80)) + f' {T0 + 1e-7:.9g} 0 1 0)'
    rows = run('stuck', COLS, gpio=g_, tstop='120m', tstep='5u', tmax='5u', **kw)
    after = [x for x in rows if x[0] >= T0]
    t_1ma = next((x[0] - T0 for i, x in enumerate(after) if all(y[3] < 1e-3 for y in after[i:i + 200]) and x[3] < 1e-3), None)
    t_10ma = next((x[0] - T0 for i, x in enumerate(after) if x[3] < 10e-3 and all(y[3] < 10e-3 for y in after[i:i + 200])), None)
    charge = sum((b_[0] - a_[0]) * (a_[3] + b_[3]) / 2 for a_, b_ in zip(after, after[1:]))
    energy = sum((b_[0] - a_[0]) * (a_[3] * a_[4] + b_[3] * b_[4]) / 2 for a_, b_ in zip(after, after[1:]))
    res['stuck_low'].append({'case': label, 'coil_below_10ma_after_ms': round(t_10ma * 1e3, 2), 'coil_below_1ma_after_ms': round(t_1ma * 1e3, 2),
                             'i_coil_peak_ma': round(max(x[3] for x in after) * 1e3, 1), 'coil_charge_mC': round(charge * 1e3, 3),
                             'q4_energy_mJ': round(energy * 1e3, 3), 'vgs_at_50ms_v': round(min(after, key=lambda x: abs(x[0] - T0 - 50e-3))[1], 4),
                             'i_coil_at_50ms_ua': round(min(after, key=lambda x: abs(x[0] - T0 - 50e-3))[3] * 1e6, 3)})
    if label.startswith('slowest'):
        w = [x for x in rows if 18e-3 <= x[0] <= 80e-3]
        svg(HERE / 'stuck_low.svg', 'GPIO8 stuck low at t = 20 ms (slowest corner): Vgs (blue), GPIO8 (grey), coil current x10 A (red)',
            [('Vgs (V)', [(x[0], x[1]) for x in w], '#1f6fd0'), ('GPIO8 (V)', [(x[0], x[2]) for x in w], '#999'), ('I coil x10 (A)', [(x[0], x[3] * 10) for x in w], '#d03a1f')])
        (HERE / 'stuck_low.csv').write_text('t_s,vgs_v,gpio8_v,i_coil_a,vds_on_v,bzr_vdd_v\n' + '\n'.join(','.join(f'{v:.6g}' for v in x) for x in w[::4]) + '\n')

# ---- 3. power-up and power-down with GPIO8 high-Z (only R14): Q4 must stay off ----
for label, src in (('power_up_1ms', 'PWL(0 0 1m 3.3 20m 3.3)'), ('power_down_1ms', 'PWL(0 3.3 5m 3.3 6m 0 20m 0)'), ('power_up_50us', 'PWL(0 0 50u 3.3 20m 3.3)')):
    rows = run('ramp', COLS, gpio='0', rgpio='1e9', v33src=src, tstop='20m', tstep='2u', tmax='2u')
    res['power_up'][label] = {'vgs_most_negative_v': round(min(x[1] for x in rows), 4), 'i_coil_peak_ua': round(max(abs(x[3]) for x in rows) * 1e6, 2)}

# ---- 4. reset RC with the supervisor (analytic; plain RC) ----
R12, C9, R46 = 47e3, 1e-6, 1e3
res['reset'] = {
    'low_level_with_u12_asserted_mv': round(3.3 * R46 / (R12 + R46) * 1e3, 1),
    'c9_discharge_tau_ms': R46 * C9 * 1e3, 'u12_peak_sink_ma': round(3.3 / R46 * 1e3, 2),
    'c9_below_0v8_after_ms': round(-R46 * C9 * math.log((0.8 - 0.069) / (3.3 - 0.069)) * 1e3, 2),
    'rc_delay_to_vt_plus_ms': {f'{vt} V': round(-R12 * C9 * math.log(1 - vt / 3.3) * 1e3, 1) for vt in (1.3, 1.6, 2.0)},
    'note': 'After U12 releases (200 ms typ after 3V3 > 2.93 V) C9 charges from 0 V through R12; U8 Schmitt VT+ window taken as 1.3-2.0 V at 3.3 V.'}
(HERE / 'results.json').write_text(json.dumps(res, indent=2) + '\n')
worst = max((x for x in res['pwm'] if x['clamp'] == 'RB520S-30'), key=lambda x: x['vgs_on_weakest_v'])
print(json.dumps({'pwm_runs': len(res['pwm']), 'weakest_vgs_on_v': worst['vgs_on_weakest_v'], 'stuck_low_worst_ms': max(s['coil_below_1ma_after_ms'] for s in res['stuck_low'])}))
