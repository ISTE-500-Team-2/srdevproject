"""Prepare manufacturer package specifications only; no placement PASS or CAD edits."""
from pathlib import Path
import copy
import hashlib
import json
import shutil

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT.parent/'fieldnote-integrated-v0.2'
OUT=ROOT/'manufacturing/v03-clearance-sources'


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    OUT.mkdir(exist_ok=True)
    baseline=BASE/'manufacturing/placement-clearance-dimensions.json'
    supplement=BASE/'manufacturing/placement-clearance-supplement-dimensions.json'
    assert sha(baseline)=='0a1b0785ef55ff32489abd06538481e0e50e81fdaf375d5b10ed25f58b56be5f'
    assert sha(supplement)=='bcac2bd8f01e1a776eacace76d73797a1feae3292b044dd24e0cfcba62b5c175'
    b=json.loads(baseline.read_text());s=json.loads(supplement.read_text())
    original={p['ref']:p for p in b['parts']};original.update({p['ref']:p for p in s['parts']})
    by_mpn={p['mpn']:p for p in original.values()}
    selection_path=ROOT/'manufacturing/pn7160-component-selection-review.json'
    selection=json.loads(selection_path.read_text())
    fitted=selection['fitted_purchased_parts']
    assert len(fitted)==len({p['ref'] for p in fitted})==78
    sources={}

    def archive_source(src,root):
        src=copy.deepcopy(src)
        old=root/src['path'];new=OUT/old.name
        assert sha(old)==src['sha256'],str(old)
        if new.exists():assert sha(new)==sha(old),str(new)
        else:shutil.copyfile(old,new)
        src['reused_source_path']=str(old)
        src['path']=str(new.relative_to(ROOT))
        if src.get('product_page_path'):
            pp=root/src['product_page_path'];target=OUT/pp.name
            assert sha(pp)==src['product_page_sha256']
            if not target.exists():shutil.copyfile(pp,target)
            assert sha(target)==sha(pp)
            src['product_page_path']=str(target.relative_to(ROOT))
        sources[src['path']]=src
        return src

    def new_source(path,url,page,basis,mpn_page=None):
        p=ROOT/path;target=OUT/p.name
        if not target.exists():shutil.copyfile(p,target)
        assert sha(target)==sha(p)
        src=dict(path=str(target.relative_to(ROOT)),sha256=sha(target),url=url,page_1_based=page,basis=basis,
                 artifact_kind='manufacturer_pdf',raw_manufacturer_pdf_archived=True)
        if mpn_page:src['exact_mpn_page_1_based']=mpn_page
        sources[src['path']]=src
        return src

    fields=['local_xy_max_mm','local_center_mm','package_max_height_mm','assembly_seating_allowance_mm',
            'modeled_assembled_height_mm','body_xy_max_mm','envelope_includes_leads',
            'body_local_center_mm','body_local_bounds_mm','full_package_local_bounds_mm',
            'manufacturer_body_width_max_mm','retained_width_registration_reserve_mm',
            'exposed_contact_tail_local_y_bounds_mm','body_nominal_local_center_mm','tolerance_chain']
    package_specs={}
    for mpn in sorted({p['mpn'] for p in fitted}):
        if mpn in by_mpn:
            row=by_mpn[mpn]
        elif mpn.startswith('RC0603'):
            row=next(p for p in original.values() if p['specification_key']=='RC0603')
        elif mpn.startswith('CRCW0805') and mpn.endswith('FKEAHP'):
            row=next(p for p in original.values() if p['specification_key']=='CRCW0805HP')
        else:continue
        data={k:copy.deepcopy(row[k]) for k in fields if k in row}
        data['source']=archive_source(row['source'],BASE)
        data['reused_accepted_v02_dimensions']=True
        data['axes_basis']='Native footprint localX/localY; same package/axis registration as reviewed v02.'
        package_specs[mpn]=data

    def add(mpn,size,height,src,basis):
        package_specs[mpn]=dict(local_xy_max_mm=size,local_center_mm=[0,0],body_xy_max_mm=size,
            package_max_height_mm=height,assembly_seating_allowance_mm=.10,
            modeled_assembled_height_mm=height+.10,envelope_includes_leads=True,source=src,
            reused_accepted_v02_dimensions=False,axes_basis=basis)

    add('PN7160A1HN/C100E',[6.25,6.25],1.00,new_source('simulation/references/PN7160_PN7161.pdf',
        'https://www.nxp.com/docs/en/data-sheet/PN7160_PN7161.pdf',57,
        'Rev4.2 22Jul2026 Fig37 SOT618-1: D/Emax6.10 plus0.075 protrusion per side;Amax1.00. SOT618-16 was an incorrect package spelling.'),
        'SOT618-1 square package centered on native U2 footprint; terminal protrusions included.')
    add('NX2016SA-27.12MHZ-EXS00A-CS06346',[2.10,1.70],.50,new_source('simulation/references/NDK-CS06346.pdf',
        'https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/6749/CS06346-27.12M.pdf',4,
        'Manufacturer-authored EXS11B-10535: p2 exactCS06346,27.12MHz,CL10; p4 body2.0+/-0.1 x1.6+/-0.1 x0.45+/-0.05mm; hosted distributor copy.',2),
        'LocalX length2.0,localY width1.6; terminals contained by ceramic body rectangle;native lands0.85x0.75 atx+/-0.675,y+/-0.525.')
    add('LQW18CAR16J00D',[1.75,.95],.95,new_source('simulation/references/Murata-JELF243A-0159.pdf',
        'https://search.murata.co.jp/Ceramy/image/img/P02/JELF243A-0159.pdf',2,
        'JELF243A_0159D-01 exactpartlistedp1; p2 L1.6+/-0.15,W/T0.8+/-0.15mm including external termination.',1),
        'LocalX bodylength,localY width; external winding and terminations included in maximum outline.')
    add('CL10B225KP8NNNC',[1.70,.90],.90,new_source('references/power-review/CL10B225KP8NNN-specsheet.pdf',
        'https://product.samsungsem.com/mlcc/CL10B225KP8NNN.do',1,
        'Samsung exactP/NCL10B225KP8NNNC issued09Apr2024: L1.60+/-0.10,W/T0.80+/-0.10mm.'),
        'LocalX capacitorlength,localY width; no external leads beyond terminations.')
    for mpn in ['CBR06C130F5GAC','CC0603GRNPO9BN131','CC0603GRNPO9BN331','CC0603JRX7R9BB102']:
        h=.87 if mpn.startswith('CBR') else .90
        add(mpn,[1.70,.90],h,new_source('manufacturing/v03-clearance-sources/'+mpn+'.pdf',
            'https://www.yageogroup.com/download/specsheet/'+mpn,1,
            'Exact generated manufacturerspec: L1.6+/-0.1,W0.8+/-0.1;T0.8+/-'+('0.07' if mpn.startswith('CBR') else '0.1')+'mm.'),
            'LocalX capacitorlength,localY width; maximum includes terminations.')
    assert set(package_specs)=={p['mpn'] for p in fitted},set(p['mpn'] for p in fitted)-set(package_specs)
    assert len(package_specs)==41
    output=dict(schema_version=1,status='SOURCE_PACKAGE_CATALOG_READY_AWAITING_ADOPTED_FINAL_ROUTING_FREEZE',
                scope='Package sources/specifications only; no final placement or case geometry PASS.',
                generator_sha256=sha(Path(__file__)),selection_review_path=str(selection_path.relative_to(ROOT)),
                selection_review_sha256=sha(selection_path),
                selection_metadata_sha256=selection['variant_metadata']['sha256'],
                accepted_v02_dimensions_sha256=sha(baseline),accepted_v02_supplement_sha256=sha(supplement),
                fitted_count=78,expected_pair_count=3003,distinct_mpn_count=41,
                fitted_selection=[dict(ref=p['ref'],mpn=p['mpn'],footprint=p['footprint']) for p in fitted],
                specifications_by_mpn=package_specs,source_documents=list(sources.values()),
                assumed_placement_budget=dict(xy_each_axis_mm=.10,rotation_deg=1,validated_by_assembler=False),
                rotation_radius_method='Maximum norm of four complete local envelope corners about native footprint origin.',
                preserved_conditions=['Exact HRO basevariant/revision and supplier registration, positivecopperoverlap vs completeleadcontainment, solder/fillet/nozzle/rework acceptance.',
                                     'J1 full-contact asymmetric bounds9.14x8.30 center[0,-.32] and maximumcorneroriginradius apply.',
                                     'Assembly seating reserves are engineering allowances; no measured assembler standoff/capability claim.',
                                     'Final PN7160 EPvia/paste/tenting screen must report open-hole/process risk without assuming costly filled/capped vias.'])
    path=ROOT/'manufacturing/v03-package-catalog.json'
    path.write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps(dict(status=output['status'],fitted_count=78,distinct_mpn_count=41,source_documents=len(sources),
                         catalog_sha256=sha(path)),indent=2))


if __name__=='__main__':main()
