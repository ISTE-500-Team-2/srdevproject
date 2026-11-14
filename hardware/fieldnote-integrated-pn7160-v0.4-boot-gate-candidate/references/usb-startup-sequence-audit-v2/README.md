# USB attach and startup sequence audit v2

**The frozen board has no hardware guarantee that higher current precedes ESP32 boot. A brownout or boot loop is plausible, not demonstrated.** The least-complex reviewed hardware proposal is a Schmitt AND gate on CHIP_EN, with a separate service selector. No solver was run and no frozen CAD, firmware, package or factory document was edited.

The read-only [audit script](audit_usb_startup.py) records 300 passing checks against the actual native schematics of PN7160 v0.3 and PN532 v0.2. It traces library pin positions through native wires to global labels, compares those connections with design-data.json, and records input hashes in [usb-startup-audit.json](usb-startup-audit.json). This is schematic evidence and arithmetic, not a manufactured-board or waveform pass.

## Actual dependency and the missing ordering

Both variants have U6 TUSB320LAIRWBR VDD on 3V3, PORT and EN_N grounded, ADDR open, OUT1 on USB_LIMITED, and OUT2 unused. R7 pulls OUT1 to 3V3; U7 SN74LVC1G04DBVR inverts it onto USB_HIGH_CURRENT. That net directly drives BQ24074 EN2; EN1 is grounded. The MCU reads OUT1 but does not authorize the hardware current-mode transition.

R26/C36 first delay TPS enable. Only afterward does U6 acquire its supply and begin powered attach detection. R12/C9 independently delay ESP_EN from the same 3V3 rail. Thus delaying TPS alone also delays U6; it cannot establish a CC-before-ESP ordering. The background current detector can remain in default-current mode while reset RC charges and the ESP begins execution.

## Exact TUSB320LAI timing evidence

Use **SLLSEQ8D, Rev D, May 2017**, linked by the [TUSB320LAI product page](https://www.ti.com/product/TUSB320LAI), not the older TUSB320 datasheet. [Primary PDF](https://www.ti.com/lit/ds/symlink/tusb320lai.pdf):

| Constraint | Exact location | Bound |
|---|---|---|
| Default CC debounce | p6, section 6.7 | 168 ms **typical**; min/max blank |
| VBUS debounce | p6, section 6.7 | 2 ms **typical**; min/max blank |
| I2C ready after enable/valid VDD | p6, section 6.7 | 100 ms maximum; not GPIO attach completion |
| VDD ramp | p3 and p28 | “VDD must ramp within 25 ms or less” |
| External EN_N control | p3 | Hold low at least 50 ms after valid VDD; this board ties EN_N to GND |
| UFP attach | p10, section 7.2.1.2 | “debounces the CC pins and wait for VBUS detection before successfully attaching” |
| OUT1 | p12, Table 3 | High for unattached/default; low for attached 1.5 A/3 A |

There is **no specified GPIO attach-completion maximum** here. The 168 ms and 2 ms entries cannot be promoted to guaranteed timing bounds or simply summed into a guaranteed 170 ms deadline. The rendered p6 was visually checked to distinguish columns. Dead-battery Rd permits the source to provide VBUS while U6 lacks its supply; it does not supply a prior valid OUT1 current report.

## Existing reset arithmetic and boot stages

For a settled step, `t = -R*C*ln(1 - threshold/supply)`. Retained engineering capacitance screens and guarded resistance values give:

| ESP R12/C9 case | Crosses 25%: first possible release | Crosses 75%: guaranteed-high level |
|---|---:|---:|
| 46.25082 kΩ, 0.4 µF | 5.322 ms | 25.647 ms |
| 47 kΩ, 1 µF | 13.521 ms | 65.156 ms |
| 47.75482 kΩ, 1.265 µF | 17.379 ms | 83.746 ms |

The ESP threshold interval and 50 µs minimum supply-stabilization/reset-low requirements come from the selected [Espressif module datasheet v2.2](https://documentation.espressif.com/esp32-c3-mini-1_datasheet_en.html), Table 6-3 pp21-22 and Table 4-6 p15. Crossing 25% does not mean the actual chip releases at that instant. These calculations exclude rail ramp, leakage, precharge and local returns; the capacitor screens are not joint manufacturer guarantees.

For comparison, nominal TPS 150 kΩ/1 µF from a 4.3 V step reaches the 0.4 V/1.2 V input boundaries after 14.646/49.082 ms. The retained minimum screen from 4.5 V gives 5.496/18.313 ms. TPS's thresholds are in [TI TPS63031 Rev D](https://www.ti.com/lit/ds/symlink/tps63031.pdf), p5. These are converter-enable arithmetic, not complete converter startup bounds. Neither delay supplies a CC completion guarantee.

The clock description must distinguish stages. The retained official bootloader source describes cold POR ROM at 40 MHz and warns that watchdog-reset paths can retain higher clocks. The installed C3 second stage normally configures 80 MHz. **Both CPU80 sdkconfig files still configure application-port startup at 160 MHz.** Product ELF disassembly corroborates 160 in esp_clk_init and 80 at Arduino app_main. Arduino CPUFreq=80 therefore improves the later application interval; it does not bound ROM, port startup, constructors, USB enumeration or flash operations. See [Espressif startup ordering](https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32c3/api-guides/startup.html) and the separately preserved startup-assumption review.

The native-path model uses 87 mA usable BQ-path current plus 3 mA explicit BQ overhead in USB100 cases. BQ's [Rev N datasheet](https://www.ti.com/lit/ds/symlink/bq24074.pdf) specifies 90/95/100 mA min/typ/max, p12; current-mode selection is in p9 Table 7-2. Its p19 description continuously monitors EN1/EN2, but provides no guaranteed mode-change settling time. The model does not simulate TUSB/U7 attachment or the autonomous BQ mode transition. Its imposed 80 mA CPU plus 6 mA overhead is not a maximum complete-boot measurement. Typical CPU currents cannot prove that envelope. Therefore the sequencing gap is real; USB100 boot failure remains unproved.

## Concrete candidate for a separate revision

Use **U8 SN74LVC1G97DBVR**, DBV six-pin SOT-23. [TI Rev N PDF](https://www.ti.com/lit/ds/symlink/sn74lvc1g97.pdf), p3 pin map and p8 Table 1, supports the following configuration:

| U8 pin | Connection |
|---|---|
| 1, In1 | GND |
| 2 | GND |
| 3, In0 | ESP_RESET_RC |
| 4, Y | Isolated ESP_CHIP_EN, U1.8 |
| 5 | 3V3, with local 100 nF |
| 6, In2 | POWER_PERMIT |

Derived truth: `CHIP_EN = RESET_RC AND POWER_PERMIT`. With permit low, output is low for either RC state. With permit high, output follows the Schmitt interpretation of RC. The inputs accommodate slow RC transitions. An ordinary SN74LVC1G08 directly on this RC is unsuitable: its [p5 recommended input rate](https://www.ti.com/lit/ds/symlink/sn74lvc1g08.pdf) is 10 ns/V at 3.3 V.

Rename the old reset node ESP_RESET_RC. **R12.1, C9.1, SW1.1/SW1.2, and J4.5 remain on that input node.** Only U1.8 moves to U8 output. Never leave the reset button or recovery reset lead shorting a push-pull output. SW2/J4.6 BOOT_IO9 remain unchanged. Recovery equipment asserts reset by pulling J4.5 low; reset pulses still must meet the chip's 50 µs requirement.

Prefer moving R12.2 from 3V3 to POWER_PERMIT. On a cold, discharged-C9 start, RC charging then follows permission rather than running in advance. Direct In2 still inhibits output on permission loss. This does not claim that BQ has settled: TI supplies no transition-time maximum.

Add a mutually exclusive three-pad selector: common POWER_PERMIT, default NORMAL bridge to USB_HIGH_CURRENT, service bridge to 3V3. Never bridge both sides or connect U7's output directly to 3V3. The service bridge changes processor permission only; **BQ EN2 continues to follow actual OUT1 detection**. Default-current sources hold the processor reset in NORMAL. Native-USB recovery on such a source requires SERVICE and remains physically unqualified.

| Candidate item | Exact MPN | Treatment |
|---|---|---|
| U8 | SN74LVC1G97DBVR | New fitted IC |
| U8 local 100 nF | CC0603KRX7R9BB104 | New C_0603; reuse frozen C32/C33 family |
| CHIP_EN pulldown 47 kΩ | RC0603FR-0747KL | New R_0603 |
| POWER_PERMIT pulldown **47 kΩ** | RC0603FR-0747KL | New R_0603; final refinement below |
| Existing R2 | RC0603FR-0710KL | Change from 100 kΩ to 10 kΩ |
| Existing R12, C9 | RC0603FR-0747KL; C0603C105K4RACTU | Retain values/MPNs |
| Selector | Copper solder bridge; SERVICE open in normal assembly | No fitted BOM item |

This adds four fitted parts and changes one existing resistor value. It is a part-count proposal, not a supplier price quote. An open-drain SN74LVC1G07 clamp would keep the original reset wiring, but needs a series discharge resistor to constrain C9 discharge current plus decoupling; with fail-safe input bias its fitted count is comparable. The Schmitt AND provides direct inhibition without discharging the large C9 through its output.

For U8, create a dedicated **TI_DBV0006A** land pattern from PDF page 36, drawing 4214840/G: six 1.10 × 0.60 mm copper pads, corner radius 0.05 mm; row center spacing 2.60 mm; pitch 0.95 mm. Pad centers relative to package center are 1=(-1.30,-0.95), 2=(-1.30,0), 3=(-1.30,+0.95), 4=(+1.30,+0.95), 5=(+1.30,0), 6=(+1.30,-0.95). Use non-solder-mask-defined lands, with the fabricator's mask/stencil clearance rules. The exact source page was visually inspected. Existing Fieldnote SOT23-6 uses different IPC alternate geometry and is not identical to this TI example. A new library/board pad check is required on the later candidate.

## Level screens, partial power and history limits

The TI U8 p5 values used here are: input leakage ±5 µA, Ioff ±10 µA at VCC=0; at the 3 V test point positive thresholds 1.50-1.87 V and negative thresholds 0.84-1.19 V. Its 100 µA output tests give high ≥VCC-0.1 and low ≤0.1 V. Operating supply is 1.65-5.5 V, p4. U7 [p6](https://www.ti.com/lit/ds/symlink/sn74lvc1g04.pdf) likewise specifies power-off leakage ±10 µA and output high ≥2.4 V at the 3 V/16 mA test point.

Our conservative arithmetic, retaining the existing ±1%/temperature resistor guard, gives:

- CHIP_EN 47 kΩ pulldown: ≤0.480 V from 10 µA gate leakage plus 50 nA ESP input leakage; high-state load ≤77.9 µA, retaining the U8 high-level test condition.
- R2 10 kΩ: ≤0.305 V for a conservative combined 30 µA off-state allowance, below BQ's 0.4 V low boundary; the permit pulldown helps further.
- POWER_PERMIT **47 kΩ**: ≤0.478 V for both U8 input leakages, below the 3 V negative threshold minimum.
- With R12 supplied by permit, RC steady high is ≥2.161 V using U7's 2.4 V lower screen and 5 µA leakage; low steady RC is ≤0.339 V. These satisfy the specified U8 thresholds **at the 3 V test point**. They do not assert a manufacturer-guaranteed threshold interpolation over every possible rail voltage.

The earlier 100 kΩ permit pulldown would see both input leakages after R12 is moved: up to 1.016 V. That can retain a previously high Schmitt state when the selector is unbridged. It is therefore superseded by 47 kΩ for a claimed fail-low no-bridge state. Keeping 100 kΩ requires a closed selector and no powered/unbridged fail-safe claim.

At valid 3 V gate supply, empty C9, a 2.4-3 V permit step and the retained RC/leakage screens, the calculated U8 switching interval is **11.545-121.081 ms**. That is a conditional cold-step screen. It is not a guaranteed loaded-source settling interval. If C9 is precharged, a short permit-low event can yield immediate release when permission returns. A conservative illustrated discharge from 3.6 V to below 0.84 V takes about 113 ms with the upper RC and leakage screen; a shorter event does not guarantee the input was cleared. Adding a discharge diode or active clamp would require separate discharge-current, leakage and part-count review.

Ioff specifies the power-off condition, not every point of an arbitrary analog ramp. U7/U8 share the existing 3V3 supply; at valid logic power their default inputs/pulldowns inhibit reset. The proposal does not claim immunity to every ramp glitch, rail dip, residual-charge replug or local-return transient. Verify actual differential 3V3/CHIP_EN against the 3.0-3.6 V rail and 50 µs reset/stabilization requirements. Check U6's ≤25 ms ramp constraint as well.

## Service, future battery and acceptance

CPU80 firmware keeps NFC VEN low before qualification, radios off in service, native USB enabled, and all three LED functions. The normal gate deliberately prevents automatic default-current service boot. SERVICE preserves the attempt to reach ROM/SDK/application service; it does **not** prove USB100 startup, enumeration, erase/write, or sustained programming current. Firmware qualification after boot still matters for NFC/radio behavior, but cannot qualify execution that precedes it.

The charging IC, BAT path, NTC/ISET and USB current gate remain available for a future battery revision. Normal USB-only permission will inhibit battery-only boot when USB is absent. That future revision needs a validated battery-derived processor permit and battery firmware profile; it must keep BQ current-mode selection dependent on CC advertisement. A service jumper is not battery capacity, charge, or thermal qualification.

Before release, capture VBUS, BQ IN/OUT, 3V3, OUT1, USB_HIGH_CURRENT, POWER_PERMIT, reset RC, CHIP_EN and VEN through cold attach, short/long replug, reset/brownout/watchdog, both orientations, default and higher advertisements, SERVICE recovery, blank-chip USB download and flash erase/write. Confirm causal sequencing, supply stabilization, absence of unintended NFC/radio activity, sustained programming and no false BQ high-current selection. Until then, preserve manufacturing HOLD and describe the gate as a reviewed candidate, not a complete startup pass.
