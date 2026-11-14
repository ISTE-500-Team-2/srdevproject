# Fieldnote interface board v0.1 — SCHEMATIC CANDIDATE, HOLD

Daughterboard that stacks behind the Fieldnote PN7160 v0.5 reader
(`../fieldnote-integrated-pn7160-v0.5-reader-interface-candidate/`) and connects it to an existing,
already-listed access-control panel. The panel keeps the lock relay, door inputs, REX and fire-alarm release.

Status: schematic (50 parts, ERC 0) and **first-pass placement** (`place_interface.py`, 0 placement errors, not routed). Not simulated, not tested.
Revised 2026-11-10 after the GPT-6.1 review (`../fieldnote-integrated-pn7160-v0.5-reader-interface-candidate/output/review-gpt-6.1.md`).

Rebuild: `KiCad python build_interface.py`, then `kicad-cli sch erc fieldnote-interface.kicad_sch`.
`design-data.json` is the source of truth; schematic sheets are generated from it.

## What changed after review

| Finding | Change |
|---|---|
| I2C-expander Wiegand is not deterministic; the TCA9535 keeps outputs through an ESP32 reset (line can stick low) | TCA9535 + SC16IS740 + crystal replaced by **U2 STM32G031F6P6** coprocessor: timer-driven Wiegand, USART2 with hardware RS-485 driver-enable, own watchdog. All outputs default off (gate pulldowns). |
| 15 V clamps on lines described as 24 V-tolerant | **PESD24VS2UT** (24 V standoff) on all panel lines; lines are specified 24 V nominal maximum. |
| Sense clamps could inject current into 3V3 / back-power an unpowered reader | Panel LED/beeper inputs are now a 10k pull-up plus a **1N4148W blocking diode** to the line. Panel sinking reads about 0.6 V (low). A driven 5–24 V line or an unpowered reader reverse-biases the diode: no injection. |
| A hung controller could hold the tamper output "normal" after the case opens | **SW1 is in series with Q3's gate drive** (R14 -> SW1 -> gate, R17 pulldown). Opening the case opens the tamper output whatever the firmware does. R15 reads the gate node, so switch state is readable only while firmware drives TAMPER_DRV high (the normal state). In alarm (drive low), firmware must pulse the drive to re-read the switch. |
| 12 mm x 9.5 mm self-drive buzzer set the stack depth | **BZ1 = PUI SMT-1240-S-HT** SMD piezo, 12 x 12 x **2.8 mm**, 78 dBA min at 3 Vp-p / 4 kHz, about 1 mA, -40 to +105 C. Bridge-driven from U2 TIM1_CH1/CH1N (PA8/PA7) through R18/R19 100R (about 6.6 Vp-p; loudness to be measured). Q4/D9 removed. Lower than J1 (about 4.3 mm) and L1 (4.5 mm), so it no longer adds stack depth. Footprint pads from the PUI suggested land pattern (verify before fab); the 3D model is a scaled Murata stand-in. |

## Sheets

- **field-power**: J1 field pigtail, F1 PTC, D1 SMAJ33A TVS, D2 reverse-polarity Schottky,
  U1 LMR36510 (4.2–65 V, 1 A, 400 kHz) -> `5V_FIELD`. Component values follow TI datasheet
  Table 8-1 for 5 V / 400 kHz. EN divider 432k/100k: starts at about 6.55 V and stops at about 5.96 V. 5 V
  panel ports are deliberately unsupported; document this. `FIELD_PG` is pulled up from `5V_FIELD` (R5).
- **reader-link**: J2 Samtec CLP-105 socket, mates reader J6 (through-hole FTSH-105-01-L-D) pin-for-pin.
  The pins carry 5V_FIELD x2, GND x2, 3V3, FIELD_PG, SDA, SCL, IO_INT and PWR_SRC.
- **panel-interface**: U2 coprocessor (I2C target, address 0x30 in firmware) with C8/C9/C10 and J3 Tag-Connect SWD;
  U4 THVD1450 RS-485 (D3 SM712, JP1/R9 termination); Q1/Q2 Wiegand; D7/D8 blocking-diode inputs; tamper interlock; BZ1 buzzer.

## Coprocessor pin map (U2, TSSOP-20)

| Pin | Port | Function |
|---|---|---|
| 1 / 20 | PB7 / PB6 | I2C1 SDA / SCL to reader (AF6 to confirm in CubeMX; bonded twins PB8, PB3–PB5 stay inputs) |
| 8 / 9 / 10 | PA1 / PA2 / PA3 | USART2 DE / TX / RX -> THVD1450 (OSDP) |
| 11 / 12 | PA4 / PA5 | Wiegand D0 / D1 drive |
| 13 | PA6 | Tamper drive |
| 14 / 15 | PA7 / PA8 | Piezo bridge: TIM1_CH1N / TIM1_CH1 (AF to confirm in CubeMX) |
| 7 / 3 / 2 | PA0 / PC15 / PB9 | LED sense / beeper sense / tamper sense |
| 17 | PA10 | PWR_SRC (high = field selected) |
| 16 | PA9 | IO_INT open-drain to reader IO0 |
| 6 / 18 / 19 | NRST / PA13 / PA14 | SWD (J3) |

OSDP Secure Channel runs on the ESP32. The coprocessor only moves bytes, so keys never leave the reader MCU.
The ROM I2C bootloader has reported no-ACK problems on STM32G0 in ST community threads. Factory programming
is therefore over SWD, and field updates need an application-level updater.

## Open items before layout

1. MPNs still TBD: F1 (1812 PTC, >=60 V, ~0.5 A hold) and C2 (220 nF 100 V 0805).
2. L1 SRN6045TA-220M: confirm Isat >= 1.5 A and DCR.
3. Confirm U2 alternate-function numbers (I2C1 PB6/PB7, USART2_DE PA1) in STM32CubeMX for the exact TSSOP-20 part.
4. Board outline and stack height: stay behind the reader's electronics area and the new right-edge strip, never
   behind the NFC coil (reader x < 33.1 mm, y > 10.7 mm). The case must change.
5. Power budget is unmeasured. Spec until measured: field supply >= 500 mA at 12 V (>= 250 mA at 24 V), or a dedicated Class 2 supply (matches the reader README).
6. Supported-panel matrix (supply voltage, Wiegand timing and levels, LED polarity, tamper supervision, OSDP options), then bench tests.
