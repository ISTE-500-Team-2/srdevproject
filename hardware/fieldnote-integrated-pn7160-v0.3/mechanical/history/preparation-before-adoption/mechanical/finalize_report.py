"""Bind finished PN7160 results; never turn a failed or seed audit into PASS."""
from pathlib import Path
import json
from freeze_inputs import require_owner_freeze, assert_unchanged, sha256

ROOT=Path(__file__).resolve().parents[1]
HERE=ROOT/'mechanical'


def member(name):
    path=ROOT/name
    return dict(path=name,sha256=sha256(path),bytes=path.stat().st_size)


def main():
    freeze,inputs=require_owner_freeze(ROOT)
    audit=json.loads((ROOT/'simulation/results/mechanical.json').read_text())
    retention=json.loads((HERE/'retention-checks.json').read_text())
    native=json.loads((HERE/'native-geometry.json').read_text())
    pads=json.loads((ROOT/'simulation/results/native-pad-transform.json').read_text())
    dimensions=json.loads((ROOT/'manufacturing/v03-placement-clearance-dimensions.json').read_text())
    for report in (audit,retention,native,pads):
        assert report['variant']=='PN7160_v03'
    assert native['status']=='PASS_NATIVE_EXTRACTION'
    assert pads['status']=='PASS_NATIVE_PAD_GEOMETRY'
    assert native['source_sha256']['fieldnote.kicad_pcb']==pads['source_sha256']['fieldnote.kicad_pcb']==inputs['fieldnote.kicad_pcb']
    assert native['source_sha256']['design-data.json']==pads['source_sha256']['design-data.json']==inputs['design-data.json']
    assert_unchanged(ROOT,audit['input_sha256'])
    assert_unchanged(ROOT,pads['source_sha256'])
    assert retention['native_board_sha256']==inputs['fieldnote.kicad_pcb']
    assert retention['design_data_sha256']==inputs['design-data.json']
    assert retention['manufacturer_dimensions_sha256']==sha256(ROOT/'manufacturing/v03-placement-clearance-dimensions.json')
    expected={p['ref'] for p in dimensions['parts']}
    assert len(expected)==78 and set(audit['component_envelopes_mm'])==expected
    assert all(p['manufacturer_maximum_contained'] for p in audit['fitted_component_coverage']['components'])
    fields=('status','stack_sweep_cases','rigid_collision_cases','continuous_XY_pose_envelope_cases',
        'continuous_XY_pose_collision_cases','pad_bulge_component_collision_cases',
        'continuous_pad_bulge_envelope_cases','continuous_pad_bulge_component_collision_cases')
    nominal={key:retention[key] for key in fields}
    assumed={key:retention['assumed_independent_component_placement'][key] for key in fields}
    for screen in (nominal,assumed):
        assert screen['stack_sweep_cases']==243
        assert screen['continuous_XY_pose_envelope_cases']==screen['continuous_pad_bulge_envelope_cases']==27
    assert nominal['status']=='PASS_BOUNDED_GEOMETRY' and assumed['status']=='PASS_ASSUMED_COMPONENT_PLACEMENT', 'Do not freeze a failed mechanical candidate as PASS; report the interference to root.'
    assert all(value==0 for key,value in nominal.items() if 'collision_cases' in key)
    assert all(value==0 for key,value in assumed.items() if 'collision_cases' in key)
    files=['simulation/results/mechanical.json','mechanical/retention-checks.json',
        'mechanical/native-geometry.json','simulation/results/native-pad-transform.json',
        'mechanical/native-freeze.json','mechanical/retention-parameters.json',
        'mechanical/height-envelope-sources.json','simulation/simulate_mechanical.py',
        'simulation/verify_native_pads.py','mechanical/design_retention.py',
        'mechanical/freeze_inputs.py','mechanical/extract_native_geometry.py',
        'mechanical/render_preview.py','mechanical/finalize_report.py','mechanical/README.txt',
        'mechanical/retention-preview.png','mechanical/retention-preview.svg',
        'simulation/results/pcb-component-envelopes.stl',
        'manufacturing/v03-package-catalog.json','manufacturing/v03-placement-clearance-dimensions.json',
        'manufacturing/v03-clearance-native-geometry.json']+[f['path'] for f in retention['files']]
    for artifact in retention['files']:
        assert sha256(ROOT/artifact['path'])==artifact['sha256']
    parameters=retention['parameters'];j1=audit['component_envelopes_mm']['J1']
    delta=audit['assumptions']['J1_independent_XY_inflation_mm']+parameters['xy_pose_allowance_mm']
    opening=parameters['usb_opening_bounds_mm']
    margin=min(j1[0][0]-delta-opening[0][0],opening[1][0]-j1[1][0]-delta)
    result=dict(status='PASS_PN7160_78_COMPONENT_R2_DECLARED_GEOMETRY_SCREENS',variant='PN7160_v03',
        owner_freeze=freeze,source_board_sha256=inputs['fieldnote.kicad_pcb'],source_design_data_sha256=inputs['design-data.json'],
        source_dimensions_sha256=retention['manufacturer_dimensions_sha256'],
        fitted_component_count=78,all_manufacturer_maxima_contained=True,
        native_screen=nominal,assumed_screen=dict(assumed,process_assumptions=retention['assumed_independent_component_placement']['process_assumptions']),
        J1_full_body_contact_case_prism_mm=j1,J1_combined_opening_side_margin_mm=margin,
        USB_tail_to_upward_tolerance_floor_minimum_mm=retention['USB_tail_to_upward_tolerance_floor_minimum_mm'],
        compliant_pad_gap_range_mm=retention['compliant_pad_gap_range_mm'],
        pad_required_compression_fraction_range=retention['pad_required_compression_fraction_range'],
        all_earlier_PN532_results_not_inherited=True,files=[member(name) for name in files],
        not_manufacturing_release=True,
        disposition='Engineering REVIEW/HOLD: supplier/source registration, assumed process budgets, physical print, retention, compliant pad and mating plug qualification remain pending.')
    assert_unchanged(ROOT,inputs)
    target=HERE/'freeze-refresh.json';target.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(path=str(target.relative_to(ROOT)),sha256=sha256(target),status=result['status'],files=len(files)),indent=2))


if __name__=='__main__':
    main()
