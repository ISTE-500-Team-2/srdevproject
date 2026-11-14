#!/usr/bin/env python3
"""v0.5.3 candidate: v0.5.2 with the remaining hardware defects fixed and a cleaned-up, black-mask layout.

Source: source-v052/ (frozen v0.5.2 board 78e671b3..., design-data 539c7a3e...). This script edits only the netlist and the
part data (design-data.json) and regenerates the schematic sheets; the PCB work is in apply_v053_pcb.py.

Netlist / part changes:
  1. D8 (CC1) and D9 (CC2) TPD1E05U06DPYR (TI, X1SON-2 / DPY0002A 1.0 x 0.6 mm, LCSC C436349): single-line ESD diodes at J1,
     pin 1 I/O, pin 2 GND, each GND pad on its own via to the In1 plane. VRWM 5.5 V, 0.42 pF typ, clamp 10 V @ 1 A TLP (SLVSBO7O).
     The TUSB320LAI datasheet (SLLSEQ8D) gives no CC capacitance limit; the USB PD cReceiver 200-600 pF window applies to PD
     ports only. A 2-line SOT-23 (TPD2E2U06) was the first choice but no legal SOT-23 site exists within 6 mm of J1
     (J1 / U5 / U6 / D4 / U7 courtyards); the 0402-size DPY parts fit in the 1.9 mm column between J4 and J1.
     The footprint TI_DPY0002A is generated here from the TI land pattern (pads 0.3 x 0.5 mm, 0.7 mm pitch).
  2. R47 10k 1% 0402 (UNI-ROYAL 0402WGF1002TCE, C25744, basic): IO_INT (ESP32-C3 GPIO0) pull-up to 3V3, so the shared
     open-drain interrupt does not float without the daughterboard. GPIO0 is not a strapping pin on the ESP32-C3 (straps are
     GPIO2, GPIO8, GPIO9; datasheet v2.5 section 3 / Table 2-7); it has no internal pull at or after reset (Table 2-1).
  3. RGB LED current: R38 (red) 150R -> 180R, R39/R40 (green/blue) 100R -> 120R, so the worst case (min Vf, VSYS 4.5 V,
     -1 % resistor, FET drop ignored) stays at or below the 45 C derating point of 16.9 mA (datasheet page 6).
  4. NFC matching network (owner-approved, from hardware/nfc-antenna-study/README.md section 7): values / MPNs on the existing
     pads only, no RF placement or copper change. C24/C25 330 pF 1 % (C519562), C26/C27 120 pF 1 % (C519498), C28/C29 330 pF 1 %
     (C519562), C34/C35 FITTED 15 pF 1 % (C519483), R22/R23 1.0 R 1 % 0.5 W Vishay CRCW08051R00FKEAHP (C313850), L1/L2 160 nH
     Murata LQW18CNR16J00D (C437367). Study result: Z(TX1-TX2) 11.1 - j0.3 ohm, ITVDD 207 mA nominal, <= ~233-241 mA bounded.
  5. C22/C23: KEMET CBR06C130F5GAC (68 in stock) -> YAGEO CC0603FRNPO9BN130 (C519488), 13 pF NP0 +-1 % 50 V 0603.
"""
from pathlib import Path
import hashlib, json
import build_design as g

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'source-v052' / 'design-data.json'
V052_DESIGN = '539c7a3ed9b399aff0948dbdbbd472a8e4055634979d682febecb4c2be15bcca'

# LED derating (XL-1615RGBC-RF datasheet p.6: 20 mA to ~27 C, linear to 10 mA at 85 C; p.4: Vf min R 1.8 V, G/B 2.6 V @ 20 mA)
T_CASE = 45.0
I_LIMIT = 20 - 10 * (T_CASE - 27) / (85 - 27)
VSYS_MAX, VSYS_TYP = 4.5, 4.4
VF = {'R': (1.8, 2.1), 'G': (2.6, 3.0), 'B': (2.6, 3.0)}      # (min, mid of min/max) at 20 mA
E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1]


DPY = """(footprint "TI_DPY0002A"
	(version 20260206)
	(generator "fieldnote-prepare_v053")
	(layer "F.Cu")
	(descr "TI DPY0002A X1SON-2 1.0 x 0.6 mm, 0.65 mm terminal pitch; land pattern per TI 4224561/C (pads 0.3 x 0.5, 0.7 mm pitch). Pin 1 I/O, pin 2 GND.")
	(tags "X1SON DPY TPD1E05U06")
	(property "Reference" "REF**" (at 0 -1 0) (layer "F.SilkS") (effects (font (size 0.8 0.8) (thickness 0.12))))
	(property "Value" "TI_DPY0002A" (at 0 1 0) (layer "F.Fab") (effects (font (size 0.5 0.5) (thickness 0.08))))
	(attr smd)
	(duplicate_pad_numbers_are_jumpers no)
	(fp_line (start -0.78 -0.3) (end -0.78 0.3) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
	(fp_rect (start -0.68 -0.43) (end 0.68 0.43) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))
	(fp_rect (start -0.5 -0.3) (end 0.5 0.3) (stroke (width 0.1) (type solid)) (fill no) (layer "F.Fab"))
	(fp_line (start -0.35 -0.3) (end -0.35 0.3) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
	(pad "1" smd roundrect (at -0.35 0) (size 0.3 0.5) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.166667))
	(pad "2" smd roundrect (at 0.35 0) (size 0.3 0.5) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.166667))
	(embedded_fonts no)
)
"""


def led_resistors():
    out = {}
    for ch, (vmin, vtyp) in VF.items():
        need = (VSYS_MAX - vmin) / (I_LIMIT / 1000) / 0.99            # -1 % resistor tolerance
        r = min(round(m * 10 ** e, 1) for e in (1, 2, 3) for m in E24 if m * 10 ** e >= need)
        out[ch] = {'R_min_ohm': round(need, 1), 'R_E24': r, 'I_worst_mA': round((VSYS_MAX - vmin) / (r * .99) * 1000, 2),
                   'I_typ_mA': round((VSYS_TYP - vtyp) / r * 1000, 1)}
    return out


def main():
    assert hashlib.sha256(SRC.read_bytes()).hexdigest() == V052_DESIGN
    d = json.loads(SRC.read_text()); P = {p['ref']: p for p in d['parts']}
    log = {'source_design_sha256': V052_DESIGN, 'added': [], 'changed': []}

    def add(ref, value, fp, nets, mpn, group, note='', names=None, pin_types=None):
        assert ref not in P, ref
        p = dict(ref=ref, value=value, fp=fp, nets={str(k): v for k, v in nets.items()}, xy=[0, 0], angle=0, group=group,
                 mpn=mpn, note=note, dnp=False, side='F', names={str(k): v for k, v in (names or {k: str(k) for k in nets}).items()})
        if pin_types: p['pin_types'] = {str(k): v for k, v in pin_types.items()}
        d['parts'].append(p); P[ref] = p; log['added'].append(ref)

    def change(ref, **kw):
        for k_, v in kw.items():
            log['changed'].append([ref, k_, P[ref].get(k_), v]); P[ref][k_] = v

    # ---- 1. CC ESD ----
    assert P['U6']['nets']['1'] == 'CC1' and P['U6']['nets']['2'] == 'CC2'
    for ref, net in (('D8', 'CC1'), ('D9', 'CC2')):
        add(ref, 'TPD1E05U06', 'TI_DPY0002A', {1: net, 2: 'GND'}, 'TPD1E05U06DPYR', 'USB',
            f'LCSC C436349 (genuine TI; same-name clones exist - do not substitute). USB-C {net} ESD at J1: VRWM 5.5 V, 0.42 pF typ, '
            'clamp 10 V @ 1 A TLP, IEC 61000-4-2 +-12 kV contact. GND pad on its own via to the In1 plane.', {1: 'IO', 2: 'GND'})
    P['U6']['note'] += ' v0.5.3: CC1/CC2 protected by D8/D9 at J1.'

    # ---- 2. IO_INT pull-up ----
    add('R47', '10k 1%', 'R_0402', {1: 'IO_INT', 2: '3V3'}, '0402WGF1002TCE', 'MCU',
        'LCSC C25744 (basic). IO_INT (GPIO0) pull-up: the shared open-drain interrupt no longer floats without the daughterboard. '
        'Parallel with the daughterboard pull-up is intended. GPIO0 is not an ESP32-C3 strapping pin. Do not fit if GPIO0 ever '
        'carries a 32 kHz crystal.')

    # ---- 3. LED current ----
    led = led_resistors(); log['led'] = {'T_case_C': T_CASE, 'I_limit_mA': round(I_LIMIT, 2), 'VSYS_max': VSYS_MAX, 'channels': led}
    assert led['R']['R_E24'] == 180 and led['G']['R_E24'] == 120 and led['B']['R_E24'] == 120, led
    change('R38', value='180R 1%', mpn='RC0603FR-07180RL',
           note=f'v0.5.3: RGB R current {led["R"]["I_worst_mA"]} mA worst case (Vf 1.8 V min, VSYS 4.5 V, -1 %), {led["R"]["I_typ_mA"]} mA typ; '
                f'limit {I_LIMIT:.1f} mA = datasheet derating at {T_CASE:.0f} C (indoor case worst). Was 150R.')
    for ref, ch in (('R39', 'G'), ('R40', 'B')):
        change(ref, value='120R 1%', mpn='RC0603FR-07120RL',
               note=f'v0.5.3: RGB {ch} current {led[ch]["I_worst_mA"]} mA worst case (Vf 2.6 V min, VSYS 4.5 V, -1 %), {led[ch]["I_typ_mA"]} mA typ; '
                    f'limit {I_LIMIT:.1f} mA at {T_CASE:.0f} C. Was 100R.')

    # ---- 4. NFC matching values (hardware/nfc-antenna-study/README.md section 7, owner-approved) ----
    STUDY = ('hardware/nfc-antenna-study/README.md section 7 (2026-11-13): asymmetric match for the FastHenry coil model '
             '(543.6 nH, 0.461 ohm incl. GND planes), Z(TX1-TX2) 11.1 - j0.3 ohm, ITVDD 207 mA nominal and bounded at about 233 mA '
             '(241 mA fast-driver corner) for any coil L; Q 18.8. Bound to the v0.5.2 RF geometry, which v0.5.3 keeps.')
    rf = {'C24': ('330pF C0G 50V 1%', 'CC0603FRNPO9BN331', 'C519562', 'C0 EMC shunt'),
          'C25': ('330pF C0G 50V 1%', 'CC0603FRNPO9BN331', 'C519562', 'C0 EMC shunt'),
          'C26': ('120pF C0G 50V 1%', 'CC0603FRNPO9BN121', 'C519498', 'C1 series match (|Z| knob)'),
          'C27': ('120pF C0G 50V 1%', 'CC0603FRNPO9BN121', 'C519498', 'C1 series match (|Z| knob)'),
          'C28': ('330pF C0G 50V 1%', 'CC0603FRNPO9BN331', 'C519562', 'C2 shunt match'),
          'C29': ('330pF C0G 50V 1%', 'CC0603FRNPO9BN331', 'C519562', 'C2 shunt match'),
          'C34': ('15pF C0G 50V 1%', 'CC0603FRNPO9BN150', 'C519483', 'C2 trim, now FITTED (C2 = 345 pF)'),
          'C35': ('15pF C0G 50V 1%', 'CC0603FRNPO9BN150', 'C519483', 'C2 trim, now FITTED (C2 = 345 pF)'),
          'R22': ('1.0R 1% 0.5W', 'CRCW08051R00FKEAHP', 'C313850', 'RQ damping in series with the coil, 0.5 W pulse-proof'),
          'R23': ('1.0R 1% 0.5W', 'CRCW08051R00FKEAHP', 'C313850', 'RQ damping in series with the coil, 0.5 W pulse-proof'),
          'L1': ('160nH 5%', 'LQW18CNR16J00D', 'C437367', 'L0 EMC inductor, Murata LQW18CN (NXP-named series, 1 A, DCR <= 0.1 ohm)'),
          'L2': ('160nH 5%', 'LQW18CNR16J00D', 'C437367', 'L0 EMC inductor, Murata LQW18CN (NXP-named series, 1 A, DCR <= 0.1 ohm)')}
    for ref, (val, mpn, lcsc, role) in rf.items():
        was = (P[ref]['value'], P[ref]['mpn'], P[ref]['dnp'])
        change(ref, value=val, mpn=mpn, dnp=False,
               note=f'LCSC {lcsc}. {role}. v0.5.3: {val} per {STUDY} Was {was[0]} {was[1]}' + (' (DNP).' if was[2] else '.') +
                    ' Physical check: PN7160 antenna self-test / TVDD current on the first board; re-tune table in the study.')

    # ---- 5. C22/C23 ----
    for ref in ('C22', 'C23'):
        change(ref, mpn='CC0603FRNPO9BN130',
               note='v0.5.3: YAGEO CC0603FRNPO9BN130 (LCSC C519488), 13 pF NP0 +-1 % 50 V 0603, replaces KEMET CBR06C130F5GAC (68 in stock). '
                    'Same value, tolerance and dielectric. NXP AN14518 13 pF branch; oscillator start and frequency check on first boards.')

    d['variant'] = 'PN7160 v0.5.3 candidate (v0.5.2 + hardware defect fixes + layout clean-up)'
    d['engineering_status'] = 'HOLD_DESIGN_CANDIDATE_NOT_TESTED'
    d['v053_profile'] = {
        'cc_esd': 'D8 (CC1) / D9 (CC2) TPD1E05U06DPYR at J1.',
        'io_int_pullup': 'R47 10k to 3V3 on GPIO0 / IO_INT.',
        'rgb_current': log['led'],
        'nfc_matching': 'C24/C25 330 pF, C26/C27 120 pF, C28/C29 330 pF, C34/C35 15 pF fitted, R22/R23 1.0 R 0.5 W, L1/L2 LQW18CNR16J00D (nfc-antenna-study section 7).',
        'crystal_caps': 'C22/C23 YAGEO CC0603FRNPO9BN130.',
        'board': 'black solder mask, white silkscreen, ENIG; top-left case notch removed; 1 mm convex corner radius.',
        'physical_status': 'NOT TESTED'}
    d['v052_profile']['board_outline'] = 'v0.5.3: notch removed, convex corners rounded (74.0 x 45.2 mm unchanged).'
    (ROOT / 'Fieldnote.pretty' / 'TI_DPY0002A.kicad_mod').write_text(DPY)
    g.PARTS = d['parts']
    g.SHEET_GROUPS = [('usb-power', ['USB', 'Power']), ('esp32-leds', ['MCU', 'Indicators']), ('pn7160', ['NFC', 'Test']), ('nfc-rf', ['RF']), ('field-interface', ['Interface'])]
    g.schematic()
    for path in sorted(ROOT.glob('*.kicad_sch')):
        path.write_text(path.read_text().replace('(rev "0.3")', '(rev "0.5.3-candidate")').replace('(date "2026-10-03")', '(date "2026-11-13")')
                        .replace('Fieldnote PN7160 NFC reader', 'Fieldnote PN7160 NFC reader v0.5.3')
                        .replace('65.5 x 47.2 mm including USB tongue; V17 case target 68.1 x 50.5 x 10 mm.', '74.0 x 45.2 mm, 4 layers, black mask / white silk / ENIG.'))
    (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (ROOT / 'output' / 'v053-netlist-changes.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'parts': len(d['parts']), 'added': log['added'], 'changed': len(log['changed']),
                      'led': {k: (v['R_E24'], v['I_worst_mA'], v['I_typ_mA']) for k, v in led.items()}}))


if __name__ == '__main__':
    main()
