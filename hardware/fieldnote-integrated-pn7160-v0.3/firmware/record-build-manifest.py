#!/usr/bin/env python3
"""Record successful firmware/export and immutable host-test inputs, without flashing."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
VARIANT = ROOT.parent
SKETCH = ROOT / 'product_integrated_pn7160_v03'
BUILD = ROOT / 'product-build'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


log = (BUILD / 'compile.log').read_text()
flash = int(re.search(r'Sketch uses (\d+) bytes', log).group(1))
ram = int(re.search(r'Global variables use (\d+) bytes', log).group(1))
assert 'Error during build' not in log
assert 'native USB CDC is required' in (BUILD / 'cdc-off-rejection.log').read_text()
verification = json.loads((ROOT / 'tests/verification-results.json').read_text())
assert verification['status'] == 'PASS_HOST_CHECKS_ONLY'
for name, expected in verification['inputs_sha256'].items():
    assert sha(VARIANT / name) == expected, f'Independent input changed: {name}'
protocol = (ROOT / 'tests/test_pn7160_protocol.log').read_text()
protocol_result = re.search(r'RESULT passed=(\d+) failed=(\d+)', protocol)
assert protocol_result and int(protocol_result.group(2)) == 0
protocol_cases = int(protocol_result.group(1))
assert protocol_cases >= 50
baseline = json.loads((ROOT / 'product-source-baseline.json').read_text())
for name, expected in baseline['sources'].items():
    assert sha(Path(baseline['source_root']) / name) == expected, name
assert sha(Path(baseline['source_manifest'])) == baseline['source_manifest_sha256']
app_info = (BUILD / 'image-info-app.txt').read_text()
boot_info = (BUILD / 'image-info-bootloader.txt').read_text()
for report in (app_info, boot_info):
    assert 'ESP32-C3' in report and '(valid)' in report and 'ESP-IDF: v5.5.5' in report
sdk = (BUILD / 'sdkconfig').read_text()
assert 'CONFIG_ESP32C3_REV_MIN_FULL=3' in sdk
assert 'CONFIG_ESP32C3_REV_MAX_FULL=199' in sdk
assert '# CONFIG_SPI_FLASH_ROM_IMPL is not set' in sdk
for name in ['admin-ui-test.log','web-embedding-test.log','wire-transport-test.log','tag-policy-test.log','power-qualification-test.log']:
    text = (BUILD / name).read_text()
    assert text.strip() and 'FAIL' not in text, name
images = [p for p in BUILD.iterdir() if p.suffix in ('.bin', '.elf', '.map')]
assert images
for image in images:
    duplicate = SKETCH / 'build/esp32.esp32.esp32c3' / image.name
    assert duplicate.exists() and sha(image) == sha(duplicate), image.name

record = {
    'status': 'COMPILED_AND_HOST_VERIFIED_NOT_FLASHED_OR_PHYSICALLY_QUALIFIED',
    'generated_utc': datetime.now(timezone.utc).isoformat(),
    'sketch': SKETCH.name,
    'app_version': '1.5.0-pn7160',
    'board': 'esp32:esp32:esp32c3:CDCOnBoot=cdc',
    'build_command': 'arduino-cli --config-file /private/tmp/fieldnote-arduino/arduino-cli.yaml compile --fqbn esp32:esp32:esp32c3:CDCOnBoot=cdc --build-path /private/tmp/fieldnote-arduino/pn7160-product-build --export-binaries hardware/fieldnote-integrated-pn7160-v0.3/firmware/product_integrated_pn7160_v03',
    'toolchain': {'ArduinoCLI': '1.5.1', 'ESP32_Arduino': '3.3.12', 'ESP_IDF': '5.5.5', 'esptool': '5.3.1', 'ArduinoJson': '7.4.3', 'Adafruit_PN532_dependency': False, 'proprietary_NXP_MCU_library_included': False},
    'program_bytes': flash, 'ram_bytes': ram,
    'module_compatibility': {'selected_MPN': 'ESP32-C3-MINI-1-N4X', 'chip_revision': 'v1.1', 'SDK_min_revision': 'v0.3', 'SDK_max_revision': 'v1.99', 'flash_MB': 4, 'image_flash_mode': 'DIO', 'image_flash_frequency_MHz': 80, 'SPI_FLASH_ROM_IMPL': False, 'note': 'Image header has permissive legacy revision values; saved SDK bounds establish shared-revision support.'},
    'reader_profile': {'MPN': 'PN7160A1HN/C100E', 'expected_model_id_hex': '61', 'expected_controller_firmware': '12.50.05', 'interface': 'NCI2 I2C', 'address_7bit_hex': '28', 'SDA_GPIO': 4, 'SCL_GPIO': 5, 'IRQ_GPIO': 20, 'IRQ_active_high': True, 'VEN_GPIO': 7, 'service_VEN_low': True, 'DWL_REQ_and_WUP_REQ': 'GND', 'RF_state': 'Known IDLE/discovery/active; no deactivation command in IDLE', 'configuration': 'EEPROM read-modify/write-if-changed; RESET KEEP/INIT after changes; no copied demonstration RF_CONF', 'PMU': 'CFG2/no DC-DC; TXLDO3.3V with qualified USB VSYS~4.4V; VUP5V/3.6V checks disabled while reserved fields preserved', 'clock': '27.12MHz crystal; A003 b3 set and C100E RFU b4 cleared; PMU ON clock source00 follows CLOCK_SEL; full clock/PMU post-reset readback required', 'DPC': 'A00B length87; clear byte0 E0, preserve other bytes, verify full read-back before RF map/discovery', 'battery': 'Battery-only full operation not enabled; future voltage-aware TXLDO policy and hardware qualification required'},
    'hardware_profile': {'USB_LIMITED_GPIO': 6, 'LED_GPIO': {'green': 1, 'amber': 3, 'red': 10}, 'native_USB_GPIO': {'DM': 18, 'DP': 19}, 'CDC_required': True, 'GPIO20_service_straps': 'R27 fitted, R28 DNP; mutually exclusive UART recovery configuration disables NFC IRQ', 'CPU_MHz': 80, 'qualification_ms': 100, 'monitor_interval_ms': 10, 'VEN_reset_low_ms': 10, 'VEN_cold_start_ms': 1000, 'initial_sequence': 'Qualified VEN/NCI/config before Wi-Fi; RF polling gated until networkStarted', 'retry_sequence': 'RF session failure requests one immediate reinit; failed bring-up uses a 30-second retry over qualified Wi-Fi; inrush unmeasured'},
    'product_contract': {'routes': ['/', '/api/status', '/api/write', '/health'], 'hostname': 'nfc-reader', 'status_compatibility': 'Historical pn532 JSON slot retained with chip=PN7160 and actual model/firmware/NCI diagnostics', 'credentials': 'Same validated fieldnote/wifi record; no migration/credential embedding', 'Classic': '4-byte UID, sector1 KeyA, blocks4–6, 48-byte NFCWEB01/CRC/read-back/rollback', 'Type2': '4/7-byte UID, pages4–15, short UTF8 text/HTTP(S) URL NDEF, max36bytes, safe commit/read-back/rollback', 'write_authorization': 'Explicit confirmation; recent writable UID; fresh UID+protocol selection; session change blocks further writes including rollback', 'unimplemented_headroom': 'No BLE app service, P2P, phone-to-PCB emulation or wider tag protocol stack'},
    'verification': {'independent_report': 'tests/verification-results.json', 'protocol_mock_cases': protocol_cases, 'power_qualifier_cases': 8, 'actual_codec_rollback_fixture_cases': 13, 'exact_frozen_codec_functions': 11, 'strict_host_warnings': True, 'ASan_UBSan': 'PASS independent suites', 'wire_transport': 'PASS IRQ-gated split read, whole-frame NACK retry, short/ambiguous error rejection, cancellation/timer wrap', 'tag_policy': 'PASS supported UID/protocol matrix and matching read/write dispatch', 'browser_UI': 'PASS 8 groups from copied admin UI suite', 'generated_UI': 'PASS exact embedding check', 'CDC_off': 'Expected compile-time rejection; GPIO20 UART contention prevented', 'frozen_v02': '8 source files and frozen product-build manifest unchanged', 'native_pin_snapshot': '36 logical assignments only; no routed continuity/physical proof', 'physical': 'NOT_TESTED; no board flashed'},
    'flash_files': {'bootloader': {'offset': '0x0', 'file': 'product-build/product_integrated_pn7160_v03.ino.bootloader.bin'}, 'partitions': {'offset': '0x8000', 'file': 'product-build/product_integrated_pn7160_v03.ino.partitions.bin'}, 'OTA_boot': {'offset': '0xE000', 'file': 'product-build/boot_app0.bin'}, 'application': {'offset': '0x10000', 'file': 'product-build/product_integrated_pn7160_v03.ino.bin'}, 'fresh_factory_merged_image': {'offset': '0x0', 'file': 'product-build/product_integrated_pn7160_v03.ino.merged.bin', 'note': 'Factory fresh-board image; ordinary existing credentials must not be erased without authorization.'}},
    'production_release': 'HOLD pending physical USB/power/IRQ/current/thermal/RF/tag/phone/stress qualification and final CAD/manufacturing release',
    'limitations': ['NCI packets fit one frame; fragmented messages fail closed rather than reassemble.', 'Host tests do not execute real FreeRTOS/HTTP/Wi-Fi/IRQ or establish actual reader firmware interoperability.', 'Nominal power models and staged startup do not bound PN7160 PMU inrush; retries over Wi-Fi require physical measurement.', 'Firmware12.50.05/MPN must be checked; later firmware changes advertised TypeF/P2P/FeliCa capabilities.', 'No measured baseline read/write range or prototype parity is inherited.'],
}
def product_file(path):
    if not path.is_file() or '__pycache__' in path.parts:
        return False
    relative = path.relative_to(ROOT)
    # The independently built factory diagnostic has its own manifest and may
    # be updated without changing this frozen product firmware release.
    if relative.parts[0] in ('factory_test_pn7160_v03', 'factory-build'):
        return False
    return path.name not in ('product-build-manifest.json', 'factory-build-manifest.json',
                             'record-factory-build.py')


record['file_scope'] = 'Product firmware, exported build, product documentation and independent host tests; separate factory diagnostic excluded and records its own manifest.'
record['files'] = {str(p.relative_to(ROOT)): sha(p) for p in sorted(ROOT.rglob('*')) if product_file(p)}
(ROOT / 'product-build-manifest.json').write_text(json.dumps(record, indent=2)+'\n')
print(f'PASS manifest: {flash} flash / {ram} RAM bytes; {len(record["files"])} hashed files; all independent inputs and frozen baseline match.')
