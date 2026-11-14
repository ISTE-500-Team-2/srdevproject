"""Prepare a routed revision for completion with a reserved USB pair.

Keep In1.Cu as a ground reference and all switch/RF/ground seeds fixed.
Remove three existing signal segments that obstruct new thermal vias.
"""
from pathlib import Path
import re,json,shutil
import pcbnew as k
import wx
ROOT=Path(__file__).resolve().parent
def main():
    app=wx.App(False);path=ROOT/'fieldnote.kicad_pcb';b=k.LoadBoard(str(path))
    fs=list(b.GetFootprints());fps={f.GetReference():f for f in fs};ts=list(b.GetTracks())
    ids={'ad0f377d-b161-4e3e-b1b9-9733ac9f41c3','57304428-b7ba-4475-bd9d-a450188b9ec8','2c5f1045-672a-4e0a-8a1e-4416259656c6'}
    for t in ts:
        if t.m_Uuid.AsString() in ids:b.Remove(t)
    paste=[p for p in fps['U3'].Pads() if p.IsOnLayer(k.F_Paste) and not p.IsOnLayer(k.F_Cu)]
    for p in paste:fps['U3'].Remove(p)
    window=[(.07,.07),(.77,.07),(.77,.77),(.07,.77),(.07,.75),(.25,.75),(.25,.25),(.07,.25)]
    for sx in [-1,1]:
        for sy in [-1,1]:
            p=k.PAD(fps['U3']);p.SetNumber('');p.SetAttribute(k.PAD_ATTRIB_SMD);p.SetShape(k.PAD_SHAPE_CUSTOM)
            p.SetSize(k.VECTOR2I(k.FromMM(.05),k.FromMM(.05)))
            p.SetPosition(k.VECTOR2I(k.FromMM(118+sx*.5),k.FromMM(58.8+sy*.5)))
            layers=k.LSET();layers.AddLayer(k.F_Paste);p.SetLayerSet(layers)
            poly=k.SHAPE_POLY_SET();poly.NewOutline()
            for x,y in window:poly.Append(k.VECTOR2I(k.FromMM((x-.5)*sx),k.FromMM((y-.5)*sy)))
            p.AddPrimitivePoly(k.F_Paste,poly,0,True);fps['U3'].Add(p)
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones());k.SaveBoard(str(path),b)
    dsn=ROOT/'output/fieldnote-resume-native.dsn';assert k.ExportSpecctraDSN(b,str(dsn))
    s=dsn.read_text().replace('(width 200)','(width 150)').replace('(clearance 37.5 (type smd_smd))','(clearance 150 (type smd_smd))')
    # Reviewed USB routes are locked before export. Preserve their networks so
    # the session importer can retain all four fixed paths.
    usb=['USB_DP','USB_DM','MCU_USB_DP','MCU_USB_DM']
    start=s.index('    (class kicad_default');stop=s.index('  (wiring',start)
    block=s[start:stop]
    special=['GND','3V3','VSYS','VBUS','BAT','PN3V','NFC_VBAT']+usb
    for net in special:block=re.sub(r'(?<![\w-])'+net+r'(?![\w-])','',block)
    classes='    (class GND GND (rule (width 200) (clearance 150)))\n'
    classes+='    (class POWER 3V3 VSYS VBUS BAT NFC_VBAT (rule (width 350) (clearance 150)))\n'
    classes+='    (class ANALOG PN3V (rule (width 200) (clearance 150)))\n'
    classes+='    (class USB '+' '.join(usb)+' (rule (width 230) (clearance 150)))\n'
    s=s[:start]+classes+block+s[stop:]
    (ROOT/'output/fieldnote-resume.dsn').write_text(s)
    print('Prepared ground-plane router completion with reviewed USB routes fixed.')
if __name__=='__main__':main()
