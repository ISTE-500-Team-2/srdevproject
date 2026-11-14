from pathlib import Path
import hashlib,json
import wx,pcbnew as k,route_pn7160 as r
ROOT=Path(__file__).resolve().parent
app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')))
for t in b.GetDrawings():
 if isinstance(t,k.PCB_TEXT)and t.m_Uuid.AsString()in('13859acd-bd15-5340-8e76-4f29baf887dd','26b2fddc-6407-56bf-89e3-481a0362f32f'):t.SetPosition(r.vec([23.7 if t.GetText()=='USB' else 26.2,8.65]))
src=k.LoadBoard(str(ROOT/'source-v03/fieldnote.kicad_pcb'));old={t.m_Uuid.AsString():t for t in src.GetDrawings()}
for t in b.GetDrawings():
 if t.m_Uuid.AsString()=='1b804338-f1c7-576e-9d3a-3cb55f76be16':t.SetPosition(old[t.m_Uuid.AsString()].GetPosition())
k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v03/fieldnote.kicad_pro').read_bytes())
print(hashlib.sha256((ROOT/'fieldnote.kicad_pcb').read_bytes()).hexdigest())
