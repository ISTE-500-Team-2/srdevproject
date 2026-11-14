from pathlib import Path
import json,hashlib
import wx,pcbnew as k
ROOT=Path(__file__).resolve().parent
app=wx.App(False);b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));u=next(f for f in b.GetFootprints()if f.GetReference()=='U8');lib=k.FootprintLoad(str(ROOT/'Fieldnote.pretty'),'TI_DBV0006A')
rows=[]
for p,q in zip(sorted(u.Pads(),key=lambda p:p.GetNumber()),sorted(lib.Pads(),key=lambda p:p.GetNumber())):
 assert p.GetNumber()==q.GetNumber();margin=k.ToMM(p.GetLocalSolderMaskMargin());lm=k.ToMM(q.GetLocalSolderMaskMargin());assert margin==.05 and lm==.05
 assert p.GetLocalSolderPasteMargin()==q.GetLocalSolderPasteMargin() and p.GetLocalSolderPasteMarginRatio()==q.GetLocalSolderPasteMarginRatio();assert p.GetLocalSolderPasteMargin()in(None,0) and p.GetLocalSolderPasteMarginRatio()in(None,0)
 assert abs(k.ToMM(p.GetSize().x)-1.1)<1e-9 and abs(k.ToMM(p.GetSize().y)-.6)<1e-9
 rows.append({'pad':p.GetNumber(),'native_local_mask_margin_mm':margin,'library_local_mask_margin_mm':lm,'copper_width_mm':1.1,'copper_height_mm':.6,'mask_opening_nominal_width_mm':1.2,'mask_opening_nominal_height_mm':.7,'minimum_between_adjacent_pad_openings_mm':.25,'local_paste_margin_mm':p.GetLocalSolderPasteMargin(),'local_paste_margin_ratio':p.GetLocalSolderPasteMarginRatio(),'paste_override_scope':'None means inherited unchanged source default; no local override introduced'})
report={'status':'PASS_NATIVE_LIBRARY_SIX_PAD_50UM_MASK_MARGIN','board_sha256':hashlib.sha256((ROOT/'fieldnote.kicad_pcb').read_bytes()).hexdigest(),'library_sha256':hashlib.sha256((ROOT/'Fieldnote.pretty/TI_DBV0006A.kicad_mod').read_bytes()).hexdigest(),'pads':rows,'limitations':'Nominal mask relief/geometry only; manufacturer solder-mask registration/web capability and assembled joints remain HOLD.'}
(ROOT/'output/U8-native-mask-check-v4a.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'status':report['status'],'pads':len(rows),'board':report['board_sha256']}))
