#!/usr/bin/env python3
"""Record an isolated PN532 CPU80 factory build; no original writes or device access."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
VARIANT = ROOT.parent
BUILD = Path("/private/tmp/fieldnote-arduino/pn532-factory-build-cpu80")
OUT = ROOT / "factory-build"
FQBN = "esp32:esp32:esp32c3:CDCOnBoot=cdc,CPUFreq=80"
ESPTOOL = "/private/tmp/fieldnote-arduino/data/packages/esp32/tools/esptool_py/5.3.1/esptool"
OBJDUMP = "/private/tmp/fieldnote-arduino/data/packages/esp32/tools/esp-rv32/2601/bin/riscv32-esp-elf-objdump"


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
    for absolute, expected in baseline["frozen_inputs_sha256"].items():
        assert sha(Path(absolute)) == expected, "Frozen original changed: " + absolute
    for name, record in baseline["factory_copied_sources"].items():
        assert sha(ROOT / name) == record["sha256"] == sha(VARIANT / record["frozen_source"])
    for name, lib in baseline["libraries"].items():
        for relative, expected in lib["source_files_sha256"].items():
            assert sha(Path(lib["installed_root"]) / relative) == expected, "Dependency source changed"
    archive = Path(baseline["immutable_archive"]["path"])
    expanded = archive.with_suffix("")
    package = json.loads((expanded / "MANIFEST.json").read_text())
    assert len(package["files"]) == 377
    with zipfile.ZipFile(archive) as bundle:
        for name, record in package["files"].items():
            assert sha(expanded / name) == record["sha256"]
            assert hashlib.sha256(bundle.read(expanded.name + "/" + name)).hexdigest() == record["sha256"]
    names = ["sdkconfig", "build.options.json", "partitions.csv", "flash_args", "boot_app0.bin"]
    names += ["factory_test.ino." + suffix for suffix in ("bin", "bootloader.bin", "partitions.bin", "merged.bin", "elf", "map")]
    for name in names: shutil.copyfile(BUILD / name, OUT / name)
    shutil.copyfile(BUILD / "sketch/factory_test.ino.cpp", OUT / "compiled-sketch.cpp")
    options = json.loads((OUT / "build.options.json").read_text())
    assert options["fqbn"] == FQBN
    commands = json.loads((BUILD / "compile_commands.json").read_text())
    chosen = [row for row in commands if row["file"].endswith("/cores/esp32/main.cpp") or
              row["file"].endswith("/sketch/factory_test.ino.cpp") or
              any(row["file"].startswith(lib["installed_root"] + "/") for lib in baseline["libraries"].values())]
    assert any(row["file"].endswith("/cores/esp32/main.cpp") for row in chosen)
    assert any(row["file"].endswith("/sketch/factory_test.ino.cpp") for row in chosen)
    assert all("-DF_CPU=80000000L" in row["arguments"] for row in chosen)
    for lib in baseline["libraries"].values():
        assert any(row["file"].startswith(lib["installed_root"] + "/") for row in chosen)
    (OUT / "main-library-compile-commands.json").write_text(json.dumps(chosen, indent=2) + "\n")
    sdk = (OUT / "sdkconfig").read_text()
    assert "CONFIG_ESP32C3_REV_MIN_FULL=3" in sdk and "CONFIG_ESP32C3_REV_MAX_FULL=199" in sdk
    assert "# CONFIG_SPI_FLASH_ROM_IMPL is not set" in sdk
    disassembly = tool([OBJDUMP, "-d", "--disassemble=app_main", str(OUT / "factory_test.ino.elf")], "app-main-disassembly.txt")
    assert re.search(r"\bli\s+a0,80\b", disassembly)
    assert disassembly.index("<setCpuFrequencyMhz>") < disassembly.index("<initArduino>")
    for suffix, name in (("bin", "image-info-app.txt"), ("bootloader.bin", "image-info-bootloader.txt")):
        info = tool([ESPTOOL, "image-info", str(OUT / ("factory_test.ino." + suffix))], name)
        assert "ESP32-C3" in info and "Flash size: 4MB" in info and "Flash mode: DIO" in info
        assert "Flash freq: 80m" in info and "ESP-IDF: v5.5.5" in info and "(valid)" in info
    old_manifest_path = VARIANT / "firmware/build-manifest.json"
    old = json.loads(old_manifest_path.read_text())
    boot = sha(OUT / "factory_test.ino.bootloader.bin")
    assert boot == old["files"]["build/factory_test.ino.bootloader.bin"]
    log = (OUT / "compile.log").read_text()
    program = int(re.search(r"Sketch uses (\d+) bytes", log)[1])
    ram = int(re.search(r"Global variables use (\d+) bytes", log)[1])
    files = {"factory_test/factory_test.ino": sha(ROOT / "factory_test/factory_test.ino")}
    files.update({str(p.relative_to(ROOT)): sha(p) for p in sorted(OUT.iterdir()) if p.is_file()})
    for p in (Path(__file__), baseline_path, ROOT / "factory-cpu80-selection.md"):
        files[str(p.relative_to(ROOT))] = sha(p)
    result = {"status": "PN532_CPU80_FACTORY_COMPILED_SOURCE_IDENTICAL_PHYSICAL_NOT_TESTED",
              "generated_utc": datetime.now(timezone.utc).isoformat(), "board": FQBN,
              "build_argv": ["arduino-cli", "--config-file", "/private/tmp/fieldnote-arduino/arduino-cli.yaml",
                     "compile", "--fqbn", FQBN, "--build-path", str(BUILD), str(ROOT / "factory_test")],
              "program_bytes": program, "ram_bytes": ram,
              "toolchain": {"ESP32_Arduino": "3.3.12", "ESP_IDF": "5.5.5", "Adafruit_PN532": "1.3.4", "Adafruit_BusIO": "1.17.4", "esptool": "5.3.1"},
              "source_correspondence": baseline["factory_copied_sources"],
              "dependency_sources": baseline["libraries"],
              "startup": {"actual_compile_F_CPU": "80000000L", "app_main": "80MHz before initArduino", "pre_app_main_SDK_CPU_MHz": 160,
                           "bootloader_unchanged_sha256": boot, "ROM_POR_and_early_SDK_current": "UNPROVED; no whole-boot USB100 guarantee"},
              "module_compatibility": {"MPN": "ESP32-C3-MINI-1-N4X", "revision": "v1.1", "SDK_revision_range": "v0.3..v1.99", "flash_MB": 4, "flash_mode": "DIO", "flash_frequency_MHz": 80, "SPI_FLASH_ROM_IMPL": False},
              "factory_profile": {"reader": "PN532", "address_hex": "24", "I2C_GPIO": [4,5], "USB_LIMITED_GPIO": 6,
                       "PN532_reset_N_GPIO": 7, "LED_GPIO": [1,3,10], "native_USB_GPIO": [18,19],
                       "RF_configuration": "Unchanged SAM/normalmode/passiveactivationretry01 + checked response drain",
                       "supervision": "Original loop-based startup/poll remains; no new shutdown latency claim"},
              "accepted_frozen_factory_manifest_sha256": sha(old_manifest_path),
              "accepted_frozen_product_manifest_sha256": sha(VARIANT / "firmware/product-build-manifest.json"),
              "immutable_80body_r2": {**baseline["immutable_archive"], "manifest_members_checked_in_archive_and_expanded": 377},
              "frozen_member_check": {"original_firmware_members": 51, "snapshot_paths": len(baseline["frozen_inputs_sha256"]), "status": "PASS_UNCHANGED"},
              "QA": {"source_changed": False, "identical_source_UI_suites_rerun": False, "new_evidence": "CPU80 compile/config/ELF/disassembly/image validation only", "physical": "NOT_TESTED"},
              "flash_files": {"bootloader": {"offset": "0x0", "file": "factory-build/factory_test.ino.bootloader.bin"},
                     "partitions": {"offset": "0x8000", "file": "factory-build/factory_test.ino.partitions.bin"},
                     "OTA_boot": {"offset": "0xE000", "file": "factory-build/boot_app0.bin"},
                     "application": {"offset": "0x10000", "file": "factory-build/factory_test.ino.bin"},
                     "fresh_merged": {"offset": "0x0", "file": "factory-build/factory_test.ino.merged.bin", "note": "Fresh-board only; preserve NVS with separate images"}},
              "package_reference_replaced": False, "device_flashed": False, "production_release": "HOLD", "files": files}
    (ROOT / "factory-build-manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    print("PASS PN532 factory80: %d manifest members;51 original firmware members and377 archive members unchanged" % len(files))


if __name__ == "__main__": main()
