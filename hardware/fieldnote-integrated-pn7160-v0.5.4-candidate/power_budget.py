#!/usr/bin/env python3
"""v0.5.4 power analysis: VSYS worst case, BQ24074 input limit, bulk capacitance, thermal, firmware budget, service mode.

Every input carries its source. 'DS' = datasheet value, 'J' = judgment (stated). Output: output/v054-power-budget.json and
output/v054-power-budget.md (pasted into README.md). Plain python3, no dependencies.
"""
import json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'output'

# ---- BQ24074 (TI SLUS810N) ----
USB100 = (90, 95, 100)                    # mA, IINmax EN1=EN2=LO (DS)
KILIM = (1500, 1610, 1720)                # A*ohm, ILIM 500 mA-1.5 A row (DS)
VOREG = (4.3, 4.4, 4.5)                   # V, OUT regulation BQ24073/74 (DS)
VDO_MAX_1A = 0.475                        # V, VIN-VOUT at IIN 1 A, VIN 4.3 V (DS max) -> 0.475 ohm
RTHJA = 44.5                              # C/W RGT16 (DS, JEDEC high-K)
TJREG = 125                               # C thermal regulation (DS)
ICC_IN = 1.5                              # mA IN supply current max (DS)
COUT_RANGE = (4.7, 47)                    # uF, "Bypass OUT to VSS with a 4.7-uF to 47-uF ceramic capacitor" (DS pin table)
R6_OLD, R6_NEW, R_TOL = 1620, 1300, 0.01

# ---- loads ----
LED_N, LED_CH_TYP = 10, 12.0              # mA per channel (WS2812B-2020-V6 DS: "operating current per channel 12 mA")
LED_CH_MAX = 13.8                         # J: +15 % (DS gives no max)
LED_IC_ACTIVE = 1.0                       # J: per-LED IC current while lit (DS gives only the < 1 uA off-state quiescent)
LED_IDLE_UA = 1.0                         # uA per LED, no data, RGB off (DS max)
PN_PCD_MAX = 290                          # mA, PN7160 continuous total in PCD mode, VBAT+VUP, antenna <= 250 mA (DS Table 1)
PN_PCD_NOM = 207 + 30                     # mA, study nominal ITVDD + J 30 mA chip
PN_HPD_UA = 16                            # uA, IBAT hard power-down max (DS Table 1)
ESP_TX = 350                              # mA peak, 802.11b 1 Mbps @20.5 dBm, 100 % duty (ESP32-C3-MINI-1 DS v2.2 Table 6-4)
ESP_RX = 84                               # mA, 802.11n HT40 RX (DS Table 6-4)
ESP_MODEM_SLEEP = 28                      # mA, 160 MHz CPU running, all peripheral clocks on (DS Table 6-6)
FLASH_WRITE = 25                          # mA, J: in-package SPI NOR program/erase (Espressif gives no figure; typ NOR max)
USB_PHY = 5                               # mA, J: USB-Serial-JTAG PHY active
BUZZER_AVG = 3.3 / (4.7 + 12) * 0.5 * 1000 * 1.2   # mA: 50 % drive into R44 4.7 R + KLJ-4020 12 R, x1.2 ripple (J)
MISC_3V3 = 3.0                            # mA: TUSB320 0.1 (DS), logic/supervisor < 0.05 (DS), pull-ups R7/R8/R9/R2/R20/R21 when low
ETA_TPS_HI = 0.85                         # TPS63031 PS disabled, VIN 4.2 V, 500 mA: ~88 % (DS Fig 16); J margin -> 0.85
ETA_TPS_LO = 0.80                         # ~60 mA, VIN 4.3 V: ~87 % between the 10 mA / 100 mA curves (DS Fig 16); J -> 0.80
VSYS_CALC = 4.0                           # V, VSYS used to convert TPS input current (low end, conservative)
MARGIN = 0.90                             # J: use 90 % of the minimum input limit for firmware budgets

# ---- VSYS capacitance (nominal uF, J effective fraction at 4.4 V DC bias for the exact parts) ----
CAPS = [('C3', 22, 'CL21A226MAQNNNE 25 V X5R 0805 (JLC fit)', .55), ('C4', 22, 'same', .55), ('C57', 22, 'CL21A226MAQNNNE (new, bar)', .55),
        ('C12', 4.7, 'CL21A475KOFNNNE 16 V X5R 0805 (NFC_VBAT behind FB1)', .65), ('C14', 4.7, 'same', .65),
        ('C5/C13/C59', 0.3, '3 x 100 nF', .85), ('C47-C56', 1.0, '10 x 100 nF 0402 X7R', .85)]


def ilim(r):
    return {'min': KILIM[0] / (r * (1 + R_TOL)), 'typ': KILIM[1] / r, 'max': KILIM[2] / (r * (1 - R_TOL))}


def tps_in(i3v3, eta, vsys=VSYS_CALC): return i3v3 * 3.3 / (eta * vsys)


def main():
    res = {}
    old, new = {k: round(v * 1000) for k, v in ilim(R6_OLD).items()}, {k: round(v * 1000) for k, v in ilim(R6_NEW).items()}
    res['ilim'] = {'R6_1.62k': old, 'R6_1.30k': new, 'margin_to_1500mA_pct': round((1500 - new['max']) / 1500 * 100, 1)}
    led_full = {'typ': LED_N * (3 * LED_CH_TYP + LED_IC_ACTIVE), 'max': LED_N * (3 * LED_CH_MAX + LED_IC_ACTIVE)}
    i3 = ESP_TX + BUZZER_AVG + MISC_3V3
    worst = {'LED bar full white (peak)': led_full['max'], 'PN7160 PCD (VBAT + VUP, DS max)': PN_PCD_MAX,
             'TPS63031 input (ESP TX 350 + buzzer %.0f + misc %.0f mA at 3V3, eta %.2f, %.1f V)' % (BUZZER_AVG, MISC_3V3, ETA_TPS_HI, VSYS_CALC): tps_in(i3, ETA_TPS_HI),
             'other VSYS (R26, U13, LED idle)': 0.1}
    typ = {'LED bar full white': led_full['typ'], 'PN7160 PCD nominal (study 207 mA ITVDD)': PN_PCD_NOM,
           'TPS63031 input (ESP TX + buzzer + misc, eta 0.88, 4.4 V)': tps_in(i3, .88, 4.4), 'other': 0.1}
    res['vsys_worst_mA'] = {k: round(v, 1) for k, v in worst.items()} | {'TOTAL': round(sum(worst.values()), 1)}
    res['vsys_typ_mA'] = {k: round(v, 1) for k, v in typ.items()} | {'TOTAL': round(sum(typ.values()), 1)}
    # VSYS under load at the limit: dropout through Q1 (VDO max 0.475 V at 1 A -> 0.475 ohm)
    rq1 = VDO_MAX_1A / 1.0
    res['vsys_at_limit'] = {f'VIN {vin} V': round(min(VOREG[0], vin - rq1 * new['min'] / 1000), 2) for vin in (4.5, 4.75, 5.0)}
    # firmware budget: peak channels (each lit channel pulls its full current during its PWM on-time; 10 free-running 2 kHz PWMs
    # can align, so the budget is on the number of non-zero channels, not on brightness)
    avail = MARGIN * new['min']
    scen = [('Idle / Wi-Fi associated, RX or modem-sleep, no field', 0, ESP_RX + MISC_3V3, 0),
            ('NFC field on (polling) + Wi-Fi RX', PN_PCD_MAX, ESP_RX + MISC_3V3, 0),
            ('NFC field on + Wi-Fi TX burst', PN_PCD_MAX, ESP_TX + MISC_3V3, 0),
            ('NFC field on + Wi-Fi TX + buzzer', PN_PCD_MAX, ESP_TX + MISC_3V3, BUZZER_AVG),
            ('Wi-Fi TX + buzzer, no field', 0, ESP_TX + MISC_3V3, BUZZER_AVG)]
    rows = []
    for name, pn, i3v3, bz in scen:
        other = pn + tps_in(i3v3 + bz, ETA_TPS_HI) + 0.1
        left = avail - other
        ch = max(0, int(left // (LED_CH_MAX + LED_IC_ACTIVE / 3)))
        rows.append({'scenario': name, 'non_LED_mA': round(other), 'LED_budget_mA': round(left), 'max_lit_channels': min(ch, 30),
                     'max_full_white_LEDs': min(10, int(left // (3 * LED_CH_MAX + LED_IC_ACTIVE)))})
    res['firmware_budget'] = {'available_mA': round(avail), 'basis': f'{MARGIN:.0%} of ILIM min {new["min"]} mA (R6 1.30k)', 'rows': rows}
    # bulk capacitance
    ceff = sum(c * f for _, c, _, f in CAPS); cnom = sum(c for _, c, _, _ in CAPS)
    res['vsys_capacitance_uF'] = {'nominal': round(cnom, 1), 'effective_4V4': round(ceff, 1), 'bq_range': COUT_RANGE,
                                  'parts': [[n, c, d, f] for n, c, d, f in CAPS]}
    step = led_full['max'] + tps_in(ESP_TX, ETA_TPS_HI) - tps_in(ESP_RX, ETA_TPS_HI)
    res['bulk_step'] = {'worst_step_mA': round(step), 'droop_mV_for_loop_response_us': {t: round(step / 1000 * t * 1e-6 / (ceff * 1e-6) * 1000) for t in (5, 10, 20)},
                        'loop_response_covered_us_for_300mV': round(0.3 * ceff / (step / 1000), 1)}
    res['overload_ride_through_us'] = {f'{d} mA over the limit': round(0.4 * ceff / (d / 1000), 0) for d in (25, 50, 100, 200)}
    # USB100 start
    c_hi = cnom * 1.2
    t_vsys = c_hi * 1e-6 * VOREG[2] / (USB100[0] / 1000) * 1000
    rc_min, rc_nom = 148.5e3 * 0.4e-6, 150e3 * 1e-6           # R26 150k 1 %, C36 1 uF X7R; the v0.4 note screens 0.4-1.2 uF effective
    t_en_min = (0.4 / VOREG[0] * rc_min + t_vsys / 1000 / 2) * 1000   # earliest EN (VIL 0.4 V), ramp-driven RC
    t_en_nom = -rc_nom * math.log(1 - 1.2 / VOREG[1]) * 1000
    c3v3 = 22 + 10 + 1 + 0.6 + 5 + 22                          # C6, C10, C19, 0.1 uF x6, ESP module internal (J), C44 via R44
    e_need = 0.5 * c3v3 * 1e-6 * 3.3 ** 2 / 0.8
    e_bq = USB100[0] / 1000 * 4.0 * 0.5e-3                      # J: 0.5 ms TPS soft start (DS Fig 24)
    v_dip = math.sqrt(max(0, VOREG[1] ** 2 - 2 * max(0, e_need - e_bq) / (ceff * 1e-6)))
    v_dip_old = math.sqrt(max(0, VOREG[1] ** 2 - 2 * max(0, e_need - e_bq) / ((ceff - 22 * .55) * 1e-6)))
    res['usb100_start'] = {'vsys_charge_ms_at_90mA_nominal_C+20pct': round(t_vsys, 1), 'tps_en_earliest_ms': round(t_en_min, 1),
                           'tps_en_nominal_ms': round(t_en_nom, 1), '3v3_caps_uF': c3v3, 'vsys_dip_during_tps_softstart_V': round(v_dip, 2),
                           'same_without_C57_V': round(v_dip_old, 2), 'tps_uvlo_V': 1.5}
    # thermal
    res['bq_thermal'] = {f'VIN {vin} V, VSYS {vs} V, IIN {i} mA': {'P_W': round((vin - vs) * i / 1000 + vin * ICC_IN / 1000, 2),
                                                                     'rise_C': round(((vin - vs) * i / 1000 + vin * ICC_IN / 1000) * RTHJA, 1)}
                         for vin, vs, i in ((5.0, 4.4, 1000), (5.25, 4.3, new['max']), (5.5, 4.3, new['max']), (5.0, 4.4, old['max']))}
    # service mode (default port, USB100)
    esp = ESP_MODEM_SLEEP + FLASH_WRITE + USB_PHY
    misc = 1.3
    svc3 = esp + misc
    svc = {'ESP32-C3 ROM download + flash write (28 + 25 + 5 mA at 3V3)': tps_in(esp, ETA_TPS_LO, 4.3),
           'pull-ups / TUSB320 / logic (1.3 mA at 3V3)': tps_in(misc, ETA_TPS_LO, 4.3),
           'LED bar idle (10 x 1 uA)': LED_N * LED_IDLE_UA / 1000, 'PN7160 hard power-down, VEN low by R19 (16 uA max)': PN_HPD_UA / 1000,
           'R26 + U13 ICCB': 0.035}
    tot = sum(svc.values())
    res['service_mode'] = {'items_mA_at_VSYS': {k: round(v, 2) for k, v in svc.items()}, 'TOTAL_mA': round(tot, 1),
                           'limit_mA_min': USB100[0], 'headroom_mA': round(USB100[0] - tot, 1), 'utilisation_pct': round(tot / USB100[0] * 100),
                           'eta_0.7_TOTAL_mA': round(tps_in(svc3, .7, 4.3) + .06, 1), 'bq_icc_from_port_mA': ICC_IN}
    (OUT / 'v054-power-budget.json').write_text(json.dumps(res, indent=2) + '\n')
    md = []
    md.append('| Input limit (R6) | min | typ | max |\n|---|---:|---:|---:|')
    md.append(f'| 1.62k (v0.5.3) | {old["min"]} | {old["typ"]} | {old["max"]} mA |')
    md.append(f'| **1.30k (v0.5.4)** | **{new["min"]}** | **{new["typ"]}** | **{new["max"]} mA** |')
    md.append('\n| Worst-case simultaneous VSYS load | mA |\n|---|---:|')
    md += [f'| {k} | {v} |' for k, v in res['vsys_worst_mA'].items()]
    md.append('\n| Firmware budget (peak) | non-LED mA | LED budget mA | max lit channels | max full-white LEDs |\n|---|---:|---:|---:|---:|')
    md += [f'| {r_["scenario"]} | {r_["non_LED_mA"]} | {r_["LED_budget_mA"]} | {r_["max_lit_channels"]} of 30 | {r_["max_full_white_LEDs"]} of 10 |' for r_ in rows]
    md.append('\n| Service mode (USB100) | mA at VSYS |\n|---|---:|')
    md += [f'| {k} | {v} |' for k, v in res['service_mode']['items_mA_at_VSYS'].items()]
    md.append(f'| **TOTAL** | **{res["service_mode"]["TOTAL_mA"]}** of {USB100[0]} (min) |')
    (OUT / 'v054-power-budget.md').write_text('\n'.join(md) + '\n')
    print(json.dumps({k: res[k] for k in ('ilim', 'vsys_worst_mA', 'vsys_at_limit', 'vsys_capacitance_uF', 'bulk_step', 'usb100_start', 'service_mode')}, indent=1)[:4000])
    print(json.dumps(rows, indent=0))
    print(json.dumps(res['bq_thermal']), json.dumps(res['overload_ride_through_us']))


if __name__ == '__main__':
    main()
