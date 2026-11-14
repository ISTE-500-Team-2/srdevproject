#!/bin/zsh
# Full v0.5.1 pipeline from the frozen v0.5 board (source-v05/, read-only).
set -e
cd "${0:A:h}"
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
CLI=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
F='Debug:|duplicate image|^$|assert'
$PY prepare_v051.py 2>&1 | grep -v -E "$F" | tail -1
$CLI sch erc --severity-all --format json -o output/erc-v051.json fieldnote.kicad_sch 2>&1 | grep Found
for ph in textprep surgery place; do
  $PY apply_v051_pcb.py $ph 2>&1 | grep -v -E "$F" | tail -1
  cp fieldnote.kicad_pcb output/v051-after-$ph.kicad_pcb
done
$PY apply_v051_pcb.py vsys 2>&1 | grep -v -E "$F" | tail -1
cp fieldnote.kicad_pcb output/v051-after-vsys.kicad_pcb
$PY apply_v051_pcb.py route 2>&1 | grep -v -E "$F" > output/v051-routing.log; tail -1 output/v051-routing.log
cp fieldnote.kicad_pcb output/v051-after-route.kicad_pcb
$PY apply_v051_pcb.py finish 2>&1 | grep -v -E "$F" | tail -1
$CLI pcb drc --severity-all --schematic-parity --refill-zones --format json -o output/v051-drc.json fieldnote.kicad_pcb 2>&1 | grep Found
