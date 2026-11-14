"""Reviewed-scope PN532 decoupling locality candidate; never writes live by default.

Only C14/C15/C31 placement and explicitly owned PN3V/RX/receive-takeoff
conductors change. Existing USB, other placements, ground stitches and rule
areas are preserved. Native DRC must pass before the root agent uses --apply.
"""
from pathlib import Path
import argparse, hashlib, json, math, shutil
import pcbnew as k
import wx
from apply_routed_rf_refinements import xy, vec, automatic_path, multi_path
from apply_silkscreen_cleanup import immutable

ROOT=Path(__file__).resolve().parent
SOURCE_SHA='d3b40561762a160dd011637c7e1eb2a7159fc39b4d4f89d2df58d7c0fe9634f7'

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()

def conductor(b,t):
    row=dict(uuid=str(t.m_Uuid.AsString()),net=t.GetNetname(),locked=t.IsLocked())
    if isinstance(t,k.PCB_VIA):
        row.update(kind='via',xy=xy(t.GetPosition()),diameter_mm=k.ToMM(t.GetWidth(k.F_Cu)),
            drill_mm=k.ToMM(t.GetDrillValue()),tented_front_back=True)
    else:row.update(kind='track',layer=b.GetLayerName(t.GetLayer()),a=xy(t.GetStart()),b=xy(t.GetEnd()),width_mm=k.ToMM(t.GetWidth()))
    return row

def apply_reviewed(target,manifest_path):
    """Selectively integrate exactly the frozen, zero-finding candidate IDs."""
    m=json.loads(manifest_path.read_text());candidate=manifest_path.parent/'fieldnote.kicad_pcb'
    assert sha(target)==m['source_sha256'],'Live base changed'
    assert sha(candidate)==m['candidate_sha256'],'Reviewed candidate changed'
    drc_path=manifest_path.parent/'drc.json';assert sha(drc_path)==m['drc_sha256'],'Candidate DRC changed'
    d=json.loads(drc_path.read_text());assert not any(d[n] for n in ['violations','unconnected_items','schematic_parity'])
    b=k.LoadBoard(str(target));c=k.LoadBoard(str(candidate));before=immutable(b)
    # Manifest coordinates come from integer-nanometre native objects. Round
    # them back to that integer grid rather than truncate a binary float.
    native_vec=lambda p:k.VECTOR2I(round((p[0]+60)*1e6),round((p[1]+50)*1e6))
    changed={r['uuid'] for r in m['removed']+m['added']};moved=set(m['moved_components'])
    assert moved=={'C14','C15','C31','TP5'}
    def stable(data):return ([f for f in data[0] if f[0] not in moved],sorted([t for t in data[1] if t[0] not in changed]),data[2],data[3])
    assert stable(immutable(c))==stable(before),'Candidate changed unrelated copper, placements, edges or zones'
    assert all(r['net'] in {'PN3V','NFC_RX','RF_RX_COUPLED','RF2_FILTER','NFC_RESET_N'} for r in m['removed'])
    assert all(r['net'] in {'PN3V','NFC_RX','RF_RX_COUPLED','RF2_FILTER','NFC_RESET_N','GND'} for r in m['added'])
    fs=list(b.GetFootprints());cf=list(c.GetFootprints());fps={f.GetReference():f for f in fs};cps={f.GetReference():f for f in cf}
    assert all((f.GetValue(),f.GetFieldText('MPN'),f.GetFPID().GetLibNickname(),f.GetFPID().GetLibItemName())==
        (cps[r].GetValue(),cps[r].GetFieldText('MPN'),cps[r].GetFPID().GetLibNickname(),cps[r].GetFPID().GetLibItemName()) for r,f in fps.items())
    for ref,row in m['moved_components'].items():
        f=fps[ref];assert [xy(f.GetPosition()),f.GetOrientationDegrees()]==row['before']
        f.SetPosition(native_vec(row['after'][0]));f.SetOrientationDegrees(row['after'][1])
    for ref in ['C14','C15','C20']:fps[ref].Reference().SetVisible(False)
    tracks={str(t.m_Uuid.AsString()):t for t in b.GetTracks()};removed=[];added=[]
    for row in m['removed']:
        t=tracks[row['uuid']];assert conductor(b,t)==row
        b.Remove(t);removed.append(t)
    for row in m['added']:
        assert row['uuid'] not in tracks
        if row['kind']=='via':
            t=k.PCB_VIA(b);t.SetPosition(native_vec(row['xy']));t.SetWidth(k.FromMM(row['diameter_mm']));t.SetDrill(k.FromMM(row['drill_mm']))
            t.SetViaType(k.VIATYPE_THROUGH);t.SetLayerPair(k.F_Cu,k.B_Cu)
            t.SetFrontTentingMode(k.TENTING_MODE_TENTED);t.SetBackTentingMode(k.TENTING_MODE_TENTED)
        else:
            t=k.PCB_TRACK(b);t.SetStart(native_vec(row['a']));t.SetEnd(native_vec(row['b']));t.SetWidth(k.FromMM(row['width_mm']));t.SetLayer(b.GetLayerID(row['layer']))
        t.SetUuid(k.KIID(row['uuid']));t.SetNet(b.FindNet(row['net']));t.SetLocked(row['locked']);b.Add(t);added.append(t)
    assert stable(immutable(b))==stable(before),'Integration changed unrelated geometry'
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones())
    def normalized(data):return (sorted(data[0]),sorted(data[1]),data[2],data[3])
    assert normalized(immutable(b))==normalized(immutable(c)),'Integration geometry differs from frozen candidate'
    backup=ROOT/'output'/('pn-local-caps-base-'+m['source_sha256'][:12]+'.kicad_pcb')
    if backup.exists():assert sha(backup)==m['source_sha256']
    else:backup.write_bytes(target.read_bytes())
    # Geometric selective integration was proved equal to the frozen board.
    # Retain that reviewed native fill exactly: refilling identical geometry
    # can serialize the polygon contours in a different traversal order.
    target.write_bytes(candidate.read_bytes())
    result=dict(status='APPLIED_REQUIRES_NATIVE_DRC',source_sha256=m['source_sha256'],board_sha256=sha(target),
        candidate_sha256=m['candidate_sha256'],removed=len(removed),added=len(added),manifest_sha256=sha(manifest_path),unrelated_geometry_preserved=True)
    (target.parent/'pn-local-caps-integration.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

def apply(b):
    old=list(b.GetTracks());removed=[];made=[];auto=[]
    fs=list(b.GetFootprints());refs={f.GetReference():f for f in fs}
    before={r:(xy(f.GetPosition()),f.GetOrientationDegrees()) for r,f in refs.items()}
    def rm(t): b.Remove(t);removed.append(t)
    def same(a,c):return math.dist(a,c)<1e-5
    def via(net,p):
        v=k.PCB_VIA(b);v.SetPosition(vec(p));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2))
        v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet(net));v.SetLocked(True)
        v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED)
        b.Add(v);made.append(v)
    def route(net,ps,width,layer):
        for a,c in zip(ps,ps[1:]):
            if math.dist(a,c)<1e-7:continue
            t=k.PCB_TRACK(b);t.SetStart(vec(a));t.SetEnd(vec(c));t.SetNet(b.FindNet(net));t.SetLayer(b.GetLayerID(layer));t.SetWidth(k.FromMM(width));t.SetLocked(True)
            b.Add(t);made.append(t)
    def path(net,a,c,width,layers,bounds):
        if layers==['MULTI']:
            legs,vs=multi_path(b,net,a,c,width,bounds)
            for layer,ps in legs:route(net,ps,width,layer)
            for p in vs:via(net,p)
            auto.append(dict(net=net,legs=legs,via_positions=vs))
        else:
            length,layer,ps=automatic_path(b,net,a,c,width,layers,bounds)
            route(net,ps,width,layer);auto.append(dict(net=net,length_mm=length,layer=layer,points=ps))
        print(json.dumps(auto[-1]),flush=True)
    # Match the source placements to guard against applying to an unrelated PCB.
    assert before['C14']==([47.45,21.5],90.0),before['C14']
    assert before['C15']==([47.5,25.7],90.0),before['C15']
    assert before['C31']==([38.75,17.0],0.0),before['C31']
    for ref,pos,angle in [('C14',[40.95,17.5],90),('C15',[37.95,17.0],0),('C31',[47.5,25.7],90),('TP5',[42,15.25],0)]:
        refs[ref].SetPosition(vec(pos));refs[ref].SetOrientationDegrees(angle)
    # Only copper pads identify these tiny local caps in assembly outputs;
    # remove the two displaced silk labels that otherwise cover their lands.
    refs['C14'].Reference().SetVisible(False);refs['C15'].Reference().SetVisible(False)
    refs['C20'].Reference().SetVisible(False)
    # The replaced branch contains all PN3V back conductors and only the two
    # removed capacitor escape vias plus the one former layer-change via.
    for t in old:
        n=t.GetNetname();a,c=xy(t.GetStart()),xy(t.GetEnd());isv=isinstance(t,k.PCB_VIA)
        layer=b.GetLayerName(t.GetLayer())
        if n=='PN3V' and ((isv and any(same(a,p) for p in [[46.7,22.45],[46.7,26.475],[46.35,25.75]])) or
            (not isv and (layer=='B.Cu' or (layer=='In2.Cu' and min(a[0],c[0])>46.3) or
              (layer=='F.Cu' and any(same(a,p) or same(c,p) for p in [[47.45,22.45],[47.5,26.475]]))))):rm(t)
        # Retain chip fine escape, R24 local branch, and their connecting In2
        # route. Replace only the old long RX branch to displaced C31.
        if n=='NFC_RX' and ((not isv and layer=='B.Cu') or
            (isv and same(a,[35.476,16.829])) or
            (not isv and layer=='F.Cu' and max(a[1],c[1])<18)):rm(t)
        if n=='RF_RX_COUPLED':rm(t)
        if n=='RF2_FILTER' and ((isv and same(a,[36.9084,17.4181])) or
            (not isv and ((layer=='F.Cu' and max(a[1],c[1])<18) or layer=='In2.Cu'))):rm(t)
        if n=='NFC_RESET_N' and not isv and layer=='F.Cu' and ((same(a,[41.9936,17]) and same(c,[38.98,20.0136])) or (same(c,[41.9936,17]) and same(a,[38.98,20.0136]))):rm(t)
        if n=='NFC_RESET_N' and not isv and layer=='F.Cu' and ((same(a,[42,15.5]) and same(c,[42,16.2267])) or (same(c,[42,15.5]) and same(a,[42,16.2267]))):rm(t)
    # DVDD 100nF uses a tented ordinary via beside the capacitor. Drill remains
    # outside both solder-paste apertures; no filled-via cost is needed.
    route('PN3V',[[40.95,18.45],[40.554,19.1153]],.2,'F.Cu')
    via('PN3V',[36.55,17.8]);route('PN3V',[[37.175,17],[36.55,17.625],[36.55,17.8]],.2,'F.Cu')
    path('PN3V',[38.25,21.05],[36.55,17.8],.2,['B.Cu','In2.Cu'],[36.2,17.3,39.4,21.5])
    route('NFC_RESET_N',[[42,15.25],[42,16.2267]],.15,'F.Cu')
    via('NFC_RESET_N',[42.2,17.9]);route('NFC_RESET_N',[[41.9936,17],[42.2,17.9]],.15,'F.Cu')
    path('NFC_RESET_N',[42.2,17.9],[39.35,20.95],.15,['B.Cu','In2.Cu'],[38.5,17.4,43,21.5])
    # Move the high-impedance receive takeoff clear of the local bypass. Keep
    # RF2's power/filter/matching paths untouched.
    via('RF2_FILTER',[37.625,14.2]);route('RF2_FILTER',[[37.325,15.25],[37.325,14.5],[37.625,14.2]],.15,'F.Cu')
    path('RF2_FILTER',[37.625,14.2],[35.2455,29.7452],.15,['In2.Cu','B.Cu'],[33.8,13.8,39,30.2])
    # The receive capacitor moves closer to the PN532 RX pin, using vacant
    # space left by C15. Ordinary tented escape vias stay outside paste.
    via('NFC_RX',[46.7,26.475]);route('NFC_RX',[[47.5,26.475],[46.7,26.475]],.15,'F.Cu')
    path('NFC_RX',[37.1,27.8],[46.7,26.475],.15,['MULTI'],[36.3,25.5,47.2,31.8])
    via('RF_RX_COUPLED',[35.675,14.3]);route('RF_RX_COUPLED',[[35.675,15.25],[35.675,14.3]],.15,'F.Cu')
    via('RF_RX_COUPLED',[46.7,22.45]);path('RF_RX_COUPLED',[47.5,24.925],[46.7,22.45],.15,['F.Cu'],[46,21.8,48.3,25.2])
    path('RF_RX_COUPLED',[35.675,14.3],[46.7,22.45],.15,['B.Cu','In2.Cu'],[34,13.5,48.2,27])
    # Local ground stitches return both moved bypass caps to the internal
    # reference near their pads. The third restores C21's new small F island.
    # Existing ground conductors and all antenna/reference rule areas remain.
    for p in [[39.9,15.8],[39.6,17.7],[43,16.1]]:via('GND',p)
    route('GND',[[40.95,16.55],[39.9,15.8]],.25,'F.Cu')
    route('GND',[[38.725,17],[39.6,17.7]],.25,'F.Cu')
    after={r:(xy(f.GetPosition()),f.GetOrientationDegrees()) for r,f in refs.items()}
    assert all(before[r]==after[r] for r in before if r not in ['C14','C15','C31','TP5'])
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones())
    return dict(moved_components={r:dict(before=before[r],after=after[r]) for r in ['C14','C15','C31','TP5']},
        silk_changes=dict(C14='reference hidden',C15='reference hidden',C20='reference hidden'),
        removed_count=len(removed),added_count=len(made),touched_nets=sorted({t.GetNetname() for t in removed+made}),
        automatic_routes=auto),old,removed,made,fs

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=ROOT/'fieldnote.kicad_pcb');ap.add_argument('--apply',type=Path)
    ap.add_argument('--manifest',type=Path,default=ROOT/'output/pn-local-caps-candidate/pn-local-caps-patch.json')
    ap.add_argument('--output',type=Path,default=ROOT/'output/pn-local-caps-candidate');args=ap.parse_args()
    app=wx.App(False)
    if args.apply:apply_reviewed(args.apply.resolve(),args.manifest.resolve());return
    source=args.source;bb=source.read_bytes();source_sha=hashlib.sha256(bb).hexdigest()
    assert source_sha==SOURCE_SHA,(source_sha,SOURCE_SHA)
    b=k.LoadBoard(str(source));result,old,removed,made,fs=apply(b)
    if args.apply:target=source
    else:
        args.output.mkdir(parents=True,exist_ok=True)
        for p in source.parent.iterdir():
            if p.is_file() and (p.suffix in ['.kicad_pro','.kicad_sch','.kicad_sym','.kicad_dru'] or p.name in ['fp-lib-table','sym-lib-table']):shutil.copy2(p,args.output/p.name)
        for name in ['Fieldnote.pretty','fieldnote.pretty']:
            if (source.parent/name).exists():shutil.copytree(source.parent/name,args.output/name,dirs_exist_ok=True)
        target=args.output/'fieldnote.kicad_pcb'
    k.SaveBoard(str(target),b)
    result.update(source_path=str(source),source_sha256=source_sha,candidate_path=str(target),candidate_sha256=hashlib.sha256(target.read_bytes()).hexdigest(),status='CANDIDATE_REQUIRES_NATIVE_DRC')
    (target.parent/'pn-local-caps-patch.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

if __name__=='__main__':main()
