#!/usr/bin/env python3
"""Export an immutable PCBWay REVIEW/HOLD snapshot from native KiCad CAD.

No generator/import/refill/save operation is used. Every CLI operation reads the
captured CAD copy, never the working board. Existing destinations are refused.
Python 3.9+ standard library and KiCad 10 CLI are sufficient.

    python3 manufacturing/export_package.py --out /new/package-directory
    python3 manufacturing/export_package.py --review-index output/engineering-results-index.json --out /new/package-directory
    python3 manufacturing/export_package.py --verify /new/package-directory
    python3 manufacturing/export_package.py --verify /new/package-directory.zip
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

STATUS = 'REVIEW / HOLD - NOT AUTHORIZED FOR PRODUCTION'
DNP = {'J2', 'J3', 'J4'}
GERBER_LAYERS = 'F.Cu,In1.Cu,In2.Cu,B.Cu,F.Mask,B.Mask,F.SilkS,B.SilkS,F.Paste,Edge.Cuts'
ASSEMBLY_LAYERS = 'F.Fab,Edge.Cuts'
TOKEN = re.compile(r'\s+|;[^\n]*|\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+')


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def sexpr(text: str):
    """Read KiCad's native S-expression format without loading GUI Python/wx."""
    root, stack, end = [], [], 0
    current = root
    for match in TOKEN.finditer(text):
        if match.start() != end:
            raise ValueError(f'Unrecognized KiCad syntax at offset {end}')
        end = match.end()
        token = match.group()
        if token.isspace() or token.startswith(';'):
            continue
        if token == '(':
            item = []
            current.append(item)
            stack.append(current)
            current = item
        elif token == ')':
            if not stack:
                raise ValueError('Unbalanced KiCad close parenthesis')
            current = stack.pop()
        else:
            current.append(json.loads(token) if token.startswith('"') else token)
    if end != len(text) or stack or len(root) != 1:
        raise ValueError('Incomplete KiCad S-expression')
    return root[0]


def children(node, name):
    return [x for x in node if isinstance(x, list) and x and x[0] == name]


def child(node, name, default=None):
    found = children(node, name)
    return found[0] if found else default


def ref_key(ref):
    match = re.fullmatch(r'([^0-9]+)([0-9]+)', ref)
    return (match[1], int(match[2])) if match else (ref, 0)


def board_inventory(board_bytes: bytes):
    board = sexpr(board_bytes.decode('utf-8'))
    if board[0] != 'kicad_pcb':
        raise ValueError('Input is not a native KiCad PCB')
    footprints, seen = [], set()
    for fp in children(board, 'footprint'):
        properties = {x[1]: x[2] for x in children(fp, 'property')}
        ref = properties.get('Reference', '')
        if not ref:
            legacy = [x for x in children(fp, 'fp_text') if x[1] == 'reference']
            ref = legacy[0][2] if legacy else ''
        if not ref or ref in seen:
            raise ValueError(f'Missing/duplicate native board reference: {ref!r}')
        seen.add(ref)
        attrs = child(fp, 'attr', ['attr'])[1:]
        at = child(fp, 'at')
        layer = child(fp, 'layer')
        if not at or not layer:
            raise ValueError(f'Missing native footprint pose: {ref}')
        pads = children(fp, 'pad')
        pth = [p for p in pads if len(p) > 2 and p[2] == 'thru_hole']
        npth = [p for p in pads if len(p) > 2 and p[2] == 'np_thru_hole']
        excluded = (ref in DNP or ref.startswith('TP') or ref.startswith('ANT')
                    or 'dnp' in attrs or 'exclude_from_bom' in attrs)
        footprints.append({
            'reference': ref, 'value': properties.get('Value', ''),
            'mpn': properties.get('MPN', '').strip(), 'footprint': fp[1],
            'layer': layer[1], 'native_dnp': 'dnp' in attrs,
            'excluded_from_first_batch': excluded,
            'at_mm_native_xy': [float(at[1]), float(at[2])],
            'native_rotation_deg': float(at[3]) if len(at) > 3 else 0.0,
            'plated_through_pad_count': len(pth), 'npth_pad_count': len(npth),
            'plated_through_drills_native': [child(p, 'drill') for p in pth],
            'npth_drills_native': [child(p, 'drill') for p in npth],
            'properties': properties,
        })
    fitted = [p for p in footprints if not p['excluded_from_first_batch']]
    for p in fitted:
        if p['layer'] != 'F.Cu':
            raise ValueError(f'First-batch populated component is not front: {p["reference"]}')
        if not p['mpn']:
            raise ValueError(f'Fitted native component has no exact MPN property: {p["reference"]}')
    j1 = next((p for p in fitted if p['reference'] == 'J1'), None)
    if not j1 or j1['plated_through_pad_count'] != 4 or j1['npth_pad_count'] != 2:
        raise ValueError('J1 must have exactly four PTH shell anchors and two NPTH peg holes')
    if any(not d or d[1] != 'oval' for d in j1['plated_through_drills_native']):
        raise ValueError('J1 shell anchors must be plated slots, not round/NPTH holes')
    for via in children(board, 'via'):
        layers = child(via, 'layers', ['layers'])[1:]
        if layers != ['F.Cu', 'B.Cu'] or any(x in {'micro', 'blind'} for x in via if isinstance(x, str)):
            raise ValueError('Nonstandard blind/buried/microvia found; no HDI permitted')
        drill = child(via, 'drill')
        if not drill or float(drill[1]) < .2 - 1e-9:
            raise ValueError('Native via drill below 0.20 mm is not authorized')
    copper = [x[1] for x in child(board, 'layers', ['layers'])[1:]
              if isinstance(x, list) and len(x) > 1 and x[1].endswith('.Cu')]
    if copper != ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']:
        raise ValueError(f'Expected standard four copper layers, found {copper}')
    general = child(board, 'general', ['general'])
    thickness = child(general, 'thickness', ['thickness', None])[1]
    setup = child(board, 'setup', ['setup'])
    origin = child(setup, 'aux_axis_origin', ['aux_axis_origin', '0', '0'])
    edges = []
    for edge in board:
        if not isinstance(edge, list) or not edge or not edge[0].startswith('gr_'):
            continue
        edge_layer = child(edge, 'layer')
        if edge_layer and edge_layer[1] == 'Edge.Cuts':
            edges.append(edge)
    return {'footprints': sorted(footprints, key=lambda p: ref_key(p['reference'])),
            'copper_layers': copper, 'thickness_mm': float(thickness),
            'aux_origin_mm_native_xy': [float(origin[1]), float(origin[2])],
            'edge_cuts_native': edges, 'zone_count': len(children(board, 'zone')),
            'segment_count': len(children(board, 'segment')),
            'via_count': len(children(board, 'via'))}


def review_index_path(root: Path, requested: Path | None):
    if requested is not None:
        path = requested if requested.is_absolute() else root / requested
        path = path.resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('Explicit --review-index must be an existing file inside the design root')
        return path
    candidates = [p for p in [root / 'engineering-results-index.json',
                              root / 'output' / 'engineering-results-index.json'] if p.is_file()]
    if len(candidates) > 1:
        raise ValueError('Multiple engineering indices exist; select one with --review-index PATH')
    return candidates[0] if candidates else None


def review_index_records(index):
    files = index.get('files')
    if not isinstance(files, dict) or not files:
        raise ValueError('Engineering review index requires a nonempty files map')
    records = {}
    for name, entry in files.items():
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts or relative.as_posix() != name:
            raise ValueError(f'Unsafe engineering review path: {name}')
        record = {'sha256': entry} if isinstance(entry, str) else dict(entry)
        expected = record.get('sha256', '')
        if not isinstance(expected, str) or not re.fullmatch(r'[a-fA-F0-9]{64}', expected):
            raise ValueError(f'Invalid engineering review SHA-256: {name}')
        if relative.suffix.lower() in {'.npz', '.zip', '.tar', '.gz', '.bz2', '.xz'}:
            raise ValueError(f'Raw arrays/vendor bundles are outside the quote review package: {name}')
        record['sha256'] = expected.lower()
        records[name] = record
    return records


def validate_review_index(root: Path, index_path: Path | None, frozen):
    if index_path is None:
        return {'status': 'ABSENT - HOLD; engineering evidence selection incomplete',
                'index_path': None, 'engineering_pass_inferred': False,
                'self_contained_rerunnable': False,
                'physical_bench_validated_by_exporter': False}
    name = index_path.relative_to(root).as_posix()
    index = json.loads(frozen[name])
    records = review_index_records(index)
    for path, record in records.items():
        if path not in frozen or sha(frozen[path]) != record['sha256']:
            raise ValueError(f'Stale/missing engineering evidence: {path}; regenerate the index after review')
    return {'status': 'HASH MATCH - SEE DECLARED REVIEW SCOPE', 'index_path': name,
            'index_sha256': sha(frozen[name]), 'selected_files': records,
            'declared_summary': index.get('summary', {}), 'declared_profiles': index.get('profiles', []),
            'declared_external_model_dependencies': index.get('external_model_dependencies', []),
            'self_contained_rerunnable': False,
            'engineering_pass_inferred': False, 'physical_bench_validated_by_exporter': False}


def selected_inputs(root: Path, board: Path, review_index: Path | None = None):
    paths = {board}
    for path in root.iterdir():
        if path.is_file() and (path.suffix in {'.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_sym'}
                               or path.name in {'design-data.json', 'placement-lock.json',
                                                'source-revision.json', 'fp-lib-table', 'sym-lib-table'}):
            paths.add(path)
    for directory in ['Fieldnote.pretty', 'mechanical', 'manufacturing']:
        for path in (root / directory).rglob('*'):
            if not path.is_file() or '__pycache__' in path.parts:
                continue
            if directory == 'manufacturing' and path.suffix not in {'.md', '.json', '.py'}:
                continue
            if directory == 'mechanical' and path.suffix not in {'.md', '.txt', '.json', '.py', '.stl', '.step', '.svg', '.png'}:
                continue
            paths.add(path)
    for name in ['Box_V17_BRACED_PETG.stl', 'Lid_V17_BRACED_PETG.stl']:
        path = root / 'references' / name
        if path.is_file():
            paths.add(path)
    # Include simulation source for reproduction with its external dependencies;
    # never infer current result files
    # from names or sweep results/vendor-model directories.
    paths.update(p for p in (root / 'simulation').glob('*.py') if p.is_file())
    if review_index is not None:
        paths.add(review_index)
        index = json.loads(review_index.read_text())
        for name in review_index_records(index):
            path = root / name
            if not path.resolve().is_relative_to(root):
                raise ValueError(f'Engineering evidence escapes design root: {name}')
            paths.add(path)
    fw_manifest = root / 'firmware' / 'build-manifest.json'
    if not fw_manifest.is_file():
        raise ValueError('Factory source/build-manifest.json required for this review package')
    fw = json.loads(fw_manifest.read_text())
    paths.add(fw_manifest)
    paths.add(root / 'firmware' / 'factory_test' / 'factory_test.ino')
    for name in fw.get('files', {}):
        path = (root / 'firmware' / name).resolve()
        if not path.is_relative_to(root / 'firmware'):
            raise ValueError(f'Unsafe factory manifest relative path: {name}')
        paths.add(path)
    return sorted(paths, key=lambda p: p.relative_to(root).as_posix())


def capture(root: Path, paths):
    frozen = {}
    for path in paths:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Missing or symlink source input: {path}')
        frozen[path.relative_to(root).as_posix()] = path.read_bytes()
    # Fail rather than package a mixture of revisions during concurrent writes.
    for name, data in frozen.items():
        if sha((root / name).read_bytes()) != sha(data):
            raise ValueError(f'Source changed during snapshot; retry once frozen: {name}')
    return frozen


def csv_write(path: Path, columns, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


def validate_firmware(frozen):
    manifest = json.loads(frozen['firmware/build-manifest.json'])
    failures = []
    for name, expected in manifest.get('files', {}).items():
        actual = sha(frozen.get('firmware/' + name, b''))
        if actual != expected:
            failures.append({'path': name, 'expected_sha256': expected, 'actual_sha256': actual})
    return {'status': 'MATCH' if not failures else 'HOLD - FILE HASH MISMATCH',
            'build_status': manifest.get('status'), 'hash_failures': failures,
            'hardware_tested': False, 'module_compatibility': manifest.get('module_compatibility')}


def source_parity(inventory, design):
    native = {x['reference']: x for x in inventory['footprints']}
    differences = []
    for part in design['parts']:
        ref = part['ref']
        actual = native.get(ref)
        if actual is None:
            differences.append({'reference': ref, 'issue': 'missing native footprint'})
            continue
        for field, native_field in [('mpn', 'mpn'), ('value', 'value')]:
            if part.get(field, '') != actual[native_field]:
                differences.append({'reference': ref, 'field': field,
                                    'metadata': part.get(field, ''), 'native': actual[native_field]})
        if bool(part.get('dnp', False)) != actual['native_dnp']:
            differences.append({'reference': ref, 'issue': 'native/metadata DNP attribute differs',
                                'metadata_dnp': bool(part.get('dnp', False)), 'native_dnp': actual['native_dnp']})
        expected_exclusion = bool(part.get('dnp', False)) or ref.startswith('TP') or ref.startswith('ANT')
        if expected_exclusion != actual['excluded_from_first_batch']:
            differences.append({'reference': ref, 'issue': 'native population differs from frozen metadata'})
        if ref in DNP and not part.get('dnp', False):
            differences.append({'reference': ref, 'issue': 'required metadata DNP absent'})
    extra = set(native) - {p['ref'] for p in design['parts']}
    differences.extend({'reference': ref, 'issue': 'native reference absent from metadata'} for ref in sorted(extra))
    return {'status': 'MATCH' if not differences else 'HOLD - METADATA/NATIVE MISMATCH',
            'differences': differences, 'authoritative_export_source': 'snapshot native PCB'}


def run_cli(cli, args, stage, commands, expected_codes=(0,)):
    command = [str(cli)] + [str(x) for x in args]
    result = subprocess.run(command, cwd=stage / 'source' / 'design',
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    command_record = {'argv': [str(x).replace(str(stage), '${PACKAGE}') for x in command],
                      'returncode': result.returncode, 'output': result.stdout}
    commands.append(command_record)
    if result.returncode not in expected_codes:
        raise RuntimeError(f'KiCad command failed ({result.returncode}): {command_record}')


def write_bom(stage, fitted, sourcing):
    known = {p['design_mpn']: p for p in sourcing.get('previous_parts', []) + sourcing.get('parts', [])}
    grouped = collections.defaultdict(list)
    for part in fitted:
        grouped[(part['mpn'], part['footprint'])].append(part)
    rows = []
    for (mpn, fp), group in sorted(grouped.items(), key=lambda item: ref_key(min(p['reference'] for p in item[1]))):
        value = '; '.join(sorted({part['value'] for part in group}))
        evidence = known.get(mpn, {})
        if not evidence.get('manufacturer'):
            raise ValueError(f'Manufacturer missing from reconciled sourcing.json for native MPN: {mpn}')
        rows.append({'Designator': ','.join(sorted((p['reference'] for p in group), key=ref_key)),
                     'Quantity': len(group), 'Quantity_2_Boards': len(group) * 2,
                     'Manufacturer': evidence['manufacturer'], 'MPN': evidence.get('supplier_mpn', mpn),
                     'Value': value, 'Footprint': fp, 'Side': 'Top',
                     'DNP': 'No', 'Supplier_URL': evidence.get('supply_snapshot', {}).get('url', '')})
    csv_write(stage / 'assembly' / 'BOM-fitted-two-boards.csv', list(rows[0]), rows)
    excluded = [p for p in board_inventory((stage / 'source' / 'design' / 'fieldnote.kicad_pcb').read_bytes())['footprints']
                if p['excluded_from_first_batch']]
    write_json(stage / 'assembly' / 'population-summary.json', {
        'status': STATUS, 'physical_components_per_board': len(fitted),
        'unique_grouped_bom_lines': len(rows), 'assembled_boards': 2, 'bare_boards': 5,
        'excluded_references': [p['reference'] for p in excluded],
        'battery_included': False, 'J1_note': 'One hybrid connector; include SMT contacts plus four PTH shell anchors, not two purchased components.'})


def filter_positions(stage, inventory):
    fitted = {p['reference']: p for p in inventory['footprints'] if not p['excluded_from_first_batch']}
    raw = stage / 'assembly' / 'positions-native-front-all.csv'
    with raw.open(newline='', encoding='utf-8') as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames
        if not columns or 'Ref' not in columns:
            raise ValueError(f'Unexpected KiCad position header: {columns}')
        rows = [row for row in reader if row['Ref'] in fitted]
    actual = [row['Ref'] for row in rows]
    if len(actual) != len(set(actual)) or set(actual) != set(fitted):
        raise ValueError(f'Native front-position references disagree: missing={set(fitted)-set(actual)}, extra={set(actual)-set(fitted)}')
    for row in rows:
        part = fitted[row['Ref']]
        x, y = part['at_mm_native_xy']
        if abs(float(row['PosX']) - x) > 0.0001 or abs(float(row['PosY']) + y) > 0.0001:
            raise ValueError(f'Unexpected native position origin/sign convention for {row["Ref"]}')
        if row['Side'].lower() not in {'top', 'front'}:
            raise ValueError(f'Unexpected placement side: {row}')
    rows.sort(key=lambda row: ref_key(row['Ref']))
    csv_write(stage / 'assembly' / 'positions-fitted-front.csv', columns, rows)
    raw.unlink()  # The unfiltered intermediate must not be submitted by accident.
    dnp_names = ', '.join(sorted(p['reference'] for p in inventory['footprints']
                                if p['native_dnp'] or p['reference'] in DNP))
    (stage / 'assembly' / 'position-conventions.md').write_text(
        '# Position conventions\n\nNative KiCad CLI front CSV; millimeters; absolute KiCad coordinate origin (0,0); '
        '+X right and exported +Y upward (native editor Y is downward). No bottom mirroring or manual rotation correction. '
        'Gerbers and drills use the same absolute origin. Rotations are the native KiCad position-file rotations. '
        'The assembler must visually verify pin 1, polarity and its importer rotation convention against the assembly drawing. '
        f'J1 is retained despite its PTH anchors. DNP: {dnp_names}. These references, TP* and ANT* are excluded.\n', encoding='utf-8')


def assembly_plot_copy(native_bytes, path):
    """Make a legible Fab-only drawing; preserve all physical geometry."""
    text = native_bytes.decode('utf-8')
    value_fields = list(re.finditer(r'(\(property\s+"Value"\s+"(?:\\.|[^"\\])*")', text))
    edits = 0
    for match in reversed(value_fields):
        depth, end = 0, None
        for token in TOKEN.finditer(text, match.start()):
            if token.group() == '(':
                depth += 1
            elif token.group() == ')':
                depth -= 1
                if depth == 0:
                    end = token.end()
                    break
        if end is None:
            raise ValueError('Unbalanced native value property')
        if not re.search(r'\(hide\s+yes\)', text[match.start():end]):
            text = text[:match.end()] + '\n\t\t\t(hide yes)' + text[match.end():]
            edits += 1
    additions = []
    # Several stock footprints lack a Fab reference. Add a visualization-only
    # label at their native origin, so every fitted component is identified.
    for match in reversed(list(re.finditer(r'\(footprint\s+"(?:\\.|[^"\\])*"', text))):
        depth, end = 0, None
        for token in TOKEN.finditer(text, match.start()):
            if token.group() == '(':
                depth += 1
            elif token.group() == ')':
                depth -= 1
                if depth == 0:
                    end = token.end()
                    break
        fp = sexpr(text[match.start():end])
        properties = {p[1]: p[2] for p in children(fp, 'property')}
        ref = properties.get('Reference', '')
        if ref.startswith(('TP', 'ANT')):
            continue
        fab_refs = [t for t in children(fp, 'fp_text')
                    if len(t) > 2 and t[2] in {'${REFERENCE}', ref}
                    and child(t, 'layer', ['', ''])[1] == 'F.Fab']
        if fab_refs:
            continue
        size = .7 if ref.startswith('U') else 1.0 if ref == 'J1' else .4
        label = ('\n\t\t(fp_text user ' + json.dumps(ref) +
                 f' (at 0 0 0) (layer "F.Fab") (effects (font (size {size} {size}) (thickness {size * .15:g}))))')
        text = text[:end - 1] + label + text[end - 1:]
        additions.append(label.encode('utf-8'))
    derived = text.encode('utf-8')
    if board_inventory(derived) != board_inventory(native_bytes):
        raise ValueError('Assembly visibility-only copy changed native inventory/geometry counts')
    # Reversing only these display edits must restore the exact original bytes.
    restored = derived
    for label in additions:
        restored = restored.replace(label, b'', 1)
    if restored.replace(b'\n\t\t\t(hide yes)', b'') != native_bytes.replace(b'\n\t\t\t(hide yes)', b''):
        raise ValueError('Unexpected physical/source edit in assembly plot copy')
    path.write_bytes(derived)
    return {'purpose': 'assembly visualization only, not fabrication input',
            'value_fields_hidden': edits, 'missing_fab_references_added': len(additions),
            'silkscreen_omitted_from_assembly_drawing': True,
            'original_board_sha256': sha(native_bytes),
            'plot_copy_sha256': sha(derived), 'physical_geometry_unchanged': True}


def drc_summary(path):
    data = json.loads(path.read_text())
    entries = []
    lists = {}
    for name, value in data.items():
        if isinstance(value, list):
            lists[name] = len(value)
            if name in {'violations', 'unconnected_items', 'schematic_parity'}:
                entries.extend(x for x in value if isinstance(x, dict))
    severities = collections.Counter(x.get('severity', 'unspecified') for x in entries)
    blockers = sum(severities.get(s, 0) for s in ['error', 'unspecified'])
    return {'status': 'HOLD - FINDINGS PRESENT' if entries else 'NO REPORTED FINDINGS; PRODUCTION STILL HOLD',
            'report_list_counts': lists, 'severity_counts': dict(severities),
            'cad_error_status': 'ZERO REPORTED ERRORS' if blockers == 0 else 'ERRORS PRESENT',
            'error_or_unspecified_count': blockers,
            'ignored_check_count': lists.get('ignored_checks', 0),
            'ignored_checks_require_engineering_review': bool(lists.get('ignored_checks', 0)),
            'native_schematic_parity_requested': True, 'zones_refilled_by_exporter': False,
            'board_saved_by_exporter': False}


def manifest_records(stage):
    return {p.relative_to(stage).as_posix(): {'sha256': sha(p.read_bytes()), 'bytes': p.stat().st_size}
            for p in sorted(stage.rglob('*')) if p.is_file()
            and p.relative_to(stage).as_posix() not in {'MANIFEST.json', 'MANIFEST.sha256'}}


def verify(path: Path):
    if path.is_dir():
        read = lambda name: (path / name).read_bytes()
        actual_names = {p.relative_to(path).as_posix() for p in path.rglob('*') if p.is_file()}
        closer = None
    else:
        archive = zipfile.ZipFile(path)
        roots = {n.split('/')[0] for n in archive.namelist()}
        if len(roots) != 1 or archive.testzip() is not None:
            raise ValueError('Invalid review archive')
        prefix = next(iter(roots)) + '/'
        read = lambda name: archive.read(prefix + name)
        actual_names = {n[len(prefix):] for n in archive.namelist()}
        closer = archive
    try:
        manifest_bytes = read('MANIFEST.json')
        expected_manifest_hash = read('MANIFEST.sha256').decode().split()[0]
        if sha(manifest_bytes) != expected_manifest_hash:
            raise ValueError('Manifest self-check failed')
        manifest = json.loads(manifest_bytes)
        expected_names = set(manifest['files']) | {'MANIFEST.json', 'MANIFEST.sha256'}
        if actual_names != expected_names:
            raise ValueError(f'Package files changed: extra={actual_names-expected_names}, missing={expected_names-actual_names}')
        for name, record in manifest['files'].items():
            if Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError(f'Unsafe manifest file path: {name}')
            data = read(name)
            if len(data) != record['bytes'] or sha(data) != record['sha256']:
                raise ValueError(f'Package hash mismatch: {name}')
        return {'status': manifest['status'], 'verified_files': len(manifest['files']),
                'manifest_sha256': sha(manifest_bytes), 'path': str(path)}
    finally:
        if closer:
            closer.close()


def export(args):
    root = args.root.resolve()
    board = (root / 'fieldnote.kicad_pcb').resolve()
    output = args.out.resolve()
    archive_path = output.with_name(output.name + '.zip')
    archive_hash_path = archive_path.with_name(archive_path.name + '.sha256')
    if output.exists() or archive_path.exists() or archive_hash_path.exists():
        raise ValueError('Immutable destination already exists; choose a new --out directory')
    cli = args.kicad_cli or shutil.which('kicad-cli')
    if not cli:
        candidate = Path('/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
        cli = str(candidate) if candidate.is_file() else None
    if not cli:
        raise ValueError('KiCad CLI missing; pass --kicad-cli /path/to/kicad-cli')
    index_path = review_index_path(root, args.review_index)
    paths = selected_inputs(root, board, index_path)
    frozen = capture(root, paths)
    engineering = validate_review_index(root, index_path, frozen)
    if args.plan_only:
        print(json.dumps({'status': STATUS, 'source_inputs': [str(p.relative_to(root)) for p in paths],
                          'out': str(output), 'gerber_layers': GERBER_LAYERS,
                          'engineering_review_index': engineering}, indent=2))
        return
    inventory = board_inventory(frozen['fieldnote.kicad_pcb'])
    fitted = [p for p in inventory['footprints'] if not p['excluded_from_first_batch']]
    design = json.loads(frozen['design-data.json'])
    sourcing = json.loads(frozen['manufacturing/sourcing.json'])
    if sourcing.get('source_design', {}).get('sha256') != sha(frozen['design-data.json']):
        raise ValueError('sourcing.json is stale relative to design-data.json; reconcile it before exporting')
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.' + output.name + '-staging-', dir=output.parent))
    commands = []
    try:
        for name, data in frozen.items():
            target = stage / 'source' / 'design' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        for directory in ['fabrication/gerbers', 'fabrication/drills', 'assembly', 'checks']:
            (stage / directory).mkdir(parents=True, exist_ok=True)
        native = stage / 'source' / 'design' / 'fieldnote.kicad_pcb'
        version = subprocess.check_output([str(cli), 'version'], text=True).strip()
        write_json(stage / 'checks' / 'native-inventory.json', inventory)
        write_json(stage / 'checks' / 'engineering-evidence-index-check.json', engineering)
        parity = source_parity(inventory, design)
        write_json(stage / 'checks' / 'native-metadata-parity.json', parity)
        fw_check = validate_firmware(frozen)
        write_json(stage / 'checks' / 'factory-firmware-manifest-check.json', fw_check)
        run_cli(cli, ['pcb', 'drc', '--format', 'json', '--severity-all', '--schematic-parity',
                      '--output', stage / 'checks' / 'native-drc-parity.json', native], stage, commands)
        drc = drc_summary(stage / 'checks' / 'native-drc-parity.json')
        write_json(stage / 'checks' / 'native-drc-summary.json', drc)
        run_cli(cli, ['pcb', 'export', 'gerbers', '--layers', GERBER_LAYERS,
                      '--no-protel-ext', '--subtract-soldermask', '--output',
                      str(stage / 'fabrication' / 'gerbers') + '/', native], stage, commands)
        run_cli(cli, ['pcb', 'export', 'drill', '--format', 'excellon', '--drill-origin', 'absolute',
                      '--excellon-units', 'mm', '--excellon-zeros-format', 'decimal',
                      '--excellon-oval-format', 'route', '--excellon-separate-th',
                      '--generate-map', '--map-format', 'svg', '--generate-report',
                      '--report-path', stage / 'fabrication' / 'drills' / 'drill-report.txt',
                      '--output', str(stage / 'fabrication' / 'drills') + '/', native], stage, commands)
        run_cli(cli, ['pcb', 'export', 'pos', '--side', 'front', '--format', 'csv', '--units', 'mm',
                      '--output', stage / 'assembly' / 'positions-native-front-all.csv', native], stage, commands)
        filter_positions(stage, inventory)
        write_bom(stage, fitted, sourcing)
        plot_copy = stage / 'checks' / 'assembly-visibility-only.kicad_pcb'
        write_json(stage / 'checks' / 'assembly-visibility-changes.json',
                   assembly_plot_copy(frozen['fieldnote.kicad_pcb'], plot_copy))
        run_cli(cli, ['pcb', 'export', 'svg', '--mode-single', '--layers', ASSEMBLY_LAYERS,
                      '--page-size-mode', '2', '--exclude-drawing-sheet', '--black-and-white',
                      '--crossout-DNP-footprints-on-fab-layers',
                      '--output', stage / 'assembly' / 'assembly-front-review.svg', plot_copy], stage, commands)
        run_cli(cli, ['pcb', 'export', 'pdf', '--mode-single', '--layers', ASSEMBLY_LAYERS,
                      '--black-and-white',
                      '--crossout-DNP-footprints-on-fab-layers', '--no-property-popups', '--scale', '0',
                      '--output', stage / 'assembly' / 'assembly-front-review.pdf', plot_copy], stage, commands)
        # Separate pad-number plots preserve polarity/pin-1 evidence without
        # cluttering the component-reference drawing.
        run_cli(cli, ['pcb', 'export', 'svg', '--mode-single', '--layers', ASSEMBLY_LAYERS,
                      '--page-size-mode', '2', '--exclude-drawing-sheet', '--black-and-white',
                      '--sketch-pads-on-fab-layers', '--crossout-DNP-footprints-on-fab-layers',
                      '--output', stage / 'assembly' / 'assembly-front-pad-map.svg', plot_copy], stage, commands)
        run_cli(cli, ['pcb', 'export', 'pdf', '--mode-single', '--layers', ASSEMBLY_LAYERS,
                      '--black-and-white', '--sketch-pads-on-fab-layers',
                      '--crossout-DNP-footprints-on-fab-layers', '--no-property-popups', '--scale', '0',
                      '--output', stage / 'assembly' / 'assembly-front-pad-map.pdf', plot_copy], stage, commands)
        # KiCad CLI must not alter even its snapshot copy.
        for name, data in frozen.items():
            if (stage / 'source' / 'design' / name).read_bytes() != data:
                raise ValueError(f'CLI changed a captured source input: {name}')
        gerbers = list((stage / 'fabrication' / 'gerbers').glob('*.gbr'))
        drills = list((stage / 'fabrication' / 'drills').glob('*.drl'))
        if len(gerbers) != len(GERBER_LAYERS.split(',')) or len(drills) < 2:
            raise ValueError(f'Incomplete plotted layers/drills: {len(gerbers)} Gerbers, {len(drills)} drill files')
        specs = {'status': STATUS, 'fabricated_boards': 5, 'assembled_boards': 2,
                 'return_bare_boards': 3, 'material': 'standard FR-4', 'layer_order': inventory['copper_layers'],
                 'thickness_mm_nominal': 1.6, 'copper_oz': 1, 'soldermask': 'green', 'silkscreen': 'white',
                 'finish': 'lead-free HASL cost comparison; SMT review required; price ENIG separately if required',
                 'assembly_side': 'front/top only', 'minimum_track_clearance_mm': .15,
                 'ordinary_via_pad_hole_mm': [.6, .3], 'local_PN_via_pad_hole_mm': [.5, .2],
                 'minimum_annular_ring_mm': .15, 'blind_buried_HDI': False, 'filled_capped_vias': False,
                 'thermal_vias': {'U3': {'count': 2, 'hole_mm': .3}, 'U2': {'count': 4, 'hole_mm': .3},
                                  'intent': 'ordinary plated through, back tented; front paste windows avoid holes; assembler review required'},
                 'J1': 'four PTH shell slots and two NPTH locating holes; verify exact drawing and drill maps',
                 'dnp_references': sorted(p['reference'] for p in inventory['footprints'] if p['native_dnp'] or p['reference'] in DNP), 'battery_included': False,
                 'origin': 'absolute KiCad (0,0); mm; no manual offsets',
                 'power_bench_validation_pending': True,
                 'engineering_evidence_index': engineering['index_path'],
                 'model_validation_scope': 'Conditional/profile-based; consult the indexed evidence, including failure sensitivities',
                 'review_required': ['physical power/NFC bench qualification of conditional model results', 'native DRC + schematic parity and metadata match', 'Gerber/drill/paste/mask visual review',
                                     'PCBWay stock/overage/stackup/0.20 mm drill acceptance', 'placement orientation/stencil/tenting review',
                                     'concrete itemized quote and production authorization']}
        write_json(stage / 'fabrication' / 'fabrication-specs.json', specs)
        dnp_names = ', '.join(specs['dnp_references'])
        (stage / 'fabrication' / 'fabrication-specs.md').write_text(
            '# Fabrication specification - REVIEW/HOLD\n\n' +
            'Five bare / two front-assembled / three returned bare. Four layers, standard FR-4, 1.6 mm nominal, '
            '1 oz, green mask and white silkscreen. Lead-free HASL comparison requires SMT suitability review; '
            'price ENIG separately if required. Native Edge.Cuts is authoritative. Minimum track/clearance 0.15 mm; '
            'normal via 0.60/0.30 mm, local PN532 via 0.50/0.20 mm with 0.15 mm annular ring. '
            'Separate PTH/NPTH Excellon files use mm and absolute origin; J1 has four plated shell slots and two nonplated peg holes. '
            'U3 two and U2 four 0.30 mm ordinary thermal vias are intended back tented and unfilled/uncapped, '
            'with front paste windows avoiding holes. Require assembler stencil/tenting review. '
            f'No battery; DNP: {dnp_names}. Detailed engineering instructions are in source/design/manufacturing/assembly-spec.md.\n', encoding='utf-8')
        write_json(stage / 'checks' / 'export-commands.json', {'kicad_version': version, 'commands': commands})
        (stage / 'README-REVIEW-HOLD.md').write_text(
            '# Fieldnote PCBWay review package\n\n**' + STATUS + '**\n\n'
            f'Plan: five fabricated bare boards, two assembled, three returned bare. No battery; DNP: {dnp_names}. '
            'Gerbers/drills/positions are generated from the exact captured native board; BOM uses its MPN properties. '
            'Assembly drawings use Fab outlines and a visualization-only copied board with values hidden and missing Fab references added; '
            'physical geometry, poses and net data are unchanged and the copy/change record is in checks/. '
            'The separate front pad maps show pad numbers for pin-1 and polarity review. '
            'The working CAD was neither rebuilt nor saved. Source CAD, mechanical prototypes and factory firmware/source/manifest '
            'are under source/design/. Mechanical files are physically untested prototypes, not an order for cases.\n\n'
            'Review checks/native-drc-summary.json, checks/native-drc-parity.json and checks/native-metadata-parity.json. '
            'Even zero CAD errors do not authorize production. checks/engineering-evidence-index-check.json records the exact selected evidence and its hash agreement. '
            'Engineering results retain their declared CAD-check, conditional-model and sensitivity scope; model passes apply only to their labelled profiles and assumptions. '
            'The archive is not self-contained for simulation reproduction: obtain the external TI model from its indexed official URL, verify its hash, '
            'and provide the documented model paths and ngspice/NumPy/KiCad toolchains. Raw model/vendor bundles are not included. '
            'The exporter infers no engineering pass from file names or matching hashes. Physical power/NFC bench qualification remains a release gate. '
            'Review copper/antenna geometry, plated USB slots, NPTH pegs, '
            'paste apertures, tenting, exact part sourcing/overage, supplier stackup and imported placement rotations. '
            'Factory firmware has not been tested on physical boards. PCBWay review, a concrete quote and user production approval remain outstanding.\n\n'
            'Do not edit this package. Change the original design and export to a new directory. '
            'Run manufacturing/export_package.py --verify PATH against this directory or ZIP to detect any changed, missing or extra files. '
            'MANIFEST.sha256 checks MANIFEST.json integrity; its file hashes cover every other file. '
            'The sibling ZIP.sha256 covers the complete transport archive. Hashes establish identity, not engineering correctness.\n', encoding='utf-8')
        manifest = {'schema_version': 1, 'status': STATUS, 'created_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                    'kicad_version': version, 'batch': {'bare': 5, 'assembled': 2},
                    'authoritative_board_sha256': sha(frozen['fieldnote.kicad_pcb']),
                    'source_input_sha256': {name: sha(data) for name, data in frozen.items()},
                    'native_drc_summary': drc, 'native_metadata_parity': parity['status'],
                    'engineering_evidence_index_check': engineering,
                    'factory_firmware_hash_check': fw_check['status'],
                    'production_authorized': False, 'external_quote_requested': False,
                    'files': manifest_records(stage)}
        write_json(stage / 'MANIFEST.json', manifest)
        (stage / 'MANIFEST.sha256').write_text(sha((stage / 'MANIFEST.json').read_bytes()) + '  MANIFEST.json\n')
        verify(stage)
        with zipfile.ZipFile(archive_path, 'x', zipfile.ZIP_DEFLATED, compresslevel=7) as archive:
            for path in sorted(stage.rglob('*')):
                if path.is_file():
                    info = zipfile.ZipInfo(output.name + '/' + path.relative_to(stage).as_posix(), (2000, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o100444 << 16
                    archive.writestr(info, path.read_bytes())
        verify(archive_path)
        archive_hash_path.write_text(sha(archive_path.read_bytes()) + '  ' + archive_path.name + '\n')
        stage.rename(output)
        for path in output.rglob('*'):
            if path.is_file():
                path.chmod(0o444)
        print(json.dumps({'status': STATUS, 'directory': str(output), 'zip': str(archive_path),
                          'zip_sha256': sha(archive_path.read_bytes()), 'files': len(manifest['files']),
                          'fitted_components_per_board': len(fitted), 'native_metadata_parity': parity['status'],
                          'native_drc_summary': drc}, indent=2))
    except Exception:
        write_json(stage / 'EXPORT-FAILED.json', {'status': 'FAILED - DO NOT SUBMIT', 'commands': commands})
        print(f'Export failed; diagnostic staging files preserved at {stage}', file=sys.stderr)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--out', type=Path, help='New immutable package directory; never overwritten')
    parser.add_argument('--kicad-cli', type=Path)
    parser.add_argument('--review-index', type=Path,
                        help='Require this hash-pinned engineering index; otherwise auto-detect root/output engineering-results-index.json')
    parser.add_argument('--plan-only', action='store_true')
    parser.add_argument('--verify', type=Path, help='Verify directory or ZIP hashes; does not export')
    args = parser.parse_args()
    if args.verify:
        print(json.dumps(verify(args.verify.resolve()), indent=2))
    elif args.out:
        export(args)
    else:
        parser.error('--out NEW_DIRECTORY or --verify EXISTING_PACKAGE is required')


if __name__ == '__main__':
    main()
