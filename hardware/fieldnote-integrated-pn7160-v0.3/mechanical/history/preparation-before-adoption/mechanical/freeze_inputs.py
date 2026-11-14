"""Reject unfrozen PN7160 geometry before any mechanical result is written.

native-freeze.json is created only after the hardware owner explicitly adopts
the native board/design revision. The catalog is preparation evidence, not a
placement freeze. This helper never creates an adoption record itself.
"""
from pathlib import Path
import hashlib
import json


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require_owner_freeze(root):
    root = Path(root)
    path = root / 'mechanical/native-freeze.json'
    if not path.exists():
        raise RuntimeError('PN7160 mechanical audit is NOT RUN: await explicit owner-adopted native freeze and final 78-part dimensions.')
    record = json.loads(path.read_text())
    assert record['status'] == 'OWNER_ADOPTED_NATIVE_FREEZE', 'Owner adoption is required before the PN7160 fit audit.'
    assert record['variant'] == 'PN7160_v03'
    assert record.get('owner_authorization'), 'Record the explicit hardware-owner adoption message.'
    sources = record['source_sha256']
    assert {'fieldnote.kicad_pcb', 'design-data.json'} <= set(sources)
    for name, expected in sources.items():
        member = (root / name).resolve()
        assert member.is_relative_to(root.resolve()), 'Freeze inputs must reside in the PN7160 project.'
        assert sha256(member) == expected, 'Adopted freeze changed: ' + name
    return record, dict(sources, **{'mechanical/native-freeze.json': sha256(path)})


def assert_unchanged(root, sources):
    for name, expected in sources.items():
        assert sha256(Path(root) / name) == expected, 'Mechanical input changed during audit: ' + name
