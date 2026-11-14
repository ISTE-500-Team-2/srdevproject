#!/usr/bin/env python3
"""Copy final native footprint geometry into this board's local library only.

Run with KiCad's bundled Python/pcbnew. Default is a dry run; --apply writes only
changed .kicad_mod files. It never saves/refills the board or changes routing.
Use a copied board and copied library to validate before applying to live libs.

    python sync_native_libraries.py --board COPY.kicad_pcb --library COPY.pretty
    python sync_native_libraries.py --board COPY.kicad_pcb --library COPY.pretty --apply

Each detached duplicate is normalized to zero pose before FootprintSave.
Library metadata/Reference/Value fields are retained from the existing entry;
board MPNs, references, paths, net assignments and placement flags are excluded.
Conflicting geometry among instances sharing one FPID is an error, never an
arbitrary choice of an instance. --only accepts local footprint names or refs.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

import pcbnew as k
import wx

ROOT = Path(__file__).resolve().parent
TOKEN = re.compile(r'\s+|;[^\n]*|\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+')
PAD_INSTANCE_SETTINGS = {'zone_connect', 'thermal_bridge_width', 'thermal_bridge_angle',
                         'thermal_gap', 'clearance'}


class Quoted(str):
    pass


def read_tree(text):
    root, stack, end = [], [], 0
    current = root
    for match in TOKEN.finditer(text):
        if match.start() != end:
            raise ValueError('Unrecognized syntax at offset %s' % end)
        end = match.end()
        token = match.group()
        if token.isspace() or token.startswith(';'):
            continue
        if token == '(':
            node = []
            current.append(node)
            stack.append(current)
            current = node
        elif token == ')':
            if not stack:
                raise ValueError('Unbalanced close parenthesis')
            current = stack.pop()
        else:
            current.append(Quoted(json.loads(token)) if token.startswith('"') else token)
    if stack or end != len(text) or len(root) != 1:
        raise ValueError('Incomplete S-expression')
    return root[0]


def emit(node, level=0):
    if not isinstance(node, list):
        return json.dumps(str(node), ensure_ascii=False) if isinstance(node, Quoted) else str(node)
    if not any(isinstance(item, list) for item in node):
        return '(' + ' '.join(emit(item, level + 1) for item in node) + ')'
    atoms = []
    nested = []
    for item in node:
        (nested if isinstance(item, list) else atoms).append(item)
    return '(' + ' '.join(emit(item, level + 1) for item in atoms) + ''.join(
        '\n' + '\t' * (level + 1) + emit(item, level + 1) for item in nested) + '\n' + '\t' * level + ')'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def geometry(tree):
    """Ignore instance identity/fields; retain pad, stencil, graphic and zone data."""
    ignored = {'uuid', 'tstamp', 'net', 'pinfunction', 'pintype', 'locked'}
    root_ignored = {'version', 'generator', 'generator_version', 'at', 'path',
                    'sheetfile', 'sheetname', 'property', 'descr', 'tags',
                    'attr', 'embedded_fonts', 'model', 'component_classes'}

    def clean(node):
        if not isinstance(node, list):
            return str(node)
        excluded = ignored | PAD_INSTANCE_SETTINGS if node and node[0] == 'pad' else ignored
        return [clean(x) for x in node if not (
            isinstance(x, list) and x and str(x[0]) in excluded) and x != 'locked']

    items = []
    for item in tree[2:]:
        if isinstance(item, list) and item:
            if str(item[0]) in root_ignored:
                continue
            if item[0] == 'fp_text' and item[1] in {'reference', 'value'}:
                continue
        items.append(json.dumps(clean(item), separators=(',', ':')))
    return collections.Counter(items)


def restore_library_metadata(candidate, old, name):
    # Geometry comes from native serialization. Everything identifying a board
    # component comes from the generic library entry, rather than from the PCB.
    native_geometry = geometry(candidate)
    metadata = {'property', 'descr', 'tags', 'attr', 'model', 'embedded_fonts'}
    board_only = {'at', 'path', 'sheetfile', 'sheetname', 'component_classes', 'uuid', 'tstamp'}
    candidate = [candidate[0], Quoted(name)] + [x for x in candidate[2:] if not (
        isinstance(x, list) and x and (str(x[0]) in metadata | board_only or
        (x[0] == 'fp_text' and x[1] in {'reference', 'value'}))) and x != 'locked']
    preserved = [x for x in old[2:] if isinstance(x, list) and x and (
        str(x[0]) in metadata or (x[0] == 'fp_text' and x[1] in {'reference', 'value'}))]
    candidate.extend(preserved)

    def remove_pad_instance_data(node):
        if not isinstance(node, list):
            return node
        excluded = {'net', 'pinfunction', 'pintype'} | PAD_INSTANCE_SETTINGS if node and node[0] == 'pad' else set()
        return [remove_pad_instance_data(x) for x in node if not (
            isinstance(x, list) and x and x[0] in excluded) and x != 'locked']

    candidate = remove_pad_instance_data(candidate)
    # Ground-pad direct/thermal connection and local clearance overrides belong
    # to individual board instances. Keep the old library defaults, if any.
    old_pads = collections.defaultdict(list)
    for pad in old:
        if isinstance(pad, list) and pad and pad[0] == 'pad':
            old_pads[str(pad[1])].append(pad)
    used = collections.Counter()
    for pad in candidate:
        if isinstance(pad, list) and pad and pad[0] == 'pad':
            number = str(pad[1])
            index = used[number]
            used[number] += 1
            if index < len(old_pads[number]):
                pad.extend(x for x in old_pads[number][index] if isinstance(x, list) and x and x[0] in PAD_INSTANCE_SETTINGS)
    assert geometry(candidate) == native_geometry, 'Metadata cleanup changed native geometry'
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board', type=Path, default=ROOT / 'fieldnote.kicad_pcb')
    parser.add_argument('--library', type=Path, default=ROOT / 'Fieldnote.pretty')
    parser.add_argument('--only', action='append', default=[], help='Footprint name or component reference; repeatable')
    parser.add_argument('--apply', action='store_true', help='Write only changed local library files')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    board_path, library = args.board.resolve(), args.library.resolve()
    if library.suffix != '.pretty' or not library.is_dir():
        raise ValueError('Existing KiCad .pretty directory required')
    source_bytes = board_path.read_bytes()
    app = wx.App(False)
    # KiCad 10's path guessing returns FILE_TYPE_NONE for a new empty .pretty
    # directory. Select its native serializer explicitly for staging writes.
    native_plugin = k.PCB_IO_MGR.FindPlugin(k.PCB_IO_MGR.KICAD_SEXP)
    if native_plugin is None:
        raise RuntimeError('KiCad native footprint serializer unavailable')
    board = k.LoadBoard(str(board_path))
    groups = collections.defaultdict(list)
    for fp in board.GetFootprints():
        fpid = fp.GetFPID()
        nickname, name = str(fpid.GetLibNickname()), str(fpid.GetLibItemName())
        if nickname != 'Fieldnote':
            raise ValueError('Unexpected library nickname for %s: %s' % (fp.GetReference(), nickname))
        if not name or Path(name).name != name:
            raise ValueError('Invalid local footprint name: %r' % name)
        groups[name].append(fp)
    known = set(groups) | {f.GetReference() for fs in groups.values() for f in fs}
    if set(args.only) - known:
        raise ValueError('Unknown --only selection: %s' % sorted(set(args.only) - known))
    changes, conflicts, prepared = [], [], {}
    with tempfile.TemporaryDirectory(prefix='fieldnote-library-sync-') as temporary:
        staging = Path(temporary) / 'native.pretty'
        staging.mkdir()
        for name, fps in sorted(groups.items()):
            if args.only and name not in args.only and not any(f.GetReference() in args.only for f in fps):
                continue
            original_path = library / (name + '.kicad_mod')
            original_bytes = original_path.read_bytes()
            old = read_tree(original_bytes.decode('utf-8'))
            instances = []
            for fp in sorted(fps, key=lambda f: f.GetReference()):
                if fp.GetLayer() != k.F_Cu:
                    raise ValueError('Back-side footprint needs explicit flip normalization: %s' % fp.GetReference())
                detached = k.Cast_to_FOOTPRINT(fp.Duplicate(False))
                detached.SetParent(None)
                detached.SetOrientationDegrees(0)
                detached.SetPosition(k.VECTOR2I(0, 0))
                native_plugin.FootprintSave(str(staging), detached)
                candidate = read_tree((staging / (name + '.kicad_mod')).read_text())
                candidate = restore_library_metadata(candidate, old, name)
                instances.append((fp.GetReference(), candidate, geometry(candidate)))
            if any(item[2] != instances[0][2] for item in instances[1:]):
                conflicts.append({'footprint': name, 'references': [item[0] for item in instances],
                                  'reason': 'One FPID has different native geometry; cannot represent it with one library entry'})
                continue
            if instances[0][2] == geometry(old):
                continue
            text = emit(instances[0][1]) + '\n'
            assert geometry(read_tree(text)) == instances[0][2]
            # Reload the proposed library using native KiCad before any write.
            (staging / (name + '.kicad_mod')).write_text(text)
            if k.FootprintLoad(str(staging), name) is None:
                raise ValueError('Native footprint reload failed: %s' % name)
            prepared[original_path] = text.encode('utf-8')
            changes.append({'footprint': name, 'references': [item[0] for item in instances],
                            'before_sha256': digest(original_bytes), 'after_sha256': digest(prepared[original_path])})
        if board_path.read_bytes() != source_bytes:
            raise ValueError('Native board changed during sync; retry with a stable final snapshot')
        if args.apply and conflicts:
            raise ValueError('No libraries written because shared-FPID conflicts exist: %s' % json.dumps(conflicts))
        if args.apply:
            for path, data in prepared.items():
                temporary_path = path.with_suffix('.kicad_mod.sync-tmp')
                temporary_path.write_bytes(data)
                os.replace(temporary_path, path)
    report = {'status': 'CONFLICT' if conflicts else ('APPLIED_LIBRARY_ONLY' if args.apply else 'DRY_RUN'),
              'board': str(board_path), 'board_sha256': digest(source_bytes), 'library': str(library),
              'board_saved': False, 'changes': changes, 'conflicts': conflicts,
              'metadata': 'Existing generic library properties/reference/value/model metadata retained; board nets/path/pose/MPN excluded',
              'next_check': 'Native DRC with schematic parity, final pin audit and library geometry after all CAD edits'}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return 1 if conflicts else 0


if __name__ == '__main__':
    raise SystemExit(main())
