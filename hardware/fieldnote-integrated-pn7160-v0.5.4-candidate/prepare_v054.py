#!/usr/bin/env python3
"""v0.5.4 candidate: netlist / part data (design-data.json), new footprints and schematic regeneration.

Source: source-v053/ (frozen v0.5.3 board 200afafc..., design-data dce9305a...). The PCB work is in apply_v054_pcb.py.

Owner-approved changes (see README.md for the analysis behind every value):
  1. Field-power / daughterboard section removed: J6, U10 (TPS2121), U11 (SN74LVC1G0832), JP2, R31-R37, C39, C40, C42, C43 and
     C41 (the TPS2121 IN2 capacitor; no legal site at J1 that does not neck VBUS, and C1 4.7 uF stays at the BQ24074 IN pin).
     Nets 5V_FIELD, FIELD_PG, PWR_SRC, VIN_SEL, MUX_* are gone. VBUS from J1 feeds BQ24074 IN (pin 13) and C1 directly.
     SOURCE_QUALIFIED is now the U7 output itself (TUSB320 OUT1 inverted); USB_HIGH_CURRENT is merged into it.
     IO_INT (GPIO0) loses R47 and J6; the net returns to its v0.4 name BAT_ADC with the DNP battery divider R10/R11/C8.
  2. JP1 replaced by SW3, Nidec CUS-12TB side-actuated SPDT slide switch (non-shorting = break-before-make, datasheet
     "Contact timing: Non-shorting"): 1 = 3V3 (SVC), 2 = common POWER_PERMIT, 3 = SOURCE_QUALIFIED (RUN).
  3. RGB LED D5, Q1-Q3, R38-R43, R16-R18 replaced by a 10-LED WS2812B-2020-V6 bar D10..D19 (data enters D10, the right end),
     100 nF per LED (C47..C56), 22 uF bar bulk C57, SN74LVC1T45 level shifter U13 (VCCA 3V3 / VCCB VSYS) with C58/C59,
     R48 47R series at the ESP32, R49 100k pulldown at the shifter input, R50 100k pulldown at the first DIN.
     GPIO1 net LED_GREEN -> LED_DATA. GPIO3 and GPIO10 become unconnected.
  4. R6 (BQ24074 ILIM) 1.62k -> 1.30k: input limit 1142 / 1238 / 1336 mA (min / typ / max incl. the 1 % resistor), under the 1.5 A advertisement.
"""
from pathlib import Path
import hashlib, json, re
import build_design as g

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'source-v053' / 'design-data.json'
V053_DESIGN = 'dce9305ad5a6360090b5810dbab2b74e7ec05f6d90e2d5e62150c6dc4f52be65'

REMOVE = ['J6', 'U10', 'U11', 'JP2', 'R31', 'R32', 'R33', 'R34', 'R35', 'R36', 'R37', 'C39', 'C40', 'C41', 'C42', 'C43', 'R47',
          'JP1', 'D5', 'Q1', 'Q2', 'Q3', 'R38', 'R39', 'R40', 'R41', 'R42', 'R43', 'R16', 'R17', 'R18']
GONE_NETS = {'5V_FIELD', 'FIELD_PG', 'PWR_SRC', 'VIN_SEL', 'MUX_CP2', 'MUX_PR1', 'MUX_ILM', 'MUX_SS', 'USB_HIGH_CURRENT', 'IO_INT',
             'LED_GREEN', 'LED_BLUE', 'LED_RED', 'LEDR_K', 'LEDG_K', 'LEDB_K', 'LEDR_D', 'LEDG_D', 'LEDB_D',
             'LEDR_GATE', 'LEDG_GATE', 'LEDB_GATE'}
N_LED = 10
LED_REFS = [f'D{10 + i}' for i in range(N_LED)]          # D10 = first in the chain (right end of the bar)
CAP_REFS = [f'C{47 + i}' for i in range(N_LED)]
# LCSC numbers (JLC stock checked 2026-11-13 through the JLC parts search; output/v054-sourcing-check.json)
LCSC = {'WS2812B-2020-V6': 'C52917434', 'SN74LVC1T45DBVR': 'C7843', 'CUS-12TB': 'C2921739', 'CL05B104KO5NNNC': 'C1525',
        'CL21A226MAQNNNE': 'C45783', '0402WGF470JTCE': 'C25118', '0402WGF1003TCE': 'C25741', 'RC0603FR-071K3L': 'C125319'}

LED_NOTE = ('LCSC C52917434 (Worldsemi WS2812B-2020-V6, 862 959 JLC stock 2026-11-13). Datasheet: VDD 3.3-5.3 V, 12 mA per channel '
            '(36 mA full white), quiescent < 1 uA (no data, RGB off), port scan (PWM) 2 kHz, -40..+85 C, VIH min 0.55 x VDD '
            '(2.48 V at VDD 4.5 V; ESP32-C3 VOH min 0.8 x 3.3 = 2.64 V leaves 0.16 V, so the data is buffered by U13 from VSYS). '
            'Pin 1 DO, 2 GND, 3 DI, 4 VDD; footprint in JLC/EasyEDA orientation (pin 1 top-left), datasheet land 0.7 x 0.7 mm.')


def main():
    assert hashlib.sha256(SRC.read_bytes()).hexdigest() == V053_DESIGN
    d = json.loads(SRC.read_text()); P = {p['ref']: p for p in d['parts']}
    log = {'source_design_sha256': V053_DESIGN, 'removed': [], 'added': [], 'changed': []}

    def add(ref, value, fp, nets, mpn, group, note='', names=None, pin_types=None):
        assert ref not in P, ref
        p = dict(ref=ref, value=value, fp=fp, nets={str(k): v for k, v in nets.items()}, xy=[0, 0], angle=0, group=group,
                 mpn=mpn, note=note, dnp=False, side='F', names={str(k): v for k, v in (names or {k: str(k) for k in nets}).items()})
        if pin_types: p['pin_types'] = {str(k): v for k, v in pin_types.items()}
        d['parts'].append(p); P[ref] = p; log['added'].append(ref)

    def change(ref, **kw):
        for k_, v in kw.items():
            log['changed'].append([ref, k_, P[ref].get(k_), v]); P[ref][k_] = v

    def renet(ref, pin, net):
        log['changed'].append([ref, 'net' + str(pin), P[ref]['nets'][str(pin)], net]); P[ref]['nets'][str(pin)] = net

    # ---- 1. field power / daughterboard ----
    for ref in REMOVE:
        p = P.pop(ref); d['parts'].remove(p); log['removed'].append({'ref': ref, 'value': p['value'], 'mpn': p['mpn'], 'nets': p['nets']})
    assert P['U3']['nets']['13'] == 'VIN_SEL' and P['C1']['nets']['1'] == 'VIN_SEL'
    renet('U3', 13, 'VBUS'); renet('C1', 1, 'VBUS')
    assert P['U7']['nets']['4'] == 'USB_HIGH_CURRENT'
    renet('U7', 4, 'SOURCE_QUALIFIED')
    for ref, pin in (('U1', 12), ('R10', 2), ('R11', 1), ('C8', 1)):
        assert P[ref]['nets'][str(pin)] == 'IO_INT', ref
        renet(ref, pin, 'BAT_ADC')
    change('U3', note='Power path. IN (pin 13) on VBUS directly from J1 (v0.5.4: TPS2121 removed). EN1 = GND, EN2 = SOURCE_QUALIFIED: '
                      'USB100 (90-100 mA) until the TUSB320 reports a >= 1.5 A source, then the R6 ILIM limit. TMR and ITERM open (defaults).')
    change('C1', value='4.7uF 16V X5R', note='BQ24074 IN capacitor on VBUS, about 3 mm of copper from pin 13 (datasheet: IN bypass 1-10 uF). '
                                             'v0.5.4: VIN_SEL island merged into VBUS. Total VBUS capacitance 4.7 uF (USB-C sink limit 10 uF).')
    change('U7', note='Inverts TUSB320 open-drain OUT1 (R7 pull-up). v0.5.4: the output IS SOURCE_QUALIFIED (BQ EN2, R2, TP10, SW3 RUN); '
                      'the U11 AND-OR qualification stage is gone with the field-power input.')
    change('R2', note='10k pulldown on SOURCE_QUALIFIED / BQ EN2: holds USB100 while U7 is unpowered (3V3 off) or Ioff.')
    for ref in ('R10', 'R11', 'C8'):
        change(ref, note='DNP. v0.5.4: GPIO0 (BAT_ADC) is free again after the daughterboard removal; optional 1S battery-voltage '
                         'divider footprint as in v0.4. GPIO0 floats when unfitted: firmware leaves it as a disabled input.')

    # ---- 2. service switch ----
    add('SW3', 'CUS-12TB RUN/SVC', 'SW_CUS-12TB', {1: '3V3', 2: 'POWER_PERMIT', 3: 'SOURCE_QUALIFIED'}, 'CUS-12TB', 'MCU',
        'LCSC C2921739 (Nidec Components CUS-12TB, 1 508 JLC stock 2026-11-13). Side-actuated SPDT slide switch, knob 1.5 mm out of '
        'the body, 1.5 mm travel. Datasheet "Contact timing: Non-shorting" (break-before-make): SOURCE_QUALIFIED can never meet 3V3. '
        '10 000 cycles at 4 V / 300 mA; -20..+70 C. Common pin 2 = POWER_PERMIT; knob toward pin 3 = RUN (SOURCE_QUALIFIED), '
        'toward pin 1 = SVC (3V3). While the knob moves, POWER_PERMIT floats and R30 pulls it low: switching always resets the ESP32.',
        names={1: 'SVC', 2: 'C', 3: 'RUN'})
    change('R30', note='47k POWER_PERMIT pulldown: defines the U8 Schmitt input while SW3 is between positions (non-shorting) and '
                       'bounds the input leakage. v0.5.4: moved next to SW3.')
    change('R12', note='47k reset RC pull-up to POWER_PERMIT (SW3 common). C9 charges only once SW3 selects a high source.')
    for ref in ('U12', 'R46', 'C46'):
        P[ref]['note'] = (P[ref].get('note') or '') + ' v0.5.4: group moved from the top-left strip (now the LED bar) to the right side.'

    # ---- 3. LED bar ----
    assert P['U1']['nets']['13'] == 'LED_GREEN' and P['U1']['nets']['6'] == 'LED_BLUE' and P['U1']['nets']['16'] == 'LED_RED'
    renet('U1', 13, 'LED_DATA'); renet('U1', 6, None); renet('U1', 16, None)
    chain = ['LED_DIN'] + [f'LED_D{i + 2}' for i in range(N_LED - 1)] + [None]
    for i, ref in enumerate(LED_REFS):
        add(ref, 'WS2812B-2020-V6', 'LED_WS2812B_2020', {1: chain[i + 1], 2: 'GND', 3: chain[i], 4: 'VSYS'}, 'WS2812B-2020-V6',
            'Indicators', LED_NOTE + f' Position {i + 1} of {N_LED} in the chain.', names={1: 'DO', 2: 'GND', 3: 'DI', 4: 'VDD'},
            pin_types={1: 'output', 2: 'power_in', 3: 'input', 4: 'power_in'})
        add(CAP_REFS[i], '100nF 16V X7R', 'C_0402', {1: 'VSYS', 2: 'GND'}, 'CL05B104KO5NNNC', 'Indicators',
            f'LCSC C1525 (basic). {ref} VDD decoupling, datasheet typical application Cn = 100 nF.')
    add('C57', '22uF 25V X5R', 'C_0805', {1: 'VSYS', 2: 'GND'}, 'CL21A226MAQNNNE', 'Power',
        'LCSC C45783 (basic). VSYS bulk at the LED bar. Sized in README (power design): with C3/C4 and the NFC_VBAT caps the '
        'VSYS ceramic is about 39 uF effective at 4.4 V, inside the BQ24074 OUT range (4.7-47 uF).')
    add('U13', 'SN74LVC1T45DBVR', 'TI_DBV0006A', {1: '3V3', 2: 'GND', 3: 'LED_DATA_3V3', 4: 'LED_DIN', 5: '3V3', 6: 'VSYS'},
        'SN74LVC1T45DBVR', 'Indicators',
        'LCSC C7843. LED data level shifter: VCCA 3V3 (A input VIH 2.0 V at VCCA 3.0-3.6 V; ESP32-C3 VOH >= 2.64 V), VCCB = VSYS '
        '(1.65-5.5 V, specified over the whole 3.9-4.5 V VSYS range, unlike 74AHCT which needs >= 4.5 V); B VOH >= VCCB - 0.1 V '
        'against the LED VIH 0.55 x VDD. DIR tied to VCCA (A to B). Ioff / VCC isolation: B is high-Z while 3V3 is off, R50 keeps DIN low.',
        names={1: 'VCCA', 2: 'GND', 3: 'A', 4: 'B', 5: 'DIR', 6: 'VCCB'},
        pin_types={1: 'power_in', 2: 'power_in', 3: 'input', 4: 'output', 5: 'input', 6: 'power_in'})
    add('C58', '100nF 16V X7R', 'C_0402', {1: '3V3', 2: 'GND'}, 'CL05B104KO5NNNC', 'Indicators', 'LCSC C1525 (basic). U13 VCCA decoupling.')
    add('C59', '100nF 16V X7R', 'C_0402', {1: 'VSYS', 2: 'GND'}, 'CL05B104KO5NNNC', 'Indicators', 'LCSC C1525 (basic). U13 VCCB decoupling.')
    add('R48', '47R 1%', 'R_0402', {1: 'LED_DATA', 2: 'LED_DATA_3V3'}, '0402WGF470JTCE', 'Indicators',
        'LCSC C25118. Series damping at the ESP32 GPIO1 for the long data run to U13.')
    add('R49', '100k 1%', 'R_0402', {1: 'LED_DATA_3V3', 2: 'GND'}, '0402WGF1003TCE', 'Indicators',
        'LCSC C25741 (basic). Holds the U13 A input low while GPIO1 is high-Z (reset, ROM boot).')
    add('R50', '100k 1%', 'R_0402', {1: 'LED_DIN', 2: 'GND'}, '0402WGF1003TCE', 'Indicators',
        'LCSC C25741 (basic). First-DIN pulldown: the bar stays dark during boot and while U13 is unpowered (B high-Z).')

    # ---- 4. ILIM ----
    assert P['R6']['value'] == '1.62k 1%'
    change('R6', value='1.30k 1%', mpn='RC0603FR-071K3L',
           note='LCSC C125319. BQ24074 ILIM: KILIM 1500 / 1610 / 1720 A-ohm (500 mA-1.5 A row) -> 1142 / 1238 / 1336 mA incl. the 1 % resistor. Max is 10.9 % under '
                'the 1.5 A Type-C advertisement; min covers NFC + Wi-Fi TX + 3V3 loads with LED budget left (README power design). Was 1.62k.')

    nets = {n for p in d['parts'] for n in p['nets'].values() if n}
    assert not (nets & GONE_NETS), nets & GONE_NETS
    d['variant'] = 'PN7160 v0.5.4 candidate (v0.5.3 without field power, with service switch and 10-LED bar)'
    d['engineering_status'] = 'HOLD_DESIGN_CANDIDATE_NOT_TESTED'
    d['outline'] = [[0, 0], [47, 0], [47, -2], [60, -2], [60, 0], [74, 0], [74, 37], [65.5, 37], [65.5, 45.2], [61.5, 45.2],
                    [61.5, 38.7], [48.1, 38.7], [48.1, 45.2], [0, 45.2]]
    d['field_power_profile'] = {'status': 'REMOVED in v0.5.4 (J6, TPS2121 mux, qualification logic). USB-C only.'}
    d['usb_boot_gate_profile'].update({
        'normal_selector': 'SW3 RUN: POWER_PERMIT = SOURCE_QUALIFIED = NOT(TUSB320 OUT1) from U7',
        'service_selector': 'SW3 SVC: POWER_PERMIT = 3V3 (break-before-make slide switch, never both)',
        'v054_sequence': 'USB100 at attach -> VSYS ~5 ms -> TPS_EN (R26/C36) >= 19 ms -> 3V3 -> TUSB320 debounce 133 ms -> '
                         'SOURCE_QUALIFIED -> BQ ILIM + C9 RC; U12 holds ESP_RESET_RC low for its 200 ms delay. See README.'})
    d['v054_profile'] = {
        'removed': [r['ref'] for r in log['removed']],
        'service_switch': 'SW3 CUS-12TB, right board edge, knob through the case wall; RUN / SVC silk.',
        'led_bar': f'{N_LED} x WS2812B-2020-V6 (D10 first) on the top edge, pitch 3.1 mm, axis y 4.2; U13 SN74LVC1T45 VSYS-referenced data.',
        'ilim': 'R6 1.30k (1142-1336 mA incl. 1 % resistor).',
        'mounting_holes': 'DROPPED by the owner (brief item 5): no holes, outline unchanged.',
        'nfc_band': 'No-copper rule area y 9.6-10.7 (2.0 mm from the coil outer turn), all four layers.',
        'physical_status': 'NOT TESTED'}

    footprints()
    g.PARTS = d['parts']
    g.SHEET_GROUPS = [('usb-power', ['USB', 'Power']), ('esp32-leds', ['MCU', 'Indicators']), ('pn7160', ['NFC', 'Test']), ('nfc-rf', ['RF'])]
    assert not [p for p in d['parts'] if p['group'] == 'Interface']
    g.schematic()
    root = (ROOT / 'fieldnote.kicad_sch').read_text()
    root = drop_sexpr(root, '(symbol (lib_id "Fieldnote:PWR_FLAG")', '"#FLG04"')
    root = drop_sexpr(root, '(global_label "5V_FIELD"', '"5V_FIELD"')
    root = root.replace('3 LEDs, 1S LiPo connector', '10-LED WS2812B-2020 bar, RUN/SVC switch, 1S LiPo footprint (DNP)')
    (ROOT / 'fieldnote.kicad_sch').write_text(root)
    for path in sorted(ROOT.glob('*.kicad_sch')):
        path.write_text(path.read_text().replace('(rev "0.3")', '(rev "0.5.4-candidate")').replace('(date "2026-10-03")', '(date "2026-11-13")')
                        .replace('Fieldnote PN7160 NFC reader', 'Fieldnote PN7160 NFC reader v0.5.4')
                        .replace('65.5 x 47.2 mm including USB tongue; V17 case target 68.1 x 50.5 x 10 mm.', '74.0 x 45.2 mm, 4 layers, black mask / white silk / ENIG.'))
    (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (ROOT / 'output' / 'v054-netlist-changes.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'parts': len(d['parts']), 'removed': len(log['removed']), 'added': log['added'], 'changed': len(log['changed'])}))


def _pad(num, x, y, w, h, extra=''):
    return (f'\t(pad "{num}" smd roundrect (at {x:g} {y:g}) (size {w:g} {h:g}) (layers "F.Cu" "F.Mask" "F.Paste") '
            f'(roundrect_rratio 0.1){extra})\n')


def _line(a, b, layer, w):
    return f'\t(fp_line (start {a[0]:g} {a[1]:g}) (end {b[0]:g} {b[1]:g}) (stroke (width {w:g}) (type solid)) (layer "{layer}"))\n'


def _rect(a, b, layer, w):
    return f'\t(fp_rect (start {a[0]:g} {a[1]:g}) (end {b[0]:g} {b[1]:g}) (stroke (width {w:g}) (type solid)) (fill no) (layer "{layer}"))\n'


def _head(name, descr, tags, attr='smd', ref_at=(0, -1.6)):
    return (f'(footprint "{name}"\n\t(version 20260206)\n\t(generator "fieldnote-prepare_v054")\n\t(layer "F.Cu")\n'
            f'\t(descr "{descr}")\n\t(tags "{tags}")\n'
            f'\t(property "Reference" "REF**" (at {ref_at[0]:g} {ref_at[1]:g} 0) (layer "F.SilkS") (effects (font (size 0.8 0.8) (thickness 0.15))))\n'
            f'\t(property "Value" "{name}" (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 0.5 0.5) (thickness 0.08))))\n'
            f'\t(attr {attr})\n\t(duplicate_pad_numbers_are_jumpers no)\n')


def footprints():
    lib = ROOT / 'Fieldnote.pretty'
    # WS2812B-2020-V6. Pad numbers / positions in the JLC (EasyEDA LED-SMD_4P-L2.2-W2.0) orientation: pin 1 DO top-left, 2 GND
    # bottom-left, 3 DI bottom-right, 4 VDD top-right (= the Worldsemi top view rotated 180 deg). Land: datasheet 0.7 x 0.7 mm,
    # 1.13 mm inner gap (centres +-0.915), 0.40 mm row gap (centres +-0.55).
    s = _head('LED_WS2812B_2020', 'Worldsemi WS2812B-2020-V6 addressable RGB LED, 2.2 x 2.0 mm; land per datasheet p.2; JLC/EasyEDA '
              'orientation (pin 1 DO top-left). Pin 1 DO, 2 GND, 3 DI, 4 VDD.', 'WS2812B 2020 addressable LED', ref_at=(0, -1.75))
    for num, x, y in (('1', -0.915, -0.55), ('2', -0.915, 0.55), ('3', 0.915, 0.55), ('4', 0.915, -0.55)):
        s += _pad(num, x, y, 0.7, 0.7)
    s += _rect((-1.1, -1.0), (1.1, 1.0), 'F.Fab', 0.1) + _line((-0.6, -1.0), (-0.6, 1.0), 'F.Fab', 0.1)
    s += _rect((-1.5, -1.15), (1.5, 1.15), 'F.CrtYd', 0.05)
    s += _line((-0.45, -1.02), (0.45, -1.02), 'F.SilkS', 0.12) + _line((-0.45, 1.02), (0.45, 1.02), 'F.SilkS', 0.12)
    s += '\t(fp_circle (center -1.45 -1.05) (end -1.38 -1.05) (stroke (width 0.12) (type solid)) (fill yes) (layer "F.SilkS"))\n'
    s += '\t(embedded_fonts no)\n)\n'
    (lib / 'LED_WS2812B_2020.kicad_mod').write_text(s)
    # Nidec CUS-12TB (CUS-12B land, datasheet p.3), JLC/EasyEDA SW-SMD_CUS-12TB origin and orientation: terminals 1-3 at +y,
    # knob at -y. Terminal 1 x +2.25, 2 (C) x -0.75, 3 x -2.25; mounting tabs (no number) at x +-3.65; two 0.9 mm NPTH peg holes.
    s = _head('SW_CUS-12TB', 'Nidec CUS-12TB side-actuated SPDT slide switch, non-shorting; land per datasheet CUS-12B, '
              'JLC/EasyEDA orientation; knob (1.5 mm past the body) toward -y.', 'slide switch SPDT CUS-12', ref_at=(0, -4.0))
    for num, x in (('1', 2.25), ('2', -0.75), ('3', -2.25)):
        s += _pad(num, x, 1.4, 0.7, 1.5)
    for x, y in ((-3.65, 0.7), (-3.65, -1.4), (3.65, 0.7), (3.65, -1.4)):
        s += _pad('', x, y, 1.0, 0.8)
    for x in (-1.5, 1.5):
        s += f'\t(pad "" np_thru_hole circle (at {x:g} -0.35) (size 0.9 0.9) (drill 0.9) (layers "*.Cu" "*.Mask"))\n'
    s += _rect((-3.35, -1.65), (3.35, 0.95), 'F.Fab', 0.1) + _rect((-1.3, -3.15), (0, -1.65), 'F.Fab', 0.1)
    pts = ' '.join(f'(xy {x:g} {y:g})' for x, y in ((-4.4, -1.95), (-1.55, -1.95), (-1.55, -3.4), (1.75, -3.4), (1.75, -1.95), (4.4, -1.95), (4.4, 2.4), (-4.4, 2.4)))
    s += f'\t(fp_poly (pts {pts}) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))\n'    # body + knob, one outline
    s += _line((-2.95, -1.75), (-1.45, -1.75), 'F.SilkS', 0.12) + _line((0.15, -1.75), (2.95, -1.75), 'F.SilkS', 0.12)
    s += _line((-1.6, 1.05), (-1.4, 1.05), 'F.SilkS', 0.12) + _line((-0.1, 1.05), (1.6, 1.05), 'F.SilkS', 0.12)
    s += '\t(embedded_fonts no)\n)\n'
    (lib / 'SW_CUS-12TB.kicad_mod').write_text(s)
    stale = lib / 'MountingHole_M2_NPTH_Keepout4.5.kicad_mod'      # item 5 (mounting holes) dropped by the owner
    if stale.exists(): stale.unlink()


def drop_sexpr(text, head, must):
    """Remove the one balanced s-expression starting with `head` that contains `must`."""
    i = 0
    while True:
        i = text.index(head, i)
        depth, j = 0, i
        while True:
            c = text[j]
            depth += (c == '(') - (c == ')'); j += 1
            if depth == 0: break
        if must in text[i:j]:
            return text[:i] + text[j:]
        i = j


if __name__ == '__main__':
    main()
