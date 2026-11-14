"""Six-ref RF Value/MPN-only candidate and guarded reviewed integration.

Default copies the project and patches string tokens in PCB/schematic/library
plus those two metadata keys. It never regenerates or refills routed copper.
--apply-dir is reserved for root review after native DRC/ERC/parity pass.
"""
from pathlib import Path
import argparse, copy, hashlib, json, re, shutil

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output/routed-rf-values-candidate'
BASE_BOARD='1ea3e9e01202277e5603b3c989f391fa86cc71dfa319b053cda6c318f2e056a2'
CHANGES={
    'C24':(('220pF C0G 50V','CC0603JRNPO9BN221'),('220pF C0G 100V','CC0603JRNPO0BN221')),
    'C25':(('220pF C0G 50V','CC0603JRNPO9BN221'),('220pF C0G 100V','CC0603JRNPO0BN221')),
    'C26':(('68pF C0G 50V','CC0603JRNPO9BN680'),('75pF C0G 100V','CC0603JRNPO0BN750')),
    'C27':(('68pF C0G 50V','CC0603JRNPO9BN680'),('75pF C0G 100V','CC0603JRNPO0BN750')),
    'C34':(('47pF C0G 50V','CC0603JRNPO9BN470'),('36pF C0G 50V','CC0603JRNPO9BN360')),
    'C35':(('47pF C0G 50V','CC0603JRNPO9BN470'),('36pF C0G 50V','CC0603JRNPO9BN360')),
}
FILES=['fieldnote.kicad_pcb','nfc-rf.kicad_sch','Fieldnote.kicad_sym','design-data.json']
TOKEN=re.compile(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+')

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def parse(text):
    """Balanced token tree with source spans; atoms retain original spelling."""
    tokens=list(TOKEN.finditer(text));i=0
    def read():
        nonlocal i
        t=tokens[i];i+=1
        if t.group()=='(':
            children=[]
            while tokens[i].group()!=')':children.append(read())
            end=tokens[i].end();i+=1;return dict(children=children,start=t.start(),end=end)
        assert t.group()!=')';return dict(atom=t.group(),start=t.start(),end=t.end())
    tree=read();assert i==len(tokens);return tree

def plain(node):
    if 'atom' in node:return node['atom']
    return [plain(c) for c in node['children']]

def atom(node):
    s=node['atom'];return json.loads(s) if s.startswith('"') else s

def nodes(tree):
    if 'children' in tree:
        yield tree
        for c in tree['children']:yield from nodes(c)

def patch_sexpr(text):
    tree=parse(text);edits=[];counts={r:dict(Value=0,MPN=0) for r in CHANGES}
    for n in nodes(tree):
        cs=n['children']
        if not cs or 'atom' not in cs[0] or atom(cs[0]) not in ['footprint','symbol']:continue
        props={}
        for c in cs[1:]:
            cc=c.get('children',[])
            if len(cc)>=3 and cc[0].get('atom')=='property':props[atom(cc[1])]=cc[2]
        if 'Reference' not in props:continue
        ref=atom(props['Reference'])
        if ref not in CHANGES:continue
        old,new=CHANGES[ref]
        for key,idx in [('Value',0),('MPN',1)]:
            if key not in props:continue
            tok=props[key];assert atom(tok)==old[idx],(ref,key,atom(tok),old[idx])
            edits.append((tok['start'],tok['end'],json.dumps(new[idx])));counts[ref][key]+=1
            tok['atom']=json.dumps(new[idx])
    assert all(v['Value']>=1 for v in counts.values()),counts
    out=text
    for a,c,s in sorted(edits,reverse=True):out=out[:a]+s+out[c:]
    # The parsed result must equal the original tree with exactly these string
    # leaves changed. Everything else, including all geometry/UUIDs, is fixed.
    assert plain(parse(out))==plain(tree)
    return out,counts

def patch_metadata(text):
    old=json.loads(text);new=copy.deepcopy(old);parts={p['ref']:p for p in new['parts']}
    for ref,(before,after) in CHANGES.items():
        p=parts[ref];assert (p['value'],p['mpn'])==before,(ref,p['value'],p['mpn'])
        p['value'],p['mpn']=after
    restored=copy.deepcopy(new);rp={p['ref']:p for p in restored['parts']}
    for ref,(before,_) in CHANGES.items():rp[ref]['value'],rp[ref]['mpn']=before
    assert restored==old
    return json.dumps(new,indent=2)+'\n'

def validate_selected(text,name):
    if name=='design-data.json':
        parts={p['ref']:p for p in json.loads(text)['parts']}
        for ref,(_,after) in CHANGES.items():assert (parts[ref]['value'],parts[ref]['mpn'])==after
        return
    found={r:0 for r in CHANGES}
    for n in nodes(parse(text)):
        cs=n['children']
        if not cs or cs[0].get('atom') not in ['symbol','footprint']:continue
        props={atom(c['children'][1]):atom(c['children'][2]) for c in cs[1:] if c.get('children',[{}])[0].get('atom')=='property'}
        ref=props.get('Reference')
        if ref not in CHANGES:continue
        assert props['Value']==CHANGES[ref][1][0],(name,ref,props)
        if 'MPN' in props:assert props['MPN']==CHANGES[ref][1][1],(name,ref,props)
        found[ref]+=1
    assert all(found.values()),(name,found)

def integrate(target,manifest_path):
    m=json.loads(manifest_path.read_text());candidate=manifest_path.parent
    for name,row in m['files'].items():
        assert digest(target/name)==row['before_sha256'],('Live file changed',name)
        assert digest(candidate/name)==row['after_sha256'],('Candidate file changed',name)
    for name in ['drc.json','erc.json']:
        check=json.loads((candidate/name).read_text())
        groups=[check[g] for g in ['violations','unconnected_items','schematic_parity']] if name=='drc.json' else [s['violations'] for s in check['sheets']]
        assert not any(groups),(name,check)
        assert digest(candidate/name)==m['native_validation'][name]['sha256'],('Native report changed',name)
    # Rebuild each candidate from the guarded live inputs and prove it is the
    # same six-ref string/metadata change, rather than trusting its manifest.
    for name in FILES:
        text=(target/name).read_text()
        if name in m['apply_files']:expected=patch_metadata(text) if name=='design-data.json' else patch_sexpr(text)[0]
        else:validate_selected(text,name);expected=text
        assert expected==(candidate/name).read_text(),('Unexpected candidate edit',name)
    backup=target/'output'/('rf-values-base-'+m['files']['fieldnote.kicad_pcb']['before_sha256'][:12]);backup.mkdir(parents=True,exist_ok=True)
    for name in FILES:
        if (backup/name).exists():assert digest(backup/name)==m['files'][name]['before_sha256']
        else:shutil.copy2(target/name,backup/name)
    for name in m['apply_files']:shutil.copy2(candidate/name,target/name)
    result=dict(status='FIELDS_SYNCED_REQUIRES_FINAL_NATIVE_CHECKS',files={n:digest(target/n) for n in FILES},
        board_geometry_and_part_count_unchanged=True,changed_refs=sorted(CHANGES),manifest_sha256=digest(manifest_path))
    (target/'output/rf-values-integration.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

def main():
    p=argparse.ArgumentParser();p.add_argument('--source-dir',type=Path,default=ROOT);p.add_argument('--output',type=Path,default=OUT)
    p.add_argument('--apply-dir',type=Path);p.add_argument('--manifest',type=Path,default=OUT/'rf-value-patch.json')
    p.add_argument('--board-only',action='store_true',help='Other three guarded source files already contain the selected values')
    a=p.parse_args()
    if a.apply_dir:integrate(a.apply_dir.resolve(),a.manifest.resolve());return
    assert digest(a.source_dir/'fieldnote.kicad_pcb')==BASE_BOARD,'Source board differs from accepted geometry'
    a.output.mkdir(parents=True,exist_ok=True)
    for f in a.source_dir.iterdir():
        if f.is_file() and (f.suffix in ['.kicad_pro','.kicad_sch','.kicad_sym','.kicad_dru'] or f.name in ['design-data.json','fp-lib-table','sym-lib-table']):shutil.copy2(f,a.output/f.name)
    for name in ['Fieldnote.pretty','fieldnote.pretty']:
        if (a.source_dir/name).exists():shutil.copytree(a.source_dir/name,a.output/name,dirs_exist_ok=True)
    records={};counts={}
    for name in FILES:
        src=a.source_dir/name;before=src.read_text()
        if a.board_only and name!='fieldnote.kicad_pcb':validate_selected(before,name);after=before
        elif name=='design-data.json':after=patch_metadata(before)
        else:after,counts[name]=patch_sexpr(before)
        (a.output/name).write_text(after);records[name]=dict(before_sha256=digest(src),after_sha256=digest(a.output/name))
    manifest=dict(status='SIX_REF_FIELDS_ONLY_REQUIRES_NATIVE_DRC_ERC',files=records,
        apply_files=['fieldnote.kicad_pcb'] if a.board_only else FILES,
        changed_refs={r:dict(before=b,after=n) for r,(b,n) in CHANGES.items()},
        field_token_counts=counts,board_geometry_uuid_routing_placement_fill_unchanged=True,
        metadata_only_value_and_mpn_changed=True,part_count_unchanged=True)
    (a.output/'rf-value-patch.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))

if __name__=='__main__':main()
