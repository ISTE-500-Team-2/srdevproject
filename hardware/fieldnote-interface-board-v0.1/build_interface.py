#!/usr/bin/env python3
"""Fieldnote interface daughterboard v0.1 - schematic and design data.

Stacks behind the Fieldnote PN7160 v0.5 reader through J2 (mates reader J6, Samtec FTSH/CLP 2x5 1.27 mm).
Provides: 12/24 VDC field input -> 5V_FIELD (feeds reader TPS2121 IN1), FIELD_PG, and an STM32G031 coprocessor (I2C target)
handling OSDP RS-485, timer-driven Wiegand D0/D1, panel LED/beeper inputs, hardware-interlocked tamper output and buzzer.
All logic is powered from the reader's 3V3 through J2. MPN 'TBD' entries are unselected on purpose.
"""
from pathlib import Path
import json
import build_design as g

ROOT = Path(__file__).resolve().parent
PARTS = []

PWR_IC = {'power_in', 'power_out', 'input', 'output', 'bidirectional', 'open_collector', 'passive'}


def add(ref, value, fp, nets, mpn, note='', group='Interface', names=None, pin_types=None, dnp=False):
    p = dict(ref=ref, value=value, fp=fp, nets={str(k): v for k, v in nets.items()}, xy=[0, 0], angle=0, group=group,
             mpn=mpn, note=note, dnp=dnp, names={str(k): v for k, v in (names or {k: str(k) for k in nets}).items()})
    if pin_types:
        assert set(pin_types.values()) <= PWR_IC
        p['pin_types'] = {str(k): v for k, v in pin_types.items()}
    PARTS.append(p)


def two(a, b): return {1: a, 2: b}


def R(ref, val, a, b, mpn, note='', group='Interface'): add(ref, val, 'R_0603', two(a, b), mpn, note, group)
def C(ref, val, a, b, mpn, note='', group='Interface', fp='C_0603'): add(ref, val, fp, two(a, b), mpn, note, group)


def build():
    # ---------------- field power ----------------
    P = 'Power'
    add('J1', 'FIELD 10P', 'JST_GH_SM10B',
        {1: 'VIN_RAW', 2: 'GND', 3: 'WG_D0', 4: 'WG_D1', 5: 'PANEL_LED', 6: 'PANEL_BZR', 7: 'RS485_A', 8: 'RS485_B', 9: 'TAMPER_OUT', 10: 'GND', 'MP': 'GND'},
        'SM10B-GHS-TB(LF)(SN)', 'Field pigtail: 1 +V (12/24 VDC), 2 GND, 3 D0, 4 D1, 5 LED in, 6 beeper in, 7 RS-485 A, 8 RS-485 B, 9 tamper out, 10 shield drain. JST GH rated 1 A/pin.',
        names={1: '+V', 2: 'GND', 3: 'D0', 4: 'D1', 5: 'LED', 6: 'BZR', 7: 'A', 8: 'B', 9: 'TAMPER', 10: 'SHIELD', 'MP': 'MP'})
    add('F1', 'PTC 0.5A hold >=60V', 'Fuse_1812', two('VIN_RAW', 'VIN_FUSED'), 'TBD', 'Resettable fuse; protects panel reader-port wiring. Select a 1812 PTC rated >=60 V, ~0.5 A hold.', P)
    add('D1', 'SMAJ33A', 'D_SMA', two('VIN_FUSED', 'GND'), 'SMAJ33A', 'Unidirectional TVS: surge clamp below LMR36510 66 V transient rating; forward-conducts on reverse polarity so F1 trips.', P, {1: 'K', 2: 'A'})
    add('D2', 'SS16 60V 1A', 'D_SMA', two('VIN_PROT', 'VIN_FUSED'), 'SS16-E3/61T', 'Series reverse-polarity Schottky.', P, {1: 'K', 2: 'A'})
    C('C1', '2.2uF 100V X7R', 'VIN_PROT', 'GND', 'GRM32ER72A225KA35L', 'Buck input (TI Table 8-1: 2.2 uF + 220 nF).', P, 'C_1210')
    C('C2', '220nF 100V X7R', 'VIN_PROT', 'GND', 'TBD', 'Buck high-frequency input bypass, at VIN/PGND pins.', P, 'C_0805')
    add('U1', 'LMR36510ADDAR', 'TI_DDA0008J_HSOP8',
        {1: 'GND', 2: 'VIN_PROT', 3: 'BUCK_EN', 4: 'FIELD_PG', 5: 'BUCK_FB', 6: 'BUCK_VCC', 7: 'BUCK_BOOT', 8: 'SW_BUCK', 9: 'GND'},
        'LMR36510ADDAR', '4.2-65 V, 1 A, 400 kHz PFM buck -> 5V_FIELD. Values from TI datasheet Table 8-1 (5 V, 400 kHz).', P,
        {1: 'PGND', 2: 'VIN', 3: 'EN', 4: 'PG', 5: 'FB', 6: 'VCC', 7: 'BOOT', 8: 'SW', 9: 'PAD'},
        {1: 'power_in', 2: 'power_in', 3: 'input', 4: 'open_collector', 5: 'input', 6: 'power_out', 7: 'passive', 8: 'output', 9: 'passive'})
    R('R1', '432k 1%', 'VIN_PROT', 'BUCK_EN', 'RC0603FR-07432KL', 'EN divider top: start 1.231 V x 5.32 = 6.55 V, stop about 5.96 V (110 mV hysteresis).', P)
    R('R2', '100k 1%', 'BUCK_EN', 'GND', 'RC0603FR-07100KL', 'EN divider bottom.', P)
    C('C3', '1uF 16V X7R', 'BUCK_VCC', 'GND', 'C0603C105K4RACTU', 'VCC LDO capacitor (datasheet: 1 uF).', P)
    C('C4', '100nF 50V X7R', 'BUCK_BOOT', 'SW_BUCK', 'CC0603KRX7R9BB104', 'Bootstrap capacitor (datasheet: 100 nF BOOT-SW).', P)
    add('L1', '22uH', 'L_SRN6045TA', two('SW_BUCK', '5V_FIELD'), 'SRN6045TA-220M', '22 uH per Table 8-1. Confirm Isat >= 1.5 A and DCR at selection.', P)
    C('C5', '22uF 10V X5R', '5V_FIELD', 'GND', 'C0805C226M8PACTU', 'Output 2 x 22 uF nominal per Table 8-1; verify effective capacitance at 5 V bias.', P, 'C_0805')
    C('C6', '22uF 10V X5R', '5V_FIELD', 'GND', 'C0805C226M8PACTU', '', P, 'C_0805')
    R('R3', '100k 1%', '5V_FIELD', 'BUCK_FB', 'RC0603FR-07100KL', 'RFBT (datasheet recommended 100k).', P)
    R('R4', '24.9k 1%', 'BUCK_FB', 'GND', 'RC0603FR-0724K9L', 'RFBB for 5.0 V (Vref 1.0 V).', P)
    R('R5', '10k 1%', 'FIELD_PG', '5V_FIELD', 'RC0603FR-0710KL', 'PG pull-up from 5V_FIELD so no field power = no qualification. Reader R37 100k pulldown -> high level about 4.5 V (LVC/TCA inputs 5.5 V tolerant).', P)
    # ---------------- reader link ----------------
    L = 'Link'
    add('J2', 'READER LINK 2x5 1.27', 'Socket_2x05_P1.27mm_SMD',
        {1: '5V_FIELD', 2: '5V_FIELD', 3: 'GND', 4: 'GND', 5: '3V3', 6: 'FIELD_PG', 7: 'SDA', 8: 'SCL', 9: 'IO_INT', 10: 'PWR_SRC'},
        'CLP-105-02-F-D', 'Mates reader J6 (FTSH-105-01-F-DV-K). Pin numbers match J6 one-to-one. Stack height set by case.', L)
    C('C7', '10uF 16V X5R', '3V3', 'GND', 'CL21A106KOCLRNC', 'Local 3V3 bulk for RS-485 transmit and buzzer current.', L, 'C_0805')
    R('R6', '10k 1%', 'IO_INT', '3V3', 'RC0603FR-0710KL', 'Pull-up for the coprocessor open-drain interrupt to reader IO0.', L)
    # ---------------- coprocessor ----------------
    add('U2', 'STM32G031F6P6', 'TSSOP-20',
        {1: 'SDA', 2: 'TAMPER_SENSE', 3: 'BZR_SENSE', 4: '3V3', 5: 'GND', 6: 'MCU_NRST', 7: 'LED_SENSE', 8: 'RS485_DE', 9: 'RS485_DI', 10: 'RS485_RO',
         11: 'WG_D0_DRV', 12: 'WG_D1_DRV', 13: 'TAMPER_DRV', 14: 'BZR_N', 15: 'BZR_P', 16: 'IO_INT', 17: 'PWR_SRC', 18: 'SWDIO', 19: 'SWCLK', 20: 'SCL'},
        'STM32G031F6P6',
        'Interface coprocessor (replaces TCA9535 + SC16IS740 after review). I2C target to the reader (address 0x30, firmware). '
        'USART2 with hardware driver-enable (PA1 RTS_DE, PA2 TX, PA3 RX) for OSDP; timer-driven Wiegand; independent watchdog releases '
        'Wiegand/tamper/buzzer outputs (all default high-Z with gate pulldowns). OSDP Secure Channel stays on the ESP32 (keys never leave it). '
        'Bonded pads: pin 1 = PB7/PB8, pin 20 = PB3-PB6, pin 15 = PA8/PB0-PB2, pin 16 = PA9/PA11: keep the unused twins as inputs. '
        'Piezo BZ1 bridge-driven by TIM1_CH1 (PA8, pin 15) and TIM1_CH1N (PA7, pin 14) in complementary PWM at about 4 kHz: about 6.6 Vp-p across the transducer. '
        'I2C1 on PB6/PB7 and TIM1 on PA7/PA8 (AF2) to be confirmed in CubeMX. Factory programming over SWD (J3).',
        names={1: 'PB7/PB8', 2: 'PB9/PC14', 3: 'PC15', 4: 'VDD', 5: 'VSS', 6: 'PF2-NRST', 7: 'PA0', 8: 'PA1', 9: 'PA2', 10: 'PA3', 11: 'PA4', 12: 'PA5',
               13: 'PA6', 14: 'PA7', 15: 'PA8/PB0-2', 16: 'PA9/PA11', 17: 'PA10/PA12', 18: 'PA13-SWDIO', 19: 'PA14-SWCLK', 20: 'PB3-6'},
        pin_types={4: 'power_in', 5: 'power_in', **{i: 'bidirectional' for i in [1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]}})
    C('C8', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U2 VDD decoupling, at pin 4.')
    C('C9', '1uF 16V X7R', '3V3', 'GND', 'C0603C105K4RACTU', 'U2 VDD bulk.')
    C('C10', '100nF 50V X7R', 'MCU_NRST', 'GND', 'CC0603KRX7R9BB104', 'NRST filter capacitor (ST recommends 100 nF).')
    add('J3', 'SWD TC2030', 'TagConnect_TC2030_NL', {1: '3V3', 2: 'SWDIO', 3: 'MCU_NRST', 4: 'SWCLK', 5: 'GND', 6: None},
        'PCB only', 'Tag-Connect TC2030-NL SWD pads: 1 VCC, 2 SWDIO, 3 NRST, 4 SWCLK, 5 GND, 6 SWO (unused).',
        names={1: 'VCC', 2: 'SWDIO', 3: 'NRST', 4: 'SWCLK', 5: 'GND', 6: 'SWO'})
    # ---------------- OSDP / RS-485 ----------------
    add('U4', 'THVD1450DR', 'SOIC-8', {1: 'RS485_RO', 2: 'RS485_DE', 3: 'RS485_DE', 4: 'RS485_DI', 5: 'GND', 6: 'RS485_A', 7: 'RS485_B', 8: '3V3'},
        'THVD1450DR', '3.3 V RS-485, +-18 kV IEC ESD, bus fail-safe receiver. ~RE tied to DE: half-duplex, receiver off while transmitting; DE driven by USART2 hardware.',
        names={1: 'R', 2: '~RE', 3: 'DE', 4: 'D', 5: 'GND', 6: 'A', 7: 'B', 8: 'VCC'},
        pin_types={1: 'output', 2: 'input', 3: 'input', 4: 'input', 5: 'power_in', 6: 'bidirectional', 7: 'bidirectional', 8: 'power_in'})
    C('C12', '100nF 50V X7R', '3V3', 'GND', 'CC0603KRX7R9BB104', 'U4 decoupling.')
    R('R8', '10k 1%', 'RS485_RO', '3V3', 'RC0603FR-0710KL', 'Holds UART RX idle-high while the receiver is disabled during transmit.')
    add('D3', 'SM712', 'SOT-23', {1: 'RS485_A', 2: 'RS485_B', 3: 'GND'}, 'SM712.TCT', 'Asymmetric -7/+12 V RS-485 line TVS.', names={1: 'IO1', 2: 'IO2', 3: 'GND'})
    R('R9', '120R 1%', 'RS485_A', 'RS485_TERM', 'RC0603FR-07120RL', 'Bus termination, enabled only by JP1 at the end of the line.')
    add('JP1', 'RS-485 TERM', 'SolderJumper_2_Open', two('RS485_TERM', 'RS485_B'), 'PCB copper', 'Open by default. Bridge only when this reader is the last device on the RS-485 line.')
    # ---------------- Wiegand out ----------------
    for q, rr, drv, line in (('Q1', 'R10', 'WG_D0_DRV', 'WG_D0'), ('Q2', 'R11', 'WG_D1_DRV', 'WG_D1')):
        add(q, '2N7002K', 'SOT-23', {1: drv, 2: 'GND', 3: line}, '2N7002K-7', f'Open-drain {line[-2:]} pull-down; panel supplies the pull-up (usually 5 V, up to 12 V).', names={1: 'G', 2: 'S', 3: 'D'})
        R(rr, '100k 1%', drv, 'GND', 'RC0603FR-07100KL', 'Gate pulldown: line released (idle high) during reset, boot or watchdog.')
    for dd, a_, b_ in (('D4', 'WG_D0', 'WG_D1'), ('D5', 'PANEL_LED', 'PANEL_BZR'), ('D6', 'TAMPER_OUT', None)):
        add(dd, 'PESD24VS2UT', 'SOT-23', {1: a_, 2: b_, 3: 'GND'}, 'PESD24VS2UT,215',
            '24 V standoff line clamp (was 15 V; review finding). Lines rated 24 V nominal maximum.', names={1: 'K1', 2: 'K2', 3: 'A'})
    # ---------------- panel LED / beeper inputs (no injection into 3V3) ----------------
    for rp, dd, line, sense in (('R12', 'D7', 'PANEL_LED', 'LED_SENSE'), ('R13', 'D8', 'PANEL_BZR', 'BZR_SENSE')):
        R(rp, '10k 1%', '3V3', sense, 'RC0603FR-0710KL', 'Pull-up: idle/high/undriven line reads high.')
        add(dd, '1N4148W', 'D_SOD-123', two(line, sense), '1N4148W-7-F',
            'Blocking diode (cathode to panel line): panel sinking pulls the sense node to about 0.6 V (low); a line driven to 5-24 V, '
            'or an unpowered reader, reverse-biases it, so no current flows into 3V3. 75 V rating.', names={1: 'K', 2: 'A'})
    # ---------------- tamper (hardware interlock) ----------------
    R('R14', '1k 1%', 'TAMPER_DRV', 'TAMPER_SW_IN', 'RC0603FR-071KL', 'Series drive into the tamper switch.')
    add('SW1', 'TAMPER', 'SW_PTS810', two('TAMPER_SW_IN', 'TAMPER_GATE'), 'PTS810 SJM 250 SMTR LFS',
        'Held closed by the back plate. In series with Q3 gate drive: opening the case opens the tamper output regardless of firmware state.')
    R('R17', '100k 1%', 'TAMPER_GATE', 'GND', 'RC0603FR-07100KL', 'Gate pulldown: tamper output open unless switch closed AND firmware drives normal.')
    R('R15', '10k 1%', 'TAMPER_GATE', 'TAMPER_SENSE', 'RC0603FR-0710KL', 'Lets firmware read the switch (gate high only when driven and closed).')
    add('Q3', '2N7002K', 'SOT-23', {1: 'TAMPER_GATE', 2: 'GND', 3: 'TAMPER_OUT'}, '2N7002K-7', 'Tamper output to panel: conducting = normal, open = tamper, no power or firmware fault.', names={1: 'G', 2: 'S', 3: 'D'})
    # ---------------- buzzer: low-profile SMD piezo, bridge drive ----------------
    add('BZ1', 'PUI SMT-1240-S-HT', 'PUI_SMT-1240-S-HT', two('BZR_P_R', 'BZR_N_R'), 'SMT-1240-S-HT',
        '12 x 12 x 2.8 mm SMD piezo (was a 12 mm x 9.5 mm-tall magnetic buzzer). 78 dBA min at 3 Vp-p, 4 kHz, about 1 mA, 15 nF, '
        '-40 to +105 C (PUI datasheet). Bridge drive gives about 6.6 Vp-p (estimated ~84 dBA; measure in the case). Put the side sound port at a case vent.')
    R('R18', '100R 1%', 'BZR_P', 'BZR_P_R', 'RC0603FR-07100RL', 'Series resistor: limits charge current into the 15 nF piezo and isolates the MCU pin from shock-generated piezo voltage.')
    R('R19', '100R 1%', 'BZR_N', 'BZR_N_R', 'RC0603FR-07100RL', 'Series resistor, complementary leg.')


def main():
    build()
    refs = [p['ref'] for p in PARTS]; assert len(refs) == len(set(refs)), 'duplicate refs'
    g.PARTS = PARTS
    g.SHEET_GROUPS = [('field-power', ['Power']), ('reader-link', ['Link']), ('panel-interface', ['Interface'])]
    g.schematic()
    for path in ROOT.glob('*.kicad_sch'):
        t = path.read_text().replace('(rev "0.3")', '(rev "0.1-candidate")').replace('(date "2026-10-03")', '(date "2026-11-10")')
        t = t.replace('Fieldnote PN7160 NFC reader', 'Fieldnote interface board v0.1')
        t = t.replace('PN7160 variant; native checks in output, hardware qualification pending.', 'Interface daughterboard for Fieldnote PN7160 v0.5; not laid out, not tested.')
        t = t.replace('65.5 x 47.2 mm including USB tongue; V17 case target 68.1 x 50.5 x 10 mm.\\n3 LEDs, 1S LiPo connector, charger and power path, ESP32-C3, PN7160, PCB NFC antenna.\\nENGINEERING VARIANT: native validation tracked in output; bench RF and power qualification required.',
                      'Stacks behind Fieldnote PN7160 v0.5 via J2/J6.\\n12/24 VDC field input, OSDP RS-485, Wiegand, panel LED/beeper, tamper, buzzer.\\nSCHEMATIC CANDIDATE: layout, MPN selection and bench qualification pending.')
        path.write_text(t)
    for stale in ('fieldnote.kicad_sch',):
        (ROOT / stale).unlink(missing_ok=True)
    (ROOT / 'design-data.json').write_text(json.dumps({'board': 'Fieldnote interface board v0.1', 'status': 'SCHEMATIC_CANDIDATE_NOT_LAID_OUT_NOT_TESTED',
                                                        'mates': 'Fieldnote PN7160 v0.5 J6', 'parts': PARTS}, indent=2) + '\n')
    tbd = [p['ref'] for p in PARTS if p['mpn'] == 'TBD']
    print(json.dumps({'parts': len(PARTS), 'mpn_tbd': tbd}))


if __name__ == '__main__':
    main()
