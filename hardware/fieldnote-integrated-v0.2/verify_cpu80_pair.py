#!/usr/bin/env python3
"""Independent PN532 CPU80 artifact selection, preserving prior packages."""
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / 'output/firmware-cpu80-root-review-v1'
OBJDUMP = pathlib.Path('/private/tmp/fieldnote-arduino/data/packages/esp32/tools/esp-rv32/2601/bin/riscv32-esp-elf-objdump')
EXPECTED = {
    'firmware/product-build-manifest.json': 'f683feb752693a8a3ac03b43d773a113523ef90b78a7196d57dcaa128c63a30a',
    'firmware/build-manifest.json': '1ba1f7cf441a42f06d837848641f86e2663e89ed288ef283b68915e6293b260a',
    'firmware-cpu80/product-build-manifest.json': 'ff402de67210242fd40e4164f7a910c052c9930eb1820a8b4f53b122e96d4598',
    'firmware-cpu80/factory-build-manifest.json': 'bb5eed96d2f0b543bb34d65f319886d3cd2289a0516724070c30c0fa21f42570',
}
PACKAGE = ROOT / 'output/Fieldnote-PCBWay-review-v0.2-c6c7ff17-80body-r2'
ZIP_SHA = 'a25aeda7b8833820edf8034020715c6115450c49d69f677dcf37537bd746b012'
PACKAGE_MANIFEST_SHA = '5b59b8cb24707a68c9d407f48867b94bed0f016a4c06c12124f2d01c6984903c'
FQBN = 'esp32:esp32:esp32c3:CDCOnBoot=cdc,CPUFreq=80'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    assert not OUT.exists(), 'Use a fresh output revision; prior evidence is immutable.'
    inputs = {}
    manifests = {}
    counts = {}
    for rel, expected in EXPECTED.items():
        path = ROOT / rel
        assert sha(path) == expected
        inputs[rel] = expected
        manifest = json.loads(path.read_text())
        manifests[rel] = manifest
        counts[rel] = len(manifest['files'])
        for file_rel, digest in manifest['files'].items():
            member = path.parent / file_rel
            assert sha(member) == digest, str(member)
            inputs[str(member.relative_to(ROOT))] = digest
    product = manifests['firmware-cpu80/product-build-manifest.json']
    assert len(product['copied_source_sha256']) == 9
    for rel, digest in product['copied_source_sha256'].items():
        assert sha(ROOT / 'firmware/product_integrated_v02' / rel) == digest
        assert sha(ROOT / 'firmware-cpu80/product_integrated_v02' / rel) == digest
    factory = manifests['firmware-cpu80/factory-build-manifest.json']
    assert len(factory['source_correspondence']) == 1
    for rel, item in factory['source_correspondence'].items():
        assert sha(ROOT / 'firmware-cpu80' / rel) == item['sha256']
        assert sha(ROOT / item['frozen_source']) == item['sha256']
    dependencies = {}
    for name, item in product['dependency_source_sha256'].items():
        for rel, digest in item['files_sha256'].items():
            path = pathlib.Path(item['source_root']) / rel
            assert sha(path) == digest
            dependencies[str(path)] = digest
    for absolute, digest in product['installed_arduino_sources_sha256'].items():
        assert sha(pathlib.Path(absolute)) == digest
        dependencies[absolute] = digest

    selected = {}
    disassembly = {}
    for name, sketch, old_build in [('product', 'product_integrated_v02', 'product-build'), ('factory', 'factory_test', 'build')]:
        manifest = manifests[f'firmware-cpu80/{name}-build-manifest.json']
        build = ROOT / 'firmware-cpu80' / f'{name}-build'
        assert manifest['board'] == FQBN
        assert json.loads((build / 'build.options.json').read_text())['fqbn'] == FQBN
        sdk = (build / 'sdkconfig').read_text()
        assert 'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=160\n' in sdk
        assert 'CONFIG_ESP_REV_MIN_FULL=3\n' in sdk and 'CONFIG_ESP_REV_MAX_FULL=199\n' in sdk
        for symbol in ['app_main', 'esp_clk_init']:
            proc = subprocess.run([str(OBJDUMP), '-d', f'--disassemble={symbol}', str(build / f'{sketch}.ino.elf')], capture_output=True, text=True, check=True)
            body = proc.stdout.split(f'<{symbol}>:', 1)[1]
            if symbol == 'app_main':
                assert re.search(r'li\s+a0,80\b', body)
                assert body.index('<setCpuFrequencyMhz>') < body.index('<initArduino>')
            else:
                assert re.search(r'li\s+a0,160\b', body) and '<rtc_clk_cpu_freq_mhz_to_config>' in body
            disassembly[f'{name}-{symbol}.txt'] = proc.stdout
        boot = build / f'{sketch}.ino.bootloader.bin'
        assert boot.read_bytes() == (ROOT / 'firmware' / old_build / boot.name).read_bytes()
        for key, offset in [('bootloader', '0x0'), ('partitions', '0x8000'), ('OTA_boot', '0xE000'), ('application', '0x10000')]:
            item = manifest['flash_files'][key]
            assert item['offset'] == offset
            assert sha(ROOT / 'firmware-cpu80' / item['file']) == manifest['files'][item['file']]
        selected[name] = {
            'manifest': f'firmware-cpu80/{name}-build-manifest.json',
            'manifest_sha256': EXPECTED[f'firmware-cpu80/{name}-build-manifest.json'],
            'application_sha256': sha(build / f'{sketch}.ino.bin'),
            'merged_sha256': sha(build / f'{sketch}.ino.merged.bin'),
            'unchanged_bootloader_sha256': sha(boot),
            'fqbn': FQBN,
            'program_bytes': manifest['program_bytes'],
            'ram_bytes': manifest['ram_bytes'],
            'app_main_before_initArduino_MHz': 80,
            'earlier_IDF_startup_MHz': 160,
        }

    archive = pathlib.Path(str(PACKAGE) + '.zip')
    assert sha(archive) == ZIP_SHA
    assert sha(PACKAGE / 'MANIFEST.json') == PACKAGE_MANIFEST_SHA
    package_manifest = json.loads((PACKAGE / 'MANIFEST.json').read_text())
    assert len(package_manifest['files']) == 377
    with zipfile.ZipFile(archive) as zipped:
        expected_names = {f'{PACKAGE.name}/{rel}' for rel in package_manifest['files']} | {f'{PACKAGE.name}/MANIFEST.json', f'{PACKAGE.name}/MANIFEST.sha256'}
        assert set(zipped.namelist()) == expected_names and len(zipped.namelist()) == len(expected_names)
        for rel, item in package_manifest['files'].items():
            path = PACKAGE / rel
            assert sha(path) == item['sha256'] and path.stat().st_size == item['bytes']
            assert zipped.read(f'{PACKAGE.name}/{rel}') == path.read_bytes()
    for rel, digest in inputs.items():
        assert sha(ROOT / rel) == digest
    for absolute, digest in dependencies.items():
        assert sha(pathlib.Path(absolute)) == digest
    assert sha(archive) == ZIP_SHA and sha(PACKAGE / 'MANIFEST.json') == PACKAGE_MANIFEST_SHA
    OUT.mkdir(parents=True)
    for rel, contents in disassembly.items():
        (OUT / rel).write_text(contents)
    result = {
        'status': 'PASS_ARTIFACT_IDENTITY_AND_CPU80_PAIR_SELECTION_PHYSICAL_HOLD',
        'generated_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'selected_candidate_pair': selected,
        'manifest_member_counts_verified': counts,
        'unchanged_frozen_members': 51,
        'candidate_members': 63,
        'copied_source_files': 10,
        'preserved_package': {'path': str(PACKAGE.relative_to(ROOT)), 'zip_sha256': ZIP_SHA, 'manifest_sha256': PACKAGE_MANIFEST_SHA, 'expanded_and_zip_members_verified': 377},
        'bound_inputs': inputs,
        'installed_dependency_sources': dependencies,
        'fresh_disassembly': {rel: sha(OUT / rel) for rel in disassembly},
        'verifier_sha256': sha(pathlib.Path(__file__)),
        'selection_scope': 'Select matched pair for next engineering-review package and first-article testing; existing references/packages preserved.',
        'host_suites_repeated': False,
        'device_flashed': False,
        'complete_USB100_boot_current': 'UNPROVED; ROM, early SDK, reset/download and programming current remain physical gates.',
        'factory_shutdown_semantics': 'Unchanged frozen PN532 loop/blocking semantics. No measured downgrade latency is claimed.',
        'production_authorized': False,
    }
    (OUT / 'review.json').write_text(json.dumps(result, indent=2) + '\n')
    (OUT / 'review.md').write_text(
        '# PN532 CPU80 pair integration review\n\n'
        'Root independently verified all 63 candidate and 51 frozen manifest members, ten identical copied source files, installed dependency source hashes and the supported native-CDC CPU80 build selection. '
        'Fresh disassembly of both actual ELF files confirms the 80 MHz request before Arduino initialization; earlier ESP-IDF startup remains 160 MHz. Both bootloaders are unchanged.\n\n'
        'Select the matched pair together for the next engineering-review package and first-article tests, using each manifest for exact images, hashes and offsets. '
        'The existing 80body-r2 review archive and all 377 expanded/ZIP members were independently checked unchanged. Existing package references remain preserved. '
        'No host suites were repeated and no board was flashed. The frozen PN532 factory loop/blocking behavior is unchanged; measured supply-downgrade latency remains unproved. '
        'Complete USB100 boot/programming current, native USB, simultaneous Wi-Fi/NFC operation and physical factory outcomes remain NOT TESTED; production remains HOLD.\n\n'
        'See [the bound evidence](review.json).\n'
    )
    print(json.dumps({'status': result['status'], 'frozen_members': 51, 'candidate_members': 63, 'unchanged_package_members': 377, 'review_sha256': sha(OUT / 'review.json')}))


if __name__ == '__main__':
    main()
