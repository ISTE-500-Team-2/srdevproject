#!/usr/bin/env python3
"""Sync final PN7160 component fields/placements without altering PCB copper.

Only accepts a board inside this separate variant directory. --fields writes
Value/MPN strings; --placements copies saved positions into metadata. The
optional --crystal-lands changes only Y1 rounded corners to the manufacturer
rectangle with fixed size/center/net. No pcbnew save, refill, routing edits,
automatic net assignments or v0.2 writes occur. Rerun native parity/DRC after
the final field/placement/land synchronization.
"""
from pathlib import Path
import argparse
import hashlib
import json

import build_design as gen

ROOT = Path(__file__).resolve().parent


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--board', type=Path, default=ROOT / 'fieldnote.kicad_pcb')
    ap.add_argument('--require-sha256', required=True)
    ap.add_argument('--fields', action='store_true')
    ap.add_argument('--placements', action='store_true')
    ap.add_argument('--review-label', action='store_true', help='Update inherited draft drawing label to the correct variant')
    ap.add_argument('--crystal-lands', action='store_true', help='Match NDK recommended rectangular Y1 lands without changing centers/sizes')
    args = ap.parse_args()
    assert args.fields or args.placements or args.review_label or args.crystal_lands, 'Choose an explicit synchronization operation'
    path = args.board.resolve()
    assert ROOT.resolve() in path.parents and path.suffix == '.kicad_pcb'
    assert 'baseline' not in path.relative_to(ROOT).parts and 'pn7160-seed' not in path.relative_to(ROOT).parts
    raw = path.read_bytes()
    assert sha(raw) == args.require_sha256.lower(), 'Saved source hash changed'
    data_path = ROOT / 'design-data.json'
    data_raw = data_path.read_bytes()
    data = json.loads(data_raw)
    assert data['nfc_profile']['mpn'] == 'PN7160A1HN/C100E'
    parts = {p['ref']: p for p in data['parts']}
    tree = gen.readsex(raw.decode())
    found = set()
    changed_fields, changed_positions, changed_annotations, changed_lands = [], [], [], []
    for fp in gen.children(tree, 'footprint'):
        props = {gen.unq(x[1]): x for x in gen.children(fp, 'property')}
        ref = gen.unq(props['Reference'][2])
        assert ref in parts and ref not in found, ('unexpected or duplicate reference', ref)
        found.add(ref)
        p = parts[ref]
        assert gen.unq(fp[1]) == 'Fieldnote:' + p['fp'], ('footprint mismatch', ref)
        if args.crystal_lands and ref == 'Y1':
            assert p['mpn'] == 'NX2016SA-27.12MHZ-EXS00A-CS06346'
            for pad in gen.children(fp, 'pad'):
                assert gen.unq(pad[1]) in {'1', '2', '3', '4'} and pad[2] == 'smd'
                size = gen.child(pad, 'size')
                assert [float(x) for x in size[1:]] == [0.85, 0.75]
                if pad[3] != 'rect':
                    changed_lands.append({'ref': ref, 'pad': gen.unq(pad[1]), 'before_shape': pad[3], 'after_shape': 'rect'})
                    pad[3] = 'rect'
                    pad[:] = [x for x in pad if not (isinstance(x, list) and x and x[0] == 'roundrect_rratio')]
        if args.fields:
            for field, key in [('Value', 'value'), ('MPN', 'mpn')]:
                node = props[field]
                expected = str(p.get(key) or '')
                before = gen.unq(node[2])
                if before != expected:
                    node[2] = gen.q(expected)
                    changed_fields.append({'ref': ref, 'field': field, 'before': before, 'after': expected})
        if args.placements:
            at = gen.child(fp, 'at')
            pos = [round(float(at[1]) - 60, 6), round(float(at[2]) - 50, 6)]
            angle = float(at[3]) if len(at) > 3 else 0.0
            if p['xy'] != pos or float(p['angle']) != angle:
                changed_positions.append({'ref': ref, 'before': [p['xy'], p['angle']], 'after': [pos, angle]})
                p['xy'], p['angle'] = pos, angle
    assert found == set(parts), 'Component set differs from circuit metadata'
    if args.review_label:
        for label in gen.children(tree, 'gr_text'):
            before = gen.unq(label[1])
            if before.startswith('FIELDNOTE v0.2'):
                after = 'FIELDNOTE PN7160 v0.3 - ENGINEERING REVIEW'
                label[1] = gen.q(after)
                changed_annotations.append({'before': before, 'after': after})
    assert path.read_bytes() == raw and data_path.read_bytes() == data_raw, 'Inputs changed while syncing'
    if changed_fields or changed_annotations or changed_lands:
        path.write_text(gen.sx(tree) + '\n')
    if changed_positions:
        data_path.write_text(json.dumps(data, indent=2) + '\n')
    report = {'board': str(path), 'before_sha256': sha(raw), 'after_sha256': sha(path.read_bytes()),
              'metadata_before_sha256': sha(data_raw), 'metadata_after_sha256': sha(data_path.read_bytes()),
              'changed_fields': changed_fields, 'changed_positions': changed_positions,
              'changed_annotations': changed_annotations,
              'changed_crystal_lands': changed_lands,
              'copper_pad_library_geometry': 'Routing untouched. Optional Y1 land-shape synchronization changes only rounded corners to the manufacturer rectangle; centers/sizes/nets stay fixed.'}
    out = path.parent / 'field-placement-sync.json'
    out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
