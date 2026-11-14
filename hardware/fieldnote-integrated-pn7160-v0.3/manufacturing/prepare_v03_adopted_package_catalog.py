"""Merge explicitly adopted tuning selection into a new catalog; preserve preparation."""
from pathlib import Path
import copy
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT/'manufacturing'
FROZEN = ROOT/'output/native-review-candidate-v2'
BOARD_SHA = '7b3c0b8d9d14abde51ec01ae3f21b2ca2af0204b79f25e4eb8b13243ad3029f6'
DESIGN_SHA = 'e5db89f4158c074e48b2796a4e05f75d80875480a6e508622d0e021d18e1c3fa'
PROJECT_SHA = '0c661919c7ec3bc5d5bf6cf8bb5c67dd0e6b8f98cf57bcf0d8109d84890c8e6d'


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    expected = {'fieldnote.kicad_pcb': BOARD_SHA, 'design-data.json': DESIGN_SHA,
                'fieldnote.kicad_pro': PROJECT_SHA}
    assert all(sha(FROZEN/n)==h for n,h in expected.items())
    prep = BASE/'v03-clearance-preparation-manifest.json'
    p = json.loads(prep.read_text())
    assert sha(prep)=='c07a7fdc00fca2502540b73319d1c452b43ac5d1031da509caad867db60c1b9a'
    for f in p['files']:
        assert sha(ROOT/f['path'])==f['sha256'], f['path']
    cp = BASE/'v03-package-catalog.json'
    assert sha(cp)=='a3de65d0e915546e3fbdb97843e76d0d0fc9428b22176aa89ec4627a0b87e689'
    cat = copy.deepcopy(json.loads(cp.read_text()))
    candidate_path = BASE/'v03-rf-capacitor-candidate-package.json'
    assert sha(candidate_path)=='4c496e59b779f6a5b8b148592016b54ccab1c4981950445f22e8e0bdc8460a8d'
    candidate = json.loads(candidate_path.read_text())
    sp = copy.deepcopy(candidate['specifications_by_mpn']['CC0603GRNPO9BN301'])
    sel_path = BASE/'pn7160-component-selection-review-final.json'
    assert sha(sel_path)=='912fc1f9b4e447425fbab26f4c6ee23d2bce601507bbbb3b5586b3c0bd483db6'
    selection = json.loads(sel_path.read_text())
    assert selection['board']['sha256']==BOARD_SHA
    assert selection['variant_metadata']['sha256']==DESIGN_SHA
    fitted = selection['fitted_purchased_parts']
    actual = [x for x in json.loads((FROZEN/'design-data.json').read_text())['parts']
              if not x['dnp'] and x['mpn'] and x['ref']!='ANT1' and not x['ref'].startswith('TP')]
    assert len(fitted)==len(actual)==78
    assert {x['ref']: (x['mpn'],x['footprint'].split(':')[-1],x['value']) for x in fitted} == \
           {x['ref']: (x['mpn'],x['fp'],x['value']) for x in actual}
    old = {x['ref']:x for x in cat['fitted_selection']}
    changes = [dict(ref=x['ref'],before_mpn=old[x['ref']]['mpn'],adopted_mpn=x['mpn'])
               for x in fitted if old[x['ref']]['mpn'] != x['mpn']]
    assert changes == [dict(ref=x,before_mpn='CC0603GRNPO9BN331',adopted_mpn='CC0603GRNPO9BN301') for x in ('C28','C29')]
    cat['specifications_by_mpn']['CC0603GRNPO9BN301'] = sp
    cat['source_documents'].append(sp['source'])
    cat.update(status='ADOPTED_SOURCE_PACKAGE_CATALOG_AWAITING_FINAL_NATIVE_CLEARANCE_RUN',
               scope='Source-qualified exact adopted packages; geometry output requires frozen native extraction.',
               generator_sha256=sha(Path(__file__)),
               selection_review_path=str(sel_path.relative_to(ROOT)),
               selection_review_sha256=sha(sel_path),selection_metadata_sha256=DESIGN_SHA,
               source_board_sha256=BOARD_SHA,source_design_data_sha256=DESIGN_SHA,
               source_project_sha256=PROJECT_SHA,
               source_board_path=str((FROZEN/'fieldnote.kicad_pcb').relative_to(ROOT)),
               source_design_data_path=str((FROZEN/'design-data.json').relative_to(ROOT)),
               source_project_path=str((FROZEN/'fieldnote.kicad_pro').relative_to(ROOT)),
               preserved_preparation_catalog_sha256=sha(cp),preserved_preparation_manifest_sha256=sha(prep),
               qualified_candidate_entry_sha256=sha(candidate_path),adopted_exact_mpn_changes=changes,
               fitted_selection=fitted,distinct_mpn_count=len({x['mpn'] for x in fitted}))
    assert cat['distinct_mpn_count']==42
    assert set(cat['specifications_by_mpn'])=={x['mpn'] for x in fitted}
    assert len(cat['source_documents'])==30
    for src in cat['source_documents']:
        assert sha(ROOT/src['path'])==src['sha256']
        if src.get('product_page_path'):
            assert sha(ROOT/src['product_page_path'])==src['product_page_sha256']
    assert all(sha(FROZEN/n)==h for n,h in expected.items())
    out = BASE/'v03-package-catalog-adopted.json'
    out.write_text(json.dumps(cat,indent=2)+'\n')
    print(json.dumps(dict(path=str(out),sha256=sha(out),fitted=78,mpns=42,sources=30),indent=2))


if __name__ == '__main__':
    main()
