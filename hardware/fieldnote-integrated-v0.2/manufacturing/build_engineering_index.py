#!/usr/bin/env python3
"""Plan or build a hash-pinned Fieldnote engineering review index.

Default invocation reads and checks the explicit selection template without
writing an index. Writing requires --out plus the full frozen CAD/metadata
hashes. This does not run CAD, simulations, firmware builds or an exporter.
"""
from __future__ import annotations
import argparse
import collections
import datetime as dt
import hashlib
import itertools
import json
from pathlib import Path
import re
import sys

CLASSES = {'CAD', 'conditional_model', 'sensitivity', 'physical_unverified', 'source'}
BANNED = {'.npz', '.zip', '.tar', '.gz', '.bz2', '.xz'}
STATUS = 'REVIEW / HOLD - NOT AUTHORIZED FOR PRODUCTION'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(root, name):
    rel = Path(name)
    if rel.is_absolute() or '..' in rel.parts or rel.as_posix() != name or rel.suffix.lower() in BANNED:
        raise ValueError(f'Unsafe/excluded package evidence path: {name}')
    path = root / rel
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError(f'Symlink/escaping package evidence path: {name}')
    return path


def pointer(document, path):
    if path == '':
        return document
    if not path.startswith('/'):
        raise ValueError(f'JSON pointer must start with slash: {path}')
    value = document
    for item in path[1:].split('/'):
        key = item.replace('~1', '/').replace('~0', '~')
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def validate_part_overlay(read, selection):
    """Check the declared overlay against exact fitted identities and every pair."""
    def document(name):
        return json.loads(read(selection[name]))

    def rows_by_ref(rows, label):
        mapped = {row['ref']: row for row in rows}
        if len(mapped) != len(rows):
            raise ValueError(f'Duplicate references in {label}')
        return mapped

    design = document('design_path')
    fitted = rows_by_ref([part for part in design['parts']
                         if not part.get('dnp', False) and not part['ref'].startswith(('TP', 'ANT'))],
                        'fitted metadata')
    base = rows_by_ref(document('base_path')['parts'], 'base dimensions')
    overlay = rows_by_ref(document('overlay_path')['parts'], 'supplement dimensions')
    native = rows_by_ref(document('native_geometry_path')['footprints'], 'native geometry')
    report = document('review_path')
    reviewed = rows_by_ref(report['all_parts'], 'supplement reviewed parts')
    expected_refs = set(fitted)
    if len(fitted) != selection['required_fitted_count']:
        raise ValueError('Fitted metadata count differs from the declared overlay coverage')
    if set(base) != expected_refs or set(reviewed) != expected_refs:
        raise ValueError('Base/supplement review coverage differs from exact fitted metadata references')
    if set(overlay) != set(selection['expected_overlay_refs']):
        raise ValueError('Supplement overlay references differ from the declared replacement set')
    merged = dict(base, **overlay)
    for ref, row in merged.items():
        part, pose = fitted[ref], native[ref]
        if row['mpn'] != part['mpn'] or row['footprint'] != part['fp'] or row['footprint'] != pose['footprint']:
            raise ValueError(f'Overlay part identity differs from native/metadata: {ref}')
        if row['native_center_board_mm'] != part['xy'] or row['native_center_board_mm'] != pose['center_board_mm']:
            raise ValueError(f'Overlay position differs from native/metadata: {ref}')
        if any(abs((row['native_angle_deg'] - angle + 180) % 360 - 180) > 1e-9
               for angle in [part['angle'], pose['angle_board_deg']]):
            raise ValueError(f'Overlay rotation differs from native/metadata: {ref}')
        if any(reviewed[ref].get(key) != value for key, value in row.items()):
            raise ValueError(f'Supplement review does not preserve the selected dimension/source overlay: {ref}')
        source = row['source']
        if sha(read(source['path'])) != source['sha256']:
            raise ValueError(f'Stale component dimension source: {ref}: {source["path"]}')
    actual_pairs = [tuple(sorted(pair['refs'])) for pair in report['all_pairs']]
    expected_pairs = set(itertools.combinations(sorted(expected_refs), 2))
    if len(actual_pairs) != len(expected_pairs) or set(actual_pairs) != expected_pairs:
        raise ValueError('Supplement pair coverage differs from every unique fitted component pair')
    if any(pair['manufacturer_max_rectangle_overlap_mm2'] != 0 or
           pair['assumed_placement_rectangle_overlap_mm2'] != 0 for pair in report['all_pairs']):
        raise ValueError('Supplement pair inventory contains a component overlap')
    return {'file': selection['review_path'], 'check': 'exact_fitted_dimension_overlay_and_pairs',
            'fitted_references': len(fitted), 'unique_pairs': len(expected_pairs),
            'overlay_references': sorted(overlay), 'status': 'MATCH', 'assembler_approved': False}


def gather(root, template_path, board_hash=None, design_hash=None):
    template_bytes = template_path.read_bytes()
    template = json.loads(template_bytes)
    frozen, records, errors, checks = {}, {}, [], []

    def read(name):
        if name not in frozen:
            frozen[name] = safe_path(root, name).read_bytes()
        return frozen[name]

    def add(name, record, expected=None):
        if record.get('validation_class') not in CLASSES:
            raise ValueError(f'Unknown validation_class for {name}')
        data = read(name)
        actual = sha(data)
        if expected is not None and actual != expected:
            raise ValueError(f'Hash mismatch: {name}; expected {expected}, got {actual}')
        if name not in records:
            records[name] = dict(record, sha256=actual, bytes=len(data))
        return data

    for name, expected in [('fieldnote.kicad_pcb', board_hash), ('design-data.json', design_hash)]:
        try:
            add(name, {'label': 'Frozen native board' if name.endswith('pcb') else 'Frozen design metadata',
                       'validation_class': 'source', 'scope': 'Authoritative source identity'}, expected)
        except (ValueError, OSError) as exc:
            errors.append(str(exc))

    for entry in template['files']:
        name = entry['path']
        try:
            data = add(name, {k: v for k, v in entry.items() if k not in {'path', 'bindings', 'expect', 'check', 'lengths', 'key_sets'}},
                       entry.get('expected_sha256'))
            if any(entry.get(key) for key in ['bindings', 'expect', 'check', 'lengths', 'key_sets']):
                document = json.loads(data)
                for binding in entry.get('bindings', []):
                    expected = sha(read(binding['source_path']))
                    actual = pointer(document, binding['json_pointer'])
                    if actual != expected:
                        raise ValueError(f'Stale source binding: {name} {binding["json_pointer"]} != {binding["source_path"]}')
                    checks.append({'file': name, 'check': 'source_hash_binding', 'source': binding['source_path'], 'status': 'MATCH'})
                for expectation in entry.get('expect', []):
                    actual = pointer(document, expectation['json_pointer'])
                    if actual not in expectation['allowed']:
                        raise ValueError(f'Unexpected review value: {name} {expectation["json_pointer"]}: {actual!r}')
                for expectation in entry.get('lengths', []):
                    actual = len(pointer(document, expectation['json_pointer']))
                    if actual != expectation['expected']:
                        raise ValueError(f'Incomplete evidence coverage: {name} {expectation["json_pointer"]}: {actual}, expected {expectation["expected"]}')
                for expectation in entry.get('key_sets', []):
                    actual = set(pointer(document, expectation['json_pointer']))
                    expected = set(expectation['expected_keys'])
                    if actual != expected:
                        raise ValueError(f'Evidence reference coverage differs: {name} {expectation["json_pointer"]}; missing {sorted(expected-actual)}, extra {sorted(actual-expected)}')
                if entry.get('check') not in {None, 'erc_zero_errors'}:
                    raise ValueError(f'Unknown evidence check: {entry["check"]}')
                if entry.get('check') == 'erc_zero_errors':
                    findings = [v for sheet in document.get('sheets', []) for v in sheet.get('violations', [])]
                    error_count = sum(v.get('severity') == 'error' for v in findings)
                    if error_count:
                        raise ValueError(f'ERC has {error_count} errors: {name}')
                    checks.append({'file': name, 'check': 'ERC', 'error_count': 0, 'warnings': sum(v.get('severity') == 'warning' for v in findings)})
        except (ValueError, OSError, KeyError, TypeError) as exc:
            errors.append(str(exc))

    for selection in template.get('part_overlays', []):
        try:
            checks.append(validate_part_overlay(read, selection))
        except (ValueError, OSError, KeyError, TypeError) as exc:
            errors.append(str(exc))

    manifest_checks = []
    for selection in template.get('manifests', []):
        name = selection['path']
        try:
            data = add(name, {'label': selection['label'], 'validation_class': 'source',
                             'scope': 'Compiled artifact/source hashes; physical operation untested'}, selection.get('expected_sha256'))
            manifest = json.loads(data)
            files = manifest['files']
            if len(files) != selection['required_file_count']:
                raise ValueError(f'Manifest count differs: {name}: {len(files)}')
            for relative, expected in files.items():
                full = (Path(selection['base_directory']) / relative).as_posix()
                add(full, {'label': f'{selection["label"]}: {relative}', 'validation_class': 'source',
                           'scope': 'Frozen manifest member; compiled/source evidence, not hardware test'}, expected)
            manifest_checks.append({'path': name, 'sha256': sha(data), 'verified_file_count': len(files),
                                    'declared_status': manifest.get('status'), 'physical_tested': False})
        except (ValueError, OSError, KeyError, TypeError) as exc:
            errors.append(str(exc))

    # Expand only a named evidence manifest, never an arbitrary result directory.
    for selection in template.get('source_hash_maps', []):
        try:
            report = json.loads(read(selection['report']))
            hashes = pointer(report, selection['json_pointer'])
            for relative, expected in hashes.items():
                name = (Path(selection['base_directory']) / relative).as_posix()
                add(name, {'label': selection['label'] + ': ' + relative, 'validation_class': 'source',
                           'scope': selection['scope']}, expected)
        except (ValueError, OSError, KeyError, TypeError) as exc:
            errors.append(str(exc))

    # Explicit source-document inventories may preserve URL/page/basis metadata.
    for selection in template.get('source_document_lists', []):
        try:
            documents = pointer(json.loads(read(selection['report'])), selection['json_pointer'])
            if not isinstance(documents, list):
                raise ValueError(f'Source-document inventory is not a list: {selection["report"]}')
            for document in documents:
                name = document.get(selection.get('path_key', 'path'))
                if name is None:
                    raise ValueError(f'Missing source-document path: {selection["report"]}')
                data = add(name, {'label': selection['label'] + ': ' + name,
                           'validation_class': selection.get('validation_class', 'source'),
                           'scope': selection['scope'],
                           'declared_source': {key: value for key, value in document.items() if key not in {'path', 'sha256'}}},
                    document['sha256'])
                if 'bytes' in document and len(data) != document['bytes']:
                    raise ValueError(f'Source-document length differs: {name}')
        except (ValueError, OSError, KeyError, TypeError) as exc:
            errors.append(str(exc))

    models = []
    for dependency in template.get('external_model_dependencies', []):
        model = dict(dependency)
        try:
            data = (root / dependency['local_verification_path']).read_bytes()
            actual = sha(data)
            if actual != dependency['sha256']:
                raise ValueError(f'External model changed: {dependency["label"]}')
            model['local_hash_status'] = 'MATCH; verified locally but not included in archive'
        except (ValueError, OSError) as exc:
            errors.append(str(exc))
        models.append(model)

    # Report source-bound input files must be package members too.
    for name in list(frozen):
        if name not in records:
            add(name, {'label': 'Referenced source for evidence binding', 'validation_class': 'source',
                       'scope': 'Source hash used by an explicitly selected report'})
    for name, data in frozen.items():
        try:
            if sha(safe_path(root, name).read_bytes()) != sha(data):
                errors.append(f'Source changed during index capture: {name}')
        except (ValueError, OSError) as exc:
            errors.append(str(exc))
    if template_path.read_bytes() != template_bytes:
        errors.append('Engineering selection template changed during capture')
    result = {'schema_version': 1, 'status': STATUS,
              'created_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
              'selection_template': template_path.relative_to(root).as_posix(),
              'selection_template_sha256': sha(template_bytes),
              'summary': dict(template.get('summary', {}),
                              evidence_hash_validation='MATCH' if not errors else 'INCOMPLETE / STALE',
                              production_authorized=False, physical_bench_validated=False,
                              self_contained_rerunnable=False),
              'profiles': template.get('profiles', []), 'external_model_dependencies': models,
              'manifest_checks': manifest_checks, 'report_binding_checks': checks,
              'files': dict(sorted(records.items()))}
    return result, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--template', type=Path, default=Path(__file__).with_name('engineering-results-selection.json'))
    parser.add_argument('--out', type=Path, help='New root-relative index path; requires frozen hashes and never overwrites')
    parser.add_argument('--frozen-board-sha256')
    parser.add_argument('--frozen-design-sha256')
    args = parser.parse_args()
    root = args.root.resolve(); template = args.template.resolve()
    if not template.is_relative_to(root):
        parser.error('Selection template must be inside the design root')
    if args.out and not all(re.fullmatch(r'[0-9a-f]{64}', x or '') for x in [args.frozen_board_sha256, args.frozen_design_sha256]):
        parser.error('Writing requires full lowercase --frozen-board-sha256 and --frozen-design-sha256')
    result, errors = gather(root, template, args.frozen_board_sha256, args.frozen_design_sha256)
    if not args.out:
        print(json.dumps({'mode': 'PLAN ONLY; no index/export written', 'status': 'READY TO FREEZE' if not errors else 'WAIT FOR FROZEN REPORTS',
                          'selected_file_count': len(result['files']),
                          'class_counts': dict(collections.Counter(r['validation_class'] for r in result['files'].values())),
                          'manifest_checks': result['manifest_checks'], 'external_model_dependencies': result['external_model_dependencies'],
                          'errors': errors}, indent=2))
        return
    if errors:
        print(json.dumps({'status': 'REFUSED; stale/missing evidence', 'errors': errors}, indent=2), file=sys.stderr)
        raise SystemExit(1)
    output = safe_path(root, args.out.as_posix())
    if output.exists():
        parser.error('Immutable index destination exists; choose a new path')
    output.parent.mkdir(parents=True, exist_ok=True)
    # The template and builder are part of the exact selection used to produce the index.
    for path in [template, Path(__file__).resolve()]:
        data = path.read_bytes(); result['files'][path.relative_to(root).as_posix()] = {
            'sha256': sha(data), 'bytes': len(data), 'label': 'Engineering index selection/builder source', 'validation_class': 'source'}
        if path == template and sha(data) != result['selection_template_sha256']:
            raise SystemExit('Selection template changed after capture; no index written')
    with output.open('x', encoding='utf-8') as handle:
        handle.write(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'status': STATUS, 'path': str(output), 'sha256': sha(output.read_bytes()),
                      'selected_files': len(result['files']), 'self_contained_rerunnable': False}, indent=2))


if __name__ == '__main__':
    main()
