#!/usr/bin/env python3
"""Create drawings from the actual generated placement and circuit data."""
from pathlib import Path
import json, math, textwrap
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color, white
from reportlab.lib.pagesizes import A4, A3, landscape
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
import build_design as d

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output'
DATA=json.loads((ROOT/'design-data.json').read_text())
d.load_placement()
PARTS=DATA['parts']; BY={p['ref']:p for p in PARTS}
NAVY='#112C3A'; TEAL='#12756F'; GOLD='#D8AE59'; MUTED='#537078'
FONT='/System/Library/Fonts/Supplemental/Arial.ttf'
FONTB='/System/Library/Fonts/Supplemental/Arial Bold.ttf'

def preview():
    scale=21; origin=(115,170); W,H=1600,1280
    im=Image.new('RGB',(W,H),'#F2F6F5'); draw=ImageDraw.Draw(im)
    def xy(p):return (origin[0]+p[0]*scale,origin[1]+p[1]*scale)
    def f(n,b=False):
        source=FONTB if b else FONT
        return ImageFont.truetype(source,n) if Path(source).exists() else ImageFont.load_default(size=n)
    draw.text((110,38),'FIELDNOTE / INTEGRATED NFC + ESP32',font=f(30,True),fill=NAVY)
    draw.text((110,84),'V17 case target • three LEDs • USB-C + rechargeable 1S LiPo',font=f(23),fill=MUTED)
    draw.polygon([xy(v) for v in DATA['outline']],fill='#155F56',outline='#082F2B',width=4)
    # Keepout regions are shown visibly, rather than suggesting filled copper.
    draw.rectangle([xy((1.5,10.7)),xy((33.1,45.0))],fill='#164A44')
    draw.rectangle([xy((33.1,38.7)),xy((48.1,45.0))],fill='#325F5A')
    draw.rectangle([xy((61.5,38.7)),xy((65.3,45.0))],fill='#325F5A')
    draw.line([xy(v) for v in DATA['coil']],fill=GOLD,width=round(.8*scale),joint='curve')
    draw.line([xy(DATA['coil'][-1]),xy((33.9,26.2))],fill='#9FC8D0',width=round(.8*scale))
    for p in PARTS:
        if p['ref']=='ANT1':continue
        x,y=p['xy']; ref=p['ref']; bounds=d.placement_bounds(p)
        if ref=='U1':
            draw.rectangle([xy((48.2,27.6)),xy((61.4,38.8))],fill='#C7CDD0',outline='#283D43',width=3)
            draw.rectangle([xy((48.2,38.8)),xy((61.4,44.2))],fill='#143A38',outline='#A8C4BB',width=2)
            draw.text(xy((49.3,40.0)),'Wi-Fi antenna',font=f(18),fill='#C6DFD0')
            draw.text(xy((49.3,41.7)),'module area',font=f(16),fill='#C6DFD0')
            draw.text(xy((49.4,31.0)),'ESP32-C3',font=f(23,True),fill=NAVY)
            draw.text(xy((49.4,33.0)),'MINI-1',font=f(19),fill=NAVY)
            continue
        if ref.startswith('D'):
            color={'D1':'#6DEF8C','D2':'#FFCF55','D3':'#FF786F'}[ref]
            center=xy((x,y));r=1.65*scale
            draw.ellipse([center[0]-r,center[1]-r,center[0]+r,center[1]+r],outline='#B8D4CC',width=2)
            draw.rounded_rectangle([xy((x-1,y-.65)),xy((x+1,y+.65))],radius=4,fill=color)
            draw.text((center[0]-12,center[1]-58),ref,font=f(21,True),fill='#E5F4ED')
            continue
        # Draw real footprint copper pads in their final orientation.
        for pad in d.children(d.library(p['fp']),'pad'):
            if not d.unq(pad[1]):continue
            at=d.child(pad,'at');sz=d.child(pad,'size')
            a=p['angle']+(float(at[3]) if len(at)>3 else 0);r=math.radians(a)
            cx,cy=d.transform(float(at[1]),float(at[2]),p);w,h=float(sz[1])/2,float(sz[2])/2
            pts=[(cx+u*math.cos(r)+v*math.sin(r),cy-u*math.sin(r)+v*math.cos(r)) for u,v in [(-w,-h),(w,-h),(w,h),(-w,h)]]
            draw.polygon([xy(v) for v in pts],fill='#D4BA78')
        if ref in ['J1','J2','U2','U3','U4','Y1','L3','SW1','SW2']:
            a,b,c,e=bounds
            fill='#CAD0D1' if ref=='J1' else ('#E5E0C9' if ref=='J2' else '#20383B')
            draw.rectangle([xy((a+.2,b+.2)),xy((c-.2,e-.2))],fill=fill,outline='#A1BDB2',width=2)
            pos=xy((x,y))
            label={'U2':'PN532','U3':'CHG','U4':'3V3','J1':'USB-C','J2':'LiPo','Y1':'27.12','L3':'L3','SW1':'RST','SW2':'BOOT'}[ref]
            font=f(18 if ref in ['U2','J1','J2'] else 13,True)
            draw.text(pos,label,font=font,fill=NAVY if ref in ['J1','J2'] else '#D9ECE4',anchor='mm')
        elif ref.startswith('TP'):
            draw.ellipse([xy((x-.5,y-.5)),xy((x+.5,y+.5))],fill=GOLD)
        else:
            a,b,c,e=bounds
            draw.rectangle([xy((a+.32,b+.2)),xy((c-.32,e-.2))],fill='#B7BBAA' if ref.startswith('C') else '#243839')
    draw.text(xy((8,27.5)),'NFC',font=f(47,True),fill='#CEDBD1')
    draw.text(xy((7.5,31)),'3-turn copper loop',font=f(20),fill='#CEDBD1')
    draw.text(xy((6.5,33)),'No ground pour beneath',font=f(18),fill='#ABC6BA')
    draw.text((110,1154),'65.5 × 47.2 mm envelope, including USB tongue',font=f(26,True),fill=NAVY)
    draw.text((110,1201),'PLACEMENT DRAWING • signal traces unrouted • antenna values await tuning',font=f(21),fill=MUTED)
    path=OUT/'board-preview.png';im.save(path);return path

PDF=OUT/'Fieldnote-PCB-review.pdf'
c=canvas.Canvas(str(PDF),pagesize=A4)
c.setTitle('Fieldnote integrated NFC + ESP32 PCB / Revision 0.1')
c.setAuthor('Fieldnote hardware design')
PAGE=0; W,H=A4
def text(x,y,s,size=10,color=NAVY,bold=False):
    c.setFillColor(HexColor(color));c.setFont('Helvetica-Bold' if bold else 'Helvetica',size);c.drawString(x,y,s)
def para(x,y,w,s,size=10,color=NAVY):
    style=ParagraphStyle('p',fontName='Helvetica',fontSize=size,leading=size*1.43,textColor=HexColor(color))
    p=Paragraph(s,style);_,height=p.wrap(w,900);p.drawOn(c,x,y-height);return y-height
def start(title,sub='',size=A4):
    global PAGE,W,H
    PAGE+=1;W,H=size;c.setPageSize(size)
    c.setFillColor(HexColor(NAVY));c.rect(0,H-105,W,105,fill=1,stroke=0)
    text(34,H-32,'FIELDNOTE  /  HARDWARE  /  REV 0.1',9,'#94C3BC',True)
    text(34,H-64,title,23,'#FFFFFF',True)
    text(34,H-88,sub,10,'#D1E1DE')
def end():
    c.setStrokeColor(HexColor('#C7D6D2'));c.line(34,35,W-34,35)
    text(34,20,'REVIEW DRAFT  |  Unrouted; CAD ERC/DRC and physical validation pending',8,MUTED)
    c.setFont('Helvetica',8);c.drawRightString(W-34,20,str(PAGE));c.showPage()
def table(x,y,width,headers,rows,widths=None,font=9):
    style=ParagraphStyle('cell',fontName='Helvetica',fontSize=font,leading=font*1.3,textColor=HexColor(NAVY))
    items=[[Paragraph(str(v),style) for v in row] for row in [headers,*rows]]
    t=Table(items,colWidths=[width*v for v in (widths or [1/len(headers)]*len(headers))])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),HexColor('#DCEAE5')),('VALIGN',(0,0),(-1,-1),'TOP'),('BOTTOMPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),7),('LINEBELOW',(0,0),(-1,-1),.4,HexColor('#C9D8D3'))]))
    _,hh=t.wrap(width,H);t.drawOn(c,x,y-hh);return y-hh

PREVIEW=preview()
start('One board, sized for your case','ESP32-C3 + bare PN532 + printed NFC antenna + 3 status LEDs + battery charging')
c.drawImage(str(PREVIEW),34,292,width=W-68,height=(W-68)*1280/1600)
y=para(34,279,W-68,'This revision replaces the separate ESP32 and PN532 reader boards with a single custom PCB. The three indicator LEDs sit beneath the existing lid apertures. USB-C supplies power, charges a connected battery, and provides the ESP32 native USB programming connection.',11)
y=table(34,y-16,W-68,['Design choice','Included in this revision'],[
    ['Case target','V17 braced enclosure: 68.1 × 50.5 × 10.0 mm'],
    ['Board','65.5 × 47.2 mm envelope; 1.6 mm nominal thickness; four layers proposed'],
    ['Power','Protected 1S LiPo connector, BQ24074 charger/power path, 3.3 V buck-boost'],
    ['Status','Circuit and placement draft. Electrical routing and manufacturing release remain open.']],[.27,.73])
end()

start('Mechanical fit and LED alignment','Coordinates below describe the assembled case; PCB +Y points toward the rear')
ox,oy,scale=58,700,6.45
def mxy(p):return (ox+p[0]*scale,oy-p[1]*scale)
c.setFillColor(HexColor('#E5EDE8'));c.setStrokeColor(HexColor(MUTED));c.rect(ox,oy-50.5*scale,68.1*scale,50.5*scale,fill=1)
points=[(x+1.3,y+3.8) for x,y in DATA['outline']];path=c.beginPath();path.moveTo(*mxy(points[0]))
for p in points[1:]:path.lineTo(*mxy(p))
path.close();c.setFillColor(HexColor('#AFCBC0'));c.drawPath(path,fill=1,stroke=1)
for x in [12,22,32]:
    px,py=mxy((x,8));c.setStrokeColor(HexColor(TEAL));c.circle(px,py,1.65*scale,fill=0)
    text(px-9,py+17,str(x)+' mm',8,TEAL,True)
for a,b in [((4.4,.7),(6.8,3.4)),((16.4,.7),(18.8,3.4)),((4.5,3.6),(12.5,5.1))]:
    px,py=mxy(a);xx,yy=mxy(b);c.setFillColor(HexColor('#BE9D80'));c.rect(px,yy,xx-px,py-yy,fill=1,stroke=0)
text(ox,oy+15,'68.1 mm exterior',10,NAVY,True)
text(ox,oy-50.5*scale-18,'50.5 mm exterior depth',10,NAVY,True)
text(*mxy((42,3)),'USB center X = 54.4',8,NAVY)
text(*mxy((49,47)),'Wi-Fi notch',8,NAVY)
y=table(34,337,W-68,['Feature','Board coordinate / assembled case target'],[
 ['LED centers','(10.7, 4.2), (20.7, 4.2), (30.7, 4.2) mm / case X = 12, 22, 32; Y = 8.0 mm'],
 ['Placement origin','PCB (0,0) = case (1.3,3.8) mm. USB tongue begins at PCB Y = -2.0 mm.'],
 ['Board height','Bottom Z = 0.8 mm; top Z = 2.4 mm. Requires a 0.2 mm spacer above the 0.6 mm floor.'],
 ['Retaining lip','Front notch clears the lip root. The clip cap leaves about 1.1 mm of upward play; retention needs a fitted spacer/holder.'],
 ['LED optics','Top-emitting 0805 LEDs; light pipes or holders must bridge to the 3.3 mm lid holes.'],
 ['Battery fit','Cell dimensions remain unselected. The connector alone does not establish internal battery fit.']],[.23,.77],9)
para(34,y-12,W-68,'The bare-board outline passes sampled sections of the supplied V17 bottom STL at three Z heights. This is a clearance check for the board outline, not a complete enclosure, connector, cable, lid, or battery collision analysis.',9,MUTED)
end()

start('Power and firmware interface','Existing ESP32-C3 I2C pins are retained')
y=table(34,H-128,W-68,['Connection','Assignment / behavior'],[
 ['PN532 I2C','SDA GPIO4; SCL GPIO5; 7-bit address 0x24; 100 kHz bus'],
 ['Green / amber / red','GPIO1 / GPIO3 / GPIO10; active high through individual 1 kOhm resistors'],
 ['Native USB','GPIO18 D-; GPIO19 D+; ESD protection and 22 Ohm series resistors'],
 ['Battery sense','GPIO0; 220 kOhm / 100 kOhm divider; 4.2 V maps to about 1.313 V'],
 ['Programming / recovery','Native USB, RESET/BOOT buttons, unpopulated six-pin 1.27 mm UART header'],
 ['Charging status','CHG_N and PGOOD_N test points; no fourth indicator LED added']],[.31,.69],10)
y=para(34,y-20,W-68,'<b>Charging and power path.</b> The BQ24074 supports operation from USB while charging a protected single-cell 4.2 V LiPo. The proposed charge setting is 100 mA nominal, with about 111 mA upper tolerance. A 10 kOhm NTC bonded to the cell connects at J3; an open sensor connection inhibits charging. The cell must support this charge rate and the combined ESP32/NFC peak current.',10)
y=para(34,y-16,W-68,'<b>USB input qualification.</b> The charger selects a 500 mA input ceiling once the 3.3 V rail rises. That selection is not USB current negotiation or host-enumeration compliance. Qualify the final power control for the intended USB source before release.',10)
y=para(34,y-16,W-68,'<b>Two supply domains.</b> The ESP32 runs from a TPS63031 3.3 V buck-boost. The PN532 VBAT input uses filtered system power; its internal DVDD output feeds the PN532 analog and transmitter supply. PN532 PVDD uses the ESP32 3.3 V rail for the I2C interface.',10)
y=para(34,y-16,W-68,'<b>Firmware work.</b> The existing NFC code keeps its I2C wiring. LED state control and calibrated battery telemetry still need firmware implementation. Confirm the C3 board configuration enables USB CDC on boot.',10)
end()

def schematic_page(tag,title,sub):
    start(title,sub,landscape(A3))
    tree=d.readsex((ROOT/(tag+'.kicad_sch')).read_text())
    # Actual sheet placements and pin mapping are used; no decorative circuit is invented.
    scale=2.60;ox=18;oy=H-126
    def xy(x,y):return (ox+x*scale,oy-(y-20)*scale)
    for inst in d.children(tree,'symbol'):
        at=d.child(inst,'at');ref=d.unq(d.child(inst,'lib_id')[1]).split(':')[1]
        p=BY[ref];x,y=float(at[1]),float(at[2]);_,pins,h=d.symbol_def(p)
        half=2.54 if len(p['nets'])<=2 else (25.4 if len(p['nets'])>20 else 12.7)
        a,b=xy(x-half,y+h);c.setFillColor(HexColor('#F3F7F4'));c.setStrokeColor(HexColor(MUTED));c.setLineWidth(.55)
        c.rect(a,b,2*half*scale,2*h*scale,fill=1)
        px,py=xy(x,y-h-2);c.setFillColor(HexColor(NAVY));c.setFont('Helvetica-Bold',7);c.drawCentredString(px,py,ref)
        px,py=xy(x,y+h+2);c.setFont('Helvetica',6.5);c.drawCentredString(px,py-5,p['value']+(' [DNP]' if p['dnp'] else ''))
        for k,xx,yy,angle in pins:
            left=xx<0; net=p['nets'][k];ex,ey=x+xx,y-yy;edge=x-half if left else x+half
            ax,ay=xy(ex,ey);bx,by=xy(edge,ey);c.setStrokeColor(HexColor(MUTED));c.line(ax,ay,bx,by)
            c.setFillColor(HexColor(NAVY));c.setFont('Helvetica',5)
            if len(p['nets'])>2:
                if left:c.drawString(bx+3,by-1.5,p['names'].get(k,k))
                else:c.drawRightString(bx-3,by-1.5,p['names'].get(k,k))
            c.setFont('Helvetica',4.7);c.drawCentredString((ax+bx)/2,ay+2,k)
            if net:
                dx=-7.62 if left else 7.62;tx,ty=xy(ex+dx,ey);c.setStrokeColor(HexColor(TEAL));c.line(ax,ay,tx,ty)
                c.setFillColor(HexColor(TEAL));c.circle(tx,ty,.7,fill=1,stroke=0);c.setFont('Helvetica',6)
                if left:c.drawRightString(tx-3,ty-1.8,net)
                else:c.drawString(tx+3,ty-1.8,net)
            else:
                c.setStrokeColor(HexColor('#839692'));c.line(ax-2,ay-2,ax+2,ay+2);c.line(ax-2,ay+2,ax+2,ay-2)
    text(34,62,'Identical net labels connect across all four sheets. X marks an intentionally unconnected pin.',9,MUTED)
    end()
schematic_page('usb-power','USB-C, charger and regulator','Includes protected-cell connector, external NTC and battery voltage divider')
schematic_page('esp32-leds','ESP32-C3 and the three LEDs','GPIO4/5 NFC bus • GPIO1/3/10 LEDs • GPIO18/19 native USB')
schematic_page('pn532','PN532 circuit and test points','Fixed I2C mode • separate internal PN532 supply • 27.12 MHz crystal')
schematic_page('nfc-rf','NFC matching network and antenna','Component values are starting points; measure and tune with the final case and battery arrangement')

start('Release work and source references','A review package with reproducible circuit and placement sources')
y=table(34,H-128,W-68,['Check','Result / remaining work'],[
 ['Automated checks','86 parts, 55 nets. Pin/pad sets, C3 I2C mapping, PN532 straps, LED coordinates and conservative placement overlap checks pass.'],
 ['Bare-board samples','No V17 bottom intersection in three sampled STL cross sections. Complete assembled fit remains unverified.'],
 ['CAD validation','Files have balanced S-expressions and unique object IDs. KiCad is unavailable in this environment; native loading, ERC and DRC have not been run.'],
 ['Electrical routing','Place and route power loops, ground return paths, USB pair and I2C. Add thermal vias and copper zones outside both antenna keepouts.'],
 ['RF prototype','Measure the fabricated loop impedance/inductance, tune matching and damping at 13.56 MHz, and verify read range with representative tags.'],
 ['Parts / mechanics','Finalize RF inductors, buck-boost inductor, ferrite, switch and LED footprints/MPNs; select and fit the battery, NTC and light pipes.'],
 ['Fabrication release','Run ERC/DRC, inspect antenna net-tie copper/keepouts, select laminate/stackup and assembly rules, then generate and verify fabrication exports.']],[.26,.74],9)
y=para(34,y-12,W-68,'<b>Procurement:</b> NXP lists PN532 as not recommended for new designs. This revision keeps the PN532 selected for compatibility; verify authorized-stock availability before committing to production.',9)
y=para(34,y-13,W-68,'<b>Manufacturer references</b> (clickable links):',9)
sources=[('NXP PN532 data sheet','https://www.nxp.com/docs/en/nxp/data-sheets/PN532_C1.pdf'),
 ('NXP antenna design guide AN1445','https://www.nxp.com/docs/en/application-note/AN1445_An1444.zip'),
 ('Espressif ESP32-C3-MINI-1 data sheet','https://www.espressif.com/sites/default/files/documentation/esp32-c3-mini-1_datasheet_en.pdf'),
 ('Texas Instruments BQ24074','https://www.ti.com/lit/ds/symlink/bq24074.pdf'),
 ('Texas Instruments TPS63031','https://www.ti.com/lit/ds/symlink/tps63031.pdf'),
 ('ST USBLC6-2 protection','https://www.st.com/resource/en/datasheet/usblc6-2.pdf')]
for name,url in sources:y=para(34,y-4,W-68,f'<link href="{url}" color="{TEAL}">{name}</link>',8.7)
y=para(34,y-10,W-68,'Mechanical source: <b>3D Modeling / esp32_nfc_v17_braced_case</b>, using the V13-derived bottom geometry and V16 lid LED coordinates. Footprint sources and license notices are preserved in the project references folder.',8.5,MUTED)
end();c.save()
print(str(PDF));print(str(PREVIEW))
