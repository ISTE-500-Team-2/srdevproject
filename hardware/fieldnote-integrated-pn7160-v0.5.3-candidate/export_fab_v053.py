#!/usr/bin/env python3
"""Run fab-export/export_fab.py on v0.5.3 into fab-export/out-v0.5.3/ without touching anything else in fab-export/.

* sourcing: fab-export/sourcing-map.json plus the v0.5.3 overlay below (new parts and the new LED resistor values), written to
  output/sourcing-map-v053.json and patched into tools/sourcing.MAP for this run only;
* cache: a copy of fab-export/cache in fab-cache/ (new JLC/LCSC/EasyEDA lookups land there, not in fab-export/cache);
* FAB-NOTES.md: export_fab.py hard-codes a green mask and the old case notch; the three affected rows are rewritten here from
  the board (black mask / white silk / ENIG from the stackup, outline without the notch, bottom silk = J6 only).
Usage: KiCad python export_fab_v053.py   (or any python3; it re-executes under KiCad's Python)
"""
import json, os, re, shutil, sys
sys.dont_write_bytecode = True        # do not touch fab-export/__pycache__
HERE = os.path.dirname(os.path.abspath(__file__))
FAB = os.path.join(os.path.dirname(HERE), 'fab-export')
OUT = os.path.join(FAB, 'out-v0.5.3')
sys.path.insert(0, FAB); sys.path.insert(0, os.path.join(FAB, 'tools'))
import kicad_env                      # noqa: E402
kicad_env.ensure_pcbnew()
import jlc_api, sourcing             # noqa: E402

OVERLAY = {
    'TPD1E05U06DPYR': {'lcsc': 'C436349', 'mfr': 'Texas Instruments',
                       'check': 'v0.5.3 D8/D9 USB-C CC1/CC2 ESD: genuine TI X1SON-2 (DPY0002A), VRWM 5.5 V, 0.42 pF. Same-MPN clones '
                                '(TECH PUBLIC C2937017 / C907835, BORN C2929229) exist in the library - do not let the assembler swap. '
                                'Pin 1 I/O, pin 2 GND.'},
    '0402WGF1002TCE': {'lcsc': 'C25744', 'mfr': 'UNI-ROYAL', 'check': 'v0.5.3 R47 IO_INT pull-up: 10k 1% 62.5 mW 0402 (JLC basic).'},
    'RC0603FR-07180RL': {'lcsc': 'C137786', 'mfr': 'YAGEO',
                         'check': 'v0.5.3 R38 RGB red current resistor 180R 1% 0603 (worst case 15.2 mA <= 16.9 mA, 45 C derating).',
                         'alts': [{'lcsc': 'C22828', 'mfr': 'UNI-ROYAL', 'mpn': '0603WAF1800T5E', 'check': '180R 1% 0603 100 mW - same value/tolerance.'}]},
    'RC0603FR-07120RL': {'lcsc': 'C114640', 'mfr': 'YAGEO', 'basic_alt': 'C22787',
                         'check': 'v0.5.3 R39/R40 RGB green/blue current resistor 120R 1% 0603 (worst case 16.0 mA <= 16.9 mA).'},
    'CC0603FRNPO9BN331': {'lcsc': 'C519562', 'mfr': 'YAGEO', 'check': 'v0.5.3 C24/C25 (C0) and C28/C29 (C2): 330 pF +-1 % NP0 50 V 0603 per nfc-antenna-study section 7. RF tuning value: no substitution of value or tolerance.'},
    'CC0603FRNPO9BN121': {'lcsc': 'C519498', 'mfr': 'YAGEO', 'check': 'v0.5.3 C26/C27 (C1): 120 pF +-1 % NP0 50 V 0603 per nfc-antenna-study section 7. RF tuning value.'},
    'CC0603FRNPO9BN150': {'lcsc': 'C519483', 'mfr': 'YAGEO', 'check': 'v0.5.3 C34/C35 (C2 trim, now fitted): 15 pF +-1 % NP0 50 V 0603 per nfc-antenna-study section 7.'},
    'CRCW08051R00FKEAHP': {'lcsc': 'C313850', 'mfr': 'Vishay', 'check': 'v0.5.3 R22/R23 (RQ): 1.0 ohm 1 % 0.5 W pulse-proof 0805, in series with the NFC coil (carries the coil current). Keep the 0.5 W HP part.'},
    'LQW18CNR16J00D': {'lcsc': 'C437367', 'mfr': 'Murata Electronics', 'check': 'v0.5.3 L1/L2 (L0): 160 nH 5 % wire-wound 0603, NXP-named LQW18CN series, 1 A, DCR <= 0.1 ohm. Value AND series matter; no substitution.'},
    'CC0603FRNPO9BN130': {'lcsc': 'C519488', 'mfr': 'YAGEO',
                          'check': 'v0.5.3 C22/C23 PN7160 crystal load caps: 13 pF +-1 % NP0 50 V 0603; replaces KEMET CBR06C130F5GAC (68 in stock).'},
}


def notes_fix(path, pcb):
    t = open(path).read()
    pc = open(pcb).read()
    mask = re.search(r'\(layer "F\.Mask"\s*\(type "[^"]+"\)\s*\(color "([^"]+)"\)', pc)
    silk = re.search(r'\(layer "F\.SilkS"\s*\(type "[^"]+"\)\s*\(color "([^"]+)"\)', pc)
    fin = re.search(r'\(copper_finish "([^"]+)"\)', pc)
    assert mask and silk and fin and mask.group(1) == 'Black' and silk.group(1) == 'White' and fin.group(1) == 'ENIG', 'stackup colours'
    rows = {
        '| Solder mask |': '| Solder mask | **BLACK**, both sides (board stackup colour); openings 1:1 with pads (mask expansion 0 in the Gerbers); do not add more than 0.05 mm |',
        '| Silkscreen |': '| Silkscreen | **WHITE**. Top: references, polarity marks, labels, title. Bottom: J6 header outline and reference only |',
        '| Outline |': '| Outline | non-rectangular (USB-C tongue x 47-60, right step at y 37, Wi-Fi antenna cut-out x 48.1-61.5 / y >= 38.7), '
                        '1.0 mm radius on every convex corner, internal corners at the router-bit radius: **CNC-routed edges only, no V-score**. '
                        'C41/C42/C44 and the USB-C shell sit near the right/top edges - no V-cut, no mouse-bite tab within 3 mm of them |',
    }
    out = []
    for line in t.split('\n'):
        for key, new in rows.items():
            if line.startswith(key): line = new
        out.append(line)
    t = '\n'.join(out)
    t = t.replace('| Surface finish | ENIG', '| Surface finish | **ENIG**')
    assert 'notch' not in t.lower() and 'green' not in t.lower(), 'stale notes'
    t += '\n## Board appearance (v0.5.3)\n\nBlack solder mask, white silkscreen, ENIG finish - set in the board stackup (`fieldnote.kicad_pcb`), so 3D renders ' \
         'and these notes agree. Order option at JLC: PCB colour **Black**, silkscreen **White**, surface finish **ENIG**.\n'
    open(path, 'w').write(t)


def main():
    cache = os.path.join(HERE, 'fab-cache')
    if not os.path.isdir(cache):
        shutil.copytree(os.path.join(FAB, 'cache'), cache)
    jlc_api.CACHE = cache
    m = json.load(open(os.path.join(FAB, 'sourcing-map.json')))
    for k_, v in OVERLAY.items():
        assert k_ not in m['parts'], k_
        m['parts'][k_] = v
    m['_about'] += ' v0.5.3 overlay (export_fab_v053.py): ' + ', '.join(OVERLAY)
    merged = os.path.join(HERE, 'output', 'sourcing-map-v053.json')
    json.dump(m, open(merged, 'w'), indent=2)
    sourcing.MAP = merged
    import export_fab
    sys.argv = ['export_fab.py', HERE, OUT, '--build', 'usb', '--qty', '10']
    export_fab.main()
    notes_fix(os.path.join(OUT, 'FAB-NOTES.md'), os.path.join(HERE, 'fieldnote.kicad_pcb'))


if __name__ == '__main__':
    main()
