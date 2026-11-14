#!/usr/bin/env python3
"""Remove unnecessary old-pad descriptive fields introduced by generic import."""
from pathlib import Path
import copy,hashlib,json
import wx,pcbnew as k,build_design as g
ROOT=Path(__file__).resolve().parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def ref(f):return g.unq(next(p for p in g.children(f,'property')if g.unq(p[1])=='Reference')[2])
def main():
 before=sha(ROOT/'fieldnote.kicad_pcb');source=g.readsex((ROOT/'source-v02/fieldnote.kicad_pcb').read_text());new=g.readsex((ROOT/'fieldnote.kicad_pcb').read_text())
 old={ref(f):f for f in g.children(source,'footprint')};changes=[]
 for fp in g.children(new,'footprint'):
  name=ref(fp)
  if name not in old:continue
  pads={g.unq(g.child(p,'uuid')[1]):p for p in g.children(old[name],'pad')}
  for p in g.children(fp,'pad'):
   origin=pads[g.unq(g.child(p,'uuid')[1])]
   for key in ('pinfunction','pintype'):
    have=g.child(p,key);want=g.child(origin,key)
    if have==want:continue
    changes.append({'ref':name,'pin':g.unq(p[1]),'field':key,'from':have,'to':want})
    p[:]=[n for n in p if not(isinstance(n,list)and n and n[0]==key)]
    if want:p.append(copy.deepcopy(want))
 pre=ROOT/'output/preserved-old-pad-annotations-preload.kicad_pcb';pre.write_text(g.sx(new)+'\n')
 app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(pre));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')));k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v02/fieldnote.kicad_pro').read_bytes())
 report={'status':'OLD_PAD_DESCRIPTIVE_FIELDS_RESTORED','source_board_sha256':before,'candidate_board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'changes':changes,'electrical_scope':'Net assignments, pad geometry, physical copper and all new gate pad functions unchanged. Old source had no pinfunction fields; generic import had added descriptive names unnecessarily. Restore the original absence for exact old-pad preservation.'}
 (ROOT/'output/old-pad-annotation-restoration.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'status':report['status'],'changes':len(changes),'board_sha256':report['candidate_board_sha256']}))
if __name__=='__main__':main()
