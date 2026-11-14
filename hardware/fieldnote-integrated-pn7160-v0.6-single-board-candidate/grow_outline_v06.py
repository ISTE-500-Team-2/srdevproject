#!/usr/bin/env python3
"""Grow the v0.5 outline (right edge x 74, y 0..37) to x 110 full height, keeping a notch at x 65.5..76.5,
y 37..45.2 so copper stays >= 15 mm from the ESP32-C3 antenna end (x 61.5). Text edit of the saved board."""
import re, sys, uuid, json, hashlib
from pathlib import Path
p = Path(sys.argv[1]); t = p.read_text(); before = hashlib.sha256(t.encode()).hexdigest()
old = '(xy 134 50) (xy 134 87) (xy 125.5 87)'
n = t.count(old); assert n == 4, n
t = t.replace(old, '(xy 170 50) (xy 170 95.2) (xy 136.5 95.2) (xy 136.5 87) (xy 125.5 87)')
blocks = list(re.finditer(r'\t\(gr_line\n.*?\n\t\)\n', t, re.S))
def find(s, e):
    h = [m for m in blocks if f'(start {s})' in m.group(0) and f'(end {e})' in m.group(0) and '"Edge.Cuts"' in m.group(0)]
    assert len(h) == 1, (s, e, len(h)); return h[0]
top, right, step = find('120 50', '134 50'), find('134 50', '134 87'), find('134 87', '125.5 87')
tpl = right.group(0)
def line(a, b):
    s = re.sub(r'\(start [^)]*\)', f'(start {a})', tpl); s = re.sub(r'\(end [^)]*\)', f'(end {b})', s)
    return re.sub(r'\(uuid "[^"]*"\)', f'(uuid "{uuid.uuid5(uuid.NAMESPACE_URL, "fieldnote-v06-edge:" + a + ":" + b)}")', s)
repl = {top.span(): top.group(0).replace('(end 134 50)', '(end 170 50)'),
        right.span(): line('170 50', '170 95.2') + line('170 95.2', '136.5 95.2') + line('136.5 95.2', '136.5 87'),
        step.span(): step.group(0).replace('(start 134 87)', '(start 136.5 87)')}
for (a, b_), s in sorted(repl.items(), reverse=True): t = t[:a] + s + t[b_:]
p.write_text(t); print(json.dumps({'zones': n, 'before': before[:16], 'after': hashlib.sha256(t.encode()).hexdigest()[:16]}))
