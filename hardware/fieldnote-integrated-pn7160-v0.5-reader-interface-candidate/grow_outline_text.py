#!/usr/bin/env python3
"""Grow the board 8.5 mm on the right edge (x 65.5 -> 74.0 for y 0..37) by editing the saved PCB text.
Replaces the pcbnew-API outline phase, which segfaulted. Board coordinates are offset +60/+50 in the file."""
import re, sys, uuid, json, hashlib
from pathlib import Path
p = Path(sys.argv[1]); t = p.read_text()
before = hashlib.sha256(t.encode()).hexdigest()
old_pair = '(xy 125.5 50) (xy 125.5 95.2)'
n_zones = t.count(old_pair); assert n_zones == 4, n_zones
t = t.replace(old_pair, '(xy 134 50) (xy 134 87) (xy 125.5 87) (xy 125.5 95.2)')
# Edge.Cuts: find the gr_line blocks by their start/end pairs
blocks = list(re.finditer(r'\t\(gr_line\n.*?\n\t\)\n', t, re.S))
def find(start, end):
    hits = [m for m in blocks if f'(start {start})' in m.group(0) and f'(end {end})' in m.group(0) and '"Edge.Cuts"' in m.group(0)]
    assert len(hits) == 1, (start, end, len(hits)); return hits[0]
top = find('120 50', '125.5 50'); right = find('125.5 50', '125.5 95.2')
tpl = right.group(0)
def line(a, b):
    s = re.sub(r'\(start [^)]*\)', f'(start {a})', tpl); s = re.sub(r'\(end [^)]*\)', f'(end {b})', s)
    return re.sub(r'\(uuid "[^"]*"\)', f'(uuid "{uuid.uuid5(uuid.NAMESPACE_URL, "fieldnote-v05b-edge:" + a + ":" + b)}")', s)
new_top = top.group(0).replace('(end 125.5 50)', '(end 134 50)')
new_right = right.group(0).replace('(start 125.5 50)', '(start 125.5 87)')
extra = line('134 50', '134 87') + line('134 87', '125.5 87')
t = t[:top.start()] + new_top + t[top.end():right.start()] + new_right + extra + t[right.end():] if top.start() < right.start() else None
assert t is not None
p.write_text(t)
print(json.dumps({'zones_grown': n_zones, 'edges_added': 2, 'before': before[:16], 'after': hashlib.sha256(t.encode()).hexdigest()[:16]}))
