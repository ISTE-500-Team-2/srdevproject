from pathlib import Path
import json,hashlib,importlib.util,re
ROOT=Path(__file__).resolve().parent;OUT=ROOT/'output';OLD=OUT/'native-review-candidate-v4'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(ROOT/'fieldnote.kicad_pcb')=='95543eecbfa9c0feb23ca7445aae5526d0a1fbaba78326112d9eebe811cc3d55'
archive=OUT/'fieldnote-pn7160-v0.4-native-review-HOLD.zip';old_identity={'v4_snapshot_files':[{'path':str(p.relative_to(OLD)),'sha256':sha(p),'bytes':p.stat().st_size}for p in sorted(OLD.rglob('*'))if p.is_file()],'v4_zip_sha256':sha(archive)}
spec=importlib.util.spec_from_file_location('audit',ROOT/'manufacturing/audit_native_pins.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
board_path=ROOT/'fieldnote.kicad_pcb';before=board_path.read_text();start=before.index('(footprint "Fieldnote:TI_DBV0006A"');depth=0
for m in a.TOKEN.finditer(before,start):
 token=m.group()
 if token=='(':depth+=1
 elif token==')':
  depth-=1
  if depth==0:end=m.end();break
region=before[start:end];assert region.count('(pad ')==6 and '(solder_mask_margin'not in region
pattern=r'(\(roundrect_rratio [^)]+\))'
updated,n=re.subn(pattern,lambda m:m.group(0)+'\n\t\t\t(solder_mask_margin 0.05)',region);assert n==6
board_path.write_text(before[:start]+updated+before[end:])
lib=ROOT/'Fieldnote.pretty/TI_DBV0006A.kicad_mod';text=lib.read_text();assert text.count('(pad ')==6 and '(solder_mask_margin'not in text
text,n=re.subn(pattern,lambda m:m.group(0)+' (solder_mask_margin 0.05)',text);assert n==6;lib.write_text(text)
helper=ROOT/'prepare_boot_gate.py';text=helper.read_text();needle='(roundrect_rratio 0.0833333333))';assert text.count(needle)==1;helper.write_text(text.replace(needle,'(roundrect_rratio 0.0833333333) (solder_mask_margin 0.05))'))
oldtree=a.sexpr(before);newtree=a.sexpr(board_path.read_text());delta=[]
for oldfp,newfp in zip(a.children(oldtree,'footprint'),a.children(newtree,'footprint')):
 ref=next(x[2]for x in a.children(oldfp,'property')if x[1]=='Reference')
 if ref!='U8':assert oldfp==newfp;continue
 for oldpad,newpad in zip(a.children(oldfp,'pad'),a.children(newfp,'pad')):
  assert a.child(newpad,'solder_mask_margin')==['solder_mask_margin','0.05']
  assert oldpad==[x for x in newpad if not(isinstance(x,list)and x and x[0]=='solder_mask_margin')]
  delta.append({'ref':'U8','pad':newpad[1],'before_margin_mm':0,'after_margin_mm':.05})
 assert oldfp==[([x for x in item if not(isinstance(x,list)and x and x[0]=='solder_mask_margin')]if isinstance(item,list)and item and item[0]=='pad'else item)for item in newfp]
assert oldtree==[([([x for x in item if not(isinstance(x,list)and x and x[0]=='solder_mask_margin')]if isinstance(item,list)and item and item[0]=='pad'else item)for item in fp]if isinstance(fp,list)and fp and fp[0]=='footprint'and fp[1]=='Fieldnote:TI_DBV0006A'else fp)for fp in newtree]
assert all(sha(OLD/row['path'])==row['sha256']for row in old_identity['v4_snapshot_files'])and sha(archive)==old_identity['v4_zip_sha256']
seed=json.loads((ROOT/'source-v03/seed-identity.json').read_text());assert all(sha(Path(row['path']))==row['sha256']for row in seed['files'])
report={'status':'PASS_EXACT_SIX_PAD_MASK_ONLY_DELTA','prior_board_sha256':hashlib.sha256(before.encode()).hexdigest(),'candidate_board_sha256':sha(board_path),'unchanged_metadata_sha256':sha(ROOT/'design-data.json'),'unchanged_project_sha256':sha(ROOT/'fieldnote.kicad_pro'),'prior_native_freeze_manifest_sha256':sha(OLD/'native-freeze-manifest.json'),'prior_v4_preserved':old_identity,'pad_delta':delta,'proof':'Native S-expression trees equal after deleting only six added U8 solder_mask_margin0.05 nodes; all other footprint properties, copper/paste/courtyard/pose/nets/planes/fill geometry and board objects identical. Explicit pad overrides matched in local TI_DBV0006A library. Helper changed only generated pad margin clause.','source_seed_files_reverified_unchanged':43,'manufacturer_basis':'TI SN74LVC1G97 RevN DBV0006A p36 NSMD example, up to0.07mm mask relief; adopted nominal0.05mm relief. Manufacturer mask registration/process acceptance remains HOLD.'}
(OUT/'mask-only-repair-v4a.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:report[k]for k in ('status','prior_board_sha256','candidate_board_sha256','unchanged_metadata_sha256','unchanged_project_sha256')},indent=2))
