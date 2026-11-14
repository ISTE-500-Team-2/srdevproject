#!/bin/zsh
# Full v0.5b layout pipeline from the post-surgery board.
set -e
cd "${0:A:h}"
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
F='Debug:|duplicate image|^$'
cp output/v05b-after-outline.kicad_pcb fieldnote.kicad_pcb
$PY apply_v05b_pcb.py place 2>&1 | grep -v -E "$F" > output/v05b-placement.log
cp fieldnote.kicad_pcb output/v05b-after-placement.kicad_pcb
$PY apply_v05b_pcb.py route 2>&1 | grep -v -E "$F" > output/v05b-routing.log
cp fieldnote.kicad_pcb output/v05b-after-routing.kicad_pcb
python3 -I grow_outline_text.py fieldnote.kicad_pcb > output/v05b-outline-text.log
$PY apply_v05b_pcb.py finish 2>&1 | grep -v -E "$F" > output/v05b-finish.log
kicad-cli pcb drc --severity-all --schematic-parity --refill-zones --format json -o output/v05b-drc.json fieldnote.kicad_pcb 2>&1 | grep Found
