#!/usr/bin/env python3
"""v0.5.2 candidate: v0.5.1 (buzzer + RGB) with the independent-review hardware fixes. Outline unchanged.

Source: source-v051/ (frozen v0.5.1 board 3fec6983..., design-data bcc477b6...). This script only edits the netlist
(design-data.json) and regenerates the schematic sheets; the PCB work is in apply_v052_pcb.py.

Netlist changes:
  1. Buzzer stuck-on protection - Q4 gate is AC-coupled.
       GPIO8 (BOOT_IO8, R14 10k pull-up stays on the GPIO side) -- C45 100nF -- BZR_GATE (Q4 gate)
       R45 68k   BZR_GATE -> BZR_VDD (Q4 source): gate returns to the source, tau = R45 x C45 = 6.8 ms
                 (100k, the first value, left 46 ms of stuck-on time in the hot low-threshold corner; see sim/)
       D7 RB520S-30 anode BZR_GATE, cathode BZR_VDD: clamps the gate at source + Vf, so every falling GPIO edge
       pulls Vgs to about -(3.3 V - Vf) whatever the duty cycle (DC restore).
     A static low on GPIO8 therefore turns Q4 off again within about 14 ms typ / 32 ms worst simulated corner; a static high
     or a high-Z pin keeps it off. RB520S-30 is required for D7: a 1N4148 clamp leaves only -2.39 V of gate drive.
     Simulation: sim/ (ngspice), summary in sim/results.json and the README.
  2. Reset supervisor - U12 TLV803S (2.93 V, open drain, 200 ms) senses 3V3 and pulls ESP_RESET_RC low through
     R46 1k. ESP_RESET_RC is the U8 (SN74LVC1G97, Y = In0 AND In2, In1 = GND) In0 node with R12 47k to POWER_PERMIT
     and C9 1uF, already shared with SW1 and J4.5, all of which only pull low. U8 drives ESP_EN push-pull, so the
     supervisor must not sit on ESP_EN. R46 limits the C9 discharge current into the open-drain output to 3.3 mA
     (low level 1k/(47k+1k) x 3.3 V = 69 mV, C9 discharge tau 1 ms). C46 100nF is the local U12 bypass.
New footprints C_0402, R_0402 and SOD523 are copied from the KiCad 10 standard libraries (pads unchanged).
"""
from pathlib import Path
import hashlib, json, re
import build_design as g

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'source-v051' / 'design-data.json'
V051_DESIGN = 'bcc477b67186f6d9deeccbd003c2ec7afd8f42c4003282d6b575f9da3276389a'
KICAD_FP = Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints')
STD_FP = {'C_0402': ('Capacitor_SMD.pretty', 'C_0402_1005Metric'), 'R_0402': ('Resistor_SMD.pretty', 'R_0402_1005Metric'),
          'SOD523': ('Diode_SMD.pretty', 'D_SOD-523')}


def footprints():
    out = {}
    for name, (lib, std) in STD_FP.items():
        t = (KICAD_FP / lib / (std + '.kicad_mod')).read_text()
        t = t.replace(f'(footprint "{std}"', f'(footprint "{name}"', 1)
        t = re.sub(r'\n\t\(model [^\n]*\n(?:\t\t.*\n)*?\t\)', '', t)          # no 3D model path dependency
        (ROOT / 'Fieldnote.pretty' / (name + '.kicad_mod')).write_text(t)
        out[name] = f'{lib}/{std}'
    return out


def main():
    assert hashlib.sha256(SRC.read_bytes()).hexdigest() == V051_DESIGN
    d = json.loads(SRC.read_text()); P = {p['ref']: p for p in d['parts']}
    log = {'source_design_sha256': V051_DESIGN, 'renets': [], 'added': [], 'footprints_from_kicad_std': footprints()}

    def add(ref, value, fp, nets, mpn, group, note='', names=None, pin_types=None):
        assert ref not in P, ref
        p = dict(ref=ref, value=value, fp=fp, nets={str(k): v for k, v in nets.items()}, xy=[0, 0], angle=0, group=group,
                 mpn=mpn, note=note, dnp=False, side='F', names={str(k): v for k, v in (names or {k: str(k) for k in nets}).items()})
        if pin_types: p['pin_types'] = {str(k): v for k, v in pin_types.items()}
        d['parts'].append(p); P[ref] = p; log['added'].append(ref)
    two = lambda a, b: {1: a, 2: b}

    # ---- fix 1: AC-coupled buzzer gate ----
    assert P['Q4']['nets']['1'] == 'BOOT_IO8'
    P['Q4']['nets']['1'] = 'BZR_GATE'; log['renets'].append(['Q4', '1', 'BOOT_IO8', 'BZR_GATE'])
    P['Q4']['note'] = ('LCSC C15127. High-side P-FET. v0.5.2: gate is AC-coupled from GPIO8 (C45) with R45 to the source and clamp D7, '
                       'so only PWM edges turn it on; any static GPIO8 level leaves it off within about 32 ms worst case (simulated).')
    add('C45', '100nF 16V X7R', 'C_0402', two('BOOT_IO8', 'BZR_GATE'), 'CL05B104KO5NNNC', 'Indicators',
        'LCSC C1525. Buzzer gate coupling capacitor. With R45: tau 6.8 ms.')
    add('R45', '68k 1%', 'R_0402', two('BZR_GATE', 'BZR_VDD'), '0402WGF6802TCE', 'Indicators',
        'LCSC C36871. Gate return to the Q4 source: Q4 is off 14 ms typ / 32 ms worst simulated corner after GPIO8 stops toggling.')
    add('D7', 'RB520S-30', 'SOD523', two('BZR_VDD', 'BZR_GATE'), 'RB520S-30', 'Indicators',
        'LCSC C8522 (JSCJ). Gate clamp / DC restore: anode gate, cathode Q4 source. Low-Vf Schottky is required: a 1N4148 '
        'clamp leaves Q4 with only -2.39 V of gate drive at 2 kHz / 90 % (below the 2.5 V Rds(on) spec point).', {1: 'K', 2: 'A'})
    P['R14']['note'] = 'GPIO8 strap pull-up, unchanged. v0.5.2: Q4 gate is no longer DC-connected to this net (C45 in series).'
    P['R44']['note'] = ('Buzzer supply isolation with C44 (~50 us). 4.7R keeps the coil near its 3 V rating. v0.5.2: a stuck-low GPIO8 no longer '
                        'holds DC in the coil (AC-coupled gate), so the 0.19 W fault case is gone. Any 0805 >= 0.25 W 4.7R is acceptable.')
    P['C44']['note'] += ' v0.5.2: moved >= 1.5 mm from the board edge.'

    # ---- fix 2: reset supervisor ----
    add('U12', 'TLV803S', 'SOT23', {1: 'GND', 2: 'SUP_RESET_N', 3: '3V3'}, 'TLV803SDBZR', 'MCU',
        'LCSC C132016. 3V3 supervisor, 2.93 V threshold, open drain, 200 ms typ delay. Pulls the reset RC node low (through R46), '
        'never ESP_EN: U8 drives ESP_EN push-pull.', {1: 'GND', 2: 'RESET_N', 3: 'VDD'},
        {1: 'power_in', 2: 'open_collector', 3: 'power_in'})
    add('R46', '1k 1%', 'R_0402', two('SUP_RESET_N', 'ESP_RESET_RC'), '0402WGF1001TCE', 'MCU',
        'LCSC C11702. Limits the C9 discharge current into the U12 open-drain output to 3.3 mA; low level 69 mV, discharge tau 1 ms.')
    add('C46', '100nF 16V X7R', 'C_0402', two('3V3', 'GND'), 'CL05B104KO5NNNC', 'MCU', 'LCSC C1525. U12 supply bypass.')
    P['C9']['note'] += ' v0.5.2: U12 discharges it through R46 on every 3V3 brownout, so the reset delay always re-arms.'
    P['U1']['note'] = P['U1']['note'].replace('IO8 drives the buzzer (active low, LEDC ~4 kHz, idle high)',
                                              'IO8 drives the buzzer through C45 (LEDC 2-5 kHz only; a static level is silent)')

    d['variant'] = 'PN7160 v0.5.2 candidate (v0.5.1 + review fixes)'
    d['engineering_status'] = 'HOLD_DESIGN_CANDIDATE_NOT_TESTED'
    d['v051_profile']['buzzer'] = ('BZ1 KLJ-4020 on 3V3 via R44/C44, Q4 AO3401A high side. v0.5.2: gate AC-coupled from GPIO8 '
                                   '(C45 100nF, R45 68k to source, D7 clamp). Firmware: LEDC on GPIO8, 2-5 kHz, timed beeps; idle level does not matter.')
    d['v052_profile'] = {
        'buzzer_gate': 'C45 100nF series, R45 68k gate-source, D7 RB520S-30 clamp. Stuck-low GPIO8: Q4 off in 14 ms typ, 32 ms worst simulated corner (sim/results.json).',
        'supervisor': 'U12 TLV803S 2.93 V open drain on 3V3 -> R46 1k -> ESP_RESET_RC (C9/R12/U8 In0). Release = 200 ms typ after 3V3 valid, then R12 x C9.',
        'nfc_keepout': 'NFC rule areas extended from x 1.5 to the left board edge; the grounded edge strip is gone on all four layers.',
        'stackup': '4 layers, 1.6 mm FR-4, 1 oz outer, 0.5 oz inner (see README for the 5V_FIELD inner-layer current note).',
        'board_outline': 'unchanged (74.0 x 45.2 mm)', 'physical_status': 'NOT TESTED'}
    g.PARTS = d['parts']
    g.SHEET_GROUPS = [('usb-power', ['USB', 'Power']), ('esp32-leds', ['MCU', 'Indicators']), ('pn7160', ['NFC', 'Test']), ('nfc-rf', ['RF']), ('field-interface', ['Interface'])]
    g.schematic()
    for path in ROOT.glob('*.kicad_sch'):
        path.write_text(path.read_text().replace('(rev "0.3")', '(rev "0.5.2-candidate")').replace('(date "2026-10-03")', '(date "2026-11-13")')
                        .replace('Fieldnote PN7160 NFC reader', 'Fieldnote PN7160 NFC reader v0.5.2'))
    (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (ROOT / 'output' / 'v052-netlist-changes.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'parts': len(d['parts']), 'added': log['added'], 'renets': len(log['renets'])}))


if __name__ == '__main__':
    main()
