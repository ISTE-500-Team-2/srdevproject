# Fieldnote PN7160 v0.5.2 candidate

v0.5.1 (buzzer + RGB, board SHA-256 `3fec6983…e7eabe30d`) with the independent-review hardware fixes.
Status: **design candidate, not built or bench-tested.** Outline, LED parts and LED resistor values are unchanged.

| | |
|---|---|
| Board | `fieldnote.kicad_pcb`, SHA-256 `78e671b38e97363926ec36fa88dac2a63df54d59f413ac996088c911dc2716e6` |
| Schematic | `fieldnote.kicad_sch`, SHA-256 `c8dcb5bfca9f563989a03576a6cb79b08791f8d8e9f76bda55246f45c17a1fe0` |
| Design data | `design-data.json`, SHA-256 `539c7a3ed9b399aff0948dbdbbd472a8e4055634979d682febecb4c2be15bcca` |
| Rebuild | `./run_v052.sh` (about 1 min) rebuilds everything from the read-only `source-v051/`. Two consecutive runs gave identical hashes. |
| 3D render | `output/v052-render-top.png` |

## Change table

| # | Fix | Parts (MPN, LCSC) | What was done / rationale |
|---|---|---|---|
| 1 | Buzzer stuck-on protection | C45 100 nF 16 V X7R 0402 (Samsung CL05B104KO5NNNC, C1525, basic); R45 68 k 1 % 0402 (UNI-ROYAL 0402WGF6802TCE, C36871); D7 RB520S-30 SOD-523 (JSCJ, C8522). The Q4 gate is re-netted from BOOT_IO8 to BZR_GATE. | GPIO8 → C45 → Q4 gate. R45 returns the gate to the Q4 source and D7 clamps the gate at source + Vf, so every falling edge drives Vgs to about −3 V whatever the duty cycle (DC restore). A static GPIO8 level (low, high or high-Z) leaves Q4 off. The R14 10 k strap pull-up stays on the GPIO side and C45 blocks DC, so the GPIO8 boot strap is unaffected. **R45 changed from the earlier 100 k to 68 k** after the extended sim (below). |
| 2 | Reset supervisor on the RC node | U12 TLV803SDBZR (TI, C132016): 2.93 V (2.87–2.99 V), open drain, td 120/200/280 ms. R46 1 k 1 % 0402 (UNI-ROYAL 0402WGF1001TCE, C11702, basic). C46 100 nF 0402 (C1525). | U12 senses 3V3 and pulls **ESP_RESET_RC** (C9/R12, U8 In0) low through R46; ESP_EN is untouched. U8 (SN74LVC1G97, Y = In0 AND In2) keeps driving ESP_EN push-pull. R46 limits the sink current to 3.3 mA (U12 abs max 5 mA) when C9 discharges or when a UART adapter drives J4.5 high. With U12 asserted the node sits at 69 mV. |
| 3 | NFC keepout to the board edge | — | The three "NFC …" rule areas now run from x 1.5 to x 0. Grounded copper in the edge strip beside the coil: **42.8 mm² per layer in v0.5.1 → 0 on all four layers** (audit). Nothing depended on it: DRC shows 0 unconnected and no tracks or vias were in the strip. |
| 4 | Power-path copper (VBUS J1→U10, VIN_SEL, 5V_FIELD) | — | Every segment widened in place to the widest legal value (≤ 1.0 mm), with original-width necks at small pads and at local obstacles. B.Cu twin copper where a run could not widen. Parallel 0.6/0.3 vias at every layer change. Details below. |
| 5 | C44 off the edge | — | In v0.5.1 C44 was 0.75 mm (pad copper) / 0.47 mm (courtyard) from the right edge. It is now **3.46 mm / 3.18 mm**. The buzzer corner was re-packed: Q4, C44, R44, D6 and BZ1 moved; the corner copper was ripped and re-routed. |
| 6 | 4-layer stackup in board setup | — | F.Cu 35 µm / prepreg 0.21 / In1 17.5 µm / core 1.075 / In2 17.5 µm / prepreg 0.21 / B.Cu 35 µm, 1.6 mm, ENIG. That is 1 oz outer and 0.5 oz inner (JLC04161H-7628 class); 1 oz inner is not required. |
| 7 | Silkscreen | — | The JP1 reference no longer sits on the R38 pad (moved 0.9 mm, turned 90°). The six new parts' references are hidden, as v0.5.1 did for the buzzer group, because no clear spot within 4 mm reads as their own. New silk warnings: 0. **25 inherited warnings remain**, all in the v0.5 U10/R31/R32/JP2/C40–C43/R33/R35/R36/U11 cluster (v0.5.1 had 26). |

The buzzer group (BZ1, Q4, D6, R44, C44, C45, R45, D7) is self-contained in the right-hand corner (x 65.6–73.6, y 26.3–36.8). It has four interfaces only: 3V3 at R44.1, BOOT_IO8 at C45.1, and local GND vias. That keeps a later swap to the lid speaker + NS4150B option (`hardware/speaker-study/`) confined to the corner. This was not acted on.

## Fix 1: simulation evidence (`sim/`)

ngspice (KiCad's libngspice), `sim/run_sim.py` → `sim/results.json`, plots `sim/stuck_low.svg` and `sim/pwm_4khz_50pct.svg`. The models are generic, written in the script; they are not vendor models:
- Q4: level-1 PMOS, Vth swept −0.35 / −0.5 / −0.9 / −1.3 V.
- Buzzer: 12 Ω + 0.5 mH (the inductance is assumed).
- Coil supply: R44 4.7 Ω with C44 at an effective 10 µF.

| Check | 100 k (first pass, `sim/results-r45-100k-first-pass.json`) | **68 k (final)** |
|---|---|---|
| Static low on GPIO8, Q4 current < 1 mA after: typ (Vth −0.9 V) | 20.1 ms | **13.7 ms** |
| … slowest 25 °C corner (Vth −0.5 V, C45 +10 %) | 34.4 ms | **23.6 ms** |
| … hot corner (Vth −0.35 V ≈ −0.5 V min at 85 °C, C45 +20 %) | 46.5 ms (no margin to 50 ms) | **32.1 ms** |
| PWM 2–5 kHz, 10–90 % low: weakest on-state Vgs (RB520S-30) | −2.80 V | **−2.72 V** (AO3401A Rds(on) is specified ≤ 85 mΩ at −2.5 V); Vds ≤ 14 mV at 205 mA |
| PWM off-phase mean Q4 current, worst (Vth −0.5 V) | 23.8 mA (5 kHz, 10 %) | **2.2 mA** (2 kHz, 50 %); 0 at Vth ≥ 0.9 V |
| Power-up / power-down with GPIO8 high-Z | Vgs ≥ −0.19 V, coil ≤ 0.1 mA | same |

- A 1N4148 clamp in place of D7 leaves only −2.39 V of gate drive at 2 kHz / 90 %. **D7 must be a low-Vf Schottky**; the old "1N4148WT drop-in" note was removed.
- Firmware: drive GPIO8 with LEDC at 2–5 kHz for beeps. The idle level no longer matters.
- Open: the off-phase partial conduction of a minimum-threshold FET at 2 kHz / 50 % is a few mA. It is harmless but should be confirmed on the bench.

## Fix 2: startup timing (analysis, not simulated)

- After 3V3 crosses VIT (2.87–2.99 V), U12 holds ESP_RESET_RC low for td = 120–280 ms (200 typ).
- C9 then charges from 0 V through R12 47 k from POWER_PERMIT. U8's Schmitt input reaches VT+ (1.3–2.0 V) after 23–44 ms.
- ESP_EN therefore rises 145–325 ms after 3V3 is valid, against about 23–44 ms in v0.5.1.
- Every brown-out below 2.87–2.99 V now fully discharges C9 (through R46, τ = 1 ms, below 0.8 V within 1.5 ms) and restarts the delay. This closes the v0.5 "retained C9 charge after a brief detach" item.
- **JP1 SERVICE mode** (POWER_PERMIT = 3V3) behaves the same apart from the extra 120–280 ms. USB mode (POWER_PERMIT = SOURCE_QUALIFIED) is likewise unchanged in logic.
- SW1 and J4.5 still pull the same node low. U12 only sinks current, so there is no contention with them.

## Fix 4: power path, achieved copper

IPC-2221, 10 °C rise: 1 oz outer 0.30 mm ≈ 1.0 A, 0.35 ≈ 1.1 A, 0.5 ≈ 1.45 A, 1.0 ≈ 2.4 A. 0.5 oz inner 0.40 mm ≈ 0.37 A, 0.45 ≈ 0.41 A.

| Net | v0.5.1 | v0.5.2 (main path; sense taps R1/R33/U5/R31 unchanged) | Vias at layer changes |
|---|---|---|---|
| VBUS | F.Cu 0.35 (31.8 mm), 0.30 (2.5 mm), 0.40; B.Cu hop 0.40 | F.Cu 0.5–1.0 (15.5 mm), 0.40–0.45 (10 mm), 0.35 (14.2 mm: J1 pin loop and runs boxed in by USB/CC nets); 0.30 only as 1.3 mm of neck at C41. B.Cu hop 0.4 → 1.0. **New B.Cu twin 0.8–1.0 mm × 7 mm** parallel to the J1→C41 F.Cu run. | C41→U10 hop: 2 → **2 + 4 × 0.6/0.3**. Twin: 2 × 0.6/0.3 at its J1 end. |
| VIN_SEL | F.Cu 0.30–0.40 | F.Cu 0.6–1.0 (6.1 mm), 0.40 (9.0 mm); 0.30/0.35 only next to U10 OUT, U3 IN and C40 pads (5.1 mm in total) | none (F.Cu only) |
| 5V_FIELD | F.Cu 0.40 (5.9 mm), In2 0.40 (16.7 mm) | F.Cu 0.5–1.0, J6.1–J6.2 link 1.0. In2 run 0.40–0.45 (an In2 neighbour blocks widening). **New B.Cu twin 16.8 mm** (0.5 mm × 5.5 mm past the edge GND-stitch vias, 0.8–1.0 mm × 8.2 mm), dropping to F.Cu next to J6 to reach J6.2 (J6.2 is fenced on B.Cu by NFC_SCL). | F.Cu→In2 field via: 1 → **1 + 2 × 0.6/0.3**. Twin's B→F via 0.5/0.2 + 1 × 0.6/0.3. J6 pins are THT. |

**Order requirement: 1 oz outer finished copper (standard). 0.5 oz inner is sufficient**, because the In2 5V_FIELD run (0.37–0.41 A on its own) carries only about 30 % of the current. The B.Cu twin, 0.5 mm 1 oz at its narrowest (≈ 1.45 A), carries the rest. Choosing 1 oz inner is optional margin and is not set in the stackup.

## Native checks (from `run_v052.sh`)

| Check | Result |
|---|---|
| ERC (`kicad-cli sch erc --severity-all`) | **0 violations** |
| DRC (`--severity-all --schematic-parity --refill-zones`) | **0 errors, 0 unconnected, 0 parity**; 25 warnings, all inherited silkscreen (3 edge clearance, 8 overlap, 14 over copper) |
| GND pour islands (F/In2/B fill polygons touching no GND via, PTH or track) | **0** (`output/v052-audit.json`). The one island the new copper created (C46.2) is fixed with a routed stub to its own via. |
| Track/via diff against `source-v051/` | Removed: 29, exactly the ripped v0.5.1 buzzer-corner copper. Changed: 29, all on VBUS/VIN_SEL/5V_FIELD (width-only, or width plus neck split). Added: 116 items, only on BZR_*, SUP_RESET_N, ESP_RESET_RC, BOOT_IO8, 3V3, GND and the three power nets. All shared-net additions are inside the buzzer/supervisor corner. |
| Footprints | Added: C45 C46 D7 R45 R46 U12. Moved: BZ1 C44 D6 Q4 R44. No value changes. LED parts unchanged. Outline unchanged. Only the three NFC rule-area outlines changed. |

## Placement and routing notes

- **U12** has exactly one legal site near the reset node (0.05 mm grid search): (67.55, 24.35), 90°. It sits between the USB_HIGH_CURRENT F.Cu run and the J6 tails. Its courtyard overlaps J6's *back-side* courtyard but no J6 hole; copper clearance to the J6 pads is ≥ 0.45 mm.
  - The only other free area on the board is top-left (x 3–10, y 2–9), about 25 mm from the reset node.
  - `legality()` now checks the real outline: the old check used a rectangle and accepted a site below the y 37 step. It also checks back-side THT holes.
- **Routes:** the buzzer corner is all F.Cu. Three longer links needed vias:
  - BOOT_IO8, 3 vias, 8.3 mm;
  - ESP_RESET_RC, 4 vias, 10.5 mm (a slow, 1 µF-loaded node);
  - SUP_RESET_N, 2 vias via In2.
  - Two vias sit under the U12 body (tented).
- **GND vias:** every new GND pad has its own GND via.

## Open items / owner decisions

1. Everything is untested hardware. Bench-check the buzzer:
   - beep at 2/4/5 kHz;
   - force GPIO8 low and confirm the current dies within about 30 ms;
   - confirm the boot strap with GPIO8.
2. **NFC re-tune:** removing the grounded edge strip changes the coil's surroundings slightly. Re-measure the antenna match (R22/R23, C24–C29) on the first boards.
3. **J6 hand-fit (field build):** J6's solder joints are on the front, 0.45 mm from U12's pads. Use a fine tip, or fit J6 before U12 when hand-assembling.
4. **25 inherited silkscreen warnings** in the v0.5 power-mux cluster: no clear spot exists within 2.5 mm, so they were left as they were. Fixing them means hiding references or accepting overlap. This is an owner call.
5. The new 0402/SOD-523 footprints have no 3D model attached (copied from the KiCad library without the model path). This is cosmetic, render only.
6. Pending owner decision (not acted on): replacing the buzzer with the lid speaker + NS4150B.
