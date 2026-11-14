#!/usr/bin/env python3
"""Read-only native PCB/netlist/metadata pin audit, standard-library Python.

    python3 manufacturing/audit_native_pins.py --out simulation/results/final-pin-audit.json
    python3 manufacturing/audit_native_pins.py --require-board-sha256 FINAL_SHA

Does not load a generator, save CAD, refill zones or infer manufacture readiness.
Use a freshly exported native schematic netlist and rerun after final CAD edits.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
TOKEN = re.compile(r'\s+|;[^\n]*|\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+')


def sexpr(text):
    root, stack, end = [], [], 0
    current = root
    for match in TOKEN.finditer(text):
        if match.start() != end:
            raise ValueError('Unrecognized KiCad syntax at offset %s' % end)
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
                raise ValueError('Unbalanced close parenthesis')
            current = stack.pop()
        else:
            current.append(json.loads(token) if token.startswith('"') else token)
    if stack or end != len(text) or len(root) != 1:
        raise ValueError('Incomplete KiCad S-expression')
    return root[0]


def children(node, name):
    return [x for x in node if isinstance(x, list) and x and x[0] == name]


def child(node, name, default=None):
    found = children(node, name)
    return found[0] if found else default


def normal_net(name):
    return None if not name or name.startswith('unconnected-') else name


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board', type=Path, default=ROOT / 'fieldnote.kicad_pcb')
    parser.add_argument('--netlist', type=Path, default=ROOT / 'output/fieldnote.net')
    parser.add_argument('--metadata', type=Path, default=ROOT / 'design-data.json')
    parser.add_argument('--require-board-sha256')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    inputs = {'board': args.board.resolve(), 'netlist': args.netlist.resolve(),
              'metadata': args.metadata.resolve()}
    snapshots = {key: path.read_bytes() for key, path in inputs.items()}
    board_sha = sha(snapshots['board'])
    if args.require_board_sha256 and board_sha != args.require_board_sha256.lower():
        raise ValueError('Board hash differs from required final snapshot: ' + board_sha)
    board = sexpr(snapshots['board'].decode('utf-8'))
    netlist = sexpr(snapshots['netlist'].decode('utf-8'))
    assert board[0] == 'kicad_pcb' and netlist[0] == 'export'
    raw_parts = json.loads(snapshots['metadata'])['parts']
    parts = {p['ref']: p for p in raw_parts}
    assert len(parts) == len(raw_parts), 'Duplicate metadata references'
    errors = []
    global_nets = {x[1]: x[2] for x in children(board, 'net') if len(x) == 3}
    schematic_nets = {}
    for net in children(child(netlist, 'nets', ['nets']), 'net'):
        name = normal_net(child(net, 'name', ['name', ''])[1])
        for node in children(net, 'node'):
            key = (child(node, 'ref')[1], child(node, 'pin')[1])
            if key in schematic_nets and schematic_nets[key] != name:
                errors.append({'type': 'schematic_pin_on_two_nets', 'ref_pin': key})
            schematic_nets[key] = name
    schematic_components = {}
    for component in children(child(netlist, 'components', ['components']), 'comp'):
        ref = child(component, 'ref')[1]
        if ref in schematic_components:
            errors.append({'type': 'duplicate_schematic_ref', 'ref': ref})
        schematic_components[ref] = component
    native = {}
    pad_count = 0
    unique_pins = set()
    net_by_pin = {}
    for fp in children(board, 'footprint'):
        properties = {x[1]: x[2] for x in children(fp, 'property')}
        ref = properties.get('Reference')
        if not ref:
            reference = next((x for x in children(fp, 'fp_text') if x[1] == 'reference'), None)
            ref = reference[2] if reference else ''
        if not ref or ref in native:
            errors.append({'type': 'missing_or_duplicate_native_ref', 'ref': ref})
            continue
        native[ref] = fp
        if ref not in parts:
            errors.append({'type': 'native_ref_missing_metadata', 'ref': ref})
            continue
        part = parts[ref]
        expected_fpid = 'Fieldnote:' + part['fp']
        if fp[1] != expected_fpid:
            errors.append({'type': 'footprint_identity', 'ref': ref, 'actual': fp[1], 'expected': expected_fpid})
        for field, key in [('MPN', 'mpn'), ('Value', 'value')]:
            actual, expected = properties.get(field, '').strip(), str(part.get(key) or '').strip()
            if actual != expected:
                errors.append({'type': 'native_metadata', 'ref': ref, 'field': field,
                               'actual': actual, 'expected': expected})
        native_dnp = 'dnp' in child(fp, 'attr', ['attr'])[1:]
        if native_dnp != bool(part.get('dnp', False)):
            errors.append({'type': 'native_dnp', 'ref': ref, 'actual': native_dnp,
                           'expected': bool(part.get('dnp', False))})
        expected_pins = part['nets']
        found = set()
        for pad in children(fp, 'pad'):
            number = pad[1]
            if not number:
                continue
            pad_count += 1
            found.add(number)
            key = (ref, number)
            unique_pins.add(key)
            net_node = child(pad, 'net')
            actual = normal_net(net_node[-1] if net_node and len(net_node) == 3 else
                                global_nets.get(net_node[1], net_node[1]) if net_node else None)
            if key in net_by_pin and net_by_pin[key] != actual:
                errors.append({'type': 'duplicate_native_pad_net', 'ref': ref, 'pin': number})
            net_by_pin[key] = actual
            if number not in expected_pins:
                errors.append({'type': 'native_pad_missing_metadata', 'ref': ref, 'pin': number})
                continue
            expected = normal_net(expected_pins[number])
            schematic = schematic_nets.get(key)
            if actual != expected or actual != schematic:
                errors.append({'type': 'pad_net', 'ref': ref, 'pin': number,
                               'native': actual, 'metadata': expected, 'schematic': schematic})
        for number in set(expected_pins) - found:
            errors.append({'type': 'metadata_pin_missing_native_pad', 'ref': ref, 'pin': number})
        schematic = schematic_components.get(ref)
        if schematic:
            for tag, expected in [('value', part['value']), ('footprint', expected_fpid)]:
                actual = child(schematic, tag, [tag, ''])[1]
                if actual != expected:
                    errors.append({'type': 'schematic_metadata', 'ref': ref, 'field': tag,
                                   'actual': actual, 'expected': expected})
            schematic_properties = {child(x, 'name')[1]: child(x, 'value', ['value', ''])[1]
                                    for x in children(schematic, 'property')}
            schematic_fields = {child(x, 'name')[1]: x[-1] if len(x) > 2 else ''
                                for x in children(child(schematic, 'fields', ['fields']), 'field')}
            expected_mpn = str(part.get('mpn') or '').strip()
            for label, table in [('property', schematic_properties), ('field', schematic_fields)]:
                actual_mpn = str(table.get('MPN', '')).strip()
                if actual_mpn != expected_mpn:
                    errors.append({'type': 'schematic_mpn_' + label, 'ref': ref,
                                   'actual': actual_mpn, 'expected': expected_mpn})
            schematic_dnp = 'dnp' in schematic_properties
            if schematic_dnp != bool(part.get('dnp', False)):
                errors.append({'type': 'schematic_dnp', 'ref': ref, 'actual': schematic_dnp,
                               'expected': bool(part.get('dnp', False))})
    for label, refs in [('native', set(native)), ('schematic', set(schematic_components))]:
        for ref in sorted(set(parts) - refs):
            errors.append({'type': 'metadata_ref_missing_' + label, 'ref': ref})
        for ref in sorted(refs - set(parts)):
            errors.append({'type': label + '_ref_missing_metadata', 'ref': ref})
    for ref, pin in sorted(set(schematic_nets) - unique_pins):
        errors.append({'type': 'schematic_pin_missing_native_pad', 'ref': ref, 'pin': pin})
    # Circuit-specific critical assignments independently recorded in the
    # manufacturer audit. These guard against matching-but-wrong regenerated maps.
    # PN532 source mapping retained; explicitly approved reset-gate additions.
    critical = {'U2': {'23': '3V3', '38': 'NFC_RESET_N', '40': 'NFC_VBAT', '41': 'GND'},
                'U1': {'20': 'USB_LIMITED', '21': 'NFC_RESET_N', '26': 'MCU_USB_DM', '27': 'MCU_USB_DP'},
                'U5': {'1': 'USB_DM', '6': 'USB_DM', '3': 'USB_DP', '4': 'USB_DP', '2': 'GND', '5': 'VBUS'},
                'U6': {'3': 'GND', '7': 'USB_LIMITED', '10': 'GND', '11': 'GND', '12': '3V3'},
                'U7': {'2': 'USB_LIMITED', '3': 'GND', '4': 'USB_HIGH_CURRENT', '5': '3V3'},
                'U3': {'4': 'GND', '5': 'USB_HIGH_CURRENT', '6': 'GND', '17': 'GND'},
                'U4': {'10': '3V3', '11': 'GND'}, 'R19': {'1':'NFC_RESET_N','2':'GND'}, 'U8': {'1':'GND','2':'GND','3':'ESP_RESET_RC','4':'ESP_EN','5':'3V3','6':'POWER_PERMIT'}, 'R12': {'1':'ESP_RESET_RC','2':'POWER_PERMIT'}, 'C9': {'1':'ESP_RESET_RC','2':'GND'}, 'SW1': {'1':'ESP_RESET_RC','2':'ESP_RESET_RC','3':'GND','4':'GND'}, 'J4': {'1':'GND','2':'3V3','3':'UART_TX','4':'UART_RX','5':'ESP_RESET_RC','6':'BOOT_IO9'}, 'JP1': {'1':'USB_HIGH_CURRENT','2':'POWER_PERMIT','3':'3V3'}, 'R29': {'1':'ESP_EN','2':'GND'}, 'R30': {'1':'POWER_PERMIT','2':'GND'}, 'C38': {'1':'3V3','2':'GND'}}
    for ref, pins in critical.items():
        for pin, expected in pins.items():
            actual = net_by_pin.get((ref, pin))
            if actual != expected:
                errors.append({'type': 'manufacturer_audit_critical_net', 'ref': ref, 'pin': pin,
                               'actual': actual, 'expected': expected})
    if any(path.read_bytes() != snapshots[key] for key, path in inputs.items()):
        errors.append({'type': 'input_changed_during_audit'})
    result = {'status': 'PASS_NATIVE_PIN_METADATA_PARITY' if not errors else 'FAIL_NATIVE_PIN_METADATA_PARITY',
              'inputs': {key: {'path': str(path), 'sha256': sha(snapshots[key])} for key, path in inputs.items()},
              'footprints_checked': len(native), 'numbered_physical_pads_checked': pad_count,
              'unique_ref_pin_pairs': len(unique_pins), 'errors': errors,
              'normalization': 'Empty and explicit unconnected-* nets are NC; every repeated numbered physical pad is checked',
              'limitation': 'Electrical/MPN/value/DNP parity only. Does not prove routing, pad land pattern, stencil or hardware function; use manufacturer audit and final native DRC separately.'}
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return 0 if not errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
