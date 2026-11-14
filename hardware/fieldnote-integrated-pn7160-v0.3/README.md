# Fieldnote integrated PN7160 v0.3

This is the separate cheaper-reader design. It replaces the PN532 circuitry with PN7160A1HN/C100E and a new NCI firmware driver while retaining the existing case outline, ESP32-C3-MINI-1-N4X, native USB-C, USB supply qualification, three LEDs, USB charging circuit and future battery connector. The first batch is intended to use qualified USB power with no battery fitted.

Open `fieldnote.kicad_pro` in KiCad 10. The native board is `fieldnote.kicad_pcb`; `fieldnote.kicad_sch` contains separate USB/power, ESP32/LED, PN7160 and NFC/RF sheets. The local symbol and footprint libraries travel with the project. The original PN532 design remains in its own v0.2 directory.

The PN7160 uses GPIO4/5 for I2C at seven-bit address 0x28, GPIO7 for active-high VEN and GPIO20 for active-high IRQ. R19 holds VEN low during host reset. Normal assembly fits R27 and leaves R28 unpopulated. UART recovery requires removing R27, fitting R28 and holding VEN low; both links must never be fitted together. Native USB remains the normal programming interface.

The selected power configuration ties VBAT/VDDUP to filtered VSYS and VDDPAD to the ESP32 3.3 V supply. PN7160 internal 1.8 V and TXLDO outputs have separate local bypass rails. USB full operation configures TXLDO to 3.3 V and requires local VDDUP at least 3.6 V. Future battery-only operation needs a separately qualified voltage-aware transmit profile.

The RF values are a conditional first-article tuning seed selected against the actual routed geometry: 160 nH / 330 pF EMC, 130 pF series, 300 pF shunt and 1.3 ohm damping in each leg. The differential receiver uses 2.2 kohm / 1 nF AC coupling from the EMC nodes. DPC is disabled for this matching configuration. The NXP-approved NDK 27.12 MHz crystal uses provisional 13 pF load capacitors.

The project is under engineering review. `output` stores native check results and candidate routing reports; check the report hashes against the saved board before treating a result as current. ERC, DRC and net/field parity establish static consistency. The simulation reports distinguish exact routed geometry from assumed coil capacitance, out-of-band inductor loss models and unmodeled internal PMU dynamics.

The inherited KiCad project ignores missing-courtyard findings. A clean native DRC therefore still needs the independent fitted-body/case clearance review before assembly approval; pad clearance alone does not establish physical component separation.

Before a manufacturing release, finish the native checks, assembly sourcing review and firmware build review. First-article measurements still need to establish antenna impedance/Q in the final case, crystal startup/frequency, receiver AGC/waveform limits, startup and Wi-Fi/RF current transients, thermal performance, and Classic/Type2 safe write/read-back behavior. Simulation cannot establish those measurements from the available models.

`design-data.json` is the component/net/placement source. `integrate_pn7160.py --schematic-only` refreshes schematics and component tables without touching routed copper. Its `--seed` mode is intentionally locked after the first conversion from the immutable baseline. `build_design.py` refuses a normal full build to prevent the old PN532 generator from overwriting this native variant.

Review records:

- `source-revision.json` and `baseline/` identify the frozen original PCB.
- `manufacturing/pin-signal-review.md` records the actual PN7160 pin, power and service map.
- `manufacturing/audit_native_pins.py` independently compares native board pads, schematic netlist and component metadata.
- `manufacturing/audit_geometry_preservation.py` independently compares final geometry with the frozen original and conversion seed after native zone refill.
- `manufacturing/audit_footprint_land_agreement.py` compares embedded native copper, drill, mask and paste pads with the saved local libraries; board-owned zone overrides are listed separately.
- `simulation/pn7160-hardware-reference.md`, `simulation/results/` and `manufacturing/factory-test-PN7160.md` define remaining qualification.
- `manufacturing/pn7160-procurement.json` reports fitted cost and minimum catalog purchases separately from a PCBWay assembly quote.
- `manufacturing/pn7160-procurement-addendum.json` keeps exact-MPN sourcing and paid-lot scenarios separate from the fair NFC-only comparison and delivered-board cost.
