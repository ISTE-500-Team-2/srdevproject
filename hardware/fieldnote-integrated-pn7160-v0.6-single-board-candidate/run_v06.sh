#!/bin/zsh
# Full v0.6 pipeline from the frozen v0.5 board.
set -e
cd "${0:A:h}"
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
F='Debug:|duplicate image|^$'
$PY prepare_v06.py 2>&1 | grep -v assert | tail -1
kicad-cli sch erc --severity-all --format json -o output/erc-v06.json fieldnote.kicad_sch 2>&1 | grep Found
cp source-v05/fieldnote.kicad_pcb fieldnote.kicad_pcb; chmod u+w fieldnote.kicad_pcb
$PY apply_v06_pcb.py surgery 2>&1 | grep -v -E "$F" | tail -1
python3 -I grow_outline_v06.py fieldnote.kicad_pcb
cp fieldnote.kicad_pcb output/v06-after-surgery-outline.kicad_pcb
$PY apply_v06_pcb.py place2 2>&1 | grep -v -E "$F" | tail -1
cp fieldnote.kicad_pcb output/v06-after-placement.kicad_pcb
$PY apply_v06_pcb.py route 2>&1 | grep -v -E "$F" > output/v06-routing.log; tail -1 output/v06-routing.log
cp fieldnote.kicad_pcb output/v06-after-routing.kicad_pcb
$PY apply_v06_pcb.py finish 2>&1 | grep -v -E "$F" | tail -1
kicad-cli pcb drc --severity-all --schematic-parity --refill-zones --format json -o output/v06-drc.json fieldnote.kicad_pcb 2>&1 | grep Found
