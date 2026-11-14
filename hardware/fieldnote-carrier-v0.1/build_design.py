#!/usr/bin/env python3
"""Generate a passive carrier review candidate. Socket geometry is NOT verified.

The assumed narrow 30-pin ESP32 pattern is intentionally separate from the
existing integrated designs. No fabrication export is made by this generator.
"""
from pathlib import Path
import json, uuid, csv, re

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'
LIB = ROOT / 'Carrier.pretty'
NS = uuid.UUID('ccf5a474-9bc8-4f2a-92c1-cbaf6b328b14')
def uid(s): return str(uuid.uuid5(NS, str(s)))
def q(s): return json.dumps(str(s))
def f(x): return f'{float(x):.5f}'.rstrip('0').rstrip('.') or '0'
def fx(size=1, hide=False, justify=''):
    return f'(effects (font (size {size} {size})){" (justify "+justify+")" if justify else ""}{" hide" if hide else ""})'

LEFT = ['5V','GND','GPIO13','GPIO12','GPIO14','GPIO27','GPIO26','GPIO25','GPIO33','GPIO32','GPIO35','GPIO34','GPIO39_VN','GPIO36_VP','EN']
RIGHT = ['3V3','GND','GPIO15','GPIO2','GPIO4','GPIO16','GPIO17','GPIO5','GPIO18','GPIO19','GPIO21','GPIO3_RX0','GPIO1_TX0','GPIO22','GPIO23']
PARTS = [
 dict(ref='J1',value='ESP32 30-pin socket pair - ASSUMED',fp='ESP32_30_Socket_Pair_ASSUMED',
      names={str(i+1):n for i,n in enumerate(LEFT+RIGHT)},
      nets={str(i+1):({'5V':'VBUS_5V','GND':'GND','3V3':'HOST_3V3','GPIO17':'NFC_SDA','GPIO22':'NFC_SCL'}.get(n)) for i,n in enumerate(LEFT+RIGHT)},
      xy=[5,5],sch=[63.5,73.66],dnp=False),
 dict(ref='J2',value='PN532 V3 I2C socket - ASSUMED',fp='PN532_I2C_1x04_ASSUMED',
      names={'1':'GND','2':'VCC_5V','3':'SDA','4':'SCL'},
      nets={'1':'GND','2':'VBUS_5V','3':'NFC_SDA','4':'NFC_SCL'},xy=[39,20],sch=[180.34,55.88],dnp=False),
 dict(ref='R1',value='4.7k OPTIONAL DNP',fp='R_0805',names={'1':'1','2':'2'},
      nets={'1':'HOST_3V3','2':'NFC_SDA'},xy=[33.5,23.5],sch=[137.16,93.98],dnp=True),
 dict(ref='R2',value='4.7k OPTIONAL DNP',fp='R_0805',names={'1':'1','2':'2'},
      nets={'1':'HOST_3V3','2':'NFC_SCL'},xy=[33.5,29],sch=[137.16,119.38],dnp=True),
]
for i,(net,x,y) in enumerate([('VBUS_5V',8,10),('GND',26.4,9),('HOST_3V3',29.4,16.5),('NFC_SDA',30.3,20.24),('NFC_SCL',29.5,32)],1):
    PARTS.append(dict(ref=f'TP{i}',value=net,fp='TestPad',names={'1':net},nets={'1':net},xy=[x,y],sch=[234.95,45.72+12.7*i],dnp=False))
OUTLINE = [(0,0),(10,0),(10,7.5),(23,7.5),(23,0),(33,0),(33,17.5),(43,17.5),(43,32),(33,32),(33,44),(0,44)]
ROOT_UUID = uid('root')

def fp(name,pads,body=None):
    s=f'(footprint {q(name)} (version 20221018) (generator pcbnew) (layer "F.Cu") (attr through_hole)'
    s+=f'(fp_text reference "REF**" (at 0 -2.5) (layer "F.SilkS") {fx(.9)})'
    s+=f'(fp_text value {q(name)} (at 0 0) (layer "F.Fab") {fx(.7,True)})'
    if body:
        x0,y0,x1,y1=body
        for layer,w,delta in [('F.Fab',.1,0),('F.CrtYd',.05,.25)]:
            s+=f'(fp_rect (start {f(x0-delta)} {f(y0-delta)}) (end {f(x1+delta)} {f(y1+delta)}) (stroke (width {w}) (type default)) (fill none) (layer {q(layer)}))'
    for k,x,y,drill,size in pads:
        typ='thru_hole' if drill else 'smd'
        shape='rect' if k=='1' else 'circle'
        if not drill:shape='rect' if name=='R_0805' else 'circle'
        layers='"*.Cu" "*.Mask"' if drill else ('"F.Cu" "F.Paste" "F.Mask"' if name=='R_0805' else '"F.Cu" "F.Mask"')
        s+=f'(pad {q(k)} {typ} {shape} (at {f(x)} {f(y)}) (size {f(size[0])} {f(size[1])})'+(f' (drill {drill})' if drill else '')+f' (layers {layers}))'
    return s+')'

def footprints():
    defs={}
    # 30-pin clone datum: pin 1 = left USB-end 5V; pin 16 = right USB-end 3V3.
    pads=[(str(i+1),0 if i<15 else 22.86,(i%15)*2.54,1.0,[1.7,1.7]) for i in range(30)]
    s=fp('ESP32_30_Socket_Pair_ASSUMED',pads)
    # Individual socket courtyards, rather than a filled module courtyard.
    for x in [0,22.86]:
        s=s[:-1]+f'(fp_rect (start {f(x-1.55)} -1.55) (end {f(x+1.55)} 37.11) (stroke (width .05) (type default)) (fill none) (layer "F.CrtYd"))'+')'
    defs['ESP32_30_Socket_Pair_ASSUMED']=s
    defs['PN532_I2C_1x04_ASSUMED']=fp('PN532_I2C_1x04_ASSUMED',[(str(i+1),0,i*2.54,1.,[1.7,1.7]) for i in range(4)],[-1.3,-1.3,1.3,8.92])
    defs['R_0805']=fp('R_0805',[('1',-.9125,0,0,[1.025,1.4]),('2',.9125,0,0,[1.025,1.4])],[-1.675,-.95,1.675,.95]).replace('(attr through_hole)','(attr smd)')
    defs['TestPad']=fp('TestPad',[('1',0,0,0,[1,1])]).replace('(attr through_hole)','(attr smd exclude_from_bom)')
    defs['Mount_M2']=fp('Mount_M2',[])
    defs['Mount_M2']=defs['Mount_M2'][:-1]+'(pad "" np_thru_hole circle (at 0 0) (size 2.2 2.2) (drill 2.2) (layers "*.Cu" "*.Mask")))'
    for name,s in defs.items():(LIB/(name+'.kicad_mod')).write_text(s+'\n')
    return defs

def symbol(p):
    keys=list(p['nets']);n=len(keys);h=max(2.54,((n+1)//2-1)*1.27+2.54)
    if n==4:h=6.35
    pins=[]
    for i,k in enumerate(keys):
        if n==30:
            side=i//15;px=-20.32 if side==0 else 20.32;py=(7-(i%15))*2.54
        elif n==4:px=-12.7;py=(1.5-i)*2.54
        elif n==2:px=-5.08 if i==0 else 5.08;py=0
        else:px=-5.08;py=0
        pins.append((k,px,py,0 if px<0 else 180))
    half=15.24 if n==30 else (7.62 if n==4 else 2.54)
    s=f'(symbol {q(p["ref"])} (pin_names (offset .508){" hide" if n==1 else ""}) (in_bom {"no" if p["ref"].startswith("TP") else "yes"}) (on_board yes)'
    s+=f'(property "Reference" {q(p["ref"])} (at 0 {f(h+3)} 0) {fx(1.27)})'
    s+=f'(property "Value" {q(p["value"])} (at 0 {f(-h-3)} 0) {fx(1)})'
    s+=f'(property "Footprint" {q("Carrier:"+p["fp"])} (at 0 0 0) {fx(1,True)})'
    shape=f'(circle (center 0 0) (radius 1.27)' if n==1 else f'(rectangle (start {-half} {h}) (end {half} {-h})'
    s+=f'(symbol {q(p["ref"]+"_0_1")} {shape} (stroke (width .254) (type default)) (fill (type background))))'
    s+=f'(symbol {q(p["ref"]+"_1_1")} '
    for k,x,y,a in pins:
        s+=f'(pin passive line (at {f(x)} {f(y)} {a}) (length {3.81 if n==1 else (5.08 if n>2 else 2.54)}) (name {q(p["names"][k])} {fx(.9)}) (number {q(k)} {fx(.9)}))'
    return s+'))',pins,h

def schematic():
    syms={p['ref']:symbol(p) for p in PARTS}
    (ROOT/'Carrier.kicad_sym').write_text('(kicad_symbol_lib (version 20220914) (generator kicad_symbol_editor) '+''.join(s[0] for s in syms.values())+')\n')
    s=f'(kicad_sch (version 20230121) (generator eeschema) (uuid {ROOT_UUID}) (paper "A4") (title_block (title "Fieldnote passive carrier") (date "2026-10-04") (rev "0.1 DRAFT")) (lib_symbols '+''.join(v[0].replace('(symbol '+q(k),'(symbol '+q('Carrier:'+k),1) for k,v in syms.items())+')'
    notes=[('PASSIVE CARRIER - REVIEW CANDIDATE',15.24,15.24,1.5),('USB power and programming remain on the existing ESP32 board. I2C: GPIO17 / GPIO22, 100 kHz.',15.24,22.86,1),('30-pin ESP32 map, socket row centers and PN532 socket position are assumptions. CONFIRM BEFORE FABRICATION.',15.24,29.21,1),('R1 / R2 are DNP by default. Fit only if needed after checking module pull-ups. Never fit 5V I2C pull-ups.',109.22,146.05,1),('PN532 VCC = 5V. Interface switches: S1 ON, S2 OFF. Verify actual reader GPIO idle levels at 3.3V.',109.22,153.67,1)]
    for t,x,y,z in notes:s+=f'(text {q(t)} (at {x} {y} 0) {fx(z,justify="left")} (uuid {uid(t)}))'
    for p in PARTS:
        x,y=p['sch'];defn,pins,h=syms[p['ref']]
        for k,px,py,a in pins:
            ex,ey=x+px,y-py;net=p['nets'][k]
            if net is None:s+=f'(no_connect (at {f(ex)} {f(ey)}) (uuid {uid(p["ref"]+k+"NC")}))';continue
            dx=-7.62 if px<0 else 7.62
            s+=f'(wire (pts (xy {f(ex)} {f(ey)}) (xy {f(ex+dx)} {f(ey)})) (stroke (width 0) (type default)) (uuid {uid(p["ref"]+k+"wire")}))'
            s+=f'(global_label {q(net)} (shape input) (at {f(ex+dx)} {f(ey)} {0 if dx<0 else 180}) {fx(.9,justify="right" if dx<0 else "left")} (uuid {uid(p["ref"]+k+"label")}))'
        s+=f'(symbol (lib_id {q("Carrier:"+p["ref"])}) (at {x} {y} 0) (unit 1) (in_bom {"no" if p["ref"].startswith("TP") else "yes"}) (on_board yes) (dnp {"yes" if p["dnp"] else "no"}) (uuid {uid(p["ref"])})'
        for key,val,yy,hide in [('Reference',p['ref'],y-h-2,False),('Value',p['value'],y+h+2,False),('Footprint','Carrier:'+p['fp'],y,True)]:
            s+=f'(property {q(key)} {q(val)} (at {x} {f(yy)} 0) {fx(1 if key=="Value" else 1.27,hide)})'
        for k,*_ in pins:s+=f'(pin {q(k)} (uuid {uid(p["ref"]+k+"pin")}))'
        s+=f'(instances (project "fieldnote-carrier" (path {q("/"+ROOT_UUID)} (reference {q(p["ref"])}) (unit 1)))))'
    s+='(sheet_instances (path "/" (page "1"))))'
    (ROOT/'fieldnote-carrier.kicad_sch').write_text(s+'\n')

def board(defs):
    nets=sorted({n for p in PARTS for n in p['nets'].values() if n})
    for p in PARTS:
        for pin,n in list(p['nets'].items()):
            if n is None:nets.append(f'unconnected-({p["ref"]}-{p["names"][pin]}-Pad{pin})')
    ids={n:i+1 for i,n in enumerate(nets)}
    layers='(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (34 "B.Paste" user) (35 "F.Paste" user) (36 "B.SilkS" user "B.Silkscreen") (37 "F.SilkS" user "F.Silkscreen") (38 "B.Mask" user) (39 "F.Mask" user) (40 "Dwgs.User" user "User.Drawings") (41 "Cmts.User" user "User.Comments") (44 "Edge.Cuts" user) (46 "B.CrtYd" user "B.Courtyard") (47 "F.CrtYd" user "F.Courtyard") (48 "B.Fab" user) (49 "F.Fab" user))'
    s='(kicad_pcb (version 20221018) (generator pcbnew) (general (thickness 1.6)) (paper "A4")'+layers+'(setup (pad_to_mask_clearance 0)) (net 0 "")'
    s+=''.join(f'(net {i} {q(n)})' for n,i in ids.items())
    def absxy(p):return [f(50+p[0]),f(50+p[1])]
    for p in PARTS:
        t=defs[p['fp']]
        t=t.replace('(footprint '+q(p['fp']), '(footprint '+q('Carrier:'+p['fp']),1)
        t=t.replace('(fp_text value '+q(p['fp']), '(fp_text value '+q(p['value']),1)
        if p['dnp']:t=t.replace('(attr smd)', '(attr smd dnp)',1)
        t=t.replace('(layer "F.Cu")',f'(layer "F.Cu") (at {" ".join(absxy(p["xy"]))}) (path {q("/"+ROOT_UUID+"/"+uid(p["ref"]))}) (tstamp {uid(p["ref"])})',1)
        t=t.replace('"REF**"',q(p['ref']),1)
        t=t.replace('(fp_text reference '+q(p['ref'])+' (at 0 -2.5)', '(fp_text reference '+q(p['ref'])+' (at '+('0 -2.5' if p['ref'].startswith('J') else '0 -1.8')+')')
        if p['ref']=='J2':t=t.replace('(at 0 -2.5)','(at 0 -1.4)',1)
        if p['ref'].startswith('TP'):t=t.replace('(layer "F.SilkS") '+fx(.9), '(layer "F.Fab") '+fx(.9,True),1)
        # Net attribute inserted into each pad by its number.
        for pin,n in p['nets'].items():
            if n is None:n=f'unconnected-({p["ref"]}-{p["names"][pin]}-Pad{pin})'
            t=t.replace('(pad '+q(pin)+' ',f'(pad {q(pin)} ',1)
            # Insert net immediately before pad's closing parenthesis.
            pat=r'(\(pad '+re.escape(q(pin))+r' [^\n]*?\(layers [^)]*\))\)'
            t=re.sub(pat,lambda m:m[1]+f' (net {ids[n]} {q(n)}))',t,count=1)
        s+=t
    for j,xy in enumerate([(1.8,3),(1.8,41)],1):
        t=defs['Mount_M2'].replace('(layer "F.Cu")',f'(layer "F.Cu") (at {" ".join(absxy(xy))}) (tstamp {uid("H"+str(j))})',1).replace('"REF**"',q('H'+str(j)),1)
        t=t.replace('(footprint "Mount_M2"','(footprint "Carrier:Mount_M2"',1).replace('(attr through_hole)','(attr through_hole board_only exclude_from_bom exclude_from_pos_files)',1)
        t=t.replace('(layer "F.SilkS") '+fx(.9), '(layer "F.Fab") '+fx(.9,True),1)
        s+=t
    for a,b in zip(OUTLINE,OUTLINE[1:]+OUTLINE[:1]):
        s+=f'(gr_line (start {" ".join(absxy(a))}) (end {" ".join(absxy(b))}) (stroke (width .05) (type default)) (layer "Edge.Cuts") (tstamp {uid((a,b))}))'
    def route(net,points,layer='F.Cu',width=.25):
        nonlocal s
        for a,b in zip(points,points[1:]):s+=f'(segment (start {" ".join(absxy(a))}) (end {" ".join(absxy(b))}) (width {width}) (layer {q(layer)}) (net {ids[net]}) (tstamp {uid((net,layer,a,b))}))'
    route('VBUS_5V',[(5,5),(8,5),(8,10),(8,11.35),(26,11.35)],width=.8)
    route('VBUS_5V',[(26,11.35),(28.7,11.35)],width=.25)
    route('VBUS_5V',[(28.7,11.35),(30.5,11.35),(30.5,18.8),(34.24,22.54),(39,22.54)],'B.Cu',.8)
    route('GND',[(5,7.54),(6.5,9),(26.4,9),(27.86,7.54),(29.5,9),(31.5,9),(31.5,17.8),(33.7,20),(39,20)],'B.Cu',.8)
    route('HOST_3V3',[(27.86,5),(29.4,6.54),(29.4,16.5),(31.5,18.6),(31.5,23.5),(32.5875,23.5)])
    route('HOST_3V3',[(31.5,23.5),(31.5,29),(32.5875,29)])
    route('NFC_SDA',[(27.86,20.24),(30.3,20.24),(30.3,21.5),(32.3,23.5),(35.5,23.5)],'B.Cu')
    route('NFC_SDA',[(34.4125,23.5),(35.5,23.5),(37.08,25.08),(39,25.08)])
    route('NFC_SCL',[(27.86,38.02),(29.5,36.38),(29.5,32),(29.5,30.6),(34.4125,29),(35.5,29)],'B.Cu')
    route('NFC_SCL',[(34.4125,29),(35.5,29),(36.88,27.62),(39,27.62)])
    # Test pads on F.Cu connect to existing traces without adding long stubs.
    for net,xy in [('VBUS_5V',[28.7,11.35]),('GND',[26.4,9]),('NFC_SDA',[30.3,20.24]),('NFC_SCL',[29.5,32])]:
        s+=f'(via (at {" ".join(absxy(xy))}) (size .6) (drill .3) (layers "F.Cu" "B.Cu") (net {ids[net]}) (tstamp {uid((net,xy,"via"))}))'
    for net,xy in [('NFC_SDA',[35.5,23.5]),('NFC_SCL',[35.5,29])]:
        s+=f'(via (at {" ".join(absxy(xy))}) (size .6) (drill .3) (layers "F.Cu" "B.Cu") (net {ids[net]}) (tstamp {uid((net,xy,"via"))}))'
    for txt,x,y in [('FIELDNOTE CARRIER',16,41.5),('v0.1 - VERIFY SOCKETS',16,43),('GND',41.4,20),('5V',41.4,22.54),('SDA',41.4,25.08),('SCL',41.4,27.62),('USB',16.5,9.5)]:
        s+=f'(gr_text {q(txt)} (at {" ".join(absxy([x,y]))}) (layer "F.SilkS") {fx(.8)} (tstamp {uid(txt)}))'
    for text,x,y in [('ESP32 body: 24.5 x 50.03 mm envelope',16.43,52),('PN532 body: nominal 42.7 x 40.4 mm',54.35,50.5),('NO CARRIER GROUND PLANE BEHIND NFC LOOP',54.35,54)]:
        s+=f'(gr_text {q(text)} (at {" ".join(absxy([x,y]))}) (layer "Dwgs.User") {fx(.9)} (tstamp {uid(text)}))'
    for x0,y0,x1,y1 in [(4.18,0,28.68,50.03),(33,8,75.7,48.4)]:
        s+=f'(gr_rect (start {" ".join(absxy([x0,y0]))}) (end {" ".join(absxy([x1,y1]))}) (stroke (width .15) (type dash)) (fill none) (layer "Dwgs.User") (tstamp {uid((x0,y0,x1,y1))}))'
    s+=')'
    (ROOT/'fieldnote-carrier.kicad_pcb').write_text(s+'\n')

def main():
    OUT.mkdir(exist_ok=True);LIB.mkdir(exist_ok=True)
    (ROOT/'sym-lib-table').write_text('(sym_lib_table (lib (name "Carrier") (type "KiCad") (uri "${KIPRJMOD}/Carrier.kicad_sym") (options "") (descr "Passive carrier symbols")))\n')
    (ROOT/'fp-lib-table').write_text('(fp_lib_table (lib (name "Carrier") (type "KiCad") (uri "${KIPRJMOD}/Carrier.pretty") (options "") (descr "Carrier candidate footprints; module dimensions unverified")))\n')
    (ROOT/'fieldnote-carrier.kicad_pro').write_text(json.dumps({'meta':{'filename':'fieldnote-carrier.kicad_pro','version':1},'net_settings':{'classes':[{'name':'Default','clearance':.2,'track_width':.25,'via_diameter':.6,'via_drill':.3,'diff_pair_width':.25,'diff_pair_gap':.25,'diff_pair_via_gap':.25}]},'board':{'design_settings':{'rules':{'min_clearance':.2,'min_track_width':.2,'min_through_hole_diameter':.3,'min_copper_edge_clearance':.3}}}},indent=2)+'\n')
    defs=footprints();schematic();board(defs)
    (ROOT/'design-data.json').write_text(json.dumps({'status':'REVIEW CANDIDATE - SOCKET MODEL / GEOMETRY UNVERIFIED - NO FABRICATION RELEASE','parts':PARTS,'board_outline_mm':OUTLINE,'board_extent_mm':[43,44],'layer_count':2,'thickness_mm':1.6,'module_envelopes':{'esp32':[4.18,0,28.68,50.03],'pn532':[33,8,75.7,48.4]},'assumptions':{'esp32_model':'narrow original ESP32 30-pin clone, NOT confirmed','esp32_row_centers_mm':22.86,'esp32_pitch_mm':2.54,'pn532_pitch_mm':2.54,'pn532_connector_xy_mm':[39,20],'sockets':'female vertical; matching male headers on module undersides','carrier_fits_existing_case':False},'firmware':{'profile':'Fieldnote standalone I2C','SDA_GPIO':17,'SCL_GPIO':22,'frequency_Hz':100000},'power':{'source':'existing ESP32 USB','reader_supply_V':5,'host_gpio_V':3.3,'pullups':'R1/R2 DNP; optional 4.7k to HOST_3V3 only'},'release_gates':['Exact ESP32 board identity and pin order','ESP32 header pitch, row centers and USB datum','PN532 actual header pitch/order/location','Socket height, underside clearance and support/retention','Powered I2C levels, current, WiFi/NFC and closed-case range']},indent=2)+'\n')
    with (OUT/'pin-net-map.csv').open('w',newline='') as h:
        w=csv.writer(h);w.writerow(['reference','pin','label','net','footprint_status'])
        for p in PARTS:
            for pin,n in p['nets'].items():w.writerow([p['ref'],pin,p['names'][pin],n or 'NC','ASSUMED module sockets' if p['ref'].startswith('J') else 'generic'])
    print('Generated passive carrier review candidate; geometry remains unverified.')

if __name__=='__main__':main()
