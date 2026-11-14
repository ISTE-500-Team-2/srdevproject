"""Assign local router rules without changing the schematic netlist.

In1.Cu is reserved for the ground plane. GND is finished with short return
stubs/vias and filled zones. ANT1's inner return is already joined to its
outer pin 2 by the footprint copper, which the DSN exporter omits.
"""
from pathlib import Path
import re
ROOT=Path(__file__).resolve().parent
path=ROOT/'output/fieldnote-seed.dsn'
s=path.read_text()
s=s.replace('(width 200)','(width 150)').replace('(clearance 37.5 (type smd_smd))',
                                                         '(clearance 150 (type smd_smd))')
start=s.index('    (class kicad_default')
stop=s.index('  (wiring',start)
block=s[start:stop]
special=['GND','3V3','VSYS','VBUS','BAT','PN3V','NFC_VBAT']
for net in special: block=re.sub(r'(?<![\w-])'+net+r'(?![\w-])','',block)
s=s[:start]+block+s[stop:]
classes='    (class GND GND (rule (width 200) (clearance 150)))\n'
classes+='    (class POWER 3V3 VSYS VBUS BAT PN3V NFC_VBAT (rule (width 350) (clearance 150)))\n'
s=s.replace('    (class kicad_default',classes+'    (class kicad_default')
s=s.replace('R23-2 ANT1-2 ANT1-2@1','R23-2 ANT1-2@1')
(ROOT/'output/fieldnote-routing.dsn').write_text(s)
print('Prepared DSN with a reserved ground layer and explicit power widths.')
