#!/usr/bin/env python3
"""Independently bind the separate CPU80 pair without editing frozen inputs."""
import datetime
import hashlib
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / 'output' / 'firmware-cpu80-root-review-v1'
OBJDUMP = pathlib.Path('/private/tmp/fieldnote-arduino/data/packages/esp32/tools/esp-rv32/2601/bin/riscv32-esp-elf-objdump')
EXPECTED = {
    'firmware/product-build-manifest.json': '807e8122f635ace892323d118a8400f61b9bb5cec75751ed71ce3a501f1b40fa',
    'firmware/factory-build-manifest.json': 'ccc5b3f96e33090a94a3b3e5b6fd5c7207840f847eb223fc3ebd3f3fbae9a5ac',
    'firmware-cpu80/product-build-manifest.json': '11ab14655c02d1e13eb1ed187f0296933a0a5b2fbc9350e4128e81dd7e4c8546',
    'firmware-cpu80/factory-build-manifest.json': 'd38b4c49659f64060358aa50b278c03cac62fb6944f4d85122fbc809817b17c6',
    'manufacturing/usb100-startup-assumption-review.json': 'fdd4faab7969195827165cce583fea03eaf7e3b0d967547f89bba4350880d48f',
}
FQBN = 'esp32:esp32:esp32c3:CDCOnBoot=cdc,CPUFreq=80'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(path, digest):
    assert path.is_file(), str(path)
    actual = sha(path)
    assert actual == digest, (str(path), actual, digest)
    return {'sha256': actual, 'bytes': path.stat().st_size}


def main():
    assert not OUT.exists(), 'Use a new output revision; existing evidence is immutable.'
    snapshots = {}
    manifests = {}
    manifest_checks = {}
    for rel, expected in EXPECTED.items():
        snapshots[rel] = check(ROOT / rel, expected)
        manifests[rel] = json.loads((ROOT / rel).read_text())
        if 'files' not in manifests[rel]:
            continue
        members = manifests[rel]['files']
        for file_rel, digest in members.items():
            member = (ROOT / rel).parent / file_rel
            snapshots[str(member.relative_to(ROOT))] = check(member, digest)
        manifest_checks[rel] = {'members': len(members), 'all_hashes_match': True}

    review = manifests['manufacturing/usb100-startup-assumption-review.json']
    for table in ['input_sha256', 'evidence_files_sha256']:
        for rel, digest in review[table].items():
            snapshots[rel] = check(ROOT / rel, digest)
    installed_inputs = {}
    for absolute, digest in review['installed_toolchain_sha256'].items():
        installed_inputs[absolute] = check(pathlib.Path(absolute), digest)
    for item in review['sources'].values():
        check(ROOT / item['saved'], item['sha256'])
        check(pathlib.Path(item['local_source']), item['sha256'])
    check(ROOT / 'manufacturing/usb100-startup-assumption-review.md', review['review_markdown_sha256'])

    correspondence = json.loads((ROOT / 'firmware-cpu80/product-source-correspondence.json').read_text())
    assert len(correspondence['files']) == 16
    for rel, digest in correspondence['files'].items():
        check(ROOT / correspondence['source_root'] / rel, digest)
        check(ROOT / 'firmware-cpu80/product_integrated_pn7160_v03' / rel, digest)
    factory = manifests['firmware-cpu80/factory-build-manifest.json']
    assert len(factory['source_correspondence']) == 7
    for rel, item in factory['source_correspondence'].items():
        check(ROOT / item['frozen_source'], item['sha256'])
        check(ROOT / 'firmware-cpu80' / rel, item['sha256'])

    results = {}
    fresh_disassembly = {}
    for name, sketch in [('product', 'product_integrated_pn7160_v03'), ('factory', 'factory_test_pn7160_v03')]:
        manifest = manifests[f'firmware-cpu80/{name}-build-manifest.json']
        build = ROOT / 'firmware-cpu80' / f'{name}-build'
        assert manifest['board'] == FQBN
        options = json.loads((build / 'build.options.json').read_text())
        assert options['fqbn'] == FQBN
        assert pathlib.Path(options['sketchLocation']).resolve() == ROOT / 'firmware-cpu80' / sketch
        sdk = (build / 'sdkconfig').read_text()
        assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=160\n' in sdk
        assert 'CONFIG_ESP_REV_MIN_FULL=3\n' in sdk
        assert 'CONFIG_ESP_REV_MAX_FULL=199\n' in sdk
        elf = build / f'{sketch}.ino.elf'
        for symbol in ['app_main', 'esp_clk_init']:
            proc = subprocess.run([str(OBJDUMP), '-d', f'--disassemble={symbol}', str(elf)], capture_output=True, text=True, check=True)
            body = proc.stdout.split(f'<{symbol}>:', 1)[1]
            if symbol == 'app_main':
                assert re.search(r'li\s+a0,80\b', body)
                assert body.index('<setCpuFrequencyMhz>') < body.index('<initArduino>')
            else:
                assert re.search(r'li\s+a0,160\b', body)
                assert '<rtc_clk_cpu_freq_mhz_to_config>' in body
            fresh_disassembly[f'{name}-{symbol}.txt'] = proc.stdout
        boot = build / f'{sketch}.ino.bootloader.bin'
        frozen_boot = ROOT / 'firmware' / f'{name}-build' / f'{sketch}.ino.bootloader.bin'
        assert boot.read_bytes() == frozen_boot.read_bytes()
        for key, offset in [('bootloader', '0x0'), ('partitions', '0x8000'), ('OTA_boot', '0xE000'), ('application', '0x10000')]:
            item = manifest['flash_files'][key]
            assert item['offset'] == offset
            assert sha(ROOT / 'firmware-cpu80' / item['file']) == manifest['files'][item['file']]
        results[name] = {
            'candidate_manifest': f'firmware-cpu80/{name}-build-manifest.json',
            'candidate_manifest_sha256': EXPECTED[f'firmware-cpu80/{name}-build-manifest.json'],
            'application_sha256': sha(build / f'{sketch}.ino.bin'),
            'merged_sha256': sha(build / f'{sketch}.ino.merged.bin'),
            'bootloader_sha256_unchanged': sha(boot),
            'fqbn': FQBN,
            'app_main_MHz_before_initArduino': 80,
            'earlier_IDF_clock_init_MHz': 160,
            'source_identical_files': 16 if name == 'product' else 7,
            'program_bytes': manifest['program_bytes'],
            'ram_bytes': manifest['ram_bytes'],
        }

    for rel, info in snapshots.items():
        check(ROOT / rel, info['sha256'])
    for absolute, info in installed_inputs.items():
        check(pathlib.Path(absolute), info['sha256'])
    OUT.mkdir(parents=True)
    for rel, contents in fresh_disassembly.items():
        (OUT / rel).write_text(contents)
    result = {
        'status': 'PASS_ARTIFACT_IDENTITY_AND_CPU80_PAIR_SELECTION_PHYSICAL_HOLD',
        'generated_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'selected_candidate_pair': results,
        'manifest_member_checks': manifest_checks,
        'bound_inputs': snapshots,
        'installed_inputs': installed_inputs,
        'fresh_disassembly': {rel: {'sha256': sha(OUT / rel), 'bytes': (OUT / rel).stat().st_size} for rel in fresh_disassembly},
        'verifier_sha256': sha(pathlib.Path(__file__)),
        'unchanged_frozen_members': 99,
        'candidate_members': 75,
        'copied_source_files': 23,
        'frozen_package_references_modified': False,
        'selection_scope': 'Matched pair selected for the next engineering-review package and first-article test; original packages preserved.',
        'host_suites_repeated': False,
        'device_flashed': False,
        'complete_USB100_boot_current': 'UNPROVED: earlier SDK, ROM, reset/download, flash programming and actual current envelope remain physical gates.',
        'native_USB_RF_WiFi_and_factory_acceptance': 'NOT_TESTED; exact source host evidence reused only for unchanged source.',
        'production_authorized': False,
    }
    (OUT / 'review.json').write_text(json.dumps(result, indent=2) + '\n')
    (OUT / 'review.md').write_text(
        '# PN7160 CPU80 pair integration review\n\n'
        'The separately compiled product and factory CPU80 images are selected together for the next engineering-review package and first-article testing. '
        'Root independently verified all 75 candidate and 99 frozen manifest members, all 23 copied sources, supported FQBN/build configuration and source evidence. '
        'Fresh disassembly of both actual ELF files confirms the 80 MHz request before Arduino initialization; their earlier ESP-IDF clock initialization remains 160 MHz. '
        'Both bootloaders remain byte-identical to the frozen images.\n\n'
        'Use each selected manifest for exact image paths, hashes and flash offsets. The original product/factory manifests and package references remain unchanged. '
        'Unchanged-source host suites were not repeated, and no board was flashed. This selection does not prove complete USB100 startup or programming current, native USB interoperability, radio/reader behavior or physical factory acceptance. '
        'Production remains HOLD. The complete power path and actual routed hardware still require verification.\n\n'
        'See [the bound evidence](review.json) and [the startup review](../../manufacturing/usb100-startup-assumption-review.md).\n'
    )
    print(json.dumps({k: result[k] for k in ['status', 'unchanged_frozen_members', 'candidate_members', 'copied_source_files', 'production_authorized']}))
    print('review_sha256', sha(OUT / 'review.json'))


if __name__ == '__main__':
    main()
