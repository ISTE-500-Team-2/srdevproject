#!/usr/bin/env python3
"""Read-only PN532 source audit and immutable candidate seed copy.

Never generates/rebuilds a board and never modifies the PN532 source revision.
"""
from pathlib import Path
import hashlib, importlib.util, json, shutil

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / 'fieldnote-integrated-v0.2'
GATE_SOURCE = ROOT.parent / 'fieldnote-integrated-pn7160-v0.4-boot-gate-candidate'
EXPECTED = {
    'fieldnote.kicad_pcb': 'c6c7ff173b25e8f182a084e327d3c602c3bc24246ff914d45e3b7228775e2456',
    'fieldnote.kicad_pro': 'a5be58441bff60f20244b140b604ca189f131d1fb4d5e5eba167f44519fc3c11',
    'design-data.json': 'ac013ae9e9c12a99ecdc8f7ff99909f215e4ed712e52035d55024d073d69b274',
}

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    for name, digest in EXPECTED.items():
        assert sha(SOURCE / name) == digest, ('SOURCE_IDENTITY_CHANGED', name)
    spec = importlib.util.spec_from_file_location('frozen_source_generator', SOURCE/'build_design.py')
    g = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(g)  # Helpers only; main() is never called.
    tree = g.readsex((SOURCE/'fieldnote.kicad_pcb').read_text())
    gate_tree = g.readsex((GATE_SOURCE/'source-v03/fieldnote.kicad_pcb').read_text())
    data = json.loads((SOURCE/'design-data.json').read_text())
    gate_data = json.loads((GATE_SOURCE/'source-v03/design-data.json').read_text())
    parts = {p['ref']:p for p in data['parts']}
    gate_parts = {p['ref']:p for p in gate_data['parts']}
    def tracks(t):
        return {g.unq(g.child(n,'uuid')[1]):n for n in t
                if isinstance(n,list) and n and n[0] in ('segment','via')}
    original = tracks(tree)
    gate_original = tracks(gate_tree)
    same = [ui for ui,n in original.items() if gate_original.get(ui) == n]
    reset_removed = {'12206052-95c1-418e-a62f-c7eefa2fc60a','1c37adc3-a9f6-4d12-93c3-59dd3fa77caa',
       '8d5ce634-87a2-4bb2-984f-1b412d5c2418','9eac0a9e-7d77-4ac2-a1fc-a54add150171',
       'ef89ced7-1974-40f6-af08-51ed43a2e208','b78ca86b-3602-4207-92c8-ee341aeade58',
       '4eefddda-76bf-4276-abda-672f4a5adfcb'}
    pullup_removed = {'14e944ce-7899-4dfa-9341-ff3cb253ced9','1b01b75d-7bdb-4f04-9610-761255777256',
       '86c300e7-cbbd-44b7-954c-b4fdb5c90ed2','84561600-1622-498c-8aff-e05a067e629c'}
    isolation = reset_removed | pullup_removed
    assert all(ui in original and original[ui] == gate_original[ui] for ui in isolation)
    files = sorted([*SOURCE.glob('*.kicad_sch'), SOURCE/'fieldnote.kicad_pcb', SOURCE/'fieldnote.kicad_pro',
        SOURCE/'design-data.json', SOURCE/'build_design.py', SOURCE/'sync_native_libraries.py',
        SOURCE/'sym-lib-table', SOURCE/'fp-lib-table', SOURCE/'Fieldnote.kicad_sym',
        *sorted((SOURCE/'Fieldnote.pretty').glob('*.kicad_mod')),
        *(SOURCE/'mechanical'/name for name in ('native-geometry.json','retention-checks.json',
          'retention-parameters.json','height-envelope-sources.json'))])
    identities = {str(p.relative_to(SOURCE)):sha(p) for p in files}
    seed = ROOT/'source-v02'
    for p in files:
        target = seed/p.relative_to(SOURCE)
        target.parent.mkdir(parents=True,exist_ok=True)
        if target.exists():
            assert target.read_bytes() == p.read_bytes(), ('SEED_OVERWRITE_FORBIDDEN', target)
        else:
            shutil.copyfile(p,target)
    fp = g.children(tree,'footprint')
    numbered = [pad for f in fp for pad in g.children(f,'pad') if g.unq(pad[1])]
    count = {'footprints':len(fp),'segments':len(g.children(tree,'segment')),'vias':len(g.children(tree,'via')),
      'numbered_pad_instances':len(numbered),'unique_ref_pin_pairs':sum(len(set(g.unq(p[1]) for p in g.children(f,'pad') if g.unq(p[1])))for f in fp),
      'metadata_fitted_parts':sum(not p['dnp'] and bool(p['mpn']) and p['mpn']!='PCB copper' for p in data['parts']),
      'rule_areas':sum(g.child(z,'keepout') is not None for z in g.children(tree,'zone'))}
    protected = {}
    for group in ('USB','Power','MCU','Indicators','NFC','RF','Test'):
        refs = sorted(p['ref'] for p in data['parts'] if p['group']==group)
        protected[group] = refs
    important = ('U1','U3','U4','U6','U7','R2','R12','C9','SW1','J4')
    common_parts = {ref:{'PN532':parts[ref],'PN7160_seed':gate_parts[ref],
      'exact_metadata_match':parts[ref]==gate_parts[ref]}for ref in important}
    board_outline = [g.sx(n) for n in tree if isinstance(n,list) and n and n[0].startswith('gr_')
                     and g.child(n,'layer') and g.unq(g.child(n,'layer')[1])=='Edge.Cuts']
    rule_areas = [g.sx(z) for z in g.children(tree,'zone') if g.child(z,'keepout')]
    report = {'status':'SOURCE_INVENTORY_COMPLETE_WAITING_FOR_PN7160_GATE_FREEZE',
      'source_revision':'PN532 v0.2','source_files_sha256':identities,'native_counts':count,
      'outline_metadata':data['outline'],'outline_native_sha256':hashlib.sha256('\n'.join(board_outline).encode()).hexdigest(),
      'rule_area_definitions_sha256':hashlib.sha256('\n'.join(rule_areas).encode()).hexdigest(),
      'original_copper_count':len(original),'exact_shared_copper_with_pn7160_seed':len(same),
      'expected_isolation':{ui:{'reason':'RESET_OUTPUT_ISOLATION' if ui in reset_removed else 'R12_HIGH_SIDE_ISOLATION',
         'original_sexpr':g.sx(original[ui]),'identical_to_pn7160_seed':True}for ui in sorted(isolation)},
      'retained_copper_count_after_explicit_isolation':len(original)-len(isolation),
      'protected_reference_groups':protected,'shared_control_metadata':common_parts,
      'adaptation_requirements':[
       'Use original PN532 board bytes; never replace the NFC chip or RF/coil/clock geometry with PN7160 geometry.',
       'Rename old reset network ESP_RESET_RC, preserve U1.8 as ESP_EN, remove exactly the eleven bound isolation items.',
       'R12.2 becomes POWER_PERMIT; reconnect original interrupted 3V3 transit endpoints.',
       'Add U8, C38, R29, R30 and PCB-only JP1 after final PN7160 circuit/library freeze.',
       'Re-evaluate placement and route against PN532 copper, keeping all other old pad/copper/outline/keepout geometry.',
       'Fresh PN532 native DRC/ERC/parity, BOM/CPL exclusions and exact-delta preservation evidence are required.',
       'No inherited PN7160 RF, firmware, complete-power transient, case or physical qualification claim.'
      ],'source_mutated':False,'native_candidate_created':False}
    out=ROOT/'output';out.mkdir(exist_ok=True)
    (out/'source-inventory.json').write_text(json.dumps(report,indent=2)+'\n')
    (seed/'seed-identity.json').write_text(json.dumps({'source':str(SOURCE),'files':identities},indent=2)+'\n')
    for p in files:assert sha(p)==identities[str(p.relative_to(SOURCE))]
    print(json.dumps({'status':report['status'],'counts':count,'shared_copper':len(same),
          'isolation_count':len(isolation),'retained_after_isolation':len(original)-len(isolation),
          'inventory_sha256':sha(out/'source-inventory.json')}))

if __name__=='__main__':main()
