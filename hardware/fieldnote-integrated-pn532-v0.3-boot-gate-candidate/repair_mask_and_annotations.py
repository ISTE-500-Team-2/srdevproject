#!/usr/bin/env python3
"""Repair local mask/annotation nodes without the broken SWIG optional setter."""
from pathlib import Path
import hashlib,json,uuid
import wx,pcbnew as k,build_design as g
ROOT=Path(__file__).resolve().parent

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def tracks(tree):return {g.unq(g.child(t,'uuid')[1]):g.sx(t)for t in tree if isinstance(t,list)and t and t[0]in('segment','via')}
def main():
 lib=ROOT/'Fieldnote.pretty/TI_DBV0006A.kicad_mod';ls=lib.read_text()
 if '(solder_mask_margin 0.05)'not in ls:
  assert ls.count('(roundrect_rratio 0.0833333333)')==6
  lib.write_text(ls.replace('(roundrect_rratio 0.0833333333)','(roundrect_rratio 0.0833333333) (solder_mask_margin 0.05)'))
 assert lib.read_text().count('(solder_mask_margin 0.05)')==6
 before=sha(ROOT/'fieldnote.kicad_pcb');tree=g.readsex((ROOT/'fieldnote.kicad_pcb').read_text());old=tracks(tree)
 fs={g.unq(next(p for p in g.children(f,'property')if g.unq(p[1])=='Reference')[2]):f for f in g.children(tree,'footprint')}
 pads=[]
 for pad in g.children(fs['U8'],'pad'):
  assert g.unq(pad[1])in('1','2','3','4','5','6') and g.child(pad,'solder_mask_margin')is None
  pad.append(['solder_mask_margin','0.05']);pads.append({'pin':g.unq(pad[1]),'solder_mask_margin_mm':.05,'copper_size_mm':list(map(float,g.child(pad,'size')[1:]))})
 assert len(pads)==6
 changes=[]
 for ref in ('U8','C38','R29','R30','C9','C33','SW1'):
  prop=next(p for p in g.children(fs[ref],'property')if g.unq(p[1])=='Reference');prior=g.sx(prop)
  if ref in ('U8','C38','R29','R30'):g.child(prop,'at')[1:]=['0','0','0']
  g.child(prop,'layer')[1]=g.q('F.Fab');font=g.child(g.child(prop,'effects'),'font');g.child(font,'size')[1:]=['0.8','0.8'];g.child(font,'thickness')[1]='0.1'
  effects=g.child(prop,'effects');effects[:]=[n for n in effects if n!='hide'];prop[:]=[n for n in prop if not(isinstance(n,list)and n and n[0]=='hide')]
  changes.append({'ref':ref,'before':prior,'after':g.sx(prop)})
 jp=next(p for p in g.children(fs['JP1'],'property')if g.unq(p[1])=='Reference');g.child(g.child(g.child(jp,'effects'),'font'),'size')[1:]=['0.8','0.8']
 removed=[g.unq(g.child(t,'uuid')[1])for t in g.children(tree,'gr_text')if g.unq(t[1])=='USB   SVC']
 tree[:]=[t for t in tree if not(isinstance(t,list)and t and t[0]=='gr_text'and g.unq(t[1])=='USB   SVC')]
 for label,p in [('USB',[24.25,8.65]),('SVC',[26.25,8.65])]:
  tree.append(g.readsex('(gr_text '+g.q(label)+' (at '+str(p[0]+60)+' '+str(p[1]+50)+' 0) (layer "F.SilkS") (uuid "'+str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-pn532-boot-gate-v03:legend:'+label))+'") (effects (font (size 0.8 0.8) (thickness 0.1))))'))
 assert tracks(tree)==old
 pre=ROOT/'output/mask-annotation-before-native-save.kicad_pcb';pre.write_text(g.sx(tree)+'\n')
 app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(pre));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')))
 b.BuildConnectivity();filler=k.ZONE_FILLER(b);filler.Fill(b.Zones());k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v02/fieldnote.kicad_pro').read_bytes())
 assert tracks(g.readsex((ROOT/'fieldnote.kicad_pcb').read_text()))==old
 report={'source_board_sha256':before,'candidate_board_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'TI_library_sha256':sha(lib),'U8_pad_mask_relief':pads,'mask_web_nominal_mm':.95-.6-2*.05,'source_basis':'Root-approved TI Rev N page 36 NSMD relief; 0.05 mm selected within 0.07 mm maximum.','annotation_changes':changes,'removed_selector_legend_uuid':removed,'routing_changed':False,'native_binding_note':'PAD.SetLocalSolderMaskMargin optional setter invalidated SWIG container iteration in three unsaved attempts. Final repair uses parsed native/library nodes, a fresh native load/save and exact retained copper comparison.','limitations':'Actual solder-mask registration and manufacturer stencil/placement acceptance remain unverified.'}
 (ROOT/'output/mask-and-annotation-repair.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
if __name__=='__main__':main()
