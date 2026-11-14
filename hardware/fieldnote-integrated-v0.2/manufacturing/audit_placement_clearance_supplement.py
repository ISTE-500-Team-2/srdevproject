"""Supplement immutable PN532 placement evidence; never save CAD/base artifacts."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import itertools
import json
import math
import re

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'manufacturing'
SOURCES = BASE / 'clearance-supplement-sources'
BOARD_SHA = 'c6c7ff173b25e8f182a084e327d3c602c3bc24246ff914d45e3b7228775e2456'
DESIGN_SHA = 'ac013ae9e9c12a99ecdc8f7ff99909f215e4ed712e52035d55024d073d69b274'
BASE_MANIFEST_SHA = '76a6e286607f1c7465a1e066b338a0060e712e3ca831fd828747d21a3e456851'
BASE_DIMENSIONS_SHA = '0a1b0785ef55ff32489abd06538481e0e50e81fdaf375d5b10ed25f58b56be5f'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_frozen():
    assert sha(ROOT / 'fieldnote.kicad_pcb') == BOARD_SHA
    assert sha(ROOT / 'design-data.json') == DESIGN_SHA
    assert sha(BASE / 'placement-clearance-manifest.json') == BASE_MANIFEST_SHA
    assert sha(BASE / 'placement-clearance-dimensions.json') == BASE_DIMENSIONS_SHA
    manifest = json.loads((BASE / 'placement-clearance-manifest.json').read_text())
    assert len(manifest['files']) == 34
    for item in manifest['files']:
        assert sha(ROOT / item['path']) == item['sha256'], item['path']


def blocks(text, prefix):
    """Balanced native s-expression blocks; quotes do not alter parenthesis depth."""
    for found in re.finditer(re.escape('(' + prefix) + r'\s', text):
        depth = 0
        quoted = escaped = False
        for i in range(found.start(), len(text)):
            c = text[i]
            if quoted:
                if escaped:
                    escaped = False
                elif c == '\\':
                    escaped = True
                elif c == '"':
                    quoted = False
            elif c == '"':
                quoted = True
            elif c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    yield text[found.start():i + 1]
                    break
        else:
            raise ValueError('Unbalanced native block')


def main():
    validate_frozen()
    spec = importlib.util.spec_from_file_location('immutable_clearance_helpers', BASE / 'audit_placement_clearance.py')
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    original = json.loads((BASE / 'placement-clearance-dimensions.json').read_text())
    native_path = ROOT / 'mechanical/native-geometry.json'
    assert sha(native_path) == original['native_geometry_sha256']
    native = json.loads(native_path.read_text())
    poses = {p['ref']: p for p in native['footprints']}
    rows = copy.deepcopy(original['parts'])
    by_ref = {p['ref']: p for p in rows}
    assert len(rows) == len(by_ref) == 80
    hro_path = SOURCES / 'hro-TYPE-C-31-M-12-family.pdf'
    murata_path = SOURCES / 'murata-ENFA0003-AN01.pdf'
    for p in (hro_path, murata_path):
        assert p.read_bytes().startswith(b'%PDF')
    assert sha(hro_path) == '1c23b78973c56e8dd83f1b46b8c31226f31ba0ea136ce3babd9f80bbaf2e7345'
    assert sha(murata_path) == '82694c0ea97fe0d08407dbb680c179e1354f7103a48d03c11ee97ea0a4593876'
    hro_url = 'https://omo-oss-file110.thefastfile.com/portal-saas/pg2026081913505947704/cms/file/type-c-31-m-12&12a&12b&12c(1).pdf'
    murata_url = 'https://pim.murata.com/asset/pim4/ferriteBeadInductortypefilter/ENFA0003_PDF_FERRITEBEADINDUCTORTYPEFILTER?lastModifiedDatetime=20250707190934'
    hro_source = dict(path=str(hro_path.relative_to(ROOT)), sha256=sha(hro_path), url=hro_url,
                      product_page_url='https://en.krhro.com/Product-Details/726.html',
                      product_page_path=str((SOURCES / 'hro-product-726.html').relative_to(ROOT)),
                      product_page_sha256=sha(SOURCES / 'hro-product-726.html'), page_1_based=4,
                      document='HRO TYPE-C-31-M-12, drawing date2020.12.08, RevA, basevariant',
                      artifact_kind='manufacturer_pdf', raw_manufacturer_pdf_archived=True,
                      basis='Exact chosen baseM12 sheet; otherfamily sheetsM12A/B/C are not substitutions. BodyL7.35,F(matingface-to-peg)6.28, both+/-0.15; contactprojection0.40+/-0.10; independent drawing limits retained.')
    murata_source = dict(path=str(murata_path.relative_to(ROOT)), sha256=sha(murata_path), url=murata_url,
                         page_1_based=5, exact_mpn_list_page_1_based=2,
                         document='Murata JENF243A_0003AN-01, current officialPIM asset retrieved2026-10-03',
                         artifact_kind='manufacturer_pdf', raw_manufacturer_pdf_archived=True,
                         basis='ExactBLM18AG601SN1D listedp2; p5 L1.6+/-0.15,W0.8+/-0.15,T0.8+/-0.15 forSN1. Geometry matches accepted maximum1.75x0.95x0.95mm.')
    j1 = by_ref['J1']
    # Diagram datum: X=body/peg-pair centerline, Y=peg centers, +Y=mating face.
    # Native peg Y=-2.60. Independent F,L,P bounds deliberately do not assume
    # supplier correlation: body rear=(F-L), tail tip=(F-L-P).
    F = [6.13, 6.43]
    L = [7.20, 7.50]
    P = [.30, .50]
    peg_y = -2.60
    body_y = [peg_y + F[0] - L[1], peg_y + F[1]]
    tail_y = [peg_y + F[0] - L[1] - P[1], peg_y + F[1] - L[0]]
    assert all(abs(a-b) < 1e-8 for a,b in zip(body_y, [-3.97, 3.83]))
    assert all(abs(a-b) < 1e-8 for a,b in zip(tail_y, [-4.47, -3.37]))
    j1.update(local_xy_max_mm=[9.14, 8.30], local_center_mm=[0, -.32], source=hro_source,
              body_xy_max_mm=[9.14, 7.80], envelope_includes_leads=True,
              body_local_center_mm=[0, -.07],
              body_local_bounds_mm=[[-4.57, -3.97], [4.57, 3.83]],
              full_package_local_bounds_mm=[[-4.57, -4.47], [4.57, 3.83]],
              manufacturer_body_width_max_mm=9.09,
              retained_width_registration_reserve_mm=.05,
              exposed_contact_tail_local_y_bounds_mm=tail_y,
              body_nominal_local_center_mm=[0, .005],
              tolerance_chain=dict(peg_native_local_y_mm=peg_y,mating_face_to_peg_range_mm=F,
                                   body_length_range_mm=L,exposed_contact_projection_range_mm=P,
                                   independent_dimension_extrema=True,supplier_correlation_assumed=False),
              specification_key='J1_SUPPLEMENT_FULL_TOLERANCED_BODY_AND_LEADS')
    by_ref['FB1'].update(source=murata_source, specification_key='BLM18AG601SN1D_CURRENT_AN01')
    for row in rows:
        n = poses[row['ref']]
        assert row['native_center_board_mm'] == n['center_board_mm']
        assert row['native_angle_deg'] == n['angle_board_deg']
        half_x, half_y = [v/2 for v in row['local_xy_max_mm']]
        ox,oy = row['local_center_mm']
        corners = [[ox+x,oy+y] for x,y in itertools.product((-half_x,half_x),(-half_y,half_y))]
        radius = max(math.hypot(x,y) for x,y in corners)
        inflation = .10 + 2*radius*math.sin(math.radians(.5))
        bb = helpers.bounds(row['native_center_board_mm'], row['native_angle_deg'], row['local_xy_max_mm'],row['local_center_mm'])
        row.update(package_max_bounds_board_mm=bb,
                   independent_placement_envelope_board_mm=[[v-inflation for v in bb[0]],[v+inflation for v in bb[1]]],
                   placement_envelope_inflation_per_side_mm=inflation,
                   placement_rotation_radius_about_native_origin_mm=radius,
                   rotation_radius_method='maximum norm of four local envelope corners about native footprint origin')
    updates = [by_ref[r] for r in ('J1','FB1')]
    dimensions = dict(schema_version=1,supplement_version=1,scope='Overlay these two parts onto immutable80-ref dimensions',
                      source_board_sha256=BOARD_SHA,source_design_data_sha256=DESIGN_SHA,
                      base_dimensions_path='manufacturing/placement-clearance-dimensions.json',
                      base_dimensions_sha256=BASE_DIMENSIONS_SHA,base_manifest_sha256=BASE_MANIFEST_SHA,
                      native_geometry_sha256=sha(native_path),generator_sha256=sha(Path(__file__)),
                      fitted_count_after_merge=80,parts=updates,source_documents=[hro_source,murata_source],
                      axes=original['axes'],height_note=original['height_note'])
    dim_path = BASE / 'placement-clearance-supplement-dimensions.json'
    dim_path.write_text(json.dumps(dimensions,indent=2)+'\n')
    pairs = []
    for a,b in itertools.combinations(rows,2):
        d,area = helpers.distance(a['package_max_bounds_board_mm'],b['package_max_bounds_board_mm'])
        sd,sa = helpers.distance(a['independent_placement_envelope_board_mm'],b['independent_placement_envelope_board_mm'])
        pairs.append(dict(refs=[a['ref'],b['ref']],manufacturer_max_gap_mm=d,
                          manufacturer_max_rectangle_overlap_mm2=area,assumed_placement_screen_gap_mm=sd,
                          assumed_placement_rectangle_overlap_mm2=sa))
    pairs.sort(key=lambda p:(p['manufacturer_max_gap_mm'],p['refs']))
    assert len(pairs)==3160
    angle=math.radians(j1['native_angle_deg']); c,s=math.cos(angle),math.sin(angle)
    pads=[]
    for p in poses['J1']['pads']:
        dx,dy=[a-b for a,b in zip(p['center_board_mm'],j1['native_center_board_mm'])]
        local=[round(dx*c-dy*s,9),round(dx*s+dy*c,9)]
        pads.append(dict(number=p['number'],local_center_mm=local,datum_center_mm=[local[0],round(local[1]-peg_y,9)],
                         copper_size_mm=p['size_mm'],drill_size_mm=p['drill_size_mm'],native_attribute=p['attribute']))
    p1=next(p for p in pads if p['number']=='A1')
    native_tail_pad_y=[p1['local_center_mm'][1]-p1['copper_size_mm'][1]/2,
                       p1['local_center_mm'][1]+p1['copper_size_mm'][1]/2]
    assert all(abs(a-b)<1e-8 for a,b in zip(native_tail_pad_y,[-4.77,-3.32]))
    assert native_tail_pad_y[0] <= tail_y[0] and native_tail_pad_y[1] >= tail_y[1]
    contact_groups=[]
    for group,pad_name,centers,tols,nominal_land_center in [
        ('GNDnegative','A1',[-3.325,-3.075],[.075,.075],-3.20),
        ('VBUSnegative','A4',[-2.525,-2.275],[.075,.050],-2.40),
        *[(name,name,[x],[.050],x) for name,x in [('B8',-1.75),('A5',-1.25),('B7',-.75),('A6',-.25),('A7',.25),('B6',.75),('A8',1.25),('B5',1.75)]],
        ('VBUSpositive','A9',[2.275,2.525],[.050,.075],2.40),
        ('GNDpositive','A12',[3.075,3.325],[.075,.075],3.20)]:
        pp=next(p for p in pads if p['number']==pad_name)
        px=pp['local_center_mm'][0]; width=pp['copper_size_mm'][0]
        land=[px-width/2,px+width/2]
        maximum_projection=[min(x-t-.125 for x,t in zip(centers,tols)),max(x+t+.125 for x,t in zip(centers,tols))]
        overlaps=[]
        for x,t in zip(centers,tols):
            for delta,w in itertools.product((-t,t),(.15,.25)):
                overlaps.append(max(0,min(land[1],x+delta+w/2)-max(land[0],x+delta-w/2)))
        assert min(overlaps)>0
        contact_groups.append(dict(group=group,native_pad_name=pad_name,native_land_x_bounds_mm=land,
                                   recommended_land_center_x_mm=nominal_land_center,
                                   native_minus_recommended_center_x_mm=round(px-nominal_land_center,9),
                                   physical_lead_nominal_centers_x_mm=centers,
                                   independent_physical_center_tolerances_x_mm=tols,
                                   physical_lead_width_range_mm=[.15,.25],
                                   maximum_physical_lead_projection_x_mm=maximum_projection,
                                   maximum_projection_beyond_native_copper_mm=max(0,land[0]-maximum_projection[0],maximum_projection[1]-land[1]),
                                   minimum_independent_tolerance_copper_overlap_x_mm=min(overlaps)))
    # Native board has a USB tongue. Its Edge.Cuts datum is -2.0 board mm,
    # not the main board's0.0 boundary; check the actual c6 board segment.
    text=(ROOT/'fieldnote.kicad_pcb').read_text()
    edge_segments=[]
    for block in blocks(text,'gr_line'):
        if '(layer "Edge.Cuts")' not in block:continue
        ends=[list(map(float,re.search(r'\('+name+r'\s+([-\d.]+)\s+([-\d.]+)\)',block).groups())) for name in ('start','end')]
        edge_segments.append([[x-native['native_origin_mm'][0],y-native['native_origin_mm'][1]] for x,y in ends])
    assert any(abs(a[1]+2)<1e-9 and abs(b[1]+2)<1e-9 and min(a[0],b[0])<j1['native_center_board_mm'][0]<max(a[0],b[0]) for a,b in edge_segments)
    report=dict(schema_version=1,supplement_version=1,
                status='PASS_SUPPLEMENTAL_MAX_PACKAGE_SEPARATION_CONDITIONAL_ASSEMBLY_ACCEPTANCE' if not any(p['manufacturer_max_rectangle_overlap_mm2']>1e-9 or p['assumed_placement_rectangle_overlap_mm2']>1e-9 for p in pairs) else 'OVERLAP_REQUIRES_REVIEW',
                source_board_sha256=BOARD_SHA,source_design_data_sha256=DESIGN_SHA,
                base_manifest_sha256=BASE_MANIFEST_SHA,base_dimensions_sha256=BASE_DIMENSIONS_SHA,
                dimensions_sha256=sha(dim_path),native_geometry_sha256=sha(native_path),generator_sha256=sha(Path(__file__)),
                fitted_components=80,pair_checks=3160,all_parts=rows,
                minimum_manufacturer_max_gap_mm=pairs[0]['manufacturer_max_gap_mm'],
                closest_nominal_pair=pairs[0],closest_assumed_placement_pair=min(pairs,key=lambda p:p['assumed_placement_screen_gap_mm']),
                manufacturer_max_overlap_pairs=[p for p in pairs if p['manufacturer_max_rectangle_overlap_mm2']>1e-9],
                assumed_placement_overlap_pairs=[p for p in pairs if p['assumed_placement_rectangle_overlap_mm2']>1e-9],
                closest_j1_pairs=sorted([p for p in pairs if 'J1' in p['refs']],key=lambda p:p['manufacturer_max_gap_mm'])[:8],
                all_pairs=pairs,
                j1_registration=dict(datum='X centerline of peg pair;Ypegcenters0,+Ytowardmatingface; nativepegY=-2.60',
                    native_pads=pads,contact_groups=contact_groups,
                    native_contact_local_y_bounds_mm=native_tail_pad_y,
                    maximum_contact_tail_local_y_bounds_mm=tail_y,
                    full_tail_y_contained_by_nominal_native_copper=True,
                    y_containment_margins_mm=[tail_y[0]-native_tail_pad_y[0],native_tail_pad_y[1]-tail_y[1]],
                    recommended_contact_datum_y_bounds_mm=[-1.64,-.50],
                    recommended_contact_height_inferred_mm=1.14,
                    native_minus_recommended_contact_center_y_mm=-.375,
                    recommended_contact_height_inference='padtop-to-peg1.64 minus padbottom-to-peg0.50; this is not the1.70 shell-slotcallout',
                    shell_rear=dict(native_datum_y_mm=-.53,recommended_datum_y_mm=-.50,
                                    native_drill_mm=[.60,1.70],recommended_drill_mm=[.60,1.70],
                                    native_copper_mm=[1.00,2.10],recommended_copper_mm=[.90,2.00]),
                    shell_front=dict(native_datum_y_mm=3.65,recommended_datum_y_mm=3.68,
                                     native_drill_mm=[.60,1.40],recommended_drill_mm=[.60,1.40],
                                     native_copper_mm=[1.00,1.70],recommended_copper_mm=[.90,1.70]),
                    shell_x_abs_native_mm=4.320,shell_x_abs_recommended_mm=4.325,shell_row_spacing_mm=4.18,
                    peg_native_x_abs_mm=2.89,peg_recommended_x_abs_mm=2.89,
                    peg_native_npth_diameter_mm=.65,peg_recommended_npth_diameter_mm=.60,
                    component_peg_diameter_range_mm=[.40,.60],
                    native_body_fab_nominal_xy_mm=[8.94,7.30],
                    drawing_body_nominal_xy_mm=[8.94,7.35],
                    drawing_nominal_body_local_y_bounds_mm=[-3.67,3.68],
                    native_fab_nominal_body_local_y_bounds_mm=[-3.65,3.65],
                    body_max_height_mm=3.36,assembly_seating_allowance_mm=.05,
                    pcb_tongue_edge_board_y_mm=-2.0,pcb_tongue_edge_datum_y_mm=4.80,
                    recommended_pcb_edge_datum_y_mm=5.79-1.64,
                    edge_forward_deviation_mm=.65,
                    nominal_manufacturer_mating_face_overhang_mm=1.48,
                    recommended_nominal_mating_face_overhang_mm=2.13,
                    nominal_front_drill_to_edge_gap_mm=.45,nominal_front_copper_to_edge_gap_mm=.30,
                    pcb_layout_drawing_tolerance_mm=.05,
                    exact_variant_documented=True,supplied_variant_confirmed_by_assembler=False),
                fb1=dict(current_official_document='JENF243A_0003AN-01',raw_source_sha256=sha(murata_path),
                         maximum_package_xy_mm=[1.75,.95],maximum_package_height_mm=.95,
                         assumed_seating_reserve_mm=.10,modeled_assembled_height_mm=1.05,
                         accepted_original_envelope_unchanged=True,documentary_geometry_gap_closed=True,
                         solder_standoff_measured=False),
                limitations=['Nativecontactcopper is enlarged/shifted relative recommendedlandpattern; positiveoverlap is not fulltolXcontainment or solderprocessqualification.',
                             'TailY containment uses componentdrawinglimits relativepegdatum and nominalcopper; excludes actualplacement/boardfaberrors and does not assert fillet/nozzle/reworkacceptance.',
                             'Rotation allowance is continuous about nativeorigin with maximumcornerradius; independent±0.10mm/±1degree is an engineering screen,not assemblercapability.',
                             'HRO exactbaseM12 drawing is available; suppliermust lock that variant/revision and assemblermust accept the deviations. Productpagegeneric3.16mm height is not used instead of baseM12drawing3.26mm.',
                             'Independentdatum/body/contacttolerances intentionally use conservative combinations; no suppliercorrelation presumed.',
                             'This review establishes componentseparation and drawingcomparison, not enclosure/fillet/assemblyprocessqualification.'],
                frozen_base_34_members_unchanged=True)
    validate_frozen()
    output=BASE/'placement-clearance-supplement-review.json'
    output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(dict(status=report['status'],dimensions_sha256=sha(dim_path),dimensions_bytes=dim_path.stat().st_size,
                         minimum_nominal_pair=report['closest_nominal_pair'],minimum_assumed_pair=report['closest_assumed_placement_pair'],
                         closest_j1_pairs=report['closest_j1_pairs'][:3],j1_rotation_radius_mm=j1['placement_rotation_radius_about_native_origin_mm'],
                         j1_inflation_mm=j1['placement_envelope_inflation_per_side_mm']),indent=2))


if __name__=='__main__':
    main()
