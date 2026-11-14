"""Parameter-driven solid geometry for the V17 printable retention prototype.

The saved case meshes remain the authoritative external geometry. PETG supports
are unioned into the base; PETG keeper posts are unioned into the lid. Four 2 mm
compliant pads preload the PCB against the supports. The elastic material law is
NOT simulated: compressed pads and a larger bulge keepout are geometry bounds.
"""
from pathlib import Path
from freeze_inputs import require_owner_freeze, assert_unchanged, sha256
import hashlib
import itertools
import json
import numpy as np
import trimesh
import manifold3d as m

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
EPS = 1e-5


def signed_clearance(body, other):
    """Positive mesh gap; do not invent a penetration depth for interference."""
    volume=float((body^other).volume())
    if volume>EPS:
        return dict(sign=-1,signed_gap_mm=None,intersection_volume_mm3=volume,
                    penetration_depth_computed=False)
    gap=float(body.min_gap(other,8.0))
    return dict(sign=1 if gap>1e-7 else 0,signed_gap_mm=gap,
                gap_search_ceiling_mm=8.0,gap_is_lower_bound=gap>=8.0,
                intersection_volume_mm3=volume)


def minimum_clearance(rows, field):
    values=[(r[field]['signed_gap_mm'],r) for r in rows if r[field]['signed_gap_mm'] is not None]
    if any(r[field]['sign']<0 for r in rows):return dict(sign=-1,signed_gap_mm=None)
    gap,row=min(values,key=lambda pair:pair[0])
    return dict(sign=row[field]['sign'],signed_gap_mm=gap,
                PCB_bottom_mm=row['PCB_bottom_mm'],PCB_thickness_mm=row['PCB_thickness_mm'],
                keeper_tip_z_mm=row['keeper_tip_z_mm'])


def box(bounds):
    a, b = np.array(bounds[0]), np.array(bounds[1])
    return m.Manifold.cube(tuple(b-a)).translate(tuple(a))


def union(solids):
    return m.Manifold.batch_boolean(list(solids), m.OpType.Add)


def export(body, name, preserve_existing=False):
    assert body.status() == m.Error.NoError, (name, body.status())
    mesh = body.to_mesh()
    mesh = trimesh.Trimesh(np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts), process=False)
    # STL stores every triangle separately; merge exact vertices for audit only.
    mesh.merge_vertices()
    assert mesh.is_watertight and mesh.is_winding_consistent and mesh.volume > 0, name
    if preserve_existing:
        saved=trimesh.load_mesh(HERE/name,process=False)
        saved.merge_vertices()
        assert saved.is_watertight and saved.is_winding_consistent and saved.volume>0,name
        assert np.max(np.abs(saved.bounds-mesh.bounds))<1e-4,'Preserved STL bounds differ: '+name
        assert abs(saved.volume-mesh.volume)<.02,'Preserved STL volume differs: '+name
        mesh=saved
    else:
        mesh.export(HERE/name)
    return dict(path='mechanical/'+name, watertight=True, volume_mm3=float(mesh.volume),
                bounds_mm=mesh.bounds.tolist(), connected_bodies=len(body.decompose()),
                sha256=hashlib.sha256((HERE/name).read_bytes()).hexdigest(),preserved_existing_STL=preserve_existing)


def support_solids(p, centers, top):
    return [m.Manifold.cylinder(top-p['support_root_z_mm'], p['support_base_radius_mm'],
                               p['support_contact_radius_mm'], circular_segments=64)
            .translate((x, y, p['support_root_z_mm'])) for x, y in centers]


def keeper_solids(p, centers, tip):
    return [m.Manifold.cylinder(p['keeper_root_z_mm']-tip, p['keeper_contact_radius_mm'],
                               p['keeper_root_radius_mm'], circular_segments=64)
            .translate((x, y, tip)) for x, y in centers]


def locator_solids(p, inward=0):
    # Stop faces are outside the unchanged polygon. Front tabs avoid the LED
    # notches and USB tongue; rear tabs avoid the ESP32 antenna cutout.
    c = p['locator_nominal_clearance_mm']-inward
    left, right, front, back = 1.3-c, 66.8+c, 3.8-c, 49.0+c
    b = []
    for y in (16.0, 39.0):
        b.append([[.5, y-1.5, .5], [left, y+1.5, 3.5]])
    for y in (9.0, 44.0):
        b.append([[right, y-1.5, .5], [67.6, y+1.5, 3.5]])
    for x in (26.5, 42.0):
        # Extend to the front wall rather than leave a thin free-standing fin.
        # This gives a short, broad load path for USB insertion/removal forces.
        b.append([[x-1.5, .5, .5], [x+1.5, front, 3.5]])
    for x in (8.0, 64.8):
        b.append([[x-1.5, back, .5], [x+1.5, 50.0, 3.5]])
    return [box(v) for v in b], b


def retained_case(p, base, lid, centers, support_top=None, keeper_tip=None, inward=0):
    top = p['board_bottom_nominal_mm'] if support_top is None else support_top
    tip = p['keeper_tip_z_nominal_mm'] if keeper_tip is None else keeper_tip
    relief = box(p['usb_opening_bounds_mm'])
    g = p['green_clip_relief']
    relief = relief + m.Manifold.cylinder(g['height_mm'], g['radius_mm'], circular_segments=96).translate((*g['center_case_mm'],g['bottom_z_mm']))
    relief = relief + box(p['green_clip_PCB_plane_relief_bounds_mm'])
    locators, _ = locator_solids(p, inward)
    return (base-relief)+union(support_solids(p, centers, top)+locators), (lid-box(p['lid_usb_lip_relief_bounds_mm']))+union(keeper_solids(p, centers, tip))


def component_shifted_items(d, items, bottom, thickness, x, y, nominal_bottom, nominal_thickness):
    delta_bottom = bottom-nominal_bottom
    delta_top = bottom+thickness-(nominal_bottom+nominal_thickness)
    out = {'PCB': m.CrossSection([np.array(d.OUTLINE)]).extrude(thickness).translate((d.CASE_OFFSET[0]+x,d.CASE_OFFSET[1]+y,bottom))}
    for ref, body in items.items():
        if ref == 'PCB' or ref.startswith(('J2','J3')):
            continue
        out[ref] = body.translate((x,y,delta_bottom if '_lead' in ref else delta_top))
    return out


def pad_solids(p, centers, board_top, keeper_tip, bulge=False):
    side = p['pad_bulge_envelope_square_mm'] if bulge else p['pad_contact_square_mm']
    return [box([[x-side/2,y-side/2,board_top],[x+side/2,y+side/2,keeper_tip]]) for x,y in centers]


def bare_pad_audit(d, centers, p, native):
    # Native solder/exposed pads are forbidden contact surfaces. Tracks under
    # solder mask are allowed; dielectric loading still requires an RF check.
    checks = []
    half = p['pad_contact_square_mm']/2 + p['xy_pose_allowance_mm']
    for i, center in enumerate(centers):
        x,y = np.array(center)-d.CASE_OFFSET
        hits=[]
        for fp in d.children(native, 'footprint'):
            at=d.child(fp,'at'); angle=float(at[3]) if len(at)>3 else 0
            props=d.children(fp,'property')
            ref=next((d.unq(v[2]) for v in props if d.unq(v[1])=='Reference'), '?')
            for pad in d.children(fp,'pad'):
                layers=d.child(pad,'layers')
                layer_names=[d.unq(a) for a in layers[1:]]
                if not any(a in layer_names for a in ('F.Mask','B.Mask','*.Mask','F.Cu','B.Cu','*.Cu')):
                    continue
                pa=d.child(pad,'at'); size=d.child(pad,'size')
                pose={'xy':[float(at[1])-60,float(at[2])-50],'angle':angle}
                px,py=d.transform(float(pa[1]),float(pa[2]),pose)
                # Native .kicad_pcb pad angles are absolute board angles;
                # footprint-local positions still need the footprint rotation.
                t=np.radians(float(pa[3]) if len(pa)>3 else 0)
                sx,sy=float(size[1])/2,float(size[2])/2
                hx=abs(np.cos(t))*sx+abs(np.sin(t))*sy
                hy=abs(np.sin(t))*sx+abs(np.cos(t))*sy
                if abs(px-x)<hx+half and abs(py-y)<hy+half:
                    hits.append(ref+':'+d.unq(pad[1]))
        via_hits=[]
        for n,via in enumerate(d.children(native,'via')):
            at=d.child(via,'at');drill=d.child(via,'drill')
            px,py=float(at[1])-60,float(at[2])-50
            radius=float(drill[1])/2
            if abs(px-x)<half+radius and abs(py-y)<half+radius:
                via_hits.append(n)
        contact=m.CrossSection([np.array([[x-half,y-half],[x+half,y-half],[x+half,y+half],[x-half,y+half]])]).extrude(1)
        outline=m.CrossSection([np.array(d.OUTLINE)]).extrude(1)
        outside=float((contact-outline).volume())
        checks.append(dict(contact=i+1,center_board_mm=[float(x),float(y)],
                           pad_keepout_half_width_mm=half,exposed_pad_rectangle_hits=hits,via_drill_hits=via_hits,
                           contact_sweep_outside_board_mm2=outside))
    return checks

def assumed_component_placement_audit(d,p,base,lid,items,centers):
    """Separate assumed process screen; inflate XY without changing heights."""
    inflated={}
    for ref,body in items.items():
        if ref=='PCB':inflated[ref]=body;continue
        owner=ref.split('_lead')[0]
        delta=d.ASSUMED_COMPONENT_XY_INFLATION_MM[owner]
        b=body.bounding_box()
        inflated[ref]=box([[b[0]-delta,b[1]-delta,b[2]],[b[3]+delta,b[4]+delta,b[5]]])
    nominal_bottom=p['board_bottom_nominal_mm'];nominal_t=p['board_thickness_nominal_mm']
    bottoms=[nominal_bottom-p['support_height_allowance_mm'],nominal_bottom,nominal_bottom+p['support_height_allowance_mm']]
    ts=[nominal_t*(1-p['board_thickness_tolerance_fraction']),nominal_t,nominal_t*(1+p['board_thickness_tolerance_fraction'])]
    nominal_tip=p['keeper_tip_z_nominal_mm']
    tips=[nominal_tip-p['keeper_height_allowance_mm'],nominal_tip,nominal_tip+p['keeper_height_allowance_mm']]
    a=p['xy_pose_allowance_mm'];poses=list(itertools.product((-a,0,a),repeat=2))
    rows=[];continuous=[];details=[];continuous_details=[];pad_details=[];continuous_pad=[];continuous_pad_details=[]
    for bottom,t,tip in itertools.product(bottoms,ts,tips):
        casebase,caselid=retained_case(p,base,lid,centers,bottom,tip,p['locator_inward_print_allowance_mm'])
        floor_high=p['source_floor_nominal_mm']+p['floor_upward_print_allowance_mm']
        casebase=casebase+box([[.6,.6,0],[67.5,49.9,floor_high]])
        cases=[('base',casebase),('lid',caselid)]
        nominal=component_shifted_items(d,inflated,bottom,t,0,0,nominal_bottom,nominal_t)
        full_xy={'PCB':m.CrossSection([np.array(d.OUTLINE)]).offset(a,m.JoinType.Miter).extrude(t).translate((*d.CASE_OFFSET,bottom))}
        for ref,body in nominal.items():
            if ref=='PCB':continue
            b=body.bounding_box();full_xy[ref]=box([[b[0]-a,b[1]-a,b[2]],[b[3]+a,b[4]+a,b[5]]])
        envelope=union(full_xy.values())
        ev={name:float((envelope^body).volume()) for name,body in cases}
        stack=dict(PCB_bottom_mm=bottom,PCB_thickness_mm=t,keeper_tip_z_mm=tip)
        components=union(body for ref,body in full_xy.items() if ref!='PCB')
        continuous.append(dict(**stack,intersections_mm3=ev,
            component_to_base_clearance=signed_clearance(components,casebase),
            component_to_lid_clearance=signed_clearance(components,caselid)))
        pads=union(pad_solids(p,centers,bottom+t,tip,bulge=True))
        pad_v=float((pads^components).volume())
        continuous_pad.append(dict(**stack,pad_component_volume_mm3=pad_v,
            component_to_pad_bulge_clearance=signed_clearance(components,pads)))
        if pad_v>EPS:
            hits=[]
            for ref,body in full_xy.items():
                if ref=='PCB':continue
                v=float((pads^body).volume())
                if v>EPS:hits.append(dict(ref=ref,volume_mm3=v,component_XY_swept_bounds_case_mm=list(body.bounding_box())))
            continuous_pad_details.append(dict(**stack,pad_component_volume_mm3=pad_v,component_hits=hits))
        candidates={name:[] for name,_ in cases}
        for name,case in cases:
            if ev[name]<=EPS:continue
            for ref,body in full_xy.items():
                v=float((body^case).volume())
                if v>EPS:
                    candidates[name].append(ref)
                    continuous_details.append(dict(**stack,ref=ref,case=name,volume_mm3=v,component_XY_swept_bounds_case_mm=list(body.bounding_box())))
        for x,y in poses:
            bodies=component_shifted_items(d,inflated,bottom,t,x,y,nominal_bottom,nominal_t)
            volumes={name:0. for name,_ in cases}
            row=dict(**stack,pose_xy_mm=[x,y])
            for name,case in cases:
                for ref in candidates[name]:
                    volume=float((bodies[ref]^case).volume())
                    if volume>EPS:
                        details.append(dict(**row,ref=ref,case=name,volume_mm3=volume,component_bounds_case_mm=list(bodies[ref].bounding_box())))
                if candidates[name]:volumes[name]=float((union(bodies[ref] for ref in candidates[name])^case).volume())
            rows.append(dict(**row,intersections_mm3=volumes))
            pads=union(pad_solids(p,centers,bottom+t,tip,bulge=True))
            components=union(body for ref,body in bodies.items() if ref!='PCB')
            pad_v=float((pads^components).volume())
            if pad_v>EPS:
                hits=[]
                for ref,body in bodies.items():
                    if ref=='PCB':continue
                    v=float((pads^body).volume())
                    if v>EPS:hits.append(dict(ref=ref,volume_mm3=v))
                pad_details.append(dict(**row,pad_component_volume_mm3=pad_v,component_hits=hits))
    status='PASS_ASSUMED_COMPONENT_PLACEMENT' if not details and not continuous_details and not pad_details and not continuous_pad_details else 'FAIL_ASSUMED_COMPONENT_PLACEMENT'
    return dict(status=status,method='Per-ref conservative XY inflation from the maximum sourced package corner radius about the native placement origin; applied to existing larger prisms, then combined with global PCB pose/stack allowances. Heights and seating remain unchanged.',
        process_assumptions=dict(independent_component_translation_each_axis_mm=.10,independent_component_rotation_deg=1.,global_PCB_translation_each_axis_mm=a,measured_PCBWay_capability=False),
        per_ref_XY_inflation_mm=d.ASSUMED_COMPONENT_XY_INFLATION_MM,
        stack_sweep_cases=len(rows),rigid_collision_cases=sum(any(v>EPS for v in row['intersections_mm3'].values()) for row in rows),
        continuous_XY_pose_envelope_cases=len(continuous),continuous_XY_pose_collision_cases=sum(any(v>EPS for v in row['intersections_mm3'].values()) for row in continuous),
        rigid_collision_details=details,continuous_XY_collision_details=continuous_details,
        pad_bulge_component_collision_cases=len(pad_details),pad_bulge_collision_details=pad_details,
        continuous_pad_bulge_envelope_cases=len(continuous_pad),continuous_pad_bulge_component_collision_cases=len(continuous_pad_details),
        continuous_pad_bulge_envelopes=continuous_pad,continuous_pad_bulge_collision_details=continuous_pad_details,
        continuous_minimum_clearances=dict(base=minimum_clearance(continuous,'component_to_base_clearance'),
            lid=minimum_clearance(continuous,'component_to_lid_clearance'),
            pad_bulge=minimum_clearance(continuous_pad,'component_to_pad_bulge_clearance')),
        stack_sweep=rows,continuous_XY_pose_envelopes=continuous,
        limitations=['Assumed per-part assembly variation is a conservative design screen, not measured supplier placement capability. Existing larger package/courtyard prisms are additionally inflated; failures may conservatively exceed exact vendor-body shapes. No printable case revision is made by this screen.'])


def generate(d, base, lid, items, native, preserve_existing_stls=False):
    freeze,freeze_sources=require_owner_freeze(ROOT)
    p=json.loads((HERE/'retention-parameters.json').read_text())
    fitted_refs={part['ref'] for part in d.PARTS if not part['dnp'] and not part['ref'].startswith('TP') and part['ref']!='ANT1'}
    modeled_refs={ref for ref in items if ref!='PCB' and '_lead' not in ref}
    assert modeled_refs==fitted_refs,'Retention review cannot skip a fitted purchased component.'
    assert not fitted_refs & {'J2','J3','J4'},'This retention audit is USB-only; future connector assembly requires a revised model.'
    if preserve_existing_stls:
        previous=json.loads((HERE/'retention-checks.json').read_text())
        assert p==previous['parameters'],'Cannot preserve STL artifacts after changing case parameters.'
        assert all(hashlib.sha256((ROOT/'references'/name).read_bytes()).hexdigest()==value for name,value in previous['source_mesh_sha256'].items()),'Original case meshes changed.'
        assert all(hashlib.sha256((ROOT/f['path']).read_bytes()).hexdigest()==f['sha256'] for f in previous['files']),'Existing STL hashes differ from the previous audit.'
    nominal_bottom=p['board_bottom_nominal_mm']; nominal_thickness=p['board_thickness_nominal_mm']; nominal_tip=p['keeper_tip_z_nominal_mm']
    centers=[tuple(np.array(c)+d.CASE_OFFSET) for c in p['contact_centers_board_mm']]
    nominal_base, nominal_lid=retained_case(p,base,lid,centers)
    def name(stem):
        return stem+p.get('artifact_suffix','')+'.stl'
    files=[]
    files.append(export(nominal_base,name('base-V17-PCB-retained-PETG'),preserve_existing_stls))
    # Saved V17 lid STL is interior-up on the print bed, inverse assembly pose.
    files.append(export(nominal_lid.translate((0,-50.5,-10)).rotate((180,0,0)),name('lid-V17-PCB-retained-PETG'),preserve_existing_stls))
    files.append(export(nominal_lid,name('lid-assembled-inspection'),preserve_existing_stls))
    side=p['pad_contact_square_mm']; wall=p['TPU_pad_wall_mm']; height=p['pad_free_height_mm']
    pad=box([[0,0,0],[side,side,height]])-box([[wall,wall,-.1],[side-wall,side-wall,height-p['TPU_pad_roof_mm']]])
    files.append(export(pad,name('compliant-puck-TPU-prototype'),preserve_existing_stls))
    files.append(export(union(pad_solids(p,centers,nominal_bottom+nominal_thickness,nominal_tip)),name('pads-nominal-compressed-inspection'),preserve_existing_stls))
    # Do not weld intentionally touching board/case/pads into an ambiguous STL.
    # Each printable body and compressed-pad inspection mesh is audited alone.

    # Mesh connectivity is an essential guard: each PETG body must be one solid,
    # and every support/keeper must share nonzero volume with its source case.
    attachments=[]
    for i,(s,k) in enumerate(zip(support_solids(p,centers,nominal_bottom),keeper_solids(p,centers,nominal_tip))):
        attachments.append(dict(contact=i+1,support_to_source_base_mm3=float((s^base).volume()),keeper_to_source_lid_mm3=float((k^lid).volume())))
    assert all(v['support_to_source_base_mm3']>EPS and v['keeper_to_source_lid_mm3']>EPS for v in attachments)
    assert len(nominal_base.decompose()) == 1 and len(nominal_lid.decompose()) == 1
    exterior_escape=float((union([nominal_base,nominal_lid])-box([[0,0,0],p['case_size_mm']])).volume())
    original_floor=base^box([[0,0,0],[68.1,50.5,p['source_floor_nominal_mm']]])
    removed_floor=float((original_floor-nominal_base).volume())
    assert exterior_escape<EPS and removed_floor<EPS

    thicknesses=[nominal_thickness*(1-p['board_thickness_tolerance_fraction']),nominal_thickness,nominal_thickness*(1+p['board_thickness_tolerance_fraction'])]
    bottoms=[nominal_bottom-p['support_height_allowance_mm'],nominal_bottom,nominal_bottom+p['support_height_allowance_mm']]
    tips=[nominal_tip-p['keeper_height_allowance_mm'],nominal_tip,nominal_tip+p['keeper_height_allowance_mm']]
    a=p['xy_pose_allowance_mm'];poses=list(itertools.product((-a,0,a),repeat=2))
    rows=[]; details=[]; pad_collision=[];continuous_xy=[];continuous_pad=[];continuous_pad_details=[]
    for bottom,thickness,tip in itertools.product(bottoms,thicknesses,tips):
        actual_base, actual_lid=retained_case(p,base,lid,centers,bottom,tip,p['locator_inward_print_allowance_mm'])
        # Worst-case floor error is additional material, never floor thinning.
        # Cover the entire internal floor instead of only the USB tail sites.
        floor_high=p['source_floor_nominal_mm']+p['floor_upward_print_allowance_mm']
        actual_base=actual_base+box([[.6,.6,0],[67.5,49.9,floor_high]])
        # Every board-outline edge is axis-aligned. A mitered 0.2 mm offset is
        # therefore its exact rectangular XY pose envelope, including every
        # intermediate translation. Component prisms are rectangular too.
        a=p['xy_pose_allowance_mm']
        outline_envelope=m.CrossSection([np.array(d.OUTLINE)]).offset(a,m.JoinType.Miter)
        full_xy={'PCB':outline_envelope.extrude(thickness).translate((*d.CASE_OFFSET,bottom))}
        nominal_items=component_shifted_items(d,items,bottom,thickness,0,0,nominal_bottom,nominal_thickness)
        for ref,body in nominal_items.items():
            if ref=='PCB':continue
            bb=body.bounding_box()
            full_xy[ref]=box([[bb[0]-a,bb[1]-a,bb[2]],[bb[3]+a,bb[4]+a,bb[5]]])
        envelope=union(full_xy.values())
        ev={k:float((envelope^v).volume()) for k,v in [('base',actual_base),('lid',actual_lid)]}
        components=union(body for ref,body in full_xy.items() if ref!='PCB')
        continuous_xy.append(dict(PCB_bottom_mm=bottom,PCB_thickness_mm=thickness,keeper_tip_z_mm=tip,intersections_mm3=ev,
            component_to_base_clearance=signed_clearance(components,actual_base),
            component_to_lid_clearance=signed_clearance(components,actual_lid)))
        pads=union(pad_solids(p,centers,bottom+thickness,tip,bulge=True))
        pad_v=float((pads^components).volume())
        source_v=float((pads^union([base,lid])).volume())
        pad_row=dict(PCB_bottom_mm=bottom,PCB_thickness_mm=thickness,keeper_tip_z_mm=tip,pad_component_volume_mm3=pad_v,pad_source_case_volume_mm3=source_v,
            component_to_pad_bulge_clearance=signed_clearance(components,pads))
        continuous_pad.append(pad_row)
        if pad_v>EPS or source_v>EPS:continuous_pad_details.append(pad_row)
        for x,y in poses:
            bodies=component_shifted_items(d,items,bottom,thickness,x,y,nominal_bottom,nominal_thickness)
            assembled=union(bodies.values())
            vols={k:float((assembled^v).volume()) for k,v in [('base',actual_base),('lid',actual_lid)]}
            row=dict(pose_xy_mm=[x,y],PCB_bottom_mm=bottom,PCB_thickness_mm=thickness,keeper_tip_z_mm=tip,intersections_mm3=vols)
            rows.append(row)
            if any(v>EPS for v in vols.values()):
                for ref,body in bodies.items():
                    for case,casebody in [('base',actual_base),('lid',actual_lid)]:
                        volume=float((body^casebody).volume())
                        if volume>EPS:details.append(dict(**row,ref=ref,case=case,volume_mm3=volume))
            # Intentional pad/PCB and pad/keeper contact has zero volume. The
            # inflated pad is only intersected with components and source case.
            pads=union(pad_solids(p,centers,bottom+thickness,tip,bulge=True))
            components=union(v for ref,v in bodies.items() if ref!='PCB')
            pv=float((pads^components).volume())
            cv=float((pads^union([base,lid])).volume())
            if pv>EPS or cv>EPS:pad_collision.append(dict(**row,pad_component_volume_mm3=pv,pad_source_case_volume_mm3=cv))
    pad_gaps=[tip-(bottom+t) for tip,bottom,t in itertools.product(tips,bottoms,thicknesses)]
    contact_audit=bare_pad_audit(d,centers,p,native)
    bulge_p=dict(p,pad_contact_square_mm=p['pad_bulge_envelope_square_mm'])
    bulge_pad_audit=bare_pad_audit(d,centers,bulge_p,native)
    result=dict(variant='PN7160_v03',revision=p['revision'],owner_freeze=freeze,method='manifold3d watertight solid intersections; prescribed compliant-pad geometry',
        status='PASS_BOUNDED_GEOMETRY' if not details and not pad_collision and not continuous_pad_details and all(not any(v>EPS for v in r['intersections_mm3'].values()) for r in continuous_xy) and all(not c['exposed_pad_rectangle_hits'] and not c['via_drill_hits'] and c['contact_sweep_outside_board_mm2']<EPS for c in contact_audit) and all(not c['exposed_pad_rectangle_hits'] and not c['via_drill_hits'] for c in bulge_pad_audit) else 'FAIL_BOUNDED_GEOMETRY',
        native_board_sha256=d.NATIVE_BOARD_SHA256,
        design_data_sha256=d.NATIVE_DESIGN_DATA_SHA256,
        manufacturer_dimensions_sha256=d.MECHANICAL_DIMENSIONS_SOURCE_SHA256,
        manufacturer_dimensions_path=d.MECHANICAL_DIMENSIONS_SOURCE_PATH,
        manufacturer_catalog_sha256=d.MECHANICAL_CATALOG_SHA256,
        manufacturer_catalog_path=d.MECHANICAL_CATALOG_SOURCE_PATH,
        manufacturer_native_geometry_sha256=d.MECHANICAL_NATIVE_SOURCE_SHA256,
        manufacturer_native_geometry_path=d.MECHANICAL_NATIVE_SOURCE_PATH,
        audit_source_sha256={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in
            (ROOT/'simulation/simulate_mechanical.py',HERE/'design_retention.py',HERE/'height-envelope-sources.json',HERE/'freeze_inputs.py')},
        fitted_component_coverage=dict(status='PASS_COMPLETE_FITTED_COVERAGE',expected_count=len(fitted_refs),modeled_count=len(modeled_refs),missing_refs=[],modeled_refs=sorted(modeled_refs)),
        source_mesh_sha256={v:hashlib.sha256((ROOT/'references'/v).read_bytes()).hexdigest() for v in ('Box_V17_BRACED_PETG.stl','Lid_V17_BRACED_PETG.stl')},
        parameters=p,contact_centers_case_mm=centers,contact_native_exposed_pad_audit=contact_audit,pad_bulge_native_exposed_pad_audit=bulge_pad_audit,
        attachment_intersections_mm3=attachments,files=files,
        exterior_escape_volume_mm3=exterior_escape,original_floor_removed_volume_mm3=removed_floor,
        stack_sweep_cases=len(rows),rigid_collision_cases=sum(any(v>EPS for v in r['intersections_mm3'].values()) for r in rows),
        continuous_XY_pose_envelope_cases=len(continuous_xy),continuous_XY_pose_collision_cases=sum(any(v>EPS for v in r['intersections_mm3'].values()) for r in continuous_xy),
        continuous_XY_pose_envelopes=continuous_xy,
        continuous_pad_bulge_envelope_cases=len(continuous_pad),continuous_pad_bulge_component_collision_cases=len(continuous_pad_details),
        continuous_pad_bulge_envelopes=continuous_pad,continuous_pad_bulge_collision_details=continuous_pad_details,
        continuous_minimum_clearances=dict(base=minimum_clearance(continuous_xy,'component_to_base_clearance'),
            lid=minimum_clearance(continuous_xy,'component_to_lid_clearance'),
            pad_bulge=minimum_clearance(continuous_pad,'component_to_pad_bulge_clearance')),
        signed_clearance_method='manifold3d minimum mesh gap for the component/USB-tail union across every continuous global-XY/vertical-stack envelope; intentional PCB-support/pad/keeper contact excluded. Positive gap means separation, zero means boundary contact. Positive-volume interference has negative sign and no fabricated penetration depth. Gap search ceiling is 8 mm.',
        intersection_volume_threshold_mm3=EPS,
        rigid_collision_details=details,pad_bulge_component_collision_cases=len(pad_collision),pad_bulge_collision_details=pad_collision,
        compliant_pad_gap_range_mm=[min(pad_gaps),max(pad_gaps)],
        pad_required_compression_fraction_range=[1-max(pad_gaps)/height,1-min(pad_gaps)/height],
        USB_tail_to_original_floor_minimum_mm=min(bottoms)-p['usb_shell_protrusion_bound_mm']-p['source_floor_nominal_mm'],
        USB_tail_to_upward_tolerance_floor_minimum_mm=min(bottoms)-p['usb_shell_protrusion_bound_mm']-floor_high,
        pose_thickness_keeper_sweep=rows,
        limitations=['Geometry passing does not validate retention force, TPU buckling, foam compression set, PETG strength, impact, USB insertion force, printer accuracy, board warpage or plug boot fit.',
            '2 mm compliant pad must be qualified for 12–48% compression; hollow TPU STL is a candidate requiring a compression test. Solid PETG pads make assembly impossible at tolerance extremes.',
            'Support-height and keeper allowances are independent ±0.10 mm design budgets, not measured printer tolerances. Measure printed seats before installing the board.',
            'Four sites are checked against actual native exposed pad rectangles. Masked NFC copper beneath the left rear pad can experience small dielectric loading; RF tuning must include the complete case/pads.',
            'First assembly is USB only: J2/J3 DNP, J4 DNP, no battery. A future populated connector build must rerun envelope checks.',
            'PCB outline manufacturing tolerance, local solder bulges, and board warpage are additional to the modeled envelopes. Reject support seats below z1.55 or floor thickness above 0.70: minimum USB-tail/floor clearance is 0.07 mm at those bounds.',
            'The original 0.6 mm floor is retained. Supports and keeper posts are solid tapered PETG pillars and carry no asserted load rating.'])
    result['assumed_independent_component_placement']=assumed_component_placement_audit(d,p,base,lid,items,centers)
    assert hashlib.sha256((ROOT/'fieldnote.kicad_pcb').read_bytes()).hexdigest()==d.NATIVE_BOARD_SHA256,'Native PCB changed during retention check.'
    assert hashlib.sha256((ROOT/'design-data.json').read_bytes()).hexdigest()==d.NATIVE_DESIGN_DATA_SHA256,'Design data changed during retention check.'
    assert sha256(ROOT/d.MECHANICAL_DIMENSIONS_SOURCE_PATH)==d.MECHANICAL_DIMENSIONS_SOURCE_SHA256,'Manufacturer dimensions changed during retention check.'
    assert sha256(ROOT/d.MECHANICAL_CATALOG_SOURCE_PATH)==d.MECHANICAL_CATALOG_SHA256,'Manufacturer catalog changed during retention check.'
    assert sha256(ROOT/d.MECHANICAL_NATIVE_SOURCE_PATH)==d.MECHANICAL_NATIVE_SOURCE_SHA256,'Manufacturer native extraction changed during retention check.'
    assert_unchanged(ROOT,freeze_sources)
    (HERE/'retention-checks.json').write_text(json.dumps(result,indent=2)+'\n')
    return result
