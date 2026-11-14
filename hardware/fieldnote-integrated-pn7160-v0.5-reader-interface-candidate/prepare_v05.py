#!/usr/bin/env python3
"""v0.5 reader-interface candidate: schematic/design-data changes on top of frozen v4c.

Adds automatic USB-C / 12-24 V source selection (TPS2121 priority mux, field input
arrives as 5V_FIELD from the interface daughterboard), the boot-permission OR gate,
the daughterboard connector, and reclaims IO0 as the shared interface interrupt.
Never touches source-v04c/.
"""
from pathlib import Path
import hashlib, json, shutil
import build_design as g

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'source-v04c'
KICAD_FP = Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints')
V4C_DESIGN_SHA = '7d8d0ae32b42c3ae52a6ce4910f859c83cea7ac47a84a8366d8cde541183c267'


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def copy_fp(lib, name, new):
    text = (KICAD_FP / lib / (name + '.kicad_mod')).read_text()
    assert text.count('(footprint "' + name + '"') == 1
    (ROOT / 'Fieldnote.pretty' / (new + '.kicad_mod')).write_text(text.replace('(footprint "' + name + '"', '(footprint "' + new + '"', 1))


def main():
    src = SRC / 'design-data.json'
    assert sha(src) == V4C_DESIGN_SHA, 'v4c design-data changed'
    d = json.loads(src.read_text())
    P = {p['ref']: p for p in d['parts']}
    changes = []

    def renet(ref, pin, new, note=None):
        old = P[ref]['nets'][pin]
        P[ref]['nets'][pin] = new
        changes.append({'ref': ref, 'pin': pin, 'from': old, 'to': new})
        if note: P[ref]['note'] = note

    # 1. USB VBUS no longer feeds the charger directly; the mux output does.
    renet('U3', '13', 'VIN_SEL', 'Power path. IN now fed by U10 TPS2121 output VIN_SEL (USB VBUS or 5V_FIELD). TMR and ITERM open retain defaults.')
    renet('C1', '1', 'VIN_SEL', 'BQ24074 IN local capacitor, now on VIN_SEL island after the USB/field mux. Existing pose and copper retained.')
    # 2. Charger input mode and boot permission follow SOURCE_QUALIFIED = USB_HIGH_CURRENT OR FIELD_PG.
    renet('U3', '5', 'SOURCE_QUALIFIED')
    renet('R2', '1', 'SOURCE_QUALIFIED', '10k pulldown on SOURCE_QUALIFIED / BQ EN2 (moved from USB_HIGH_CURRENT; same pose). Leakage screen must be redone with U11 Ioff.')
    renet('JP1', '1', 'SOURCE_QUALIFIED', 'Default copper bridge1-2 selects qualified-source operation (good USB OR field power). CUT1-2 before soldering2-3 SERVICE. Never bridge both: U11 output would short 3V3.')
    P['JP1']['names']['1'] = 'SOURCE_QUALIFIED'
    renet('TP10', '1', 'SOURCE_QUALIFIED'); P['TP10']['value'] = 'SOURCE_QUALIFIED'
    P['U7']['note'] = 'Inverts TUSB320 open-drain OUT1. Output USB_HIGH_CURRENT now drives only U11 input C (OR term).'
    # 3. IO0 becomes the shared open-drain interrupt from the interface board; battery ADC divider DNP.
    renet('U1', '12', 'IO_INT')
    P['U1']['names']['12'] = 'IO0'
    for ref, pin in (('R10', '2'), ('R11', '1'), ('C8', '1')):
        renet(ref, pin, 'IO_INT')
        P[ref]['dnp'] = True
        P[ref]['note'] = 'DNP in v0.5: IO0 reclaimed as IO_INT (interface interrupt). Battery is DNP; a future battery gauge needs another path.'

    def add(ref, value, fp, nets, mpn, note, names=None, group='Power', xy=(0, 0), angle=0, side='F', pin_types=None, dnp=False):
        assert ref not in P, ref
        part = dict(ref=ref, value=value, fp=fp, nets={str(k): v for k, v in nets.items()}, xy=list(xy), angle=angle,
                    group=group, mpn=mpn, note=note, dnp=dnp, side=side,
                    names={str(k): v for k, v in (names or {k: str(k) for k in nets}).items()})
        if pin_types: part['pin_types'] = {str(k): v for k, v in pin_types.items()}
        d['parts'].append(part); P[ref] = part

    two = lambda a, b: {1: a, 2: b}
    # TPS2121 priority mux. IN1 = 5V_FIELD (priority), IN2 = USB VBUS. XCOMP mode: PR1 vs CP2.
    add('U10', 'TPS2121RUXR', 'TI_RUX0012A',
        {1: 'VIN_SEL', 2: 'VBUS', 3: 'MUX_CP2', 4: 'GND', 5: 'GND', 6: 'MUX_PR1', 7: '5V_FIELD', 8: 'VIN_SEL', 9: 'PWR_SRC', 10: 'MUX_ILM', 11: 'MUX_SS', 12: 'GND'},
        'TPS2121RUXR',
        'USB/field priority mux. Field (IN1) wins whenever valid; USB (IN2) otherwise. Fast 5us switchover in XCOMP mode. Reverse-current blocking keeps field power off the USB host. OV1/OV2 unused (GND); BQ24074 retains its own input OVP.',
        {1: 'OUT', 2: 'IN2', 3: 'CP2', 4: 'OV2', 5: 'OV1', 6: 'PR1', 7: 'IN1', 8: 'OUT', 9: 'ST', 10: 'ILM', 11: 'SS', 12: 'GND'},
        xy=(68.9, 5.0), pin_types={1: 'power_out', 2: 'power_in', 3: 'input', 4: 'input', 5: 'input', 6: 'input', 7: 'power_in', 8: 'passive', 9: 'open_collector', 10: 'passive', 11: 'passive', 12: 'power_in'})
    add('R31', '23.2k 1%', 'R_0603', two('5V_FIELD', 'MUX_PR1'), 'RC0603FR-0723K2L', 'PR1 divider top: PR1 = 0.301 x 5V_FIELD (1.51 V at 5.0 V).', xy=(70.5, 8.4))
    add('R32', '10k 1%', 'R_0603', two('MUX_PR1', 'GND'), 'RC0603FR-0710KL', 'PR1 divider bottom. Field keeps priority while PR1 > CP2: down to 4.14 V field at 5.00 V USB, 4.35 V at 5.25 V USB.', xy=(70.5, 10.0))
    add('R33', '30.1k 1%', 'R_0603', two('VBUS', 'MUX_CP2'), 'RC0603FR-0730K1L', 'CP2 divider top: CP2 = 0.249 x VBUS. CP2 >= VREF (fast-switchover XCOMP mode) for VBUS >= 4.41 V.', xy=(67.2, 8.4))
    add('R34', '10k 1%', 'R_0603', two('MUX_CP2', 'GND'), 'RC0603FR-0710KL', 'CP2 divider bottom.', xy=(67.2, 10.0))
    add('R35', '59k 1%', 'R_0603', two('MUX_ILM', 'GND'), 'RC0603FR-0759KL', 'TPS2121 current limit 65.2/59^0.861 = 1.95 A typ, above BQ24074 ILIM max 1.073 A.', xy=(70.0, 1.7))
    add('C39', '100nF 50V X7R', 'C_0603', two('MUX_SS', 'GND'), 'CC0603KRX7R9BB104', 'TPS2121 soft start, about 780 V/s at 5 V (datasheet Table 9-1).', xy=(66.9, 1.7))
    add('C40', '10uF 16V X5R', 'C_0805', two('VIN_SEL', 'GND'), 'CL21A106KOCLRNC', 'Mux output bulk. With C1 about 14.7 uF nominal: 1 A x 5 us switchover dip about 0.34 V.', xy=(66.4, 12.0))
    add('C41', '1uF 16V X7R', 'C_0603', two('VBUS', 'GND'), 'C0603C105K4RACTU', 'TPS2121 IN2 (USB) local capacitor. USB VBUS total stays below 10 uF.', xy=(66.3, 6.2))
    add('C42', '1uF 16V X7R', 'C_0603', two('5V_FIELD', 'GND'), 'C0603C105K4RACTU', 'TPS2121 IN1 (field) local capacitor.', xy=(71.2, 6.0))
    add('R36', '10k 1%', 'R_0603', two('PWR_SRC', '3V3'), 'RC0603FR-0710KL', 'ST pull-up (datasheet 6-20k). High = field/IN1 or no output, low = USB/IN2.', xy=(71.0, 12.2))
    add('JP2', 'USB PRIORITY', 'SolderJumper_2_Open', two('MUX_PR1', 'GND'), 'PCB copper',
        'Open by default (field priority). Bridge for bench work to make USB win whenever valid; with USB absent the field input still powers the board.', xy=(70.5, 11.8))
    # Boot permission / charger mode OR gate.
    add('U11', 'SN74LVC1G0832DBVR', 'TI_DBV0006A', {1: 'FIELD_PG', 2: 'GND', 3: 'PWR_SRC', 4: 'SOURCE_QUALIFIED', 5: '3V3', 6: 'USB_HIGH_CURRENT'},
        'SN74LVC1G0832DBVR', 'AND-OR: SOURCE_QUALIFIED = (FIELD_PG AND PWR_SRC) OR USB_HIGH_CURRENT. Field qualifies only while U10 actually selects IN1 (ST high), so JP2/USB-priority on a weak USB port can no longer select BQ ILIM. TI SCES606: Y=(A.B)+C, inputs 5.5 V tolerant, Ioff.',
        {1: 'A', 2: 'GND', 3: 'B', 4: 'Y', 5: 'VCC', 6: 'C'}, xy=(68.5, 14.0), pin_types={1: 'input', 2: 'power_in', 3: 'input', 4: 'output', 5: 'power_in', 6: 'input'})
    add('C43', '100nF 50V X7R', 'C_0603', two('3V3', 'GND'), 'CC0603KRX7R9BB104', 'U11 local decoupling.', xy=(68.5, 16.5))
    add('R37', '100k 1%', 'R_0603', two('FIELD_PG', 'GND'), 'RC0603FR-07100KL',
        'FIELD_PG pulldown. Pull-up lives on the interface board from 5V_FIELD, so an absent/unpowered field converter can never qualify a weak USB port.', group='Interface', xy=(70.6, 16.5))
    # Interface daughterboard connector (back side; the interface board stacks behind the reader).
    add('J6', 'INTERFACE 2x5 1.27', 'Header_2x05_P1.27mm_THT',
        {1: '5V_FIELD', 2: '5V_FIELD', 3: 'GND', 4: 'GND', 5: '3V3', 6: 'FIELD_PG', 7: 'NFC_SDA', 8: 'NFC_SCL', 9: 'IO_INT', 10: 'PWR_SRC'},
        'FTSH-105-01-L-D',
        'Board-to-board link to the interface daughterboard (field 12/24 V input, buck, OSDP, Wiegand, tamper, buzzer). Through-hole, body on the back side so the reader stays single-sided SMT. Mates with Samtec CLP-105-02 family; stack height set by case. Land is the KiCad generic 1.27 mm THT header - verify against Samtec drawing.',
        {1: '5V_FIELD', 2: '5V_FIELD', 3: 'GND', 4: 'GND', 5: '3V3', 6: 'FIELD_PG', 7: 'SDA', 8: 'SCL', 9: 'IO_INT', 10: 'PWR_SRC'},
        group='Interface', xy=(68.7, 24.0), side='B')

    copy_fp('Package_DFN_QFN.pretty', 'Texas_VQFN-HR-12_2x2.5mm_P0.5mm', 'TI_RUX0012A')
    copy_fp('Connector_PinHeader_1.27mm.pretty', 'PinHeader_2x05_P1.27mm_Vertical', 'Header_2x05_P1.27mm_THT')
    copy_fp('Jumper.pretty', 'SolderJumper-2_P1.3mm_Open_Pad1.0x1.5mm', 'SolderJumper_2_Open')

    d['outline'] = [[0, 0], [3, 0], [3, 1.6], [11.5, 1.6], [11.5, 0], [47, 0], [47, -2], [60, -2], [60, 0], [72.0, 0], [72.0, 37.0], [65.5, 37.0], [65.5, 45.2], [61.5, 45.2], [61.5, 38.7], [48.1, 38.7], [48.1, 45.2], [0, 45.2]]
    d['variant'] = 'PN7160 v0.5 reader-interface candidate'
    d['engineering_status'] = 'HOLD_DESIGN_CANDIDATE_NOT_ROUTED_NOT_TESTED'
    d['field_power_profile'] = {
        'mux': 'U10 TPS2121 IN1=5V_FIELD priority, IN2=USB VBUS, XCOMP fast switchover; JP2 bridge = USB priority',
        'permission': 'SOURCE_QUALIFIED = (FIELD_PG AND PWR_SRC) OR USB_HIGH_CURRENT (U11 SN74LVC1G0832) -> BQ EN2 and JP1.1',
        'outline': 'Grown 6.5 mm on the right edge (x 65.5 -> 72.0) for y 0..37; stops above the Wi-Fi antenna keepout (y >= 38.7). J2 battery connector loses edge access (battery unsupported in v0.5).',
        'field_pg_qualification': 'Pull-up from 5V_FIELD on interface board; R37 100k pulldown on main board',
        'io0': 'IO_INT shared open-drain interrupt; R10/R11/C8 DNP',
        'startup_reanalysis_required': 'C9/R12 reset delay with U11 propagation and TPS2121 tSET/soft start',
        'physical_status': 'NOT TESTED'}
    g.PARTS = d['parts']
    g.SHEET_GROUPS = [('usb-power', ['USB', 'Power']), ('esp32-leds', ['MCU', 'Indicators']), ('pn7160', ['NFC', 'Test']), ('nfc-rf', ['RF']), ('field-interface', ['Interface'])]
    g.schematic()
    for path in ROOT.glob('*.kicad_sch'):
        path.write_text(path.read_text().replace('(rev "0.3")', '(rev "0.5-reader-interface-candidate")').replace('(date "2026-10-03")', '(date "2026-11-10")')
                        .replace('Fieldnote PN7160 NFC reader', 'Fieldnote PN7160 NFC reader v0.5'))
    (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (ROOT / 'output').mkdir(exist_ok=True)
    (ROOT / 'output' / 'v05-netlist-changes.json').write_text(json.dumps({'source_design_sha256': V4C_DESIGN_SHA, 'renets': changes,
        'added': [p['ref'] for p in d['parts'] if p.get('side') == 'B']}, indent=2) + '\n')
    print(json.dumps({'parts': len(d['parts']), 'renets': len(changes), 'added': [p['ref'] for p in d['parts'] if p.get('side') == 'B']}))


if __name__ == '__main__':
    main()
