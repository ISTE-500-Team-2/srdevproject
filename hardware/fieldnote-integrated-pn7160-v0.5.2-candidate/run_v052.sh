#!/bin/zsh
# Full v0.5.2 pipeline from the frozen v0.5.1 board (source-v051/, read-only). Re-runnable: every step starts from source-v051.
set -e
cd "${0:A:h}"
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
CLI=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
F='Debug:|duplicate image|^$|assert|stdpbase'
rm -f '~fieldnote.kicad_pro.lck'
(cd source-v051 && shasum -a 256 -c ../output/source-v051.SHA256SUMS | grep -c OK)
$PY prepare_v052.py 2>&1 | grep -v -E "$F" | tail -1
$CLI sch erc --severity-all --format json -o output/erc-v052.json fieldnote.kicad_sch 2>&1 | grep Found
for ph in textprep surgery place power; do
  $PY apply_v052_pcb.py $ph 2>&1 | grep -v -E "$F" | tail -1
  cp fieldnote.kicad_pcb output/v052-after-$ph.kicad_pcb
done
$PY apply_v052_pcb.py route 2>&1 | grep -v -E "$F" > output/v052-routing.log; tail -1 output/v052-routing.log
cp fieldnote.kicad_pcb output/v052-after-route.kicad_pcb
$PY apply_v052_pcb.py finish 2>&1 | grep -v -E "$F" | tail -1
$CLI pcb drc --severity-all --schematic-parity --refill-zones --format json -o output/v052-drc.json fieldnote.kicad_pcb 2>&1 | grep Found
$PY apply_v052_pcb.py audit 2>&1 | grep -v -E "$F" | tail -1
/usr/bin/python3 sim/run_sim.py 2>&1 | tail -1
$CLI pcb render --side top --quality high --width 2400 --height 1600 --zoom 1.0 -o output/v052-render-top.png fieldnote.kicad_pcb 2>&1 | grep -v -E "$F" | tail -1
shasum -a 256 fieldnote.kicad_pcb fieldnote.kicad_sch design-data.json > output/v052.SHA256SUMS; cat output/v052.SHA256SUMS
