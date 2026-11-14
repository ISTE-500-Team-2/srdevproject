FIELDNOTE INTEGRATED NFC + ESP32 PCB
Revision 0.1 / 2026-10-03 / REVIEW DRAFT

This package contains an editable circuit and a case-specific component
placement. Signal traces have not been routed. KiCad 10.0.6 loaded the project;
native ERC has zero violations. Native DRC fails: 17 copper-edge errors,
201 warnings, 220 unconnected items and 37 schematic parity issues.
The board is not released for fabrication.

Current assembly scope is USB power with NO BATTERY. The connector and
charging circuit are provisions for future use. No battery fit is assumed.
The manufacturer is intended to assemble the components when released.

LATEST SIMULATION REVIEW

output/pdf/Fieldnote-simulation-review.pdf supersedes the older v0.1 overview
PDF/ZIP's verification statements. simulation/README.txt explains evidence,
assumptions and reproduction. Results include three TI regulator transients,
FastHenry antenna copper extraction, passive RF matching checked in ngspice,
10,000 RF sensitivity samples, USB power budgets and full case-solid checks.

Release remains HOLD: initial RF matching fails, USB power margin is not
robust over all bounded assumptions, connector leads / green guide / USB
aperture need mechanical work, and PCB routing/native DRC remain unfinished.
simulation/results/candidate-base-fit-corrections.stl is a reviewable case
alternative, not a strength-tested replacement of the existing V17 case.

INCLUDED DESIGN

ESP32-C3-MINI-1-N4, bare PN5321A3HN/C1, a printed 3-turn NFC loop, three LEDs,
USB-C power/data, BQ24074 charging and power path, protected 1S LiPo connector,
external battery temperature-sensor connector, TPS63031 3.3 V buck-boost,
battery-voltage divider, RESET/BOOT buttons, recovery header and test points.

The protected battery is external to the board's protection circuitry. Use a
standard 4.2 V charge-termination cell, not a 4.35 V LiHV cell. A battery pack
and internal mounting arrangement have not yet been selected.

OPEN THE PROJECT

Open fieldnote.kicad_pro in KiCad. The root schematic is fieldnote.kicad_sch
and the board is fieldnote.kicad_pcb. Local symbol/footprint library tables
use ${KIPRJMOD}; there are no absolute library dependencies or 3D model links.
The legacy KiCad 7 file versions load in the verified KiCad 10.0.6 runtime.
Other KiCad versions have not been tested.

Circuit sheets:
  usb-power.kicad_sch    USB-C, charger, power path, regulator and ADC divider
  esp32-leds.kicad_sch   ESP32-C3, programming, boot/reset and three LEDs
  pn532.kicad_sch        PN532, supplies, crystal and test points
  nfc-rf.kicad_sch       RF matching network and copper antenna

Global net labels connect across sheets. Explicit NC markers identify unused
pins. IC pin numbers include the exposed thermal/ground pads.

output/Fieldnote-PCB-review.pdf gives the design overview, case dimensions,
component placement and circuit sheets. output/board-preview.png is a
placement drawing derived from the project data, not a rendered routed board.
output/BOM.csv is a review BOM, not an assembly-order BOM.
output/placement.csv uses board-local coordinates, not manufacturing centroids.
output/pin-net-map.csv records every component pin and assigned net.
output/board-outline.dxf contains the outline and LED aperture centers.
output/validation.json records the checks actually performed.

CASE COORDINATES

Source: 3D Modeling/esp32_nfc_v17_braced_case; V13-derived bottom with V17
bracing and V16 LED lid. Source geometry and the exact V17 bottom STL used in
the sampled clearance check are copied into references/.

Case exterior: 68.1 x 50.5 x 10.0 mm.
Board main panel: 65.5 x 45.2 mm; total envelope with USB tongue 65.5 x 47.2 mm.
Board thickness: 1.6 mm nominal. Four copper layers are proposed.
PCB (0,0) maps to assembled case (1.3,3.8) mm; +Y points to the rear.
Board bottom/top Z: 0.8/2.4 mm. The 0.6 mm floor requires a 0.2 mm spacer.
The retaining cap leaves about 1.1 mm upward play; add a fitted support/holder.
LED board centers: (10.7,4.2), (20.7,4.2), (30.7,4.2) mm.
LED assembled case centers: (12,8), (22,8), (32,8) mm.
The assembled Y=8 value accounts for the lid's mirrored print orientation.
LED holes: 3.3 mm diameter. Light pipes/holders remain to be fitted.
USB opening center: case X=54.4 mm; existing aperture 9.1 x 5.1 mm.

The outline clears sampled sections of the bottom STL at Z=0.801, 1.6 and
2.399 mm. Full solid checks were subsequently run against the base and lid.
Component envelopes clear at nominal placement, except connector leads below
the board; pose allowances expose tight USB clearance. The straight green
light pipe hits the retaining clip. See the latest simulation review.

FIRMWARE MAPPING

PN532: SDA GPIO4, SCL GPIO5, 7-bit I2C address 0x24, 100 kHz.
LED green GPIO1; amber GPIO3; red GPIO10. Active high, with 1 kOhm resistors.
Native USB: GPIO18 D-, GPIO19 D+. Enable USB CDC on boot in the C3 build.
Battery ADC: GPIO0, 220 kOhm/100 kOhm divider, 100 nF filter.
GPIO6 and GPIO7: spare test points. UART recovery: RX20/TX21 plus EN/BOOT9.
Existing firmware is unchanged. LED state behavior and calibrated battery
telemetry require implementation and testing.

POWER DETAILS

J2 pin 1 is BAT+; pin 2 is GND. Verify the mating cell cable polarity.
J3 connects a 10 kOhm-at-25 C NTC bonded to the cell. Open TS inhibits charging.
Choose the exact NTC and confirm its hot/cold thresholds from the TI data sheet.
Nominal charge current is 100 mA, approximately 111 mA at the upper tolerance.
Select a protected cell rated for that charge current and system peak discharge.

EN2 is low and EN1 pulls up from 3.3 V, selecting a 500 mA input ceiling once
that rail rises. This is not USB current negotiation or enumeration compliance;
qualify it for the intended 5 V source or implement input-current control.
The charger's power-path output feeds the regulator and filtered PN532 VBAT.
PN532 DVDD supplies its AVDD/TVDD domain; this domain is separate from ESP32 3V3.

RF AND ROUTING WORK

NFC loop: 29.4 x 31 mm outer centerline, 3 turns, 0.8 mm trace, 0.5 mm spacing.
The inner terminal returns on B.Cu via two through-hole pads. The footprint
uses a net tie between ANT_A/ANT_B to model the DC-continuous antenna copper.
Inspect KiCad's handling of the net tie and copper graphics during native DRC.

Matching values are initial tuning positions. Measure fabricated impedance/
inductance and tune at 13.56 MHz with the final case, cell position and tags.
Metal cell foil near the loop can change tuning and read range.
The NFC area has no copper pours on any layer. Do not route unrelated signals
or add ground under the antenna. Maintain the ESP32 antenna notch/keepout.

Route the regulator and charger current loops first; use the manufacturer
layouts, suitable ground returns, thermal vias and capacitor placement.
Revisit placement for RF/oscillator routing before committing to it.
Route and verify the USB pair, I2C and control signals, then fill approved zones.
Finalize trace/clearance/stackup rules with the selected fabricator.
Run native ERC and DRC and inspect the board before generating fabrication data.

PARTS TO FINALIZE

The schematic identifies major ICs and the crystal. Exact passive part numbers,
RF inductors, ferrite, buck-boost inductor, LEDs, switches, light pipes, NTC and
battery remain to be selected. The generic switch, LED and 3x3 inductor
footprints require comparison with the selected manufacturers' land patterns.
DNP indicates tuning positions or unpopulated recovery connectors.
NXP lists PN532 as not recommended for new designs; confirm authorized supply.

REBUILD

python3 build_design.py regenerates circuit, board, tables and validation using
the Python standard library and the included case STL. placement-lock.json
holds the current placement. Editing generated files directly will be
overwritten on rebuild; either edit generator inputs or stop using the generator.
python3 render_review.py regenerates PDF/PNG and requires reportlab and Pillow.
The PDF uses standard fonts; the preview uses Arial when available or a fallback.
That older overview generator predates the full simulation workflow. Rebuilding
it does not validate the design. Re-run native checks and the simulation scripts
after any design change; results/preflight-status.json fingerprints tested files.

SOURCE REFERENCES AND ATTRIBUTION

NXP PN532: https://www.nxp.com/docs/en/nxp/data-sheets/PN532_C1.pdf
NXP antenna guide: https://www.nxp.com/docs/en/application-note/AN1445_An1444.zip
NXP product status:
https://www.nxp.com/products/rfid-nfc/nfc-hf/nfc-readers/nfc-integrated-solution:PN5321A3HN?lang_cd=en
ESP32-C3-MINI-1:
https://www.espressif.com/sites/default/files/documentation/esp32-c3-mini-1_datasheet_en.pdf
Espressif layout guidance:
https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/schematic-checklist.html
TI charger: https://www.ti.com/lit/ds/symlink/bq24074.pdf
TI regulator: https://www.ti.com/lit/ds/symlink/tps63031.pdf
ST protection: https://www.st.com/resource/en/datasheet/usblc6-2.pdf
Abracon crystal: https://abracon.com/Resonators/abm8.pdf

Local footprints are based on KiCad and Espressif libraries, with format
conversion and local adaptations. Their CC-BY-SA 4.0 notices and design-use
exceptions are retained in references/KiCad-LICENSE.md and
references/Espressif-LICENSE.md.
https://github.com/KiCad/kicad-footprints
https://github.com/espressif/kicad-libraries
