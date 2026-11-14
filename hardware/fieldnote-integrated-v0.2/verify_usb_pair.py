"""Read-only USB geometry/reference audit of a specified immutable PCB snapshot.

Defaults retain the original USB-candidate location. For a final revision use
--board SNAPSHOT --out DIRECTORY --expected-sha256 HASH. Native DRC is run
without refill/save; neither this checker nor KiCad DRC saves the input PCB.
"""
from pathlib import Path
import argparse,collections,hashlib,heapq,json,math,subprocess
import pcbnew as k
import wx
from usb_pair_seed import ROOT,NETS,OUT,vec,xy
CLI=Path('/private/tmp/fieldnote-kicad-runtime/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def signature(item):
    if 'via' in item:return ('via',item['net'],tuple(item['via']),round(item['width'],6),round(item['drill'],6),item['locked'])
    a,c=sorted([tuple(item['a']),tuple(item['b'])]);return ('track',item['net'],item['layer'],a,c,round(item['width'],6),item['locked'])
def track_geometry(t,b):
    d={'uuid':str(t.m_Uuid.AsString()),'net':t.GetNetname(),'width':k.ToMM(t.GetWidth(k.F_Cu) if isinstance(t,k.PCB_VIA) else t.GetWidth()),'locked':t.IsLocked()}
    if isinstance(t,k.PCB_VIA):d.update(via=xy(t.GetPosition()),drill=k.ToMM(t.GetDrillValue()),layers=[b.GetLayerName(l) for l in [k.F_Cu,k.B_Cu]])
    else:d.update(a=xy(t.GetStart()),b=xy(t.GetEnd()),layer=b.GetLayerName(t.GetLayer()))
    return d

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--board',type=Path,default=OUT/'fieldnote.kicad_pcb')
    parser.add_argument('--out',type=Path,default=OUT)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--seed',type=Path,default=OUT/'usb-routes.json')
    parser.add_argument('--seed-board',type=Path,default=OUT/'fieldnote.kicad_pcb')
    parser.add_argument('--sample-step-mm',type=float,default=.05)
    args=parser.parse_args();assert 0<args.sample_step_mm<=.1
    board=args.board.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True);before=sha(board)
    if args.expected_sha256:assert before==args.expected_sha256,('Unexpected snapshot hash',before,args.expected_sha256)
    app=wx.App(False);b=k.LoadBoard(str(board));footprints=list(b.GetFootprints());refs={f.GetReference():f for f in footprints};native_tracks=list(b.GetTracks());native_zones=list(b.Zones())
    def pad(ref,num):return next(p for p in refs[ref].Pads() if p.GetNumber()==str(num))
    def node(p,layer,net):return tuple(round(float(v),6) for v in p)+(layer,net)
    graph={};via_list=[];tracks=[];pads=[]
    def edge(a,c,length,vias=0):
        graph.setdefault(a,[]).append((c,length,vias));graph.setdefault(c,[]).append((a,length,vias))
    for t in native_tracks:
        isvia=isinstance(t,k.PCB_VIA);net=t.GetNetname();geometry=track_geometry(t,b);tracks.append(geometry)
        if isvia:via_list.append({'uuid':geometry['uuid'],'net':net,'xy':xy(t.GetPosition()),'diameter_mm':k.ToMM(t.GetWidth(k.F_Cu)),'drill_mm':k.ToMM(t.GetDrillValue())})
        if net not in NETS:continue
        if isvia:
            p=xy(t.GetPosition());edge(node(p,'F.Cu',net),node(p,'B.Cu',net),1.6,1)
        else:
            a,c=xy(t.GetStart()),xy(t.GetEnd());layer=b.GetLayerName(t.GetLayer());edge(node(a,layer,net),node(c,layer,net),math.dist(a,c))
    for ref in ['R3','R4']:
        a,c=pad(ref,1),pad(ref,2);edge(node(xy(a.GetPosition()),'F.Cu',a.GetNetname()),node(xy(c.GetPosition()),'F.Cu',c.GetNetname()),0)
    def shortest(start,end):
        queue=[(0,0,start)];seen=set()
        while queue:
            length,nvia,current=heapq.heappop(queue)
            if current in seen:continue
            seen.add(current)
            if current==end:return {'copper_path_mm':round(length-1.6*nvia,6),'through_vias_in_path':nvia,'path_including_nominal_1_6_mm_via_barrel_mm':round(length,6)}
            for nxt,increment,nviainc in graph.get(current,[]):
                if nxt not in seen:heapq.heappush(queue,(length+increment,nvia+nviainc,nxt))
        return None
    paths={}
    for conn,target in [('A6','27'),('B6','27'),('A7','26'),('B7','26')]:
        a,c=pad('J1',conn),pad('U1',target);paths[conn]=shortest(node(xy(a.GetPosition()),'F.Cu',a.GetNetname()),node(xy(c.GetPosition()),'F.Cu',c.GetNetname()))
    protected_paths={}
    for signal,sref,snum,eref,enum in [('DM','U5','1','R3','1'),('DP','U5','3','R4','1')]:
        a,c=pad(sref,snum),pad(eref,enum);protected_paths[signal]=shortest(node(xy(a.GetPosition()),'F.Cu',a.GetNetname()),node(xy(c.GetPosition()),'F.Cu',c.GetNetname()))
    seed=json.loads(args.seed.read_text());original=collections.Counter(signature(t) for t in seed['tracks']);actual=collections.Counter(signature(t) for t in tracks);missing_seed=list((original-actual).elements())
    pad_changes=[]
    for key,expected in seed['expected_pads'].items():
        ref,num=key.split(':');actual_pos=xy(pad(ref,num).GetPosition())
        if math.dist(actual_pos,expected)>1e-5:pad_changes.append({'pad':key,'expected':expected,'actual':actual_pos})
    original_board=k.LoadBoard(str(args.seed_board.resolve()));original_zones=list(original_board.Zones())
    def keepout(z):
        return {'name':z.GetZoneName(),'layers':[b.GetLayerName(l) for l in z.GetLayerSet().Seq()],'rule_area':z.GetIsRuleArea(),'no_tracks':z.GetDoNotAllowTracks(),'no_vias':z.GetDoNotAllowVias(),'no_pads':z.GetDoNotAllowPads(),'no_zone_fill':z.GetDoNotAllowZoneFills(),'outline':z.Outline().Format()}
    original_keepouts={z.GetZoneName():keepout(z) for z in original_zones if z.GetZoneName().startswith('USB In2 reference -')}
    final_keepouts={z.GetZoneName():keepout(z) for z in native_zones if z.GetZoneName().startswith('USB In2 reference -')}
    assert len(original_keepouts)==2
    ground_zones={layer:[z for z in native_zones if not z.GetIsRuleArea() and z.GetNetname()=='GND' and layer in z.GetLayerSet().Seq()] for layer in [k.In1_Cu,k.In2_Cu]}
    ground={layer:[z.GetFilledPolysList(layer) for z in ground_zones[layer]] for layer in ground_zones}
    def covered(p,layer):return any(poly.Contains(vec(p)) for poly in ground[layer])
    def antipad_sources(p,reference):
        # Normal manufactured void radius is the via land plus GND pour
        # clearance. Extra .025mm accounts for polygon-fill rounding only.
        clearance=max(k.ToMM(z.GetLocalClearance()) for z in ground_zones[reference])
        return [v for v in via_list if v['net']!='GND' and math.dist(p,v['xy']) <= v['diameter_mm']/2+clearance+.025]
    missing=[];antipads=[];center_sampled=0;edge_sampled=0;segments=[]
    for t in native_tracks:
        if isinstance(t,k.PCB_VIA) or t.GetNetname() not in NETS:continue
        a,c=xy(t.GetStart()),xy(t.GetEnd());layer=t.GetLayer();reference=k.In1_Cu if layer==k.F_Cu else k.In2_Cu
        assert layer in [k.F_Cu,k.B_Cu],('Unsupported USB signal layer',b.GetLayerName(layer))
        length=math.dist(a,c);steps=max(1,math.ceil(length/args.sample_step_mm));width=k.ToMM(t.GetWidth());nx,ny=-(c[1]-a[1])/length,(c[0]-a[0])/length
        center_status=[]
        for i in range(steps+1):
            center=[a[j]+(c[j]-a[j])*i/steps for j in [0,1]]
            for label,offset in [('center',0),('edge+',width/2),('edge-',-width/2)]:
                p=(center[0]+nx*offset,center[1]+ny*offset)
                if label=='center':center_sampled+=1
                else:edge_sampled+=1
                if covered(p,reference):
                    if label=='center':center_status.append('covered')
                    continue
                sources=antipad_sources(p,reference);row={'track_uuid':str(t.m_Uuid.AsString()),'net':t.GetNetname(),'xy':[round(v,5) for v in p],'cross_section':label,'reference':b.GetLayerName(reference)}
                if sources:
                    row['antipads']=[{'uuid':v['uuid'],'net':v['net'],'xy':v['xy'],'diameter_mm':v['diameter_mm']} for v in sources];antipads.append(row)
                    if label=='center':center_status.append('antipad')
                else:
                    missing.append(row)
                    if label=='center':center_status.append('gap')
        longest=run=0
        for status in center_status:
            run=run+1 if status!='covered' else 0;longest=max(longest,run)
        segments.append({'uuid':str(t.m_Uuid.AsString()),'net':t.GetNetname(),'signal_layer':b.GetLayerName(layer),'reference_layer':b.GetLayerName(reference),'length_mm':length,'center_samples':len(center_status),'covered_center_samples':center_status.count('covered'),'normal_antipad_center_samples':center_status.count('antipad'),'unexplained_gap_center_samples':center_status.count('gap'),'maximum_sampled_void_run_mm':round(longest*length/steps,6)})
    returns=[]
    for signal in [v for v in via_list if v['net'] in NETS]:
        candidates=[v for v in via_list if v['net']=='GND' and all(covered(v['xy'],layer) for layer in [k.In1_Cu,k.In2_Cu])]
        near=min(candidates,key=lambda v:math.dist(signal['xy'],v['xy']))
        returns.append({'signal_via_uuid':signal['uuid'],'signal_net':signal['net'],'signal_xy':signal['xy'],'nearest_ground_via_uuid':near['uuid'],'ground_xy':near['xy'],'distance_mm':round(math.dist(signal['xy'],near['xy']),6),'ground_via_touches_both_reference_fills':True})
    for f in footprints:
        for p in f.Pads():
            bb=p.GetBoundingBox();pads.append({'ref':f.GetReference(),'num':p.GetNumber(),'net':p.GetNetname(),'pos':xy(p.GetPosition()),'bounds':[xy(bb.GetOrigin()),[k.ToMM(bb.GetWidth()),k.ToMM(bb.GetHeight())]],'layers':[b.GetLayerName(l) for l in p.GetLayerSet().Seq() if b.GetLayerName(l).endswith('.Cu')]})
    (out/'copper-geometry.json').write_text(json.dumps({'tracks':tracks,'pads':pads},indent=2)+'\n')
    native_report=out/'drc.json'
    run=subprocess.run([str(CLI),'pcb','drc','--format','json','--schematic-parity','--all-track-errors','-o',str(native_report),str(board)],capture_output=True,text=True)
    assert run.returncode==0,(run.returncode,run.stdout,run.stderr)
    drc=json.loads(native_report.read_text());errors=[v for v in drc['violations'] if v['severity']=='error'];usb_unconnected=[v for v in drc['unconnected_items'] if any(any(n in i['description'] for n in NETS) for i in v['items'])]
    after=sha(board);assert before==after,'Input board changed during read-only verification'
    result={'board':str(board),'board_sha256':before,'board_sha256_after':after,'input_board_unchanged':True,
            'seed_geometry':{'expected_items':sum(original.values()),'preserved_items':sum(original.values())-len(missing_seed),'missing_items':missing_seed,'expected_pad_positions_unchanged':not pad_changes,'changed_pads':pad_changes,'usb_reference_keepouts_unchanged':original_keepouts==final_keepouts,'reference_keepout_names':list(final_keepouts)},
            'native_drc_errors':errors,'native_drc_warnings_by_type':{key:sum(v['type']==key for v in drc['violations']) for key in sorted(set(v['type'] for v in drc['violations']))},'all_unconnected_items':drc['unconnected_items'],'usb_unconnected':usb_unconnected,'schematic_parity':drc['schematic_parity'],
            'paths':paths,'esd_output_to_series_resistor_paths':protected_paths,
            'esd_to_series_resistor_length_difference_mm':round(abs(protected_paths['DM']['copper_path_mm']-protected_paths['DP']['copper_path_mm']),6) if all(protected_paths.values()) else None,
            'main_pair_nominal_geometry_preserved_from_seed':{'trace_width_mm':seed['trace_width_mm'],'edge_gap_mm':seed['main_pair_gap_mm'],'center_spacing_mm':seed['pair_center_spacing_mm'],'narrow_escape_width_mm':seed['narrow_escape_width_mm'],'ordinary_via_diameter_drill_mm':[seed['ordinary_via_diameter_mm'],seed['ordinary_via_drill_mm']]},
            'no_signal_tracks_on_In1_Cu':not any(not isinstance(t,k.PCB_VIA) and t.GetLayer()==k.In1_Cu and t.GetNetname()!='GND' for t in native_tracks),
            'reference_sample_step_mm':args.sample_step_mm,'reference_center_samples':center_sampled,'reference_trace_edge_samples':edge_sampled,
            'reference_gaps_outside_normal_via_antipads':missing,'reference_missing_samples_inside_normal_via_antipads':len(antipads),
            'normal_antipad_sample_sources_by_net':dict(collections.Counter(v['net'] for a in antipads for v in a['antipads'])),
            'reference_segments':segments,'signal_via_ground_returns':returns,
            'U5_pin2_ground_pin5_VBUS_correct':pad('U5',2).GetNetname()=='GND' and pad('U5',5).GetNetname()=='VBUS',
            'limitations':['Reference checks sample existing native filled copper at centerline and trace edges; they are a geometric audit, not a field solver.',
                           'Normal via antipads are explicitly reported, including those of other nets; excluding them from unexplained gaps does not remove their physical return-path interruption.',
                           'Path barrel allowance is nominal 1.6mm per through-via. Connector/ESD/resistor package delays and full USB eye quality are not modeled.',
                           'Nominal .23/.15 main-pair geometry preserves the conditional impedance model. The fabrication stackup and manufactured impedance remain unconfirmed.']}
    result['checks_pass']=not errors and not drc['unconnected_items'] and not drc['schematic_parity'] and not missing_seed and not pad_changes and original_keepouts==final_keepouts and not missing and all(paths.values()) and result['U5_pin2_ground_pin5_VBUS_correct']
    (out/'usb-validation.json').write_text(json.dumps(result,indent=2)+'\n')
    (out/'reference-antipad-samples.json').write_text(json.dumps(antipads,indent=2)+'\n')
    print(json.dumps({key:result[key] for key in ['board_sha256','checks_pass','seed_geometry','paths','esd_to_series_resistor_length_difference_mm','reference_center_samples','reference_trace_edge_samples','reference_missing_samples_inside_normal_via_antipads','normal_antipad_sample_sources_by_net','reference_gaps_outside_normal_via_antipads']}))
if __name__=='__main__':main()
