"""Explicit PN3V/RF-only route patch; default creates a separate candidate.

No footprint/ground/USB/keepout changes. Deleted conductors are matched by net,
layer and exact endpoints; changes in the source make the patch fail closed.
--apply is reserved for the root agent's reviewed integration on an explicit
board, after checking the cloned candidate's native DRC.
"""
from pathlib import Path
import argparse,hashlib,json,math,shutil,heapq
import pcbnew as k
import wx
ROOT=Path(__file__).resolve().parent
OUT=ROOT/'output/routed-rf-candidate'

def xy(v):return [round(k.ToMM(v.x)-60,6),round(k.ToMM(v.y)-50,6)]
def vec(p):return k.VECTOR2I(k.FromMM(p[0]+60),k.FromMM(p[1]+50))

def point_seg(p,a,b):
    v=[b[0]-a[0],b[1]-a[1]];vv=v[0]**2+v[1]**2
    q=max(0.,min(1.,((p[0]-a[0])*v[0]+(p[1]-a[1])*v[1])/vv)) if vv else 0.
    return math.hypot(p[0]-a[0]-q*v[0],p[1]-a[1]-q*v[1])

def segdist(a,b,c,d):
    def cross(p,q,r):return (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])
    ca,cb,cc,cd=cross(a,b,c),cross(a,b,d),cross(c,d,a),cross(c,d,b)
    if ca*cb<0 and cc*cd<0:return 0.
    return min(point_seg(a,c,d),point_seg(b,c,d),point_seg(c,a,b),point_seg(d,a,b))

def collision_test(b,net,width,layer,all_pads=False):
    li=b.GetLayerID(layer);obstacles=[];rects=[];ts=list(b.GetTracks());fs=list(b.GetFootprints())
    for t in ts:
        if t.GetNetname()==net or not t.IsOnLayer(li):continue
        r=(k.ToMM(t.GetWidth(k.F_Cu)) if isinstance(t,k.PCB_VIA) else k.ToMM(t.GetWidth()))/2+width/2+.16
        obstacles.append((xy(t.GetStart()),xy(t.GetEnd()),r))
    for f in fs:
        for p in f.Pads():
            if (p.GetNetname()==net and not all_pads) or not p.IsOnLayer(li):continue
            bb=p.GetBoundingBox();a=xy(bb.GetPosition());c=xy(k.VECTOR2I(bb.GetX()+bb.GetWidth(),bb.GetY()+bb.GetHeight()))
            rects.append((a,c));obstacles.extend([([a[0],a[1]],[c[0],a[1]],width/2+.16),
                ([c[0],a[1]],[c[0],c[1]],width/2+.16),([c[0],c[1]],[a[0],c[1]],width/2+.16),
                ([a[0],c[1]],[a[0],a[1]],width/2+.16)])
    def clear(a,c):
        if any(p[0]<=a[0]<=q[0] and p[1]<=a[1]<=q[1] for p,q in rects):return False
        for p,q,r in obstacles:
            if max(a[0],c[0])+r<min(p[0],q[0]) or min(a[0],c[0])-r>max(p[0],q[0]) or \
               max(a[1],c[1])+r<min(p[1],q[1]) or min(a[1],c[1])-r>max(p[1],q[1]):continue
            if segdist(a,c,p,q)<r-1e-8:return False
        return True
    return clear

def multi_path(b,net,start,end,width,bounds):
    layers=['F.Cu','B.Cu','In2.Cu'];clear={l:collision_test(b,net,width,l) for l in layers}
    via_checks=[collision_test(b,net,.5,l,True) for l in ['F.Cu','B.Cu','In1.Cu','In2.Cu']]
    point=lambda u:(round(start[0]+u[1]*.1,6),round(start[1]+u[2]*.1,6))
    pq=[];best={};prev={};edges={};vcache={};goal=None;vis=0
    for li in range(len(layers)):
        u=(li,0,0,0);best[u]=0.;heapq.heappush(pq,(math.dist(start,end),0.,u))
    while pq and vis<150000:
        _,cost,u=heapq.heappop(pq)
        if cost>best[u]+1e-8:continue
        vis+=1;a=point(u);layer=layers[u[0]]
        if math.dist(a,end)<=.2 and clear[layer](a,end):goal=u;break
        opts=[]
        for dx,dy in [(1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)]:
            v=(u[0],u[1]+dx,u[2]+dy,u[3]);c=point(v)
            if not bounds[0]<=c[0]<=bounds[2] or not bounds[1]<=c[1]<=bounds[3]:continue
            key=(u[0],tuple(sorted([(u[1],u[2]),(v[1],v[2])])) )
            if key not in edges:edges[key]=clear[layer](a,c)
            if edges[key]:opts.append((v,math.hypot(dx,dy)*.1))
        if u[3]<2:
            key=u[1:3]
            if key not in vcache:vcache[key]=all(fn(a,a) for fn in via_checks)
            if vcache[key]:
                opts.extend([((li,u[1],u[2],u[3]+1),3.2) for li in range(len(layers)) if li!=u[0]])
        for v,add in opts:
            cc=cost+add
            if cc<best.get(v,1e99):best[v]=cc;prev[v]=u;heapq.heappush(pq,(cc+math.dist(point(v),end),cc,v))
    assert goal is not None,('NO_MULTI_LAYER_PATH',net,start,end,vis)
    states=[goal]
    while goal in prev:goal=prev[goal];states.append(goal)
    states.reverse();legs=[];vias=[];pts=[start];layer=layers[states[0][0]]
    for u in states[1:]:
        p=point(u);new=layers[u[0]]
        if new!=layer:
            legs.append((layer,pts));vias.append(p);layer=new;pts=[p]
        else:pts.append(p)
    pts.append(end);legs.append((layer,pts))
    simple=[]
    for layer,pts in legs:
        out=[pts[0]]
        for i in range(1,len(pts)-1):
            a,c,d=out[-1],pts[i],pts[i+1]
            if abs((c[0]-a[0])*(d[1]-c[1])-(c[1]-a[1])*(d[0]-c[0]))>1e-8:out.append(c)
        out.append(pts[-1]);simple.append((layer,out))
    return simple,vias

def automatic_path(b,net,start,end,width,layers,bounds):
    """Conservative 0.1mm A* path with a 20um clearance guard; no new vias."""
    paths=[];fs=list(b.GetFootprints());ts=list(b.GetTracks())
    for layer in layers:
        li=b.GetLayerID(layer);obstacles=[]
        for t in ts:
            if t.GetNetname()==net or not t.IsOnLayer(li):continue
            r=(k.ToMM(t.GetWidth(k.F_Cu)) if isinstance(t,k.PCB_VIA) else k.ToMM(t.GetWidth()))/2+width/2+.17
            obstacles.append((xy(t.GetStart()),xy(t.GetEnd()),r))
        for f in fs:
            for p in f.Pads():
                if p.GetNetname()==net or not p.IsOnLayer(li):continue
                bb=p.GetBoundingBox();a=xy(bb.GetPosition());c=xy(k.VECTOR2I(bb.GetX()+bb.GetWidth(),bb.GetY()+bb.GetHeight()))
                # Rectangle edges plus containment capture native copper bounds.
                obstacles.extend([([a[0],a[1]],[c[0],a[1]],width/2+.17),
                    ([c[0],a[1]],[c[0],c[1]],width/2+.17),
                    ([c[0],c[1]],[a[0],c[1]],width/2+.17),
                    ([a[0],c[1]],[a[0],a[1]],width/2+.17)])
        def clear(a,c):
            for p,q,r in obstacles:
                if max(a[0],c[0])+r<min(p[0],q[0]) or min(a[0],c[0])-r>max(p[0],q[0]) or \
                   max(a[1],c[1])+r<min(p[1],q[1]) or min(a[1],c[1])-r>max(p[1],q[1]):continue
                if segdist(a,c,p,q)<r-1e-8:return False
            return True
        if clear(start,end):paths.append((math.dist(start,end),layer,[start,end]));continue
        # Grid origin is the fixed existing via, so no roundoff breaks a joint.
        point=lambda u:(round(start[0]+u[0]*.1,6),round(start[1]+u[1]*.1,6))
        pq=[(math.dist(start,end),0.,(0,0))];best={(0,0):0.};prev={};goal=None;visited=0
        cache={}
        while pq and visited<70000:
            _,cost,u=heapq.heappop(pq)
            if cost>best[u]+1e-8:continue
            visited+=1;a=point(u)
            if math.dist(a,end)<=.2 and clear(a,end):goal=u;break
            for dx,dy in [(1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)]:
                v=(u[0]+dx,u[1]+dy);c=point(v)
                if not bounds[0]<=c[0]<=bounds[2] or not bounds[1]<=c[1]<=bounds[3]:continue
                pair=tuple(sorted([u,v]))
                if pair not in cache:cache[pair]=clear(a,c)
                if not cache[pair]:continue
                cc=cost+math.hypot(dx,dy)*.1
                if cc<best.get(v,1e99):best[v]=cc;prev[v]=u;heapq.heappush(pq,(cc+math.dist(c,end),cc,v))
        if goal is None:
            print(json.dumps(dict(no_path_layer=layer,net=net,visited=visited,
                closest_mm=min(math.dist(point(u),end) for u in best))),flush=True)
            continue
        pts=[end,point(goal)]
        while goal in prev:goal=prev[goal];pts.append(point(goal))
        pts.reverse()
        # Collapse collinear grid steps. Preserve 45-degree manufactured corners.
        out=[pts[0]]
        for i in range(1,len(pts)-1):
            a,c,d=out[-1],pts[i],pts[i+1]
            if abs((c[0]-a[0])*(d[1]-c[1])-(c[1]-a[1])*(d[0]-c[0]))>1e-8:out.append(c)
        out.append(pts[-1]);paths.append((sum(math.dist(a,c) for a,c in zip(out,out[1:])),layer,out))
    assert paths,('NO_CLEAR_PATH',net,start,end,layers)
    return min(paths,key=lambda v:v[0])

def apply(b,mode='all'):
    old=list(b.GetTracks());removed=[];made=[];auto=[]
    def remove(net,layer,a,c,via=False):
        found=[t for t in old if t not in removed and t.GetNetname()==net and
            isinstance(t,k.PCB_VIA)==via and (via or b.GetLayerName(t.GetLayer())==layer) and
            ((math.dist(xy(t.GetStart()),a)<1e-5 and math.dist(xy(t.GetEnd()),c)<1e-5) or
             (math.dist(xy(t.GetStart()),c)<1e-5 and math.dist(xy(t.GetEnd()),a)<1e-5))]
        assert len(found)==1,(net,layer,a,c,via,len(found))
        b.Remove(found[0]);removed.append(found[0])
    def route(net,points,width,layer):
        for a,c in zip(points,points[1:]):
            if math.dist(a,c)<1e-7:continue
            t=k.PCB_TRACK(b);t.SetStart(vec(a));t.SetEnd(vec(c));t.SetNet(b.FindNet(net))
            t.SetLayer(b.GetLayerID(layer));t.SetWidth(k.FromMM(width));t.SetLocked(True)
            b.Add(t);made.append(t)
    def automatic(net,a,c,width,layers,bounds):
        if layers==['MULTI']:
            legs,vias=multi_path(b,net,a,c,width,bounds)
            for layer,points in legs:route(net,points,width,layer)
            for p in vias:
                v=k.PCB_VIA(b);v.SetPosition(vec(p));v.SetWidth(k.FromMM(.5));v.SetDrill(k.FromMM(.2))
                v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet(net));v.SetLocked(True)
                v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(v);made.append(v)
            auto.append(dict(net=net,legs=legs,new_vias=vias))
        else:
            length,layer,points=automatic_path(b,net,a,c,width,layers,bounds)
            route(net,points,width,layer);auto.append(dict(net=net,length_mm=length,layer=layer,points=points))
    # Cut the old C14/C15→I0/C17 branch so the new short DVDD path is a tree.
    for a,c in [([46.7,26.475],[46.6716,26.4466]),([46.6716,26.4466],[43.2534,26.4466]),
                ([43.2534,26.4466],[41.4,28.85])]:remove('PN3V','B.Cu',a,c)
    automatic('PN3V',[38.25,21.05],[46.7,22.45],.2,['MULTI'],[35.5,18,47.3,30])
    # Replace the long AVDD→I0/C17 inner detour with a shorter back route.
    for a,c in [([37.1,26.25],[38.65,26.25]),([38.65,26.25],[40.3,27.9]),
                ([40.3,27.9],[41.4,27.9]),([41.4,27.9],[41.4,28.85])]:remove('PN3V','In2.Cu',a,c)
    automatic('PN3V',[37.1,26.25],[41.4,28.85],.2,['B.Cu','In2.Cu'],[36.3,25.8,42,30])
    # AVDD gets a short direct path to the nearby C16 bulk capacitor as well.
    for a,c in [([36.6,24.75],[36.6,25.75]),([36.6,25.75],[37.1,26.25])]:remove('PN3V','In2.Cu',a,c)
    route('PN3V',[[37.1,26.25],[36.45,25.6],[35.95,25.6]],.15,'F.Cu')
    if mode=='all':
        # Remove RF1_MATCH's two-via detour, keeping C28/C34 connected.
        for a,c in [([34,19.725],[34.875,19.725]),([34.875,19.725],[34.9,19.7]),
                    ([34,24.6625],[34.4,25.0625]),([34.4,25.0625],[34.4,25.2])]:
            remove('RF1_MATCH','F.Cu',a,c)
        for a,c in [([34.9,19.7],[33.7,20.9]),([33.7,20.9],[33.7,24.5]),
                    ([33.7,24.5],[34.4,25.2])]:remove('RF1_MATCH','B.Cu',a,c)
        for p in [[34.9,19.7],[34.4,25.2]]:remove('RF1_MATCH','',p,p,True)
        # Keep the input via; move the output via outside the resistor's paste
        # land, shortening the back detour and avoiding an ordinary via in pad.
        for p,size,drill in [([34.9,19.7],.6,.3),([34.3,25.45],.5,.2)]:
            v=k.PCB_VIA(b);v.SetPosition(vec(p));v.SetWidth(k.FromMM(size));v.SetDrill(k.FromMM(drill))
            v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNet(b.FindNet('RF1_MATCH'));v.SetLocked(True)
            v.SetFrontTentingMode(k.TENTING_MODE_TENTED);v.SetBackTentingMode(k.TENTING_MODE_TENTED);b.Add(v);made.append(v)
        route('RF1_MATCH',[[34,19.725],[34.875,19.725],[34.9,19.7]],.15,'F.Cu')
        route('RF1_MATCH',[[34,24.6625],[34.3,24.9625],[34.3,25.45]],.15,'F.Cu')
        automatic('RF1_MATCH',[34.9,19.7],[34.3,25.45],.2,['B.Cu'],[33.4,19.4,35.0,25.7])
        # Main RF2 shunt capacitors reach the series junction from the left of
        # C27/C29's other pads, preserving the loop copper exclusion boundary.
        for a,c in [([34,29.0125],[36.0925,29.0125]),([36.0925,29.0125],[36.6708,29.5908]),
                    ([36.6708,29.5908],[36.6708,32.7042]),([36.6708,32.7042],[34,35.375])]:
            remove('RF2_MATCH','F.Cu',a,c)
        route('RF2_MATCH',[[34,30.575],[33.275,31.3],[33.275,34.65],[34,35.375]],.15,'F.Cu')
        # RF2_FILTER's receive takeoff remains unchanged in this candidate:
        # fixed R25 placement and other receive conductors block a simple
        # shortened top route. This is disclosed in the routed RF model.
    b.BuildConnectivity();assert k.ZONE_FILLER(b).Fill(b.Zones())
    return dict(removed_count=len(removed),added_count=len(made),mode=mode,
                touched_nets=sorted({t.GetNetname() for t in removed+made}),automatic_routes=auto),old,removed,made

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--source',type=Path,default=ROOT/'fieldnote.kicad_pcb')
    ap.add_argument('--output',type=Path,default=OUT);ap.add_argument('--apply',type=Path)
    ap.add_argument('--mode',choices=['all','decoupling'],default='all');args=ap.parse_args()
    app=wx.App(False)
    source=args.apply or args.source;before=source.read_bytes();b=k.LoadBoard(str(source))
    fp_before={f.GetReference():(xy(f.GetPosition()),f.GetOrientationDegrees()) for f in b.GetFootprints()}
    result,old,removed,made=apply(b,args.mode)
    assert fp_before=={f.GetReference():(xy(f.GetPosition()),f.GetOrientationDegrees()) for f in b.GetFootprints()}
    if args.apply:target=source
    else:
        args.output.mkdir(parents=True,exist_ok=True)
        for p in ROOT.iterdir():
            if p.is_file() and (p.suffix in ['.kicad_pro','.kicad_sch','.kicad_sym','.kicad_dru'] or p.name in ['fp-lib-table','sym-lib-table']):
                shutil.copy2(p,args.output/p.name)
        for name in ['Fieldnote.pretty','fieldnote.pretty']:
            if (ROOT/name).exists():shutil.copytree(ROOT/name,args.output/name,dirs_exist_ok=True)
        target=args.output/'fieldnote.kicad_pcb'
    k.SaveBoard(str(target),b)
    result.update(source_path=str(source),source_sha256=hashlib.sha256(before).hexdigest(),
        candidate_path=str(target),candidate_sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
        placement_unchanged=True,status='PATCHED_REQUIRES_NATIVE_DRC')
    (target.parent/'rf-route-patch.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
