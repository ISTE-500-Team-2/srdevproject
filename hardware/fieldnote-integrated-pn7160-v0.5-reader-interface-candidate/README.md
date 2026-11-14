# Fieldnote PN7160 v0.5 reader-interface candidate — DESIGN SPEC, HOLD

Source: the frozen v0.4 v4c snapshot, copied read-only to `source-v04c/`
(board SHA-256 `6ed6056d35972376a55a58faac274b82d1fa07bdd6ae1436a3bf3f270341b616`). A verified saved copy of
v0.4 is in `../snapshots/fieldnote-pn7160-v0.4-saved-20261110/`. The interface daughterboard is a separate
project: `../fieldnote-interface-board-v0.1/`.

## Status (2026-11-10, after GPT-6.1 review): routed, DRC-clean candidate, HOLD

Board SHA-256 `1c64f9903f6d2f3be6b658038252d0359edbaed5345d4fb8ba7a5826ac9e5167`.
Native KiCad 10 checks: ERC 0, DRC **0 errors, 0 unconnected**, schematic parity 0. The 25 warnings are all silkscreen.
All pre-existing v4c tracks and vias keep their geometry (UUID/geometry snapshot check in `output/v05b-routing.json`).

Layout B (`apply_v05b_pcb.py`, `grow_outline_text.py`, `gnd_fix_v05b.py`, driven by `run_v05b.sh`):
- **Board grows 8.5 mm on the right edge** (x 65.5 -> 74.0, y 0-37), next to USB and the charger. It stops above the
  Wi-Fi antenna keepout (y >= 38.7). Final outline 74.0 x 45.2 mm (plus the USB tongue). **The case must be redesigned**,
  which the stacked interface board requires anyway. J2 (battery, DNP) loses edge access; battery is unsupported in v0.5.
- VBUS loop cut at (63.407, 3.668)-(63.407, 4.703), so both mux power ends land about 2 mm from the strip.
  VIN_SEL: 3.8 mm front copper, no vias. VBUS: 2.5 mm plus a 6.2 mm hop with 2 vias (0.5/0.2 mm; check current rating at about 1.07 A).
- All new SMD parts on the top side (single-sided SMT). J6 is through-hole (FTSH-105-01-L-D) with its body on the back.
- U11 is SN74LVC1G0832 (AND-OR): `SOURCE_QUALIFIED = (FIELD_PG AND PWR_SRC) OR USB_HIGH_CURRENT`.
- 34 links routed and 13 local ground vias placed. Ground repairs: R5.2 via, U1.14 island via, and J6.3/J6.4 links (the new I2C
  and power routes had isolated those pour areas).

Open review items:
1. USB_HIGH_CURRENT (U11 -> U7) is 72.9 mm with 4 vias. It is a static push-pull enable level, but the long run is a noise-pickup and review item.
2. NFC_SDA 20.9 mm / NFC_SCL 28.5 mm from J6 into the I2C bus near U1. Estimated rise time is about 160 ns with 4.7k pull-ups; measure on the assembled boards.
3. 5V_FIELD J6 -> C42 is 21.9 mm at 0.4 mm. Check drop and the TPS2121 priority threshold (field must stay above 0.827 x VBUS).
4. Startup/reset timing (C9/R12 with U11 and the TPS2121 settling/soft start) is still unanalysed. Power budget and switchover transients are unmeasured.
5. Silkscreen cleanup in the new strip.
Layout A (back-side cluster behind the LED strip; 2 links unrouted) is kept for the record: `apply_v05_pcb.py`, `output/v05-wip-board.kicad_pcb`.

## Goal

Make Fieldnote a drop-in **reader** for existing, already-listed access-control panels.
The panel owns the lock relay, door inputs, REX and fire-alarm release; Fieldnote only
reads credentials and reports them. Fieldnote must run from either:

- **USB-C** (bench, service, programming), or
- **12/24 VDC field power** from the panel's reader port or a separate access-control supply,

with automatic switching between them. A fast (about 5 us typical) switchover applies only when VBUS is at least about 4.41 V; otherwise it is the slower, unmeasured path.

## 1. Power-source switching (USB-C <-> 12/24 VDC)

### Topology

```
[interface board] J1 +V -> F1 PTC -> D1 SMAJ33A -> D2 SS16 -> U1 LMR36510 buck (4.2-65 V, 1 A)
            -> 5V_FIELD -> (J2/J6) ->
                                                             \
                                                              U10 TPS2121 power mux -> VIN_SEL -> U3 BQ24074 IN (pin 13)
                                                             /
J1 USB-C VBUS (U5 ESD, R1 VBUS_DET, C41) -------------------  (C1 now sits on VIN_SEL at U3)
```

- **Field priority.** U10 IN1 = 5V_FIELD (priority, set by the PR1 divider R31/R32),
  IN2 = USB VBUS. When field power is present the board runs from it; USB carries data
  only. If field power drops, U10 switches to USB (5 us typical fast switchover only while VBUS >= about 4.41 V;
  ride-through of VSYS/3V3 is expected but unmeasured).
- **No backfeed.** U10 blocks reverse current, so field power never drives a laptop's
  VBUS and USB never drives the panel's port. (USB spec: a device must not source VBUS.)
- **Manual override.** JP2 "USB PRIORITY" (PCB solder jumper, open by default) shorts U10 PR1
  to GND. With VBUS >= about 4.41 V (CP2 >= VREF) USB is then selected. With CP2 below VREF the internal
  comparator picks the higher input. It is a preference, not a USB-only disconnect.
- **Priority is voltage-dependent**, not absolute: in XCOMP mode field wins while
  0.301 x V_field > 0.249 x V_USB, i.e. field > 0.827 x VBUS (4.14 V at 5.00 V USB).
- **Status.** U10 ST (open drain, R36 pull-up) -> `PWR_SRC`: high = IN1 (field) or output Hi-Z,
  low = IN2 (USB). Per TPS2121 Table 9-3. Firmware also keeps reading GPIO6 USB_LIMITED.
- **Fixed after review:** `FIELD_PG` alone did not prove field was the selected source (JP2 + weak USB could select
  BQ ILIM from USB). U11 is now SN74LVC1G0832 AND-OR: Y = (FIELD_PG AND PWR_SRC) OR USB_HIGH_CURRENT.
  (SN74LVC1G3208, first named here, is OR-AND and was the wrong part.)

### Boot-gate and charger changes (required)

Today `USB_HIGH_CURRENT` (U7 output) drives both **BQ24074 EN2** (input-limit mode) and,
through JP1 pad 1, **POWER_PERMIT** (U8 boot gate). On field power that signal never
asserts, so the ESP32 would stay in reset and the BQ would stay in USB100 mode.

Add **U11 SN74LVC1G0832** (AND-OR, Y = (A AND B) OR C, TI SCES606), placed in the right-edge strip:

| Net | Old | New |
|---|---|---|
| `USB_HIGH_CURRENT` | U7 out -> BQ EN2, JP1.1, R2, TP10 | U7 out -> U11 C (pin 6) only |
| `FIELD_PG` (new) | — | Interface-board buck PG (via J6.6) -> U11 A (pin 1); R37 100k pulldown here |
| `PWR_SRC` (new) | — | U10 ST (R36 pull-up) -> U11 B (pin 3) and J6.10 |
| `SOURCE_QUALIFIED` (new) | — | U11 Y (pin 4) -> BQ EN2 (U3.5), JP1.1, R2 10k pulldown, TP10 |

- `FIELD_PG` is pulled up from **5V_FIELD** on the interface board (10k), with R37 100k pulldown here. With no
  field power there is no pull-up. LVC inputs are 5.5 V tolerant and Ioff-specified (SCES606).
- Field qualifies only while U10 reports IN1 selected (ST high). ST is also high when the mux output is Hi-Z, but then the board is unpowered.
- Startup order: BQ starts in USB100 mode, then the TPS_EN delay, then 3V3 rises, then U7/U11 evaluate and
  `SOURCE_QUALIFIED` releases EN2/ILIM and the U8 boot gate. **The C9/R12 reset-delay analysis must be redone**
  with U11 and the TPS2121 settling/soft-start time. Not yet done.
- JP1 SERVICE (2-3) behavior is unchanged. The never-bridge-both rule still applies, now protecting U11's output.

### Field input (on the interface board)

The 12/24 V input, protection and buck converter are on the interface daughterboard
(`../fieldnote-interface-board-v0.1/`: J1, F1, D1 SMAJ33A, D2 SS16, U1 LMR36510 5 V / 1 A). The reader
receives `5V_FIELD` and `FIELD_PG` through J6. Mux parts on this board: U10 TPS2121RUXR, R31-R34 PR1/CP2 dividers,
R35 59k ILM, C39 100 nF SS, C40 10 uF VIN_SEL, C41/C42 1 uF input caps, R36 ST pull-up, JP2 "USB PRIORITY" (open).

### Field power budget — must measure

The v0.4 design assumes a >=1.5 A USB source, with a proposed and unmeasured 0.71 A settled screen
at 5 V. Panel reader ports commonly provide only about 150-250 mA at 12 V. Required:

1. A **field-power firmware profile**: Wi-Fi off, 80 MHz, PN7160 low-power card
   detection, limited TX duty. Target about 100 mA average and 250 mA peak at 12 V.
2. Measure on first articles. Until then the install requirement is **a field supply of at least 500 mA at 12 V
   (or 250 mA at 24 V), or a dedicated Class 2 12/24 V supply**. With EN1 hard-wired low, field mode uses BQ ILIM (about 1 A at 5 V),
   which can draw about 463 mA from 12 V at 90% efficiency. 300 mA is not enough. (Agreed with the round-2 review.)
3. BQ ILIM (R6, ~1 A) is shared by both sources. If measurements require a lower
   field-mode limit, add a second ILIM resistor switched by source.

## 2. Panel interface (reader mode)

Implemented on the interface daughterboard, revised after review: **STM32G031F6P6 coprocessor** (I2C target) with
THVD1450 RS-485 (OSDP, hardware driver-enable), timer-driven Wiegand D0/D1, diode-isolated panel LED/beeper inputs,
PESD24VS2UT line clamps, hardware tamper interlock and buzzer. See `../fieldnote-interface-board-v0.1/README.md`.
The TCA9535/SC16IS740 version described in earlier drafts was replaced.

Reader side: J6 (FTSH-105-01-L-D, through-hole) carries 5V_FIELD x2, GND x2, 3V3, FIELD_PG, NFC_SDA, NFC_SCL,
IO_INT (IO0, open-drain, pull-up on the interface board) and PWR_SRC. I2C addresses: PN7160 0x28, coprocessor 0x30.

Not in v0.5: relays, door inputs and fire-alarm interface (the panel owns these), plus 125 kHz.

## 3. Layout options (option 2, the daughterboard, is the one being built)

The added circuitry is roughly 450-550 mm2 of parts before routing. The free top-side
area in the v4c outline (the strip between the LEDs and the coil) is about 240 mm2, and
the area behind the coil must stay component-free for the NFC tuning. Options:

1. Grow the PCB and case.
2. A stacked **interface daughterboard** (field connector, protection, buck, RS-485,
   Wiegand, expander). Main-board changes would be limited to U10, U11, a board-to-board header and
   the IO0 reclaim.
3. Bottom-side assembly under the electronics area (second SMT pass).

## 4. Firmware work

- OSDP PD stack (for example libosdp) with Secure Channel. Enable ESP32-C3 secure boot and
  flash encryption for key storage.
- Wiegand output formats: 26-bit H10301, 34, 37, 56-bit CSN, configurable facility code.
- Map panel LED/beeper control to D1-D3 and BZ1.
- Power-source detection and field-power low-power profile.
- Wi-Fi web UI off by default in reader mode. Configure over USB or OSDP.

## 5. Certification still required

FCC Part 15.225 (NFC), UL 294 (reader), SIA OSDP Verified. Production remains HOLD.
