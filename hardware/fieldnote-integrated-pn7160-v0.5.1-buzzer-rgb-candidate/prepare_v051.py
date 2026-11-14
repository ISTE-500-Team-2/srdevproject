#!/usr/bin/env python3
"""v0.5.1 candidate: v0.5 main board + tap buzzer + one high-brightness RGB status LED.

Owner requirements (2026-11-13): add a small buzzer for card taps without growing the board; replace the three
status LEDs (D1 green, D2 amber, D3 red) with ONE RGB LED that can go very bright. The daughterboard is unchanged.

Decisions:
  * Buzzer: KLJ-4020 4x4x2 mm magnetic transducer on 3V3, high-side AO3401A P-FET gated by GPIO8 (BOOT_IO8).
    R14 (existing 10k pull-up) holds the FET off through reset, so the GPIO8 strap is undisturbed. R44 10R + C44 22uF
    isolate the 4 kHz coil current from the 3V3 rail that feeds the ESP32 and PN7160, and cap a stuck-low fault at ~200 mA (R44 4.7R).
  * RGB: XL-1615RGBC-RF (1.6x1.5x0.6 mm, common anode, 20 mA abs max per die) on VSYS (BQ24074 OUT, 4.4 V nominal)
    because 3.3 V cannot forward-bias the InGaN green/blue dies at full current. Low-side AO3400A per channel, gate
    driven by the existing GPIO + series resistor (R16/R17/R18), 100k gate pulldown so it stays dark during boot.
    Current resistors sized so the minimum-Vf die at VSYS 4.5 V stays <= 20 mA: R 150R, G/B 100R.
    Pin map: IO1 LED_GREEN -> G, IO3 LED_BLUE (was LED_AMBER) -> B, IO10 LED_RED -> R. Amber = R + G in firmware.
"""
from pathlib import Path
import hashlib, json
import build_design as g

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'source-v05' / 'design-data.json'
V05_DESIGN = 'a025c2d9c07398e1c9cb30e6b93b2310b54598f14c07c949b17af8e61c1a4255'
RENAME = {'LED_AMBER': 'LED_BLUE', 'D1_ANODE': 'LEDG_GATE', 'D2_ANODE': 'LEDB_GATE', 'D3_ANODE': 'LEDR_GATE'}


def main():
    assert hashlib.sha256(SRC.read_bytes()).hexdigest() == V05_DESIGN
    d = json.loads(SRC.read_text()); P = {p['ref']: p for p in d['parts']}
    log = {'source_design_sha256': V05_DESIGN, 'removed': ['D1', 'D2', 'D3'], 'renamed_nets': RENAME, 'renets': [], 'added': []}
    d['parts'] = [p for p in d['parts'] if p['ref'] not in ('D1', 'D2', 'D3')]
    for p in d['parts']:
        for pin, n in p['nets'].items():
            if n in RENAME:
                p['nets'][pin] = RENAME[n]; log['renets'].append([p['ref'], pin, n, RENAME[n]])
    P = {p['ref']: p for p in d['parts']}
    for ref, col in (('R16', 'green'), ('R17', 'blue'), ('R18', 'red')):
        P[ref]['note'] = f'Gate resistor for the RGB {col} channel FET (was the LED current resistor).'
    P['R14']['note'] = 'GPIO8 strap pull-up; also holds buzzer FET Q4 off through reset and boot.'
    P['U1']['note'] = (P['U1'].get('note') or '') + (' v0.5.1: IO8 drives the buzzer (active low, LEDC ~4 kHz, idle high);'
                                                      ' IO1/IO3/IO10 drive RGB G/B/R (active high PWM).')

    def add(ref, value, fp, nets, mpn, note='', names=None):
        assert ref not in P, ref
        p = dict(ref=ref, value=value, fp=fp, nets={str(k): v for k, v in nets.items()}, xy=[0, 0], angle=0, group='Indicators',
                 mpn=mpn, note=note, dnp=False, side='F', names={str(k): v for k, v in (names or {k: str(k) for k in nets}).items()})
        d['parts'].append(p); P[ref] = p; log['added'].append(ref)
    two = lambda a, b: {1: a, 2: b}
    GSD = {1: 'G', 2: 'S', 3: 'D'}

    # ---- RGB status LED ----
    add('D5', 'RGB XL-1615RGBC-RF', 'LED_RGB_1615_XL-1615RGBC', {1: 'LEDR_K', 2: 'VSYS', 3: 'LEDG_K', 4: 'LEDB_K'}, 'XL-1615RGBC-RF',
        'LCSC C965840. 1.6x1.5x0.6 mm common anode, 20 mA abs max per die; Iv at 20 mA R 100-180, G 350-800, B 120-180 mcd. '
        'Centred on the middle light-guide site (case [22, 8]).', {1: 'R_K', 2: 'A', 3: 'G_K', 4: 'B_K'})
    for q, rr, rp, col, val, mpn in (('Q1', 'R39', 'R41', 'G', '100R 1%', 'RC0603FR-07100RL'),
                                      ('Q2', 'R40', 'R42', 'B', '100R 1%', 'RC0603FR-07100RL'),
                                      ('Q3', 'R38', 'R43', 'R', '150R 1%', 'RC0603FR-07150RL')):
        add(q, 'AO3400A', 'SOT23', {1: f'LED{col}_GATE', 2: 'GND', 3: f'LED{col}_D'}, 'AO3400A',
            f'LCSC C20917. Low-side switch for RGB {col}; Vgs(th) <= 1.45 V so 3.3 V gate drive saturates it.', GSD)
        add(rr, val, 'R_0603', two(f'LED{col}_K', f'LED{col}_D'), mpn,
            f'RGB {col} current: <= 20 mA at minimum Vf and VSYS 4.5 V (datasheet abs max 20 mA).')
        add(rp, '100k 1%', 'R_0603', two(f'LED{col}_GATE', 'GND'), 'RC0603FR-07100KL', f'Keeps RGB {col} dark while the GPIO is an input (reset/boot).')

    # ---- tap buzzer ----
    add('BZ1', 'KLJ-4020', 'Buzzer_KLJ-4020', two('BZR_P', 'GND'), 'KLJ-4020',
        'LCSC C556936. Keliking 4x4x2 mm magnetic transducer, 12 ohm, rated 3 Vo-p, 73 dBA min at 10 cm / 4 kHz, 100 mA max mean. '
        'Alternate FUET-4020 (C391027), same land pattern, quieter. Needs a sound port in the front cover.', {1: '+', 2: '-'})
    add('Q4', 'AO3401A', 'SOT23', {1: 'BOOT_IO8', 2: 'BZR_VDD', 3: 'BZR_P'}, 'AO3401A',
        'LCSC C15127. High-side P-FET; gate = GPIO8 with R14 pull-up, so off whenever GPIO8 is high or an input.', GSD)
    add('D6', '1N4148WS', 'SOD323', two('BZR_P', 'GND'), '1N4148WS-7-F', 'Flyback across the buzzer coil.', {1: 'K', 2: 'A'})
    add('R44', '4.7R 1% 0.5W', 'R_0805', two('3V3', 'BZR_VDD'), 'CRCW08054R70FKEAHP',
        'Buzzer supply isolation with C44 (~50 us). 4.7R keeps the coil near its 3 V rating (10R left only ~2 V, Fable review). '
        'Stuck-low fault: ~200 mA, 0.19 W here - firmware task watchdog required. Any 0805 >= 0.25 W 4.7R is acceptable; tune on first articles.')
    add('C44', '22uF 6.3V X5R', 'C_0603', two('BZR_VDD', 'GND'), 'CL10A226MQ8NRNC', 'LCSC C59461. Buzzer reservoir: supplies the 4 kHz coil pulses locally (about 10 uF effective at 3 V).')

    d['variant'] = 'PN7160 v0.5.1 buzzer + RGB candidate'
    d['engineering_status'] = 'HOLD_DESIGN_CANDIDATE_NOT_TESTED'
    d['v051_profile'] = {
        'buzzer': 'BZ1 KLJ-4020 on 3V3 via R44/C44, Q4 AO3401A high side, gate GPIO8 (R14 pull-up = off at reset). Firmware: LEDC on GPIO8, inverted (idle high), ~4 kHz 50 %, timed beeps only.',
        'rgb': 'D5 XL-1615RGBC-RF common anode on VSYS; Q1/Q2/Q3 AO3400A low side on IO1 (G), IO3 (B), IO10 (R) via R16/R17/R18; 100k gate pulldowns.',
        'board_outline': 'unchanged from v0.5 (74.0 x 45.2 mm)',
        'physical_status': 'NOT TESTED'}
    g.PARTS = d['parts']
    g.SHEET_GROUPS = [('usb-power', ['USB', 'Power']), ('esp32-leds', ['MCU', 'Indicators']), ('pn7160', ['NFC', 'Test']), ('nfc-rf', ['RF']), ('field-interface', ['Interface'])]
    g.schematic()
    for path in ROOT.glob('*.kicad_sch'):
        path.write_text(path.read_text().replace('(rev "0.3")', '(rev "0.5.1-buzzer-rgb-candidate")').replace('(date "2026-10-03")', '(date "2026-11-13")')
                        .replace('Fieldnote PN7160 NFC reader', 'Fieldnote PN7160 NFC reader v0.5.1'))
    (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (ROOT / 'output' / 'v051-netlist-changes.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'parts': len(d['parts']), 'added': log['added'], 'renets': len(log['renets'])}))


if __name__ == '__main__':
    main()
