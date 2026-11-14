#!/usr/bin/env python3
"""Read-only frozen PN532 -> PN7160 native geometry audit.

Compare after native zone refill, because refill can assign a loose via to
the net of a pad that was accidentally placed over it. This check never
loads pcbnew, saves a board, or infers that RF/power hardware is qualified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from audit_native_pins import sexpr, child, children

ROOT = Path(__file__).resolve().parents[1]
BASE_SHA = '1ea3e9e01202277e5603b3c989f391fa86cc71dfa319b053cda6c318f2e056a2'
MOVABLE = {'U2', 'Y1', 'FB1', 'L1', 'L2', 'R19', 'R22', 'R23', 'R24', 'R25',
           'R27', 'R28', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19',
           'C20', 'C21', 'C22', 'C23', 'C24', 'C25', 'C26', 'C27', 'C28', 'C29',
           'C30', 'C31', 'C34', 'C35', 'C37', 'TP2', 'TP4', 'TP5'}
PROTECTED_NETS = {'VSYS', 'VBUS', '3V3', 'BAT', 'BAT_ADC', 'CHG_N', 'PGOOD_N',
                  'REG_EN', 'ESP_EN', 'LED_GREEN', 'LED_RED', 'LED_AMBER',
                  'UART_TX', 'USB_LIMITED', 'USB_HIGH_CURRENT'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(node, omit=()):
    """Normalize UUIDs and net IDs while preserving actual shape/settings."""
    if not isinstance(node, list):
        return node
    return [canonical(x, omit) for x in node
            if not (isinstance(x, list) and x and x[0] in set(omit) | {'uuid', 'tstamp'})]


def nets(board):
    return {x[1]: x[2] for x in children(board, 'net') if len(x) == 3}


def net_name(node, table):
    n = child(node, 'net')
    if not n:
        return ''
    return n[-1] if len(n) == 3 else table.get(n[1], n[1])


def copper(board):
    result = {}
    table = nets(board)
    for kind in ['segment', 'arc', 'via']:
        for item in children(board, kind):
            ident = child(item, 'uuid', child(item, 'tstamp'))[1]
            shape = canonical(item, {'net'})
            result[ident] = {'net': net_name(item, table), 'shape': shape}
    return result


def footprints(board):
    result = {}
    for fp in children(board, 'footprint'):
        ref = {x[1]: x[2] for x in children(fp, 'property')}.get('Reference')
        if ref is None:
            ref = next(x[2] for x in children(fp, 'fp_text') if x[1] == 'reference')
        # Copper lands/body position are protected independently of text fields,
        # library path changes and sheet UUID paths.
        geometry = [canonical(x, {'net', 'pinfunction', 'pintype'}) for x in fp
                    if isinstance(x, list) and x and x[0] in
                    {'at', 'layer', 'pad', 'fp_line', 'fp_rect', 'fp_circle', 'fp_arc', 'fp_poly', 'zone'}]
        result[ref] = {'library': fp[1], 'geometry': geometry}
    return result


def edges(board):
    return sorted(json.dumps(canonical(x), sort_keys=True) for x in board
                  if isinstance(x, list) and x and x[0].startswith('gr_') and
                  child(x, 'layer', ['layer', ''])[1] == 'Edge.Cuts')


def keepouts(board):
    return sorted(json.dumps(canonical(z), sort_keys=True) for z in children(board, 'zone')
                  if child(z, 'keepout'))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--board', type=Path, default=ROOT / 'fieldnote.kicad_pcb')
    ap.add_argument('--cleanup', type=Path,
                    help='JSON list of explicitly reviewed additional seed-copper removals; UUID/net/reason required')
    ap.add_argument('--out', type=Path, default=ROOT / 'output/geometry-preservation.json')
    args = ap.parse_args()
    paths = {'baseline': ROOT / 'baseline/fieldnote-pn532-frozen.kicad_pcb',
             'seed': ROOT / 'output/pn7160-seed/fieldnote.kicad_pcb', 'final': args.board.resolve()}
    raw = {key: p.read_bytes() for key, p in paths.items()}
    assert digest(raw['baseline']) == BASE_SHA, 'Frozen baseline hash changed'
    boards = {key: sexpr(value.decode()) for key, value in raw.items()}
    tracks = {key: copper(value) for key, value in boards.items()}
    parts = {key: footprints(value) for key, value in boards.items()}
    manifest = json.loads((ROOT / 'output/pn7160-seed/seed-manifest.json').read_text())
    assert digest(raw['seed']) == manifest['seed_sha256'], 'Seed differs from integration manifest'
    removed_baseline = {r['uuid'] for r in manifest['removed_copper']}
    retained_baseline = {r['uuid'] for r in manifest['retained_copper']}
    assert removed_baseline.isdisjoint(retained_baseline)
    assert removed_baseline | retained_baseline == set(tracks['baseline'])
    cleanup_rows = json.loads(args.cleanup.read_text()) if args.cleanup else []
    allowed_cleanup = {}
    errors = []
    for row in cleanup_rows:
        ident, reason = row.get('uuid'), row.get('reason', '')
        original = tracks['baseline'].get(ident, tracks['seed'].get(ident))
        seed_original = tracks['seed'].get(ident)
        known_nets = {original['net'], seed_original['net']} if original and seed_original else set()
        if not original or not seed_original or not reason or row.get('net') not in known_nets:
            errors.append({'type': 'invalid_declared_cleanup', 'row': row})
            continue
        n = original['net']
        if n not in {'GND', '3V3', 'NFC_VBAT'}:
            errors.append({'type': 'cleanup_outside_nfc_shared_rail_scope', 'row': row})
            continue
        item = original['shape']
        points = [x for x in item if isinstance(x, list) and x and x[0] in {'start', 'end', 'at'}]
        if not points or any(not (93 <= float(p[1]) <= 110 and 64 <= float(p[2]) <= 88) for p in points):
            errors.append({'type': 'cleanup_outside_nfc_region', 'row': row})
            continue
        allowed_cleanup[ident] = dict(row, baseline_net=original['net'], seed_net=seed_original['net'])
    # A seed may already contain a refill-induced net reassignment. Preserve
    # the immutable baseline conductor in that case, rather than accepting the
    # seed's accidental net. Report the discrepancy even after it is repaired.
    seed_discrepancies = []
    for ident in sorted(retained_baseline):
        if tracks['seed'].get(ident) != tracks['baseline'][ident]:
            seed_discrepancies.append({'uuid': ident, 'baseline': tracks['baseline'][ident],
                                       'seed': tracks['seed'].get(ident),
                                       'final': tracks['final'].get(ident)})
    for ident, original in tracks['seed'].items():
        if ident in retained_baseline:
            original = tracks['baseline'][ident]
        actual = tracks['final'].get(ident)
        if ident in allowed_cleanup:
            if actual is not None:
                errors.append({'type': 'declared_removed_cleanup_still_present', 'uuid': ident})
        elif actual != original:
            errors.append({'type': 'preserved_seed_copper_changed_or_removed', 'uuid': ident,
                           'before': original, 'after': actual})
    for ref, original in parts['baseline'].items():
        if ref in MOVABLE:
            continue
        actual = parts['final'].get(ref)
        if actual != original:
            errors.append({'type': 'protected_footprint_geometry_changed', 'ref': ref})
    for key in ['seed', 'final']:
        if edges(boards[key]) != edges(boards['baseline']):
            errors.append({'type': 'case_edge_geometry_changed', 'board': key})
        if keepouts(boards[key]) != keepouts(boards['baseline']):
            errors.append({'type': 'antenna_or_esp_keepout_changed', 'board': key})
    new_tracks = {ident: row for ident, row in tracks['final'].items() if ident not in tracks['seed']}
    permitted_added = {'GND', '3V3', 'NFC_VBAT', 'PN_1V8', 'PN_TX_LDO', 'NFC_SDA', 'NFC_SCL',
                       'NFC_VEN', 'NFC_IRQ', 'MCU_NFC_IRQ', 'UART_RX', 'NFC_VMID', 'NFC_RXN',
                       'NFC_RXP', 'NFC_OSCIN', 'NFC_OSCOUT', 'NFC_TX1', 'NFC_TX2', 'RF1_FILTER',
                       'RF2_FILTER', 'RF1_MATCH', 'RF2_MATCH', 'RF_RXP_COUPLED', 'RF_RXN_COUPLED',
                       'ANT_A', 'ANT_B', 'VSYS'}
    # Relocating the NFC bead permits a new local source branch; it must not
    # alter any inherited VSYS conductor or expand into the USB/regulator area.
    # V4 placement: original NFC feed -> FB1.1 at native (109.5, 63.95) mm.
    new_vsys_extensions = []
    for ident, row in new_tracks.items():
        if row['net'] not in permitted_added:
            errors.append({'type': 'new_copper_outside_authorized_nfc_nets', 'uuid': ident, 'net': row['net']})
        elif row['net'] == 'VSYS':
            shape = row['shape']
            points = [x for x in shape if isinstance(x, list) and x and x[0] in {'start', 'end', 'at'}]
            if shape[0] not in {'segment', 'via'} or not points or any(
                    not (93 <= float(p[1]) <= 110 and 60 <= float(p[2]) <= 88) for p in points):
                errors.append({'type': 'new_vsys_copper_outside_nfc_bead_extension', 'uuid': ident,
                               'shape': shape})
            else:
                new_vsys_extensions.append({'uuid': ident, 'shape': shape})
    if any(path.read_bytes() != raw[key] for key, path in paths.items()):
        errors.append({'type': 'input_changed_during_audit'})
    report = {'status': 'PASS_NATIVE_GEOMETRY_PRESERVATION' if not errors else 'FAIL_NATIVE_GEOMETRY_PRESERVATION',
              'inputs': {key: {'path': str(path), 'sha256': digest(raw[key])} for key, path in paths.items()},
              'baseline_copper_items': len(tracks['baseline']), 'declared_integration_removals': len(removed_baseline),
              'preserved_seed_copper_items': len(tracks['seed']) - len(allowed_cleanup),
              'additional_reviewed_nfc_cleanup': list(allowed_cleanup.values()), 'new_nfc_copper_items': len(new_tracks),
              'new_nfc_local_vsys_extensions': new_vsys_extensions,
              'seed_integration_discrepancies': seed_discrepancies,
              'protected_footprints_checked': len(set(parts['baseline']) - MOVABLE),
              'protected_antenna_and_case_geometry': not any(e['type'] in {'case_edge_geometry_changed',
                                                                       'antenna_or_esp_keepout_changed'} for e in errors),
              'errors': errors,
              'limitation': 'Exact inherited native geometry preservation only; new NFC-local VSYS feed extensions and ground-fill changes require the separate power/USB audit. Native ERC/DRC/parity and physical RF/power qualification remain separate.'}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k not in {'inputs', 'additional_reviewed_nfc_cleanup'}}, indent=2))
    return 0 if not errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
