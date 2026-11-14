#!/usr/bin/env python3
"""Extract actual native PCB pads and copper for the review drawing.

Run using KiCad's bundled Python with its pcbnew site-packages on PYTHONPATH.
"""
from pathlib import Path
import json, hashlib
import pcbnew

ROOT=Path(__file__).resolve().parent
SOURCE=ROOT/'fieldnote-carrier.kicad_pcb'
board=pcbnew.LoadBoard(str(SOURCE))
def xy(v):return [pcbnew.ToMM(v.x)-50,pcbnew.ToMM(v.y)-50]
out={'source':SOURCE.name,'source_sha256':hashlib.sha256(SOURCE.read_bytes()).hexdigest(),'pads':[],'segments':[],'vias':[]}
for fp in board.GetFootprints():
    for p in fp.Pads():out['pads'].append({'ref':fp.GetReference(),'pin':p.GetNumber(),'net':p.GetNetname(),'xy':xy(p.GetPosition()),'size':[pcbnew.ToMM(p.GetSize().x),pcbnew.ToMM(p.GetSize().y)],'drill':[pcbnew.ToMM(p.GetDrillSize().x),pcbnew.ToMM(p.GetDrillSize().y)]})
for t in board.GetTracks():
    if isinstance(t,pcbnew.PCB_VIA):out['vias'].append({'net':t.GetNetname(),'xy':xy(t.GetPosition()),'size':pcbnew.ToMM(t.GetWidth(pcbnew.F_Cu)),'drill':pcbnew.ToMM(t.GetDrillValue())})
    else:out['segments'].append({'net':t.GetNetname(),'start':xy(t.GetStart()),'end':xy(t.GetEnd()),'width':pcbnew.ToMM(t.GetWidth()),'layer':board.GetLayerName(t.GetLayer())})
(ROOT/'output/native-geometry.json').write_text(json.dumps(out,indent=2)+'\n')
print(f'Extracted {len(out["pads"])} pads, {len(out["segments"])} segments and {len(out["vias"])} vias.')
