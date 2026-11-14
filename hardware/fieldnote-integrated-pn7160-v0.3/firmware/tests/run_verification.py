#!/usr/bin/env python3
"""Run independent host checks and retain immutable-input evidence, without CAD writes.

Only firmware/tests evidence files and temporary host binaries are written.
Native pad/net checks establish logical profile correspondence, not routing continuity.
"""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SKETCH = ROOT / "firmware/product_integrated_pn7160_v03"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def native_profile_check():
    # Read the shared parser, but do not execute its main or save a PCB.
    helper = ROOT / "manufacturing/audit_native_pins.py"
    spec = importlib.util.spec_from_file_location("fieldnote_readonly_pin_parser", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    board_bytes = (ROOT / "fieldnote.kicad_pcb").read_bytes()
    metadata_bytes = (ROOT / "design-data.json").read_bytes()
    board = module.sexpr(board_bytes.decode())
    parts = {p["ref"]: p for p in json.loads(metadata_bytes)["parts"]}
    footprints = {}
    for fp in module.children(board, "footprint"):
        props = {p[1]: p[2] for p in module.children(fp, "property")}
        footprints[props["Reference"]] = fp
    global_nets = {n[1]: n[2] for n in module.children(board, "net") if len(n) == 3}
    expected = {
        "U1": {"13": "LED_GREEN", "6": "LED_AMBER", "16": "LED_RED",
               "18": "NFC_SDA", "19": "NFC_SCL", "20": "USB_LIMITED",
               "21": "NFC_VEN", "30": "MCU_NFC_IRQ", "31": "UART_TX",
               "26": "MCU_USB_DM", "27": "MCU_USB_DP"},
        "U2": {"1": "GND", "3": "GND", "4": "GND", "5": "NFC_SDA",
               "6": "3V3", "7": "NFC_SCL", "8": "NFC_IRQ", "10": "NFC_VEN",
               "12": "NFC_VBAT", "13": "NFC_VBAT", "14": "PN_TX_LDO",
               "18": "PN_TX_LDO", "22": "PN_TX_LDO", "26": "PN_1V8",
               "27": "PN_1V8", "28": "NFC_VBAT", "31": "PN_1V8"},
        "R19": {"1": "NFC_VEN", "2": "GND"},
        "R27": {"1": "NFC_IRQ", "2": "MCU_NFC_IRQ"},
        "R28": {"1": "UART_RX", "2": "MCU_NFC_IRQ"},
        "J4": {"3": "UART_TX", "4": "UART_RX"},
    }
    for ref, pins in expected.items():
        pads = {p[1]: p for p in module.children(footprints[ref], "pad")}
        for number, required in pins.items():
            node = module.child(pads[number], "net")
            actual = node[-1] if len(node) == 3 else global_nets.get(node[1], node[1])
            assert actual == required == parts[ref]["nets"][number], (ref, number, actual, required)
    for ref, dnp in (("R19", False), ("R27", False), ("R28", True)):
        assert parts[ref]["dnp"] == dnp
        assert ("dnp" in module.child(footprints[ref], "attr", ["attr"])) == dnp
    assert parts["R19"]["value"].startswith("100k"), "VEN pulldown value changed"
    assert parts["U1"]["mpn"] == "ESP32-C3-MINI-1-N4X"
    assert parts["U2"]["mpn"] == "PN7160A1HN/C100E"
    return {"status": "PASS", "checked_pad_nets": sum(map(len, expected.values())),
            "board_sha256": sha(board_bytes), "metadata_sha256": sha(metadata_bytes),
            "scope": "Native pad nets, metadata and fitted/DNP service links only; no routed-continuity proof",
            "gpio_to_native_pad": {"1": "U1.13", "3": "U1.6", "4": "U1.18",
                "5": "U1.19", "6": "U1.20", "7": "U1.21", "10": "U1.16",
                "18": "U1.26", "19": "U1.27", "20": "U1.30", "21": "U1.31"}}


def supervisor_source_checks():
    source = (SKETCH / "product_integrated_pn7160_v03.ino").read_text()
    # Structural review assertions; these do not execute FreeRTOS, radio or GPIO.
    contracts = HERE / "run_product_contract_tests.py"
    spec = importlib.util.spec_from_file_location("fieldnote_function_parser", contracts)
    # Avoid executing that test module: use the already reviewed lexical helper only.
    helper_text = contracts.read_text().split("\nsource = SKETCH.read_text()", 1)[0]
    scope = {"__file__": str(contracts), "__name__": "fieldnote_lexical_helper"}
    exec(compile(helper_text, str(contracts), "exec"), scope)
    function = scope["function"]
    setup = function(source, "setup")
    monitor = function(source, "runPowerMonitorTask")
    initialize = function(source, "initializePn7160")
    service = function(source, "enterServiceMode")
    loop = function(source, "loop")
    allows = function(source, "hardwareAllowsNfc")
    polling = function(source, "runNfcPollTask")
    low = "digitalWrite(integrated::kPnResetPin, LOW)"
    high = "digitalWrite(integrated::kPnResetPin, HIGH)"
    assert setup.index(low) < setup.index("pinMode(integrated::kPnResetPin, OUTPUT)")
    assert "setCpuFrequencyMhz(80)" in setup and "WiFi.mode(WIFI_OFF)" in setup
    assert low in monitor and "esp_wifi_stop()" in monitor
    assert "kMonitorIntervalMs" in monitor and "pn7160Mutex" not in monitor
    assert low in service and "WiFi.mode(WIFI_OFF)" in service and "attemptedReaderBoot = false" in service
    assert "highCurrentPowerAvailable()" in allows and "kPnResetPin) == HIGH" in allows
    assert initialize.index(low) < initialize.index("waitWithQualifiedPower(10)") < initialize.index(high)
    assert initialize.index(high) < initialize.index("waitWithQualifiedPower(1000)") < initialize.index("pn7160.begin")
    assert "pn7160.model() != 0x61" in initialize and "pn7160.invalidate()" in initialize
    assert loop.index("initializePn7160()") < loop.index("connectToStoredWifi()")
    assert "networkStarted && pn7160Ready && hardwareAllowsNfc()" in polling
    assert "#if !defined(ARDUINO_USB_CDC_ON_BOOT) || !ARDUINO_USB_CDC_ON_BOOT" in source
    assert "UART0 RX must not claim GPIO20" in source
    return {"status": "PASS", "scope": "Source review: active-HIGH VEN cold start, qualification, mutex-independent downgrade, requalification, initial NCI before Wi-Fi, RF after enrollment, CDC-only GPIO20 isolation; runtime latency unmeasured"}


def main():
    paths = [SKETCH / n for n in ("product_integrated_pn7160_v03.ino", "pn7160_nci.h",
             "pn7160_arduino.h", "integrated_power.h", "tag_policy.h")]
    paths += [HERE / n for n in ("test_pn7160_protocol.cpp", "test_power_qualification.cpp",
              "run_product_contract_tests.py", "run_verification.py")]
    snapshots = {str(p.relative_to(ROOT)): p.read_bytes() for p in paths}
    runs = []
    with tempfile.TemporaryDirectory(prefix="fieldnote-pn7160-independent-") as temp:
        for source_name, expected in (("test_pn7160_protocol.cpp", "passed=52 failed=0"),
                                      ("test_power_qualification.cpp", "PASS 8 actual qualifier cases")):
            binary = Path(temp) / source_name.removesuffix(".cpp")
            command = ["c++", "-std=c++11", "-Wall", "-Wextra", "-Werror",
                       "-fsanitize=address,undefined", str(HERE / source_name), "-o", str(binary)]
            built = subprocess.run(command, capture_output=True, text=True)
            (HERE / (binary.name + "-build.log")).write_text(built.stdout + built.stderr)
            assert built.returncode == 0, built.stderr
            ran = subprocess.run([str(binary)], capture_output=True, text=True)
            log_name = binary.name + ".log"
            (HERE / log_name).write_text(ran.stdout + ran.stderr)
            assert ran.returncode == 0 and expected in ran.stdout, ran.stdout + ran.stderr
            runs.append({"test": source_name, "status": "PASS", "exit_code": ran.returncode,
                         "compiler_flags": command[1:6], "log": log_name,
                         "stdout_sha256": sha((ran.stdout + ran.stderr).encode())})
            print(ran.stdout.strip())
        codec = subprocess.run([sys.executable, str(HERE / "run_product_contract_tests.py")],
                               capture_output=True, text=True)
        (HERE / "product-contract-tests.log").write_text(codec.stdout + codec.stderr)
        assert codec.returncode == 0 and "PASS 13 actual codec/rollback fixture cases" in codec.stdout
        assert "PASS 11 codec/CRC/rollback functions" in codec.stdout
        runs.append({"test": "run_product_contract_tests.py", "status": "PASS", "exit_code": codec.returncode,
                     "log": "product-contract-tests.log", "stdout_sha256": sha((codec.stdout + codec.stderr).encode())})
        print(codec.stdout.strip())
    for p in paths:
        assert p.read_bytes() == snapshots[str(p.relative_to(ROOT))], "Test input changed during run: " + str(p)
    report = {"generated_utc": datetime.now(timezone.utc).isoformat(), "status": "PASS_HOST_CHECKS_ONLY",
              "inputs_sha256": {p: sha(data) for p, data in snapshots.items()}, "runs": runs,
              "native_pin_profile": native_profile_check(), "supervisor_source_review": supervisor_source_checks(),
              "physical_tests": "NOT_TESTED", "production_release": "HOLD",
              "limitations": ["Mocks exercise selected actual driver sequences; no PN7160 controller or physical tags",
                 "No real HTTP/Arduino/FreeRTOS execution, GPIO/radio shutdown latency or IRQ timing proof",
                 "No physical supply/current/ripple/thermal, RF tuning/range, EEPROM compatibility or tag rollback proof",
                 "NCI fragmented messages fail closed; reassembly is not implemented",
                 "Native pad/net snapshot is logical correspondence only; routing may subsequently change"]}
    (HERE / "verification-results.json").write_text(json.dumps(report, indent=2) + "\n")
    print("PASS native logical pin profile and supervisor source review; physical qualification HOLD")


if __name__ == "__main__":
    main()
