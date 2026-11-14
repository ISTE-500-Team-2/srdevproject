# Fieldnote PN7160 v0.5 — design drawings (work in progress)

Exported 2026-11-10 with kicad-cli 10 from `../fieldnote.kicad_sch` / `../fieldnote.kicad_pcb`
(board SHA-256 1c64f9903f6d2f3be6b658038252d0359edbaed5345d4fb8ba7a5826ac9e5167).
**Not a release set.** Routed and DRC-clean (0 errors, 0 unconnected), engineering review candidate; see `../README.md`.

| File | Contents |
|---|---|
| 01-schematic-v0.5.pdf | All six sheets (root, usb-power, esp32-leds, pn7160, nfc-rf, field-interface) |
| 02-assembly-top.pdf | Top assembly: fab, silk, courtyard, outline, pad sketches; DNP crossed out (2:1) |
| 03-assembly-bottom-mirrored.pdf | Back-side assembly, mirrored as seen from the back (J6 header body) (2:1) |
| 04-copper-and-mask-layers.pdf | One page each: F.Cu, In1.Cu, In2.Cu, B.Cu, F/B mask, F/B silk, with outline (2:1) |
| 05-routing-composite.pdf | F.Cu + In2.Cu + B.Cu overlay with drill marks (2:1) |
| drill/ | Excellon drill file and drill map PDF |
| 06-render-top/bottom/iso.png | 3D renders |
| 07-BOM-v0.5.csv | Schematic BOM (grouped) |

Interface daughterboard drawings: `../../fieldnote-interface-board-v0.1/drawings/`
(schematic PDF and BOM; no layout exists yet).
