#!/usr/bin/env python3
"""v0.6 single-board candidate: schematic/design-data changes on top of frozen v0.5 (source-v05/).

Owner requirements (2026-11-10): the ESP32 controls everything (no coprocessor, no second firmware), and everything
sits on the TOP side of ONE board (no stacked interface board). Decisions after the GPT-6.1 second opinion
(../fieldnote-integrated-pn7160-v0.5-reader-interface-candidate/output/second-opinion-gpt-6.1-single-board.md):
  * keep ESP32-C3-MINI-1 (C6 is footprint- but not signal-compatible: USB on pads 17/18 vs 26/27);
  * Wiegand D0/D1 are hardware-timed from native GPIOs (GPIO21 = UART_TX, GPIO0) via the C3 RMT, gated by an
    SN74LVC2G02 NOR with an active-low enable from the expander, so boot/ROM-log activity cannot reach the panel;
  * slow I/O on a TCA9539 expander and OSDP on an SC16IS740 I2C-UART, both reset by ESP_EN; both are polled
    (no interrupt pin left);
  * piezo driven by a TLC555 astable + SN74LVC1G86 XOR bridge: both terminals at 0 V when disabled.
"""
from pathlib import Path
import hashlib, json
import build_design as g

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'source-v05' / 'design-data.json'


def main():
    d = json.loads(SRC.read_text()); P = {p['ref']: p for p in d['parts']}
    log = {'source_design_sha256': hashlib.sha256(SRC.read_bytes()).hexdigest(), 'removed': [], 'renets': [], 'added': []}

    # 1. No board-to-board connector any more.
    d['parts'] = [p for p in d['parts'] if p['ref'] != 'J6']; P.pop('J6'); log['removed'].append('J6')

    # 2. IO0 is now the Wiegand D1 source (hardware-timed); R10/R11/C8 stay DNP on that net.
    for ref, pin in (('U1', '12'), ('R10', '2'), ('R11', '1'), ('C8', '1')):
        P[ref]['nets'][pin] = 'WG_D1_SRC'; log['renets'].append([ref, pin, 'IO_INT', 'WG_D1_SRC'])
    P['U1']['note'] = (P['U1'].get('note') or '') + ' v0.6: IO0 = Wiegand D1 source, TXD0 (GPIO21, UART_TX) = Wiegand D0 source, both via RMT and the U16 NOR gate.'
    P['J4']['note'] = 'DNP recovery header. Pin 3 UART_TX is also the Wiegand D0 source in v0.6 (gated by U16, so harmless while WG_EN_N is high).'
    P['R37']['note'] = 'FIELD_PG pulldown (100k). Pull-up R42 is from 5V_FIELD on this board.'

    def add(ref, value, fp, nets, mpn, note='', names=None, pin_types=None, side='F', dnp=False):
        assert ref not in P, ref
        p = dict(ref=ref, value=value, fp=fp, nets={str(k): v for k, v in nets.items()}, xy=[0, 0], angle=0, group='Interface',
                 mpn=mpn, note=note, dnp=dnp, side=side, names={str(k): v for k, v in (names or {k: str(k) for k in nets}).items()})
        if pin_types: p['pin_types'] = {str(k): v for k, v in pin_types.items()}
        d['parts'].append(p); P[ref] = p; log['added'].append(ref)
    two = lambda a, b: {1: a, 2: b}
    R = lambda ref, val, a, b, mpn, note='': add(ref, val, 'R_0603', two(a, b), mpn, note)
    C = lambda ref, val, a, b, mpn, note='', fp='C_0603': add(ref, val, fp, two(a, b), mpn, note)

    # ---- field power input (top side) ----
    add('J5', 'FIELD 10P', 'JST_GH_SM10B',
        {1: 'VIN_RAW', 2: 'GND', 3: 'WG_D0', 4: 'WG_D1', 5: 'PANEL_LED', 6: 'PANEL_BZR', 7: 'RS485_A', 8: 'RS485_B', 9: 'TAMPER_OUT', 10: 'GND', 'MP': 'GND'},
        'SM10B-GHS-TB(LF)(SN)', 'Field pigtail on the top side at the board edge: 1 +V 12/24 VDC, 2 GND, 3 D0, 4 D1, 5 LED in, 6 beeper in, 7 RS-485 A, 8 RS-485 B, 9 tamper out, 10 shield. Opening faces the board edge.',
        names={1: '+V', 2: 'GND', 3: 'D0', 4: 'D1', 5: 'LED', 6: 'BZR', 7: 'A', 8: 'B', 9: 'TAMPER', 10: 'SHIELD', 'MP': 'MP'})
    add('F1', 'PTC 0.5A hold >=60V', 'Fuse_1812', two('VIN_RAW', 'VIN_FUSED'), 'TBD', 'Resettable fuse, 1812, >=60 V, ~0.5 A hold.')
    add('D5', 'SMAJ33A', 'D_SMA', two('VIN_FUSED', 'GND'), 'SMAJ33A', 'Surge clamp; forward-conducts on reverse polarity so F1 trips. Check clamp at surge current vs U12 abs max.', {1: 'K', 2: 'A'})
    add('D6', 'SS16 60V 1A', 'D_SMA', two('VIN_PROT', 'VIN_FUSED'), 'SS16-E3/61T', 'Series reverse-polarity Schottky.', {1: 'K', 2: 'A'})
    C('C44', '2.2uF 100V X7R', 'VIN_PROT', 'GND', 'GRM32ER72A225KA35L', 'Buck input (TI LMR36510 Table 8-1).', 'C_1210')
    C('C45', '220nF 100V X7R', 'VIN_PROT', 'GND', 'TBD', 'Buck HF input bypass at VIN/PGND.', 'C_0805')
    add('U12', 'LMR36510ADDAR', 'TI_DDA0008J_HSOP8',
        {1: 'GND', 2: 'VIN_PROT', 3: 'BUCK_EN', 4: 'FIELD_PG', 5: 'BUCK_FB', 6: 'BUCK_VCC', 7: 'BUCK_BOOT', 8: 'SW_BUCK', 9: 'GND'},
        'LMR36510ADDAR', '4.2-65 V, 1 A, 400 kHz buck -> 5V_FIELD (TPS2121 IN1). Values from TI Table 8-1 for 5 V/400 kHz.',
        {1: 'PGND', 2: 'VIN', 3: 'EN', 4: 'PG', 5: 'FB', 6: 'VCC', 7: 'BOOT', 8: 'SW', 9: 'PAD'},
        {1: 'power_in', 2: 'power_in', 3: 'input', 4: 'open_collector', 5: 'input', 6: 'power_out', 7: 'passive', 8: 'output', 9: 'passive'})
    R('R38', '432k 1%', 'VIN_PROT', 'BUCK_EN', 'RC0603FR-07432KL', 'EN divider: start about 6.55 V, stop about 5.96 V.')
    R('R39', '100k 1%', 'BUCK_EN', 'GND', 'RC0603FR-07100KL', 'EN divider bottom.')
    C('C46', '1uF 16V X7R', 'BUCK_VCC', 'GND', 'C0603C105K4RACTU', 'VCC LDO capacitor.')
    C('C47', '100nF 50V X7R', 'BUCK_BOOT', 'SW_BUCK', 'CC0603KRX7R9BB104', 'Bootstrap capacitor.')
    add('L4', '22uH', 'L_SRN6045TA', two('SW_BUCK', '5V_FIELD'), 'SRN6045TA-220M', '22 uH per Table 8-1; confirm Isat >= 1.5 A.')
    C('C48', '22uF 10V X5R', '5V_FIELD', 'GND', 'C0805C226M8PACTU', 'Buck output.', 'C_0805')
    C('C49', '22uF 10V X5R', '5V_FIELD', 'GND', 'C0805C226M8PACTU', 'Buck output.', 'C_0805')
    R('R40', '100k 1%', '5V_FIELD', 'BUCK_FB', 'RC0603FR-07100KL', 'RFBT.')
    R('R41', '24.9k 1%', 'BUCK_FB', 'GND', 'RC0603FR-0724K9L', 'RFBB for 5.0 V.')
    R('R42', '10k 1%', 'FIELD_PG', '5V_FIELD', 'RC0603FR-0710KL', 'PG pull-up from 5V_FIELD (no field = no qualification); with R37 100k high level about 4.5 V into 5.5 V-tolerant inputs.')

    # ---- OSDP: I2C-UART + RS-485 ----
    add('U13', 'SC16IS740IPW', 'TSSOP-16',
        {1: '3V3', 2: '3V3', 3: '3V3', 4: None, 5: 'NFC_SCL', 6: 'NFC_SDA', 7: None, 8: '3V3', 9: 'GND', 10: 'RS485_RTS', 11: 'GND', 12: 'RS485_DI', 13: 'RS485_RO', 14: 'ESP_EN', 15: 'XTAL1', 16: 'XTAL2'},
        'SC16IS740IPW,128', 'I2C UART for OSDP at 0x48 (A1=A0=VDD; confirm with NXP table). ~RESET tied to ESP_EN. ~IRQ unused: polled (64-byte FIFO, 5.6 ms at 115200; firmware must bound service latency). Auto RS-485 direction on ~RTS with EFCR.RTSINVER (bit 5) so RTS is high while transmitting. ~RTS resets HIGH (MCR[1]=0), so DE is gated by U19 with RS485_EN.',
        {1: 'VDD', 2: 'A0', 3: 'A1', 4: 'SO', 5: 'SCL', 6: 'SDA', 7: '~IRQ', 8: 'I2C/~SPI', 9: 'VSS', 10: '~RTS', 11: '~CTS', 12: 'TX', 13: 'RX', 14: '~RESET', 15: 'XTAL1', 16: 'XTAL2'},
        {1: 'power_in', 2: 'input', 3: 'input', 5: 'input', 6: 'bidirectional', 8: 'input', 9: 'power_in', 10: 'output', 11: 'input', 12: 'output', 13: 'input', 14: 'input', 15: 'input', 16: 'output'})
    add('Y2', '14.7456MHz', 'Crystal_3225_4P', {1: 'XTAL1', 2: 'GND', 3: 'XTAL2', 4: 'GND'}, 'TBD', 'Exact 9600-115200 baud. Select CL, then recompute C50/C51.')
    C('C50', '18pF C0G', 'XTAL1', 'GND', 'CC0603JRNPO9BN180', 'Load capacitor (CL about 12 pF assumed).')
    C('C51', '18pF C0G', 'XTAL2', 'GND', 'CC0603JRNPO9BN180', '')
    C('C52', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U13 decoupling.')
    add('U14', 'THVD1450DR', 'SOIC-8', {1: 'RS485_RO', 2: 'RS485_DE', 3: 'RS485_DE', 4: 'RS485_DI', 5: 'GND', 6: 'RS485_A', 7: 'RS485_B', 8: '3V3'},
        'THVD1450DR', '3.3 V RS-485, +-18 kV IEC ESD, fail-safe receiver. ~RE tied to DE (half-duplex; no echo).',
        {1: 'R', 2: '~RE', 3: 'DE', 4: 'D', 5: 'GND', 6: 'A', 7: 'B', 8: 'VCC'},
        {1: 'output', 2: 'input', 3: 'input', 4: 'input', 5: 'power_in', 6: 'bidirectional', 7: 'bidirectional', 8: 'power_in'})
    C('C53', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U14 decoupling.')
    add('U19', 'SN74LVC1G08DBVR', 'SOT23-5', {1: 'RS485_RTS', 2: 'RS485_EN', 3: 'GND', 4: 'RS485_DE', 5: '3V3'}, 'SN74LVC1G08DBVR',
        'DE = RTS AND RS485_EN. SC16IS740 ~RTS resets HIGH (NXP datasheet, MCR[1] reset 0 = RTS inactive HIGH), which would enable the driver and jam the shared OSDP bus while the ESP32 is in reset or unconfigured. RS485_EN comes from the expander (default low).',
        {1: 'A', 2: 'B', 3: 'GND', 4: 'Y', 5: 'VCC'}, {1: 'input', 2: 'input', 3: 'power_in', 4: 'output', 5: 'power_in'})
    C('C60', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U19 decoupling.')
    R('R60', '100k 1%', 'RS485_EN', 'GND', 'RC0603FR-07100KL', 'RS-485 driver disabled while the expander is reset.')
    R('R43', '10k 1%', 'RS485_RO', '3V3', 'RC0603FR-0710KL', 'RX idle-high while receiver disabled.')
    add('D7', 'SM712', 'SOT-23', {1: 'RS485_A', 2: 'RS485_B', 3: 'GND'}, 'SM712.TCT', '-7/+12 V RS-485 TVS.', {1: 'IO1', 2: 'IO2', 3: 'GND'})
    R('R44', '120R 1%', 'RS485_A', 'RS485_TERM', 'RC0603FR-07120RL', 'Termination via JP3 at the end of line only.')
    add('JP3', 'RS-485 TERM', 'SolderJumper_2_Open', two('RS485_TERM', 'RS485_B'), 'PCB copper', 'Open by default.')

    # ---- slow I/O expander ----
    add('U15', 'TCA9539PWR', 'TSSOP-24',
        {1: None, 2: 'GND', 3: 'ESP_EN', 4: 'WG_EN_N', 5: 'TAMPER_DRV', 6: None, 7: None, 8: None, 9: 'TAMPER_SENSE', 10: 'PWR_SRC', 11: 'FIELD_PG',
         12: 'GND', 13: 'RS485_EN', 14: 'BZR_EN', 15: 'LED_SENSE', 16: 'BZR_SENSE', 17: None, 18: None, 19: None, 20: None, 21: 'GND', 22: 'NFC_SCL', 23: 'NFC_SDA', 24: '3V3'},
        'TCA9539PWR', 'I2C 0x74 (A1=A0=GND). ~RESET tied to ESP_EN; reset returns all ports to inputs, so every driven function has a defined pull. ~INT unused (polled). Port map: P00 WG_EN_N, P01 TAMPER_DRV, P05 TAMPER_SENSE, P06 PWR_SRC, P07 FIELD_PG, P10 RS485_EN, P11 BZR_EN, P12 LED_SENSE, P13 BZR_SENSE (moved from P02-P04 so they leave on the open side). Unused ports: firmware sets output-low. TI datasheet pin table verified.',
        {1: '~INT', 2: 'A1', 3: '~RESET', 4: 'P00', 5: 'P01', 6: 'P02', 7: 'P03', 8: 'P04', 9: 'P05', 10: 'P06', 11: 'P07', 12: 'GND', 13: 'P10', 14: 'P11', 15: 'P12', 16: 'P13', 17: 'P14', 18: 'P15', 19: 'P16', 20: 'P17', 21: 'A0', 22: 'SCL', 23: 'SDA', 24: 'VCC'},
        {2: 'input', 3: 'input', 12: 'power_in', 21: 'input', 22: 'input', 23: 'bidirectional', 24: 'power_in', **{i: 'bidirectional' for i in range(4, 12)}})
    C('C54', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U15 decoupling.')
    R('R45', '10k 1%', 'WG_EN_N', '3V3', 'RC0603FR-0710KL', 'Wiegand disabled (high) whenever the expander is reset or unconfigured.')

    # ---- hardware-timed Wiegand ----
    add('U16', 'SN74LVC2G02DCUR', 'VSSOP-8_DCU', {1: 'UART_TX', 2: 'WG_EN_N', 3: 'WG_D1_GATE', 4: 'GND', 5: 'WG_D1_SRC', 6: 'WG_EN_N', 7: 'WG_D0_GATE', 8: '3V3'},
        'SN74LVC2G02DCUR', 'Dual NOR: gate = NOT(src OR WG_EN_N). Line asserted only while the native GPIO is LOW and WG_EN_N is LOW. GPIO idle-high/pulled-up and expander reset both release the line. TI pinout verified.',
        {1: '1A', 2: '1B', 3: '2Y', 4: 'GND', 5: '2A', 6: '2B', 7: '1Y', 8: 'VCC'},
        {1: 'input', 2: 'input', 3: 'output', 4: 'power_in', 5: 'input', 6: 'input', 7: 'output', 8: 'power_in'})
    C('C55', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U16 decoupling.')
    R('R46', '10k 1%', 'WG_D1_SRC', '3V3', 'RC0603FR-0710KL', 'IO0 pull-up: released while the GPIO is an input.')
    R('R47', '10k 1%', 'UART_TX', '3V3', 'RC0603FR-0710KL', 'GPIO21 pull-up. Production: disable the ROM boot log by eFuse so TXD0 stays idle-high through resets.')
    for q, rr, gate, line in (('Q1', 'R48', 'WG_D0_GATE', 'WG_D0'), ('Q2', 'R49', 'WG_D1_GATE', 'WG_D1')):
        add(q, '2N7002K', 'SOT-23', {1: gate, 2: 'GND', 3: line}, '2N7002K-7', f'Open-drain Wiegand {line[-2:]}; panel supplies the pull-up.', {1: 'G', 2: 'S', 3: 'D'})
        R(rr, '100k 1%', gate, 'GND', 'RC0603FR-07100KL', 'Gate pulldown when U16 is unpowered.')
    add('D8', 'PESD24VS2UT', 'SOT-23', {1: 'WG_D0', 2: 'WG_D1', 3: 'GND'}, 'PESD24VS2UT,215', '24 V standoff line clamp.', {1: 'K1', 2: 'K2', 3: 'A'})

    # ---- panel LED / beeper inputs ----
    for rp, dd, line, sense in (('R50', 'D9', 'PANEL_LED', 'LED_SENSE'), ('R51', 'D10', 'PANEL_BZR', 'BZR_SENSE')):
        R(rp, '10k 1%', '3V3', sense, 'RC0603FR-0710KL', 'Pull-up; idle/high/undriven line reads high.')
        add(dd, '1N4148W', 'D_SOD-123', two(line, sense), '1N4148W-7-F', 'Blocking diode, cathode to panel line: no injection into 3V3 from a driven or live line.', {1: 'K', 2: 'A'})
    add('D11', 'PESD24VS2UT', 'SOT-23', {1: 'PANEL_LED', 2: 'PANEL_BZR', 3: 'GND'}, 'PESD24VS2UT,215', '24 V standoff line clamp.', {1: 'K1', 2: 'K2', 3: 'A'})

    # ---- tamper (switch on the back: the one part that must face the wall) ----
    R('R52', '1k 1%', 'TAMPER_DRV', 'TAMPER_SW_IN', 'RC0603FR-071KL', 'Series drive into tamper switch.')
    add('SW3', 'TAMPER', 'SW_PTS810', two('TAMPER_SW_IN', 'TAMPER_GATE'), 'PTS810 SJM 250 SMTR LFS',
        'BACK SIDE (must touch the mounting plate). In series with Q3 gate drive: case open = tamper output open regardless of firmware.', side='B')
    R('R53', '100k 1%', 'TAMPER_GATE', 'GND', 'RC0603FR-07100KL', 'Gate pulldown.')
    R('R54', '10k 1%', 'TAMPER_GATE', 'TAMPER_SENSE', 'RC0603FR-0710KL', 'Switch read-back (valid while TAMPER_DRV is high).')
    add('Q3', '2N7002K', 'SOT-23', {1: 'TAMPER_GATE', 2: 'GND', 3: 'TAMPER_OUT'}, '2N7002K-7', 'Tamper output: conducting = normal; open = tamper, no power or expander reset.', {1: 'G', 2: 'S', 3: 'D'})
    add('D12', 'PESD24VS2UT', 'SOT-23', {1: 'TAMPER_OUT', 2: None, 3: 'GND'}, 'PESD24VS2UT,215', 'Tamper line clamp.', {1: 'K1', 2: 'K2', 3: 'A'})

    # ---- piezo: TLC555 astable + XOR bridge, 0 V across the element when disabled ----
    add('U17', 'TLC555CDGKR', 'VSSOP-8_DGK', {1: 'GND', 2: 'BZ_TIM', 3: 'BZ_OSC', 4: 'BZR_EN', 5: 'BZ_CONT', 6: 'BZ_TIM', 7: 'BZ_DIS', 8: '3V3'},
        'TLC555CDGKR', 'Astable about 4.0 kHz: f = 1.44/((Ra + 2Rb)C) = 1.44/((1k + 34.8k) x 10 nF). ~RESET = BZR_EN (expander, pulldown) forces OUT low.',
        {1: 'GND', 2: 'TRIG', 3: 'OUT', 4: '~RESET', 5: 'CONT', 6: 'THRES', 7: 'DISCH', 8: 'VCC'},
        {1: 'power_in', 2: 'input', 3: 'output', 4: 'input', 5: 'passive', 6: 'input', 7: 'passive', 8: 'power_in'})
    R('R55', '1k 1%', '3V3', 'BZ_DIS', 'RC0603FR-071KL', 'Ra.')
    R('R56', '17.4k 1%', 'BZ_DIS', 'BZ_TIM', 'RC0603FR-0717K4L', 'Rb.')
    C('C56', '10nF C0G 50V', 'BZ_TIM', 'GND', 'TBD', 'Timing capacitor, C0G.')
    C('C57', '10nF 50V X7R', 'BZ_CONT', 'GND', 'TBD', 'CONT bypass.')
    C('C58', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U17 decoupling.')
    R('R57', '100k 1%', 'BZR_EN', 'GND', 'RC0603FR-07100KL', 'Buzzer off while the expander is reset.')
    add('U18', 'SN74LVC1G86DBVR', 'SOT23-5', {1: 'BZ_OSC', 2: 'BZR_EN', 3: 'GND', 4: 'BZ_OSCN', 5: '3V3'}, 'SN74LVC1G86DBVR',
        'XOR: BZ_OSCN = BZ_OSC XOR BZR_EN. Disabled: OSC=0, EN=0 -> both piezo terminals 0 V (fixes the inverter idle-bias issue). Enabled: complementary -> about 6.6 Vp-p bridge. TI pinout verified.',
        {1: 'A', 2: 'B', 3: 'GND', 4: 'Y', 5: 'VCC'}, {1: 'input', 2: 'input', 3: 'power_in', 4: 'output', 5: 'power_in'})
    C('C59', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U18 decoupling.')
    R('R58', '100R 1%', 'BZ_OSC', 'BZR_P_R', 'RC0603FR-07100RL', 'Piezo series resistor.')
    R('R59', '100R 1%', 'BZ_OSCN', 'BZR_N_R', 'RC0603FR-07100RL', 'Piezo series resistor.')
    add('BZ1', 'PUI SMT-1240-S-HT', 'PUI_SMT-1240-S-HT', two('BZR_P_R', 'BZR_N_R'), 'SMT-1240-S-HT',
        '12 x 12 x 2.8 mm SMD piezo, 78 dBA min at 3 Vp-p / 4 kHz, about 1 mA, -40 to +105 C. Side sound port to a case vent.')

    d['variant'] = 'PN7160 v0.6 single-board candidate'
    d['engineering_status'] = 'HOLD_SCHEMATIC_CANDIDATE_LAYOUT_PENDING_NOT_TESTED'
    d['v06_profile'] = {
        'controller': 'ESP32-C3 controls everything; TCA9539 (0x74) + SC16IS740 (0x48) on the NFC I2C bus, both ~RESET = ESP_EN, both polled',
        'wiegand': 'GPIO21 (UART_TX) -> D0, GPIO0 -> D1, RMT-timed; U16 NOR gates with WG_EN_N (expander, default high)',
        'buzzer': 'TLC555 ~4 kHz + LVC1G86 XOR bridge, BZR_EN from expander (default low)',
        'field_input': 'J5 JST GH 10, F1, SMAJ33A, SS16, LMR36510 -> 5V_FIELD -> U10 IN1; FIELD_PG -> U11 A and expander',
        'back_side_parts': ['SW3 tamper switch (must touch the mounting plate)'],
        'open': ['reset/fault-state table', 'eFuse ROM-log disable plan for GPIO21', 'panel timing matrix', 'power/surge budget', 'antenna 15 mm keepout and enclosure'],
        'physical_status': 'NOT TESTED'}
    g.PARTS = d['parts']
    g.SHEET_GROUPS = [('usb-power', ['USB', 'Power']), ('esp32-leds', ['MCU', 'Indicators']), ('pn7160', ['NFC', 'Test']), ('nfc-rf', ['RF']), ('field-interface', ['Interface'])]
    g.schematic()
    for path in ROOT.glob('*.kicad_sch'):
        t = path.read_text().replace('(rev "0.3")', '(rev "0.6-single-board-candidate")').replace('(date "2026-10-03")', '(date "2026-11-10")')
        path.write_text(t.replace('Fieldnote PN7160 NFC reader', 'Fieldnote PN7160 NFC reader v0.6'))
    (ROOT / 'design-data.json').write_text(json.dumps(d, indent=2) + '\n')
    (ROOT / 'output' / 'v06-netlist-changes.json').write_text(json.dumps(log, indent=2) + '\n')
    print(json.dumps({'parts': len(d['parts']), 'added': len(log['added']), 'removed': log['removed'], 'tbd': [p['ref'] for p in d['parts'] if p['mpn'] == 'TBD']}))


if __name__ == '__main__':
    main()
