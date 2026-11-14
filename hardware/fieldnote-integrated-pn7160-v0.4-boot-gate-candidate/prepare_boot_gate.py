#!/usr/bin/env python3
"""Surgical USB-qualified reset candidate; never rebuild the baseline board."""
from pathlib import Path
import copy,hashlib,json,shutil,uuid
import build_design as g
ROOT=Path(__file__).resolve().parent

def write(name,text): (ROOT/'Fieldnote.pretty'/name).write_text(text+'\n')
def effects():return '(effects (font (size 0.7 0.7) (thickness 0.12)))'
def outline(points,layer,width):return ''.join('(fp_line (start %s %s) (end %s %s) (stroke (width %s) (type solid)) (layer "%s"))'%(*a,*b,width,layer) for a,b in zip(points,points[1:]+points[:1]))

def main():
 d=json.loads((ROOT/'source-v03/design-data.json').read_text());p={p['ref']:p for p in d['parts']}
 for ref in ('R12','C9','SW1','J4'):
  p[ref]['nets']={key:('ESP_RESET_RC' if net=='ESP_EN' else net) for key,net in p[ref]['nets'].items()}
 p['R12']['nets']['2']='POWER_PERMIT';p['R12']['note']='47k reset RC pullup to POWER_PERMIT. Empty-C9 cold delay starts after USB qualification; brief detach/replug may retain charge. No guaranteed BQ input-mode transition time.'
 p['C9']['note']='Existing reset RC input capacitor. Manual RESET and recovery header affect this input, never push-pull gate output.'
 p['SW1']['names']['1']=p['SW1']['names']['2']='RESET_RC';p['J4']['names']['5']='RESET_RC'
 p['J4']['note']='DNP recovery header. Pin5 pulls ESP_RESET_RC only. Default USB permission required; service selector must cut default copper before bridging SERVICE side.'
 p['R2'].update(value='10k 1%',mpn='RC0603FR-0710KL',note='10k pulldown on USB_HIGH_CURRENT / BQ EN2. Conservative 30uA total high-impedance leakage through hot resistor gives0.3048V below BQ0.4V LOW limit; exact3V valid-logic screen only.')
 def add(ref,value,fp,nets,pos,mpn,note,names,angle=0,pin_types=None):
  a=dict(ref=ref,value=value,fp=fp,nets={str(k):v for k,v in nets.items()},xy=list(pos),angle=angle,group='MCU',mpn=mpn,note=note,dnp=False,names={str(k):v for k,v in names.items()})
  if pin_types:a['pin_types']={str(k):v for k,v in pin_types.items()}
  d['parts'].append(a)
 add('U8','SN74LVC1G97DBVR','TI_DBV0006A',{1:'GND',2:'GND',3:'ESP_RESET_RC',4:'ESP_EN',5:'3V3',6:'POWER_PERMIT'},[34.4,8.0],'SN74LVC1G97DBVR','Schmitt AND: In1 grounded, Y=In0 AND In2. ESP32 permission precedes reset release only at valid logic supply. Neither arbitrary rail ramp nor full startup qualified.',{1:'In1',2:'GND',3:'In0_RESET_RC',4:'Y_CHIP_EN',5:'VCC',6:'In2_POWER_PERMIT'},pin_types={1:'input',2:'power_in',3:'input',4:'output',5:'power_in',6:'input'})
 add('C38','100nF 50V X7R','C_0603',{1:'3V3',2:'GND'},[37.3,8.1],'CC0603KRX7R9BB104','Local U8 supply decoupling.',{1:'1',2:'2'},90)
 add('R29','47k 1%','R_0603',{1:'ESP_EN',2:'GND'},[63.25,27.5],'RC0603FR-0747KL','Pulldown at ESP32 CHIP_EN gate output; external/manual reset acts only on input RC.',{1:'1',2:'2'})
 add('R30','47k 1%','R_0603',{1:'POWER_PERMIT',2:'GND'},[34.4,10.5],'RC0603FR-0747KL','47k bounds two input leakages to0.478V with selector open at exact3V; default-low Schmitt gate permission; solder selector is mutually exclusive.',{1:'1',2:'2'})
 add('JP1','USB / SERVICE PERMIT','Permit_Selector_3_Bridged12',{1:'USB_HIGH_CURRENT',2:'POWER_PERMIT',3:'3V3'},[25.5,7.25],'PCB copper','Default copper bridge1-2 selects USB-qualified operation. CUT1-2 before soldering2-3 SERVICE. Never bridgeboth: U7 output would short3V3. Service allows low-current programming/future battery experimentation but does not qualify charging or NFC at low cell voltage.',{1:'USB_HIGH_CURRENT',2:'COMMON_PERMIT',3:'SERVICE_3V3'})
 d['variant']='PN7160 v0.4 USB boot-gate candidate';d['engineering_status']='HOLD_REVIEW_CANDIDATE_NATIVE_CHECKS_AND_PHYSICAL_QUALIFICATION_PENDING';d['usb_boot_gate_profile']={'gate_mpn':'SN74LVC1G97DBVR','truth':'CHIP_EN = ESP_RESET_RC AND POWER_PERMIT with In1=GND','normal_selector':'JP1 copper bridge1-2; USB_HIGH_CURRENT drives POWER_PERMIT','service_selector':'Cut1-2 completely before solder bridge2-3; never bridgeboth','R12_high_side':'POWER_PERMIT','physical_status':'NOT TESTED','future_battery':'Normal selector requires USB. Explicit service setting permits experimental battery boot but does not qualify battery charging, NFC TXLDO voltage profile, transient power, or protection.','cold_delay_scope':'Empty C9 and valid3V logic step only; retained C9 charge after brief detach may allow immediate release once permission returns.','BQ_mode_settling':'No guaranteed BQ EN2 transition bound established; full startup transient model has not completed.'}
 (ROOT/'design-data.json').write_text(json.dumps(d,indent=2)+'\n')
 # Match TI DBV0006A RevN example PCB layout: six1.10x0.60mm lands, centers x±1.30mm/y±0.95mm/0;R0.05.
 s='(footprint "TI_DBV0006A" (version 20221018) (generator pcbnew) (layer "F.Cu") (descr "TI SN74LVC1G97 Rev N DBV0006A example board layout; see primary datasheet page36") (attr smd)'
 s+='(fp_text reference "REF**" (at 0 -2.15) (layer "F.SilkS") '+effects()+')'
 s+='(fp_text value "TI_DBV0006A" (at 0 2.2) (layer "F.Fab") '+effects()+')'
 s+=outline([(-.8,-1.45),(.8,-1.45),(.8,1.45),(-.8,1.45)],'F.Fab',.1)
 s+=outline([(-2.1,-2.025),(2.1,-2.025),(2.1,2.025),(-2.1,2.025)],'F.CrtYd',.05)
 s+='(fp_line (start -1.9 -1.5) (end 0.8 -1.5) (stroke (width .12) (type solid)) (layer "F.SilkS")) (fp_line (start -.8 1.5) (end .8 1.5) (stroke (width .12) (type solid)) (layer "F.SilkS"))'
 for n,x,y in [(1,-1.3,-.95),(2,-1.3,0),(3,-1.3,.95),(4,1.3,.95),(5,1.3,0),(6,1.3,-.95)]:
  s+=f'(pad "{n}" smd roundrect (at {x} {y}) (size 1.1 .6) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.0833333333) (solder_mask_margin 0.05))'
 write('TI_DBV0006A.kicad_mod',s+')')
 s='(footprint "Permit_Selector_3_Bridged12" (version 20221018) (generator pcbnew) (layer "F.Cu") (descr "PCB-only mutually exclusive USB/SERVICE selector; cut bridge1-2 before solder2-3; neverboth") (attr smd exclude_from_pos_files exclude_from_bom) (net_tie_pad_groups "1,2")'
 s+='(fp_text reference "REF**" (at 0 -1.0) (layer "F.SilkS") '+effects()+')'
 s+='(fp_text value "CUT_USB_BEFORE_SERVICE" (at 0 1) (layer "F.Fab") '+effects()+')'
 s+=outline([(-1.8,-.65),(1.8,-.65),(1.8,.65),(-1.8,.65)],'F.CrtYd',.05)
 for n,x in [(1,-1.1),(2,0),(3,1.1)]:s+=f'(pad "{n}" smd rect (at {x} 0) (size .8 .8) (layers "F.Cu" "F.Mask"))'
 s+='(fp_poly (pts (xy -1.1 -.1) (xy 0 -.1) (xy 0 .1) (xy -1.1 .1)) (stroke (width 0) (type solid)) (fill solid) (layer "F.Cu"))'
 write('Permit_Selector_3_Bridged12.kicad_mod',s+')')
 g.PARTS=d['parts'];g.SHEET_GROUPS=[('usb-power',['USB','Power']),('esp32-leds',['MCU','Indicators']),('pn7160',['NFC','Test']),('nfc-rf',['RF'])]
 g.schematic();g.write_tables([]);(ROOT/'design-data.json').write_text(json.dumps(d,indent=2)+'\n')
 for path in ROOT.glob('*.kicad_sch'):
  t=path.read_text().replace('(rev "0.3")','(rev "0.4-boot-gate-candidate")').replace('(date "2026-10-03")','(date "2026-10-04")')
  path.write_text(t)
 print(json.dumps({'status':d['engineering_status'],'parts':len(d['parts']),'added':['U8','C38','R29','R30','JP1'],'R2':'10k','R12_high_side':'POWER_PERMIT'}))
if __name__=='__main__':main()
