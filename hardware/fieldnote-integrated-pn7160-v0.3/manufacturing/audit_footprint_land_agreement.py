#!/usr/bin/env python3
"""Compare native embedded pads with the variant's saved local libraries.

Read-only, hash-bound audit of copper, drill, mask and paste pad geometry.
This complements manufacturer/package and native DRC reviews; matching two
CAD representations cannot independently establish a correct land pattern.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re

from audit_native_pins import sexpr, child, children

ROOT = Path(__file__).resolve().parents[1]
IGNORE = {'uuid', 'tstamp', 'net', 'pinfunction', 'pintype', 'zone_connect'}
NUMBER = re.compile(r'^-?(?:\d+(?:\.\d*)?|\.\d+)$')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    if isinstance(value, list):
        return [canonical(x) for x in value
                if not (isinstance(x, list) and x and x[0] in IGNORE)]
    if isinstance(value, str) and NUMBER.fullmatch(value):
        return round(float(value), 6)
    return value


def pads(fp, native=False):
    angle_node = child(fp, 'at', ['at', '0', '0'])
    angle = float(angle_node[3]) if len(angle_node) > 3 else 0.0
    result = []
    for original in children(fp, 'pad'):
        pad = json.loads(json.dumps(original))
        at = child(pad, 'at', ['at', '0', '0'])
        pad_angle = float(at[3]) if len(at) > 3 else 0.0
        relative_angle = (pad_angle - (angle if native else 0.0)) % 360.0
        at[:] = ['at', at[1], at[2], str(round(relative_angle, 6))]
        normalized = canonical(pad)
        # KiCad serialization may reorder pad settings; polygon point order
        # and other nested geometry remain untouched.
        normalized[4:] = sorted(normalized[4:], key=lambda x: json.dumps(x, sort_keys=True))
        result.append(normalized)
    return sorted(result, key=lambda x: json.dumps(x, sort_keys=True))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--board', type=Path, required=True)
    ap.add_argument('--expected-board-sha256', required=True)
    ap.add_argument('--library-directory', type=Path, default=ROOT / 'Fieldnote.pretty')
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    board_raw = args.board.read_bytes()
    assert digest(board_raw) == args.expected_board_sha256, 'Board hash changed'
    board = sexpr(board_raw.decode())
    library_inputs = {}
    errors, rows, zone_overrides = [], [], []
    for fp in children(board, 'footprint'):
        props = {x[1]: x[2] for x in children(fp, 'property')}
        ref = props['Reference']
        assert fp[1].startswith('Fieldnote:'), (ref, fp[1])
        name = fp[1].split(':', 1)[1]
        path = args.library_directory / (name + '.kicad_mod')
        if name not in library_inputs:
            library_inputs[name] = (path, path.read_bytes())
        lib = sexpr(library_inputs[name][1].decode())
        expected, actual = pads(lib), pads(fp, native=True)
        for pad in children(fp, 'pad'):
            zone = child(pad, 'zone_connect')
            if zone:
                zone_overrides.append({'ref': ref, 'pad': pad[1],
                                       'native_zone_connect': zone[1],
                                       'native_pad_at': child(pad, 'at')})
        agreement = actual == expected
        rows.append({'ref': ref, 'library_name': name,
                     'pad_count': len(actual), 'agreement': agreement})
        if not agreement:
            errors.append({'ref': ref, 'native': actual, 'library': expected})
    if args.board.read_bytes() != board_raw:
        errors.append({'type': 'board_changed_during_audit'})
    for name, (path, raw) in library_inputs.items():
        if path.read_bytes() != raw:
            errors.append({'type': 'library_changed_during_audit', 'name': name})
    report = {'status': 'PASS_NATIVE_LIBRARY_PAD_AGREEMENT' if not errors else 'FAIL_NATIVE_LIBRARY_PAD_AGREEMENT',
              'board': {'path': str(args.board.resolve()), 'sha256': digest(board_raw)},
              'libraries': {name: {'path': str(path.resolve()), 'sha256': digest(raw)}
                            for name, (path, raw) in library_inputs.items()},
              'footprints_checked': len(rows), 'physical_pads_checked': sum(x['pad_count'] for x in rows),
              'rows': rows, 'errors': errors,
              'board_zone_connection_overrides': zone_overrides,
              'normalization': 'Native absolute pad angle converted to footprint-relative angle; UUID/net/pin labels excluded. Board-owned zone-connect overrides are listed separately and excluded from land geometry equality. All remaining pad geometry/settings compared at 1 nm numeric precision.',
              'limitation': 'Agreement of embedded and saved pad geometry only; manufacturer dimensions, copper routing, component body clearance, stencil process and physical function remain separate reviews.'}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'footprints_checked': len(rows),
                      'physical_pads_checked': report['physical_pads_checked'],
                      'errors': [{'ref': x.get('ref'), 'type': x.get('type', 'pad_geometry_difference')} for x in errors]}, indent=2))
    return 0 if not errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
