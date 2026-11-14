#!/bin/zsh
# Full v0.5.4 pipeline from the frozen v0.5.3 board (source-v053/, read-only). Re-runnable: every step starts from source-v053.
# Numerics for the antenna study run on tools/pylibs (numpy/scipy) and tools/fasthenry (copies of the study's temp toolchain).
set -e
cd "${0:A:h}"
PY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
CLI=/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli
HERE="${0:A:h}"
np() { PYTHONPATH="$HERE/tools/pylibs" /usr/bin/python3 -B "$@" }
F='Debug:|duplicate image|^$|assert |stdpbase|swig'
rm -f '~fieldnote.kicad_pro.lck' '~fieldnote.kicad_pcb.lck'
(cd source-v053 && shasum -a 256 -c ../output/source-v053.SHA256SUMS | grep -c OK)
$PY prepare_v054.py 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-200
$CLI sch erc --severity-all --format json -o output/erc-v054.json fieldnote.kicad_sch 2>&1 | grep Found
for ph in textprep surgery place; do
  $PY apply_v054_pcb.py $ph 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-200
  cp fieldnote.kicad_pcb output/v054-after-$ph.kicad_pcb
done
$PY apply_v054_pcb.py route 2>&1 | grep -v -E "$F" > output/v054-routing.log; tail -1 output/v054-routing.log | cut -c1-400
cp fieldnote.kicad_pcb output/v054-after-route.kicad_pcb
for ph in necks teardrops finish; do
  $PY apply_v054_pcb.py $ph 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-600
  cp fieldnote.kicad_pcb output/v054-after-$ph.kicad_pcb
done
$CLI pcb drc --severity-all --schematic-parity --refill-zones --format json -o output/v054-drc.json fieldnote.kicad_pcb 2>&1 | grep Found
$PY apply_v054_pcb.py audit 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-800
for v in top bottom; do
  $CLI pcb render --side $v --quality high --use-board-stackup-colors --width 2400 --height 1600 --zoom 1.0 -o output/v054-render-$v.png fieldnote.kicad_pcb 2>&1 | grep -v -E "$F" | tail -1
done
$CLI pcb render --side top --quality high --use-board-stackup-colors --perspective --rotate '-40,0,30' --width 2400 --height 1600 --zoom 0.85 -o output/v054-render-iso.png fieldnote.kicad_pcb 2>&1 | grep -v -E "$F" | tail -1
# RF geometry vs the antenna study (read-only): the study's own route extractor, then the coil-surroundings / GND-fill check
np ../nfc-antenna-study/scripts/extract_rf_routes.py fieldnote.kicad_pcb output/v054-rf-routes.json > /dev/null
/usr/bin/python3 -c "import json; a=json.load(open('../nfc-antenna-study/results/rf-routes.json'))['nets']; b=json.load(open('output/v054-rf-routes.json'))['nets']; print('RF nets vs nfc-antenna-study rf-routes.json:', 'IDENTICAL' if a == b else 'DIFFERENT', len(b)); assert a == b"
$PY rf_geometry_check.py 2>&1 | grep -v -E "$F" | tail -1 | cut -c1-200
# antenna re-validation: copper raster of v0.5.3 and v0.5.4, FastHenry (study model + strip-grid board copper), matching check
mkdir -p output/antenna
$PY rf_planes_raster.py source-v053/fieldnote.kicad_pcb output/antenna/mask-v053.json 2>&1 | grep -v -E "$F" | tail -1
$PY rf_planes_raster.py fieldnote.kicad_pcb output/antenna/mask-v054.json 2>&1 | grep -v -E "$F" | tail -1
for c in study band gridrect:10.7 gridrect:9.6 grid:v053=output/antenna/mask-v053.json grid:v054=output/antenna/mask-v054.json; do
  np antenna_fasthenry.py output/antenna "$c" > "output/antenna/run-${c%%=*}.log" 2>&1 &
done
wait
cat output/antenna/run-*.log | grep '"case"' | cut -c1-160
np antenna_matching.py output/antenna/fasthenry-*.json | tail -3
/usr/bin/python3 -B power_budget.py > /dev/null
shasum -a 256 fieldnote.kicad_pcb fieldnote.kicad_sch usb-power.kicad_sch esp32-leds.kicad_sch pn7160.kicad_sch nfc-rf.kicad_sch design-data.json \
  output/v054-antenna-revalidation.json output/v054-power-budget.json > output/v054.SHA256SUMS; cat output/v054.SHA256SUMS
