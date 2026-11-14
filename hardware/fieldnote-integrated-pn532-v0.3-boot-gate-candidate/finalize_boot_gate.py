#!/usr/bin/env python3
from pathlib import Path
import json,hashlib
import wx,pcbnew as k
import route_local as r
import build_design as g
ROOT=Path(__file__).resolve().parent

def main():
 app=wx.App(False);m=k.GetSettingsManager();m.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));b.SetProject(m.GetProject(str(ROOT/'fieldnote.kicad_pro')));fs={f.GetReference():f for f in b.GetFootprints()}
 new={'U8':([35.25,4.45],.7),'C38':([36.25,10.65],.7),'R29':([64.0,26.1],.7),'R30':([30.0,5.8],.7),'JP1':([25.5,6.05],.7)}
 annotations=[]
 for ref,(p,size) in {**new,'C9':([63.25,28.5],.6),'C33':([39.25,10.2],.6)}.items():
  f=fs[ref];before={'position':r.xy(f.Reference().GetPosition()),'visible':f.Reference().IsVisible(),'size':k.ToMM(f.Reference().GetTextSize().x)}
  f.Reference().SetPosition(r.vec(p));f.Reference().SetTextSize(k.VECTOR2I(k.FromMM(size),k.FromMM(size)));f.Reference().SetTextThickness(k.FromMM(.1));f.Reference().SetVisible(True);f.Reference().SetLayer(k.F_SilkS);f.Reference().SetTextAngle(k.EDA_ANGLE(0,k.DEGREES_T));annotations.append({'ref':ref,'before':before,'after':{'position':p,'size':size,'visible':True}})
 text=k.PCB_TEXT(b);text.SetText('USB   SVC');text.SetPosition(r.vec([25.5,8.45]));text.SetLayer(k.F_SilkS);text.SetTextSize(k.VECTOR2I(k.FromMM(.6),k.FromMM(.6)));text.SetTextThickness(k.FromMM(.1));b.Add(text)
 b.BuildConnectivity();filler=k.ZONE_FILLER(b);filler.Fill(b.Zones());k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v02/fieldnote.kicad_pro').read_bytes())
 (ROOT/'output/annotation-changes.json').write_text(json.dumps({'scope':'Reference/selectorlegend only; oldcomponentposes/pads/copperunchanged','changes':annotations},indent=2)+'\n')
 data=json.loads((ROOT/'design-data.json').read_text());g.PARTS=data['parts'];g.schematic();g.write_tables([]);(ROOT/'design-data.json').write_text(json.dumps(data,indent=2)+'\n')
 for p in ROOT.glob('*.kicad_sch'):p.write_text(p.read_text().replace('(rev "0.3-boot-gate-candidate")','(rev "0.3-boot-gate-candidate")').replace('(date "2026-10-03")','(date "2026-10-04")'))
 print(json.dumps({'status':'CANDIDATE_FILLED_AND_ANNOTATED_NATIVE_CHECKS_PENDING','board_sha256':hashlib.sha256((ROOT/'fieldnote.kicad_pcb').read_bytes()).hexdigest()}))
if __name__=='__main__':main()
