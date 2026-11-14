#!/usr/bin/env python3
"""Run fab-export/export_fab.py on v0.5.4 into fab-export/out-v0.5.4/ without touching anything else in fab-export/.

* sourcing: fab-export/sourcing-map.json + the v0.5.3 overlay (unchanged parts still on the board) + the v0.5.4 overlay below,
  written to output/sourcing-map-v054.json and patched into tools/sourcing.MAP for this run only;
* cache: a copy of fab-export/cache in fab-cache/ (new JLC/LCSC/EasyEDA lookups land there, not in fab-export/cache);
* FAB-NOTES.md: export_fab.py hard-codes v0.5.2 text (green mask, notch, J6/JP1/JP2/U10/5V_FIELD); those rows are rewritten here
  from the board (black mask / white silk / ENIG from the stackup) and the v0.5.4 part list.
Usage: KiCad python export_fab_v054.py   (or any python3; it re-executes under KiCad's Python)
"""
import json, os, re, shutil, sys
sys.dont_write_bytecode = True        # do not touch fab-export/__pycache__
HERE = os.path.dirname(os.path.abspath(__file__))
FAB = os.path.join(os.path.dirname(HERE), 'fab-export')
OUT = os.path.join(FAB, 'out-v0.5.4')
sys.path.insert(0, FAB); sys.path.insert(0, os.path.join(FAB, 'tools'))
import kicad_env                      # noqa: E402
kicad_env.ensure_pcbnew()
import jlc_api, sourcing             # noqa: E402

V053_OVERLAY = {
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

OVERLAY = {
    'WS2812B-2020-V6': {'lcsc': 'C52917434', 'mfr': 'Worldsemi',
                        'check': 'v0.5.4 D10-D19 light bar: VDD 3.3-5.3 V, 12 mA/channel, < 1 uA idle, 2 kHz PWM, -40..85 C, VIH 0.55 VDD. '
                                 'Pin 1 DO, 2 GND, 3 DI, 4 VDD - footprint drawn in the JLC library orientation; a reversed WS2812 dies: '
                                 'check every LED against orientation-overlay.png. Do not substitute another 2020 WS2812 revision without '
                                 're-checking VIH and the pinout.'},
    'SN74LVC1T45DBVR': {'lcsc': 'C7843', 'mfr': 'Texas Instruments',
                        'check': 'v0.5.4 U13 LED data level shifter, VCCA 3V3 / VCCB VSYS, DIR = VCCA. SOT-23-6 pin 1 VCCA (dot).'},
    'CUS-12TB': {'lcsc': 'C2921739', 'mfr': 'Nidec Components',
                 'check': 'v0.5.4 SW3 RUN/SVC service switch, side-actuated, NON-SHORTING (break-before-make) per Nidec datasheet. '
                          'Two 0.9 mm locating pegs go into the NPTH holes of the footprint; knob overhangs the right board edge 0.5 mm.'},
    'CL21A226MAQNNNE': {'lcsc': 'C45783', 'mfr': 'Samsung Electro-Mechanics', 'check': 'v0.5.4 C57 VSYS bulk at the LED bar, 22 uF 25 V X5R 0805 (basic).'},
    '0402WGF470JTCE': {'lcsc': 'C25118', 'mfr': 'UNI-ROYAL', 'check': 'v0.5.4 R48 47R 1% 0402 LED data series resistor.'},
    '0402WGF1003TCE': {'lcsc': 'C25741', 'mfr': 'UNI-ROYAL', 'check': 'v0.5.4 R49/R50 100k 1% 0402 LED data pulldowns (basic).'},
    'RC0603FR-071K3L': {'lcsc': 'C125319', 'mfr': 'YAGEO',
                        'check': 'v0.5.4 R6 BQ24074 ILIM 1.30k 1% 0603: 1142/1238/1336 mA input limit. 1 % tolerance matters (ILIM).',
                        'alts': [{'lcsc': 'C22767', 'mfr': 'UNI-ROYAL', 'mpn': '0603WAF1301T5E', 'check': '1.30k 1% 100 mW 0603 thick film, same value/tolerance.'}]},
}
STALE = ('RC0603FR-07180RL', 'RC0603FR-07120RL', '0402WGF1002TCE')    # v0.5.3 overlay entries whose parts were removed


def notes_fix(path, pcb):
    t = open(path).read()
    pc = open(pcb).read()
    mask = re.search(r'\(layer "F\.Mask"\s*\(type "[^"]+"\)\s*\(color "([^"]+)"\)', pc)
    silk = re.search(r'\(layer "F\.SilkS"\s*\(type "[^"]+"\)\s*\(color "([^"]+)"\)', pc)
    fin = re.search(r'\(copper_finish "([^"]+)"\)', pc)
    assert mask and silk and fin and mask.group(1) == 'Black' and silk.group(1) == 'White' and fin.group(1) == 'ENIG', 'stackup colours'
    rows = {
        '| Solder mask |': '| Solder mask | **BLACK**, both sides (board stackup colour); openings 1:1 with pads (mask expansion 0 in the Gerbers); do not add more than 0.05 mm |',
        '| Silkscreen |': '| Silkscreen | **WHITE**. Top: references, polarity marks, labels (RUN / SVC at SW3, USB-C 5V >=1.5A), title. Bottom: none |',
        '| Outline |': '| Outline | non-rectangular (USB-C tongue x 47-60, right step at y 37, Wi-Fi antenna cut-out x 48.1-61.5 / y >= 38.7), '
                        '1.0 mm radius on every convex corner, internal corners at the router-bit radius: **CNC-routed edges only, no V-score**. '
                        'SW3 knob overhangs the right edge by 0.5 mm, C44 and the USB-C shell sit near the right/top edges - no V-cut, no mouse-bite '
                        'tab on the right edge (x 74) or within 3 mm of the USB-C tongue. No mounting holes (dropped by the owner) |',
    }
    out = []
    for line in t.split('\n'):
        for key, new in rows.items():
            if line.startswith(key): line = new
        if line.startswith('| Copper |'):
            line = re.sub(r'\. Inner 1 oz is NOT required.*\|$', ' |', line)
        if line.startswith('- Test points (TP*), solder jumpers'):
            line = '- Test points (TP*) and ANT1 (PCB coil) are not components. NPTH holes: J1 locating pegs (0.65 mm x2) and SW3 locating pegs (0.9 mm x2); no mounting holes (dropped by the owner).'
        if line.startswith('- J6 (Samtec FTSH-105'):
            continue
        if line.startswith('- U10 TPS2121RUXR'):
            line = ('- D10-D19 WS2812B-2020-V6 (C52917434): pin 1 DO top-left in the JLC library and on the board; data enters D10 (right end). '
                    'U13 SN74LVC1T45DBVR (C7843) SOT-23-6 pin 1 VCCA. SW3 Nidec CUS-12TB (C2921739): non-shorting slide switch, pegs into the '
                    '0.9 mm NPTH holes, knob to the right board edge.')
        if line.startswith('- Stencil 0.10-0.12 mm'):
            line = line.replace('TI RUX0012A / ', '')
        out.append(line)
    t = '\n'.join(out)
    t = t.replace('| Surface finish | ENIG', '| Surface finish | **ENIG**')
    for bad in ('notch', 'green', 'J6', 'JP1', 'JP2', 'U10', '5V_FIELD', 'C41', 'C42'):
        assert not re.search(r'\b' + bad + r'\b', t, re.I), ('stale notes', bad)
    t += '\n## Board appearance (v0.5.4)\n\nBlack solder mask, white silkscreen, ENIG finish - set in the board stackup (`fieldnote.kicad_pcb`), so 3D renders ' \
         'and these notes agree. Order option at JLC: PCB colour **Black**, silkscreen **White**, surface finish **ENIG**.\n'
    open(path, 'w').write(t)


def main():
    cache = os.path.join(HERE, 'fab-cache')
    if not os.path.isdir(cache):
        shutil.copytree(os.path.join(FAB, 'cache'), cache)
    jlc_api.CACHE = cache
    m = json.load(open(os.path.join(FAB, 'sourcing-map.json')))
    for k_, v in list(V053_OVERLAY.items()) + list(OVERLAY.items()):
        if k_ in STALE: continue
        assert k_ not in m['parts'], k_
        m['parts'][k_] = v
    m['_about'] += ' v0.5.3 + v0.5.4 overlays (export_fab_v054.py): ' + ', '.join(k_ for k_ in list(V053_OVERLAY) + list(OVERLAY) if k_ not in STALE)
    merged = os.path.join(HERE, 'output', 'sourcing-map-v054.json')
    json.dump(m, open(merged, 'w'), indent=2)
    sourcing.MAP = merged
    import export_fab
    sys.argv = ['export_fab.py', HERE, OUT, '--build', 'usb', '--qty', '10']
    export_fab.main()
    notes_fix(os.path.join(OUT, 'FAB-NOTES.md'), os.path.join(HERE, 'fieldnote.kicad_pcb'))


if __name__ == '__main__':
    main()
