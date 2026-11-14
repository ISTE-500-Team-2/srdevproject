"""Freeze actual KiCad placements, pad rectangles and drill sizes; never save CAD.

Run with KiCad's bundled Python/pcbnew. Millimeters are relative to the board
origin (60, 50); native integer nanometers are retained for exact comparison.
"""
from pathlib import Path
import collections
import hashlib
import json
import sys
import pcbnew

ROOT=Path(__file__).resolve().parents[1]
ORIGIN_NM=(60_000_000,50_000_000)
sys.path.insert(0,str(ROOT))
import build_design as d


def xy(point):
    return [(point.x-ORIGIN_NM[0])/1e6,(point.y-ORIGIN_NM[1])/1e6]


def main():
    inputs=[ROOT/'fieldnote.kicad_pcb',ROOT/'design-data.json']
    source=inputs[0].read_bytes()
    hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
    hashes['fieldnote.kicad_pcb']=hashlib.sha256(source).hexdigest()
    board=pcbnew.LoadBoard(str(inputs[0]))
    footprints=[]
    for fp in sorted(board.GetFootprints(),key=lambda f:f.GetReference()):
        pads=[]
        for pad in fp.Pads():
            position=pad.GetPosition();size=pad.GetSize();drill=pad.GetDrillSize()
            pads.append(dict(number=pad.GetNumber(),position_native_nm=[position.x,position.y],
                center_board_mm=xy(position),size_mm=[size.x/1e6,size.y/1e6],
                angle_board_deg=pad.GetOrientationDegrees(),shape=int(pad.GetShape()),
                attribute=int(pad.GetAttribute()),drill_size_mm=[drill.x/1e6,drill.y/1e6],
                drill_shape=int(pad.GetDrillShape()),
                layers=[board.GetLayerName(layer) for layer in pad.GetLayerSet().Seq()]))
        footprints.append(dict(ref=fp.GetReference(),value=fp.GetValue(),
            footprint=str(fp.GetFPID().GetLibItemName()),center_board_mm=xy(fp.GetPosition()),
            position_native_nm=[fp.GetPosition().x,fp.GetPosition().y],
            angle_board_deg=fp.GetOrientationDegrees(),pads=pads))
    vias=[]
    for track in board.GetTracks():
        if isinstance(track,pcbnew.PCB_VIA):
            position=track.GetPosition()
            vias.append(dict(position_native_nm=[position.x,position.y],center_board_mm=xy(position),
                drill_diameter_mm=track.GetDrillValue()/1e6,diameter_F_Cu_mm=track.GetWidth(pcbnew.F_Cu)/1e6))
    # Cross-check the text parser used by the solid audit against pcbnew's
    # actual world-space geometry, including every native pad and drill.
    native=d.readsex(source.decode())
    parsed_pads=collections.Counter()
    for fp in d.children(native,'footprint'):
        ref=next(d.unq(v[2]) for v in d.children(fp,'property') if d.unq(v[1])=='Reference')
        at=d.child(fp,'at');pose=dict(xy=[float(at[1]),float(at[2])],angle=float(at[3]) if len(at)>3 else 0)
        for pad in d.children(fp,'pad'):
            pat=d.child(pad,'at');sz=d.child(pad,'size');dr=d.child(pad,'drill')
            center=d.transform(float(pat[1]),float(pat[2]),pose)
            drill=([float(dr[2]),float(dr[3])] if dr and dr[1]=='oval' else
                   ([float(dr[1])]*2 if dr else [0,0]))
            parsed_pads[(ref,d.unq(pad[1]),*(round(v*1e6) for v in center),
                *(round(float(v)*1e6) for v in sz[1:3]),
                round((float(pat[3]) if len(pat)>3 else 0)%360,5),
                *(round(v*1e6) for v in drill))]+=1
    actual_pads=collections.Counter((fp['ref'],pad['number'],*pad['position_native_nm'],
        *(round(v*1e6) for v in pad['size_mm']),round(pad['angle_board_deg']%360,5),
        *(round(v*1e6) for v in pad['drill_size_mm'])) for fp in footprints for pad in fp['pads'])
    parsed_vias=collections.Counter((round(float(d.child(v,'at')[1])*1e6),
        round(float(d.child(v,'at')[2])*1e6),round(float(d.child(v,'drill')[1])*1e6))
        for v in d.children(native,'via'))
    actual_vias=collections.Counter((*v['position_native_nm'],round(v['drill_diameter_mm']*1e6)) for v in vias)
    parser_agrees=parsed_pads==actual_pads and parsed_vias==actual_vias
    unchanged=all(hashlib.sha256(p.read_bytes()).hexdigest()==hashes[str(p.relative_to(ROOT))] for p in inputs)
    result=dict(method='KiCad pcbnew actual native board geometry; read only, no CAD save',
        kicad_version=pcbnew.Version(),source_sha256=hashes,source_unchanged_during_check=unchanged,
        status=('FAIL_INPUT_CHANGED_DURING_CHECK' if not unchanged else
            ('PASS_NATIVE_EXTRACTION' if parser_agrees else 'FAIL_NATIVE_PARSER_GEOMETRY')),
        solid_audit_parser_matches_native_pads_and_drills=parser_agrees,
        parser_pad_mismatches=dict(extra=list((parsed_pads-actual_pads).elements()),missing=list((actual_pads-parsed_pads).elements())),
        parser_via_mismatches=dict(extra=list((parsed_vias-actual_vias).elements()),missing=list((actual_vias-parsed_vias).elements())),
        native_origin_mm=[60,50],board_thickness_mm=board.GetDesignSettings().GetBoardThickness()/1e6,
        footprints_count=len(footprints),pads_count=sum(len(fp['pads']) for fp in footprints),
        through_pad_drills_count=sum(any(p['drill_size_mm']) for fp in footprints for p in fp['pads']),
        via_drills_count=len(vias),footprints=footprints,vias=vias)
    (ROOT/'mechanical/native-geometry.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ('footprints','vias')},indent=2))
    assert unchanged,'Native board or metadata changed while extracting geometry.'
    assert parser_agrees,'Solid-audit text parser disagrees with actual native pad/drill geometry.'


if __name__=='__main__':
    main()
