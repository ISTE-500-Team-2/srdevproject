# Fieldnote PN7160 v0.5.4 candidate

This is v0.5.3 (board SHA-256 `200afafc…f18ac5`) with:
- the field-power / daughterboard section removed (USB-C only);
- a RUN / SVC service slide switch instead of the JP1 solder jumper;
- a 10-LED addressable light bar instead of the single RGB LED;
- a power design that accounts for the bar (R6 1.62k → 1.30k, VSYS bulk at the bar);
- a deliberate no-copper band above the NFC coil, with the antenna re-validated on the final board.

Item 5 of the brief (M2 mounting holes) was **dropped by the owner**: no holes, no keepouts, no hole silk, outline unchanged.

Status: **design candidate, not built or bench-tested.**

| | |
|---|---|
| Board | `fieldnote.kicad_pcb`, SHA-256 `c92d03e8c75e765169ba1b414cf07523be037655a085ac9aa16c200d92e2fae4` |
| Schematic | root `fieldnote.kicad_sch` plus 4 sheets (the empty `field-interface` sheet is gone); all hashes in `output/v054.SHA256SUMS` |
| Design data | `design-data.json`, SHA-256 `a49d778b1cb7cc936b7b1ccf7a20d9ebb6e14babf899eaa55d6777926cbe61eb` |
| Rebuild | `./run_v054.sh` (about 20 min) rebuilds everything from the read-only `source-v053/` (checked against `output/source-v053.SHA256SUMS`). **Two consecutive full runs (`output/run1.log`, `output/run2.log`) gave byte-identical board, schematic, design-data and power-budget hashes, and identical FastHenry L/R for all six cases. The antenna JSON first differed only in the recorded solver wall time, which is now left out of it.** |
| 3D renders | `output/v054-render-top.png`, `-iso.png`, `-bottom.png` (board-stackup colours) |
| Fab package | `../fab-export/out-v0.5.4/`, built by `export_fab_v054.py` (end of this file) |

Scripts:
- `prepare_v054.py`: netlist and part data, footprints `LED_WS2812B_2020` and `SW_CUS-12TB`, schematic regeneration (`build_design.schematic()`).
- `apply_v054_pcb.py`: phases `textprep` (text-edit rip-up), `surgery`, `place`, `route`, `necks`, `teardrops`, `finish`, `audit`. It reuses the v0.5.3 helpers (`apply_v053_pcb.py`, unchanged) and the repo routers (`route45.py` on `route_pn7160.collision_test`, which honours rule areas).
- `power_budget.py`: every number in the power sections below (`output/v054-power-budget.json/.md`).
- `rf_planes_raster.py`, `antenna_fasthenry.py`, `antenna_matching.py`: antenna re-validation. `rf_geometry_check.py`: coil surroundings v0.5.3 → v0.5.4.
- `tools/fasthenry/` and `tools/pylibs/` (numpy 2.0.2, scipy 1.13.1): copies of the antenna study's temporary toolchain, so the pipeline no longer depends on `/private/tmp`.

## Change table

| # | Change | Parts (MPN, LCSC) | Rationale / key numbers |
|---|---|---|---|
| 1 | **Field power removed.** J6, U10 (TPS2121), U11 (SN74LVC1G0832), JP2, R31–R37, C39, C40, C42, C43, and C41 (TPS2121 IN2 capacitor). R47 (IO_INT pull-up) removed. Nets gone: 5V_FIELD, FIELD_PG, PWR_SRC, VIN_SEL, MUX_*, USB_HIGH_CURRENT, IO_INT. | – | Every part's nets were checked in `design-data.json` before deletion (`output/v054-netlist-changes.json`). **C41** served only the TPS2121 input; there is no legal site at J1 that does not neck VBUS, and C1 (4.7 µF) stays 3 mm of copper from the BQ IN pin, inside the datasheet's 1–10 µF (total VBUS 4.7 µF ≤ 10 µF USB-C sink limit). **GPIO0** is free; the net returns to its v0.4 name **BAT_ADC** with the existing DNP battery divider R10/R11/C8 (copper kept, 14 items renamed only). |
| 1 | **VBUS straight to the charger**: J1 right VBUS pad pair → 0.8 mm F.Cu bus → BQ24074 IN (pin 13), 0.3 mm only for the last 1.05 mm into the 0.24 mm QFN land; C1 tap 0.5 mm (passes between the R6 pads, carries no DC); the existing J1 left-pad / R1 / U5 link joins the bus at x 58.8. | – | All on F.Cu, so no vias are needed (no "parallel vias" case arises). Max input current 1.34 A: 0.8 mm 1 oz outer ≈ 2.2 A at 10 °C rise (IPC-2221). **Kept narrower, clearance-limited inside J1's pad field:** the left-pad link and the R1 (887k sense) / U5 (TVS reference) taps, 0.35–0.4 mm (they carry the left-pad share or µA). CHG_ISET (U3.16 → R5) crossed the new corridor and was re-routed (7.1 mm, 2 vias). |
| 1 | **SOURCE_QUALIFIED = U7 output** (TUSB320 OUT1 inverted). Still drives BQ EN2 (R2 pulldown, TP10) and SW3 RUN. | – | U7.4 → existing SOURCE_QUALIFIED copper 7.8 mm F.Cu. |
| 2 | **SW3 service switch** replaces JP1: common (2) = POWER_PERMIT, RUN (3) = SOURCE_QUALIFIED, SVC (1) = 3V3. Right board edge at y 17, knob 0.5 mm past the edge; knob **up = RUN, down = SVC** (silk "RUN" / "SVC" at the two knob ends). R30 (47k POWER_PERMIT pulldown) moved next to SW3. | Nidec **CUS-12TB**, **C2921739** (1 508 JLC stock 2026-11-13) | Datasheet: **"Contact timing: Non-shorting"** (break-before-make), so SOURCE_QUALIFIED can never meet 3V3; 10 000 cycles at DC 4 V / 300 mA; −20…+70 °C; side-actuated, 1.5 mm travel. Contact map from the datasheet schematic (slider bridges C–3 in the drawn position, C–1 after moving toward terminal 1). While the knob moves, POWER_PERMIT floats and R30 holds it low: **every switch movement resets the ESP32** (by design). |
| 3 | **10-LED bar** D10…D19 replaces D5, Q1–Q3, R16–R18, R38–R43. GPIO1 net is now LED_DATA; GPIO3 / GPIO10 unconnected. Row on the top edge, centres x 30.95 → 3.05 (pitch 3.1 mm), y 4.2 (old light-guide axis); pads span x 1.79–32.22. All LEDs in the same orientation; data enters **D10 (right end)** and each DO → DI hop is one 45° run of 1.56 mm between the rows. | Worldsemi **WS2812B-2020-V6**, **C52917434** (862 959) | Datasheet (V6): VDD **3.3–5.3 V**; **12 mA per channel**; quiescent **< 1 µA** (no data, RGB off); port-scan (PWM) **2 kHz**; **−40…+85 °C**; **VIH 0.55 × VDD = 2.48 V at 4.5 V** against ESP32-C3 **VOH ≥ 0.8 × 3.3 = 2.64 V** → 0.16 V margin, inadequate → buffered. Pinout 1 DO / 2 GND / 3 DI / 4 VDD, verified against the Worldsemi drawing: the JLC/EasyEDA footprint is the datasheet top view rotated 180°, and `LED_WS2812B_2020` is drawn in that JLC orientation (pin 1 DO top-left), land 0.7 × 0.7 mm per datasheet. |
| 3 | **Level shifter U13** (VCCA 3V3, VCCB VSYS, DIR = VCCA), C58 / C59 100 nF. | TI **SN74LVC1T45DBVR**, **C7843** | Chosen over 74AHCT1G125, which is only specified at VCC 4.5–5.5 V while VSYS runs 3.9–4.5 V. LVC1T45: A-input VIH 2.0 V at VCCA 3.0–3.6 V (0.64 V margin to 2.64 V); B VOH ≥ VCCB − 0.1 V; both supplies 1.65–5.5 V; VCC isolation (B high-Z while 3V3 is off). |
| 3 | Supporting parts: C47–C56 100 nF per LED (above each LED, pad 1 straight to VDD); **R48 47 Ω** series on GPIO1; **R49 100k** at the U13 input; **R50 100k at D10 DIN**; **C57 22 µF** bar bulk. | C47–C56, C58, C59 Samsung CL05B104KO5NNNC **C1525** (basic); R48 UNI-ROYAL 0402WGF470JTCE **C25118**; R49/R50 0402WGF1003TCE **C25741**; C57 Samsung CL21A226MAQNNNE **C45783** | **VSYS rail 0.6 mm F.Cu** along the top edge (y 1.0), fed through In2 from the bulk / U13 node; the bar node reaches the BQ OUT bulk capacitor C3 through a **0.6 mm** feed (32 mm, 3 vias; no 0.8 mm path exists). R50 keeps DIN low while U13 is unpowered (B high-Z during the TPS_EN delay); R49 keeps the U13 input low while GPIO1 is high-Z. **R48 sits ~9 mm (2 vias) from GPIO1, not at the pin**: the only site at the pin (between C4, R12 and U4) lets only one of its pads escape. Judgment: at 800 kbit/s with ns edges the 54 mm run is electrically short, so R48 acts as edge-rate / EMI damping either way. **Data stays away from the coil:** the chain hops run between the LED rows; the only data copper below the row is 3.9 mm of LED_DATA_3V3 into U13 at y 9.0 (2.6 mm from the coil copper, outside the band). |
| 4 | **R6 1.62k → 1.30k** (BQ24074 ILIM). | YAGEO **RC0603FR-071K3L**, **C125319** (alt UNI-ROYAL 0603WAF1301T5E C22767) | ILIM = KILIM / R6, KILIM 1500 / 1610 / 1720 AΩ (SLUS810N, 500 mA–1.5 A row) with ±1 % resistor → **1142 / 1238 / 1336 mA**; max is 10.9 % under the 1.5 A advertisement. See *Power design*. |
| 5 | **Mounting holes: dropped by owner.** | – | Nothing added; the outline is unchanged. The top-right area freed by item 1 holds SW3, R30 and the supervisor group. |
| 6 | **NFC top-edge no-copper band**: rule area x 0–33.1, y 9.6–10.7 on all four layers (no tracks, vias, pads or pour). Together with the existing NFC region (from y 10.7) every layer now stops **2.0 mm above the coil's outer-turn copper** (y 11.6). | – | v0.5.2's "boundary" was 0.9 mm and the v0.5.3 F.Cu pour filled 1.6–3 mm above the coil; a clean 2 mm band is the brief's alternative. Antenna impact: next section. |
| 7 | Supervisor group U12 / R46 / C46 moved from the top-left strip (now the bar) to the area freed by J6 (U12 at 67.5, 23.4). Title "v0.5.4". | unchanged | ESP_RESET_RC 9.4 mm (1 via), SUP_RESET_N 1.9 mm. R44's 3V3 used to reach the network through the J6.5 pad; the route phase's split-net repair pass reconnects that cluster (C46.1 → 3V3, 11.3 mm F.Cu). |

Untouched: the ≥ 1.5 A USB-C boot gate (now simpler), the NFC coil, RF matching parts and RF copper (verified identical), the Wi-Fi keepout, the buzzer, the outline.

## Start-up sequence (re-verified for the simpler gate)

1. **Attach.** VBUS → C1 → BQ IN. BQ EN1 = GND; EN2 = SOURCE_QUALIFIED, held low by R2 (U7 is unpowered; LVC Ioff). **USB100** (90–100 mA). Before that, the BQ checks OUT with a 100 mA limit until VOUT > 0.9 V (datasheet power-on sequence).
2. **VSYS charges.** 76.7 µF nominal, +20 % tolerance, to 4.5 V at 90 mA: **4.6 ms**.
3. **TPS_EN.** R26 150k / C36 1 µF from VSYS; D4 discharges it when VSYS collapses. The TPS63031 EN threshold lies between VIL 0.4 V and VIH 1.2 V. Release is at **47.8 ms nominal** (1.2 V); the earliest corner (0.4 V threshold, C36 effective 0.4 µF per the v0.4 screen, ramp-driven RC) is **7.8 ms**. Both are later than the 4.6 ms VSYS charge.
4. **3V3 rises** in ~0.5 ms (DS Fig. 24). The TPS soft start must charge about 61 µF on 3V3 (C6, C10, C19, decoupling, C44 through R44, and an estimated 5 µF inside the module) while the BQ supplies only 90 mA. The VSYS bulk covers the difference. **VSYS dips to about 2.95 V with C57** (about 2.1 V without it); the TPS UVLO is 1.5 V. The ESP32 is held in reset, the PN7160 is in hard power-down, and the LEDs are dark (R50) throughout.
5. **U12** (TLV803S, 2.93 V) holds ESP_RESET_RC low through R46 for its 200 ms delay after 3V3 is good.
6. **TUSB320** debounces CC (133 ms) and reports the source. U7 then drives **SOURCE_QUALIFIED** high only on a ≥ 1.5 A source. That raises **BQ EN2**, moving the BQ to the R6 limit.
7. **SW3 = RUN:** POWER_PERMIT = SOURCE_QUALIFIED. C9 charges through R12 (47k × 1 µF, ≥ 24 ms to the U8 Schmitt threshold), so ESP_EN = ESP_RESET_RC AND POWER_PERMIT releases at ≈ max(U12 200 ms, qualification + RC). The ESP32 can only run while EN2 is high. On a weak source it never starts (gate kept).
8. **SW3 = SVC:** POWER_PERMIT = 3V3. The ESP32 starts after U12's 200 ms regardless of the source; the BQ stays in USB100 on a default port.

The v0.5.2 note "startup re-analysis required (U11 propagation, TPS2121 soft start)" is resolved: both parts are gone.

## Power design (item 4)

All inputs carry their source in `power_budget.py`. DS = datasheet, J = judgment.

| Input limit (R6) | min | typ | max |
|---|---:|---:|---:|
| 1.62k (v0.5.3) | 917 | 994 | 1072 mA |
| **1.30k (v0.5.4)** | **1142** | **1238** | **1336 mA** |

| Worst-case simultaneous VSYS load | mA |
|---|---:|
| LED bar full white (peak) | 424.0 |
| PN7160 PCD (VBAT + VUP, DS max) | 290 |
| TPS63031 input (ESP TX 350 + buzzer 119 + misc 3 mA at 3V3, eta 0.85, 4.0 V) | 457.7 |
| other VSYS (R26, U13, LED idle) | 0.1 |
| TOTAL | 1171.8 |

| Firmware budget (peak) | non-LED mA | LED budget mA | max lit channels | max full-white LEDs |
|---|---:|---:|---:|---:|
| Idle / Wi-Fi associated, RX or modem-sleep, no field | 85 | 943 | 30 of 30 | 10 of 10 |
| NFC field on (polling) + Wi-Fi RX | 375 | 653 | 30 of 30 | 10 of 10 |
| NFC field on + Wi-Fi TX burst | 633 | 395 | 27 of 30 | 9 of 10 |
| NFC field on + Wi-Fi TX + buzzer | 748 | 280 | 19 of 30 | 6 of 10 |
| Wi-Fi TX + buzzer, no field | 458 | 570 | 30 of 30 | 10 of 10 |

| Service mode (USB100) | mA at VSYS |
|---|---:|
| ESP32-C3 ROM download + flash write (28 + 25 + 5 mA at 3V3) | 55.64 |
| pull-ups / TUSB320 / logic (1.3 mA at 3V3) | 1.25 |
| LED bar idle (10 x 1 uA) | 0.01 |
| PN7160 hard power-down, VEN low by R19 (16 uA max) | 0.02 |
| R26 + U13 ICCB | 0.04 |
| **TOTAL** | **56.9** of 90 (min) |

**Worst case vs limits.** Worst simultaneous peak (full-white bar, PN7160 at its 290 mA datasheet maximum, Wi-Fi TX at 350 mA, buzzer): **1172 mA**.
- With the old R6 (917 mA minimum) the bar would have been unusable during an NFC poll plus Wi-Fi TX.
- With R6 1.30k the ILIM minimum is 1142 mA. Only the triple-coincidence corner exceeds it, and the firmware budget below forbids that corner.
- Typical simultaneous load (nominal ITVDD, η 0.88): about **1.0 A**, against 1238 mA typical ILIM and the 1.5 A source.

**VSYS level.**
- Below the limit, VSYS is regulated at 4.3–4.5 V.
- At the limit, Q1 is in dropout (VDO ≤ 0.475 V at 1 A → ≤ 0.475 Ω). VSYS is then **3.96 V with 4.5 V at the BQ pin, 4.21 V at 4.75 V, 4.30 V at 5.0 V**.
- So with a weak cable at full load the headroom to the 3.9 V target is about 60 mV. This is why the firmware budget is a hard **peak** budget, not something the capacitors are expected to carry.

**Bulk capacitance.** VSYS ceramic is 76.7 µF nominal and about **43.5 µF effective at 4.4 V** (C3, C4, C57 22 µF 25 V X5R at 55 % (J); C12/C14 4.7 µF at 65 % (J); 13 × 100 nF).
- The BQ24074 pin table asks for 4.7–47 µF on OUT. The effective value is inside that range; the nominal is above it, which is a bench item.
- **Largest load step: 682 mA** (all 30 channels switching on together, plus a Wi-Fi TX burst start). With 43.5 µF it droops 78 / 157 / 314 mV if the BQ loop needs 5 / 10 / 20 µs. That keeps VSYS ≥ 3.9 V from 4.3 V for any loop response up to **19 µs** (TI gives no figure; J).
- **Overload ride-through** (load above the limit, 0.4 V allowed): 696 / 348 / 174 / 87 µs for 25 / 50 / 100 / 200 mA over. That is shorter than a 2 kHz PWM period at high duty or a Wi-Fi frame, hence the peak budget.
- **The LEDs' internal PWM draws full channel current in pulses at any brightness.** Ten free-running 2 kHz oscillators can align. **The budget therefore counts lit channels (any non-zero value), not brightness.**
- C57 also lifts the USB100 start-up dip from ~2.1 V to ~2.95 V (start-up step 4).

**Thermal (BQ24074, linear: (VIN − VSYS) × IIN, RθJA 44.5 °C/W JEDEC).**

| Case | Dissipation | Rise |
|---|---:|---:|
| Typical (5.0 V, 1.0 A) | 0.61 W | +27 °C |
| Worst continuous at the new limit (5.25 V / 1.336 A) | 1.28 W | +57 °C |
| Worst continuous at the new limit (5.5 V / 1.336 A) | 1.61 W | +72 °C |

At 40 °C indoor case ambient the 5.5 V case gives TJ ≈ 111 °C, below the 125 °C thermal-regulation point (which would only reduce the input current). The peak budget keeps continuous operation well below the limit.

### Firmware power rules

1. **Count lit LED channels** (any non-zero R, G or B value) and cap them from the table above, using the worst activity that can coincide:
   - Wi-Fi TX or buzzer may run during a tag poll: **≤ 19 channels** (for example 6 LEDs full white, or 10 LEDs in one colour).
   - NFC field + Wi-Fi TX without the buzzer: **≤ 27 channels**.
   - NFC polling with Wi-Fi idle/RX, or no field: all **30 channels**.
   - Simplest safe policy: never transmit Wi-Fi while the field is on with the bar at full white; or cap the bar at 19 lit channels whenever the field is on.
2. Brightness (PWM value) reduces average heat and light, not the peak.
3. **Weak-source / service profile:** when **USB_LIMITED (GPIO6) is high** (TUSB320 reports a default source), stay in a low-power profile:
   - NFC field off (VEN low, R19 default);
   - LEDs off (send one all-zero frame, then leave GPIO1 low);
   - no Wi-Fi/BLE start (no RF calibration);
   - CPU ≤ 80 MHz.
   This applies whatever SW3's position, because the BQ is then in USB100.
4. PN7160 per the antenna study §5: TXLDO 3.3 V, DPC off, self-test at boot.

## Service mode (SW3 = SVC on a default USB port, e.g. the Orange Pi)

On a default port, SOURCE_QUALIFIED stays low, so the BQ stays in **USB100: 90 mA minimum** (SLUS810N IINmax 90 / 95 / 100 mA). The service-mode table above totals **56.9 mA at VSYS (63 % of 90 mA, 33 mA headroom)**. With a pessimistic TPS η of 0.70 it is 65.1 mA. The BQ's own 1.5 mA ICC comes from the port on top of the FET limit.

Basis for the ESP32 figure:
- Espressif gives no download-mode current. It is bounded by modem-sleep at 160 MHz with all peripheral clocks on: 28 mA (MINI-1 DS Table 6-6).
- Plus flash program/erase: 25 mA (J, typical SPI-NOR maximum).
- Plus the USB PHY: 5 mA (J).
- The TPS63031 is taken at η 0.80 (DS Fig. 16 reads ~87 % at 60 mA, 4.3 V).
- The PN7160 is in hard power-down, held by R19 while GPIO7 is high-Z (16 µA maximum). The LEDs idle at 10 × 1 µA. The charger has no battery and gets only what is left (DPPM gives the system priority).

**Programming without BOOT/SW2.** The ROM always enables the USB-Serial-JTAG controller on GPIO18/19. esptool (v4.x/v5.x, `--before default_reset`, port `/dev/ttyACM*`) recognises the Espressif USB-JTAG-Serial device and uses its reset sequence, which resets the C3 into download mode through the controller (the USB-Serial-JTAG "RTS/DTR" mechanism). No strap button is needed.

Conditions:
- the application must not disable USB-Serial-JTAG or repurpose GPIO18/19;
- the eFuses DIS_USB_SERIAL_JTAG / DIS_DOWNLOAD_MODE / DIS_FORCE_DOWNLOAD must stay unburned.

Fallback: hold SW2 (BOOT, GPIO9) while pressing SW1 (RESET), or flip SW3 RUN → SVC (which resets) while holding SW2. The firmware must then follow the USB_LIMITED profile above, because after flashing esptool resets into the application on the same weak port.

## NFC antenna re-validation (item 6)

**RF copper.**
- `extract_rf_routes.py` on the final board gives all **12 RF nets IDENTICAL** to the study's `results/rf-routes.json`.
- Audit: the 111 RF track/via items, ANT1 (shapes, pads, position) and all RF part poses are identical to v0.5.3; there are **0 teardrops on RF nets**.
- `rf_geometry_check.py`: coil copper XOR 0; coil-to-edge 1.775 mm unchanged; nearest GND fill to the coil unchanged on every layer (F 0.202, B 0.152, In1/In2 0.003 mm at the feed). GND fill within 3 mm of the coil drops by 31–50 mm² per layer (the band).

**Coil inductance (FastHenry 3.0.1, study settings: 13.56 MHz, coil mesh 11 × 3, plane pitch 0.375 mm, study coil + feed geometry).** Outputs are in `output/antenna/`.

| Model | L (nH) | R (Ω) |
|---|---:|---:|
| Study rectangle planes, fill edge y 10.7 (v0.5.2/v0.5.3), reproduces the study | **543.62** | 0.4612 |
| Study rectangle planes, fill edge y 9.6 (band) | 546.80 (**+0.58 %**) | 0.4577 |
| Strip grid, same rectangle geometry, y 10.7 / y 9.6 | 538.46 / 542.77 (+0.80 %) | 0.476 / 0.470 |
| **Strip grid, real copper of every layer, v0.5.3 board** | **542.89** | 0.4772 |
| **Strip grid, real copper of every layer, v0.5.4 board** (GND pours, band, light-bar copper, all other non-RF copper) | **546.11** | 0.4684 |
| **Δ v0.5.3 → v0.5.4** | **+3.22 nH (+0.59 %)** | −0.009 |

- **Why a strip grid.** FastHenry's native plane holes cannot represent real pour shapes: islands inside holes and 1-node necks produced "multiple boundaries around one hole region" and a preconditioner failure. Each layer is therefore written as 0.375 mm strips between adjacent copper sample points, which is what FastHenry builds internally for a plane.
- **Validation.** On the study's own geometry the strip grid reads 0.95 % lower than native planes. The **difference** between boards uses the same method on both. The band-only change predicted by the study's plane model (+0.58 %) agrees with the board result (+0.59 %).
- **Conventions kept from the study:** nothing inside the NFC region; the F/B pour fragments around the matching parts treated as holes. Every copper island is a floating conductor; copper was sampled every 0.375 mm (J: fine features below that are approximated).
- **Applied value:** the study's 543.6 nH + Δ = **546.8 nH, 0.452 Ω**.

**Matching check** (study `matching.py`, unchanged; fitted BOM: C26/27 120 pF, C28/29 330 pF + C34/35 15 pF, R22/23 1.0 Ω):

| | L (nH) | Z(TX1–TX2) (Ω) | ITVDD typ / fast driver (mA) | ITVDD bound for any L error, typ / fast (mA) | Coil current (mA rms) | Q (NXP calc) | Transfer Q / peak |
|---|---:|---|---:|---:|---:|---:|---|
| Before (study) | 543.6 | 11.11 − j0.30 | 207 / 215 | 233 / 243 | 481 | 18.8 | 17.5 / 13.47 MHz |
| **After (v0.5.4)** | **546.8** | **11.93 + j0.64** | **194 / 202** | **234 / 243** | **470** | **19.0** | 17.5 / 13.44 MHz |
| Alternative: C34/C35 → 13 pF | 546.8 | 11.29 + j0.09 | 204 / 213 | 234 / 244 | 479 | 19.0 | – |

**Decision: keep C34/C35 at 15 pF.** This is judgment against a stated threshold (`material` = |ΔL| ≥ 1 %, ≈ 23 mA ITVDD per the study).
- The shift is 0.59 % L, about 0.4 σ of the study's own coil-L model uncertainty.
- The safety bound is unchanged (≤ 234 / 243 mA, below 250 mA). Q stays inside 15–20. Z moves toward NXP's 13 Ω target.
- Cost: about −2.3 % coil current (≈ −1 % read range).
- If the owner prefers to re-centre exactly on the study's operating point, 13 pF 1 % NP0 (YAGEO CC0603FRNPO9BN130, **C519488**, already on the BOM as C22/C23) does it. It is a value swap on the same pads.
- The first-board self-test (study §5, 150–245 mA OK band) still decides.

## Native checks

| Check | Result |
|---|---|
| ERC (`--severity-all`) | **0** |
| DRC (`--severity-all --schematic-parity --refill-zones`) | **0 errors, 0 warnings (silkscreen included), 0 unconnected, 0 parity** |
| In1.Cu tracks | **0** |
| GND islands (F/In2/B fill polygons touching no GND via, PTH or track) | **0** |
| Copper in the NFC band | **0** items |
| Track/via diff vs `source-v053/` | **Removed 405**: exactly the textprep rip list (`output/v054-textprep.json`): copper of the removed nets, the CHG_ISET re-route, three 0.35–0.45 mm VBUS segments, and branches left dangling by removed or moved parts (graph-pruned per net; GND only where the stub led to a removed pad).<br>**Changed pre-existing 41**: 27 VSYS neck widenings (0.30–0.45 → 0.5–0.8 mm, width only) and 14 IO_INT → BAT_ADC renames (net name only); **0 unexpected**.<br>**Added 251**: only on the nets of the new / moved parts, VBUS, CHG_ISET, VSYS, 3V3, GND (`output/v054-audit.json`); 0 non-octilinear segments; nothing on RF nets. |
| Footprints | **Removed 31**, **added 28** (D10–D19, C47–C59, U13, R48–R50, SW3), **moved 4** (U12, R46, C46, R30), **value change** R6 |
| Silkscreen | 0 warnings; **118 references printed**, **20 hidden** (no clear 0.8 mm spot near the part): C5, C12, C15, C17, C30, C37, C47, C48, D7, R12, R14, R20, R45, R46, R48, R49, TP7, TP8, TP11, TP12 |
| Teardrops | **355** pad/via teardrops regenerated for the whole board (v0.5.3 algorithm), none on GND or RF nets |
| Determinism | Two consecutive full runs (`output/run1.log`, `output/run2.log`) gave byte-identical board, schematic, design-data and power-budget hashes, and identical FastHenry L/R for all six cases. The antenna JSON first differed only in the recorded solver wall time, which is now left out of it (`output/v054.SHA256SUMS`). |

## Fab export (`export_fab_v054.py` → `../fab-export/out-v0.5.4/`)

Same wrapper scheme as v0.5.3 (`fab-export/export_fab.py` unchanged; private `fab-cache/`; sourcing overlay `output/sourcing-map-v054.json` = shared map + v0.5.3 overlay + v0.5.4 parts). FAB-NOTES rows rewritten: black / white / ENIG, outline without notch or holes, no J6 / JP / U10 / 5V_FIELD text, new part notes.

| Check | Result |
|---|---|
| Gerbers | **11 / 11** (4 copper, mask × 2, silk × 2, paste × 2, Edge.Cuts) + job file |
| Drill vs board | **match.** PTH 0.20 × 188, 0.30 × 47, 0.50 × 8, 0.60 × 4, 0.75 × 2. **NPTH 0.65 × 2 (J1 pegs), 0.90 × 2 (SW3 pegs)** |
| CPL rows = fitted top SMT parts | **116 = 116** |
| BOM | **55 lines, 116 designators, 0 without LCSC** |
| Rotation review | **0** items. FAB-NOTES list D10–D19, U13, SW3 in the polarity watch list for the DFM preview |
| **LED bar orientation** | every D10–D19 fits JLC's C52917434 library footprint at **θ = 0** (max pad error 0.05 mm). The 2020 land is 180°-symmetric, so the fit tool reports `ok-sym`: two geometric fits, exactly one agreeing by pad number. Pin 1 is therefore set by the pad numbering verified against the Worldsemi drawing above. `orientation-overlay.png` shows the JLC pin-1 dot on KiCad pad 1 (DO, top-left) for all ten. U13 fits at 180° (CPL 270°), pin 1 VCCA on pad 1. SW3 fits at 0 (exact), pin 1 on pad 1 (SVC end). |

## Open items / owner decisions

1. **C34/C35 15 pF (kept) or 13 pF** (re-centres on the study's point, +10 mA ITVDD, same safety bound). See the antenna section.
2. **Case:**
   - a diffuser / light guide for a 30.4 mm bar on y 4.2 (replaces the single-LED light guide at x 20.7);
   - a slot in the right wall for the SW3 knob (knob travels y 15.7–18.5, protrudes 0.5 mm past the board edge at x 74);
   - RUN = up, SVC = down.
3. **Firmware** must implement the lit-channel budget and the USB_LIMITED low-power profile; the hardware does not enforce them.
4. **Bench checks:**
   - VSYS on a 1.5 A source with a long cable at full load (target ≥ 3.9 V; 3.96 V predicted at 4.5 V input);
   - BQ OUT stability with 76.7 µF nominal ceramic (datasheet asks for 4.7–47 µF; the effective value is inside);
   - USB100 start-up dip (~2.95 V predicted);
   - service-mode flashing from the Orange Pi;
   - LED data integrity through U13 at 3.9–4.5 V VSYS;
   - SW3 reset-on-toggle;
   - first-board PN7160 self-test.
5. **Judgment-based inputs:**
   - DC-bias derating of the 22 µF / 4.7 µF parts (55 % / 65 %);
   - LED channel tolerance (+15 %) and active IC current (1 mA), which the V6 datasheet does not give;
   - flash-write current and USB PHY current in service mode;
   - the BQ loop response (≤ 19 µs covered).
6. **Remaining thin VSYS copper:** pre-existing 0.35 mm segments around the BQ OUT pins and the C3 trunk (23.5 mm total, clearance- or pad-limited; 0.24 mm QFN lands). At the 1.34 A worst case, 0.35 mm 1 oz outer is ≈ 13 °C rise (IPC-2221, J). The LED feed's In2 portion is 0.6 mm 0.5 oz (≈ 0.5 A at 10 °C rise; the bar's peak is 0.42 A).
7. **SW3 stock:** 1 508 at JLC (enough for prototypes); −20…+70 °C (indoor only).
8. **3D models:** the WS2812B-2020, CUS-12TB and several 0402 footprints have no 3D model and render as bare pads (cosmetic).
9. **Hidden references** (listed above): use `output/v054-finish.json` or the assembly drawing.
10. `output/fasthenry/` holds early test runs of the antenna scripts that the sandbox would not let me delete. They are not used; the pipeline writes to `output/antenna/`. Delete the folder at will.
11. Everything is untested hardware; the v0.5.3 bench list (CC detection with D8/D9, supervisor timing, buzzer) still applies.

## What was verified and what is judgment

| Item | Status |
|---|---|
| ERC/DRC/parity, connectivity, In1, islands, band, track/via diff, RF copper identity, determinism, fab checks | **Verified** by the tools above (native KiCad 10 checks and the scripted audit) |
| Datasheet figures (BQ24074 SLUS810N, TPS63031 SLVS696D, ESP32-C3-MINI-1 v2.2, PN7160 Rev 4.2, TUSB320, SN74LVC1T45, WS2812B-2020-V6, Nidec CUS) | **Verified** against the downloaded datasheets |
| LCSC numbers and stock | **Verified** 2026-11-13 through the JLC parts search; stock changes |
| esptool reset-to-download over USB-Serial-JTAG | **From Espressif's esptool / ESP32-C3 documentation**, not re-checked online in this session and not bench-tested |
| LED and switch pinout vs the JLC library | **Verified** against the manufacturer drawings, the EasyEDA records and the orientation overlay |
| FastHenry L/R and the matching numbers | **Computed** with the study's models; the absolute L carries the study's model uncertainty (σ 1.5 %) |
| Capacitor DC-bias derating, BQ loop response, flash/PHY currents, LED tolerance, TPS soft-start time | **Judgment** (stated where used) |
| R48 placement adequacy, C34/C35 decision, "material" threshold | **Judgment** |
