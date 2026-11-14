#!/usr/bin/env python3
"""Generate a review-stage KiCad circuit and case-specific placement drawing.

No autorouting, zone filling, ERC, DRC, fabrication export, or physical validation
is implied. Coordinates are mm; PCB +Y maps to assembled enclosure +Y.
"""
from pathlib import Path
import csv, json, math, re, uuid, struct, collections, copy

ROOT = Path(__file__).resolve().parent
LIB = ROOT / 'Fieldnote.pretty'
OUT = ROOT / 'output'
NAMESPACE = uuid.UUID('270f6840-e3d2-423c-b720-98ea4ce6bf57')
def uid(s): return str(uuid.uuid5(NAMESPACE, str(s)))
def q(s): return json.dumps(str(s), ensure_ascii=False)
def readsex(text):
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+', text)
    pos = 0
    def read():
        nonlocal pos
        t = tokens[pos]; pos += 1
        if t == '(':
            a = []
            while tokens[pos] != ')': a.append(read())
            pos += 1
            return a
        return t
    out = read()
    assert pos == len(tokens), 'trailing S-expression tokens'
    return out
def sx(v): return '(' + ' '.join(map(sx, v)) + ')' if isinstance(v, list) else str(v)
def children(v, key): return [n for n in v[1:] if isinstance(n,list) and n and n[0] == key]
def child(v,key): return next(iter(children(v,key)), None)
def unq(s): return json.loads(s) if s.startswith('"') else s
def fmt(n): return f'{float(n):.5f}'.rstrip('0').rstrip('.') or '0'
def snap(n):return round(n/1.27)*1.27
def effects(size=1, hide=False, just=''):
    return f'(effects (font (size {size} {size})){" (justify " + just + ")" if just else ""}{" hide" if hide else ""})'

PARTS=[]
FLAG_NETS=['GND','3V3','VIN_PROT','5V_FIELD']
def add(ref, value, fp, nets, xy, group, mpn='', note='', angle=0, dnp=False, names=None):
    PARTS.append(dict(ref=ref,value=value,fp=fp,nets={str(k):v for k,v in nets.items()},
                      xy=list(xy),angle=angle,group=group,mpn=mpn,note=note,dnp=dnp,
                      names={str(k):v for k,v in (names or {}).items()}))
def two(ref,value,a,b,xy,group,fp=None,mpn='',note='',angle=0,dnp=False):
    if not fp: fp='R_0603' if ref.startswith('R') else 'C_0603'
    add(ref,value,fp,{1:a,2:b},xy,group,mpn,note,angle,dnp,{1:'1',2:'2'})

# USB-C / charging / regulated 3.3 V. A 10 k NTC bonded to the cell is required.
usb={'A1':'GND','A12':'GND','B1':'GND','B12':'GND','S1':'GND',
     'A4':'VBUS','A9':'VBUS','B4':'VBUS','B9':'VBUS','A5':'CC1','B5':'CC2',
     'A6':'USB_DP','B6':'USB_DP','A7':'USB_DM','B7':'USB_DM','A8':None,'B8':None}
add('J1','USB-C USB 2.0','USB_C',usb,(53.1,.2),'USB', 'HRO TYPE-C-31-M-12',
    '5 V input and native ESP32 USB; no USB PD',180,names={k:k for k in usb})
add('U6','TUSB320LAIRWBR','TUSB320_RWB12',
    {1:'CC1',2:'CC2',3:'GND',4:'USB_VBUS_DET',5:None,6:None,7:'USB_LIMITED',8:None,9:None,
     10:'GND',11:'GND',12:'3V3'},(48,8.5),'USB','TUSB320LAIRWBR',
    'Sink only, GPIO mode. Internal Rd includes dead-battery termination; no external 5.1k CC resistors.',
    names={1:'CC1',2:'CC2',3:'PORT',4:'VBUS_DET',5:'ADDR',6:'OUT3',7:'OUT1',8:'OUT2',9:'ID',10:'GND',11:'EN_N',12:'VDD'})
two('R1','887k 1%','VBUS','USB_VBUS_DET',(48,5.3),'USB',note='TI Rev D requires 855..920k at VBUS_DET')
two('R2','100k 1%','USB_HIGH_CURRENT','GND',(51,11.5),'Power',note='EN2 low until the current capability gate is powered')
two('C32','100nF 10V X7R','3V3','GND',(45,8.5),'USB',note='U6 supply decoupling; OUT1 also pulled to 3V3')
add('U7','SN74LVC1G04DBVR','SOT23-5',{1:None,2:'USB_LIMITED',3:'GND',4:'USB_HIGH_CURRENT',5:'3V3'},
    (48,12.1),'Power','SN74LVC1G04DBVR',
    'Inverts open-drain OUT1: only 1.5A/3A source advertisement permits resistor-programmed input limit',
    names={1:'NC',2:'A',3:'GND',4:'Y',5:'VCC'})
two('C33','100nF 10V X7R','3V3','GND',(45,11.5),'Power')
add('U5','USBLC6-2SC6','SOT23-6',{1:'USB_DM',2:'GND',3:'USB_DP',4:'USB_DP',5:'VBUS',6:'USB_DM'},
    (53.1,6.8),'USB','USBLC6-2SC6','Route through protection next to connector',
    names={1:'DM',2:'GND',3:'DP',4:'DP',5:'VBUS',6:'DM'})
two('R3','22R','USB_DM','MCU_USB_DM',(59,28),'MCU')
two('R4','22R','USB_DP','MCU_USB_DP',(62,28),'MCU')
two('C1','4.7uF 10V X5R','VBUS','GND',(60.5,8.8),'Power','C_0805',note='USB input capacitance below 10uF including tolerance; verify other input parasitics')
add('U3','BQ24074RGTR','BQ24074_RGT16',
    {1:'BAT_TS',2:'BAT',3:'BAT',4:'GND',5:'USB_HIGH_CURRENT',6:'GND',7:'PGOOD_N',8:'GND',9:'CHG_N',
     10:'VSYS',11:'VSYS',12:'CHG_ILIM',13:'VBUS',14:None,15:None,16:'CHG_ISET',17:'GND'},
    (58,11),'Power','BQ24074RGTR','Power path; TMR and ITERM open retain defaults',
    names={1:'TS',2:'BAT',3:'BAT',4:'CE_N',5:'EN2',6:'EN1',7:'PGOOD_N',8:'VSS',9:'CHG_N',
           10:'OUT',11:'OUT',12:'ILIM',13:'IN',14:'TMR',15:'ITERM',16:'ISET',17:'EP'})
two('R5','8.66k 1%','CHG_ISET','GND',(61.5,12.2),'Power',note='About 103 mA nominal future charge; within TI ISET resistor range including tolerance. Battery/NTC DNP first batch.')
two('R6','1.62k 1%','CHG_ILIM','GND',(61.5,10.1),'Power',note='0.994A nominal; 0.917..1.073A for TI KILIM and resistor corners. EN1 always low.')
two('R7','10k','USB_LIMITED','3V3',(50,14.2),'USB',note='OUT1 high = default/unattached; low = 1.5A/3A. GPIO6 reads this directly.')
two('R8','10k','CHG_N','3V3',(55,11.4),'Power')
two('R9','10k','PGOOD_N','3V3',(55,13.5),'Power')
two('C2','10uF 10V X5R','BAT','GND',(59.5,15),'Power','C_0805')
two('C3','22uF 10V X5R','VSYS','GND',(55.3,16.1),'Power','C_0805')
add('J2','1S protected LiPo','JST_PH',{1:'BAT',2:'GND'},(62,17),'Power','S2B-PH-K-S(LF)(SN)',
    'DNP first assembly. Pin 1 BAT+; pin 2 GND. Verify mating battery cable polarity.',90,True,names={1:'BAT+',2:'GND'})
add('J3','CELL NTC 10k','Header_1x02',{1:'BAT_TS',2:'GND'},(63,23.5),'Power','',
    'DNP first assembly. External 10k NTC bonded to the battery. Open TS inhibits charging.',90,True,names={1:'TS',2:'GND'})
add('U4','TPS63031DSKR','TPS63031_DSK10',
    {1:'3V3',2:'SW_L2',3:'GND',4:'SW_L1',5:'VSYS',6:'TPS_EN',7:'VSYS',8:'VSYS',9:'GND',10:'3V3',11:'GND'},
    (58,22),'Power','TPS63031DSKR','3.3 V buck-boost; PS/SYNC high for fixed-frequency operation',
    names={1:'VOUT',2:'L2',3:'PGND',4:'L1',5:'VIN',6:'EN',7:'PS_SYNC',8:'VINA',9:'GND',10:'FB',11:'EP'})
two('L3','1.5uH 20%','SW_L1','SW_L2',(61.5,21.5),'Power','Coilcraft_LPS3015',
    'LPS3015-152MRC',note='DCR max 0.100ohm; Isat 2.2A at 10% reduction; Irms 1.3A at 20C rise; height max 1.5mm')
two('C4','22uF 10V X5R','VSYS','GND',(55.2,20),'Power','C_0805',note='Guarded exact-part DC-bias screening: >=4.7uF effective input capacitance; typical curves require physical verification.')
two('C5','100nF 10V X7R','VSYS','GND',(57.5,19),'Power')
two('C6','22uF 10V X5R','3V3','GND',(55.2,23),'Power','C_0805',note='Fitted single output capacitor; guarded effective-capacitance screening >=5.9uF. Conditional minimum/maximum-capacitance simulations pass; bench check required.')
two('C7','22uF 10V X5R','3V3','GND',(55.2,25.2),'Power','C_0805',note='DNP minimum-cost first assembly; reserved second output capacitor. Requires R12=47k reset-delay remedy. Same exact MPN as C3/C4/C6 if later fitted.',dnp=True)
two('R10','220k 1%','BAT','BAT_ADC',(63,19.5),'Power')
two('R11','100k 1%','BAT_ADC','GND',(63,21.5),'Power')
two('C8','100nF 10V X7R','BAT_ADC','GND',(60,25.5),'Power')
two('R26','150k 1%','VSYS','TPS_EN',(51,18),'Power',
    note='RC holds converter off while VSYS capacitors charge at USB100 current limit')
two('C36','1uF 16V X7R','TPS_EN','GND',(51,20),'Power',
    mpn='C0603C105K4RACTU',note='Enable delay; screen effective capacitance 0.4..1.2uF at VSYS voltage')
add('D4','BAV199-7-F','SOT23',{1:'TPS_EN',2:None,3:'VSYS'},(51,10),'Power','BAV199-7-F',
    'First diode anode pin 1 TPS_EN, cathode/common pin 3 VSYS; pin 2 open. Low leakage preserves enable delay at high temperature.',
    names={1:'A1',2:'K2_NC',3:'K1_A2'})

# Full physical ESP32-C3-MINI-1 pin map, including NCs and ground pads.
c3names={str(i):'NC' for i in range(1,54)}
for i in [1,2,11,14,*range(36,54)]:c3names[str(i)]='GND'
for i,n in {3:'3V3',5:'IO2',6:'IO3',8:'EN',12:'IO0',13:'IO1',16:'IO10',18:'IO4',19:'IO5',20:'IO6',
            21:'IO7',22:'IO8',23:'IO9',26:'IO18_USB_DM',27:'IO19_USB_DP',30:'RXD0',31:'TXD0'}.items():c3names[str(i)]=n
c3nets={i:('GND' if n=='GND' else None) for i,n in c3names.items()}
for i,n in {3:'3V3',5:'BOOT_IO2',6:'LED_AMBER',8:'ESP_EN',12:'BAT_ADC',13:'LED_GREEN',16:'LED_RED',
            18:'NFC_SDA',19:'NFC_SCL',20:'USB_LIMITED',21:'NFC_RESET_N',22:'BOOT_IO8',23:'BOOT_IO9',
            26:'MCU_USB_DM',27:'MCU_USB_DP',30:'UART_RX',31:'UART_TX'}.items():c3nets[str(i)]=n
add('U1','ESP32-C3-MINI-1-N4X','ESP32-C3-MINI-1',c3nets,(54.8,35.9),'MCU',
    'ESP32-C3-MINI-1-N4X','Recommended rev1.1 module; requires supported ESP-IDF/recompiled firmware. Antenna over PCB notch within case.',180,names=c3names)
two('R12','47k 1%','ESP_EN','3V3',(47,31),'MCU',mpn='RC0603FR-0747KL',note='Longer ESP32 reset delay screens low-current USB cold start with upper-bound whole-rail capacitance. Conditional modeled remedy; physical attach/replug check required.')
two('C9','1uF 16V X7R','ESP_EN','GND',(47,33.5),'MCU',mpn='C0603C105K4RACTU')
two('R13','10k','BOOT_IO2','3V3',(47,28.5),'MCU')
two('R14','10k','BOOT_IO8','3V3',(62.7,31),'MCU')
two('R15','10k','BOOT_IO9','3V3',(62.7,33.5),'MCU')
add('SW1','RESET','TL3701',{1:'ESP_EN',2:'ESP_EN',3:'GND',4:'GND'},(34.5,3),'MCU',
    'TL3701AF100QG',names={1:'EN',2:'EN',3:'GND',4:'GND'})
add('SW2','BOOT','TL3701',{1:'BOOT_IO9',2:'BOOT_IO9',3:'GND',4:'GND'},(38.75,3),'MCU',
    'TL3701AF100QG',names={1:'IO9',2:'IO9',3:'GND',4:'GND'})
two('C10','10uF 10V X5R','3V3','GND',(63,36.2),'MCU','C_0805')
two('C11','100nF 10V X7R','3V3','GND',(63,37.9),'MCU')
add('J4','UART recovery','Header_1x06', {1:'GND',2:'3V3',3:'UART_TX',4:'UART_RX',5:'ESP_EN',6:'BOOT_IO9'},
    (36,7.8),'MCU','', 'Unpopulated 1.27 mm recovery header',90,True,names={1:'GND',2:'3V3',3:'TX',4:'RX',5:'EN',6:'BOOT'})
for ref,color,pin,x,res in [('D1','GREEN','LED_GREEN',10.7,'R16'),('D2','AMBER','LED_AMBER',20.7,'R17'),('D3','RED','LED_RED',30.7,'R18')]:
    two(res,'1k',pin,ref+'_ANODE',(x,7.4),'Indicators')
    add(ref,color+' LED','LED_0805',{1:'GND',2:ref+'_ANODE'},(x,4.2),'Indicators',
        {'D1':'APT2012SGC','D2':'APT2012SECK','D3':'APT2012SURCK'}[ref],
        'Top-emitting 0805; 3 mm light pipe / holder selection pending',names={1:'K',2:'A'})

# PN532: VSYS supplies VBAT; its internal DVDD output feeds AVDD and TVDD.
pnnames=['DVSS','LOADMOD','TVSS1','TX1','TVDD','TX2','TVSS2','AVDD','VMID','RX','AVSS','AUX1','AUX2',
         'OSCIN','OSCOUT','I0','I1','TESTEN','P35','NC','NC','NC','PVDD','P30','IRQ','RSTOUT_N','SCL','SDA',
         'MISO','SCK','P31','P32','P33','P34','SIGOUT','SIGIN','SVDD','RSTPD_N','DVDD','VBAT','EP']
pn={i:None for i in range(1,42)}
pn.update({1:'GND',3:'GND',4:'NFC_TX1',5:'PN3V',6:'NFC_TX2',7:'GND',8:'PN3V',9:'NFC_VMID',10:'NFC_RX',11:'GND',
           14:'NFC_OSCIN',15:'NFC_OSCOUT',16:'PN3V',17:'GND',18:'GND',23:'3V3',25:'NFC_IRQ',26:'NFC_RSTOUT',
           27:'NFC_SCL',28:'NFC_SDA',37:'NFC_SVDD',38:'NFC_RESET_N',39:'PN3V',40:'NFC_VBAT',41:'GND'})
add('U2','PN5321A3HN/C1','HVQFN40',pn,(40.8,25),'NFC','PN5321A3HN/C106,55',
    'I0 tied to internal PN3V; I1 and TESTEN grounded. PN532 is NRND.',names={i+1:n for i,n in enumerate(pnnames)})
two('FB1','600R@100MHz 500mA','VSYS','NFC_VBAT',(46.8,18.5),'NFC','C_0603',
    mpn='BLM18AG601SN1D',note='DCR max 0.38ohm at 25C / 0.48ohm at 85C; current rating 500mA')
two('C12','4.7uF 10V X5R','NFC_VBAT','GND',(44.8,20.5),'NFC','C_0805')
two('C13','100nF 10V X7R','NFC_VBAT','GND',(47.5,20.5),'NFC')
two('C14','4.7uF 10V X5R','PN3V','GND',(44.8,23),'NFC','C_0805',note='Place at DVDD pin 39')
two('C15','100nF 10V X7R','PN3V','GND',(44.8,25.5),'NFC',note='Place at DVDD pin 39')
two('C16','4.7uF 10V X5R','PN3V','GND',(37.5,27.5),'NFC','C_0805',note='Place at TVDD pin 5')
two('C17','100nF 10V X7R','PN3V','GND',(40.5,29.5),'NFC',note='Place at TVDD pin 5')
two('C18','100nF 10V X7R','PN3V','GND',(43,29.5),'NFC',note='Place at AVDD pin 8')
two('C19','100nF 10V X7R','3V3','GND',(46,27.4),'NFC',note='Place at PVDD pin 23')
two('C20','100nF 10V X7R','NFC_SVDD','GND',(39,20.5),'NFC')
two('R19','100k 1%','NFC_RESET_N','GND',(41,18),'NFC',note='GPIO7 releases PN532 from power-down only after USB capability is confirmed')
two('C21','100nF 10V X7R','NFC_RESET_N','GND',(43.5,18),'NFC')
two('R20','4.7k','NFC_SDA','3V3',(45.5,14.5),'NFC')
two('R21','4.7k','NFC_SCL','3V3',(45.5,16.5),'NFC')
add('Y1','27.12MHz CL18pF','Crystal_3225',{1:'NFC_OSCIN',2:'GND',3:'NFC_OSCOUT',4:'GND'},
    (41.1,33),'NFC','ABM8-27.120MHZ-D2Y-T','33 pF load capacitors assume about 1.5 pF stray per branch',
    names={1:'XTAL1',2:'CASE',3:'XTAL2',4:'CASE'})
two('C22','33pF C0G 50V','NFC_OSCIN','GND',(38,32.8),'NFC')
two('C23','33pF C0G 50V','NFC_OSCOUT','GND',(44.3,32.8),'NFC')

# Balanced RF network: component-specific passive model sets initial assembly
# values. In-case impedance measurement and NFC tests still determine the tune.
two('L1','560nH 5%','NFC_TX1','RF1_FILTER',(36.5,21.5),'RF','Coilcraft_0603LS',
    '0603LS-561XJRC',note='Coilcraft Document 298 AC model; SRF min 525MHz; Irms 550mA; RDC max 0.44ohm')
two('L2','560nH 5%','NFC_TX2','RF2_FILTER',(36.5,28.5),'RF','Coilcraft_0603LS',
    '0603LS-561XJRC',note='Same part and tolerance as L1; no unreviewed RF substitutions')
two('C24','220pF C0G 50V','RF1_FILTER','GND',(36.5,19.5),'RF')
two('C25','220pF C0G 50V','RF2_FILTER','GND',(36.5,30.6),'RF')
two('C26','68pF C0G 50V','RF1_FILTER','RF1_MATCH',(34.2,21.5),'RF',
    mpn='CC0603JRNPO9BN680',note='Initial series tune from actual filter model; measure on first samples')
two('C27','68pF C0G 50V','RF2_FILTER','RF2_MATCH',(34.2,28.5),'RF',
    mpn='CC0603JRNPO9BN680',note='Match C26; tune both branches together')
two('C28','390pF C0G 50V','RF1_MATCH','GND',(34.2,19.3),'RF',
    mpn='CC0603JRNPO9BN391',note='390pF plus parallel C34 47pF = 437pF nominal shunt')
two('C29','390pF C0G 50V','RF2_MATCH','GND',(34.2,30.6),'RF',
    mpn='CC0603JRNPO9BN391',note='390pF plus parallel C35 47pF = 437pF nominal shunt')
two('R22','1.5R 1% 0.5W','RF1_MATCH','ANT_A',(33.8,23.6),'RF','R_0805',
    'CRCW08051R50FKEAHP',angle=90,note='RF damping; high-power 0805 selected for modeled dissipation; tune both branches together')
two('R23','1.5R 1% 0.5W','RF2_MATCH','ANT_B',(33.8,26.4),'RF','R_0805',
    'CRCW08051R50FKEAHP',angle=90,note='RF damping; match R22')
two('R24','1k','NFC_RX','NFC_VMID',(36,33),'RF')
two('C30','100nF 10V X7R','NFC_VMID','GND',(38,29.5),'RF')
two('C31','1nF C0G 50V','NFC_RX','RF_RX_COUPLED',(35,35.4),'RF')
two('R25','2.7k','RF_RX_COUPLED','RF2_FILTER',(35,37.5),'RF')
two('C34','47pF C0G 50V','RF1_MATCH','GND',(34,14),'RF',
    mpn='CC0603JRNPO9BN470',note='Parallel fine-tuning position; initial assembly 47pF',angle=90)
two('C35','47pF C0G 50V','RF2_MATCH','GND',(36,37.3),'RF',
    mpn='CC0603JRNPO9BN470',note='Parallel fine-tuning position; initial assembly 47pF')
add('ANT1','3-turn PCB NFC loop','NFC_Loop',{1:'ANT_A',2:'ANT_B'},(0,0),'RF','PCB copper',
    '29.4 x 31 mm outer centerline; 0.8 mm trace / 0.5 mm gap; untuned',names={1:'A',2:'B'})
for i,(net,x,y) in enumerate([('3V3',48,25.5),('PN3V',43,21),('NFC_IRQ',45.5,23),('NFC_RSTOUT',45.5,21),
                            ('NFC_RESET_N',42,15.5),('CHG_N',51,14),('PGOOD_N',51,16),('GND',48,23),
                            ('USB_LIMITED',46.5,34.5),('USB_HIGH_CURRENT',46.5,36.5)],1):
    add(f'TP{i}',net,'TestPoint',{1:net},(x,y),'Test',names={1:net})
for i,net,xy in [(11,'ANT_A',(36,26.8)),(12,'ANT_B',(36,28.1)),(13,'GND',(36,35.9))]:
    add(f'TP{i}',net,'TestPoint',{1:net},xy,'RF',note='RF measurement pad: remove R22/R23 to isolate antenna for VNA measurement',names={1:net})

OUTLINE=[(0,0),(3,0),(3,1.6),(11.5,1.6),(11.5,0),(47,0),(47,-2),(60,-2),(60,0),(65.5,0),(65.5,45.2),
         (61.5,45.2),(61.5,38.7),(48.1,38.7),(48.1,45.2),(0,45.2)]
CASE_OFFSET=(1.3,3.8)
COIL=[(32.4,23.8),(32.4,12),(3,12),(3,43),(32.4,43),(32.4,26.2),
      (31.1,26.2),(31.1,13.3),(4.3,13.3),(4.3,41.7),(31.1,41.7),(31.1,27.5),
      (29.8,27.5),(29.8,14.6),(5.6,14.6),(5.6,40.4),(29.8,40.4),(29.8,28.8)]

def fp_header(name): return f'(footprint {q(name)} (version 20221018) (generator pcbnew) (layer "F.Cu") (attr smd)'
def line(a,b,layer='F.Fab',width=.1):
    return f'(fp_line (start {fmt(a[0])} {fmt(a[1])}) (end {fmt(b[0])} {fmt(b[1])}) (stroke (width {width}) (type solid)) (layer {q(layer)}))'
def pad(num,x,y,w,h,typ='smd',drill=None,layers=None):
    layers=layers or ('"*.Cu" "*.Mask"' if typ=='thru_hole' else '"F.Cu" "F.Paste" "F.Mask"')
    return f'(pad {q(num)} {typ} {"circle" if typ=="thru_hole" else "rect"} (at {fmt(x)} {fmt(y)}) (size {w} {h})'+(f' (drill {drill})' if drill else '')+f' (layers {layers}))'
def make_fp(name,pads,box=None,extra='',attr='smd'):
    s=fp_header(name).replace('(attr smd)',f'(attr {attr})')
    s+=f'(fp_text reference "REF**" (at 0 -2.5) (layer "F.SilkS") {effects(.7)})'
    s+=f'(fp_text value {q(name)} (at 0 2.5) (layer "F.Fab") {effects(.7)})'
    if box:
        x,y,w,h=box
        points=[(x,y),(x+w,y),(x+w,y+h),(x,y+h)]
        for a,b in zip(points,points[1:]+points[:1]):s+=line(a,b)
    s+=''.join(pads)+extra+')'
    (LIB/(name+'.kicad_mod')).write_text(s+'\n')

def prepare_footprints():
    # E-Switch drawing N370011 Rev B: 0.80mm lands, 3.60x2.60 outer
    # footprint. Pin 1/2 lower row common; pin 3/4 upper row common.
    make_fp('TL3701',[pad(1,-1.4,.9,.8,.8),pad(2,1.4,.9,.8,.8),
                       pad(3,-1.4,-.9,.8,.8),pad(4,1.4,-.9,.8,.8)],
        (-1.5,-1.3,3,2.6),extra=''.join(line(a,b,'F.CrtYd',.05) for a,b in
        zip([(-2,-1.5),(2,-1.5),(2,1.5),(-2,1.5)],[(2,-1.5),(2,1.5),(-2,1.5),(-2,-1.5)]))+
        '(zone (net 0) (net_name "") (layer "F.Cu") (hatch edge .5) (connect_pads (clearance 0)) (min_thickness .25) (filled_areas_thickness no) (keepout (tracks not_allowed) (vias not_allowed) (pads not_allowed) (copperpour not_allowed) (footprints allowed)) (polygon (pts (xy -.9 -1.3) (xy .9 -1.3) (xy .9 1.3) (xy -.9 1.3))))')
    make_fp('BQ24074_RGT16',
        [pad(i+1,-1.4,-.75+i*.5,.6,.24) for i in range(4)]+
        [pad(i+5,-.75+i*.5,1.4,.24,.6) for i in range(4)]+
        [pad(i+9,1.4,.75-i*.5,.6,.24) for i in range(4)]+
        [pad(i+13,.75-i*.5,-1.4,.24,.6) for i in range(4)]+
        [pad(17,0,0,1.68,1.68,layers='"F.Cu" "F.Mask"')]+
        [pad('',x,y,.7,.7,layers='"F.Paste"') for x in [-.42,.42] for y in [-.42,.42]],(-1.5,-1.5,3,3))
    make_fp('TPS63031_DSK10',
        [pad(i+1,-1.15,-1+i*.5,.6,.25) for i in range(5)]+
        [pad(i+6,1.15,1-i*.5,.6,.25) for i in range(5)]+
        [pad(11,0,0,1.2,2,layers='"F.Cu" "F.Mask"')]+
        [pad('',0,y,1,.8,layers='"F.Paste"') for y in [-.5,.5]],(-1.25,-1.25,2.5,2.5))
    make_fp('Inductor_3x3',[pad(1,-1.1,0,1.2,2.5),pad(2,1.1,0,1.2,2.5)],(-1.5,-1.5,3,3))
    make_fp('Coilcraft_0603LS',[pad(1,-.64,0,.64,1.02),pad(2,.64,0,.64,1.02)],(-.9,-.56,1.8,1.12))
    # Kingbright APT2012 recommended pattern: 1.25 x 1.1 mm lands,
    # 1.1 mm gap; cathode/marked end is physical pin 1.
    make_fp('LED_0805',[pad(1,-1.175,0,1.25,1.1),pad(2,1.175,0,1.25,1.1)],
        (-1,-.625,2,1.25),extra=''.join(line(a,b,'F.CrtYd',.05) for a,b in
        zip([(-2.05,-.875),(2.05,-.875),(2.05,.875),(-2.05,.875)],
            [(2.05,-.875),(2.05,.875),(-2.05,.875),(-2.05,-.875)])))
    make_fp('Switch_3x2',[pad(1,-1.8,0,1,1.4),pad(2,1.8,0,1,1.4)],(-1.5,-1,3,2))
    for n in [2,6]:
        make_fp(f'Header_1x0{n}',[pad(i+1,i*1.27,0,.9,.9,'thru_hole',.5) for i in range(n)],
                (-.6,-.6,(n-1)*1.27+1.2,1.2),attr='through_hole')
    make_fp('TestPoint',[pad(1,0,0,1,1,layers='"F.Cu" "F.Mask"')])
    coil='(net_tie_pad_groups "1,2")'
    coil+=''.join(line(a,b,'F.Cu',.8) for a,b in zip(COIL,COIL[1:]))
    coil+=line(COIL[-1],(33.9,26.2),'B.Cu',.8)
    make_fp('NFC_Loop',[pad(1,*COIL[0],1.1,1.1,layers='"F.Cu" "F.Mask"'),
                       pad(2,*COIL[-1],.8,.8,'thru_hole',.3),
                       pad(2,33.9,26.2,.8,.8,'thru_hole',.3)],extra=coil,attr='through_hole exclude_from_pos_files')

def library(name):
    a=readsex((LIB/(name+'.kicad_mod')).read_text())
    a[0]='footprint'; a[1]=q('Fieldnote:'+name)
    a=[a[0],a[1],*[n for n in a[2:] if not(isinstance(n,list) and n and n[0] in ['version','generator','generator_version','tedit','model','embedded_fonts','duplicate_pad_numbers_are_jumpers'])]]
    for n in list(a[2:]):
        if isinstance(n,list) and n and n[0]=='property':
            field=unq(n[1])
            if field in ['Reference','Value']:
                n[0]='fp_text';n[1]=field.lower()
                hidden=child(n,'hide')
                if hidden:n.remove(hidden);n.append('hide')
            else:a.remove(n)
    for n in a[2:]:
        if isinstance(n,list) and n and n[0] in ['fp_line','fp_circle','fp_arc','fp_poly']:
            old=child(n,'width')
            if old:n.remove(old);n.append(['stroke',['width',old[1]],['type','solid']])
    return a
def transform(x,y,p):
    # KiCad positive rotation is counterclockwise in board coordinates (+Y down).
    r=math.radians(p['angle']); return (p['xy'][0]+x*math.cos(r)+y*math.sin(r),
                                      p['xy'][1]-x*math.sin(r)+y*math.cos(r))

def placement_bounds(p):
    """Conservative pad/body/courtyard rectangle, in board coordinates."""
    f=library(p['fp']);points=[]
    for a in children(f,'pad'):
        if not unq(a[1]):continue
        at=child(a,'at');sz=child(a,'size');x,y=transform(float(at[1]),float(at[2]),p)
        t=math.radians(p['angle']+(float(at[3]) if len(at)>3 else 0))
        w,h=float(sz[1])/2,float(sz[2])/2
        hx=abs(math.cos(t))*w+abs(math.sin(t))*h
        hy=abs(math.sin(t))*w+abs(math.cos(t))*h
        points.extend([(x-hx,y-hy),(x+hx,y+hy)])
    for a in children(f,'fp_line'):
        la=child(a,'layer')
        if la and unq(la[1]) in ['F.Fab','F.CrtYd']:
            for key in ['start','end']:
                pt=child(a,key);points.append(transform(float(pt[1]),float(pt[2]),p))
    return [min(v[0] for v in points),min(v[1] for v in points),max(v[0] for v in points),max(v[1] for v in points)]

def lock_passives():
    # These exact parts need PCBWay sourcing confirmation before release.
    resistors={'887k':'887K','100k':'100K','22R':'22R','8.66k':'8K66','1.62k':'1K62',
               '10k':'10K','220k':'220K','150k':'150K','1k':'1K','4.7k':'4K7','2.7k':'2K7'}
    capacitors={'100nF':('100nF 50V X7R','CC0603KRX7R9BB104'),
                '10uF':('10uF 16V X5R','CL21A106KOCLRNC'),
                '4.7uF':('4.7uF 16V X5R','CL21A475KOFNNNE'),
                '22uF':('22uF 10V X5R','C0805C226M8PACTU'),
                '33pF':('33pF C0G 50V','CC0603JRNPO9BN330'),
                '220pF':('220pF C0G 50V','CC0603JRNPO9BN221'),
                '1nF':('1nF C0G 50V','CC0603JRNPO9BN102')}
    for p in PARTS:
        v=p['value'].split()[0]
        if not p['mpn'] and p['ref'].startswith('R'):
            p['mpn']='RC0603FR-07'+resistors[v]+'L'
        if not p['mpn'] and p['ref'].startswith('C') and v in capacitors:
            p['value'],p['mpn']=capacitors[v]

def load_placement():
    path=ROOT/'placement-lock.json'
    if path.exists():
        locked=json.loads(path.read_text())
        for p in PARTS:
            if p['ref'] in locked:
                p['xy']=locked[p['ref']]['xy'];p['angle']=locked[p['ref']]['angle']

def symbol_def(p):
    name=p['ref']; keys=list(p['nets']); n=len(keys)
    two_terminal=n==2
    half=2.54 if n<=2 else (25.4 if n>20 else 12.7)
    per=(n+1)//2
    height=2.54 if n<=2 else max(5.08,(per+1)*2.54/2)
    pins=[]
    if two_terminal:
        for j,k in enumerate(keys):pins.append((k,-5.08 if j==0 else 5.08,0,0 if j==0 else 180))
    else:
        for j,k in enumerate(keys):
            side=j//per; row=j%per; y=(per-1)*1.27-row*2.54
            pins.append((k,-half-5.08 if side==0 else half+5.08,y,0 if side==0 else 180))
    inbom='no' if p['ref'].startswith('TP') or (p['ref'] in ['ANT1'] or p['ref'].startswith('JP')) else 'yes'
    s=f'(symbol {q(name)} (pin_names (offset .508)) (in_bom {inbom}) (on_board yes)'
    s+=f'(property "Reference" {q(p["ref"])} (at 0 {fmt(height+3)} 0) {effects(1.27)})'
    s+=f'(property "Value" {q(p["value"])} (at 0 {fmt(-height-3)} 0) {effects(1.27)})'
    s+=f'(property "Footprint" {q("Fieldnote:"+p["fp"])} (at 0 0 0) {effects(1,True)})'
    s+=f'(symbol {q(name+"_0_1")} (rectangle (start {-half} {height}) (end {half} {-height}) (stroke (width .254) (type default)) (fill (type background))))'
    s+=f'(symbol {q(name+"_1_1")} '
    for k,x,y,ang in pins:
        pinname=p['names'].get(k,k)
        typ='no_connect' if p['nets'][k] is None else 'passive'
        if typ != 'no_connect':
            if p.get('pin_types'):
                typ=p['pin_types'].get(k,'passive')
            elif p['ref']=='U1':
                typ='power_in' if pinname in ['GND','3V3'] else ('input' if pinname in ['EN','RXD0'] else ('output' if pinname=='TXD0' else 'bidirectional'))
            elif p['ref']=='U2':
                typ=p.get('pin_types',{}).get(k,'passive')
            elif p.get('pin_types'):
                typ=p['pin_types'].get(k,'passive')
            elif p['ref']=='U3':
                typ='power_in' if k in ['8','13','17'] else ('power_out' if k=='10' else ('open_collector' if k in ['7','9'] else ('passive' if k in ['2','3','11','16'] else 'input')))
            elif p['ref']=='U4':
                typ='power_in' if k in ['3','5','8','9','11'] else ('power_out' if k=='1' else ('passive' if k in ['2','4'] else 'input'))
            elif p['ref']=='U6':
                typ='power_in' if k in ['10','12'] else ('open_collector' if k=='7' else ('bidirectional' if k in ['1','2'] else 'input'))
            elif p['ref']=='U7':
                typ='power_in' if k in ['3','5'] else ('output' if k=='4' else 'input')
        s+=f'(pin {typ} line (at {fmt(x)} {fmt(y)} {ang}) (length {2.54 if two_terminal else 5.08}) (name {q(pinname)} {effects(.9)}) (number {q(k)} {effects(.9)}))'
    s+='))'
    return s,pins,height

ROOT_UUID=uid('root')
SHEET_GROUPS=[('usb-power',['USB','Power']),('esp32-leds',['MCU','Indicators']),('pn7160',['NFC','Test']),('nfc-rf',['RF'])]
def schematic():
    symbols={p['ref']:symbol_def(p) for p in PARTS}
    flag='(symbol "Fieldnote:PWR_FLAG" (pin_names (offset 0) hide) (in_bom no) (on_board no) (property "Reference" "#FLG" (at 0 2.54 0) (effects (font (size 1 1)) hide)) (property "Value" "PWR_FLAG" (at 0 5.08 0) (effects (font (size 1 1)) hide)) (symbol "PWR_FLAG_0_1" (polyline (pts (xy 0 0) (xy -1.27 1.27) (xy 0 2.54) (xy 1.27 1.27) (xy 0 0)) (stroke (width .254) (type default)) (fill (type none)))) (symbol "PWR_FLAG_1_1" (pin power_out line (at 0 0 90) (length 0) (name "pwr" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1)))))))'
    library_file='(kicad_symbol_lib (version 20220914) (generator kicad_symbol_editor) '+''.join(v[0] for v in symbols.values())+flag.replace('Fieldnote:PWR_FLAG','PWR_FLAG',1)+')'
    (ROOT/'Fieldnote.kicad_sym').write_text(library_file+'\n')
    root=f'(kicad_sch (version 20230121) (generator eeschema) (uuid {ROOT_UUID}) (paper "A3") (title_block (title "Fieldnote PN7160 NFC reader") (date "2026-10-03") (rev "0.3")) (lib_symbols '+flag+')'
    for j,(tag,groups) in enumerate(SHEET_GROUPS):
        su=uid('sheet'+tag); pageuuid=uid('page'+tag)
        x=40+(j%2)*180;y=50+(j//2)*90
        root+=f'(sheet (at {x} {y}) (size 140 55) (fields_autoplaced) (stroke (width .254) (type default)) (fill (color 0 0 0 0)) (uuid {su})'
        root+=f'(property "Sheetname" {q(tag)} (at {x} {y-2} 0) {effects(1.5)})'
        root+=f'(property "Sheetfile" {q(tag+".kicad_sch")} (at {x} {y+57} 0) {effects(1.27)})'
        root+=f'(instances (project "fieldnote-interface" (path {q("/"+ROOT_UUID)} (page {q(j+2)})))))'
        selected=[p for p in PARTS if p['group'] in groups]
        doc=f'(kicad_sch (version 20230121) (generator eeschema) (uuid {pageuuid}) (paper "A3") (title_block (title {q(tag)}) (date "2026-10-03") (rev "0.3")) (lib_symbols '+''.join(symbols[p['ref']][0].replace('(symbol '+q(p['ref']), '(symbol '+q('Fieldnote:'+p['ref']),1) for p in selected)+')'
        doc+=f'(text "GLOBAL LABELS CONNECT ACROSS SHEETS. PN7160 variant; native checks in output, hardware qualification pending." (at 15 15 0) {effects(1.5,just="left")} (uuid {uid(tag+"note")}))'
        big=[p for p in selected if len(p['nets'])>20]
        small=[p for p in selected if p not in big]
        locs={p['ref']:(90+140*i,75) for i,p in enumerate(big)}
        row_top=130 if big else 35
        for first in range(0,len(small),5):
            row=small[first:first+5];hmax=max(symbols[p['ref']][2] for p in row)
            center=row_top+hmax+5
            for i,p in enumerate(row):locs[p['ref']]=(42+i*78,center)
            row_top+=2*hmax+14
        for p in selected:
            inbom='no' if p['ref'].startswith('TP') or (p['ref'] in ['ANT1'] or p['ref'].startswith('JP')) else 'yes'
            x,y=map(snap,locs[p['ref']]); definition,pins,h=symbols[p['ref']]
            # Pin endpoints carry a global label or an explicit NC marker.
            for k,px,py,ang in pins:
                ex,ey=x+px,y-py;net=p['nets'][k]
                if net is None:doc+=f'(no_connect (at {fmt(ex)} {fmt(ey)}) (uuid {uid(tag+p["ref"]+k+"nc")}))';continue
                dx=-7.62 if px<0 else 7.62
                end=ex+dx
                doc+=f'(wire (pts (xy {fmt(ex)} {fmt(ey)}) (xy {fmt(end)} {fmt(ey)})) (stroke (width 0) (type default)) (uuid {uid(tag+p["ref"]+k+"wire")}))'
                doc+=f'(global_label {q(net)} (shape input) (at {fmt(end)} {fmt(ey)} {0 if dx<0 else 180}) {effects(.85,just="right" if dx<0 else "left")} (uuid {uid(tag+p["ref"]+k+"label")}))'
            pu=uid(p['ref'])
            doc+=f'(symbol (lib_id {q("Fieldnote:"+p["ref"])}) (at {x} {y} 0) (unit 1) (in_bom {inbom}) (on_board yes) (dnp {"yes" if p["dnp"] else "no"}) (uuid {pu})'
            doc+=f'(property "Reference" {q(p["ref"])} (at {x} {fmt(y-h-2)} 0) {effects(1.27)})'
            doc+=f'(property "Value" {q(p["value"])} (at {x} {fmt(y+h+2)} 0) {effects(1.0)})'
            doc+=f'(property "Footprint" {q("Fieldnote:"+p["fp"])} (at {x} {y} 0) {effects(1,True)})'
            doc+=f'(property "MPN" {q(p["mpn"])} (at {x} {y} 0) {effects(1,True)})'
            for k,*_ in pins:doc+=f'(pin {q(k)} (uuid {uid("pin:"+p["ref"]+":"+k)}))'
            doc+=f'(instances (project "fieldnote-interface" (path {q("/"+ROOT_UUID+"/"+su)} (reference {q(p["ref"])}) (unit 1)))))'
        doc+=')';readsex(doc);(ROOT/(tag+'.kicad_sch')).write_text(doc+'\n')
    for i,net in enumerate(FLAG_NETS):
        x=snap(70+i*100);y=snap(225);ref=f'#FLG0{i+1}'
        root+=f'(symbol (lib_id "Fieldnote:PWR_FLAG") (at {x} {y} 0) (unit 1) (in_bom no) (on_board no) (dnp no) (uuid {uid(ref)}) (property "Reference" {q(ref)} (at {x} {y-3} 0) {effects(1,True)}) (property "Value" "PWR_FLAG" (at {x} {y-5} 0) {effects(1,True)}) (pin "1" (uuid {uid(ref+"pin")})) (instances (project "fieldnote-interface" (path {q("/"+ROOT_UUID)} (reference {q(ref)}) (unit 1)))))'
        root+=f'(global_label {q(net)} (shape input) (at {x} {y} 0) {effects(1,just="right")} (uuid {uid(net+"flaglabel")}))'
    note='65.5 x 47.2 mm including USB tongue; V17 case target 68.1 x 50.5 x 10 mm.\n3 LEDs, 1S LiPo connector, charger and power path, ESP32-C3, PN7160, PCB NFC antenna.\nENGINEERING VARIANT: native validation tracked in output; bench RF and power qualification required.'
    root+=f'(text {q(note)} (at 40 245 0) {effects(1.5,just="left")} (uuid {uid("rootnote")}))'
    root+=f'(sheet_instances (path "/" (page "1"))))';readsex(root);(ROOT/'fieldnote-interface.kicad_sch').write_text(root+'\n')

def board():
    # KiCad represents explicit schematic NC pins as singleton nets. Carry
    # those exact native names into the PCB so parity distinguishes NCs from
    # missing assignments without connecting them to other circuitry.
    native={}
    for p in PARTS:
        for k,n in p['nets'].items():
            label=p['names'].get(k,k)
            native[p['ref'],k]=n or ('unconnected-('+p['ref']+'-'+
                ('' if label==k else label+'-')+'Pad'+k+')')
    nets=sorted(set(native.values()))
    netids={n:i+1 for i,n in enumerate(nets)}
    s='(kicad_pcb (version 20221018) (generator pcbnew) (general (thickness 1.6)) (paper "A3")'
    s+='(layers (0 "F.Cu" signal) (1 "In1.Cu" power) (2 "In2.Cu" signal) (31 "B.Cu" signal) (32 "B.Adhes" user "B.Adhesive") (33 "F.Adhes" user "F.Adhesive") (34 "B.Paste" user) (35 "F.Paste" user) (36 "B.SilkS" user "B.Silkscreen") (37 "F.SilkS" user "F.Silkscreen") (38 "B.Mask" user) (39 "F.Mask" user) (40 "Dwgs.User" user "User.Drawings") (41 "Cmts.User" user "User.Comments") (44 "Edge.Cuts" user) (46 "B.CrtYd" user "B.Courtyard") (47 "F.CrtYd" user "F.Courtyard") (48 "B.Fab" user) (49 "F.Fab" user))'
    s+='(setup (pad_to_mask_clearance 0)) (net 0 "")'
    s+=''.join(f'(net {i} {q(n)})' for n,i in netids.items())
    pads=[]
    for p in PARTS:
        f=library(p['fp']);f.insert(2,['at',fmt(60+p['xy'][0]),fmt(50+p['xy'][1]),fmt(p['angle'])])
        f.insert(3,['tstamp',uid(p['ref'])]);
        if p['dnp']:
            attr=child(f,'attr')
            if attr is None:f.append(['attr','dnp'])
            else:attr.append('dnp')
        if p['ref'].startswith('TP') or (p['ref'] in ['ANT1'] or p['ref'].startswith('JP')):
            attr=child(f,'attr')
            if attr is None:f.append(['attr','exclude_from_pos_files','exclude_from_bom'])
            else:attr.extend(['exclude_from_pos_files','exclude_from_bom'])
        def reidentify(node,trail=''):
            for i,a in enumerate(node):
                if isinstance(a,list):
                    if a and a[0] in ['tstamp','uuid']:a[1]=uid(p['ref']+trail+str(i))
                    else:reidentify(a,trail+'/'+str(i))
        reidentify(f)
        child(f,'tstamp')[1]=uid(p['ref'])
        group=next(tag for tag,groups in SHEET_GROUPS if p['group'] in groups)
        f.append(['path',q('/'+ROOT_UUID+'/'+uid('sheet'+group)+'/'+uid(p['ref']))])
        for t in children(f,'fp_text'):
            if t[1]=='reference':t[2]=q(p['ref'])
            if t[1]=='value':t[2]=q(p['value'])
        for a in children(f,'pad'):
            k=unq(a[1]); n=native.get((p['ref'],k))
            at=child(a,'at')
            rotation=p['angle']+(float(at[3]) if len(at)>3 else 0)
            if len(at)>3:at[3]=fmt(rotation%360)
            elif rotation:at.append(fmt(rotation%360))
            if n:a.append(['net',str(netids[n]),q(n)])
            if k:
                at=child(a,'at');sz=child(a,'size');xx,yy=transform(float(at[1]),float(at[2]),p)
                pads.append(dict(ref=p['ref'],pin=k,net=n,x=xx,y=yy,size=[float(sz[1]),float(sz[2])]))
        s+=sx(f)
    for a,b in zip(OUTLINE,OUTLINE[1:]+OUTLINE[:1]):
        s+=f'(gr_line (start {fmt(60+a[0])} {fmt(50+a[1])}) (end {fmt(60+b[0])} {fmt(50+b[1])}) (stroke (width .05) (type default)) (layer "Edge.Cuts") (tstamp {uid(str(a)+str(b))}))'
    for name,points in [('NFC copper-free region',[(1.5,10.7),(33.1,10.7),(33.1,22.8),(31.8,22.8),
                                                 (31.8,24.8),(33.1,24.8),(33.1,45.2),(1.5,45.2)]),
                        ('Wi-Fi antenna clearance',[(33.1,38.7),(65.5,38.7),(65.5,45.2),(33.1,45.2)])]:
        s+=f'(zone (net 0) (net_name "") (layers "F.Cu" "In1.Cu" "In2.Cu" "B.Cu") (tstamp {uid(name)}) (name {q(name)}) (hatch edge .5) (connect_pads (clearance 0)) (min_thickness .25) (filled_areas_thickness no) (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (fill (thermal_gap .3) (thermal_bridge_width .3)) (polygon (pts '+''.join(f'(xy {fmt(60+x)} {fmt(50+y)})' for x,y in points)+')))'
    for txt,x,y in [('FIELDNOTE v0.2 - UNROUTED REVIEW DRAFT',66,99),('G',70.7,51.2),('A',80.7,51.2),('R',90.7,51.2)]:
        s+=f'(gr_text {q(txt)} (at {x} {y}) (layer "Dwgs.User") {effects(.85)} (tstamp {uid(txt)}))'
    s+=')';readsex(s);(ROOT/'fieldnote.kicad_pcb').write_text(s+'\n')
    return pads

def point_inside(x,y,poly):
    result=False
    for a,b in zip(poly,poly[1:]+poly[:1]):
        if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:result=not result
    return result
def mechanical_check():
    # Exact cross sections of the supplied V17 bottom STL at three board heights.
    path=ROOT/'references'/'Box_V17_BRACED_PETG.stl'
    data=path.read_bytes();count=struct.unpack_from('<I',data,80)[0];assert len(data)==84+50*count
    triangles=[struct.unpack_from('<12f',data,84+i*50)[3:] for i in range(count)]
    violations=[]
    for z in [.801,1.6,2.399]:
        for j,t in enumerate(triangles):
            vs=[t[0:3],t[3:6],t[6:9]];hits=[]
            for a,b in zip(vs,vs[1:]+vs[:1]):
                if (a[2]>z)!=(b[2]>z):
                    f=(z-a[2])/(b[2]-a[2]);hits.append((a[0]+f*(b[0]-a[0]),a[1]+f*(b[1]-a[1])))
            if len(hits)==2:
                for f in [0,.25,.5,.75,1]:
                    x=hits[0][0]*(1-f)+hits[1][0]*f-CASE_OFFSET[0]
                    y=hits[0][1]*(1-f)+hits[1][1]*f-CASE_OFFSET[1]
                    if point_inside(x,y,OUTLINE):violations.append(dict(z=z,triangle=j,x=x,y=y));break
    assert not violations, 'V17 base intersects proposed bare PCB plane: '+str(violations[:5])
    return dict(source=str(path),method='Binary-STL cross-section boundary samples at 0.801, 1.6, 2.399 mm',
                bare_pcb_bottom_z_mm=.8,bare_pcb_top_z_mm=2.4,base_section_collisions=len(violations),
                limit='Sampled bare-board clearance only; not an exact solid collision check or complete component/cable/battery fit proof')

def validate(pads):
    errors=[]
    for p in PARTS:
        physical={unq(a[1]) for a in children(library(p['fp']),'pad') if unq(a[1])}
        if physical != set(p['nets']):errors.append((p['ref'],'symbol/footprint pins differ',sorted(physical-set(p['nets'])),sorted(set(p['nets'])-physical)))
    assert not errors, errors
    byref={p['ref']:p for p in PARTS}
    assert byref['U1']['nets']['18']=='NFC_SDA' and byref['U1']['nets']['19']=='NFC_SCL'
    assert byref['U2']['nets']['16']=='PN3V' and byref['U2']['nets']['17']=='GND'
    assert byref['U2']['nets']['18']=='GND' and byref['U2']['nets']['39']=='PN3V'
    assert byref['U2']['nets']['5']=='PN3V' and byref['U2']['nets']['8']=='PN3V'
    assert byref['U2']['nets']['23']=='3V3' and byref['U2']['nets']['40']=='NFC_VBAT'
    assert byref['U3']['nets']['14'] is None and byref['U3']['nets']['15'] is None
    assert byref['U3']['nets']['6']=='GND' and byref['U3']['nets']['5']=='USB_HIGH_CURRENT'
    assert byref['U6']['nets']['3']=='GND' and byref['U6']['nets']['5'] is None
    assert byref['U6']['nets']['12']=='3V3' and byref['U6']['nets']['7']=='USB_LIMITED'
    assert byref['U1']['nets']['20']=='USB_LIMITED' and byref['U1']['nets']['21']=='NFC_RESET_N'
    assert byref['U4']['nets']['10']=='3V3'
    for i,x in enumerate([12,22,32],1):
        p=byref['D'+str(i)];assert abs(p['xy'][0]+CASE_OFFSET[0]-x)<1e-8
        assert abs(p['xy'][1]+CASE_OFFSET[1]-8)<1e-8
    singleton=collections.defaultdict(list)
    for p in PARTS:
        for k,n in p['nets'].items():
            if n:singleton[n].append((p['ref'],k))
    assert all(len(v)>1 for v in singleton.values()), {k:v for k,v in singleton.items() if len(v)<2}
    bounds={p['ref']:placement_bounds(p) for p in PARTS if p['ref']!='ANT1'}
    overlaps=[]
    for i,(ref,a) in enumerate(bounds.items()):
        for other,b in list(bounds.items())[i+1:]:
            if min(a[2],b[2])>max(a[0],b[0])+.001 and min(a[3],b[3])>max(a[1],b[1])+.001:overlaps.append([ref,other])
    assert not overlaps, 'Pad/body/courtyard rectangle overlaps: '+str(overlaps)
    result=dict(status='DRAFT - electrical topology / mechanical samples checked; CAD ERC/DRC and routing pending',
                components=len(PARTS),nets=len(singleton),pin_pad_map='PASS',firmware_i2c_map='PASS',
                pn532_supply_domain_separation='PASS',pn532_i2c_straps='PASS',led_case_alignment='PASS',
                conservative_placement_rectangle_overlaps=len(overlaps),
                mechanical=mechanical_check(),board_routed=False,ERC='NOT RUN',DRC='NOT RUN',antenna_tuned=False)
    (OUT/'validation.json').write_text(json.dumps(result,indent=2)+'\n')
    return result

def write_tables(pads):
    (ROOT/'design-data.json').write_text(json.dumps(dict(parts=PARTS,outline=OUTLINE,case_offset=CASE_OFFSET,coil=COIL),indent=2)+'\n')
    for name,fields,rows in [
        ('BOM.csv',['ref','value','mpn','fp','dnp','note'],PARTS),
        ('placement.csv',['ref','value','x_mm','y_mm','rotation_deg'],[dict(ref=p['ref'],value=p['value'],x_mm=p['xy'][0],y_mm=p['xy'][1],rotation_deg=p['angle']) for p in PARTS]),
        ('pin-net-map.csv',['ref','pin','name','net'],[dict(ref=p['ref'],pin=k,name=p['names'].get(k,k),net=n or 'NC') for p in PARTS for k,n in p['nets'].items()])]:
        with (OUT/name).open('w',newline='') as f:
            w=csv.DictWriter(f,fields,extrasaction='ignore');w.writeheader();w.writerows(rows)
    dxf='0\nSECTION\n2\nENTITIES\n'
    for a,b in zip(OUTLINE,OUTLINE[1:]+OUTLINE[:1]):dxf+=f'0\nLINE\n8\nBOARD\n10\n{a[0]}\n20\n{a[1]}\n30\n0\n11\n{b[0]}\n21\n{b[1]}\n31\n0\n'
    for x in [10.7,20.7,30.7]:dxf+=f'0\nCIRCLE\n8\nLED_CENTERS\n10\n{x}\n20\n4.2\n30\n0\n40\n1.65\n'
    dxf+='0\nENDSEC\n0\nEOF\n';(OUT/'board-outline.dxf').write_text(dxf)

def main():
    raise RuntimeError('Use integrate_pn7160.py for this separate variant. Legacy PN532 main() must not regenerate or overwrite native routed CAD.')
    existing=ROOT/'fieldnote.kicad_pcb'
    if existing.exists() and re.search(r'\((?:segment|via)\s',existing.read_text()):
        raise RuntimeError('Routed native CAD exists. main() would destroy routing; use selective schematic/table refresh or generate in a separate directory.')
    OUT.mkdir(exist_ok=True);prepare_footprints();lock_passives();load_placement();schematic();pads=board();write_tables(pads);result=validate(pads)
    (ROOT/'fp-lib-table').write_text('(fp_lib_table (lib (name "Fieldnote") (type "KiCad") (uri "${KIPRJMOD}/Fieldnote.pretty") (options "") (descr "Local project footprints")))\n')
    (ROOT/'sym-lib-table').write_text('(sym_lib_table (lib (name "Fieldnote") (type "KiCad") (uri "${KIPRJMOD}/Fieldnote.kicad_sym") (options "") (descr "Project circuit symbols")))\n')
    (ROOT/'fieldnote.kicad_pro').write_text(json.dumps(dict(meta=dict(filename='fieldnote.kicad_pro',version=1),
        board=dict(design_settings=dict(rules=dict(min_clearance=.15,min_track_width=.15,
            min_copper_edge_clearance=.25,min_via_diameter=.6,min_through_hole_diameter=.3,
            min_hole_clearance=.25,min_silk_text_height=.8))),
        net_settings=dict(classes=[dict(name='Default',clearance=.15,track_width=.2,via_diameter=.6,via_drill=.3,
                                       diff_pair_width=.2,diff_pair_gap=.15,diff_pair_via_gap=.25)])),indent=2)+'\n')
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
