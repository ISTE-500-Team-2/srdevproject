#!/usr/bin/env python3
"""Capture PN7160 v0.3 native exports for engineering review, always production HOLD.

Reads the pinned saved-fill native candidate. It never calls a generator,
refill, native CAD save, upload or order. A later complete evidence archive
requires an explicit hash-pinned review index; native-only snapshots do not
claim power/firmware/physical qualification. Python 3.9+ and KiCad CLI required.
"""
from __future__ import annotations
import argparse, collections, csv, datetime as dt, hashlib, io, json, os
from pathlib import Path
import re, shutil, subprocess, sys, tempfile, zipfile
STATUS = 'PN7160 v0.3 ENGINEERING REVIEW / PRODUCTION HOLD'
DNP = {'J2','J3','J4'}
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

def csv_write(path: Path, columns, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)

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

CANDIDATE = 'output/native-review-candidate-v3'
TABLES = 'manufacturing/assembly-tables-v3'
PINS = {
    CANDIDATE+'/native-freeze-manifest.json': '2764ef4bce57fea4233ece075bda8425562d22c8203e95d9236659ba0ad0c028',
    TABLES+'/assembly-tables-manifest.json': 'dc3a5471cf9d6a396eff7fb2bfcbaf9bd7196efcddb2348b15d468a3d43f2310',
    'manufacturing/v03-placement-clearance-manifest.json': '07ef67334a61232f7f7c00ee688fef829e6431b18dbfb4973a6347357c843d77',
}

def checked_path(root, name):
    rel=Path(name)
    if rel.is_absolute() or '..' in rel.parts or rel.as_posix()!=name:
        raise ValueError('Unsafe evidence path: '+name)
    p=root/rel
    if p.is_symlink() or not p.resolve().is_relative_to(root):
        raise ValueError('Escaping evidence path: '+name)
    return p


def collect(root, index_path=None):
    frozen={}
    def capture(name, expected=None, size=None):
        data=checked_path(root,name).read_bytes()
        if expected and sha(data)!=expected:raise ValueError('Stale pinned input: '+name)
        if size is not None and len(data)!=size:raise ValueError('Input length differs: '+name)
        if name in frozen and data!=frozen[name]:raise ValueError('Input changed during capture: '+name)
        frozen[name]=data
        return data
    native_manifest=json.loads(capture(CANDIDATE+'/native-freeze-manifest.json',PINS[CANDIDATE+'/native-freeze-manifest.json']))
    if len(native_manifest['files'])!=61:raise ValueError('Native freeze must contain exactly61 members')
    for row in native_manifest['files']:capture(CANDIDATE+'/'+row['path'],row['sha256'],row['size'])
    tables=json.loads(capture(TABLES+'/assembly-tables-manifest.json',PINS[TABLES+'/assembly-tables-manifest.json']))
    if tables['fitted_refs']!=78 or tables['grouped_exact_mpns']!=42 or tables['position_origin_mm']!=[0,0] or not tables['position_y_negated_from_native']:
        raise ValueError('Unexpected fitted table counts or position convention')
    for row in tables['files']:capture(TABLES+'/'+row['path'],row['sha256'])
    body=json.loads(capture('manufacturing/v03-placement-clearance-manifest.json',PINS['manufacturing/v03-placement-clearance-manifest.json']))
    for n in ['manufacturing/v03-placement-clearance-review.json','manufacturing/v03-placement-clearance-dimensions.json']:
        row=next(x for x in body['files'] if x['path']==n);capture(n,row['sha256'],row['bytes'])
    for n in ['manufacturing/assembly-spec-PN7160.md', 'manufacturing/export_pn7160_review.py']:
        capture(n)
    review={'status':'NATIVE_EXPORT_ONLY_FULL_ENGINEERING_POWER_ARCHIVE_PENDING','full_review_index_included':False,'physical_qualified':False}
    if index_path:
        name=index_path.relative_to(root).as_posix();idx=json.loads(capture(name));files=idx['files']
        if not isinstance(files,dict) or not files:raise ValueError('Review index requires a nonempty exact files map')
        for n,row in files.items():
            if Path(n).suffix.lower() in {'.npz','.zip','.tar','.gz','.bz2','.xz'}:raise ValueError('Raw/model archives are not evidence members: '+n)
            capture(n,row if isinstance(row,str) else row['sha256'])
        review={'status':'EXPLICIT_ENGINEERING_INDEX_HASH_MATCH_PRODUCTION_HOLD','index_path':name,'index_sha256':sha(frozen[name]),'indexed_files':len(files),'full_review_index_included':True,'physical_qualified':False,'declared_summary':idx.get('summary',{})}
    return frozen,native_manifest,tables,review


def validate_tables(frozen, inventory):
    fitted={p['reference']:p for p in inventory['footprints'] if not p['excluded_from_first_batch']}
    if len(fitted)!=78 or len({p['mpn'] for p in fitted.values()})!=42:raise ValueError('Native fitted population must be78 references/42 exact MPNs')
    grouped=list(csv.DictReader(io.StringIO(frozen[TABLES+'/BOM-assembled-grouped.csv'].decode())))
    refs=[]
    for row in grouped:
        designators=row['Designators'].split(',');refs.extend(designators)
        if len(designators)!=int(row['Quantity']):raise ValueError('Grouped BOM quantity differs')
        for ref in designators:
            if fitted[ref]['mpn']!=row['Manufacturer Part Number']:raise ValueError('Grouped exact MPN differs: '+ref)
    if len(refs)!=78 or len(set(refs))!=78 or set(refs)!=set(fitted) or len(grouped)!=42:raise ValueError('Grouped BOM reference coverage differs')
    rows=list(csv.DictReader(io.StringIO(frozen[TABLES+'/CPL-assembled-native.csv'].decode())))
    if len(rows)!=78 or {r['Ref'] for r in rows}!=set(fitted):raise ValueError('Accepted native CPL reference coverage differs')
    for row in rows:
        p=fitted[row['Ref']];x,y=p['at_mm_native_xy']
        if abs(float(row['PosX'])-x)>1e-6 or abs(float(row['PosY'])+y)>1e-6 or abs((float(row['Rot'])-p['native_rotation_deg']+180)%360-180)>1e-6 or row['Side']!='top':raise ValueError('Accepted CPL pose differs: '+row['Ref'])
    return fitted


def export(args):
    root=args.root.resolve();output=args.out.resolve();index=args.review_index.resolve() if args.review_index else None
    if not output.is_relative_to(root/'output'):raise ValueError('New package destination must be under v0.3 output/')
    for p in [output,Path(str(output)+'.zip'),Path(str(output)+'.zip.sha256')]:
        if p.exists():raise ValueError('Immutable destination exists: '+str(p))
    if index and not index.is_relative_to(root):raise ValueError('Review index must belong to v0.3')
    frozen,native_manifest,tables,review=collect(root,index)
    native_bytes=frozen[CANDIDATE+'/fieldnote.kicad_pcb'];inventory=board_inventory(native_bytes)
    design=json.loads(frozen[CANDIDATE+'/design-data.json']);parity=source_parity(inventory,design)
    if parity['status']!='MATCH':raise ValueError('Native/metadata mismatch: '+str(parity))
    fitted=validate_tables(frozen,inventory)
    if args.plan_only:
        print(json.dumps({'status':STATUS,'source_inputs':len(frozen),'fitted_refs':len(fitted),'MPNs':42,'native_parity':parity['status'],'review':review},indent=2));return
    cli=args.kicad_cli or Path('/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
    output.parent.mkdir(parents=True,exist_ok=True)
    stage=Path(tempfile.mkdtemp(prefix=output.name+'-staging-',dir=output.parent));commands=[]
    try:
        # Candidate CAD is flat here so schematic/project/library relative paths remain valid.
        for name,data in frozen.items():
            dest=(stage/'source/design'/name[len(CANDIDATE)+1:]) if name.startswith(CANDIDATE+'/') else stage/'source/evidence'/name
            dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
        for n in ['assembly','checks','fabrication/gerbers','fabrication/drills']:(stage/n).mkdir(parents=True,exist_ok=True)
        native=stage/'source/design/fieldnote.kicad_pcb'
        run_cli(cli,['pcb','drc','--format','json','--schematic-parity','--output',stage/'checks/native-drc-parity.json',native],stage,commands)
        drc=drc_summary(stage/'checks/native-drc-parity.json');write_json(stage/'checks/native-drc-summary.json',drc)
        if any(drc['report_list_counts'].get(k,0) for k in ['violations','unconnected_items','schematic_parity']):raise ValueError('Fresh saved-fill native DRC/parity findings')
        run_cli(cli,['pcb','export','gerbers','--layers',GERBER_LAYERS,'--no-protel-ext','--subtract-soldermask','--output',str(stage/'fabrication/gerbers')+'/',native],stage,commands)
        run_cli(cli,['pcb','export','drill','--format','excellon','--drill-origin','absolute','--excellon-units','mm','--excellon-zeros-format','decimal','--excellon-oval-format','route','--excellon-separate-th','--generate-map','--map-format','svg','--generate-report','--report-path',stage/'fabrication/drills/drill-report.txt','--output',str(stage/'fabrication/drills')+'/',native],stage,commands)
        run_cli(cli,['pcb','export','pos','--side','front','--format','csv','--units','mm','--output',stage/'assembly/positions-native-front-all.csv',native],stage,commands)
        filter_positions(stage,inventory)
        accepted=list(csv.DictReader(io.StringIO(frozen[TABLES+'/CPL-assembled-native.csv'].decode())))
        fresh=list(csv.DictReader((stage/'assembly/positions-fitted-front.csv').open()))
        if {r['Ref']:r for r in fresh}!={r['Ref']:r for r in accepted}:raise ValueError('Fresh CLI positions differ from accepted native CPL')
        (stage/'assembly/positions-fitted-front.csv').write_bytes(frozen[TABLES+'/CPL-assembled-native.csv'])
        for name in ['BOM-assembled-grouped.csv','DNP-and-PCB-only.csv','README.md']:(stage/'assembly'/name).write_bytes(frozen[TABLES+'/'+name])
        plot=stage/'checks/assembly-visibility-only.kicad_pcb';write_json(stage/'checks/assembly-visibility-changes.json',assembly_plot_copy(native_bytes,plot))
        for fmt in ['svg','pdf']:
            for padmap in [False,True]:
                name='assembly-front-pad-map' if padmap else 'assembly-front-review'
                opts=['pcb','export',fmt,'--mode-single','--layers',ASSEMBLY_LAYERS,'--black-and-white','--crossout-DNP-footprints-on-fab-layers']
                if padmap:opts+=['--sketch-pads-on-fab-layers']
                opts += ['--page-size-mode','2','--exclude-drawing-sheet'] if fmt=='svg' else ['--no-property-popups','--scale','0']
                run_cli(cli,opts+['--output',stage/'assembly'/(name+'.'+fmt),plot],stage,commands)
        if len(list((stage/'fabrication/gerbers').glob('*.gbr')))!=10 or len(list((stage/'fabrication/drills').glob('*.drl')))!=2:raise ValueError('Missing Gerber/drill exports')
        for name,data in frozen.items():
            dest=(stage/'source/design'/name[len(CANDIDATE)+1:]) if name.startswith(CANDIDATE+'/') else stage/'source/evidence'/name
            if dest.read_bytes()!=data or checked_path(root,name).read_bytes()!=data:raise ValueError('Captured/live input changed: '+name)
        write_json(stage/'checks/native-inventory.json',inventory);write_json(stage/'checks/native-metadata-parity.json',parity)
        write_json(stage/'checks/engineering-index-scope.json',review);write_json(stage/'checks/export-commands.json',{'commands':commands,'board_saved':False,'zones_refilled':False})
        dnp=sorted(p['reference'] for p in inventory['footprints'] if p['native_dnp'])
        specs={'status':STATUS,'batch':{'fabricated':5,'assembled':2,'return_bare':3},'fitted_per_board':78,'grouped_exact_MPNs':42,'DNP':dnp,'battery_fitted':False,'layers':inventory['copper_layers'],'thickness_mm':1.6,'copper_oz':1,'mask':'green','legend':'white','minimum_track_clearance_mm':.15,'ordinary_via_pad_hole_mm':[.6,.3],'smallest_standard_via_pad_hole_mm':[.5,.2],'minimum_annular_mm':.15,'HDI_blind_buried_vias':False,'filled_capped_vias_assumed':False,'U2_EP':'4.1x4.1mm GND copper; four0.5/0.2mm ordinary GND vias and nine1mm rounded paste windows;51.17% coverage;nominal0.085mm hole-to-paste gap; assembler stencil/reflow/tenting/Xray review HOLD','U3_thermal_vias':'two ordinary0.3mm, unfilled/uncapped, back tented; stencil review HOLD','finish':'compare lead-free HASL; supplier fine-pitch suitability review; ENIG separately if required','coordinate_origin':'native(0,0),mm,Xnative/Ynegated forCPL;Gerber/drill nativeabsolute','physical_qualified':False,'full_engineering_index_included':review['full_review_index_included']}
        write_json(stage/'fabrication/fabrication-specs.json',specs)
        (stage/'fabrication/assembly-spec-PN7160.md').write_bytes(frozen['manufacturing/assembly-spec-PN7160.md'])
        (stage/'README-REVIEW-HOLD.md').write_text('# PN7160 v0.3 native engineering review exports\n\n**'+STATUS+'**\n\n5 fabricated /2 assembled /3 returned bare;78 fitted references/42exactMPNs. No battery. Native saved-fill board, project/schematics and local libraries are captured under source/design; source-bound assembly and exporter evidence under source/evidence. All plots use this exact native board. Assembly-only value/reference visibility edits preserve physical geometry. Gerbers/drills nativeabsolute origin(0,0); CPL Xnative/Ynegated, no manual rotation/mirror. HybridJ1 includes4PTHshellslots+2NPTHpegs.\n\nScope: '+review['status']+'. Native CAD zero findings are distinct from conditional model evidence. Do not infer distributed-power, firmware startup, USB100current, RF/current/thermal, actual assembler process, or physical case qualification from this archive. If no full engineering index is included, final distributed-power and complete evidence archive remain pending. PN7160 EP is ordinary unfilled/capped-free; supplier stencil/tenting/reflow/Xray acceptance remains HOLD.\n\nNo upload/order/payment/production authorization. Preserve this immutable directory/ZIP; use a new path for revisions. MANIFEST and ZIP SHA256 checks establish identity, not correctness.\n')
        manifest={'schema_version':1,'status':STATUS,'created_utc':dt.datetime.now(dt.timezone.utc).isoformat(),'kicad_version':subprocess.check_output([str(cli),'version'],text=True).strip(),'board_sha256':sha(native_bytes),'design_sha256':sha(frozen[CANDIDATE+'/design-data.json']),'native_freeze_manifest_sha256':sha(frozen[CANDIDATE+'/native-freeze-manifest.json']),'source_input_sha256':{n:sha(d) for n,d in frozen.items()},'native_drc_summary':drc,'native_metadata_parity':parity['status'],'engineering_scope':review,'production_authorized':False,'external_submission':False,'files':manifest_records(stage)}
        write_json(stage/'MANIFEST.json',manifest);(stage/'MANIFEST.sha256').write_text(sha((stage/'MANIFEST.json').read_bytes())+'  MANIFEST.json\n');verify(stage)
        zp=Path(str(output)+'.zip')
        with zipfile.ZipFile(zp,'x',zipfile.ZIP_DEFLATED,compresslevel=7) as z:
            for p in sorted(stage.rglob('*')):
                if p.is_file():
                    info=zipfile.ZipInfo(output.name+'/'+p.relative_to(stage).as_posix(),(2000,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100444<<16;z.writestr(info,p.read_bytes())
        verify(zp);Path(str(zp)+'.sha256').write_text(sha(zp.read_bytes())+'  '+zp.name+'\n');stage.rename(output)
        for p in output.rglob('*'):
            if p.is_file():p.chmod(0o444)
        print(json.dumps({'status':STATUS,'directory':str(output),'zip':str(zp),'zip_sha256':sha(zp.read_bytes()),'manifest_sha256':sha((output/'MANIFEST.json').read_bytes()),'files':len(manifest['files']),'source_inputs':len(frozen),'fitted_refs':78,'exact_MPNs':42,'native_drc':drc,'scope':review},indent=2))
    except Exception:
        write_json(stage/'EXPORT-FAILED.json',{'status':'FAILED_DO_NOT_SUBMIT','commands':commands});print('Diagnostic staging preserved: '+str(stage),file=sys.stderr);raise


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--out',type=Path);p.add_argument('--review-index',type=Path);p.add_argument('--kicad-cli',type=Path);p.add_argument('--plan-only',action='store_true');p.add_argument('--verify',type=Path);args=p.parse_args()
    if args.verify:print(json.dumps(verify(args.verify.resolve()),indent=2))
    elif args.out:export(args)
    else:p.error('--out NEW_DIRECTORY or --verify EXISTING_PATH required')

if __name__=='__main__':main()
