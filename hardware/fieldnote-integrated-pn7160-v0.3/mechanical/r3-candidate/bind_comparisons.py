"""Bind the constrained R3 exploration without declaring a case adoption."""
from pathlib import Path
import json
from freeze_inputs import require_owner_freeze,assert_unchanged,sha256

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]


def member(path):
    return dict(path=str(path.relative_to(ROOT)),sha256=sha256(path),bytes=path.stat().st_size)


def hull(points):
    def cross(o,a,b):return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
    pts=sorted(set(tuple(p) for p in points));lower=[];upper=[]
    for p in pts:
        while len(lower)>=2 and cross(lower[-2],lower[-1],p)<=0:lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper)>=2 and cross(upper[-2],upper[-1],p)<=0:upper.pop()
        upper.append(p)
    return lower[:-1]+upper[:-1]


def contains(polygon,point):
    return all((b[0]-a[0])*(point[1]-a[1])-(b[1]-a[1])*(point[0]-a[0])>=-1e-9
               for a,b in zip(polygon,polygon[1:]+polygon[:1]))


def main():
    freeze,inputs=require_owner_freeze(ROOT)
    local=json.loads((HERE/'contact4-comparisons.json').read_text())
    nonlocal_=json.loads((HERE/'nonlocal-contact4-comparisons.json').read_text())
    assert_unchanged(ROOT,local['source_sha256']);assert_unchanged(ROOT,nonlocal_['source_sha256'])
    r2_path=ROOT/'mechanical/freeze-refresh.json';r2=json.loads(r2_path.read_text())
    for f in r2['files']:
        path=ROOT/f['path'];assert sha256(path)==f['sha256'];assert path.stat().st_size==f['bytes']
    v2=ROOT.parent/'fieldnote-integrated-v0.2';v2_path=v2/'mechanical/coverage-correction.json'
    assert sha256(v2_path)=='35e73567dec7004aaf179e78d1458062262d9b64ee874102a52217bcf187ff48'
    for f in json.loads(v2_path.read_text())['files']:
        path=v2/f['path'];assert sha256(path)==f['sha256'];assert path.stat().st_size==f['bytes']
    data=json.loads((ROOT/'design-data.json').read_text());u1=next(p for p in data['parts'] if p['ref']=='U1')['xy']
    r2_contacts=json.loads((ROOT/'mechanical/retention-parameters.json').read_text())['contact_centers_board_mm']
    alternative_contacts=[*r2_contacts[:3],[45.3,41.5]]
    old_hull=hull(r2_contacts);new_hull=hull(alternative_contacts)
    assert contains(old_hull,u1) and not contains(new_hull,u1)
    baseline=next(r for r in local['selected_position_candidates'] if r['center_board_mm']==[64.,41.5])
    accepted=[r for r in local['candidates'] if r['status'].startswith('PASS_')]
    files=[member(p) for p in sorted(HERE.glob('*')) if p.is_file() and p.name!='review-handoff.json']
    result=dict(status='LOCAL_R3_TARGET_CONSTRAINED_NO_CANDIDATE_ADOPTED',variant='PN7160_v03_R3_EXPLORATION',
        owner_freeze=freeze,source_board_sha256=inputs['fieldnote.kicad_pcb'],source_design_data_sha256=inputs['design-data.json'],
        R2_manifest=member(r2_path),R2_members_verified_unchanged=len(r2['files']),
        v02_manifest_sha256=sha256(v2_path),v02_members_verified_unchanged=21,
        target_component_to_bulge_gap_mm=.25,local_positions_examined=local['candidate_count'],
        local_preliminary_pass_count=len(accepted),best_local_gap_mm=max(r['assumed_component_to_bulge_gap_mm'] for r in accepted),
        R2_contact4_source_wall_gap_mm=baseline['pad_to_source_case_gap_mm'],
        absolute_PCB_contact_limited_gap_ceiling_mm=local['rear_local_bound']['maximum_component_to_bulge_X_gap_mm'],
        nonlocal_positions_examined=nonlocal_['candidate_count'],
        nonlocal_geometry_example=next(r for r in nonlocal_['selected_position_candidates'] if r['center_board_mm']==[45.3,41.5]),
        support_span_comparison=dict(U1_native_origin_board_mm=u1,R2_support_centers_board_mm=r2_contacts,
            R2_support_center_hull_board_mm=old_hull,U1_origin_inside_R2_support_hull=True,
            nonlocal_support_centers_board_mm=alternative_contacts,nonlocal_support_center_hull_board_mm=new_hull,
            U1_origin_inside_nonlocal_support_hull=False,
            force_deflection_or_retention_equivalence_computed=False),
        coordinator_disposition='Root reviewed the local constraints and instructed preservation of R2, documentation of the infeasible local target, and geometry-only labeling of the large inward relocation. Neither candidate is adopted.',
        new_printable_STLs_exported=False,new_full_243_27_27_screen_run=False,
        physical_retention_force_or_pad_behavior_qualified=False,manufacturing_release=False,
        files=files,physical_disposition='Engineering REVIEW/HOLD; comparison evidence only.')
    assert_unchanged(ROOT,inputs)
    out=HERE/'review-handoff.json';out.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(dict(path=str(out.relative_to(ROOT)),sha256=sha256(out),bytes=out.stat().st_size,
        status=result['status'],local_positions=result['local_positions_examined'],
        best_local_gap_mm=result['best_local_gap_mm'],nonlocal_example_gap_mm=result['nonlocal_geometry_example']['assumed_component_to_bulge_gap_mm'],
        verified_R2_members=len(r2['files']),verified_v02_members=21),indent=2))


if __name__=='__main__':main()
