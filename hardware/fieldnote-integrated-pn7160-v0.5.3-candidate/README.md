# Fieldnote PN7160 v0.5.3 candidate

This is v0.5.2 (board SHA-256 `78e671b3…2716e6`) with:
- the remaining hardware defects fixed;
- the owner-approved NFC matching values from `../nfc-antenna-study/`;
- a cleaned-up layout with a black solder mask.

Status: **design candidate, not built or bench-tested.**

| | |
|---|---|
| Board | `fieldnote.kicad_pcb`, SHA-256 `200afafc5739c0ff028bbf5e4ac5cbdd6387b6d1bd80c1f6bd4134b442f18ac5` |
| Schematic | root `fieldnote.kicad_sch` `5b5f2359…412d0`, plus 5 sheets; all hashes are in `output/v053.SHA256SUMS` |
| Design data | `design-data.json`, SHA-256 `dce9305ad5a6360090b5810dbab2b74e7ec05f6d90e2d5e62150c6dc4f52be65` |
| Rebuild | `./run_v053.sh` (about 25 min) rebuilds everything from the read-only `source-v052/` (checked against `output/source-v052.SHA256SUMS`). **Two consecutive full runs gave byte-identical board, schematic and design-data hashes.** |
| 3D renders | `output/v053-render-top.png`, `output/v053-render-iso.png`, `output/v053-render-bottom.png`, rendered with the board-stackup colours |
| Fab package | `../fab-export/out-v0.5.3/`, built by `export_fab_v053.py` (see the end of this file) |

Scripts:
- `prepare_v053.py`: netlist and part data, schematic regeneration, and generation of the `TI_DPY0002A` footprint.
- `apply_v053_pcb.py`: phases `textprep`, `surgery`, `place`, `route`, `necks`, `teardrops`, `finish`, `audit`.
- `route45.py`: 45° A* router on the repo collision model.
- `rf_geometry_check.py`: coil surroundings versus v0.5.2.

## Change table: hardware defects

| # | Defect | Fix | Parts (MPN, LCSC) | Rationale / numbers |
|---|---|---|---|---|
| 1 | USB-C CC1/CC2 had no ESD protection | **Done.** D8 (CC1) and D9 (CC2) single-line TVS at J1. D9's GND pad has a 1.7 mm stub to the J1 shell PTH; D8's has its own via onto the In1 plane. | 2 × TI **TPD1E05U06DPYR** (X1SON-2 / DPY0002A, 1.0 × 0.6 mm), **C436349** (53 400 LCSC / 55 229 JLC). Footprint `TI_DPY0002A` is generated from TI's land pattern (0.3 × 0.5 mm pads, 0.7 mm pitch). | Ratings (TI SLVSBO7O): VRWM 5.5 V; breakdown 6.5–8.5 V; **0.42 pF** typ; clamp 10 V at 1 A TLP; IEC 61000-4-2 ±12 kV contact. The TUSB320LAI datasheet (SLLSEQ8D) gives **no CC capacitance limit**. The USB PD cReceiver 200–600 pF window applies only to PD ports, and 0.42 pF is far below its ceiling. **Why not a 2-line SOT-23:** I tried TPD2E2U06 first, but no legal SOT-23 site exists within 6 mm of J1 (J1, U5, U6, D4 and U7 courtyards). The 0402-size parts fit the 1.9 mm column between J4 and J1. **Taps:** D9 → CC2 is 2.8 mm on F.Cu with no via; D8 → CC1 is 5.5 mm with one via. **Polarity:** JLC's library footprint for C436349 has pin 1 = I/O and pin 2 = GND on the same sides as ours; the fit is unique by pad number, so the CPL rotation is right. **Clones:** same-MPN clones exist (TECH PUBLIC, BORN), so the BOM pins the genuine TI C436349. |
| 2 | IO_INT (GPIO0, the shared open-drain interrupt) floated when the daughterboard was absent | **Done.** R47 10 k pull-up to 3V3, 6.0 mm from the J6 pads. | UNI-ROYAL **0402WGF1002TCE**, **C25744** (Basic) | **GPIO0 is not a strapping pin** on the ESP32-C3. The straps are GPIO2, GPIO8 and GPIO9 (datasheet v2.5 §3, Table 2-7). GPIO0 has no internal pull at or after reset (Table 2-1). Paralleling R47 with the daughterboard pull-up is fine; it adds about 0.33 mA when the line is pulled low. Do not fit R47 if GPIO0 ever carries a 32 kHz crystal. |
| 3 | RGB LED D5 ran above its derated forward current | **Done.** R38 150 R → **180 R**; R39/R40 100 R → **120 R**. | YAGEO **RC0603FR-07180RL** C137786; **RC0603FR-07120RL** C114640 | **Limit:** the curve on datasheet p.6 allows 20 mA up to about 27 °C, falling linearly to 10 mA at 85 °C, which gives **16.9 mA at 45 °C**. **Worst case** (min Vf R 1.8 V / G,B 2.6 V, VSYS 4.5 V, resistor −1 %, FET drop ignored): red **15.2 mA** (was 18.0); green/blue **16.0 mA** (was 19.0). 160 R would give 17.05 mA. **Typical** (VSYS 4.4 V, Vf at the min/max midpoint): red **12.8 mA** (was 15.3); green/blue **11.7 mA** (was 14.0). **Brightness**, read off the p.6 Iv–IF curve (judgment, ±10 %): red about **−18 %**, green/blue about **−10 %**. |
| 4 | R22/R23 (1.3 Ω 0805) not orderable at JLC/LCSC | **Done, superseded by the owner-approved antenna study.** R22/R23 = **1.0 Ω 1 % 0.5 W**, same 0805 land, no longer consigned. | Vishay **CRCW08051R00FKEAHP**, **C313850** (3 130 LCSC / 3 133 JLC) | **What I found first, while the brief still said to keep 1.3 Ω:** no 1.3 Ω 0805 rated ≥ 0.25 W is stocked at JLC or LCSC. I checked 15 candidates, all with 0 stock; every in-stock part is 0.125 W. In series with the coil, RQ takes most of the delivered RF power: about 0.2–0.3 W each at 250 mA ITVDD and a 3.3 V TXLDO. So 0.125 W would have been inadequate. **Resolution:** the study re-tuned around a stocked 0.5 W HP part. See *NFC matching network* below. |
| 5 | C22/C23 (13 pF C0G 1 %) had thin stock | **Done.** | YAGEO **CC0603FRNPO9BN130**, **C519488** (7 459 JLC) | Same 0603 footprint, NP0, ±1 %, 50 V. There is no Basic-class 13 pF part. Placement and copper are unchanged. |
| 6 | U12 (TLV803S) was 0.45 mm from J6's hand-soldered THT joints | **Done.** The U12/R46/C46 group moved to the top-left strip; its pads are now **≥ 65 mm** from the J6 pads. Every new part is ≥ 1.5 mm from J6. | unchanged | **Why it moved this far:** a 0.1 mm legality search (x 44–68, y 5–31) found **no legal SOT-23 site on the right half** that respects the 1.5 mm rule; the C7, C9, J2, R11, C43 and U4 courtyards block it. ESP_RESET_RC also reaches SW1 and U8 at x ≈ 33, so the group sits at that end of the net. **New routes:** SUP_RESET_N 1.6 mm, no vias; ESP_RESET_RC (R46 → SW1.1) 29.1 mm F.Cu along the top edge, **0 vias** (v0.5.2: 10.5 mm, 4 vias); 3V3 sense 27.5 mm, 1 via. The reset node is slow and has 1 µF at the far end. |
| 7 | LED supply (VSYS → D5) meandered on F.Cu and hopped 2.2 mm through In1 | **Done.** New 0.30 mm route, **33.5 mm, 2 vias, no In1**: F.Cu along the top of the LED strip → In2 under J4 → F.Cu to FB1.1. **In1.Cu now carries no tracks** (audit). | – | **UART_TX re-routed:** this service-only net (J4.3 → U1.31) is now 32.9 mm with 2 vias and still connected. UART_RX is unchanged. **Multi-via clean-up** (v0.5.2 → v0.5.3): RGB channel nets 10 vias → **0**, all F.Cu 45° runs after re-packing Q1–Q3/R38–R43 (D5 and R16–R18 fixed); ESP_RESET_RC 4 → 0; SUP_RESET_N 2 → 0; BOOT_IO8 3 → 2 (7.1 mm); buzzer 3V3 at R44.1 2 → 1. |
| 8 | 0.30–0.35 mm necks on VBUS/VIN_SEL | **Partial.** 5 VBUS F.Cu segments widened in place to 0.40–0.60 mm. | – | **Still ≤ 0.35 mm:** VBUS 17.5 mm and VIN_SEL 5.1 mm. **Limits:** clearance around the USB/CC/J1 pin loop, and pad width (the U10 VIN_SEL lands are 0.24 mm). **Kept:** 1 oz outer copper, rated about 1.0–1.1 A at 10 °C rise (IPC-2221). **Log:** `output/v053-necks.json`. Sense-tap stubs (0.25 mm) were deliberately left alone. |

**Left unchanged, as instructed:**
- the ≥ 1.5 A USB-C boot gate;
- the GPIO count;
- the daughterboard;
- the buzzer circuit;
- the NFC coil and copper-free region;
- the Wi-Fi keepout;
- the board title.

The title is a placeholder ("FIELDNOTE / v0.5.3 / 2026-11-13"); the name and logo are an owner decision still to come.

## NFC matching network (owner-approved values from `../nfc-antenna-study/README.md` §7)

Only values and MPNs on the existing pads changed. **No RF part moved and no RF track or via changed.**

| Ref | v0.5.2 | v0.5.3 | Part, LCSC (JLC stock 2026-11-13) |
|---|---|---|---|
| C24, C25 (C0) | 330 pF 2 % | **330 pF 1 %** C0G 50 V 0603 | Yageo CC0603FRNPO9BN331, **C519562** (37 000) |
| C26, C27 (C1) | 130 pF 2 % | **120 pF 1 %** | Yageo CC0603FRNPO9BN121, **C519498** (39 527) |
| C28, C29 (C2) | 300 pF 2 % | **330 pF 1 %** | Yageo CC0603FRNPO9BN331, **C519562** |
| C34, C35 (C2 trim) | 47 pF, **DNP** | **15 pF 1 %, FITTED** (C2 = 345 pF) | Yageo CC0603FRNPO9BN150, **C519483** (121 131) |
| R22, R23 (RQ) | 1.3 Ω 0.5 W (consigned) | **1.0 Ω 1 % 0.5 W** pulse-proof 0805 | Vishay CRCW08051R00FKEAHP, **C313850** (3 133) |
| L1, L2 (L0) | 160 nH LQW18CAR16J00D | **160 nH 5 %**, NXP-named series | Murata LQW18CNR16J00D, **C437367** (15 763) |

- **Where the values come from:** the part notes in `design-data.json` cite the study.
- **What the study predicts:**
  - Z(TX1–TX2) 11.1 − j0.3 Ω;
  - ITVDD 207 mA nominal, bounded at about 233 mA (241 mA fast-driver corner) for any coil inductance;
  - Q 18.8.
- **Fab effect:** C34/C35 are now fitted and in the CPL. The BOM has no consigned line any more.
- **Schematic sync:** ERC is 0, and DRC schematic parity is 0 with the DNP change.

### RF geometry confirmation

The study's numbers assume the v0.5.2 RF copper. Both checks below run on the final board inside `run_v053.sh`.

**1. The study's own extractor.** Command: `../nfc-antenna-study/scripts/extract_rf_routes.py`, numpy/scipy from the study's pylibs, `/usr/bin/python3`. Output: `output/v053-rf-routes.json`.
- All **12 RF nets are identical** to the study's `results/rf-routes.json`: path lengths, via counts, widths and every pad-to-pad path.

**2. The audit** (`output/v053-audit.json`):
- all 111 track/via items on the 12 RF nets are identical to v0.5.2;
- the ANT1 footprint (coil shapes, pads, position) is identical;
- **0 teardrops on RF nets**. Teardrops are excluded on the RF nets because they are zones, which the extractor would not see.

**3. The coil surroundings** (`rf_geometry_check.py` → `output/v053-rf-geometry-check.json`; v0.5.2 vs v0.5.3, band 3 mm around the coil, every layer):

| Item | Result |
|---|---|
| Coil copper | identical (XOR 0.000 mm²) |
| Closest GND fill to the coil, per layer (plan view) | unchanged on every layer. **F.Cu 0.202 mm** at the RF feed side, **B.Cu 0.152 mm**, **In1/In2 0.003 mm** (the planes reach the coil feed pads in plan view; identical to v0.5.2) |
| GND-fill change within 1 mm of the coil | ≤ 0.02 mm² per layer. These are vertex-level arc-approximation differences. |
| GND-fill change 1–3 mm from the coil | **F.Cu +12.6 mm²** (89.9 → 102.5 mm² in the band), almost all at x 16–32.6, y 8.6–10.0. This is the strip between the re-packed LED cluster and the NFC keepout, which starts at y 10.7. In v0.5.1, LED routes and vias cut the pour there; it now fills. In1/In2/B.Cu change ≤ 0.4 mm² each (via antipads in the LED strip). |
| Board edge | unchanged near the coil except the new 1 mm radius at the bottom-left corner (x 0–1, y 44.2–45.2). Coil-to-edge distance is unchanged at 1.775 mm. |

**Verdict:** the RF routing, the coil, and the nearest fill edges the study modelled (0.3 mm right / 0.9 mm top / none left/bottom) are unchanged. **Judgment, not computed:** the only material difference is the extra F.Cu pour 1.6–3 mm above the coil's top edge. It sits behind the existing fill edge and over the solid In1 plane, which already shields that region, so the expected effect on coil L is well under 0.5 %. To confirm it numerically, the study's FastHenry plane case can be re-run on this board.

## Change table: appearance

| Item | Done |
|---|---|
| Colours | **Black** solder mask and **White** silkscreen (F and B) are set in the board stackup; finish **ENIG**; 1.6 mm, 1 oz outer / 0.5 oz inner. The renders use `--use-board-stackup-colors`, and FAB-NOTES state black / white / ENIG. |
| Outline | **Removed:** the top-left case notch. **Added:** a 1.0 mm radius on all 9 convex corners. **Kept:** the USB tongue, the Wi-Fi cut-out (x 48.1–61.5, y ≥ 38.7) and the right step below y 37. The GND pours follow the new outline. |
| Title | "FIELDNOTE", "v0.5.3" and "2026-11-13", centred inside the coil. No logo. |
| USB label | **"USB-C 5V / ≥1.5A"** (0.8 mm, two lines) right beside J1, right of the USB tongue. The KiCad stroke font renders `≥` correctly (checked in a kicad-cli plot). One line would be 10.3 mm long and has no clear spot within 6 mm of J1. It replaces the old bare "USB" mark. |
| References | All 0.8 mm text with 0.15 mm stroke, at 0° or 90°; never on pads or on another part's body; vias avoided where possible. **125 of 140 front parts are printed** (v0.5.2: 29).<br>• **Up to 3 mm away (14):** C3, C4, C16, C36, C41, D9, R15, R20, R22, R32, R44, R47, TP6, TP10. They sit up to 3 mm from their part because nothing nearer is free (`output/v053-finish.json`, `relaxed: loose`).<br>• **Hidden (15):** C12, C15, C17, C30, C37, D7, R14, R31, R35, R37, R45, TP7, TP8, TP11, TP12. No clear 0.8 mm spot exists within reach that reads as the part's own.<br>• **Layer fixes:** seven references (SW1, U8, C9, R29, R30, C38, C33) were on F.Fab and two (R27, R28) were mirrored on the bottom silk; all are now on top. |
| Other labels | Kept: "USB" / "SVC" at JP1, "BAT", and the battery "+ / −". New: **"J6" and a pin-1 "1"** on the top side at the hand-soldered J6 joints. The bottom silk carries only the J6 outline and reference. |
| Routing | Every new or re-routed segment is 0° / 45° / 90°; the audit counts 0 non-octilinear new segments. |
| Teardrops | **434** straight pad/via teardrops, flagged as KiCad teardrop zones. They are **not** applied to GND or to the 12 RF nets.<br>• **Why my own code:** KiCad 10's Python API cannot generate teardrops, so `apply_v053_pcb.py` builds them.<br>• **Determinism:** KiCad saves teardrop zones without UUIDs and re-randomises them on load. The pipeline therefore gives each a unique priority (30000 + n) and writes them in sorted order, which keeps rebuilds byte-identical.<br>• **Removal:** in the GUI, *Edit → Remove teardrops*. |

## Native checks (`run_v053.sh`, final board `200afafc…f18ac5`)

| Check | Result |
|---|---|
| ERC (`--severity-all`) | **0 violations** |
| DRC (`--severity-all --schematic-parity --refill-zones`) | **0 errors, 0 warnings (silkscreen included), 0 unconnected, 0 parity** |
| In1.Cu tracks | **0** |
| GND pour islands (F/In2/B fill polygons touching no GND via, PTH or track) | **0** (no stitch via needed) |
| Track/via diff vs `source-v052/` | **Removed 143:** exactly the textprep rip list in `output/v053-textprep.json` — the VSYS LED spur, the nine RGB nets, UART_TX, the v0.5.2 supervisor/buzzer links, and the GND stubs of the re-placed LED parts.<br>**Changed 5 pre-existing items:** VBUS width only (defect 8).<br>**Added 108:** only on the nets listed in `output/v053-routing.json` plus GND stubs and vias; nothing on RF nets. |
| Footprints | **Added:** D8, D9, R47.<br>**Moved:** U12, R46, C46, Q1–Q3, R38–R43.<br>**Values:** R38–R40 and the RF set above.<br>**MPN:** C22/C23, L1/L2.<br>**DNP → fitted:** C34/C35.<br>**RF area:** no footprint moved. |
| Determinism | Two full runs from `source-v052/` gave byte-identical board, schematic and design-data hashes. |

## Open items / owner decisions

1. **Board name and logo:** the title is a placeholder, pending your choice.
2. **15 hidden references** (listed above): use `output/v053-finish.json` or the assembly drawing for them. Showing them all would need 0.6 mm text or local re-placement.
3. **NFC first-board check** (from the study):
   - run the PN7160 antenna self-test / TVDD current on the first assembled board;
   - re-tune values from the study's lookup table if needed. Tuning is a capacitor-only swap on existing pads.
   - The study also suggests DNP C1-trim pads for a later revision. They were not added here because they would change RF placement.
4. **Optional:** re-run the study's FastHenry plane case on this board to put a number on the extra F.Cu pour 1.6–3 mm above the coil (judged < 0.5 % L above).
5. **LED colour balance** changes slightly (12.8 / 11.7 / 11.7 mA typ); re-trim the firmware white point.
6. **D9's CC2 tap runs on F.Cu under J1's body.** It joins the existing CC2 F.Cu run there; this is normal for a USB-C receptacle footprint, mentioned for review.
7. **3D models:** TI_DPY0002A and the 0402/SOD-523 footprints have no 3D model, so they show as bare pads in the renders (cosmetic).
8. **Bench checks:** everything is untested hardware. The v0.5.2 checks (buzzer, supervisor timing) still apply. New for v0.5.3:
   - CC detection with D8/D9 fitted, on a 1.5 A and a 3 A source;
   - IO_INT idles high without the daughterboard;
   - LED brightness.

## Fab export (`export_fab_v053.py` → `../fab-export/out-v0.5.3/`)

The wrapper runs `fab-export/export_fab.py` unchanged. Everything else in `fab-export/` was left untouched:
- **Sourcing overlay:** `output/sourcing-map-v053.json` = `fab-export/sourcing-map.json` + the new parts. It is patched in for this run only.
- **Cache copy:** `fab-cache/`, so `fab-export/cache` is not written.
- **FAB-NOTES post-processing:** export_fab.py hard-codes a green mask and the old notch text. The wrapper rewrites those rows from the board stackup: black / white / ENIG, no notch, and the bottom silk is J6 only.

| Check | Result |
|---|---|
| Gerbers | 11 / 11 (4 copper, mask × 2, silk × 2, paste × 2, Edge.Cuts) plus the job file |
| Drill hits vs board | match. PTH: 0.20 × 195, 0.30 × 63, 0.50 × 8, 0.60 × 4, 0.65 × 10, 0.75 × 2. NPTH: 0.65 × 2 |
| CPL rows = fitted top SMT parts | **116 = 116** (C34/C35 now included) |
| BOM | **60 lines, 116 designators, 0 without LCSC** (no consigned parts any more) |
| Rotation review / polarity flags | 0. D8/D9 polarity was verified by hand against JLC's library pin names. |
| Orientation overlay | `orientation-overlay.png`: every JLC footprint lands on its board pads. |
| Substitutions (unchanged from v0.5.2) | C3/C4/C6, R6, R44, SW1/SW2, U1 |

Re-running only the BOM after a value change: edit `design-data.json` through `prepare_v053.py`, run `./run_v053.sh`, then run `export_fab_v053.py`.
