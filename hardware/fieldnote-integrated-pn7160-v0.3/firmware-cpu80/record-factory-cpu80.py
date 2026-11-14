#!/usr/bin/env python3
"""Collect a separate CPU80 factory compile without changing any frozen package.

No sketch export, duplicate host suite, upload or flashing is performed.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
VARIANT = ROOT.parent
OLD = VARIANT / "firmware"
SKETCH = ROOT / "factory_test_pn7160_v03"
OUT = ROOT / "factory-build"
BUILD = Path("/private/tmp/fieldnote-arduino/pn7160-factory-build-cpu80")
ESPTOOL = "/private/tmp/fieldnote-arduino/data/packages/esp32/tools/esptool_py/5.3.1/esptool"
OBJDUMP = "/private/tmp/fieldnote-arduino/data/packages/esp32/tools/esp-rv32/2601/bin/riscv32-esp-elf-objdump"
FQBN = "esp32:esp32:esp32c3:CDCOnBoot=cdc,CPUFreq=80"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tool(command, name):
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    (OUT / name).write_text(result.stdout + result.stderr)
    return result.stdout


def main():
    OUT.mkdir(exist_ok=True)
    baseline_path = ROOT / "factory-source-baseline.json"
    baseline = json.loads(baseline_path.read_text())
    procedure = VARIANT / "manufacturing/factory-test-PN7160.md"
    procedure_sha = "9d6466662419c505ef9a42668b6ddbe69166c51823a10bf8febaa44e3f9c96f6"
    assert sha(procedure) == procedure_sha, "Frozen physical procedure changed"
    for absolute, expected in baseline["frozen_inputs_sha256"].items():
        assert sha(Path(absolute)) == expected, "Frozen package changed: " + absolute
    for name, record in baseline["factory_copied_sources"].items():
        assert sha(ROOT / name) == record["sha256"] == sha(VARIANT / record["frozen_source"])
    names = ["sdkconfig", "build.options.json", "partitions.csv", "flash_args", "boot_app0.bin"]
    names += ["factory_test_pn7160_v03.ino." + suffix for suffix in
              ("bin", "bootloader.bin", "partitions.bin", "merged.bin", "elf", "map")]
    for name in names: shutil.copyfile(BUILD / name, OUT / name)
    shutil.copyfile(BUILD / "sketch/factory_test_pn7160_v03.ino.cpp", OUT / "compiled-sketch.cpp")
    headers = {}
    for name in ("pn7160_nci.h", "pn7160_arduino.h", "integrated_power.h"):
        compiled_header = BUILD / "sketch" / name
        prefix, content = compiled_header.read_bytes().split(b"\n", 1)
        assert prefix.decode() == '#line 1 "' + str((SKETCH / name).resolve()) + '"'
        assert content == (SKETCH / name).read_bytes()
        shutil.copyfile(compiled_header, OUT / ("compiled-" + name))
        headers[name] = {"source_sha256": sha(SKETCH / name),
                         "compiled_with_line_directive_sha256": sha(compiled_header),
                         "normalized_byte_identical": True,
                         "normalization": "Only ArduinoCLI's exact first-line source-path directive removed"}
    options = json.loads((OUT / "build.options.json").read_text())
    assert options["fqbn"] == FQBN
    commands = json.loads((BUILD / "compile_commands.json").read_text())
    main_commands = [row for row in commands if row["file"].endswith("/cores/esp32/main.cpp")]
    assert len(main_commands) == 1 and "-DF_CPU=80000000L" in main_commands[0]["arguments"]
    (OUT / "main-compile-command.json").write_text(json.dumps(main_commands[0], indent=2) + "\n")
    sdk = (OUT / "sdkconfig").read_text()
    assert "CONFIG_ESP32C3_REV_MIN_FULL=3" in sdk and "CONFIG_ESP32C3_REV_MAX_FULL=199" in sdk
    assert "# CONFIG_SPI_FLASH_ROM_IMPL is not set" in sdk
    elf = OUT / "factory_test_pn7160_v03.ino.elf"
    disassembly = tool([OBJDUMP, "-d", "--disassemble=app_main", str(elf)], "app-main-disassembly.txt")
    assert re.search(r"\bli\s+a0,80\b", disassembly)
    assert disassembly.index("<setCpuFrequencyMhz>") < disassembly.index("<initArduino>")
    for suffix, name in (("bin", "image-info-app.txt"), ("bootloader.bin", "image-info-bootloader.txt")):
        info = tool([ESPTOOL, "image-info", str(OUT / ("factory_test_pn7160_v03.ino." + suffix))], name)
        assert "ESP32-C3" in info and "Flash size: 4MB" in info and "Flash mode: DIO" in info
        assert "Flash freq: 80m" in info and "ESP-IDF: v5.5.5" in info and "(valid)" in info
    old_manifest_path = OLD / "factory-build-manifest.json"
    old_manifest = json.loads(old_manifest_path.read_text())
    bootloader_hash = sha(OUT / "factory_test_pn7160_v03.ino.bootloader.bin")
    assert bootloader_hash == old_manifest["files"]["factory-build/factory_test_pn7160_v03.ino.bootloader.bin"]
    log = (OUT / "compile.log").read_text()
    program = int(re.search(r"Sketch uses (\d+) bytes", log)[1])
    ram = int(re.search(r"Global variables use (\d+) bytes", log)[1])
    files = {str(p.relative_to(ROOT)): sha(p) for p in sorted(SKETCH.rglob("*")) if p.is_file()}
    files.update({str(p.relative_to(ROOT)): sha(p) for p in sorted(OUT.iterdir()) if p.is_file()})
    for p in (Path(__file__), baseline_path, ROOT / "factory-cpu80-selection.md"):
        files[str(p.relative_to(ROOT))] = sha(p)
    report = {"status": "CPU80_FACTORY_COMPILED_SOURCE_IDENTICAL_PHYSICAL_NOT_TESTED",
              "generated_utc": datetime.now(timezone.utc).isoformat(), "board": FQBN,
              "toolchain": {"ESP32_Arduino": "3.3.12", "ESP_IDF": "5.5.5", "ArduinoJson": "7.4.3", "esptool": "5.3.1"},
              "program_bytes": program, "ram_bytes": ram,
              "source_correspondence": baseline["factory_copied_sources"], "compiled_header_sha256": headers,
              "accepted_frozen_factory_manifest_sha256": sha(old_manifest_path),
              "accepted_frozen_product_manifest_sha256": sha(OLD / "product-build-manifest.json"),
              "accepted_physical_procedure_sha256": procedure_sha,
              "module_compatibility": {"MPN": "ESP32-C3-MINI-1-N4X", "selected_revision": "v1.1", "SDK_revision_range": "v0.3..v1.99",
                    "flash_MB": 4, "flash_mode": "DIO", "flash_frequency_MHz": 80, "SPI_FLASH_ROM_IMPL": False},
              "startup": {"compiled_main_F_CPU": "80000000L", "application_CPU_MHz": 80,
                    "app_main_disassembly": "li a0,80 then setCpuFrequencyMhz before initArduino",
                    "precompiled_IDF_startup_CPU_MHz": 160,
                    "bootloader_unchanged_sha256": bootloader_hash,
                    "ROM_POR_and_before_app_main_current": "UNPROVED; not a whole-boot USB100 guarantee"},
              "QA_reuse": {"source_changed": False, "host_suites_rerun": False,
                    "independent_report_sha256": sha(OLD / "tests/verification-results.json"),
                    "protocol_cases": 52, "qualifier_cases": 8, "codec_fixtures": 13, "factory_browser_fixtures": 8,
                    "reason": "Exact copied source/header hashes; frozen suites retained, not represented as new runs",
                    "native_pins": "Unchanged logical mapping; final native routing and physical behavior remain separate gates"},
              "flash_files": {"bootloader": {"offset": "0x0", "file": "factory-build/factory_test_pn7160_v03.ino.bootloader.bin"},
                    "partitions": {"offset": "0x8000", "file": "factory-build/factory_test_pn7160_v03.ino.partitions.bin"},
                    "OTA_boot": {"offset": "0xE000", "file": "factory-build/boot_app0.bin"},
                    "application": {"offset": "0x10000", "file": "factory-build/factory_test_pn7160_v03.ino.bin"},
                    "fresh_merged": {"offset": "0x0", "file": "factory-build/factory_test_pn7160_v03.ino.merged.bin", "note": "Fresh-board only; preserve existing NVS with separate images"}},
              "package_selection": "Candidate only; no frozen package reference replaced",
              "physical": "NOT_TESTED; no device flashed", "production_release": "HOLD",
              "files": files}
    (ROOT / "factory-build-manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print("PASS separate CPU80 factory: %d manifest members; frozen originals and procedure unchanged" % len(files))


if __name__ == "__main__": main()
