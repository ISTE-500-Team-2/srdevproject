#!/bin/zsh
# Full v0.5.3 pipeline from the frozen v0.5.2 board (source-v052/, read-only). Re-runnable: every step starts from source-v052.
set -e
cd "${0:A:h}"
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
CLI=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
F='Debug:|duplicate image|^$|assert|stdpbase|swig'
rm -f '~fieldnote.kicad_pro.lck' '~fieldnote.kicad_pcb.lck'
(cd source-v052 && shasum -a 256 -c ../output/source-v052.SHA256SUMS | grep -c OK)
$PY prepare_v053.py 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-200
$CLI sch erc --severity-all --format json -o output/erc-v053.json fieldnote.kicad_sch 2>&1 | grep Found
for ph in textprep surgery place; do
  $PY apply_v053_pcb.py $ph 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-200
  cp fieldnote.kicad_pcb output/v053-after-$ph.kicad_pcb
done
$PY apply_v053_pcb.py route 2>&1 | grep -v -E "$F" > output/v053-routing.log; tail -1 output/v053-routing.log | cut -c1-400
cp fieldnote.kicad_pcb output/v053-after-route.kicad_pcb
for ph in necks teardrops finish; do
  $PY apply_v053_pcb.py $ph 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-600
  cp fieldnote.kicad_pcb output/v053-after-$ph.kicad_pcb
done
$CLI pcb drc --severity-all --schematic-parity --refill-zones --format json -o output/v053-drc.json fieldnote.kicad_pcb 2>&1 | grep Found
$PY apply_v053_pcb.py audit 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-600
for v in top bottom; do
  $CLI pcb render --side $v --quality high --use-board-stackup-colors --width 2400 --height 1600 --zoom 1.0 -o output/v053-render-$v.png fieldnote.kicad_pcb 2>&1 | grep -v -E "$F" | tail -1
done
$CLI pcb render --side top --quality high --use-board-stackup-colors --perspective --rotate '-40,0,30' --width 2400 --height 1600 --zoom 0.85 -o output/v053-render-iso.png fieldnote.kicad_pcb 2>&1 | grep -v -E "$F" | tail -1
# RF geometry vs the antenna study (read-only): the study's own route extractor, then the coil-surroundings / GND-fill check
PYTHONPATH=${RF_PYLIBS:-/private/tmp/claude-501/-Users-maximusregent-Documents-ChatGPT-Senior-Dev/c402f4fa-1b5b-46d3-bc41-aa4f2c275c74/scratchpad/pylibs} \
  /usr/bin/python3 -B ../nfc-antenna-study/scripts/extract_rf_routes.py fieldnote.kicad_pcb output/v053-rf-routes.json > /dev/null
/usr/bin/python3 -c "import json; a=json.load(open('../nfc-antenna-study/results/rf-routes.json'))['nets']; b=json.load(open('output/v053-rf-routes.json'))['nets']; print('RF nets vs nfc-antenna-study rf-routes.json:', 'IDENTICAL' if a == b else 'DIFFERENT', len(b))"
$PY rf_geometry_check.py 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-200
shasum -a 256 fieldnote.kicad_pcb fieldnote.kicad_sch usb-power.kicad_sch esp32-leds.kicad_sch pn7160.kicad_sch nfc-rf.kicad_sch field-interface.kicad_sch design-data.json > output/v053.SHA256SUMS; cat output/v053.SHA256SUMS
