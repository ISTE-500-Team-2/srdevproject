from pathlib import Path
import json,hashlib,uuid
import wx,pcbnew as k,route_pn7160 as r
ROOT=Path(__file__).resolve().parent
app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')))
fs={f.GetReference():f for f in b.GetFootprints()};changes=[]
for ref in ('U8','C38','R29','R30','C9','C33','SW1'):
 t=fs[ref].Reference();before={'position':r.xy(t.GetPosition()),'layer':b.GetLayerName(t.GetLayer()),'size':k.ToMM(t.GetTextSize().x)}
 if ref in ('U8','C38','R29','R30'):t.SetPosition(fs[ref].GetPosition())
 t.SetLayer(k.F_Fab);t.SetTextSize(k.VECTOR2I(k.FromMM(.8),k.FromMM(.8)));t.SetTextThickness(k.FromMM(.1));t.SetVisible(True)
 changes.append({'ref':ref,'before':before,'after':{'position':r.xy(t.GetPosition()),'layer':'F.Fab','size':.8}})
t=fs['JP1'].Reference();t.SetTextSize(k.VECTOR2I(k.FromMM(.8),k.FromMM(.8)));t.SetTextThickness(k.FromMM(.1))
removed=[]
items=list(b.GetDrawings())
for t in items:
 if isinstance(t,k.PCB_TEXT)and t.GetText()=='USB   SVC':removed.append(t.m_Uuid.AsString());b.Remove(t)
for label,p in [('USB',[24.25,8.65]),('SVC',[26.25,8.65])]:
 t=k.PCB_TEXT(b);t.SetUuid(k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-boot-gate-v04:legend:'+label))));t.SetText(label);t.SetPosition(r.vec(p));t.SetLayer(k.F_SilkS);t.SetTextSize(k.VECTOR2I(k.FromMM(.8),k.FromMM(.8)));t.SetTextThickness(k.FromMM(.1));b.Add(t)
p=[51.5,32.7]
checks=[r.collision_test(b,'GND',.5,l,True)for l in r.ALL_COPPER];assert all(c(p,p)for c in checks)
coverage=[]
for z in b.Zones():
 if not z.GetIsRuleArea()and z.GetNetname()=='GND':
  for ln in r.ALL_COPPER:
   li=b.GetLayerID(ln)
   if z.IsOnLayer(li)and z.GetFilledPolysList(li).Collide(r.vec(p)):coverage.append(ln)
assert 'F.Cu'in coverage and 'In1.Cu'in coverage
v=k.PCB_VIA(b);v.SetUuid(k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-boot-gate-v04:new-ground-island-stitch'))));v.SetPosition(r.vec(p));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2));v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet('GND'));v.SetLocked(True);v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(v)
b.BuildConnectivity();k.ZONE_FILLER(b).Fill(b.Zones());k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v03/fieldnote.kicad_pro').read_bytes())
report={'source_board_sha256':'550e9def31a1accabf76d063e10fe3ba18d4262eb376bc1cf62be9a61d8569c7','annotation_changes':changes,'removed_selector_legend_uuid':removed,'new_ground_stitch':{'uuid':v.m_Uuid.AsString(),'position_board_mm':p,'drill_mm':.2,'diameter_mm':.5,'front_and_back_tented':True,'prefill_ground_zone_coverage':coverage,'cause':'Added reset-control routing split the front GND pour; this stitch joins its ESP-side island to the preserved In1 ground plane. Native saved/refill DRC must confirm connectivity.'},'candidate_board_sha256':hashlib.sha256((ROOT/'fieldnote.kicad_pcb').read_bytes()).hexdigest()}
(ROOT/'output/cleanup-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
