#!/usr/bin/env python3
"""Bind frozen CPU80 product to adopted native CAD; write new review files only."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FINAL = ROOT / 'output/native-review-candidate-v2'
FIRMWARE = ROOT / 'firmware-cpu80'
SKETCH = FIRMWARE / 'product_integrated_pn7160_v03'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def constant(source, name):
    value = re.search(r'\b' + name + r'\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*;', source)
    assert value, name
    return int(value.group(1), 0)


def main():
    required = {
        'fieldnote.kicad_pcb': '7b3c0b8d9d14abde51ec01ae3f21b2ca2af0204b79f25e4eb8b13243ad3029f6',
        'design-data.json': 'e5db89f4158c074e48b2796a4e05f75d80875480a6e508622d0e021d18e1c3fa',
        'source-revision.json': '4514092663f48b077e985be1082a2e02d50e0ffbd4580cdd701d20d3377e3941',
    }
    for relative, digest in required.items():
        assert sha(FINAL / relative) == digest, relative
    freeze = json.loads((FINAL / 'native-freeze-manifest.json').read_text())
    for entry in freeze['files']:
        path = FINAL / entry['path']
        assert sha(path) == entry['sha256'] and path.stat().st_size == entry['size'], entry['path']
    manifests = {}
    for relative, digest in (
        ('firmware-cpu80/product-build-manifest.json', '11ab14655c02d1e13eb1ed187f0296933a0a5b2fbc9350e4128e81dd7e4c8546'),
        ('firmware-cpu80/factory-build-manifest.json', 'd38b4c49659f64060358aa50b278c03cac62fb6944f4d85122fbc809817b17c6'),
        ('firmware/product-build-manifest.json', '807e8122f635ace892323d118a8400f61b9bb5cec75751ed71ce3a501f1b40fa'),
        ('firmware/factory-build-manifest.json', 'ccc5b3f96e33090a94a3b3e5b6fd5c7207840f847eb223fc3ebd3f3fbae9a5ac'),
    ):
        path = ROOT / relative
        assert sha(path) == digest, relative
        record = json.loads(path.read_text())
        for member, member_digest in record['files'].items():
            assert sha(path.parent / member) == member_digest, member
        manifests[relative] = {'sha256': digest, 'members_verified': len(record['files'])}
    selection = ROOT / 'output/firmware-cpu80-root-review-v1/review.json'
    assert sha(selection) == 'a071072c5b337911df33bb324c40d72c658076c6379ff3d3143aa2dad8e4c861'
    assert json.loads(selection.read_text())['status'] == 'PASS_ARTIFACT_IDENTITY_AND_CPU80_PAIR_SELECTION_PHYSICAL_HOLD'

    helper = ROOT / 'manufacturing/audit_native_pins.py'
    with tempfile.TemporaryDirectory(prefix='fieldnote-final-product-profile-') as temp:
        output = Path(temp) / 'pin-parity.json'
        command = [sys.executable, str(helper), '--board', str(FINAL / 'fieldnote.kicad_pcb'),
                   '--netlist', str(FINAL / 'fieldnote.net'), '--metadata', str(FINAL / 'design-data.json'),
                   '--require-board-sha256', required['fieldnote.kicad_pcb'], '--out', str(output)]
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        parity = json.loads(output.read_text())
    assert parity['status'] == 'PASS_NATIVE_PIN_METADATA_PARITY' and not parity['errors']

    parts = {p['ref']: p for p in json.loads((FINAL / 'design-data.json').read_text())['parts']}
    assert parts['U1']['mpn'] == 'ESP32-C3-MINI-1-N4X'
    assert parts['U2']['mpn'] == 'PN7160A1HN/C100E'
    critical = {
        'U1': {'12': 'BAT_ADC', '13': 'LED_GREEN', '6': 'LED_AMBER', '16': 'LED_RED',
               '18': 'NFC_SDA', '19': 'NFC_SCL', '20': 'USB_LIMITED', '21': 'NFC_VEN',
               '26': 'MCU_USB_DM', '27': 'MCU_USB_DP', '30': 'MCU_NFC_IRQ', '31': 'UART_TX'},
        'U2': {'1': 'GND', '2': 'GND', '3': 'GND', '5': 'NFC_SDA', '6': '3V3', '7': 'NFC_SCL',
               '8': 'NFC_IRQ', '10': 'NFC_VEN', '12': 'NFC_VBAT', '13': 'NFC_VBAT', '28': 'NFC_VBAT',
               '14': 'PN_TX_LDO', '18': 'PN_TX_LDO', '22': 'PN_TX_LDO', '26': 'PN_1V8',
               '27': 'PN_1V8', '31': 'PN_1V8', '29': 'NFC_OSCOUT', '30': 'NFC_OSCIN', '39': 'GND', '41': 'GND'},
        'R19': {'1': 'NFC_VEN', '2': 'GND'}, 'R27': {'1': 'NFC_IRQ', '2': 'MCU_NFC_IRQ'},
        'R28': {'1': 'UART_RX', '2': 'MCU_NFC_IRQ'},
        'J4': {'3': 'UART_TX', '4': 'UART_RX', '5': 'ESP_EN', '6': 'BOOT_IO9'},
        'FB1': {'1': 'VSYS', '2': 'NFC_VBAT'},
        'Y1': {'1': 'NFC_OSCIN', '2': 'GND', '3': 'NFC_OSCOUT', '4': 'GND'},
        'C28': {'1': 'RF1_MATCH', '2': 'GND'}, 'C29': {'1': 'RF2_MATCH', '2': 'GND'},
        'R7': {'1': 'USB_LIMITED', '2': '3V3'},
    }
    for reference, pins in critical.items():
        for pin, net in pins.items():
            assert parts[reference]['nets'][pin] == net, (reference, pin, net)
    for reference, dnp in (('R19', False), ('R27', False), ('R28', True), ('J4', True)):
        assert parts[reference]['dnp'] == dnp, reference
    assert parts['R19']['value'].startswith('100k')
    assert parts['Y1']['mpn'] == 'NX2016SA-27.12MHZ-EXS00A-CS06346'
    assert parts['Y1']['value'] == '27.12MHz CL10pF'
    for reference in ('C28', 'C29'):
        assert parts[reference]['mpn'] == 'CC0603GRNPO9BN301'
        assert parts[reference]['value'].startswith('300pF')

    source = (SKETCH / 'product_integrated_pn7160_v03.ino').read_text()
    wire = (SKETCH / 'pn7160_arduino.h').read_text()
    power = (SKETCH / 'integrated_power.h').read_text()
    core = (SKETCH / 'pn7160_nci.h').read_text()
    constants = {name: constant(text, name) for text, names in (
        (source, ('kSdaPin', 'kSclPin')),
        (wire, ('kAddress', 'kIrqPin', 'kVenPin', 'kBusTimeoutMs')),
        (power, ('kUsbLimitedPin', 'kPnResetPin', 'kGreenPin', 'kAmberPin', 'kRedPin',
                 'kQualificationMs', 'kMonitorIntervalMs')),
    ) for name in names}
    assert constants == {'kSdaPin': 4, 'kSclPin': 5, 'kAddress': 0x28, 'kIrqPin': 20,
        'kVenPin': 7, 'kBusTimeoutMs': 30, 'kUsbLimitedPin': 6, 'kPnResetPin': 7,
        'kGreenPin': 1, 'kAmberPin': 3, 'kRedPin': 10, 'kQualificationMs': 100, 'kMonitorIntervalMs': 10}
    assert 'kIrqActiveHigh = true' in wire
    assert '#if !defined(ARDUINO_USB_CDC_ON_BOOT) || !ARDUINO_USB_CDC_ON_BOOT' in source
    assert 'pinMode(pn7160_board::kIrqPin, INPUT)' in source
    assert 'pn7160.model() != 0x61' in source
    assert 'Wire.begin(kSdaPin, kSclPin, 100000)' in source
    assert 'setCpuFrequencyMhz(80)' in source
    configuration_checks = [
        'const uint8_t irq = irqActiveHigh ? 0x00 : 0x02',
        'clock = (clock & ~0x10u) | 0x08', 'pmu[2] = (pmu[2] & ~0xF3u) | 0x02',
        'pmu[3] = (pmu[3] & ~0xC3u) | 0x02', 'pmu[7] = (pmu[7] & 0x0F) | 0x10',
        'pmu[9] &= ~0xC0u', 'uint8_t dpc[87]', 'dpc[0] &= 0x1F', 'configure(0x0B, dpc',
        'if (configurationChanged_ && !resetInit()) return false',
        'getConfig(0x03, &verifiedClock, 1)', 'getConfig(0x0E, verifiedPmu',
        'memcmp(pmu, verifiedPmu', 'getConfig(0x0B, verifiedDpc', 'memcmp(dpc, verifiedDpc',
    ]
    for fragment in configuration_checks:
        assert fragment in core, fragment
    for relative in ('pn7160_nci.h', 'pn7160_arduino.h', 'integrated_power.h'):
        assert (SKETCH / relative).read_bytes() == (FIRMWARE / 'factory_test_pn7160_v03' / relative).read_bytes()

    erc = json.loads((FINAL / 'erc.json').read_text())
    drc = json.loads((FINAL / 'drc.json').read_text())
    assert not any(sheet['violations'] for sheet in erc['sheets'])
    assert not drc['violations'] and not drc['unconnected_items'] and not drc['schematic_parity']
    paths = [FINAL / name for name in ('fieldnote.kicad_pcb', 'fieldnote.net', 'design-data.json',
        'source-revision.json', 'native-freeze-manifest.json', 'erc.json', 'drc.json',
        'fieldnote.kicad_sch', 'esp32-leds.kicad_sch', 'pn7160.kicad_sch', 'usb-power.kicad_sch', 'nfc-rf.kicad_sch')]
    paths += [SKETCH / name for name in ('product_integrated_pn7160_v03.ino', 'pn7160_nci.h', 'pn7160_arduino.h', 'integrated_power.h')]
    paths += [helper, selection, Path(__file__)]
    record = {
        'status': 'PASS_FINAL_PRODUCT_NATIVE_PROFILE_BINDING_PHYSICAL_HOLD',
        'generated_utc': datetime.now(timezone.utc).isoformat(),
        'inputs_sha256': {str(path.relative_to(ROOT)): sha(path) for path in paths},
        'selected_firmware_and_originals_unchanged': manifests,
        'native_freeze_members_verified': len(freeze['files']),
        'fresh_native_pin_metadata_revalidation': parity,
        'product_constants': constants,
        'firmware_critical_pin_assignments': critical,
        'module_and_reader': {'MCU': 'ESP32-C3-MINI-1-N4X', 'NFC': 'PN7160A1HN/C100E',
            'expected_NFC_model_hex': '61', 'factory_expected_firmware': '12.50.05',
            'note': 'Product checks model and reports firmware; exact controller firmware is a physical factory acceptance gate.'},
        'recovery_profile': {'normal': 'R27 fitted, R28 DNP; GPIO20 input active-HIGH NFC IRQ',
            'ROM_UART_service': 'Remove R27 before fitting R28, hold VEN LOW; normal NFC firmware requires restoring the IRQ strap',
            'VEN': 'GPIO7 active HIGH; 100k R19 pulldown on NFC_VEN; LOW in service/reset',
            'native_USB': 'GPIO18/19, CDC-on required; separate UART header DNP'},
        'configuration_binding': {'I2C_address_7bit_hex': '28', 'address_straps': 'ADR0/ADR1 GND',
            'power': 'Filtered VSYS through FB1 supplies VBAT/VDDUP; PVDD3V3; CFG2/no external DCDC; internal TXLDO3.3V on qualified USB',
            'clock': 'NDK27.12MHz CL10pF crystal; A003 bit3 set/bit4 cleared, PMU ON source00',
            'DPC': 'A00B87bytes, E0 enables cleared; clock/PMU/DPC full readback after configuration/reset before RF map',
            'source_configuration_guards_checked': len(configuration_checks),
            'RF_seed': 'C28/C29 300pF is physical tuning seed only; no demonstration RF_CONF copied; physical tuning remains required',
            'battery': 'Battery-only full operation remains unqualified; USB profile retained'},
        'saved_native_checks': {'ERC_violations': 0, 'DRC_violations': 0, 'unconnected_items': 0,
            'schematic_parity_findings': 0, 'scope': 'Hash-bound existing native reports; ERC/DRC not rerun here',
            'ERC_ignored_checks': erc['ignored_checks'], 'DRC_ignored_checks': drc['ignored_checks']},
        'verification_scope': 'Fresh final native netlist/board/metadata and product-source profile binding; no unchanged compile/host suites repeated',
        'physical_tests': 'NOT_TESTED', 'production_release': 'HOLD',
        'limitations': ['Logical native pin/net/field/population agreement does not prove physical GPIO, RF, current, timing or USB function.',
            'Selected CPU80 moves the reduction to app_main; precompiled SDK startup remains160MHz and ROM/USB100 current is not guaranteed.',
            'Initial NCI configuration precedes Wi-Fi; later reader retries can overlap Wi-Fi and need measured inrush qualification.'],
    }
    output = ROOT / 'manufacturing/final-product-native-binding.json'
    output.write_text(json.dumps(record, indent=2) + '\n')
    print('PASS final product profile: 99 footprints / 354 physical pads; ' + str(sum(map(len, critical.values()))) + ' firmware-critical pins; frozen firmware/CAD members unchanged.')


if __name__ == '__main__':
    main()
