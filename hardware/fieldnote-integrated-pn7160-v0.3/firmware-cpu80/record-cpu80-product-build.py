#!/usr/bin/env python3
"""Verify separate CPU80 build against frozen sources and record exact artifacts."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
VARIANT = ROOT.parent
FROZEN = VARIANT / 'firmware'
SKETCH = ROOT / 'product_integrated_pn7160_v03'
BUILD = ROOT / 'product-build'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


frozen_records = {}
for name, expected in (
    ('product-build-manifest.json', '807e8122f635ace892323d118a8400f61b9bb5cec75751ed71ce3a501f1b40fa'),
    ('factory-build-manifest.json', 'ccc5b3f96e33090a94a3b3e5b6fd5c7207840f847eb223fc3ebd3f3fbae9a5ac'),
):
    manifest = FROZEN / name
    assert sha(manifest) == expected, 'Frozen manifest changed: ' + name
    record = json.loads(manifest.read_text())
    for relative, digest in record['files'].items():
        assert sha(FROZEN / relative) == digest, 'Frozen member changed: ' + relative
    frozen_records[name] = {'sha256': expected, 'members_verified': len(record['files'])}

correspondence = json.loads((ROOT / 'product-source-correspondence.json').read_text())
assert correspondence['source_product_manifest_sha256'] == frozen_records['product-build-manifest.json']['sha256']
for relative, digest in correspondence['files'].items():
    assert sha(SKETCH / relative) == digest
    assert sha(VARIANT / correspondence['source_root'] / relative) == digest

log = (BUILD / 'compile.log').read_text()
flash = int(re.search(r'Sketch uses (\d+) bytes', log).group(1))
ram = int(re.search(r'Global variables use (\d+) bytes', log).group(1))
assert 'Error during build' not in log
options = json.loads((BUILD / 'build.options.json').read_text())
fqbn = 'esp32:esp32:esp32c3:CDCOnBoot=cdc,CPUFreq=80'
assert options['fqbn'] == fqbn
app_main = (BUILD / 'app-main-disassembly.txt').read_text()
idf_clock = (BUILD / 'idf-clock-disassembly.txt').read_text()
assert re.search(r'li\s+a0,80\b', app_main) and 'setCpuFrequencyMhz' in app_main
assert re.search(r'li\s+a0,160\b', idf_clock) and 'rtc_clk_cpu_freq_mhz_to_config' in idf_clock
sdk = (BUILD / 'sdkconfig').read_text()
assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=160' in sdk
assert 'CONFIG_ESP32C3_REV_MIN_FULL=3' in sdk and 'CONFIG_ESP32C3_REV_MAX_FULL=199' in sdk
assert '# CONFIG_SPI_FLASH_ROM_IMPL is not set' in sdk
info = (BUILD / 'image-info-app.txt').read_text()
assert 'ESP32-C3' in info and '(valid)' in info and 'ESP-IDF: v5.5.5' in info

for image in BUILD.iterdir():
    if image.suffix in ('.bin', '.elf', '.map'):
        assert sha(image) == sha(SKETCH / 'build/esp32.esp32.esp32c3' / image.name)
boot = BUILD / 'product_integrated_pn7160_v03.ino.bootloader.bin'
assert sha(boot) == sha(FROZEN / 'product-build' / boot.name)

report = FROZEN / 'tests/verification-results.json'
assert sha(report) == 'bc2fa4bec474acfcc3c59bef7bfc6aa09583c91ae4fe78f6fe1d66d46ab1a083'
verification = json.loads(report.read_text())
for relative, digest in verification['inputs_sha256'].items():
    assert sha(VARIANT / relative) == digest
protocol_log = (FROZEN / 'tests/test_pn7160_protocol.log').read_text()
assert 'RESULT passed=52 failed=0' in protocol_log

record = {
    'status': 'SEPARATE_CPU80_BUILD_COMPILED_IDENTICAL_SOURCE_NOT_FLASHED_OR_PHYSICALLY_QUALIFIED',
    'generated_utc': datetime.now(timezone.utc).isoformat(),
    'board': fqbn,
    'application_version_unchanged': '1.5.0-pn7160',
    'build_command': 'arduino-cli --config-file /private/tmp/fieldnote-arduino/arduino-cli.yaml compile --fqbn ' + fqbn + ' --build-path /private/tmp/fieldnote-arduino/pn7160-product-cpu80-build --export-binaries hardware/fieldnote-integrated-pn7160-v0.3/firmware-cpu80/product_integrated_pn7160_v03',
    'program_bytes': flash, 'ram_bytes': ram,
    'toolchain': {'ArduinoCLI': '1.5.1', 'ESP32_Arduino': '3.3.12', 'ESP_IDF': '5.5.5', 'esptool': '5.3.1', 'ArduinoJson': '7.4.3'},
    'frozen_originals_verified_unchanged': frozen_records,
    'copied_source_sha256': correspondence['files'],
    'clock_profile': {'F_CPU_MHz': 80, 'SDK_early_MHz': 160, 'runtime_setup_MHz': 80, 'CPU80_PLL_MHz': 480, 'CPU80_PLL_divider': 6, 'APB_MHz': 80, 'reduction_hook': 'Beginning of Arduino app_main, before initArduino/NVS/loopTask/setup, after ESP-IDF port/system startup and global constructors', 'normal_second_stage_CPU_MHz': 80, 'ROM_and_reset_paths': 'Not changed by CPUFreq option; complete physical clocks/current not measured', 'ELF_evidence': ['product-build/app-main-disassembly.txt', 'product-build/idf-clock-disassembly.txt']},
    'module': {'MPN': 'ESP32-C3-MINI-1-N4X', 'revision': 'v1.1', 'SDK_min': 'v0.3', 'SDK_max': 'v1.99', 'flash_MB': 4, 'flash_mode': 'DIO', 'flash_MHz': 80},
    'native_USB': 'CDC-on retained, GPIO18/19 retained, GPIO20 UART exclusion unchanged; supported CPU80 PLL preserved; physical enumeration/programming NOT_TESTED',
    'source_behavior': 'Byte-identical APIs/UI/provisioning/tag protocols/CRC/readback/rollback/USB power supervisor; only earlier supported clock selection changes',
    'shared_host_evidence': {'reference': '../firmware/tests/verification-results.json', 'sha256': sha(report), 'protocol_mock_cases': 52, 'power_qualifier_cases': 8, 'actual_codec_rollback_cases': 13, 'exact_frozen_codec_functions': 11, 'rerun_for_build_flag': False, 'scope': 'Identical source evidence only; does not execute startup/FreeRTOS/radio/native USB'},
    'startup_review': {'reference': '../manufacturing/usb100-startup-assumption-review.json', 'sha256': sha(VARIANT / 'manufacturing/usb100-startup-assumption-review.json')},
    'flash_files': {'bootloader': {'offset': '0x0', 'file': 'product-build/product_integrated_pn7160_v03.ino.bootloader.bin', 'matches_frozen_bootloader': True}, 'partitions': {'offset': '0x8000', 'file': 'product-build/product_integrated_pn7160_v03.ino.partitions.bin'}, 'OTA_boot': {'offset': '0xE000', 'file': 'product-build/boot_app0.bin'}, 'application': {'offset': '0x10000', 'file': 'product-build/product_integrated_pn7160_v03.ino.bin'}, 'fresh_factory_merged': {'offset': '0x0', 'file': 'product-build/product_integrated_pn7160_v03.ino.merged.bin'}},
    'limitations': ['Does not configure mask ROM or remove the precompiled SDK160 startup interval.', 'Typical current tables and an imposed86mA service load do not guarantee complete USB100 boot/programming current.', 'No board flashed; native USB, clocks/timing, current/ripple, NFC/RF and product interoperability remain physical gates.'],
    'package_references_changed': False,
    'production_release': 'HOLD',
}
paths = [ROOT / 'product-cpu80-selection.md', ROOT / 'product-source-correspondence.json', Path(__file__)]
paths += [p for folder in (SKETCH, BUILD) for p in folder.rglob('*') if p.is_file() and '__pycache__' not in p.parts]
record['files'] = {str(p.relative_to(ROOT)): sha(p) for p in sorted(set(paths))}
(ROOT / 'product-build-manifest.json').write_text(json.dumps(record, indent=2) + '\n')
print('PASS CPU80 product manifest:', flash, 'flash /', ram, 'RAM;', len(record['files']), 'hashed files;', len(correspondence['files']), 'identical sources; all99 frozen members unchanged.')
