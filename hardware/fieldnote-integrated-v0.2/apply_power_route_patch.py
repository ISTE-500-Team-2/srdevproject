"""Apply only the reviewed power-conductor manifest to its exact base board.

The quoted snapshot is immutable and is never changed. Native DRC/parity must
be rerun on the resulting live board before it is used in a release package.
"""
import argparse
import hashlib
import json
from pathlib import Path

import pcbnew as k
import wx
from apply_silkscreen_cleanup import immutable

ROOT = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def xy(v):
    return [round(k.ToMM(v.x) - 60, 6), round(k.ToMM(v.y) - 50, 6)]


def vec(p):
    return k.VECTOR2I(k.FromMM(p[0] + 60), k.FromMM(p[1] + 50))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    target = args.board.resolve()
    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text())
    assert sha(target) == manifest['base_board_sha256'], 'Power patch base changed'
    candidate = manifest_path.parent / 'fieldnote.kicad_pcb'
    assert sha(candidate) == manifest['candidate_board_sha256'], 'Candidate changed'
    drc = json.loads((manifest_path.parent / 'drc.json').read_text())
    assert not drc['violations'] and not drc['unconnected_items'] and not drc['schematic_parity'], 'Candidate has findings'
    changed = {r['uuid'] for r in manifest['removed'] + manifest['added']}
    assert len(changed) == len(manifest['removed']) + len(manifest['added'])
    assert all(r['net'] in {'VBUS', 'VSYS'} for r in manifest['removed'] + manifest['added'])
    app = wx.App(False)
    board = k.LoadBoard(str(target))
    before = immutable(board)

    def stable(data):
        return (data[0], [t for t in data[1] if t[0] not in changed], data[2], data[3])

    candidate_board = k.LoadBoard(str(candidate))
    assert stable(immutable(candidate_board)) == stable(before), 'Candidate changes unrelated geometry'
    tracks = {str(t.m_Uuid.AsString()): t for t in board.GetTracks()}
    removed_proxies = []
    for row in manifest['removed']:
        t = tracks[row['uuid']]
        assert not isinstance(t, k.PCB_VIA)
        assert t.GetNetname() == row['net'] and board.GetLayerName(t.GetLayer()) == row['layer']
        assert xy(t.GetStart()) == row['a'] and xy(t.GetEnd()) == row['b']
        assert abs(k.ToMM(t.GetWidth()) - row['width_mm']) < 1e-6
        board.Remove(t)
        removed_proxies.append(t)
    for row in manifest['added']:
        assert row['uuid'] not in tracks, 'Addition already exists'
        if row['kind'] == 'via':
            t = k.PCB_VIA(board)
            t.SetPosition(vec(row['xy']))
            t.SetWidth(k.FromMM(row['diameter_mm']))
            t.SetDrill(k.FromMM(row['drill_mm']))
            t.SetViaType(k.VIATYPE_THROUGH)
            t.SetLayerPair(k.F_Cu, k.B_Cu)
            assert row['tented_front_back']
            t.SetFrontTentingMode(k.TENTING_MODE_TENTED)
            t.SetBackTentingMode(k.TENTING_MODE_TENTED)
        else:
            assert row['kind'] == 'track'
            t = k.PCB_TRACK(board)
            t.SetStart(vec(row['a']))
            t.SetEnd(vec(row['b']))
            t.SetLayer(board.GetLayerID(row['layer']))
            t.SetWidth(k.FromMM(row['width_mm']))
        t.SetUuid(k.KIID(row['uuid']))
        t.SetNet(board.FindNet(row['net']))
        t.SetLocked(True)
        board.Add(t)
    assert stable(immutable(board)) == stable(before), 'Patch changed unrelated geometry'
    board.BuildConnectivity()
    assert k.ZONE_FILLER(board).Fill(board.Zones())
    assert stable(immutable(board)) == stable(before), 'Refill changed unrelated geometry'
    def normalized(data):
        # Save/load orders conductors by UUID; in-memory additions are appended.
        return (data[0], sorted(data[1], key=lambda item: item[0]), data[2], data[3])

    assert normalized(immutable(board)) == normalized(immutable(candidate_board)), 'Applied conductors differ from reviewed candidate'
    backup = ROOT / 'output' / ('power-patch-base-' + manifest['base_board_sha256'][:12] + '.kicad_pcb')
    if backup.exists():
        assert sha(backup) == manifest['base_board_sha256']
    else:
        backup.write_bytes(target.read_bytes())
    k.SaveBoard(str(target), board)
    result = {'status': 'APPLIED_REQUIRES_NATIVE_DRC', 'board': str(target),
              'source_sha256': manifest['base_board_sha256'], 'board_sha256': sha(target),
              'manifest_sha256': sha(manifest_path), 'removed': len(manifest['removed']),
              'added': len(manifest['added']), 'unrelated_geometry_preserved': True,
              'quoted_snapshot_unchanged': True}
    (ROOT / 'output' / 'power-patch-integration.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
