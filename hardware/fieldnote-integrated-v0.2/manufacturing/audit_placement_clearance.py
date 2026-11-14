"""Read-only fitted-component clearance screen using reviewed vendor envelopes.

Never saves CAD or modifies design metadata. All native placement centers and
angles come from the already extracted, hash-bound KiCad geometry. Manufacturer
dimension/tolerance assignments are explicit below, not inferred from pads.
"""
from pathlib import Path
import hashlib
import itertools
import json
import math

ROOT = Path(__file__).resolve().parents[1]
BOARD_SHA = 'c6c7ff173b25e8f182a084e327d3c602c3bc24246ff914d45e3b7228775e2456'
DESIGN_SHA = 'ac013ae9e9c12a99ecdc8f7ff99909f215e4ed712e52035d55024d073d69b274'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source(path, url, page, basis):
    p = ROOT / path
    return dict(path=path, sha256=sha(p) if p.exists() else None,
                url=url, page_1_based=page, basis=basis,
                artifact_kind='reviewer_transcription_primary_vendor_document' if path.endswith('reviewed-dimensions.json') else 'manufacturer_pdf',
                raw_manufacturer_pdf_archived=not path.endswith('reviewed-dimensions.json'))


def specifications():
    s = {}

    def add(key, size, height, src, body=None):
        s[key] = dict(local_xy_max_mm=size, local_center_mm=[0, 0],
                      package_max_height_mm=height, source=src,
                      envelope_includes_leads=True,
                      body_xy_max_mm=body or size)

    def ref(name, size, height, path, url, page, basis, body=None):
        add(name, size, height, source(path, url, page, basis), body)

    ref('U1', [13.35, 16.75], 2.55,
        'references/power-review/esp32-c3-mini-1_datasheet_en.pdf',
        'https://www.espressif.com/sites/default/files/documentation/esp32-c3-mini-1_datasheet_en.pdf', 35,
        'Figure10-1:13.2+/-0.15 x16.6+/-0.15 x2.4+/-0.15 mm; MINI-1 N4X has this package. Native/library body is centered at local[0,0].')
    ref('U2', [6.25, 6.25], 1.0,
        'manufacturing/clearance-sources/SOT618-1.pdf',
        'https://www.nxp.com/docs/en/package-information/SOT618-1.pdf', 2,
        'D/E max6.10 mm plus0.075 mm protrusion per side; seated height1.00 mm max.')
    ref('U3', [3.10, 3.10], 1.0,
        'references/power-review/bq24074.pdf',
        'https://www.ti.com/lit/ds/symlink/bq24074.pdf', 52,
        'RGT0016C package outline3.10 x3.10 mm maxima;1.00 mm seated height.')
    ref('U4', [2.60, 2.60], .80,
        'references/power-review/tps63031.pdf',
        'https://www.ti.com/lit/ds/symlink/tps63031.pdf', 24,
        'DSK0010A package outline2.60 x2.60 mm maxima;0.80 mm seated height.')
    ref('U5', [3.00, 3.05], 1.45,
        'manufacturing/clearance-sources/usblc6-2-reviewed-dimensions.json',
        'https://www.st.com/resource/en/datasheet/usblc6-2.pdf', 12,
        'SOT23-6L Table3 H(full lead span)=3.00,D(body length)=3.05,E(body width)=1.75 mm max. LocalX lead span,localY length.', [1.75, 3.05])
    ref('U6', [1.65, 1.65], .40,
        'manufacturing/clearance-sources/tusb320lai.pdf',
        'https://www.ti.com/lit/ds/symlink/tusb320lai.pdf', 35,
        'RWB0012A package outline1.65 x1.65 mm maxima;0.40 mm seated height.')
    ref('U7', [3.00, 3.55], 1.45,
        'manufacturing/clearance-sources/sn74lvc1g04.pdf',
        'https://www.ti.com/lit/ds/symlink/sn74lvc1g04.pdf', 37,
        'DBV0005A lead span3.00 max;body length3.05,width1.75,max0.25 mm mold flash per side gives body3.55 x2.25. LocalX lead span,localY length.', [2.25, 3.55])
    ref('D4', [2.50, 3.00], 1.10,
        'references/bav199.pdf', 'https://www.diodes.com/assets/Datasheets/BAV199.pdf', 4,
        'SOT23 drawing C full lead span2.50,H body length3.00,B body width1.40,K1 height1.10 maxima. LocalX lead span,localY length.', [1.40, 3.00])
    ref('J1', [9.14, 7.55], 3.36,
        'references/usb-c-hro.pdf', None, 1,
        'HRO drawing8.94 wide,7.35 length;5-10 mm general tolerance+/-0.15 mm. Width9.09 maximum. Screen reserves9.14 x7.55 around native local[0,0], including0.025 mm center-registration allowance per end beyond7.50 maximum; native F.Fab7.30 length is slightly shorter than drawing7.35. Verify supplier actual registration before ordering.')
    for r in ['L1', 'L2']:
        ref(r, [1.80, 1.118], 1.12,
            'manufacturing/clearance-sources/0603ls.pdf',
            'https://www.coilcraft.com/getmedia/50061a32-b9f8-4dc5-bb10-57c731e20d9c/0603ls.pdf', 1,
            '0603LS-561 table overall widthB1=1.016+/-0.102;A max1.80;C max1.12 mm. Optional solder adds0.152 mm height,handled separately.')
    ref('L3', [3.156, 3.156], 1.63,
        'references/coilcraft-lps3015.pdf',
        'https://www.coilcraft.com/en-us/products/power/shielded-inductors/ferrite-drum/lps/lps3015/', 2,
        'Drawing case2.95+/-0.076 mm square,height1.4+/-0.1. Starred case dimensions exclude terminations;add0.13 mm for overall =>3.156 square,height1.63. Conservative drawing bound retained over less-than1.5 mm summary. No optionalQ/P allowance for exactR termination.')
    ref('Y1', [3.40, 2.70], .80,
        'references/abm8.pdf', 'https://abracon.com/Resonators/ABM8.pdf', 2,
        'ABM8 outline3.2+/-0.20 x2.5+/-0.20 mm;standard height0.80 mm max.')
    for r in ['SW1', 'SW2']:
        ref(r, [3.65, 2.85], .90,
            'references/tl3701.pdf', 'https://www.e-switch.com/wp-content/uploads/2022/11/TL3701AF100QG.pdf', 1,
            'N370011 RevB:body3.00 x2.60,full terminal span3.40 localX,height0.65;general x.xx+/-0.25 =>full3.65 x2.85,height0.90.', [3.25, 2.85])
    for r, name in [('D1', 'sgc'), ('D2', 'seck'), ('D3', 'surck')]:
        ref(r, [2.10, 1.35], .85,
            'references/apt2012'+name+'.pdf',
            'https://www.kingbrightusa.com/images/catalog/SPEC/APT2012'+name.upper()+'.pdf', 1,
            'APT2012 outline2.0 x1.25 x0.75 mm;general dimension tolerance+/-0.10 mm.')
    add('RC0603', [1.70, .90], .55,
        source('manufacturing/clearance-sources/RC-family.pdf',
               'https://www.yageogroup.com/content/datasheet/asset/file/PYU-RC_GROUP_51_ROHS_L', 4,
               'RC_L family Table1 explicitly covers RC0603 across resistance values:1.60+/-0.10 x0.80+/-0.10 x0.45+/-0.10 mm.'))
    add('CRCW0805HP', [2.15, 1.40], .60,
        source('manufacturing/clearance-sources/crcwhpe3.pdf',
               'https://www.vishay.com/docs/20043/crcwhpe3.pdf', 9,
               'Exact HP family CRCW0805 dimensions2.0+/-0.15 x1.25+/-0.15 x0.5+/-0.10 mm.'))
    for mpn in ['CC0603KRX7R9BB104', 'CC0603JRNPO9BN330', 'CC0603JRNPO0BN221',
                'CC0603JRNPO0BN750', 'CC0603JRNPO9BN391', 'CC0603JRNPO9BN102', 'CC0603JRNPO9BN360']:
        add(mpn, [1.70, .90], .90,
            source('manufacturing/clearance-sources/'+mpn+'.pdf',
                   'https://yageogroup.com/download/specsheet/'+mpn, 1,
                   'Exact generated manufacturer specification:1.6+/-0.1 x0.8+/-0.1 x0.8+/-0.1 mm.'))
    add('C0603C105K4RACTU', [1.75, .95], .90,
        source('references/power-review/kemet-C0603C105K4RACTU.pdf',
               'https://search.kemet.com/component-documentation/download/specsheet/C0603C105K4RACTU', 1,
               'Exact KEMET specL1.6+/-0.15,W0.8+/-0.15,T0.8+/-0.10 mm.'))
    add('C0805C226M8PACTU', [2.20, 1.45], 1.45,
        source('references/power-review/kemet-C0805C226M8PACTU.pdf',
               'https://search.kemet.com/component-documentation/download/specsheet/C0805C226M8PACTU', 1,
               'Exact KEMET specL2.0+/-0.20,W1.25+/-0.20,T1.25+/-0.20 mm.'))
    for mpn, wh, height in [('CL21A106KOCLRNC', [2.20,1.45], .95), ('CL21A475KOFNNNE', [2.10,1.35],1.35)]:
        add(mpn, wh, height,
            source('references/power-review/'+mpn[:-1]+'-specsheet.pdf',
                   'https://product.samsungsem.com/mlcc/'+mpn[:-1]+'.do', 1,
                   'Exact Samsung Reference Sheet structure/dimension table including tolerance.'))
    add('BLM18AG601SN1D', [1.75,.95], .95,
        source('manufacturing/clearance-sources/murata-BLM18-reviewed-dimensions.json',
               'https://www.mouser.com/datasheet/2/281/ENFA0003-769587.pdf', 4,
               'Murata JENF243A-0003W-01 manufacturer reference:BLM18AG drawingL1.6+/-0.15,W/T0.8+/-0.15 mm;exactAG601SN1D listedp2. Reviewer transcription of primary manufacturer document;rawPDFnot archived and currentAM01URL unavailable. Confirm supplied current package drawing before ordering.'))
    return s


def bounds(center, angle, size, offset=(0,0)):
    t = math.radians(angle)
    c,s = math.cos(t),math.sin(t)
    corners=[]
    for x,y in itertools.product((-size[0]/2,size[0]/2),(-size[1]/2,size[1]/2)):
        x+=offset[0];y+=offset[1]
        corners.append([center[0]+x*c+y*s,center[1]-x*s+y*c])
    return [[min(q[i] for q in corners) for i in (0,1)],
            [max(q[i] for q in corners) for i in (0,1)]]


def distance(a,b):
    axes=[max(0,a[0][i]-b[1][i],b[0][i]-a[1][i]) for i in (0,1)]
    overlap=[max(0,min(a[1][i],b[1][i])-max(a[0][i],b[0][i])) for i in (0,1)]
    return math.hypot(*axes),overlap[0]*overlap[1]


def main():
    assert sha(ROOT/'fieldnote.kicad_pcb')==BOARD_SHA
    assert sha(ROOT/'design-data.json')==DESIGN_SHA
    native_path=ROOT/'mechanical/native-geometry.json'
    native=json.loads(native_path.read_text())
    assert native['source_sha256']['fieldnote.kicad_pcb']==BOARD_SHA
    assert native['source_sha256']['design-data.json']==DESIGN_SHA
    parts=json.loads((ROOT/'design-data.json').read_text())['parts']
    fitted=[p for p in parts if not p['dnp'] and p['ref']!='ANT1' and not p['ref'].startswith('TP')]
    assert len(fitted)==80
    poses={p['ref']:p for p in native['footprints']}
    specs=specifications(); rows=[]
    for p in fitted:
        ref=p['ref'];mpn=p['mpn'];n=poses[ref]
        key=ref if ref in specs else ('RC0603' if mpn.startswith('RC0603') else ('CRCW0805HP' if mpn=='CRCW08051R50FKEAHP' else mpn))
        sp=specs[key]
        assert all(abs(a-b)<1e-6 for a,b in zip(n['center_board_mm'],p['xy']))
        assert min((n['angle_board_deg']-p['angle'])%360,(p['angle']-n['angle_board_deg'])%360)<1e-6
        assert abs(n['angle_board_deg']%90)<1e-6,'AABB distance only exact for cardinal orientations'
        bb=bounds(n['center_board_mm'],n['angle_board_deg'],sp['local_xy_max_mm'],sp['local_center_mm'])
        allowance=.05 if ref=='J1' else (.16 if ref in ('L1','L2') else .10)
        # Conservative continuous independent placement screen: +/-0.10 mm XY
        # and +/-1 degree rotation; not a claimed assembler capability. Any
        # corner moves <=2*r*sin(delta/2) under that rotation.
        radius=math.hypot(*sp['local_xy_max_mm'])/2
        inflate=.10+2*radius*math.sin(math.radians(1)/2)
        screened=[[v-inflate for v in bb[0]],[v+inflate for v in bb[1]]]
        rows.append(dict(ref=ref,mpn=mpn,footprint=p['fp'],native_center_board_mm=n['center_board_mm'],
                         native_angle_deg=n['angle_board_deg'],specification_key=key,**sp,
                         package_max_bounds_board_mm=bb,assembly_seating_allowance_mm=allowance,
                         modeled_assembled_height_mm=sp['package_max_height_mm']+allowance,
                         independent_placement_envelope_board_mm=screened,
                         placement_envelope_inflation_per_side_mm=inflate))
    sources={s['source']['path']:s['source'] for s in specs.values()}
    dims=dict(schema_version=1,source_board_sha256=BOARD_SHA,source_design_data_sha256=DESIGN_SHA,
              native_geometry_sha256=sha(native_path),generator_sha256=sha(Path(__file__)),
              axes='localX/localY are native footprint axes; board+Y points down;KiCad transform x*cos+y*sin,-x*sin+y*cos',
              fitted_count=80,excluded=['C7','J2','J3','J4','ANT1','all TP refs'],
              height_note='Height+seating is provided for enclosure reuse;component-component audit checks XY envelopes only.',
              source_documents=list(sources.values()),parts=rows)
    dims_path=ROOT/'manufacturing/placement-clearance-dimensions.json'
    dims_path.write_text(json.dumps(dims,indent=2)+'\n')
    pairs=[]
    for a,b in itertools.combinations(rows,2):
        d,area=distance(a['package_max_bounds_board_mm'],b['package_max_bounds_board_mm'])
        sd,sa=distance(a['independent_placement_envelope_board_mm'],b['independent_placement_envelope_board_mm'])
        pairs.append(dict(refs=[a['ref'],b['ref']],manufacturer_max_gap_mm=d,
                          manufacturer_max_rectangle_overlap_mm2=area,
                          assumed_placement_screen_gap_mm=sd,
                          assumed_placement_rectangle_overlap_mm2=sa))
    pairs.sort(key=lambda p:(p['manufacturer_max_gap_mm'],p['refs']))
    missing=[s for s in sources.values() if s['sha256'] is None]
    report=dict(schema_version=1,status='PASS_NOMINAL_VENDOR_ENVELOPES_CONDITIONAL_ASSEMBLY_ACCEPTANCE' if not missing and not any(p['manufacturer_max_rectangle_overlap_mm2']>1e-9 for p in pairs) else 'INCOMPLETE_SOURCE_OR_OVERLAP',
                source_board_sha256=BOARD_SHA,source_design_data_sha256=DESIGN_SHA,
                dimensions_sha256=sha(dims_path),native_geometry_sha256=sha(native_path),
                generator_sha256=sha(Path(__file__)),fitted_components=80,pair_checks=len(pairs),
                manufacturer_max_overlap_pairs=[p for p in pairs if p['manufacturer_max_rectangle_overlap_mm2']>1e-9],
                assumed_placement_overlap_pairs=[p for p in pairs if p['assumed_placement_rectangle_overlap_mm2']>1e-9],
                closest_pairs=pairs[:25],minimum_manufacturer_max_gap_mm=pairs[0]['manufacturer_max_gap_mm'],
                minimum_assumed_placement_screen_gap_mm=min(p['assumed_placement_screen_gap_mm'] for p in pairs),
                assumed_independent_placement_budget=dict(xy_each_axis_mm=.10,rotation_deg=1,validated_by_assembler=False),
                source_documents_missing=missing,
                existing_case_audit_coverage_issue=dict(prior_count=75,missing_refs=['U6','U7','D4','R22','R23'],cause='fab_bounds only fp_line; five fitted parts omitted',resolution='case_retention agent rerunning separate complete enclosure audit; this report does not prove enclosure clearance'),
                existing_envelope_dimension_corrections=['L3 overall package height1.63 plus0.10 seating=1.73 mm','Y1 XY maximum3.40x2.70 mm','SW1/SW2 full terminal-span maximum3.65x2.85 mm','J1 XY registration reserve7.55 mm length'],
                limitations=['Maximum rectangles include terminals and permitted molding protrusions, but local solder fillets/nozzle/rework access/warpage/rotation-to-board tolerances require assembler acceptance.',
                             'The independent placement +/-0.10 mm and +/-1 degree screen is an assumed engineering allowance;it is not PCBWay process qualification.',
                             'J1 registration allowance is conservative around native body center;check supplied connector drawing against land pattern.',
                             'No pair is cleared by vertical staggering:all fitted parts are on F.Cu and this screen conservatively forbids projected envelope overlap.',
                             'Native 0DRC with missing_courtyard ignored is not proof of physical package,placement or rework clearance.'],
                all_pairs=pairs,source_unchanged_after_check=True)
    assert sha(ROOT/'fieldnote.kicad_pcb')==BOARD_SHA and sha(ROOT/'design-data.json')==DESIGN_SHA
    out=ROOT/'manufacturing/placement-clearance-review.json'
    out.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ['status','fitted_components','pair_checks','minimum_manufacturer_max_gap_mm','minimum_assumed_placement_screen_gap_mm','manufacturer_max_overlap_pairs','assumed_placement_overlap_pairs','source_documents_missing']},indent=2))


if __name__=='__main__':
    main()
