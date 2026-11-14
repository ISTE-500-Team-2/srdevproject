# Fieldnote PN7160 v0.6 single-board candidate — HOLD

One board, everything on the top side, and the ESP32-C3 controls everything (no coprocessor, no second firmware).
Built from the frozen v0.5 candidate (`source-v05/`, read-only, hashes in `output/source-v05.SHA256SUMS`).
v0.5 and the stacked interface board stay in their own folders as saved versions.

Pipeline: `run_v06.sh` runs `prepare_v06.py` (schematic/design data), then `apply_v06_pcb.py surgery`, then
`grow_outline_v06.py`, then `apply_v06_pcb.py place|route|finish`, then native DRC.

## What changed from v0.5

- **J6 and the stacked board are gone.** Each J6 pad became a same-net via, so every v0.5 route stays connected.
- **Board grows to 110 x 45.2 mm.** The right edge moves from 74 to 110 mm. A notch at x 65.5-76.5, y 37-45.2 keeps copper
  at least 15 mm from the ESP32 antenna end (Espressif C3 layout guidance). The NFC coil region is untouched.
- **12/24 V input on top:** J5 (JST GH 10-pin) at the right edge, with the opening facing out. Then F1 PTC, D5 SMAJ33A,
  D6 SS16, and U12 LMR36510 -> `5V_FIELD` -> the existing TPS2121 (field priority). `FIELD_PG` feeds U11 and the expander.
- **OSDP:** U13 SC16IS740 (I2C 0x48) -> U14 THVD1450. U19 AND gate: `DE = RTS AND RS485_EN`.
- **Slow I/O:** U15 TCA9539 (I2C 0x74). Both U13 and U15 have their reset tied to `ESP_EN` and are polled.
- **Wiegand is hardware-timed from native GPIOs.** GPIO21 (UART_TX) drives D0 and GPIO0 drives D1, using the C3 RMT. Each
  passes through the U16 NOR gate, gated by `WG_EN_N` from the expander (default high).
- **Panel inputs:** 10k pull-up plus 1N4148W blocking diode, with PESD24VS2UT clamps on all panel lines.
- **Tamper:** SW3 is the one back-side part (it has to touch the mounting plate). It sits in series with Q3's gate drive.
- **Piezo:** BZ1 PUI SMT-1240-S-HT (2.8 mm), driven by a U17 TLC555 (about 4 kHz) and a U18 XOR bridge. Both terminals sit at 0 V when off.

## Response to the GPT-6.1 second opinion (`output/second-opinion-gpt-6.1-single-board.md` in v0.5)

| Point | Response |
|---|---|
| Wiegand from I2C-timed writes is not deterministic | **Accepted.** Moved to native GPIO21/GPIO0 with RMT timing and a boot-safe NOR gate. |
| 555 + inverter leaves DC across the piezo when off | **Accepted.** The inverter is now an XOR with the enable, so 0 V in both idle states. |
| Expander/bridge reset does not follow internal ESP resets | **Partly accepted.** See the fault table. Wiegand now releases on any ESP reset. Firmware must re-initialise U13/U15 on every boot. |
| C6 mapping "unverified" | **Disputed.** Checked against Espressif's pin tables: C6 USB is on pads 17/18, C3 USB on 26/27, and C3 pad 21 (NFC VEN) is NC on the C6. The S3-MINI is a different, larger footprint. |
| Antenna clearance and geometry | **Accepted.** 15 mm notch. Final RF and NFC tuning still need the real case. |
| Not raised by the review, found while writing the fault table | SC16IS740 ~RTS resets **HIGH** (NXP datasheet, MCR[1]), which would enable the RS-485 driver and jam the shared OSDP bus. **Fixed** with U19 + RS485_EN (default low). |

## Reset / fault-state table (design intent; to be verified on hardware)

| Condition | Wiegand D0/D1 | RS-485 driver | Tamper out | Piezo | Notes |
|---|---|---|---|---|---|
| Reader unpowered | released (FET gates pulled down) | off (unpowered) | **open = tamper** | off | THVD1450 bus-pin leakage when unpowered: verify |
| ESP_EN low (U8 gate, power-up, RESET) | released (U15 reset, WG_EN_N pulled high) | off (RS485_EN pulled low) | open = tamper (TAMPER_DRV floats, R53) | off (BZR_EN pulled low) | U13/U15 are held in reset by ESP_EN |
| ESP internal reset (watchdog/panic), ESP_EN stays high | released: GPIO21/GPIO0 revert to UART TX idle-high / input with pull-ups | stays as last configured until firmware re-initialises U13/U15 | stays at last state | stays at last state | Firmware must re-initialise U13/U15 early in boot. The GPIO21 ROM boot log toggles TXD0, and is blocked only while WG_EN_N is high, so **disable the ROM log by eFuse in production** |
| I2C bus hung | unaffected (native GPIO) | last state | last state; **case opening still opens it** (SW3 interlock) | last state | Firmware bus-recovery and watchdog required |
| Case opened | — | — | **open** regardless of firmware | — | Hardware interlock |

## Status (2026-11-10): routed, DRC-clean candidate — HOLD

Board SHA-256 `7f442871e132b8a1b94535f12f48609fa2bd3e533fb296d29f0077bc101b40db` (copy: `output/v06-final-candidate.kicad_pcb`).

| Check | Result |
|---|---|
| ERC | 0 violations (185 parts) |
| DRC errors | **0** |
| Unconnected | **0** |
| Schematic parity | 0 |
| DRC warnings | 120 (silkscreen overlaps/clipping, 6 dangling vias, 1 footprint-type) |
| v0.5 copper | all 1,459 tracks/vias present with identical geometry; 17 renamed IO_INT -> WG_D1_SRC |

How it got there: auto-routing (`apply_v06_pcb.py route`), then `repair_v06.py` (SW3 duplicate pads),
`remap_u15_v06.py` (U15 ports: BZR_EN/LED_SENSE/BZR_SENSE moved from P02-P04 to P11-P13 so they leave on the open side), `ripup_v06.py`
(new crystal/PWR_SRC copper re-routed around the U15/C50 ground pins), and `reroute_v06.py` (all J5 field nets re-routed, J5 pin 2 grounded).
Rip-ups are text edits of v0.6-only copper (pcbnew deletion in a loop crashes its SWIG layer).

Layout items for review (routed, but not good enough to release):
1. **Crystal Y2 is about 9 mm from U13**; XTAL traces are 7.6–12.4 mm with vias. Move Y2/C50/C51 next to U13 before release.
2. The LMR36510 loop placement is compact around U12/C44/L4, but it was auto-placed. Review against TI's layout guidance (input cap at VIN/PGND, SW node area).
3. VIN_RAW runs from J5 pin 1 (bottom of the connector) up to F1 at the top right.
4. Silkscreen cleanup in the extension.

## Open items

1. Native DRC/ERC status: see `output/v06-drc.json` and `output/erc-v06.json` after each run.
2. eFuse plan for GPIO21 ROM-log suppression (irreversible): agree before production provisioning.
3. Panel timing/electrical matrix and bench tests; worst-case power budget (Wi-Fi + NFC + OSDP + piezo) on field power.
4. Surge: SMAJ33A clamp at surge current vs the LMR36510 absolute maximum; connector rating; Class 2 wiring.
5. Case redesign (110 x 45.2 mm), antenna/NFC measurements in the real case, piezo sound port.
6. MPNs still TBD: F1, C45, Y2, C56, C57.
