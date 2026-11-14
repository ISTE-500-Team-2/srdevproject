"""KiCad pcbnew extraction for explicitly adopted hashes; read-only CAD access."""
from pathlib import Path
import argparse
import hashlib
import json
import pcbnew as k

ROOT=Path(__file__).resolve().parents[1]
ORIGIN=(60_000_000,50_000_000)


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def xy(p):return [(p.x-ORIGIN[0])/1e6,(p.y-ORIGIN[1])/1e6]


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--board-sha256',required=True);ap.add_argument('--design-sha256',required=True)
    args=ap.parse_args()
    bp=ROOT/'fieldnote.kicad_pcb';dp=ROOT/'design-data.json'
    assert sha(bp)==args.board_sha256 and sha(dp)==args.design_sha256
    b=k.LoadBoard(str(bp));fps=[]
    for f in sorted(b.GetFootprints(),key=lambda f:f.GetReference()):
        pads=[]
        for p in f.Pads():
            pos=p.GetPosition();sz=p.GetSize();dr=p.GetDrillSize()
            layers=[b.GetLayerName(layer) for layer in p.GetLayerSet().Seq()]
            pm=p.GetSolderPasteMargin(k.F_Paste) if 'F.Paste' in layers else None
            pads.append(dict(number=p.GetNumber(),center_board_mm=xy(pos),position_native_nm=[pos.x,pos.y],
                size_mm=[sz.x/1e6,sz.y/1e6],drill_size_mm=[dr.x/1e6,dr.y/1e6],
                angle_board_deg=p.GetOrientationDegrees(),shape=int(p.GetShape()),
                shape_name='rectangle' if p.GetShape()==k.PAD_SHAPE_RECT else str(p.GetShape()),
                attribute=int(p.GetAttribute()),layers=layers,net=p.GetNetname(),
                effective_front_paste_margin_each_side_mm=[pm.x/1e6,pm.y/1e6] if pm else None,
                front_mask_expansion_mm=p.GetSolderMaskExpansion(k.F_Mask)/1e6 if 'F.Mask' in layers else None))
        fps.append(dict(ref=f.GetReference(),value=f.GetValue(),mpn=f.GetFieldText('MPN'),
            footprint=str(f.GetFPID().GetLibItemName()),native_layer=b.GetLayerName(f.GetLayer()),
            native_dnp=bool(f.GetAttributes() & k.FP_DNP),
            center_board_mm=xy(f.GetPosition()),position_native_nm=[f.GetPosition().x,f.GetPosition().y],
            angle_board_deg=f.GetOrientationDegrees(),pads=pads))
    settings=b.GetDesignSettings();vias=[]
    modes={int(k.TENTING_MODE_FROM_BOARD):'from_board',int(k.TENTING_MODE_TENTED):'tented',int(k.TENTING_MODE_NOT_TENTED):'not_tented'}
    for t in b.GetTracks():
        if not isinstance(t,k.PCB_VIA):continue
        fm=int(t.GetFrontTentingMode());bm=int(t.GetBackTentingMode())
        assert fm in modes and bm in modes
        vias.append(dict(center_board_mm=xy(t.GetPosition()),position_native_nm=[t.GetPosition().x,t.GetPosition().y],
            drill_diameter_mm=t.GetDrillValue()/1e6,diameter_F_Cu_mm=t.GetWidth(k.F_Cu)/1e6,
            net=t.GetNetname(),front_tenting_mode=modes[fm],back_tenting_mode=modes[bm],
            effective_front_tented=bool(settings.m_TentViasFront) if fm==int(k.TENTING_MODE_FROM_BOARD) else fm==int(k.TENTING_MODE_TENTED),
            effective_back_tented=bool(settings.m_TentViasBack) if bm==int(k.TENTING_MODE_FROM_BOARD) else bm==int(k.TENTING_MODE_TENTED),
            front_covering_mode=int(t.GetFrontCoveringMode()),back_covering_mode=int(t.GetBackCoveringMode()),
            front_plugging_mode=int(t.GetFrontPluggingMode()),back_plugging_mode=int(t.GetBackPluggingMode()),
            filling_mode=int(t.GetFillingMode()),capping_mode=int(t.GetCappingMode())))
    assert sha(bp)==args.board_sha256 and sha(dp)==args.design_sha256,'Input changed during extraction'
    result=dict(schema_version=1,status='NATIVE_EXTRACTION_ONLY_NO_PLACEMENT_PASS',
        method='KiCad pcbnew read-only; no save/refill; explicitly supplied adopted final hashes.',kicad_version=k.Version(),
        source_board_sha256=args.board_sha256,source_design_data_sha256=args.design_sha256,
        extractor_sha256=sha(Path(__file__)),native_origin_mm=[60,50],source_unchanged_during_check=True,
        board_thickness_mm=settings.GetBoardThickness()/1e6,
        board_default_tent_vias_front=bool(settings.m_TentViasFront),board_default_tent_vias_back=bool(settings.m_TentViasBack),
        footprints=fps,vias=vias)
    p=ROOT/'manufacturing/v03-clearance-native-geometry.json';p.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(output=str(p),sha256=sha(p),footprints=len(fps),vias=len(vias)),indent=2))


if __name__=='__main__':main()
