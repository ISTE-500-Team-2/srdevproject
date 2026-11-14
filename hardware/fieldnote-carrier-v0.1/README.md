# Fieldnote passive carrier v0.1

**REVIEW CANDIDATE — module identity and mating dimensions are unverified.** This carrier keeps the existing ESP32 development board and AITRIP PN532 V3 module, replacing their four Fieldnote jumper connections with PCB traces. It is a separate prototype from the integrated PN532/PN7160 boards. It adds no processor, NFC chip, NFC antenna, charging circuit, regulator or USB connector. USB power, programming and reset remain on the existing ESP32 board.

The assumed ESP32 footprint is a narrow original-ESP32 **30-pin / 2 × 15** development board. The currently available records establish a photo-derived 24.5 × 50.03 mm envelope and a USB-C connector; they do **not** establish the exact board model, hole positions or header order. The footprint below is an explicit design assumption, not a measured match. Do not fabricate from this candidate until the physical module and native design checks have been reconciled.

## Electrical connections

Use the existing standalone Fieldnote I²C profile at 100 kHz. Set the PN532 switches to **S1 ON, S2 OFF**. ESP32 GPIO17 remains SDA and GPIO22 remains SCL; the deployed board's unavailable GPIO21 is not used. These connections do not apply to the alternate ESP32-C3 GPIO4/5 profile or the gateway SPI profile.

| Carrier connection | ESP32 signal | PN532 V3 connection |
|---|---|---|
| J2 pin 1 | GND | GND |
| J2 pin 2 | VIN / USB 5 V | VCC |
| J2 pin 3 | GPIO17 | SDA |
| J2 pin 4 | GPIO22 | SCL |

**J2 numbering belongs to this carrier.** The Elechouse family schematic numbers its module connector in the opposite direction: JP1.1 SCL, JP1.2 SDA, JP1.3 VCC5V, JP1.4 GND. Confirm the actual AITRIP module's labels, orientation and hole positions before mating the boards.

Power the assembly through the ESP32's existing USB connector and retain a data-capable cable for programming. The documented AITRIP Fieldnote setup supplies PN532 VCC from 5 V; 3.3 V can leave this module's reset circuit below its release threshold. ESP32 GPIO signals must remain at 3.3 V. The carrier introduces no additional power input.

R1/R2 are optional **4.7 kΩ 0805 I²C pullups to ESP32 3V3 only**, default **DNP**. The default population preserves the existing signal connections. Do not populate them without checking the actual module's existing pullups and bus levels; do not pull ESP32 SDA/SCL up to 5 V. Test pads expose 5 V, 3V3, GND, SDA and SCL. Unused ESP32 pins are not routed to the reader.

## Assumed mating footprint

J1 is one composite 30-pin footprint accepting **two 1 × 15 female sockets**. Assumed pad pitch is **2.54 mm**, row-center separation **22.86 mm**, and the first pad in each row is at **Y = 5 mm**. Viewing the ESP32 component side with **USB toward the top**, read each row from USB toward the antenna end:

| Position | Left row | Right row |
|---:|---|---|
| 1 | VIN | 3V3 |
| 2 | GND | GND |
| 3 | GPIO13 | GPIO15 |
| 4 | GPIO12 | GPIO2 |
| 5 | GPIO14 | GPIO4 |
| 6 | GPIO27 | GPIO16 |
| 7 | GPIO26 | GPIO17 |
| 8 | GPIO25 | GPIO5 |
| 9 | GPIO33 | GPIO18 |
| 10 | GPIO32 | GPIO19 |
| 11 | GPIO35 | GPIO21 |
| 12 | GPIO34 | GPIO3 / RX0 |
| 13 | GPIO39 / VN | GPIO1 / TX0 |
| 14 | GPIO36 / VP | GPIO22 |
| 15 | EN | GPIO23 |

J2 assumes a **1 × 4 female socket at 2.54 mm pitch**, with module-side male pins. The primary V3 manual does not dimension this connector's pitch or location. Its 1.27 mm connector statement refers to auxiliary chip-pin breakouts, not the four-pin I²C connector.

Pinless modules require **three male strips** before they can plug in: two 1 × 15 strips for the ESP32 and one 1 × 4 strip for PN532. Confirm hole diameters, solder access and pin orientation. Socket and header height are additional to the PCB and module component envelopes; an existing pinless installation does not establish the stacked height.

## Geometry and mounting assumptions

The carrier envelope is **43 × 44 mm**, comprising a **33 × 44 mm main body** and a local tongue for the PN532 electrical header. It provides two nominal M2 mounting positions. Mounting hardware, standoff height and case retention are not selected.

| Envelope or datum | Candidate coordinates, mm |
|---|---|
| ESP32 nominal body | X 4.18–28.68; Y 0–50.03 |
| PN532 nominal family envelope | X 33–75.7; Y 8–48.4 |
| PN532 four-pin header | X 39; Y 20–27.62 |

The modules extend beyond the carrier outline. The combined nominal assembly reaches **X = 75.7 mm** and **Y = 50.03 mm** before connector, plug and mounting allowances; the bare carrier dimensions are not the assembly dimensions. This arrangement cannot be assumed to fit the existing 68.1 × 50.5 × 10 mm exterior case. A revised enclosure and actual header/socket height checks are required for that use.

The PN532 module overhangs the carrier so there is no full carrier ground plane beneath its NFC coil. This candidate has **no ground pours** and no newly designed NFC antenna. Keep metal fasteners and other electronics outside the coil region; use nonmetal supports where practical. The local connector tongue may still cross the left coil region; the proposed conductor crossing is approximately perpendicular. This does not establish unchanged antenna tuning or read range. Closed-case NFC and Wi-Fi testing remains necessary.

## Verification and fabrication boundary

The saved candidate passes **KiCad 10.0.6 ERC with zero violations**, and **DRC with zero violations, zero unconnected items and zero schematic parity issues**. An independent native review compared all 43 numbered pads with the actual exported schematic netlist and metadata, verified the GPIO17/22 and power connections, and confirmed that unused GPIOs are isolated. No project-defined DRC exclusions were used. KiCad's default optional ignored checks are listed in the JSON reports; they were not promoted into proof of physical module fit.

The review PDF contains an assembly overview, the actual native schematic and a 1:1 assumed mating pattern. A passed CAD check establishes this candidate's internal connectivity and clearances, not the identity of the physical modules, measured fit or powered operation. Release still requires:

1. Identify the actual original-ESP32 board; verify all 30 labels, pad order, 2.54 mm pitch, 22.86 mm row spacing, hole diameters, underside clearance and USB datum. A different pin pattern requires a footprint update.
2. Measure the AITRIP PN532 outline, four-pin connector order/pitch/datum and relevant component clearances. Check both socket/header stacks and the real USB cable envelope.
3. Run native schematic ERC, PCB DRC and schematic/PCB connectivity parity on the final saved candidate; inspect socket orientation, drills, all power/signal nets and copper placement around both antennas.
4. With power disconnected, verify continuity and absence of power shorts. During powered bring-up, confirm 5 V/3V3 rails and actual SDA/SCL idle levels, then exercise USB programming/reset, NFC reads and read-back-verified writes using the unchanged Fieldnote wiring profile.
5. Verify NFC range/reliability and Wi-Fi with the assembled carrier and intended enclosure; qualify mechanical retention, connector access and socket height.

**Do not generate or release fabrication Gerbers until module/header identity and dimensions are verified and native checks pass.** Assembly quotations and socket selections require exact part drawings after these assumptions are resolved. No manufacturer upload, order, hardware flash or physical pass is implied by this package.

## Sources

- [Current Fieldnote hardware and wiring](../../firmware/esp32_nfc_web/README.md): AITRIP PN532 V3, deployed GPIO17/22, alternate C3 GPIO4/5, 5 V module supply and 100 kHz I²C.
- [Repository wiring profiles](../../docs/WIRING.md): standalone I²C and separate gateway SPI profile. Do not combine their pin maps.
- [September 14 measurement record](</Users/maximusregent/Documents/ChatGPT/3D Modeling/esp32_nfc_photo_case_20260914/README.md>): measured ESP32 width/length envelope and photographed USB/component heights; module mounting holes and headers remain undimensioned. The original referenced photographs are not present in that project directory.
- [Elechouse PN532 V3 manual](https://www.elechouse.com/elechouse/images/product/PN532_module_V3/PN532_%20Manual_V3.pdf), pages 2–4: nominal 42.7 × 40.4 × 4 mm family envelope, component-side connector labels, interface switches and perpendicular wire crossing guidance. AITRIP clone dimensions are not verified by this family reference.
- [Elechouse PN532 V3 schematic](https://www.elechouse.com/elechouse/images/product/PN532_module_V3/PN532_shematic_drowing.pdf): module JP1 numbering, MOSFET interface level shifters and internal 3.3 V pullups. Actual clone circuitry remains to be checked.
- [Espressif DevKitC V4 dimensions](https://dl.espressif.com/dl/schematics/esp32_devkitc_v4_dimensions.pdf): official 2 × 19 header reference, 25.40 mm row centers and 27.94 mm width. **This is not the assumed narrow 30-pin footprint**, and its dimensions do not prove compatibility with the measured module.

`BOM.csv` lists the default passive carrier population, optional pullups, reused modules and module-side header requirements. Exact socket/header manufacturers and part numbers are not yet selected.

## Editable files and reproduction

- `fieldnote-carrier.kicad_pro`, `.kicad_sch` and `.kicad_pcb`: open the project in KiCad. Local symbols and footprints are included.
- `build_design.py`: generates the native candidate and assumptions. Keep module-specific changes here, then regenerate and recheck.
- `extract_geometry.py`: uses KiCad's `pcbnew` Python module to extract the saved board's actual copper and pads.
- `build_review.py`: uses ReportLab and pypdf to assemble the review PDF from the native geometry and exported schematic PDF.
- `output/erc.json`, `output/drc.json`, `output/verification.json`: current check results and their file bindings.
- `output/fieldnote-carrier-review.pdf`: review drawing and assumed socket pattern; not fabrication artwork.

After regenerating, run native schematic netlist export, ERC and PCB DRC with schematic parity. Export the schematic PDF, rerun the geometry extraction, then rebuild the review PDF. The current macOS KiCad CLI required access outside the sandbox for GUI registration during DRC; it did not require a hardware connection or modify the integrated-board designs.
