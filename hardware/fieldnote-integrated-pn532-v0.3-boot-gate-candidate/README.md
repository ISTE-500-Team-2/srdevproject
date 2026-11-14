PN532 USB boot-gate engineering candidate

This separate revision starts from the frozen integrated PN532 v0.2 board. It adds the same USB-qualified ESP32 reset circuit as the PN7160 candidate while retaining the original PN532 chip, RF matching parts, tuning pads, PCB antenna, clock, USB connector, charging circuit, battery connector, three LEDs and board outline.

NORMAL operation requires a USB-C source advertising 1.5 A or 3 A. JP1 has a default copper bridge between pads 1 and 2. To select experimental SERVICE operation, cut that bridge completely before soldering pads 2 and 3. Never bridge both sides: doing so shorts U7's low output to 3V3. SERVICE does not qualify low-current programming, charging, battery operation or NFC at low battery voltage.

The Schmitt gate drives only ESP32 CHIP_EN. The RESET switch, C9 and recovery-header pin 5 act on ESP_RESET_RC. R12's pullup follows POWER_PERMIT; a brief unplug/replug may retain C9 charge and shorten the delay. The original PN532 R19 100k pulldown to GND remains, and GPIO7 releases PN532 only after USB qualification.

Native saved and refilled DRC, schematic parity, ERC and pin/MPN/DNP checks pass for the frozen snapshot. Exact preservation evidence covers all 43 source members, all 98 original footprint poses and pad geometries, the outline and zone definitions, and all 1,082 old copper items retained after the eleven declared reset/R12 isolation removals.

Engineering HOLD remains. The complete USB/charger/regulator startup and simultaneous Wi-Fi/NFC transient path has not been verified. The 53.537 mm ESP enable route crosses regions with incomplete adjacent ground coverage; the geometric screen does not qualify signal integrity or immunity to noise. New assembly/case/RF reviews must bind to this revision. Physical antenna tuning, thermal behavior, charger/battery qualification and manufacturer placement/stencil acceptance remain outstanding.

The native BOM and CPL are review artifacts only. JP1 is PCB copper and is excluded from both. Existing DNP battery/NTC/recovery footprints remain excluded. No Gerber package, upload, order or manufacturing release is implied.

Do not run build_design.py main() against routed CAD. Preparation/import scripts are for a new separate candidate only. The source-v02 directory is an exact read-only seed; output/native-review-candidate-v3a is the immutable review snapshot.
