#!/usr/bin/env python3
"""Record source-identical PN532 CPU80 candidate; never modify frozen files."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
VARIANT = ROOT.parent
FROZEN = VARIANT / 'firmware'
SKETCH = ROOT / 'product_integrated_v02'
BUILD = ROOT / 'product-build'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


baseline = json.loads((ROOT / 'product-frozen-artifact-baseline.json').read_text())
frozen_records = {}
for name, expected in (
    ('product-build-manifest.json', 'f683feb752693a8a3ac03b43d773a113523ef90b78a7196d57dcaa128c63a30a'),
    ('build-manifest.json', '1ba1f7cf441a42f06d837848641f86e2663e89ed288ef283b68915e6293b260a'),
):
    manifest = FROZEN / name
    assert sha(manifest) == expected
    record = json.loads(manifest.read_text())
    for name_, digest in record['files'].items():
        assert sha(FROZEN / name_) == digest, name_
    frozen_records[name] = {'sha256': expected, 'members_verified': len(record['files'])}

package_name = 'output/Fieldnote-PCBWay-review-v0.2-c6c7ff17-80body-r2'
package = VARIANT / package_name
assert sha(package / 'MANIFEST.json') == '5b59b8cb24707a68c9d407f48867b94bed0f016a4c06c12124f2d01c6984903c'
package_manifest = json.loads((package / 'MANIFEST.json').read_text())
for relative, entry in package_manifest['files'].items():
    path = package / relative
    assert sha(path) == entry['sha256'] and path.stat().st_size == entry['bytes'], relative
for relative, entry in baseline.items():
    if 'sha256' in entry:
        assert sha(VARIANT / relative) == entry['sha256'], relative

correspondence = json.loads((ROOT / 'product-source-correspondence.json').read_text())
for relative, digest in correspondence['files'].items():
    assert sha(SKETCH / relative) == digest
    assert sha(VARIANT / correspondence['source_root'] / relative) == digest
assert len(correspondence['files']) == 9
upstream = json.loads((FROZEN / 'product-source-baseline.json').read_text())
for relative, digest in upstream['files'].items():
    assert sha(Path(upstream['source_directory']) / relative) == digest, relative

log = (BUILD / 'compile.log').read_text()
flash = int(re.search(r'Sketch uses (\d+) bytes', log).group(1))
ram = int(re.search(r'Global variables use (\d+) bytes', log).group(1))
assert 'Error during build' not in log
fqbn = 'esp32:esp32:esp32c3:CDCOnBoot=cdc,CPUFreq=80'
assert json.loads((BUILD / 'build.options.json').read_text())['fqbn'] == fqbn
commands = json.loads((BUILD / 'compile_commands.json').read_text())
for suffix in ('main.cpp', 'Adafruit_PN532.cpp', 'Adafruit_I2CDevice.cpp', 'product_integrated_v02.ino.cpp'):
    entries = [v for v in commands if v['file'].endswith('/' + suffix)]
    assert len(entries) == 1, suffix
    flags = entries[0]['arguments']
    assert '-DF_CPU=80000000L' in flags and '-DARDUINO_USB_CDC_ON_BOOT=1' in flags
    assert '-DARDUINO_USB_MODE=1' in flags
app_main = (BUILD / 'app-main-disassembly.txt').read_text()
idf_clock = (BUILD / 'idf-clock-disassembly.txt').read_text()
assert re.search(r'li\s+a0,80\b', app_main) and 'setCpuFrequencyMhz' in app_main
assert app_main.index('setCpuFrequencyMhz') < app_main.index('initArduino')
assert re.search(r'li\s+a0,160\b', idf_clock) and 'rtc_clk_cpu_freq_mhz_to_config' in idf_clock
sdk = (BUILD / 'sdkconfig').read_text()
assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=160' in sdk
assert sha(BUILD / 'sdkconfig') == sha(FROZEN / 'product_integrated_v02/build/esp32.esp32.esp32c3/sdkconfig')
for report in ('image-info-app.txt', 'image-info-bootloader.txt'):
    info = (BUILD / report).read_text()
    assert 'ESP32-C3' in info and '(valid)' in info and 'ESP-IDF: v5.5.5' in info
for image in BUILD.iterdir():
    if image.suffix in ('.bin', '.elf', '.map'):
        assert sha(image) == sha(SKETCH / 'build/esp32.esp32.esp32c3' / image.name)
boot = BUILD / 'product_integrated_v02.ino.bootloader.bin'
assert sha(boot) == sha(FROZEN / 'product-build' / boot.name)

dependencies = {}
libraries = Path('/private/tmp/fieldnote-arduino/user/libraries')
for folder, version in (('Adafruit_PN532', '1.3.4'), ('Adafruit_BusIO', '1.17.4'), ('ArduinoJson', '7.4.3')):
    location = libraries / folder
    assert ('version=' + version) in (location / 'library.properties').read_text()
    paths = [p for p in location.rglob('*') if p.is_file() and p.suffix in ('.cpp', '.c', '.h', '.hpp') and 'examples' not in p.parts]
    paths.append(location / 'library.properties')
    dependencies[folder] = {'version': version, 'source_root': str(location), 'files_sha256': {str(p.relative_to(location)): sha(p) for p in sorted(paths)}}
core = Path('/private/tmp/fieldnote-arduino/data/packages/esp32/hardware/esp32/3.3.12')
installed_sources = {str(core / relative): sha(core / relative) for relative in ('cores/esp32/main.cpp', 'cores/esp32/esp32-hal-cpu.c', 'boards.txt')}
startup_review = VARIANT.parent / 'fieldnote-integrated-pn7160-v0.3/manufacturing/usb100-startup-assumption-review.json'
record = {
    'status': 'SEPARATE_PN532_CPU80_BUILD_COMPILED_IDENTICAL_SOURCE_NOT_FLASHED_OR_PHYSICALLY_QUALIFIED',
    'generated_utc': datetime.now(timezone.utc).isoformat(),
    'board': fqbn,
    'sketch': SKETCH.name,
    'application_version_unchanged': '1.4.0',
    'board_profile_unchanged': 'fieldnote-integrated-v0.2',
    'build_command': 'arduino-cli --config-file /private/tmp/fieldnote-arduino/arduino-cli.yaml compile --fqbn ' + fqbn + ' --build-path /private/tmp/fieldnote-arduino/pn532-product-cpu80-build --export-binaries hardware/fieldnote-integrated-v0.2/firmware-cpu80/product_integrated_v02',
    'program_bytes': flash, 'ram_bytes': ram,
    'toolchain': {'ArduinoCLI': '1.5.1', 'ESP32_Arduino': '3.3.12', 'ESP_IDF': '5.5.5', 'esptool': '5.3.1', 'Adafruit_PN532': '1.3.4', 'Adafruit_BusIO': '1.17.4', 'ArduinoJson': '7.4.3'},
    'frozen_originals_verified_unchanged': frozen_records,
    'upstream_original_source_files_verified_unchanged': len(upstream['files']),
    'manufacturer_80body_r2_verified_unchanged': {'directory': package_name, 'manifest_sha256': sha(package / 'MANIFEST.json'), 'members_verified': len(package_manifest['files']), 'zip_sha256': baseline[package_name + '.zip']['sha256'], 'sidecars_match_recorded_baseline': True},
    'copied_source_sha256': correspondence['files'],
    'dependency_source_sha256': dependencies,
    'installed_arduino_sources_sha256': installed_sources,
    'clock_profile': {'F_CPU_MHz': 80, 'SDK_early_MHz': 160, 'runtime_setup_MHz': 80, 'CPU_PLL_MHz': 480, 'CPU80_PLL_divider': 6, 'APB_MHz': 80, 'reduction_hook': 'Beginning of Arduino app_main before initArduino/NVS/loopTask/setup; after IDF startup/global constructors', 'actual_ELF_evidence': ['product-build/app-main-disassembly.txt', 'product-build/idf-clock-disassembly.txt'], 'ROM_POR_reset_download_current': 'Not configured or bounded by F_CPU; NOT_TESTED'},
    'module': {'MPN': 'ESP32-C3-MINI-1-N4X', 'revision': 'v1.1', 'SDK_min': 'v0.3', 'SDK_max': 'v1.99', 'flash_MB': 4, 'flash_mode': 'DIO', 'flash_MHz': 80, 'SPI_FLASH_ROM_IMPL': False},
    'hardware_profile_unchanged': json.loads((FROZEN / 'product-build-manifest.json').read_text())['hardware_profile'],
    'product_behavior': 'Source-identical UI/API/provisioning/PN532 record formats/readback/rollback/power supervisor; normal runtime80MHz unchanged, earlier app_main frequency selection changed',
    'shared_host_evidence': {'reference': '../firmware/product-build-manifest.json', 'sha256': sha(FROZEN / 'product-build-manifest.json'), 'scope': 'Reuse original successful UI/embedding/qualifier and 11 codec source-identity records; no identical-source host suites repeated; no actual startup/radio/FreeRTOS/USB execution'},
    'startup_evidence': {'reference': '../../fieldnote-integrated-pn7160-v0.3/manufacturing/usb100-startup-assumption-review.json', 'sha256': sha(startup_review), 'scope': 'Shared installed ESP32-C3 CPU/PLL/startup sources and typical current-table limitations; PN7160-specific sequencing does not change this PN532 source'},
    'flash_files': {'bootloader': {'offset': '0x0', 'file': 'product-build/product_integrated_v02.ino.bootloader.bin', 'matches_frozen_bootloader': True}, 'partitions': {'offset': '0x8000', 'file': 'product-build/product_integrated_v02.ino.partitions.bin'}, 'OTA_boot': {'offset': '0xE000', 'file': 'product-build/boot_app0.bin'}, 'application': {'offset': '0x10000', 'file': 'product-build/product_integrated_v02.ino.bin'}, 'fresh_factory_merged': {'offset': '0x0', 'file': 'product-build/product_integrated_v02.ino.merged.bin'}},
    'package_references_changed': False,
    'limitations': ['Earlier Arduino clock reduction leaves the precompiled SDK 160 MHz interval and ROM/reset/download behavior unchanged.', 'Typical current tables and an imposed 86 mA 3V3 load do not guarantee complete USB100 boot/programming.', 'No device flashed; current/USB/NFC/radio/timing and full product qualification remain physical gates.'],
    'production_release': 'HOLD',
}
paths = [ROOT / name for name in ('product-cpu80-selection.md', 'product-source-correspondence.json', 'product-frozen-artifact-baseline.json', 'record-cpu80-product-build.py')]
paths += [p for folder in (SKETCH, BUILD) for p in folder.rglob('*') if p.is_file() and '__pycache__' not in p.parts]
record['files'] = {str(p.relative_to(ROOT)): sha(p) for p in sorted(set(paths))}
(ROOT / 'product-build-manifest.json').write_text(json.dumps(record, indent=2) + '\n')
print('PASS PN532 CPU80:', flash, 'flash /', ram, 'RAM;', len(record['files']), 'artifact hashes; 9 identical sources; 51 original firmware + 377 manufacturer package members unchanged.')
