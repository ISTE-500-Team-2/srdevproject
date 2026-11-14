"""Final PN7160 package clearance guard; explicit adopted board/design hashes required."""
from pathlib import Path
import argparse
import copy
import hashlib
import itertools
import json
import math

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'manufacturing'


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()


def bounds(center,angle,size,offset=(0,0)):
    t=math.radians(angle);c,s=math.cos(t),math.sin(t)
    corners=[]
    for x,y in itertools.product((-size[0]/2,size[0]/2),(-size[1]/2,size[1]/2)):
        x+=offset[0];y+=offset[1]
        corners.append([center[0]+x*c+y*s,center[1]-x*s+y*c])
    return [[min(q[i] for q in corners) for i in (0,1)],[max(q[i] for q in corners) for i in (0,1)]]


def gap(a,b):
    axis=[max(0,a[0][i]-b[1][i],b[0][i]-a[1][i]) for i in (0,1)]
    overlap=[max(0,min(a[1][i],b[1][i])-max(a[0][i],b[0][i])) for i in (0,1)]
    return math.hypot(*axis),overlap[0]*overlap[1]


def point_rect_distance(p,bb):
    return math.hypot(*[max(0,bb[0][i]-p[i],p[i]-bb[1][i]) for i in (0,1)])


def rounded_aperture_distance(point, aperture):
    # Exact signed distance to the native rotated rounded rectangle.
    t=math.radians(aperture['angle_board_deg']);c,s=math.cos(t),math.sin(t)
    dx,dy=[point[i]-aperture['center_board_mm'][i] for i in (0,1)]
    x,y=abs(dx*c-dy*s),abs(dx*s+dy*c)
    hx,hy=[v/2 for v in aperture['effective_size_mm']]
    r=aperture['effective_corner_radius_mm']
    qx,qy=x-hx+r,y-hy+r
    return math.hypot(max(qx,0),max(qy,0))+min(max(qx,qy),0)-r


def exact_rotation_swept_bounds(center,angle,size,offset):
    # Independent extrema of each local corner over angle +/-1 degree,
    # plus +/-0.10 mm translation on each board axis.
    lo,hi=map(math.radians,(angle-1,angle+1));axes=[[],[]]
    for x,y in itertools.product((-size[0]/2,size[0]/2),(-size[1]/2,size[1]/2)):
        x+=offset[0];y+=offset[1]
        for axis,(a,b) in enumerate(((x,y),(y,-x))):
            ts=[lo,hi];phase=math.atan2(b,a)
            for j in range(math.ceil((lo-phase)/math.pi),math.floor((hi-phase)/math.pi)+1):
                ts.append(phase+j*math.pi)
            axes[axis].extend(center[axis]+a*math.cos(t)+b*math.sin(t) for t in ts)
    return [[min(v)-.10 for v in axes],[max(v)+.10 for v in axes]]


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--board-sha256',required=True);ap.add_argument('--design-sha256',required=True)
    args=ap.parse_args()
    cp=BASE/'v03-package-catalog-final.json';np=BASE/'v03-clearance-native-geometry-r3.json'
    cat=json.loads(cp.read_text());nat=json.loads(np.read_text())
    bp=ROOT/cat['source_board_path'];dp=ROOT/cat['source_design_data_path'];pp=ROOT/cat['source_project_path']
    assert cat['source_board_sha256']==args.board_sha256 and cat['source_design_data_sha256']==args.design_sha256
    assert sha(bp)==args.board_sha256 and sha(dp)==args.design_sha256 and sha(pp)==cat['source_project_sha256']
    parts=json.loads(dp.read_text())['parts']
    assert nat['source_board_sha256']==args.board_sha256 and nat['source_design_data_sha256']==args.design_sha256
    assert nat['source_unchanged_during_check']
    assert nat['extractor_sha256']==sha(BASE/'extract_v03_clearance_native_r3.py')
    assert cat['fitted_count']==78 and cat['expected_pair_count']==3003 and cat['distinct_mpn_count']==42
    assert nat['source_catalog_sha256']==sha(cp) and nat['source_project_sha256']==sha(pp)
    assert sha(ROOT/cat['selection_review_path'])==cat['selection_review_sha256']
    for src in cat['source_documents']:
        assert sha(ROOT/src['path'])==src['sha256'],src['path']
        if src.get('product_page_path'):assert sha(ROOT/src['product_page_path'])==src['product_page_sha256']
    fitted=[p for p in parts if not p['dnp'] and p['mpn'] and p['ref']!='ANT1' and not p['ref'].startswith('TP')]
    expected={p['ref']:p for p in cat['fitted_selection']}
    actual={p['ref']:p for p in fitted};poses={p['ref']:p for p in nat['footprints']}
    assert len(fitted)==len(actual)==len(expected)==78
    assert len(poses)==len(nat['footprints'])==len(parts)==99 and set(poses)=={p['ref'] for p in parts}
    assert len({p['mpn'] for p in fitted})==42
    assert set(actual)==set(expected),'Fitted references changed: revise source catalog explicitly'
    rows=[]
    for ref,p in actual.items():
        n=poses[ref];e=expected[ref]
        assert p['mpn']==e['mpn']==n['mpn'],ref
        assert p['fp']==e['footprint'].split(':')[-1]==n['footprint'],ref
        assert not n['native_dnp'] and n['native_layer']=='F.Cu',ref
        assert max(abs(a-b) for a,b in zip(n['center_board_mm'],p['xy']))<1e-7,ref
        assert min((n['angle_board_deg']-p['angle'])%360,(p['angle']-n['angle_board_deg'])%360)<1e-7,ref
        assert min(n['angle_board_deg']%90,90-n['angle_board_deg']%90)<1e-7,'Requires cardinal native placements'
        sp=copy.deepcopy(cat['specifications_by_mpn'][p['mpn']]);ox,oy=sp['local_center_mm'];hx,hy=[v/2 for v in sp['local_xy_max_mm']]
        radius=max(math.hypot(ox+x,oy+y) for x,y in itertools.product((-hx,hx),(-hy,hy)))
        inflate=.10+2*radius*math.sin(math.radians(.5))
        bb=bounds(n['center_board_mm'],n['angle_board_deg'],sp['local_xy_max_mm'],sp['local_center_mm'])
        swept=exact_rotation_swept_bounds(n['center_board_mm'],n['angle_board_deg'],sp['local_xy_max_mm'],sp['local_center_mm'])
        guarded=[[v-inflate for v in bb[0]],[v+inflate for v in bb[1]]]
        assert all(guarded[0][j]<=swept[0][j]+1e-9 and guarded[1][j]>=swept[1][j]-1e-9 for j in (0,1)),ref
        rows.append(dict(ref=ref,mpn=p['mpn'],footprint=p['fp'],native_center_board_mm=n['center_board_mm'],
            native_angle_deg=n['angle_board_deg'],**sp,package_max_bounds_board_mm=bb,
            placement_rotation_radius_about_native_origin_mm=radius,
            rotation_radius_method=cat['rotation_radius_method'],placement_envelope_inflation_per_side_mm=inflate,
            independent_placement_envelope_board_mm=guarded,
            independent_exact_rotation_translation_sweep_bounds_board_mm=swept,
            conservative_scalar_envelope_contains_independent_exact_sweep=True))
    hashes=dict(source_board_sha256=args.board_sha256,source_design_data_sha256=args.design_sha256,
                source_catalog_sha256=sha(cp),native_geometry_sha256=sha(np),generator_sha256=sha(Path(__file__)),
                source_project_sha256=sha(pp),selection_review_sha256=cat['selection_review_sha256'])
    dimensions=dict(schema_version=1,variant='PN7160_v03',**hashes,fitted_count=78,distinct_mpn_count=42,parts=rows,source_documents=cat['source_documents'],
        source_board_path=cat['source_board_path'],source_design_data_path=cat['source_design_data_path'],
        source_catalog_path=str(cp.relative_to(ROOT)),native_geometry_path=str(np.relative_to(ROOT)),
        axes='localX/localY native footprint axes;board+Ydown; transformx*cos+y*sin,-x*sin+y*cos.',
        height_note='Packageheight plus engineeringseatingallowance; not a measured assemblerstandoff.',
        assumed_placement_budget=cat['assumed_placement_budget'])
    pair_rows=[]
    for a,b in itertools.combinations(rows,2):
        d,area=gap(a['package_max_bounds_board_mm'],b['package_max_bounds_board_mm'])
        sd,sa=gap(a['independent_placement_envelope_board_mm'],b['independent_placement_envelope_board_mm'])
        pair_rows.append(dict(refs=[a['ref'],b['ref']],manufacturer_max_gap_mm=d,manufacturer_max_rectangle_overlap_mm2=area,
            assumed_placement_screen_gap_mm=sd,assumed_placement_rectangle_overlap_mm2=sa))
    assert len(pair_rows)==len({tuple(sorted(p['refs'])) for p in pair_rows})==3003
    pair_rows.sort(key=lambda p:(p['manufacturer_max_gap_mm'],p['refs']))
    # EP process review uses exact native aperture margins and through-via holes.
    # Tenting flags alone do not establish closed holes within the EP mask opening.
    u2=poses['U2'];ep=next(p for p in u2['pads'] if p['number']=='41' and 'F.Cu' in p['layers'])
    assert ep['shape_name']=='rectangle'
    epbb=bounds(ep['center_board_mm'],ep['angle_board_deg'],ep['size_mm'])
    apertures=[]
    for i,p in enumerate(u2['pads']):
        if 'F.Paste' not in p['layers']:continue
        bb=bounds(p['center_board_mm'],p['angle_board_deg'],p['size_mm'])
        if gap(bb,epbb)[1]<=0:continue
        assert p['shape_name'] in ('rectangle','roundrect'),'Unsupported native EP paste shape'
        assert min(p['angle_board_deg']%90,90-p['angle_board_deg']%90)<1e-7
        margin=p['effective_front_paste_margin_each_side_mm']
        size=[p['size_mm'][j]+2*margin[j] for j in (0,1)]
        assert min(size)>0
        r=0.0
        if p['shape_name']=='roundrect':
            assert max(abs(v) for v in margin)<1e-12,'Rounded aperture with nonzero paste expansion requires native effective contour audit'
            r=p['roundrect_corner_radius_mm'];assert 0<=r<=min(size)/2
        area=size[0]*size[1]-(4-math.pi)*r*r
        apertures.append(dict(native_pad_index=i,pad_number=p['number'],center_board_mm=p['center_board_mm'],
            angle_board_deg=p['angle_board_deg'],effective_size_mm=size,shape=p['shape_name'],
            effective_corner_radius_mm=r,effective_area_mm2=area,native_uuid=p['native_uuid'],
            effective_paste_margin_each_side_mm=margin,
            effective_bounds_board_mm=bounds(p['center_board_mm'],p['angle_board_deg'],size)))
    assert len(apertures)==9,'Expected nine native EP paste apertures'
    epvias=[]
    for v in nat['vias']:
        if point_rect_distance(v['center_board_mm'],epbb)>v['drill_diameter_mm']/2:continue
        assert v['net']=='GND','EP via must be GND'
        metrics=[dict(aperture_native_pad_index=p['native_pad_index'],hole_edge_to_paste_gap_mm=
            rounded_aperture_distance(v['center_board_mm'],p)-v['drill_diameter_mm']/2) for p in apertures]
        epvias.append(dict(v,nearest_hole_edge_to_paste_gap_mm=min(m['hole_edge_to_paste_gap_mm'] for m in metrics),
                           paste_aperture_gaps=metrics))
    assert len(epvias)==4 and all(abs(v['drill_diameter_mm']-.2)<1e-8 and abs(v['diameter_F_Cu_mm']-.5)<1e-8 for v in epvias)
    assert {tuple(v['center_board_mm']) for v in epvias}==set(itertools.product((41.485,42.7),(22.815,24.185)))
    for v in epvias:v['nominal_annular_ring_F_Cu_mm']=(v['diameter_F_Cu_mm']-v['drill_diameter_mm'])/2
    maskexp=ep['front_mask_expansion_mm'];maskbb=bounds(ep['center_board_mm'],ep['angle_board_deg'],[v+2*maskexp for v in ep['size_mm']]) if maskexp is not None else None
    for v in epvias:
        v['via_center_within_ep_mask_opening']=bool(maskbb and all(maskbb[0][i]<=v['center_board_mm'][i]<=maskbb[1][i] for i in (0,1)))
    overlap=[p for p in pair_rows if p['manufacturer_max_rectangle_overlap_mm2']>1e-9]
    screened=[p for p in pair_rows if p['assumed_placement_rectangle_overlap_mm2']>1e-9]
    dim_path=BASE/'v03-placement-clearance-dimensions.json'
    review=dict(schema_version=1,variant='PN7160_v03',**hashes,
        status='PASS_PACKAGE_SEPARATION_CONDITIONAL_ASSEMBLY_PROCESS_REVIEW' if not overlap and not screened else 'PLACEMENT_OVERLAP_REQUIRES_REVIEW',
        fitted_components=78,distinct_fitted_mpns=42,pair_checks=3003,
        all_native_refs=99,scalar_placement_bounds_independently_checked_for_all_78=True,manufacturer_max_overlap_pairs=overlap,assumed_placement_overlap_pairs=screened,
        closest_nominal_pair=pair_rows[0],closest_assumed_pair=min(pair_rows,key=lambda p:p['assumed_placement_screen_gap_mm']),
        all_pairs=pair_rows,ep_assembly=dict(status='HOLD_PCBWAY_STENCIL_UNFILLED_VIA_REFLOW_XRAY_PROCESS_ACCEPTANCE',
            ep_copper=ep,ep_paste_apertures=apertures,ep_ground_vias=epvias,
            summed_ep_paste_area_mm2=sum(p['effective_area_mm2'] for p in apertures),
            ep_paste_area_percent=100*sum(p['effective_area_mm2'] for p in apertures)/(ep['size_mm'][0]*ep['size_mm'][1]),
            general_nxp_paste_area_target_percent=[60,65],
            process_source=dict(path='manufacturing/v03-ep-process-sources/NXP-AN1902-Rev9.pdf',sha256=sha(BASE/'v03-ep-process-sources/NXP-AN1902-Rev9.pdf'),url='https://www.nxp.com/docs/en/application-note/AN1902.pdf',section='5.2 p21 and4.2.2.3 p16-17'),
            registration_budget_note='The total relative drill/aperture/stencil registration error plus positive drill-radius error must fit within the nominal gap; no actual vendor capability supplied.',
            minimum_hole_edge_to_paste_gap_mm=min(v['nearest_hole_edge_to_paste_gap_mm'] for v in epvias),
            expensive_filled_or_capped_via_process_assumed=False,
            tenting_note='Via tenting flags do not prove mask coverage when EP mask aperture exposes the same hole; vendor process acceptance remains required.',
            qualification_note='Solder wicking/voids, paste aperture layout and stencil thickness require PCBWay review; geometry does not predict yield.'),
        limitations=cat['preserved_conditions'],source_unchanged_during_check=True)
    assert sha(bp)==args.board_sha256 and sha(dp)==args.design_sha256 and sha(pp)==hashes['source_project_sha256'],'Input changed during audit'
    assert hashes['source_catalog_sha256']==sha(cp) and hashes['native_geometry_sha256']==sha(np)
    dim_path.write_text(json.dumps(dimensions,indent=2)+'\n');review['dimensions_sha256']=sha(dim_path)
    out=BASE/'v03-placement-clearance-review.json';out.write_text(json.dumps(review,indent=2)+'\n')
    print(json.dumps({k:review[k] for k in ['status','fitted_components','pair_checks','closest_nominal_pair','closest_assumed_pair','dimensions_sha256']},indent=2))
    print(json.dumps(dict(ep_vias=len(epvias),ep_paste_apertures=len(apertures),minimum_hole_edge_to_paste_gap_mm=review['ep_assembly']['minimum_hole_edge_to_paste_gap_mm']),indent=2))


if __name__=='__main__':main()
