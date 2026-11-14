#!/usr/bin/env python3
"""Create a review PDF from extracted native PCB geometry and native schematic."""
from pathlib import Path
import json
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from pypdf import PdfReader, PdfWriter

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output'
DATA=json.loads((ROOT/'design-data.json').read_text())
GEO=json.loads((OUT/'native-geometry.json').read_text())
W,H=landscape(A4)
INK=HexColor('#18313a'); MUTED=HexColor('#51676d'); GREEN=HexColor('#edf5ee')
RED=HexColor('#b44732'); BLUE=HexColor('#2e728f'); GOLD=HexColor('#b27916')

def label(c,t,x,y,size=10,color=INK):
    c.setFillColor(color);c.setFont('Helvetica',size);c.drawString(x,y,t)

def title(c,sub):
    c.setFillColor(HexColor('#f6f8f7'));c.rect(0,0,W,H,fill=1,stroke=0)
    label(c,'FIELDNOTE / PASSIVE CARRIER',34,H-44,23)
    label(c,sub,35,H-65,11,MUTED)
    c.setFillColor(HexColor('#fff0d6'));c.roundRect(34,H-113,W-68,30,5,fill=1,stroke=0)
    label(c,'REVIEW CANDIDATE: ESP32 model and both mating footprints are unverified.',45,H-101,11,GOLD)

def board(c,ox,oy,scale=1,copper=True):
    def pt(p):return ox+p[0]*scale,oy-p[1]*scale
    p=c.beginPath();p.moveTo(*pt(DATA['board_outline_mm'][0]))
    for xy in DATA['board_outline_mm'][1:]:p.lineTo(*pt(xy))
    p.close();c.setFillColor(GREEN);c.setStrokeColor(INK);c.setLineWidth(.75);c.drawPath(p,fill=1,stroke=1)
    if copper:
        for s in sorted(GEO['segments'],key=lambda t:t['layer']=='F.Cu'):
            c.setStrokeColor(RED if s['layer']=='F.Cu' else BLUE);c.setLineWidth(s['width']*scale)
            c.line(*pt(s['start']),*pt(s['end']))
    for pad in GEO['pads']:
        x,y=pt(pad['xy']);sx,sy=[v*scale for v in pad['size']]
        c.setFillColor(GOLD);c.setStrokeColor(GOLD)
        if pad['drill'][0]==0 and pad['ref'].startswith('R'):
            c.rect(x-sx/2,y-sy/2,sx,sy,fill=1,stroke=0)
        elif pad['pin']=='1' and pad['drill'][0]>0:
            c.rect(x-sx/2,y-sy/2,sx,sy,fill=1,stroke=0)
        elif pad['ref'].startswith('H'):
            c.setFillColor(HexColor('#f6f8f7'));c.circle(x,y,sx/2,fill=1,stroke=1)
        else:c.circle(x,y,sx/2,fill=1,stroke=0)
        if pad['drill'][0]>0 and not pad['ref'].startswith('H'):
            c.setFillColor(HexColor('#f6f8f7'));c.circle(x,y,pad['drill'][0]*scale/2,fill=1,stroke=0)
    if copper:
        for v in GEO['vias']:
            x,y=pt(v['xy']);c.setFillColor(GOLD);c.circle(x,y,v['size']*scale/2,fill=1,stroke=0)
            c.setFillColor(GREEN);c.circle(x,y,v['drill']*scale/2,fill=1,stroke=0)

def dimension(c,a,b,t):
    c.setStrokeColor(MUTED);c.setLineWidth(.5);c.line(*a,*b)
    for x,y in [a,b]:c.line(x,y-3,x,y+3)
    c.setFont('Helvetica',9);c.setFillColor(MUTED);c.drawCentredString((a[0]+b[0])/2,a[1]+5,t)

def overview(c):
    title(c,'Existing ESP32 + PN532 V3 modules; PCB traces replace the four jumper connections.')
    label(c,'ROUTED CARRIER',35,448,12)
    board(c,51,423,6.2)
    dimension(c,(51,133),(51+43*6.2,133),'43 mm carrier extent')
    label(c,'USB clearance',120,396,9)
    label(c,'J1: two 15-pin sockets',90,159,9)
    label(c,'J2: PN532',329,319,8)
    label(c,'GND / 5V',329,294,8)
    label(c,'SDA / SCL',329,260,8)
    c.setStrokeColor(MUTED);c.setLineWidth(.5)
    c.line(300,293,325,297);c.line(300,260,325,264)
    c.setStrokeColor(RED);c.setLineWidth(2);c.line(51,126,70,126);label(c,'Top copper',78,123,9)
    c.setStrokeColor(BLUE);c.line(165,126,184,126);label(c,'Bottom copper',192,123,9)
    label(c,'MODULE ARRANGEMENT / ENVELOPES',419,448,12)
    ox,oy,sc=431,421,4.5
    board(c,ox,oy,sc,copper=False)
    for key,col in [('esp32',BLUE),('pn532',RED)]:
        x0,y0,x1,y1=DATA['module_envelopes'][key]
        c.setStrokeColor(col);c.setLineWidth(1.1);c.setDash(4,3)
        c.rect(ox+x0*sc,oy-y1*sc,(x1-x0)*sc,(y1-y0)*sc,fill=0,stroke=1);c.setDash()
    label(c,'Existing ESP32',ox+7*sc,oy-23*sc,10,BLUE)
    label(c,'24.5 x 50.03 mm',ox+5.7*sc,oy-27*sc,8,BLUE)
    label(c,'PN532 V3',ox+43*sc,oy-23*sc,12,RED)
    label(c,'42.7 x 40.4 mm nominal',ox+43*sc,oy-27*sc,9,RED)
    label(c,'USB at this end',ox+5*sc,oy+6,8,BLUE)
    label(c,'Reader overhang avoids a full PCB ground plane behind its coil.',419,170,9,MUTED)
    label(c,'Tongue position, antenna clearance and socket height need measurement.',419,155,9,MUTED)
    label(c,'Combined envelope: 75.7 x 50.03 mm, before cable/case allowances.',419,137,9,MUTED)
    label(c,'Two layers / 1.6 mm PCB',35,92,11)
    label(c,'Existing USB power and programming',287,92,11)
    label(c,'GPIO17 SDA / GPIO22 SCL',582,92,11)
    label(c,'Default: sockets only. R1/R2 are optional 4.7k pull-ups to 3V3, unpopulated.',35,71,10,MUTED)
    label(c,'Native ERC: 0 violations. Native DRC: 0 violations, 0 unconnected items, 0 parity issues.',35,54,10,MUTED)
    label(c,'CAD checks establish this candidate layout only. They do not establish module fit or powered operation.',35,37,9,GOLD)
    c.showPage()

def fit_page(c):
    title(c,'Assumed socket pattern / print at 100% actual size to inspect the proposed mating pattern.')
    label(c,'1:1 CARRIER PATTERN - ASSUMPTIONS, NOT A FABRICATION DRAWING',35,444,12)
    ox,oy=85,402;sc=mm
    board(c,ox,oy,sc,copper=False)
    dimension(c,(ox+5*sc,oy+15),(ox+27.86*sc,oy+15),'22.86 mm assumed row centers')
    label(c,'USB end',ox+10*sc,oy-5*sc,8)
    label(c,'J1 / 2 x 15 holes, 2.54 mm pitch',35,247,10)
    label(c,'J2 / 1 x 4 holes, 2.54 mm pitch',35,230,10)
    dimension(c,(85,195),(85+50*mm,195),'50 mm print calibration')
    label(c,'Required before fixing the socket layout',361,406,13)
    lines=[
        '1. Exact ESP32 model and printed pin sequence.',
        '2. Header holes per side, pitch and row-center spacing.',
        '3. USB position and underside clearance.',
        '4. PN532 four-pin pitch, order and edge offsets.',
        '5. Socket / header height and module retention.',
        '6. I2C idle levels, powered NFC / Wi-Fi and case tests.',
    ]
    for i,t in enumerate(lines):label(c,t,361,378-i*23,10,MUTED)
    label(c,'Connection contract',361,212,13)
    for i,t in enumerate(['J2.1 GND  |  J2.2 ESP32 USB 5V','J2.3 GPIO17 / SDA  |  J2.4 GPIO22 / SCL','PN532 S1 ON / S2 OFF; retain existing Fieldnote firmware.']):label(c,t,361,190-i*19,10,MUTED)
    label(c,'Sources and scope',35,131,11)
    label(c,'Project firmware/esp32_nfc_web/README.md: current wiring and 100 kHz profile.',35,113,9,MUTED)
    label(c,'September 14 photo-case notes: measured ESP32 envelope; header pattern was not measured.',35,97,9,MUTED)
    label(c,'Elechouse PN532 V3 manual and schematic: family envelope, pin labels and interface circuitry.',35,81,9,MUTED)
    label(c,'Source URLs and complete assumptions are recorded in the accompanying README.md.',35,65,9,MUTED)
    label(c,'No fabrication Gerbers, manufacturer upload or physical qualification are included.',35,37,10,GOLD)
    c.showPage()

def main():
    pages=OUT/'review-layout-pages.pdf';c=canvas.Canvas(str(pages),pagesize=(W,H))
    c.setTitle('Fieldnote passive carrier v0.1 - review candidate')
    overview(c);fit_page(c);c.save()
    r=PdfReader(pages);sch=PdfReader(OUT/'schematic.pdf');w=PdfWriter()
    w.add_page(r.pages[0])
    for page in sch.pages:w.add_page(page)
    w.add_page(r.pages[1])
    w.add_metadata({'/Title':'Fieldnote passive carrier v0.1 - unverified socket geometry','/Subject':'Review candidate, not released for fabrication'})
    with (OUT/'fieldnote-carrier-review.pdf').open('wb') as h:w.write(h)
    print('Created 3-page review PDF with native schematic and 1:1 assumed fit pattern.')

if __name__=='__main__':main()
