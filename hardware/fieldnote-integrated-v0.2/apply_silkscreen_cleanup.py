"""Clean Fieldnote silkscreen only; default operates on a separate board copy.

--apply BOARD explicitly updates text and silk graphics on the requested board.
Copper, pads, component placement, board edges and zones are asserted unchanged.
"""
from pathlib import Path
import argparse,json,math,shutil,uuid
import pcbnew as k
import wx

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output/silk-candidate'
SILK=(k.F_SilkS,k.B_SilkS)
def vec(p):return k.VECTOR2I(k.FromMM(p[0]+60),k.FromMM(p[1]+50))
def xy(v):return (round(k.ToMM(v.x)-60,6),round(k.ToMM(v.y)-50,6))
def uid(key):return str(uuid.uuid5(uuid.NAMESPACE_URL,'fieldnote-v0.2-silk:'+key))
OUTLINE=json.loads((ROOT/'design-data.json').read_text())['outline']
def inside(p):
    x,y=p;result=False
    for a,c in zip(OUTLINE,OUTLINE[1:]+OUTLINE[:1]):
        if (a[1]>y)!=(c[1]>y) and x<(c[0]-a[0])*(y-a[1])/(c[1]-a[1])+a[0]:result=not result
    return result
def edge_distance(p):
    answer=float('inf')
    for a,c in zip(OUTLINE,OUTLINE[1:]+OUTLINE[:1]):
        dx,dy=c[0]-a[0],c[1]-a[1];r=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)))
        answer=min(answer,math.dist(p,(a[0]+r*dx,a[1]+r*dy)))
    return answer
def safe(p,margin=.25):return inside(p) and edge_distance(p)>=margin
def bbox_points(obj):
    bb=obj.GetBoundingBox();a=xy(bb.GetOrigin());w,h=k.ToMM(bb.GetWidth()),k.ToMM(bb.GetHeight())
    return [a,(a[0]+w,a[1]),(a[0],a[1]+h),(a[0]+w,a[1]+h)]
def immutable(b):
    footprints=[]
    for f in b.GetFootprints():
        footprints.append((f.GetReference(),xy(f.GetPosition()),f.GetOrientationDegrees(),
                           [(str(p.m_Uuid.AsString()),p.GetNumber(),p.GetNetname(),xy(p.GetPosition()),p.GetSize().x,p.GetSize().y,str(p.GetLayerSet().FmtBin())) for p in f.Pads()]))
    tracks=[]
    for t in b.GetTracks():
        if isinstance(t,k.PCB_VIA):tracks.append((str(t.m_Uuid.AsString()),t.GetNetname(),xy(t.GetPosition()),t.GetWidth(k.F_Cu),t.GetDrillValue(),t.IsLocked()))
        else:tracks.append((str(t.m_Uuid.AsString()),t.GetNetname(),xy(t.GetStart()),xy(t.GetEnd()),t.GetLayer(),t.GetWidth(),t.IsLocked()))
    return (footprints,tracks,[(str(z.m_Uuid.AsString()),z.GetNetname(),z.GetLayerSet().FmtBin(),z.Outline().Format()) for z in b.Zones()],
            [(str(g.m_Uuid.AsString()),xy(g.GetStart()),xy(g.GetEnd()),g.GetWidth()) for g in b.GetDrawings() if isinstance(g,k.PCB_SHAPE) and g.GetLayer()==k.Edge_Cuts])
def cleanup(b):
    before=immutable(b);footprints=list(b.GetFootprints());fps={f.GetReference():f for f in footprints}
    graphics=[(f,list(f.GraphicalItems())) for f in footprints]
    report={'hidden_refs':[],'retained_refs':[],'clipped_segments':[],'removed_segments':[],'added_labels':[],'pin1_markers':[]}
    drc=json.loads((ROOT/'output/drc-integrated-seed.json').read_text())
    congested=set()
    for v in drc['violations']:
        if v['type'] in ['silk_over_copper','silk_overlap','silk_edge_clearance']:
            for item in v['items']:
                description=item['description']
                if description.startswith('Reference field of '):congested.add(description[len('Reference field of '):])
    congested.update(['R2','R13','R16','R17','R18','L3'])
    manual={'D1':(10.7,6.0),'D2':(20.7,6.0),'D3':(30.7,6.0),'SW1':(34.75,5.0),'SW2':(39.0,7.0),'J2':(58.5,12.4)}
    for ref,f in fps.items():
        text=f.Reference();text.SetTextSize(k.VECTOR2I(k.FromMM(.8),k.FromMM(.8)));text.SetTextThickness(k.FromMM(.15))
        if ref in manual:
            text.SetPosition(vec(manual[ref]));text.SetTextAngle(k.EDA_ANGLE(0,k.DEGREES_T));text.SetVisible(True)
        elif ref in congested or not all(safe(p,.25) for p in bbox_points(text)):
            text.SetVisible(False)
        if text.IsVisible() and text.GetLayer() in SILK:report['retained_refs'].append(ref)
        else:report['hidden_refs'].append(ref)
    # Retain native pin-1 polygons and polarity shapes. Clip only straight
    # outline strokes that protrude past the real board with a 0.25mm margin.
    removed_proxies=[]
    for f,items in graphics:
        for g in items:
            if g.GetLayer() not in SILK:continue
            if isinstance(g,k.PCB_TEXT):
                g.SetTextThickness(k.FromMM(max(.15,k.ToMM(g.GetTextThickness()))))
                if not all(safe(p,.25) for p in bbox_points(g)):g.SetLayer(k.F_Fab)
            elif isinstance(g,k.PCB_SHAPE):
                g.SetWidth(k.FromMM(max(.15,k.ToMM(g.GetWidth()))))
                if g.GetShape()!=k.SHAPE_T_SEGMENT:continue
                a,c=xy(g.GetStart()),xy(g.GetEnd());steps=max(1,math.ceil(math.dist(a,c)/.025));kept=[]
                for i in range(steps+1):
                    p=tuple(a[j]+(c[j]-a[j])*i/steps for j in [0,1])
                    if safe(p,.25+k.ToMM(g.GetWidth())/2):kept.append(i)
                if not kept:
                    report['removed_segments'].append({'ref':f.GetReference(),'uuid':str(g.m_Uuid.AsString())});f.Remove(g);removed_proxies.append(g)
                elif len(kept)<steps+1:
                    # Native outlines here intersect the board once. Do not
                    # bridge across a cutout if future geometry changes.
                    assert kept==list(range(kept[0],kept[-1]+1)),('disjoint silk clipping',f.GetReference(),a,c)
                    first=tuple(a[j]+(c[j]-a[j])*kept[0]/steps for j in [0,1]);last=tuple(a[j]+(c[j]-a[j])*kept[-1]/steps for j in [0,1])
                    g.SetStart(vec(first));g.SetEnd(vec(last));report['clipped_segments'].append({'ref':f.GetReference(),'uuid':str(g.m_Uuid.AsString()),'start':first,'end':last})
    labels={'USB':('USB',(59.6,1.4)), 'BAT':('BAT',(58.5,11.4)),
            'BAT+':('+',(64.7,15.2)),'BAT-':('-',(64.7,17.2)),
            'D1-K':('K',(8.1,4.2)),'D2-K':('K',(18.1,4.2)),'D3-K':('K',(28.1,4.2))}
    circles={'U1-pin1':(61.9,37.1),'U3-pin1':(55.65,7.65),'U4-pin1':(55.65,21.2)}
    owned={uid(key) for key in list(labels)+list(circles)}
    for drawing in list(b.GetDrawings()):
        if str(drawing.m_Uuid.AsString()) in owned:b.Remove(drawing)
    assert next(p for p in fps['J2'].Pads() if p.GetNumber()=='1').GetNetname()=='BAT'
    assert next(p for p in fps['J2'].Pads() if p.GetNumber()=='2').GetNetname()=='GND'
    for ref in ['D1','D2','D3']:
        assert next(p for p in fps[ref].Pads() if p.GetNumber()=='1').GetNetname()=='GND'
    for key,(word,position) in labels.items():
        text=k.PCB_TEXT(b);text.SetUuid(k.KIID(uid(key)));text.SetText(word);text.SetPosition(vec(position));text.SetLayer(k.F_SilkS)
        text.SetTextSize(k.VECTOR2I(k.FromMM(.8),k.FromMM(.8)));text.SetTextThickness(k.FromMM(.15));b.Add(text)
        report['added_labels'].append({'text':word,'xy':position})
    for key,position in circles.items():
        shape=k.PCB_SHAPE(b);shape.SetUuid(k.KIID(uid(key)));shape.SetShape(k.SHAPE_T_CIRCLE);shape.SetLayer(k.F_SilkS)
        shape.SetStart(vec(position));shape.SetEnd(vec((position[0]+.15,position[1])));shape.SetWidth(k.FromMM(.15));b.Add(shape)
        report['pin1_markers'].append({'ref':key.split('-')[0],'xy':position,'diameter_mm':.3,'stroke_mm':.15})
    assert immutable(b)==before,'Non-silkscreen geometry changed'
    report['copper_pads_placement_edges_zones_unchanged']=True
    report['reference_text_height_mm']=.8;report['reference_text_stroke_mm']=.15
    report['hidden_refs_available_in']='BOM/placement and assembly drawing; native fabrication outlines and reference placeholders retained'
    return report
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',type=Path);args=parser.parse_args();app=wx.App(False)
    OUT.mkdir(parents=True,exist_ok=True)
    target=args.apply.resolve() if args.apply else OUT/'fieldnote.kicad_pcb'
    if not args.apply:
        for pattern in ['*.kicad_sch','fieldnote.kicad_pro','Fieldnote.kicad_sym','sym-lib-table','fp-lib-table']:
            for source in ROOT.glob(pattern):shutil.copyfile(source,OUT/source.name)
        shutil.copytree(ROOT/'Fieldnote.pretty',OUT/'Fieldnote.pretty',dirs_exist_ok=True)
        shutil.copyfile(ROOT/'fieldnote.kicad_pcb',target)
    b=k.LoadBoard(str(target));report=cleanup(b);k.SaveBoard(str(target),b)
    report['board']=str(target);(OUT/'silk-cleanup.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'board':str(target),'hidden_refs':len(report['hidden_refs']),'retained_refs':len(report['retained_refs']),'removed_segments':len(report['removed_segments']),'clipped_segments':len(report['clipped_segments']),'non_silk_geometry_unchanged':True}))
if __name__=='__main__':main()
