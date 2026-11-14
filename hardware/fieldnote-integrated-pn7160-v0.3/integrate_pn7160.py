#!/usr/bin/env python3
"""Create the separate PN7160 circuit/seed from an immutable routed PN532 PCB.

Run with KiCad bundled Python. No v0.2 file is ever written. --seed is a
one-time operation and refuses to overwrite an already integrated variant;
--schematic-only refreshes native schematics/tables from current metadata.
The seed removes declared obsolete NFC copper and requires routing/native
ERC/DRC/parity checks before an engineering preview is declared complete.
"""
from pathlib import Path
import argparse, copy, hashlib, json, math, shutil
import wx
import pcbnew as k
import build_design as gen

ROOT=Path(__file__).resolve().parent
BASE=ROOT/'baseline/fieldnote-pn532-frozen.kicad_pcb'
BASE_SHA='1ea3e9e01202277e5603b3c989f391fa86cc71dfa319b053cda6c318f2e056a2'

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def xy(p):return [round(k.ToMM(p.x)-60,6),round(k.ToMM(p.y)-50,6)]
def vec(p):return k.VECTOR2I(round((p[0]+60)*1e6),round((p[1]+50)*1e6))

def circuit(board):
    data=json.loads((ROOT/'baseline/design-data-pn532.json').read_text())
    parts=copy.deepcopy(data['parts']);by={p['ref']:p for p in parts}
    native={f.GetReference():f for f in board.GetFootprints()}
    # Frozen native placements, not the earlier generator placement lock,
    # define all unaffected component positions.
    for p in parts:
        f=native[p['ref']];p['xy']=xy(f.GetPosition());p['angle']=f.GetOrientationDegrees()
        p['value']=f.GetValue();p['mpn']=f.GetFieldText('MPN') or p['mpn']
    def setpart(ref,**changes):by[ref].update(changes)
    pn_names=['I2C_ADR0','DWL_REQ','I2C_ADR1','VSS_PAD','I2C_SDA','VDD_PAD','I2C_SCL','IRQ','VSS_A','VEN',
        'IC_NC11','VBAT2','VDD_UP','VDD_TX','RXN','RXP','VDD_VMID','TVDD_IN','TX2','VSS_TX','TX1','TVDD_IN2',
        'ANT1_NC','ANT2_NC','VDD_HF_NC','VDD_A','VDD','VBAT','XTAL2','NFC_CLK_XTAL1','VDD_D',
        'NC32','NC33','NC34','NC35','NC36','DCDC_EN_NC','IC_NC38','WKUP_REQ','CLK_REQ_NC','EP']
    pn={str(i):None for i in range(1,42)}
    pn.update({str(i):n for i,n in {1:'GND',2:'GND',3:'GND',4:'GND',5:'NFC_SDA',6:'3V3',7:'NFC_SCL',8:'NFC_IRQ',9:'GND',10:'NFC_VEN',
        12:'NFC_VBAT',13:'NFC_VBAT',14:'PN_TX_LDO',15:'NFC_RXN',16:'NFC_RXP',17:'NFC_VMID',18:'PN_TX_LDO',19:'NFC_TX2',20:'GND',21:'NFC_TX1',22:'PN_TX_LDO',
        26:'PN_1V8',27:'PN_1V8',28:'NFC_VBAT',29:'NFC_OSCOUT',30:'NFC_OSCIN',31:'PN_1V8',39:'GND',41:'GND'}.items()})
    types={str(i):'power_in' for i in [4,6,9,12,13,18,20,22,26,28,31,41]}
    types.update({str(i):'power_out' for i in [14,17,27]})
    types.update({str(i):'input' for i in [1,2,3,10,15,16,30,39]})
    types.update({str(i):'output' for i in [8,19,21,29]});types.update({'5':'bidirectional','7':'input'})
    setpart('U2',value='PN7160A1HN/C100E',mpn='PN7160A1HN/C100E',fp='PN7160_HVQFN40',nets=pn,names={str(i+1):n for i,n in enumerate(pn_names)},pin_types=types,angle=180,
        note='NCI I2C 0x28. CFG2: VBAT/VDDUP from filtered VSYS, PAD=3V3; internal 1V8/TXLDO outputs isolated. GPIO7 VEN, GPIO20 IRQ via R27. Reader-only ANT1/ANT2/VDDHF left open per NXP reference.')
    setpart('FB1',note='500mA ferrite bead. Manufacturer initial DCR maximum0.38ohm; post-qualification maximum0.48ohm. Variant hot/post-stress engineering screen uses0.60ohm, not a guaranteed85C specification.')
    by['U1']['nets']['21']='NFC_VEN';by['U1']['nets']['30']='MCU_NFC_IRQ'
    by['U1']['note']+=' PN7160 IRQ uses GPIO20; UART RX recovery needs R27 removed/R28 fitted.'
    for p in parts:
        if p['ref'] in ['C20','C21']:continue
        p['nets']={i:('NFC_VEN' if n=='NFC_RESET_N' else n) for i,n in p['nets'].items()}
    setpart('C12',nets={'1':'NFC_VBAT','2':'GND'},xy=[35.55,27.0],angle=90,note='4.7uF at VBAT28; also connected to VBAT2 pin12. Check effective capacitance/rail drop.')
    setpart('C13',nets={'1':'NFC_VBAT','2':'GND'},xy=[44.65,20.25],angle=90,note='Local 100nF at VBAT2 pin12.')
    setpart('C14',nets={'1':'NFC_VBAT','2':'GND'},xy=[41.75,19.0],angle=90,note='4.7uF at VDDUP pin13; filtered VSYS supply shared with VBAT per NXP CFG2.')
    for ref,net,pos,angle,note in [
        ('C15','PN_1V8',[35.95,30.0],180,'2.2uF near DVDD31; internal1.8V output only.'),
        ('C16','PN_1V8',[35.9,24.7],180,'2.2uF near AVDD26; tied to VDD27/DVDD31.'),
        ('C17','PN_TX_LDO',[39.25,19.0],90,'2.2uF at TVDD_IN18; internalTXLDO output only.'),
        ('C18','PN_TX_LDO',[35.6,22.2],180,'Second2.2uF near TVDD_IN2 pin22; tied to VDDTX14/TVDD_IN18.')]:
        setpart(ref,value='2.2uF 10V X7R 10%',mpn='CL10B225KP8NNNC',fp='C_0603',nets={'1':net,'2':'GND'},xy=pos,angle=angle,note=note+' Effective DC-bias capacitance remains a qualification gate.')
    setpart('C19',value='1uF 16V X7R 10%',mpn='C0603C105K4RACTU',nets={'1':'3V3','2':'GND'},xy=[46.2,24.75],angle=0,note='1uF at VDDPAD6, same3V3 supply as ESP32 and I2C pullups.')
    setpart('R19',nets={'1':'NFC_VEN','2':'GND'},xy=[46.0,22.0],angle=90,note='100k pulldown holds active-high VEN low during host reset; GPIO7 enables only after current qualification.')
    setpart('Y1',value='27.12MHz CL10pF',mpn='NX2016SA-27.12MHZ-EXS00A-CS06346',fp='Crystal_2016',xy=[40.2,32.4],angle=0,note='NXP AN14518 Table9 approved crystal. Provisional13pF branch capacitors; oscillator startup and frequency require physical validation.')
    for ref,pos in [('C22',[37.75,32.4]),('C23',[42.65,32.4])]:
        setpart(ref,value='13pF C0G 50V 1%',mpn='CBR06C130F5GAC',xy=pos,angle=90,note='Provisional AN14518 load calculation; exact1% C0G part selected; measured tune required.')
    # AN13219 differential topology; initial values, not an inherited PN532 tune.
    for ref in ['L1','L2']:
        setpart(ref,value='160nH 5%',mpn='LQW18CAR16J00D',fp='L_0603',note='Murata160nH,1.3A,DCRmax75mohm. AN13219 initial asymmetrical EMC stage; fullRF current/thermal qualification pending.')
    setpart('L2',xy=[36.5,23.85],angle=180)
    for ref in ['C24','C25']:setpart(ref,value='330pF C0G 50V 2%',mpn='CC0603GRNPO9BN331',note='AN13219 asymmetrical EMC shunt starting value.')
    setpart('C25',xy=[36.75,28.65],angle=0)
    for ref in ['C26','C27']:setpart(ref,value='130pF C0G 50V 2%',mpn='CC0603GRNPO9BN131',note='PN7160 conditional13ohm nominal coil model initialseriesvalue; physical final-case tuning required.')
    for ref in ['C28','C29']:setpart(ref,value='330pF C0G 50V 2%',mpn='CC0603GRNPO9BN331',note='PN7160 conditional13ohm nominal coil model initialshuntvalue; physical final-case tuning required.')
    for ref in ['R22','R23']:setpart(ref,value='1.3R 1% 0.5W',mpn='CRCW08051R30FKEAHP',note='Matched RF damping; modeled power screen and physical TX/RX tuning required.')
    for ref in ['C34','C35']:setpart(ref,dnp=True,note='Reserved DNP trim site; inherited47pF/5% MPN is a placeholder excluded from nominal RF and sourcing. Any measured tuning population must select symmetric C0G parts with tolerance≤2% per AN13219.')
    setpart('R24',value='2.2k 1%',mpn='RC0603FR-072K2L',nets={'1':'RF1_FILTER','2':'RF_RXP_COUPLED'},xy=[42.75,16.8],angle=0,note='Differential receiverP EMC-node tap, AN13219 coilarea>800mm² initial2.2k.')
    setpart('R25',value='2.2k 1%',mpn='RC0603FR-072K2L',nets={'1':'RF2_FILTER','2':'RF_RXN_COUPLED'},xy=[45.0,16.8],angle=0,note='Matched differential receiverN EMC-node tap; not antenna-side tap.')
    setpart('C31',value='1nF X7R 50V 5%',mpn='CC0603JRX7R9BB102',nets={'1':'RF_RXP_COUPLED','2':'NFC_RXP'},xy=[41.5,20.8],angle=0,note='1nF X7R 50V ±5% AC coupling to RXP16; matched to C37 at RXN15 per AN13219.')
    setpart('C30',nets={'1':'NFC_VMID','2':'GND'},xy=[37.7,19.0],angle=90,note='100nF at VMID17 only; differential RX uses AC coupling.')
    for ref,net,pos in [('TP2','PN_1V8',[37.0,18.5]),('TP4','PN_TX_LDO',[36.0,16.6]),('TP5','NFC_VEN',[42.0,15.25])]:
        setpart(ref,value=net,nets={'1':net},names={'1':net},xy=pos)
    parts=[p for p in parts if p['ref'] not in ['C20','C21']]
    def add(ref,value,fp,nets,pos,mpn,note,dnp=False):
        parts.append(dict(ref=ref,value=value,fp=fp,nets=nets,xy=pos,angle=0,group='NFC',mpn=mpn,note=note,dnp=dnp,names={i:i for i in nets}))
    add('C37','1nF X7R 50V 5%','C_0603',{'1':'RF_RXN_COUPLED','2':'NFC_RXN'},[44.15,20.8],'CC0603JRX7R9BB102','Matched1nF differentialN receiver AC coupling.')
    add('R27','0R IRQ SERVICE LINK','R_0603',{'1':'NFC_IRQ','2':'MCU_NFC_IRQ'},[43.75,5.5],'RC0603JR-070RL','Fitted normal reader mode. Remove before fitting R28 UART RX recovery link.')
    add('R28','0R UART SERVICE LINK','R_0603',{'1':'UART_RX','2':'MCU_NFC_IRQ'},[43.75,7.5],'RC0603JR-070RL','DNP normal mode. Fit only with R27 removed, VEN heldlow for ROM UART recovery.',True)
    data['parts']=parts;data['variant']='PN7160 v0.3';data['engineering_status']='SEED_NEEDS_ROUTING_AND_NATIVE_CHECKS'
    data['nfc_profile']={'mpn':'PN7160A1HN/C100E','i2c_address_7bit':40,'sda_gpio':4,'scl_gpio':5,'ven_gpio':7,'irq_gpio':20,'irq_active_high':True,'power_config':'CFG2 without DC/DC: VBAT/VDDUP filteredVSYS; VDDPAD3V3','qualified_usb_txldo_v':3.3,'future_battery_profile':'Voltage-aware TXLDO setting required before future battery qualification.','uart_recovery':'RemoveR27, fitR28, holdVENlow. Neverfitboth.'}
    return data

def refresh_schematic(data):
    gen.PARTS=data['parts'];gen.SHEET_GROUPS=[('usb-power',['USB','Power']),('esp32-leds',['MCU','Indicators']),('pn7160',['NFC','Test']),('nfc-rf',['RF'])]
    gen.schematic();gen.write_tables([])
    (ROOT/'design-data.json').write_text(json.dumps(data,indent=2)+'\n')
    obsolete=ROOT/'pn532.kicad_sch'
    if obsolete.exists():obsolete.unlink()
    # The variant only uses this newly generated PN7160 native library.
    assert 'PN7160A1HN/C100E' in (ROOT/'pn7160.kicad_sch').read_text()

def seed():
    assert sha(BASE)==BASE_SHA,'Frozen baseline changed'
    marker=ROOT/'output/pn7160-seed/seed-manifest.json'
    assert not marker.exists(),'Seed already created; use --schematic-only after intentional metadata changes, never destroy routed variant.'
    b=k.LoadBoard(str(BASE));original=list(b.GetFootprints());all_tracks=list(b.GetTracks());old={f.GetReference():f for f in original}
    data=circuit(b);parts={p['ref']:p for p in data['parts']}
    refresh_schematic(data)
    obsolete={'PN3V','NFC_SVDD','NFC_RSTOUT','NFC_RESET_N','NFC_RX','RF_RX_COUPLED','UART_RX'}
    # Existing antenna terminals/copper, all USB nets, VSYS feed, regulator,
    # charger and unrelated GPIO conductors stay unchanged.
    changed_nets={n for p in data['parts'] if p['group'] in ['NFC','RF','Test'] for n in p['nets'].values() if n and n not in {'GND','3V3','VSYS','ANT_A','ANT_B','CHG_N','PGOOD_N','USB_LIMITED','USB_HIGH_CURRENT'}}
    removed=[];retained=[]
    def inside_chip(p):return 37.05<=p[0]<=44.55 and 21.25<=p[1]<=28.75
    old_pad_boxes=[]
    for ref in ['C12','C13','C14','C15','C16','C17','C18','C19','C20','C21','C22','C23','C30','C31','Y1']:
        for pad in old[ref].Pads():
            bb=pad.GetBoundingBox();a=xy(bb.GetPosition());c=xy(k.VECTOR2I(bb.GetX()+bb.GetWidth(),bb.GetY()+bb.GetHeight()))
            old_pad_boxes.append((a,c))
    def old_pad_end(p):return any(a[0]-.01<=p[0]<=c[0]+.01 and a[1]-.01<=p[1]<=c[1]+.01 for a,c in old_pad_boxes)
    for t in all_tracks:
        n=t.GetNetname();a,c=xy(t.GetStart()),xy(t.GetEnd());via=isinstance(t,k.PCB_VIA)
        remove=n in obsolete or n in changed_nets
        reason='obsolete or rerouted NFC net'
        if n in ['GND','3V3']:
            remove=(not via and (inside_chip(a) or inside_chip(c))) or old_pad_end(a) or old_pad_end(c)
            if via and n=='GND' and math.dist(a,[40.8,25])<2.05:remove=False
            reason='old NFC pad escape or displaced NFC bypass terminal'
        row={'uuid':t.m_Uuid.AsString(),'net':n,'a':a,'b':c,'kind':'via' if via else 'track','reason':reason}
        if remove:b.Remove(t);removed.append(row)
        else:retained.append(row)
    for f in original:
        if f.GetReference() not in parts:b.Remove(f)
    net_names=set()
    for p in data['parts']:
        for pin,net in p['nets'].items():
            name=p['names'].get(pin,pin)
            net_names.add(net or ('unconnected-('+p['ref']+'-'+('' if name==pin else name+'-')+'Pad'+pin+')'))
    for name in sorted(net_names):
        if b.FindNet(name) is None:b.Add(k.NETINFO_ITEM(b,name))
    for p in data['parts']:
        ref=p['ref'];oldf=old.get(ref)
        if oldf and oldf.GetFPIDAsString().split(':')[-1]==p['fp']:f=oldf
        else:
            f=k.FootprintLoad(str(ROOT/'Fieldnote.pretty'),p['fp']);assert f,('missingfootprint',p['fp'])
            f.SetReference(ref)
            if oldf:f.SetUuid(oldf.m_Uuid);b.Remove(oldf)
            else:f.SetUuid(k.KIID(gen.uid(ref)))
            b.Add(f)
        f.SetValue(p['value']);f.SetField('MPN',p['mpn']);f.GetField('MPN').SetVisible(False);f.SetPosition(vec(p['xy']));f.SetOrientationDegrees(p['angle'])
        f.SetDNP(p['dnp']);f.SetFPID(k.LIB_ID('Fieldnote',p['fp']))
        for pad in f.Pads():
            pin=pad.GetNumber()
            if not pin:continue
            net=p['nets'][pin];name=p['names'].get(pin,pin)
            net=net or ('unconnected-('+ref+'-'+('' if name==pin else name+'-')+'Pad'+pin+')')
            pad.SetNet(b.FindNet(net));pad.SetPinFunction(name)
    refresh_schematic(data)
    # Update native schematic UUID paths after the sheet changed pn532→pn7160.
    tmp=ROOT/'output/pn7160-native-before-paths.kicad_pcb';k.SaveBoard(str(tmp),b)
    tree=gen.readsex(tmp.read_text())
    for f in gen.children(tree,'footprint'):
        props={gen.unq(x[1]):gen.unq(x[2]) for x in gen.children(f,'property')}
        ref=props.get('Reference')
        if ref not in parts:continue
        p=parts[ref];tag=next(t for t,groups in gen.SHEET_GROUPS if p['group'] in groups)
        path=gen.child(f,'path')
        new=['path',gen.q('/'+gen.ROOT_UUID+'/'+gen.uid('sheet'+tag)+'/'+gen.uid(ref))]
        if path:path[:]=new
        else:f.append(new)
    (ROOT/'fieldnote.kicad_pcb').write_text(gen.sx(tree)+'\n')
    b=k.LoadBoard(str(ROOT/'fieldnote.kicad_pcb'));k.SaveBoard(str(ROOT/'fieldnote.kicad_pcb'),b)
    dst=ROOT/'output/pn7160-seed';dst.mkdir(exist_ok=True)
    for p in ROOT.iterdir():
        if p.is_file() and (p.suffix in ['.kicad_pcb','.kicad_pro','.kicad_sch','.kicad_sym'] or p.name in ['fp-lib-table','sym-lib-table']):shutil.copy2(p,dst/p.name)
    shutil.copytree(ROOT/'Fieldnote.pretty',dst/'Fieldnote.pretty',dirs_exist_ok=True)
    manifest={'status':'PN7160_SEED_NEEDS_ROUTING_NATIVE_CHECKS','source_sha256':BASE_SHA,'seed_sha256':sha(dst/'fieldnote.kicad_pcb'),'changed_nets':sorted(changed_nets|obsolete),'removed_copper':removed,'retained_copper':retained,'removed_components':['C20','C21'],'added_components':['C37','R27','R28'],'nfc_profile':data['nfc_profile'],'rf_nominal_values_status':'Initial AN13219/coil-model values; not physical RF qualification','unaffected_usb_power_geometry':'All non-NFC copper retained except specifically recorded old NFC3V3/GND escapes. Native final invariance audit required.'}
    marker.write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({k:v for k,v in manifest.items() if k not in ['removed_copper','retained_copper']},indent=2))

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--seed',action='store_true');ap.add_argument('--schematic-only',action='store_true');args=ap.parse_args()
    assert args.seed != args.schematic_only,'Choose --seed or --schematic-only explicitly'
    if args.seed:
        app=wx.App(False)
        seed()
    else:refresh_schematic(json.loads((ROOT/'design-data.json').read_text()))
if __name__=='__main__':main()
