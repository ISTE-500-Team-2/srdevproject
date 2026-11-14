#!/usr/bin/env python3
"""Bind the selected, immutable factory CPU80 image to the adopted native v3.

Read-only inputs; writes only the three named factory binding reports. No build,
test-suite rerun, CAD save, firmware export, device access or package selection.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import re
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "manufacturing"
NATIVE = ROOT / "output/native-review-candidate-v3"
FACTORY = ROOT / "firmware-cpu80/factory_test_pn7160_v03"
BUILD = ROOT / "firmware-cpu80/factory-build"
EXPECTED = {
    "output/native-review-candidate-v3/fieldnote.kicad_pcb": "16c767ce38c3ed0bdd8345fea9010f13027d1d3d23fdc06d10d02107cebbdd65",
    "output/native-review-candidate-v3/design-data.json": "e5db89f4158c074e48b2796a4e05f75d80875480a6e508622d0e021d18e1c3fa",
    "output/native-review-candidate-v3/source-revision.json": "e528fe2aead5f9c4e568776784aa9587bb57abd376cb455a96fea70c6a9781e8",
    "output/firmware-cpu80-root-review-v1/review.json": "a071072c5b337911df33bb324c40d72c658076c6379ff3d3143aa2dad8e4c861",
    "firmware-cpu80/factory-build-manifest.json": "d38b4c49659f64060358aa50b278c03cac62fb6944f4d85122fbc809817b17c6",
    "firmware-cpu80/product-build-manifest.json": "11ab14655c02d1e13eb1ed187f0296933a0a5b2fbc9350e4128e81dd7e4c8546",
    "firmware/factory-build-manifest.json": "ccc5b3f96e33090a94a3b3e5b6fd5c7207840f847eb223fc3ebd3f3fbae9a5ac",
    "firmware/product-build-manifest.json": "807e8122f635ace892323d118a8400f61b9bb5cec75751ed71ce3a501f1b40fa",
    "firmware/tests/verification-results.json": "bc2fa4bec474acfcc3c59bef7bfc6aa09583c91ae4fe78f6fe1d66d46ab1a083",
    "manufacturing/factory-test-PN7160.md": "9d6466662419c505ef9a42668b6ddbe69166c51823a10bf8febaa44e3f9c96f6",
}
snapshots = {}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    path = path.resolve()
    data = path.read_bytes()
    if path in snapshots:
        assert snapshots[path] == data, "Input changed during binding: " + str(path)
    snapshots[path] = data
    return data


def load(path):
    return json.loads(read(path))


def check(condition, reason):
    if not condition:
        raise AssertionError(reason)


def manifest(path):
    data = load(path)
    entries = data["files"]
    if isinstance(entries, dict):
        entries = [{"path": p, "sha256": h if isinstance(h, str) else h["sha256"]}
                   for p, h in entries.items()]
    for record in entries:
        check(sha(read(path.parent / record["path"])) == record["sha256"],
              "Manifest member changed: " + record["path"])
    return data, {"sha256": sha(read(path)), "members_verified": len(entries),
                  "all_hashes_match": True}


read(Path(__file__))
for relative, digest in EXPECTED.items():
    check(sha(read(ROOT / relative)) == digest, "Selected artifact changed: " + relative)

manifests = {}
for relative in ("output/native-review-candidate-v3/native-freeze-manifest.json",
                 "firmware-cpu80/factory-build-manifest.json",
                 "firmware-cpu80/product-build-manifest.json",
                 "firmware/factory-build-manifest.json", "firmware/product-build-manifest.json"):
    data, evidence = manifest(ROOT / relative)
    manifests[relative] = evidence
    if relative == "firmware-cpu80/factory-build-manifest.json":
        factory_manifest = data
fqbn = "esp32:esp32:esp32c3:CDCOnBoot=cdc,CPUFreq=80"
check(factory_manifest["board"] == fqbn and load(BUILD / "build.options.json")["fqbn"] == fqbn,
      "Factory build must select CPU80 and native USB CDC")
selection = load(ROOT / "output/firmware-cpu80-root-review-v1/review.json")
for role in ("factory", "product"):
    record = selection["selected_candidate_pair"][role]
    check(record["candidate_manifest_sha256"] == EXPECTED[record["candidate_manifest"]],
          "Root selection differs from frozen candidate")

# Rerun the existing full native board/netlist/metadata auditor on the final
# snapshot, saving new evidence rather than changing its frozen pin-parity file.
audit_path = ROOT / "manufacturing/audit_native_pins.py"
read(audit_path)
pin_report = OUT / "final-factory-native-pin-parity-v3.json"
argv = [sys.executable, str(audit_path), "--board", str(NATIVE / "fieldnote.kicad_pcb"),
        "--netlist", str(NATIVE / "fieldnote.net"), "--metadata", str(NATIVE / "design-data.json"),
        "--require-board-sha256", EXPECTED["output/native-review-candidate-v3/fieldnote.kicad_pcb"],
        "--out", str(pin_report)]
run = subprocess.run(argv, capture_output=True, text=True)
check(run.returncode == 0, "Native pin audit failed:\n" + run.stdout + run.stderr)
parity = load(pin_report)
check(not parity["errors"], "Final native pin parity failure")
spec = importlib.util.spec_from_file_location("factory_native_pin_parser", audit_path)
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)
board = parser.sexpr(read(NATIVE / "fieldnote.kicad_pcb").decode())
parts = {p["ref"]: p for p in load(NATIVE / "design-data.json")["parts"]}
fps = {}
for fp in parser.children(board, "footprint"):
    props = {n[1]: n[2] for n in parser.children(fp, "property")}
    fps[props["Reference"]] = fp

gpio_map = {
    1: ("13", "LED_GREEN"), 3: ("6", "LED_AMBER"), 4: ("18", "NFC_SDA"),
    5: ("19", "NFC_SCL"), 6: ("20", "USB_LIMITED"), 7: ("21", "NFC_VEN"),
    10: ("16", "LED_RED"), 18: ("26", "MCU_USB_DM"), 19: ("27", "MCU_USB_DP"),
    20: ("30", "MCU_NFC_IRQ"), 21: ("31", "UART_TX"),
}
for gpio, (pad, net) in gpio_map.items():
    check(parts["U1"]["nets"][pad] == net, "Wrong MCU pad: GPIO" + str(gpio))
for ref, fitted, mpn in (("R19", True, "RC0603FR-07100KL"),
                         ("R27", True, "RC0603JR-070RL"),
                         ("R28", False, "RC0603JR-070RL")):
    check(parts[ref]["dnp"] != fitted and parts[ref]["mpn"] == mpn,
          "Wrong fitted/DNP/MPN service state: " + ref)
    check(("dnp" not in parser.child(fps[ref], "attr", ["attr"])[1:]) == fitted,
          "Native service link attribute differs: " + ref)
for ref, expected in {
    "R19": {"1": "NFC_VEN", "2": "GND"},
    "R27": {"1": "NFC_IRQ", "2": "MCU_NFC_IRQ"},
    "R28": {"1": "UART_RX", "2": "MCU_NFC_IRQ"},
}.items():
    check(parts[ref]["nets"] == expected, "Service path differs: " + ref)
check(parts["J4"]["nets"]["3"] == "UART_TX" and parts["J4"]["nets"]["4"] == "UART_RX",
      "Recovery connector signal assignment differs")
check(parts["R19"]["value"] == "100k 1%", "VEN pulldown value differs")
check(parts["U2"]["mpn"] == "PN7160A1HN/C100E" and
      parts["U1"]["mpn"] == "ESP32-C3-MINI-1-N4X", "Module/controller variant differs")
for ref in ("C28", "C29"):
    check(parts[ref]["value"] == "300pF C0G 50V 2%" and
          parts[ref]["mpn"] == "CC0603GRNPO9BN301", "Final fitted RF seed differs")
# GPIO HIGH drives each LED through its fitted resistor to anode; cathode=GND.
for ref, resistor, signal in (("D1", "R16", "LED_GREEN"),
                               ("D2", "R17", "LED_AMBER"), ("D3", "R18", "LED_RED")):
    anode = ref + "_ANODE"
    check(parts[ref]["nets"] == {"1": "GND", "2": anode} and
          parts[resistor]["nets"] == {"1": signal, "2": anode} and
          not parts[ref]["dnp"] and not parts[resistor]["dnp"], "LED polarity/path differs: " + ref)

profile = load(NATIVE / "design-data.json")["nfc_profile"]
check(all(profile[k] == v for k, v in {"i2c_address_7bit": 0x28, "sda_gpio": 4,
      "scl_gpio": 5, "ven_gpio": 7, "irq_gpio": 20, "irq_active_high": True,
      "qualified_usb_txldo_v": 3.3}.items()), "Native NFC profile differs")
for rel, record in factory_manifest["source_correspondence"].items():
    check(read(ROOT / "firmware-cpu80" / rel) == read(ROOT / record["frozen_source"]),
          "Factory copied source differs: " + rel)
for name in ("integrated_power.h", "pn7160_arduino.h", "pn7160_nci.h"):
    source = read(FACTORY / name)
    check(source == read(ROOT / "firmware-cpu80/product_integrated_pn7160_v03" / name),
          "Selected factory/product header mismatch: " + name)
    compiled = read(BUILD / ("compiled-" + name))
    prefix = ('#line 1 "' + str(FACTORY / name) + '"\n').encode()
    check(compiled == prefix + source, "Actual compiled header differs: " + name)
    check(sha(source) == load(ROOT / "firmware/tests/verification-results.json")["inputs_sha256"]
          ["firmware/product_integrated_pn7160_v03/" + name], "Host-tested header differs")

source = read(FACTORY / "factory_test_pn7160_v03.ino").decode()
compiled = read(BUILD / "compiled-sketch.cpp").decode()
power = read(FACTORY / "integrated_power.h").decode()
wire = read(FACTORY / "pn7160_arduino.h").decode()
core = read(FACTORY / "pn7160_nci.h").decode()
# Use the already frozen lexical helper, without invoking its fixture suite.
helper = ROOT / "firmware/tests/run_product_contract_tests.py"
scope = {"__file__": str(helper), "__name__": "factory_binding_lexical_helper"}
exec(compile(read(helper).decode().split("\nsource = SKETCH.read_text()", 1)[0], str(helper), "exec"), scope)
function = scope["function"]
functions = {name: function(source, name) for name in
             ("setup", "monitorPower", "enterService", "initializeReader", "loop", "allowsNfc", "fullPower", "applyLeds", "pollTags")}
for name, text in functions.items():
    check(text == function(compiled, name), "Compiled function differs: " + name)
low, high = "digitalWrite(integrated::kPnResetPin, LOW)", "digitalWrite(integrated::kPnResetPin, HIGH)"
check(functions["setup"].index(low) < functions["setup"].index("pinMode(integrated::kPnResetPin, OUTPUT)"),
      "Cold startup VEN LOW must precede output enable")
check(low in functions["monitorPower"] and "esp_wifi_stop()" in functions["monitorPower"] and
      "Semaphore" not in functions["monitorPower"], "Power downgrade must not wait on reader lock")
check(low in functions["enterService"] and "reader.invalidate()" in functions["enterService"] and
      "ledMode = Auto" in functions["enterService"] and "attemptedReaderBoot = false" in functions["enterService"],
      "Service/recovery state differs")
init = functions["initializeReader"]
check(init.index(low) < init.index("waitQualified(10)") < init.index(high) <
      init.index("waitQualified(1000)") < init.index("reader.begin"), "VEN qualification/init order differs")
check(functions["loop"].index("initializeReader()") < functions["loop"].index("startAp()"),
      "Initial controller boot must precede Wi-Fi")
check("fullPower() && digitalRead(integrated::kPnResetPin) == HIGH" in functions["allowsNfc"] and
      "qualified && digitalRead(integrated::kUsbLimitedPin) == LOW" in functions["fullPower"],
      "Active-HIGH VEN/qualified USB transport gate differs")
for token in ("kUsbLimitedPin = 6", "kPnResetPin = 7", "kGreenPin = 1", "kAmberPin = 3",
              "kRedPin = 10", "kQualificationMs = 100", "kMonitorIntervalMs = 10"):
    check(token in power, "Power/LED constant differs: " + token)
for token in ("kAddress = 0x28", "kIrqPin = 20", "kVenPin = 7", "kIrqActiveHigh = true",
              "bool powered() override { return allowsNfc_(); }"):
    check(token in wire, "Transport constant/gate differs: " + token)
check("constexpr uint8_t kSda = 4, kScl = 5" in source and
      "!ARDUINO_USB_CDC_ON_BOOT" in source and "UART0 RX must not claim GPIO20" in source and
      not re.search(r"\b(?:Serial0|Serial1|HardwareSerial)\b", source), "I2C/CDC/UART isolation differs")
check(all(token in core for token in ("clock = (clock & ~0x10u) | 0x08", "pmu[2] = (pmu[2] & ~0xF3u) | 0x02",
      "pmu[7] = (pmu[7] & 0x0F) | 0x10", "pmu[9] &= ~0xC0u", "dpc[0] &= 0x1F",
      "(verifiedClock & 0x18) != 0x08", "memcmp(pmu, verifiedPmu, sizeof(pmu))", "(verifiedDpc[0] & 0xE0)")),
      "CFG2/XTAL/DPC/readback profile differs")
check(all(token not in source for token in (".writeBlock(", ".writePage(", ".authenticate(", "Preferences")),
      "Factory must remain read-only")
drc, refill, erc = load(NATIVE / "drc-stored-fill.json"), load(NATIVE / "drc-refill.json"), load(NATIVE / "erc.json")
check(all(not result["violations"] and not result["unconnected_items"] and not result["schematic_parity"]
          for result in (drc, refill)) and
      all(not sheet["violations"] for sheet in erc["sheets"]), "Final stored native ERC/DRC findings")
for path, data in snapshots.items():
    check(path.read_bytes() == data, "Input changed during binding: " + str(path))

report = {
    "status": "PASS_FACTORY_FINAL_NATIVE_PROFILE_BINDING_PHYSICAL_HOLD",
    "scope": "Read-only identity, native pad/net/MPN/DNP, compiled factory source and profile review; no new hardware outcome",
    "bound_inputs": {str(p.relative_to(ROOT)): {"sha256": sha(data), "bytes": len(data)}
                     for p, data in sorted(snapshots.items())},
    "manifest_checks": manifests,
    "selected_factory": {"manifest": "firmware-cpu80/factory-build-manifest.json", "fqbn": fqbn,
                         "application_sha256": selection["selected_candidate_pair"]["factory"]["application_sha256"],
                         "program_bytes": factory_manifest["program_bytes"], "ram_bytes": factory_manifest["ram_bytes"]},
    "native_pin_parity": {"path": str(pin_report.relative_to(ROOT)), "sha256": sha(read(pin_report)),
                          "footprints": parity["footprints_checked"], "physical_numbered_pads": parity["numbered_physical_pads_checked"]},
    "gpio_to_pad_net": {str(g): {"pad": "U1." + p, "net": n} for g, (p, n) in gpio_map.items()},
    "reviewed_factory_behavior": ["Cold setup drives active-HIGH VEN LOW before output enable",
        "100 ms continuous qualified CC permits VEN; input HIGH cancels immediately on observation",
        "Independent priority-3 supervisor samples nominally every 10 ms, drives VEN LOW and stops Wi-Fi without reader locks",
        "Transport permits traffic only while qualified CC remains LOW and VEN is HIGH",
        "Service invalidates reader, resets Auto LED/load mode and initial-boot flag; recovery requalifies",
        "Initial NCI initialization precedes AP; later retry with live Wi-Fi remains a physical power test",
        "All three fitted active-HIGH LEDs match native paths; independent and All controls remain behind fullPower",
        "GPIO20 IRQ uses fitted R27; USB CDC guard prevents UART RX ownership; GPIO18/19 native USB preserved",
        "Factory polls UID/protocol read-only; product API/CRC/rollback acceptance uses the selected matched product image"],
    "normal_assembly": "R27 fitted 0 ohm, R28 DNP, R19 fitted 100k VEN pulldown; J4 DNP header",
    "uart_recovery": "Remove R27, fit R28, hold VEN LOW before ROM UART recovery; never fit both; restore normal links before factory operation",
    "final_rf_seed": {"C28_C29": "300pF C0G 50V 2% CC0603GRNPO9BN301", "status": "ADOPTED FIRST-ARTICLE SEED, PHYSICAL TUNING REQUIRED"},
    "stored_native_checks": {"ERC": 0, "DRC_stored_fill": 0, "DRC_refill": 0, "unconnected": 0, "schematic_parity": 0,
                             "note": "Existing frozen native results; enabled/ignored checks retained in their bound JSON"},
    "QA_reuse": "Frozen 52 protocol, 8 power qualification, 13 contract fixtures and 8 embedded UI groups retained by exact source/header and manifest identity; no repeated identical-source suites",
    "limitations": ["Native connectivity and code review do not execute GPIO/FreeRTOS/Wi-Fi/NCI/tag hardware",
        "10 ms sampling is nominal source behavior, not a measured VEN/radio shutdown deadline",
        "R19 supports LOW while GPIO7 is high impedance; ROM/JTAG/erased-flash VEN waveform remains unmeasured",
        "Arduino app_main CPU80 precedes initArduino, but precompiled SDK early startup remains CPU160; ROM/POR current and whole-boot USB100 remain unproved",
        "PMU VDDUP checks are disabled by this profile; external measured local VDDUP >=3.6 V during VEN charge/TX remains mandatory",
        "300 pF is a route-aware seed, not a physical impedance/current/thermal PASS; use final-case RF and loaded rail/current tests",
        "Frozen physical procedure is unchanged; this separate binding supplies the adopted final circuit/image identity"],
    "new_compilation": False, "new_host_suite_runs": False, "device_flashed": False,
    "physical_tests": "NOT TESTED", "manufacturing_release": False, "production_release": "HOLD",
}
destination = OUT / "final-factory-native-binding-v3.json"
destination.write_text(json.dumps(report, indent=2) + "\n")
markdown = """# Final PN7160 factory/native binding — saved-zone v3

The selected CPU80 factory image matches the adopted `native-review-candidate-v3` circuit profile. This is a static binding PASS; physical tests remain **NOT TESTED / production HOLD**. See [the complete evidence](final-factory-native-binding-v3.json) and [the fresh native pin audit](final-factory-native-pin-parity-v3.json). Run `python3 manufacturing/revalidate_final_factory_native_v3.py` from this variant directory to reproduce the binding; it does not build, flash, save CAD or rerun the frozen host suites.

Bound identities are board **16c767ce38c3ed0bdd8345fea9010f13027d1d3d23fdc06d10d02107cebbdd65**, metadata **e5db89f4158c074e48b2796a4e05f75d80875480a6e508622d0e021d18e1c3fa**, source revision **e528fe2aead5f9c4e568776784aa9587bb57abd376cb455a96fea70c6a9781e8**, and root CPU80 pair selection **a071072c5b337911df33bb324c40d72c658076c6379ff3d3143aa2dad8e4c861**. The selected factory manifest is **d38b4c49659f64060358aa50b278c03cac62fb6944f4d85122fbc809817b17c6**; factory application is **32cf0038f4f66779682f0bac210c61eb1f33a6302f03656cd85211675baf7568**. Its matched product manifest is **11ab14655c02d1e13eb1ed187f0296933a0a5b2fbc9350e4128e81dd7e4c8546**. Exact members, compiled source/header correspondence and original firmware/procedure hashes were rechecked without changing those files.

| Function | GPIO / module pad | Final circuit |
|---|---|---|
| SDA / SCL | 4 / U1.18; 5 / U1.19 | U2.5 / U2.7, I2C address0x28 |
| Qualified-current input | 6 / U1.20 | USB_LIMITED, LOW only for full-power qualification |
| Reader enable | 7 / U1.21 | U2.10 active-HIGH VEN; R19 fitted100k to GND |
| Reader IRQ | 20 / U1.30 | U2.8 → fitted R27 0Ω → MCU_NFC_IRQ |
| Green / amber / red | 1 / U1.13; 3 / U1.6; 10 / U1.16 | Fitted resistor → LED anode; cathode GND; active HIGH |
| Native USB | 18 / U1.26; 19 / U1.27 | DM / DP retained; CDC-on build required |
| UART recovery | 21 / U1.31 TX; 20 / U1.30 RX | J4.3 / J4.4; RX via R28 DNP in normal assembly |

For UART ROM recovery, remove R27, fit R28 and hold VEN LOW before entering recovery. Never fit both links. Restore R27 fitted/R28 DNP before running factory or product firmware. The factory sketch uses USB CDC and does not claim the reader IRQ with UART0 RX.

Source and actual compiled functions preserve active-HIGH VEN LOW at setup/service, 100 ms CC qualification, independent priority-3 nominal10 ms downgrade sampling, transport cancellation when CC/VEN permission is lost, and requalification before recovery. Initial NCI initialization precedes Wi-Fi; the later Wi-Fi-on retry remains a required physical charging/load test. GPIO7 ROM/JTAG/erased-flash behavior and actual shutdown latency remain unmeasured. CPU80 starts at Arduino app_main before initArduino; earlier precompiled SDK startup remains160 MHz, so complete boot current is unproved.

The adopted final C28/C29 values are **300pF C0G50V2%, CC0603GRNPO9BN301**. This replaces the earlier seed identity in the unchanged historical procedure; all physical acceptance gates remain required. CFG2 internal TXLDO3.3 V, clock A003 bit3 set/bit4 clear, PMU readback and DPC A00B byte0&E0==0 are unchanged in the frozen headers. PMU voltage checks are disabled, so measured local VDDUP≥3.6 V during VEN charging and TX is mandatory. A route-aware seed and a clean native audit do not establish RF current, receiver voltage, power margins or chip thermal compliance.

Use the unchanged [physical factory procedure](factory-test-PN7160.md) for individual LEDs, explicitly restarted All-mode HTTP+NFC activity after power recovery, both USB orientations, qualified/unqualified transitions, loaded rails/current, RF tuning and temperature. Record this final board hash, image hash and300pF fitted seed. Product API/Classic/Type2/CRC/rollback tests use the matched CPU80 product image. No fresh physical PASS, manufacture authorization or device flashing is implied by this report.
"""
(OUT / "final-factory-native-binding-v3.md").write_text(markdown)
print(json.dumps({"status": report["status"], "native_footprints": parity["footprints_checked"],
                  "native_pads": parity["numbered_physical_pads_checked"],
                  "manifest_member_counts": {p: e["members_verified"] for p, e in manifests.items()},
                  "report_sha256": sha(destination.read_bytes()),
                  "markdown_sha256": sha((OUT / "final-factory-native-binding-v3.md").read_bytes())}, indent=2))
