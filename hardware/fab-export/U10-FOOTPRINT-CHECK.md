# U10 TPS2121RUXR: footprint and pin-map verification

**Verdict: PASS.** The footprint `Fieldnote.pretty/TI_RUX0012A.kicad_mod` matches TI's recommended land pattern. The U10 pin-to-net map in `design-data.json` matches the TPS2121 pinout. The suspected OV1/GND swap does not exist.

Source: TI datasheet SLVSEA3F (Aug 2020), downloaded from ti.com on 2026-11-13:
- §6 Pin Configuration and Functions;
- RUX0012A Package Outline, Example Board Layout and Example Stencil Design (drawing 4224010/A, pp. 38–40).

A second, independent check: the JLC/EasyEDA library symbol for C485916 uses the same 12-pin map, and its land fits the board footprint with 0.00 mm pad-centre error (at a 270° library rotation).

## Package (TI outline 4224010/A)

| Item | TI | Footprint (F.Fab / pads) | OK |
|---|---|---|---|
| Body | 2.0 ±0.1 (x) × 2.5 ±0.1 (y), 1.0 max | fab outline 2.0 × 2.5 | yes |
| Exposed pad | none (VQFN-HR, "HotRod") | none | yes |
| Pin 1 | upper-left corner (pin-1 index area), large pad | pad 1 at (−0.675, −0.35), silk pin-1 triangle upper-left | yes |

## Land pattern (TI "Example board layout", top view)

| Item | TI | Footprint | Δ |
|---|---|---|---|
| Pad count | 12 (4 large + 8 small) | 12 (pads 1, 2, 7, 8 large; 3–6, 9–12 small) | 0 |
| Large pads 1/2/7/8 | 4X (1.05) × 4X (0.4), pitch 2X (0.7) in y, centres 1.35 apart in x | 1.05 × 0.40 at x ±0.675, y ±0.35 | 0.000 mm |
| Small pads | 8X (0.6) × 8X (0.2), pitch 6X 0.5 | 0.20 × 0.60 at x ±0.25 / ±0.75 | 0.000 mm |
| Small-pad rows | (2.3) centre to centre | y ±1.15 | 0.000 mm |
| Numbering (top view, CCW) | top row 12 … 9 left→right; 1 \| 8; 2 \| 7; bottom row 3 … 6 | 12 (−0.75, −1.15) … 9 (+0.75, −1.15); 1 (−0.675, −0.35) / 8 (+0.675, −0.35); 2 / 7 at y +0.35; 3 (−0.75, +1.15) … 6 (+0.75, +1.15) | match |
| Corner radius | (R0.05) typ | roundrect 25 %: 0.05 on the small pads, 0.10 on the large pads (about 1.5 % less area) | cosmetic |
| Solder mask | NSMD, 0.05 max all around | board pad-to-mask clearance 0 (1:1 openings) | within TI limit |
| Stencil | 100 % printed coverage, 0.1 mm stencil, apertures = pads | F.Paste = pad, paste margin 0 | match |

## Pin map

| Pin | TI name / function (§6) | design-data name | Net | OK |
|---|---|---|---|---|
| 1 | OUT | OUT | VIN_SEL | yes |
| 2 | IN2 | IN2 | VBUS | yes |
| 3 | CP2 (comparator; GND if unused) | CP2 | MUX_CP2 (R33/R34 divider) | yes |
| 4 | OV2 (active-low enable/OVP for IN2; GND if unused) | OV2 | GND | yes |
| 5 | OV1 (active-low enable/OVP for IN1; GND if unused) | OV1 | GND | yes |
| 6 | PR1 (priority; divider from IN1) | PR1 | MUX_PR1 (R31/R32 from 5V_FIELD) | yes |
| 7 | IN1 | IN1 | 5V_FIELD | yes |
| 8 | OUT | OUT | VIN_SEL | yes |
| 9 | ST (status) | ST | PWR_SRC | yes |
| 10 | ILIM | ILM | MUX_ILM (R35 59 k) | yes |
| 11 | SS | SS | MUX_SS (C39) | yes |
| 12 | GND | GND | GND | yes |

On the OV1/GND concern: pin 5 is OV1 and pin 12 is GND, as in TI's table. Both are tied to net GND, which is TI's instruction for unused overvoltage protection. Even swapped names would therefore be electrically identical, but the names are not swapped. With OV1 and OV2 low, both channels stay enabled and OVP is unused. The BQ24074 keeps its own input OVP.
