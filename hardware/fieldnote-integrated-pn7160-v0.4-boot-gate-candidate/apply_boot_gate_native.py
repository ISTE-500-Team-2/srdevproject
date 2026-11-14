#!/usr/bin/env python3
"""Import exact new footprints and isolate only reset/pullup copper in candidate."""
from pathlib import Path
import hashlib,json
import wx
import pcbnew as k
import build_design as g
ROOT=Path(__file__).resolve().parent
BASE_SHA='16c767ce38c3ed0bdd8345fea9010f13027d1d3d23fdc06d10d02107cebbdd65'
RESET_REMOVED={'12206052-95c1-418e-a62f-c7eefa2fc60a','1c37adc3-a9f6-4d12-93c3-59dd3fa77caa','8d5ce634-87a2-4bb2-984f-1b412d5c2418','9eac0a9e-7d77-4ac2-a1fc-a54add150171','ef89ced7-1974-40f6-af08-51ed43a2e208','b78ca86b-3602-4207-92c8-ee341aeade58','4eefddda-76bf-4276-abda-672f4a5adfcb'}
PULLUP_REMOVED={'14e944ce-7899-4dfa-9341-ff3cb253ced9','1b01b75d-7bdb-4f04-9610-761255777256','86c300e7-cbbd-44b7-954c-b4fdb5c90ed2','84561600-1622-498c-8aff-e05a067e629c'}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def xy(v):return [round(k.ToMM(v.x)-60,6),round(k.ToMM(v.y)-50,6)]
def vec(p):return k.VECTOR2I(round((p[0]+60)*1e6),round((p[1]+50)*1e6))
def main():
 raw=(ROOT/'source-v03/fieldnote.kicad_pcb').read_bytes();assert hashlib.sha256(raw).hexdigest()==BASE_SHA
 tree=g.readsex(raw.decode());renamed=[];removed=[]
 def rename(node):
  if not isinstance(node,list):return
  if node and node[0]=='net' and g.unq(node[1])=='ESP_EN':node[1]=g.q('ESP_RESET_RC')
  for n in node:rename(n)
 for node in tree:
  if not isinstance(node,list) or not node:continue
  if node[0] in ('segment','via'):
   ui=g.unq(g.child(node,'uuid')[1])
   if ui in RESET_REMOVED|PULLUP_REMOVED:removed.append({'uuid':ui,'sexpr':g.sx(node),'reason':'Isolate push-pull CHIP_EN' if ui in RESET_REMOVED else 'Isolate R12 high side while retaining/reconnecting original3V3 rail'});continue
   if g.unq(g.child(node,'net')[1])=='ESP_EN':renamed.append(ui)
  rename(node)
 tree=[n for n in tree if not (isinstance(n,list) and n and n[0] in ('segment','via') and g.unq(g.child(n,'uuid')[1]) in RESET_REMOVED|PULLUP_REMOVED)]
 assert len(removed)==11
 (ROOT/'output/isolation-before-import.kicad_pcb').write_text(g.sx(tree)+'\n')
 app=wx.App(False);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v03/fieldnote.kicad_pro').read_bytes());manager=k.GetSettingsManager();manager.LoadProject(str(ROOT/'fieldnote.kicad_pro'));b=k.LoadBoard(str(ROOT/'output/isolation-before-import.kicad_pcb'));b.SetProject(manager.GetProject(str(ROOT/'fieldnote.kicad_pro')));data=json.loads((ROOT/'design-data.json').read_text());old={f.GetReference():f for f in b.GetFootprints()}
 for name in ('ESP_EN','ESP_RESET_RC','POWER_PERMIT'):
  if b.FindNet(name) is None:b.Add(k.NETINFO_ITEM(b,name))
 for p in data['parts']:
  f=old.get(p['ref']);isnew=f is None
  if isnew:
   f=k.FootprintLoad(str(ROOT/'Fieldnote.pretty'),p['fp']);assert f
   f.SetReference(p['ref']);f.SetUuid(k.KIID(g.uid(p['ref'])));b.Add(f);f.SetPosition(vec(p['xy']));f.SetOrientationDegrees(p['angle']);f.SetFPID(k.LIB_ID('Fieldnote',p['fp']))
   f.SetPath(k.KIID_PATH('/'+g.ROOT_UUID+'/'+g.uid('sheetesp32-leds')+'/'+g.uid(p['ref'])))
   f.Reference().SetTextSize(k.VECTOR2I(k.FromMM(.7),k.FromMM(.7)));f.Reference().SetTextThickness(k.FromMM(.12))
   f.Reference().SetVisible(True);f.Value().SetVisible(False)
  f.SetValue(p['value']);f.SetField('MPN',p['mpn']);f.GetField('MPN').SetVisible(False);f.SetDNP(p['dnp'])
  for pad in f.Pads():
   pin=pad.GetNumber()
   if not pin:continue
   net=p['nets'][pin];name=p['names'].get(pin,pin)
   net=net or ('unconnected-('+p['ref']+'-'+('' if name==pin else name+'-')+'Pad'+pin+')')
   pad.SetNet(b.FindNet(net));pad.SetPinFunction(name)
   if isnew and p.get('pin_types'):pad.SetPinType(p['pin_types'].get(pin,'no_connect'))
 # Revision marking only; no changes to outline/coil/keepouts/RF/USB conductors.
 for item in b.GetDrawings():
  if isinstance(item,k.PCB_TEXT) and item.GetText().startswith('FIELDNOTE PN7160 v0.3'):
   item.SetText('FIELDNOTE PN7160 v0.4 - BOOT GATE REVIEW')
 k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b);(ROOT/'fieldnote.kicad_pro').write_bytes((ROOT/'source-v03/fieldnote.kicad_pro').read_bytes())
 report={'status':'SEPARATE_CANDIDATE_ISOLATED_NEEDS_ROUTING','base_board_sha256':BASE_SHA,'candidate_sha256':sha(ROOT/'fieldnote.kicad_pcb'),'removed_copper':removed,'renamed_reset_copper_uuids':renamed,'new_refs':['U8','C38','R29','R30','JP1'],'unaffected_source':'All remaining old tracks/vias retain geometry and UUID; old reset net renamedESP_RESET_RC. Root must independently verify after routing/refill.'}
 (ROOT/'output/isolation-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'board':str(ROOT/'fieldnote.kicad_pcb'),'renamed':len(renamed),'removed':len(removed),'new_refs':report['new_refs']}))
if __name__=='__main__':main()
