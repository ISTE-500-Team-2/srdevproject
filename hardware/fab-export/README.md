# Fieldnote fab / assembly export (JLCPCB-style)

```
KiCad-python export_fab.py <project_dir> <out_dir> [--build usb|field] [--qty N] [--refresh] [--offline]
```

Any `python3` works; the script re-executes itself under KiCad's Python. It never saves the board. The current package is `out-v0.5.2/`, built from `fieldnote-integrated-pn7160-v0.5.2-candidate` (board SHA-256 `78e671b3…2716e6`), build `usb`, with `--offline` (cache dated 2026-11-13).

| File | Content |
|---|---|
| `out-v0.5.2/gerbers/` | 11 Gerber X2 files: 4 copper, mask ×2, silk ×2, paste ×2, Edge.Cuts; Protel extensions; job file |
| `out-v0.5.2/drill/` | Excellon in mm, PTH and NPTH separate, plus Gerber drill maps |
| `fieldnote-CPL-JLC.csv` | Designator, Mid X, Mid Y, Layer, Rotation. 111 parts, JLC rotation and origin corrections applied |
| `fieldnote-BOM-JLC.csv` | Comment, Designator, Footprint, LCSC. 58 lines; no DNP parts, test points, solder jumpers or ANT1 |
| `sourcing.csv` | Every fitted MPN with LCSC, JLC class, JLC and LCSC stock, status, spec note and footprint fit against the JLC library |
| `rotation-report.csv` | Per part: KiCad rotation, correction, JLC rotation, fit error, source of the correction, polarity check |
| `orientation-overlay.png/.svg` | JLC library pads (red) over the board pads (grey); red dot = JLC pin 1, blue ring = KiCad pad 1 |
| `FAB-NOTES.md` | Stackup, finish, rules, edges/panel, DNP, consigned parts, substitutions, polarity watch list |
| `checks.json` | Sanity checks (all pass, see below) |
| `U10-FOOTPRINT-CHECK.md` | TPS2121 RUX0012A footprint and pin-map verification: PASS |

Inputs:
- `sourcing-map.json`: curated MPN → LCSC decisions; the v0.5.2 parts were added and reviewed 2026-11-13.
- `rotation-corrections.json`: six reviewed corrections (D5, BZ1, J1, SW1/SW2, C22/C23, R22/R23). Everything else uses the automatic pad fit (`tools/rotfit.py`), and only when it is unambiguous by pad number.
- `cache/`: JLC, LCSC and EasyEDA lookups.

## Sanity checks on out-v0.5.2

| Check | Result |
|---|---|
| Gerber layers | 11 / 11 expected; X2 file functions L1 Top, L2 Inr, L3 Inr, L4 Bot, plus mask, legend, paste, profile |
| Drill hits against the board database | match. PTH: 0.20 ×209, 0.30 ×64, 0.50 ×8, 0.60 ×4, 0.65 ×10, 0.75 ×2. NPTH: 0.65 ×2 |
| CPL rows = fitted top-side SMT parts | 111 = 111 |
| BOM | 58 lines, 111 designators. One line without LCSC: R22/R23 (consign) |
| Rotation review items | 0 (every part is fitted automatically or has a reviewed entry) |
| Polarity cross-check (diodes, LED, buzzer, using JLC symbol pin names) | 0 mismatches |

## Sourcing summary (qty 10 boards, stock as cached 2026-11-13)

58 BOM lines / 111 placements:
- 51 lines as designed;
- 6 lines substituted;
- 1 line consigned.

JLC class by line: 7 Basic, 1 Preferred Extended, 49 Extended, 1 none (consigned).

**Substitutions** (design MPN not orderable in quantity):

| Refs | Design | Fitted | Why acceptable |
|---|---|---|---|
| SW1 SW2 | E-Switch TL3701AF100QG | HYP 1TS016A-1000-0600-CT (C390633) | Same 3.0 × 2.6 mm, P1.8 family. Verified on the HYP drawing: pins 1-2 and 3-4 internally common along the long axis, matching the board's row nets. Lands 0.55 × 0.6 sit inside the board's 0.75 × 0.8 pads. Height 0.60 mm against 0.65 mm. |
| U1 | ESP32-C3-MINI-1-N4X (0 stock) | ESP32-C3-MINI-1-H4X (C41349510) | Same module and silicon revision, 105 °C grade. This is judgment and has not been bench-tested. |
| C3 C4 C6 | KEMET 22 µF 10 V | Samsung CL21A226MAQNNNE 25 V X5R (C45783, basic) | Same value, higher voltage rating |
| C28 C29 | YAGEO 300 pF 2 % C0G | Murata GRM1885C1H301GA01D (C3903622) | Same value, tolerance and dielectric |
| R6 | YAGEO 1.62 k 1 % | UNI-ROYAL 0603WAF1621T5E (C22844) | Same value and tolerance |
| R44 | Vishay CRCW08054R70 HP | ROHM ESR10EZPF4R70 0.4 W (C307921) | Any 0805 ≥ 0.25 W is acceptable; the v0.5.2 AC-coupled gate removes the stuck-on DC case |

**Consigned:** R22/R23 (Vishay CRCW08051R30FKEAHP, 1.3 Ω 0.5 W 0805, antenna damping). Re-checked against the cached JLC search of 2026-11-13 (`cache/jlcsearch_1.3Ω*`):
- every 1.3 Ω 0805 rated ≥ 0.25 W in the JLC library shows 0 stock;
- every in-stock one is 0.125 W.

There is no verified equivalent.

**Parts the brief expected to need substitutes, but which are orderable as designed:**
- Coilcraft LPS3015-152MRC: C17382749, 328 in stock. A Sunlord backup is listed but not footprint-verified.
- NDK 27.12 MHz Y1: C3008209, 705 in JLC stock, CL 10 pF, ESR 60 Ω. Do not substitute; the 2016 alternatives in stock are CL 6 pF.
- Samtec FTSH-105 (J6): C6860184, 95 in stock, but **DNP for the USB build**.

**Thin stock** (fine for 10 boards; reorder before larger runs):
- C22/C23 KEMET 13 pF 1 %: 68
- L3: 328
- U2 PN7160: 507
- C28/C29: 660
- Y1: 705
- C26/C27: 909
- U11: 910
- C9/C19/C36/C41/C42 KEMET 1 µF: 931
