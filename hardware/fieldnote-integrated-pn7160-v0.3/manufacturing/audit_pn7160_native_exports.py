#!/usr/bin/env python3
"""Read-only PN7160 native-export identity, drill, EP Gerber and table QA.

This parses the actual Gerber/Excellon output. It is a scoped numerical export
check, not a complete renderer or assembler process/physical qualification.
"""
import argparse,collections,csv,hashlib,json,math,re
from pathlib import Path
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()

def gerber(path):
    text=path.read_text();assert '%MOMM*%' in text and '%FSLAX46Y46*%' in text
    apertures={int(a):(shape,params) for a,shape,params in re.findall(r'%ADD(\d+)([^,*]+)(?:,([^*]*))?\*%',text)}
    flashes=[];x=y=0;tool=None;component=pad=None
    for line in text.splitlines():
        if line.startswith('%TO.C,'):component=line[6:-2]
        if line.startswith('%TO.P,'):
            v=line[6:-2].split(',');component=v[0];pad=v[1]
        if line=='%TD*%':component=pad=None
        m=re.fullmatch(r'D(\d+)\*',line)
        if m:tool=int(m[1]);continue
        m=re.fullmatch(r'(?:X(-?\d+))?(?:Y(-?\d+))?D0([123])\*',line)
        if m:
            if m[1] is not None:x=int(m[1])/1e6
            if m[2] is not None:y=int(m[2])/1e6
            if m[3]=='3':flashes.append({'xy':[x,y],'tool':tool,'aperture':apertures[tool],'component':component,'pad':pad})
    return {'sha256':sha(path),'file_function':re.search(r'%TF.FileFunction,([^*]+)\*%',text)[1],'apertures':apertures,'flashes':flashes,'text':text}

def drill(path):
    text=path.read_text();assert 'METRIC' in text and 'G90' in text
    tools={int(a):float(b) for a,b in re.findall(r'^T(\d+)C([\d.]+)$',text,re.M)}
    records=[];tool=None;start=None
    for line in text.splitlines():
        m=re.fullmatch(r'T(\d+)',line)
        if m:tool=int(m[1]);continue
        m=re.fullmatch(r'(G00|G01)?X(-?[\d.]+)Y(-?[\d.]+)',line)
        if not m:continue
        xy=[float(m[2]),float(m[3])];diam=tools[tool]
        if m[1]=='G00':start=xy
        elif m[1]=='G01':
            assert start is not None
            center=[(a+b)/2 for a,b in zip(start,xy)];length=math.dist(start,xy)+diam
            records.append((round(center[0],5),round(center[1],5),round(diam,5),round(length,5)));start=None
        else:records.append((round(xy[0],5),round(xy[1],5),round(diam,5),round(diam,5)))
    return {'sha256':sha(path),'records':records,'tools_mm':tools}

def audit(root,package):
    manifest=json.loads((package/'MANIFEST.json').read_text())
    for n,h in manifest['source_input_sha256'].items():assert sha(root/n)==h,('live input changed',n)
    for n,r in manifest['files'].items():assert sha(package/n)==r['sha256'] and (package/n).stat().st_size==r['bytes'],n
    geometry=root/'manufacturing/v03-clearance-native-geometry-r3.json';native=json.loads(geometry.read_text());assert native['source_board_sha256']==manifest['board_sha256'];assert native['source_design_data_sha256']==manifest['design_sha256']
    bodymanifest=json.loads((root/'manufacturing/v03-placement-clearance-manifest.json').read_text());member=next(x for x in bodymanifest['files'] if x['path']==geometry.relative_to(root).as_posix());assert sha(geometry)==member['sha256']
    expected={'PTH':[],'NPTH':[]}
    for v in native['vias']:
        x,y=v['position_native_nm'];d=v['drill_diameter_mm'];expected['PTH'].append((round(x/1e6,5),round(-y/1e6,5),round(d,5),round(d,5)))
    for fp in native['footprints']:
        for p in fp['pads']:
            dx,dy=p['drill_size_mm']
            if dx<=0:continue
            x,y=p['position_native_nm'];kind='NPTH' if p['attribute']==3 else 'PTH';assert p['attribute'] in [0,3]
            expected[kind].append((round(x/1e6,5),round(-y/1e6,5),round(min(dx,dy),5),round(max(dx,dy),5)))
    drill_checks={}
    for kind in ['PTH','NPTH']:
        actual=drill(package/f'fabrication/drills/fieldnote-{kind}.drl')
        # KiCad decimal Excellon emits coordinates to 0.001 mm; match its
        # half-unit quantization while preserving one-to-one drill identity.
        unmatched=list(expected[kind]);maximum_coordinate_error=0
        for exported in actual['records']:
            matches=[r for r in unmatched if all(abs(a-b)<=.0005001 for a,b in zip(exported[:2],r[:2])) and exported[2:]==r[2:]]
            assert len(matches)==1,(kind+' drill geometry differs or is ambiguous',exported)
            matched=matches[0];unmatched.remove(matched)
            maximum_coordinate_error=max(maximum_coordinate_error,*(abs(a-b) for a,b in zip(exported[:2],matched[:2])))
        assert not unmatched,kind+' native drills omitted'
        drill_checks[kind]={'count':len(actual['records']),'slots':sum(r[2]!=r[3] for r in actual['records']),'minimum_diameter_mm':min(actual['tools_mm'].values()),'sha256':actual['sha256'],'every_native_center_and_diameter_or_slot_length_matches':True,'Excellon_coordinate_resolution_mm':.001,'maximum_coordinate_quantization_error_mm':maximum_coordinate_error}
    plots={p.stem:gerber(p) for p in (package/'fabrication/gerbers').glob('*.gbr')};assert len(plots)==10
    functions={p['file_function'] for p in plots.values()};assert {'Copper,L1,Top','Copper,L2,Inr','Copper,L3,Inr','Copper,L4,Bot','Profile,NP','Soldermask,Top','Soldermask,Bot','Paste,Top','Legend,Top','Legend,Bot'}==functions,functions
    review=json.loads((root/'manufacturing/v03-placement-clearance-review.json').read_text());ep=review['ep_assembly'];paste=plots['fieldnote-F_Paste'];actual=[]
    for flash in paste['flashes']:
        if flash['component']!='U2':continue
        shape,params=flash['aperture']
        if shape!='RoundRect':continue
        v=[float(x) for x in params.split('X')];radius=v[0];xs=v[1:9:2];ys=v[2:9:2];width=max(xs)-min(xs)+2*radius;height=max(ys)-min(ys)+2*radius
        if abs(width-1)<1e-6 and abs(height-1)<1e-6:
            actual.append((tuple(flash['xy']),radius));assert abs(radius-.227273)<1e-6
    expected_paste=[((round(p['center_board_mm'][0]+60,6),round(-(p['center_board_mm'][1]+50),6)),p['effective_corner_radius_mm']) for p in ep['ep_paste_apertures']]
    assert len(actual)==9 and sorted(actual)==sorted(expected_paste),'Actual EP paste windows differ from native'
    u2ep=[f for f in plots['fieldnote-F_Cu']['flashes'] if f['component']=='U2' and f['pad']=='41'];assert len(u2ep)==1
    assert u2ep[0]['aperture']==('R','4.100000X4.100000'),u2ep
    epvias=ep['ep_ground_vias'];assert len(epvias)==4
    backmask_xy={tuple(f['xy']) for f in plots['fieldnote-B_Mask']['flashes']}
    for v in epvias:
        x,y=v['position_native_nm'];assert (x/1e6,-y/1e6) not in backmask_xy
        assert abs(v['drill_diameter_mm']-.2)<1e-9 and abs(v['diameter_F_Cu_mm']-.5)<1e-9
    assert (package/'assembly/BOM-assembled-grouped.csv').read_bytes()==(root/'manufacturing/assembly-tables-v3/BOM-assembled-grouped.csv').read_bytes()
    assert (package/'assembly/positions-fitted-front.csv').read_bytes()==(root/'manufacturing/assembly-tables-v3/CPL-assembled-native.csv').read_bytes()
    result={'status':'SCOPED_NATIVE_GERBER_EXCELLON_TABLE_IDENTITY_PASS_PHYSICAL_PROCESS_HOLD','board_sha256':manifest['board_sha256'],'design_sha256':manifest['design_sha256'],'native_geometry_sha256':sha(geometry),'package_manifest_sha256':sha(package/'MANIFEST.json'),'package_zip_sha256':sha(Path(str(package)+'.zip')),'live_inputs_verified':len(manifest['source_input_sha256']),'package_members_verified':len(manifest['files']),'drills':drill_checks,'gerber_functions':sorted(functions),'gerber_sha256':{k:v['sha256'] for k,v in plots.items()},'EP_actual_export':{'copper_mm':[4.1,4.1],'paste_window_count':9,'paste_window_mm':[1,1],'rounding_radius_mm':.227273,'summed_paste_area_mm2':ep['summed_ep_paste_area_mm2'],'paste_area_percent':ep['ep_paste_area_percent'],'ground_vias':4,'pad_hole_mm':[.5,.2],'back_mask_flash_at_EP_via_centers':False,'minimum_nominal_hole_to_paste_mm':ep['minimum_hole_edge_to_paste_gap_mm'],'stencil_registration_or_solder_voiding_qualified':False},'native_BOM_CPL_byte_match':True,'board_saved_or_refilled':False,'complete_engineering_power_archive':False,'production_authorized':False,'limitations':['Scoped actual export parsing is not a full Gerber renderer or complete copper connectivity proof. Root native GerberViewer inspection is pending.','Nominal EP geometry/back-mask flash absence does not prove actual tenting, stencil registration, solder-loss/voiding or yield.','Final distributed-power/firmware/physical qualification remains separate.']}
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--package',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();r=audit(a.root.resolve(),a.package.resolve())
    with a.out.open('x') as f:f.write(json.dumps(r,indent=2)+'\n')
    print(json.dumps({'path':str(a.out.resolve()),'sha256':sha(a.out),'status':r['status'],'drills':r['drills'],'live_inputs':r['live_inputs_verified']},indent=2))
