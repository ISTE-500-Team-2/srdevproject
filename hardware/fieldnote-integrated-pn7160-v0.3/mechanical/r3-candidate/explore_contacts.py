"""Bound small rear contact4 moves without weakening any prescribed envelope."""
from pathlib import Path
import json,math,itertools
import numpy as np
import manifold3d as m
import trimesh
from freeze_inputs import require_owner_freeze,assert_unchanged,sha256

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]


def solid(path):
    mesh=trimesh.load_mesh(path)
    return m.Manifold(m.Mesh(np.asarray(mesh.vertices,dtype=np.float32),np.asarray(mesh.faces,dtype=np.uint32)))


def cube(lo,hi):return m.Manifold.cube(tuple(np.array(hi)-lo)).translate(tuple(lo))


def xy_gap(a,b):
    delta=np.maximum(np.maximum(np.array(a[0])-b[1],np.array(b[0])-a[1]),0)
    overlap=np.minimum(a[1],b[1])-np.maximum(a[0],b[0])
    return None if np.all(overlap>1e-9) else float(np.linalg.norm(delta))


def main():
    freeze,inputs=require_owner_freeze(ROOT)
    paths=[ROOT/'mechanical/retention-checks.json',ROOT/'simulation/results/mechanical.json',ROOT/'mechanical/native-geometry.json',HERE/'explore_contacts.py']
    inputs.update({str(p.relative_to(ROOT)):sha256(p) for p in paths})
    checks=json.loads(paths[0].read_text());audit=json.loads(paths[1].read_text());native=json.loads(paths[2].read_text())
    assert_unchanged(ROOT,audit['input_sha256'])
    assert native['source_sha256']['fieldnote.kicad_pcb']==inputs['fieldnote.kicad_pcb']
    params=checks['parameters'];offset=np.array(params['expected_case_offset_mm']);a=params['xy_pose_allowance_mm']
    outline=np.array(params['expected_board_outline_mm']);polygon=m.CrossSection([outline])
    contact_half=params['pad_contact_square_mm']/2+a;bulge_half=params['pad_bulge_envelope_square_mm']/2
    exposed=[]
    for fp in native['footprints']:
        for pad in fp['pads']:
            if not any(k in pad['layers'] for k in ('F.Cu','B.Cu','F.Mask','B.Mask')):continue
            angle=math.radians(pad['angle_board_deg']);sx,sy=np.array(pad['size_mm'])/2
            half=np.array([abs(math.cos(angle))*sx+abs(math.sin(angle))*sy,abs(math.sin(angle))*sx+abs(math.cos(angle))*sy])
            exposed.append((fp['ref']+':'+pad['number'],np.array(pad['center_board_mm']),half))
    vias=[(i,np.array(v['center_board_mm']),v['drill_diameter_mm']/2) for i,v in enumerate(native['vias'])]
    inflated={}
    for ref,bounds in audit['component_envelopes_mm'].items():
        delta=a+checks['assumed_independent_component_placement']['per_ref_XY_inflation_mm'][ref]
        inflated[ref]=[np.array(bounds[0][:2])-offset-delta,np.array(bounds[1][:2])-offset+delta]
    base=solid(ROOT/'references/Box_V17_BRACED_PETG.stl')
    lid=solid(ROOT/'references/Lid_V17_BRACED_PETG.stl').rotate((180,0,0)).translate((0,50.5,10))
    source_case=base+lid
    bottom=params['board_bottom_nominal_mm']-params['support_height_allowance_mm']
    thickness=params['board_thickness_nominal_mm']*(1-params['board_thickness_tolerance_fraction'])
    tip=params['keeper_tip_z_nominal_mm']+params['keeper_height_allowance_mm']
    candidates=[(round(x,5),round(y,5)) for x,y in itertools.product(np.arange(63.0,64.21,.02),np.arange(39.0,44.21,.10))]
    candidates.extend([(64.,41.5),(64.1,41.5),(64.08,41.5),(64.04,41.5),(64.03,41.5),(64.1,43.8)])
    rows=[]
    for x,y in sorted(set(candidates)):
        center=np.array([x,y]);square=m.CrossSection([np.array([center+q for q in [(-contact_half,-contact_half),(contact_half,-contact_half),(contact_half,contact_half),(-contact_half,contact_half)]])])
        outside=float((square-polygon).area());row=dict(center_board_mm=[x,y],shift_from_R2_mm=[x-64.,y-41.5],contact_sweep_outside_PCB_mm2=outside)
        if outside>1e-7:row['status']='REJECT_CONTACT_SWEEP_OUTSIDE_PCB';rows.append(row);continue
        contacts=[ref for ref,xy,h in exposed if np.all(np.abs(xy-center)<h+contact_half-1e-9)]
        contact_vias=[i for i,xy,radius in vias if np.all(np.abs(xy-center)<radius+contact_half-1e-9)]
        bulge_pad_hits=[ref for ref,xy,h in exposed if np.all(np.abs(xy-center)<h+bulge_half+a-1e-9)]
        bulge_via_hits=[i for i,xy,radius in vias if np.all(np.abs(xy-center)<radius+bulge_half+a-1e-9)]
        row.update(contact_exposed_pad_hits=contacts,contact_via_drill_hits=contact_vias,bulge_exposed_pad_hits=bulge_pad_hits,bulge_via_drill_hits=bulge_via_hits)
        bounds=[center-bulge_half,center+bulge_half]
        gaps={ref:xy_gap(bounds,box) for ref,box in inflated.items()}
        overlaps=[ref for ref,gap in gaps.items() if gap is None]
        row['assumed_component_XY_overlap_refs']=overlaps
        if overlaps:row['status']='REJECT_ASSUMED_BODY_BULGE_OVERLAP';rows.append(row);continue
        gap=min(gaps.values());row['assumed_component_to_bulge_gap_mm']=gap
        row['gap_limiting_refs']=[ref for ref,value in gaps.items() if value<=gap+1e-7]
        case_center=center+offset;pad=cube([*(case_center-bulge_half),bottom+thickness],[*(case_center+bulge_half),tip])
        v=float((pad^source_case).volume());row['pad_to_source_case_intersection_mm3']=v
        row['pad_to_source_case_gap_mm']=float(pad.min_gap(source_case,8.)) if v<1e-5 else None
        row['PCB_right_contact_sweep_edge_margin_mm']=65.5-(x+contact_half)
        row['status']='PASS_PRELIMINARY_BOUNDED_CONTACT_AND_BULGE' if not (contacts or contact_vias or bulge_pad_hits or bulge_via_hits) and v<1e-5 else 'REJECT_EXPOSED_PAD_DRILL_OR_CASE'
        rows.append(row)
    accepted=[r for r in rows if r['status'].startswith('PASS_')]
    u1=inflated['U1'];maximum_x=65.5-contact_half;maximum_y=45.2-contact_half
    ceiling=maximum_x-bulge_half-u1[1][0]
    result=dict(status='BOUNDED_LOCAL_EXPLORATION_TARGET_CONSTRAINED',variant='PN7160_v03_R3_PROPOSAL',source_sha256=inputs,
        unchanged_budgets=dict(global_PCB_XY_mm=a,independent_part_XY_mm=.1,independent_part_rotation_deg=1.,contact_side_mm=2*params['support_contact_radius_mm'],pad_bulge_side_mm=2*bulge_half),
        sampled_domain_board_mm=dict(x=[63.,64.2],y=[39.,44.2],grid_xy_mm=[.02,.10]),
        candidate_count=len(rows),preliminary_pass_count=len(accepted),target_component_gap_mm=.25,
        rear_local_bound=dict(maximum_contact_center_board_x_mm=maximum_x,maximum_contact_center_board_y_mm=maximum_y,
            U1_assumed_continuous_bounds_board_mm=[q.tolist() for q in u1],
            maximum_component_to_bulge_X_gap_mm=ceiling,
            target_requires_center_case_y_below_module_mm=float(u1[1][1]+offset[1]+bulge_half+.25),
            allowed_maximum_contact_center_case_y_mm=maximum_y+offset[1],
            explanation='All small rear-site y moves overlap the full U1 Y envelope. Right PCB edge permits at most x64.1 for the full2.4mm contact swept±.2mm. Thus component clearance cannot reach0.25mm at this rear site without changing the unchanged geometry/budgets. Further outward movement places contact sweep outside PCB.'),
        best_component_gap_preliminary=max(accepted,key=lambda r:r['assumed_component_to_bulge_gap_mm']) if accepted else None,
        selected_position_candidates=[r for r in rows if r['center_board_mm'] in [[64.,41.5],[64.03,41.5],[64.04,41.5],[64.08,41.5],[64.1,41.5],[64.1,43.8]]],
        candidates=rows,physical_disposition='Engineering proposed candidate REVIEW/HOLD; no pad-force/print/process qualification and no old source/artifact changes.')
    assert_unchanged(ROOT,inputs)
    path=HERE/'contact4-comparisons.json';path.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:result[k] for k in ('status','candidate_count','preliminary_pass_count','rear_local_bound','selected_position_candidates')},indent=2))


if __name__=='__main__':main()
