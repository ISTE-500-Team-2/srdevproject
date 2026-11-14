#!/usr/bin/env python3
"""Record/reproduce the separate factory image, without touching a device or product.

Default: collect the existing positive build plus independent verification evidence.
Use --compile only when rebuilding; ArduinoCLI/toolchain paths are isolated temporary setup.
No upload/flash command is run.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
SKETCH = ROOT / "factory_test_pn7160_v03"
OUTPUT = ROOT / "factory-build"
BUILD = Path("/private/tmp/fieldnote-arduino/pn7160-factory-build")
CONFIG = "/private/tmp/fieldnote-arduino/arduino-cli.yaml"
ESPTOOL = "/private/tmp/fieldnote-arduino/data/packages/esp32/tools/esptool_py/5.3.1/esptool"
FQBN = "esp32:esp32:esp32c3:CDCOnBoot=cdc"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, log_name, expected=0):
    result = subprocess.run(command, capture_output=True, text=True)
    (OUTPUT / log_name).write_text(result.stdout + result.stderr)
    assert result.returncode == expected, (command, result.returncode, result.stdout, result.stderr)
    return result.stdout + result.stderr


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compile", action="store_true")
    args = parser.parse_args()
    OUTPUT.mkdir(exist_ok=True)
    command = ["arduino-cli", "--config-file", CONFIG, "compile", "--fqbn", FQBN,
               "--build-path", str(BUILD), "--export-binaries", str(SKETCH)]
    if args.compile:
        run(command, "compile.log")
    log = (OUTPUT / "compile.log").read_text()
    program = int(re.search(r"Sketch uses (\d+) bytes", log)[1])
    ram = int(re.search(r"Global variables use (\d+) bytes", log)[1])
    exported = SKETCH / "build/esp32.esp32.esp32c3"
    for source in exported.iterdir():
        if source.is_file(): shutil.copyfile(source, OUTPUT / source.name)
    compiled = BUILD / "sketch/factory_test_pn7160_v03.ino.cpp"
    compiled_text = compiled.read_text()
    assert 'server.on("/api/load", HTTP_GET' in compiled_text and "body.reserve(4096)" in compiled_text
    assert "loadGeneration" in compiled_text and "mode == All" in compiled_text
    shutil.copyfile(compiled, OUTPUT / "compiled-sketch.cpp")
    sdk = (OUTPUT / "sdkconfig").read_text()
    assert "CONFIG_ESP32C3_REV_MIN_FULL=3" in sdk and "CONFIG_ESP32C3_REV_MAX_FULL=199" in sdk
    assert "# CONFIG_SPI_FLASH_ROM_IMPL is not set" in sdk
    flash = (OUTPUT / "flash_args").read_text()
    assert "0x0 factory_test_pn7160_v03.ino.bootloader.bin" in flash
    assert "0x8000 factory_test_pn7160_v03.ino.partitions.bin" in flash
    assert "0xe000 boot_app0.bin" in flash and "0x10000 factory_test_pn7160_v03.ino.bin" in flash
    app_info = run([ESPTOOL, "image-info", str(OUTPUT / "factory_test_pn7160_v03.ino.bin")], "image-info-app.txt")
    boot_info = run([ESPTOOL, "image-info", str(OUTPUT / "factory_test_pn7160_v03.ino.bootloader.bin")], "image-info-bootloader.txt")
    for info in (app_info, boot_info):
        assert "Detected image type: ESP32-C3" in info and "Flash size: 4MB" in info
        assert "Flash mode: DIO" in info and "Flash freq: 80m" in info
        assert "valid)" in info and "ESP-IDF: v5.5.5" in info
    negative = command.copy()
    negative[negative.index(FQBN)] = "esp32:esp32:esp32c3:CDCOnBoot=default"
    negative[negative.index(str(BUILD))] = "/private/tmp/fieldnote-arduino/pn7160-factory-cdc-off"
    negative.remove("--export-binaries")
    rejected = run(negative, "cdc-off-rejection.log", expected=1)
    assert '#error "PN7160 IRQ uses GPIO20: native USB CDC is required; UART0 RX must not claim GPIO20"' in rejected
    run([sys.executable, str(SKETCH / "tools/verify_factory_sources.py")], "source-guards-test.log")
    browser = run(["node", str(SKETCH / "tools/test_factory_ui.cjs")], "factory-ui-test.log")
    assert "PASS 8 actual factory browser script cases" in browser
    independent = json.loads((ROOT / "tests/verification-results.json").read_text())
    reused = {}
    for name in ("pn7160_nci.h", "pn7160_arduino.h", "integrated_power.h"):
        assert (SKETCH / name).read_bytes() == (ROOT / "product_integrated_pn7160_v03" / name).read_bytes()
        reused[name] = sha(SKETCH / name)
    sources = {str(p.relative_to(ROOT)): sha(p) for p in sorted(SKETCH.rglob("*"))
               if p.is_file() and "__pycache__" not in p.parts}
    outputs = {str(p.relative_to(ROOT)): sha(p) for p in sorted(OUTPUT.iterdir()) if p.is_file()}
    files = {**sources, **outputs, "record-factory-build.py": sha(Path(__file__))}
    manifest = {
        "status": "COMPILED_AND_HOST_VERIFIED_NOT_FLASHED_OR_PHYSICALLY_QUALIFIED",
        "generated_utc": datetime.now(timezone.utc).isoformat(), "sketch": SKETCH.name,
        "profile": "fieldnote-pn7160-v0.3-factory-1", "board": FQBN,
        "build_command": shlex.join(command), "build_argv": command,
        "program_bytes": program, "ram_bytes": ram,
        "toolchain": {"ArduinoCLI": "1.5.1", "ESP32_Arduino": "3.3.12", "ESP_IDF": "5.5.5",
                      "ArduinoJson": "7.4.3", "esptool": "5.3.1",
                      "note": "Existing isolated temporary ArduinoCLI/native arm ctags workaround; no upload performed"},
        "module": {"MPN": "ESP32-C3-MINI-1-N4X", "selected_chip_revision": "v1.1",
                   "SDK_min_revision": "v0.3", "SDK_max_revision": "v1.99", "flash_MB": 4,
                   "flash_mode": "DIO", "flash_frequency_MHz": 80, "SPI_FLASH_ROM_IMPL": False},
        "reader": {"MPN": "PN7160A1HN/C100E", "model_id_hex": "61", "expected_firmware": "12.50.05",
                   "address_7bit_hex": "28", "SDA": 4, "SCL": 5, "IRQ": 20, "VEN": 7,
                   "service_VEN_LOW": True, "IRQ_active_HIGH": True, "CPU_MHz": 80,
                   "USB_LIMITED": 6, "qualification_ms": 100, "monitor_interval_ms": 10,
                   "LED_gpio": {"green": 1, "amber": 3, "red": 10}, "CDC_required": True,
                   "straps": "R27 fitted, R28 DNP; never both, hold VEN LOW during ROM UART recovery"},
        "header_reuse_sha256": reused,
        "verification": {"protocol_cases": 52, "qualifier_cases": 8, "browser_fixture_cases": 8,
                         "independent_product_report_sha256": sha(ROOT / "tests/verification-results.json"),
                         "native_profile": independent["native_pin_profile"],
                         "factory_source_guards": "PASS; structural review, not GPIO/FreeRTOS execution",
                         "CDC_off": "Expected rejection prevents GPIO20 UART contention",
                         "physical": "NOT_TESTED"},
        "diagnostics": {"NFC": "Read-only real-controller UID polling; no tag-memory writes",
                        "AP": "Fieldnote-Test-<six hex digits>; password fieldnote-test; 192.168.4.1",
                        "LED_modes": ["auto", "green", "amber", "red", "all", "off"],
                        "HTTP_load": "All-mode browser continuously fetches bounded4096-byte responses plus1Hzstatus",
                        "load_recovery": "Server requires qualified power+All mode beforebuild/beforesend; clientstops onHTTPerror/networkfailure/statusauto; explicituserAllselection requiredtorestart",
                        "load_counter": "Offered bytes; actual delivered throughput/maximum radio load requires physical measurement"},
        "flash_files": {"bootloader": {"offset": "0x0", "file": "factory-build/factory_test_pn7160_v03.ino.bootloader.bin"},
                        "partitions": {"offset": "0x8000", "file": "factory-build/factory_test_pn7160_v03.ino.partitions.bin"},
                        "OTA_boot": {"offset": "0xE000", "file": "factory-build/boot_app0.bin"},
                        "application": {"offset": "0x10000", "file": "factory-build/factory_test_pn7160_v03.ino.bin"},
                        "fresh_first_article_merged": {"offset": "0x0", "file": "factory-build/factory_test_pn7160_v03.ino.merged.bin",
                            "note": "Fresh-board only; use separate images when preserving NVS/credentials"}},
        "production_release": "HOLD pending final CAD and both-unit physical USB/power/RF/LED/WiFi/NFC/product qualification",
        "limitations": ["Host checks do not prove controller firmware compatibility or real IRQ/ACK/tag behavior",
                        "Nominal10ms supervision is not measured shutdown latency; transition brownout remains a bench gate",
                        "PMU inrush and live-WiFi reader retries require current/rail capture",
                        "No physical current/ripple/thermal/RF/optical outcomes; no device flashed"],
        "files": files,
    }
    (ROOT / "factory-build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("PASS factory image/evidence recorded: %d files, %d flash bytes, %d RAM bytes; physical HOLD" % (len(files), program, ram))


if __name__ == "__main__":
    main()
