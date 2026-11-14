#!/usr/bin/env python3
"""Write a separate, unadopted sourcing screen for routed RF tuning.

Uses saved exact distributor observations; no network, CAD, BOM, frozen
source-addendum, existing PDF, package catalog, or manifest writes.
"""
import datetime
import hashlib
import json
from decimal import Decimal as D
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCES = ROOT / "pn7160-rf-tuning-candidate-sources"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(value):
    return float(value)


def scenario(label, base, each, cash, lots):
    return {
        "label": label,
        "status": "UNADOPTED_CANDIDATE_NOT_A_DELIVERED_QUOTE",
        "fitted_value_per_board": number(each),
        "fitted_value_two_boards": number(each * 2),
        "catalog_cash_two_boards_before_assembly_overage_and_fees": number(cash),
        "reduction_vs_frozen_pn532_fitted_percent": number((1 - each / base) * 100),
        "50_percent_fitted_headroom_per_board": number(base / 2 - each),
        "numeric_50_percent_fitted_threshold_met": each <= base / 2,
        "numeric_80_percent_fitted_threshold_met": each <= base / 5,
        "two_board_turnkey_50_or_80_percent_demonstrated": False,
        "rf_capacitor_paid_lots": lots,
        "all_other_prices_frozen": True,
        "actual_turnkey_cost": None,
    }


def main():
    frozen_path = ROOT / "pn7160-procurement.json"
    addendum_path = ROOT / "pn7160-procurement-addendum.json"
    catalog_path = ROOT / "v03-package-catalog.json"
    frozen = json.loads(frozen_path.read_text())
    overlay = json.loads(addendum_path.read_text())
    assert overlay["frozen_comparison_sha256"] == sha(frozen_path)
    assert frozen["variant_bom_selection_sha256"] == overlay["bom_selection_sha256"]
    original = next(row for row in frozen["parts"]
                    if row["design_mpn"] == "CC0603GRNPO9BN331")
    assert original["references"] == ["C24", "C25", "C28", "C29"]
    assert D(str(original["installed_unit_price"])) == D(".23")
    assert overlay["explicit_paid_small_lot_scenario"]["installed_value_per_board"] == 20.569
    base = D("41.4653")
    dk = "https://www.digikey.com/en/products/detail/yageo/CC0603GRNPO9BN301/18106011"
    primary = "https://www.yageogroup.com/download/specsheet/CC0603GRNPO9BN301"
    observations = [{
        "manufacturer": "YAGEO", "mpn": "CC0603GRNPO9BN301",
        "supplier": "DigiKey", "supplier_code": "13-CC0603GRNPO9BN301CT-ND",
        "url": dk, "checked_on": "2026-10-04", "catalog_crawl_age": "last week",
        "canonical_retrieval_confirmed": True, "observation_kind": "refreshed primary distributor catalog",
        "observed_stock_units": 1860, "minimum_order_quantity": 1, "order_multiple": 1,
        "currency": "USD", "packaging": "Cut tape", "factory_reel_quantity": 4000,
        "price_breaks": [{"minimum_quantity": q, "unit_price": p}
                         for q, p in [(1, .22), (10, .123), (50, .087), (100, .0759), (500, .05732)]],
        "physical_quantity_per_board": 2, "fitted_quantity_two_boards": 4,
        "minimum_fitted_and_catalog_cash_for_two": .88,
        "optional_ten_lot_cash": 1.23, "optional_ten_lot_fitted_attribution": .492,
        "optional_ten_lot_surplus": 6, "source_adopted": False, "stock_reserved": False,
        "notes": ["Older indexed $0.17 and 2,592 stock superseded.",
                  "Digi-Reel adds $7; reeling excluded by selecting cut tape.",
                  "Shipping, tariffs, PCBWay overage, packaging acceptance and landed sourcing remain unquoted."],
    }, {
        "manufacturer": "YAGEO", "mpn": "CC0603GRNPO9BN301", "supplier": "Newark US",
        "supplier_code": "80AK9202", "checked_on": "2026-10-04",
        "url": "https://www.newark.com/es/yageo/cc0603grnpo9bn301/condensadores-electricos-con-dielectrico/dp/80AK9202",
        "observation_kind": "conflicting indexed primary distributor observations; canonical HTTP403",
        "catalog_crawl_age": "last month exact page; last week category page",
        "observed_stock_units": 1380, "stock_location": "UK stock, per indexed US page",
        "minimum_order_quantity": 10, "order_multiple": 10, "currency": "USD",
        "indexed_exact_page_unit_price_at_10": .071,
        "newer_us_category_unit_price_at_10": .089,
        "indicative_ten_lot_cash_range": [.71, .89],
        "canonical_retrieval_confirmed": False, "excluded_from_firm_scenarios": True,
        "source_adopted": False, "stock_reserved": False,
        "notes": ["Do not substitute Canada $0.101 or Mexico $0.093 regional prices.",
                  "Resolve current exact US price and shipping to assembler before attribution.",
                  "Newark direct page access returned403; this is not an approval rejection."],
    }, {
        "manufacturer": "YAGEO", "mpn": "CC0603GRNPO9BN121", "supplier": "DigiKey",
        "supplier_code": "311-3918-1-ND", "checked_on": "2026-10-04",
        "url": "https://www.digikey.com/en/products/detail/yageo/CC0603GRNPO9BN121/8025007",
        "observation_kind": "older indexed primary distributor catalog",
        "catalog_crawl_age": "three months", "canonical_retrieval_confirmed": True,
        "observed_stock_units": 8965, "minimum_order_quantity": 1, "order_multiple": 1,
        "currency": "USD", "packaging": "Cut tape", "factory_reel_quantity": 4000,
        "price_breaks": [{"minimum_quantity": q, "unit_price": p}
                         for q, p in [(1, .12), (10, .067), (50, .0462), (100, .0399), (500, .0295)]],
        "provisional_role": "120 pF C1 bracket; not recommended selected seed",
        "fitted_quantity_two_boards_if_selected": 4,
        "minimum_catalog_cash_for_two_if_selected": .48, "optional_ten_lot_cash": .67,
        "source_adopted": False, "stock_reserved": False,
        "notes": ["Refresh old stock/rates before procurement.",
                  "LCSC C107035 is exact YAGEO120pF ±5%, not this ±2% MPN, and is rejected."]
    }]
    specs = []
    for mpn, capacitance, termination in [("CC0603GRNPO9BN301", 300, [.35, .15]),
                                          ("CC0603GRNPO9BN121", 120, [.4, .2])]:
        file = SOURCES / (mpn + ".pdf")
        assert file.read_bytes().startswith(b"%PDF")
        specs.append({
            "manufacturer": "YAGEO", "mpn": mpn, "capacitance_pF": capacitance,
            "tolerance_percent": 2, "voltage_VDC": 50, "dielectric": "C0G",
            "temperature_range_C": [-55, 125], "dissipation_factor_percent": .1,
            "terminations": "Tin", "MSL": 1, "package": "0603 / 1608",
            "nominal_L_W_T_mm": [1.6, .8, .8], "L_W_T_tolerance_mm": [.1, .1, .1],
            "body_max_L_W_T_mm": [1.7, .9, .9],
            "termination_B_nominal_and_tolerance_mm": termination,
            "same_max_body_envelope_as_selected_330pF": True,
            "footprint_geometry_approval": False, "package_catalog_adopted": False,
            "source_url": "https://www.yageogroup.com/download/specsheet/" + mpn,
            "source_path": str(file.relative_to(ROOT)), "source_sha256": sha(file),
            "page_1_based": 1, "manufacturer_generation_date": "2026-10-04",
            "visual_review_completed": True,
            "notes": ["Source limits include terminated body; maximum seating height needs existing assembly allowance.",
                      "Same 0603 size designation is insufficient alone; exact package drawing is the evidence.",
                      "Declared dissipation factor is not a verified 13.56 MHz ESR/model."],
        })
    lots4 = [{"mpn": "CC0603GRNPO9BN331", "references": ["C24", "C25"],
              "fitted_quantity": 4, "paid_quantity": 4, "unit_rate": .23, "cash": .92},
             {"mpn": "CC0603GRNPO9BN301", "references": ["C28", "C29"],
              "fitted_quantity": 4, "paid_quantity": 4, "unit_rate": .22, "cash": .88}]
    both10 = [{"mpn": "CC0603GRNPO9BN331", "references": ["C24", "C25"],
               "fitted_quantity": 4, "paid_quantity": 10, "unit_rate": .127, "cash": 1.27},
              {"mpn": "CC0603GRNPO9BN301", "references": ["C28", "C29"],
               "fitted_quantity": 4, "paid_quantity": 10, "unit_rate": .123, "cash": 1.23}]
    mixed = [both10[0], lots4[1]]
    scenarios = [
        scenario("Fair NFC-only model: minimum four of each RF value", base,
                 D("26.8288") + 2 * (D(".22") - D(".23")),
                 D("57.2256") - D("1.84") + D(".92") + D(".88"), lots4),
        scenario("Sourcing overlay: minimum four of each RF value", base,
                 D("21.473") + 2 * (D(".22") - D(".23")),
                 D("54.2919") - D("1.84") + D(".92") + D(".88"), lots4),
        scenario("Prior paid capacitor scenario: retain 330 pF ten lot, buy four 300 pF", base,
                 D("20.569") + 2 * (D(".22") - D(".127")),
                 D("54.0819") + D(".88"), mixed),
        scenario("Prior paid capacitor scenario: pay ten of both RF values", base,
                 D("20.569") + 2 * (D(".123") - D(".127")),
                 D("54.0819") + D("1.23"), both10),
        scenario("Prior paid 22 uF scenario: lowest cash four of each RF value", base,
                 D("20.569") + 2 * (D(".23") - D(".127")) + 2 * (D(".22") - D(".127")),
                 D("54.0819") - D("1.27") + D(".92") + D(".88"), lots4),
    ]
    output = {
        "schema_version": 1, "status": "PROVISIONAL_SOURCING_ONLY_NO_SUBSTITUTION_ADOPTED",
        "written_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "quantity_boards": 2, "candidate_references": ["C28", "C29"],
        "candidate_value_pF": 300, "candidate_mpn": "CC0603GRNPO9BN301",
        "candidate_network_per_leg": {"C1_pF": 130, "C2_pF": 300, "RQ_ohm": 1.3},
        "candidate_bom_selected": False, "mpn_substitution_approved": False,
        "source_adopted": False, "order_or_upload_performed": False,
        "frozen_inputs": [{"path": str(p.relative_to(ROOT)), "sha256": sha(p)}
                          for p in [frozen_path, addendum_path, catalog_path]],
        "frozen_bom_selection_sha256": overlay["bom_selection_sha256"],
        "frozen_pn532_fitted_per_board": 41.4653,
        "frozen_fair_pn7160_fitted_per_board": 26.8288,
        "frozen_unchanged_mpn_overlay_fitted_per_board": 21.473,
        "frozen_explicit_paid_lot_fitted_per_board": 20.569,
        "frozen_explicit_paid_lot_catalog_cash_two_boards": 54.0819,
        "target_50_fitted_per_board": 20.73265, "target_80_fitted_per_board": 8.29306,
        "manufacturer_specs": specs, "distributor_observations": observations,
        "manufacturer_distributor_list_url": "https://yageogroup.com/SalesResources/Distributors",
        "manufacturer_list_evidence": "YAGEO lists DigiKey and Mouser globally, Newark Americas and Farnell globally.",
        "scenarios": scenarios,
        "excluded_candidates": [
            {"mpn": "GRM1885C1H301GA01D", "reason": "Exact 300 pF 2% 50 V C0G stocked, but distributor marks NRND; no substitute adopted."},
            {"mpn": "06035A301FAT2A", "reason": "Exact 300 pF 1% 50 V C0G not normally stocked, full 4000 reel only in observed catalog."},
            {"mpn": "C0603C301G5GACTU", "reason": "Exact 300 pF 2% 50 V C0G not normally stocked; no small-lot stock confirmed."},
            {"mpn": "CC0603JRNPO9BN301", "reason": "5% exceeds required2%; cheaper pricing excluded."},
            {"mpn": "CC0603KRX7R9BB301", "reason": "X7R10% fails required C0G and tolerance."},
        ],
        "adoption_gates": [
            "Hardware owner selects final exact value/MPN only after final geometry RF rerun.",
            "Assembly owner binds exact drawing/spec and rechecks affected pads/clearances; existing catalog unchanged.",
            "Manufacturer-listed distributor availability does not reserve stock or prove PCBWay landed sourcing.",
            "PCBWay must quote exact cut-tape acceptance, overage, traceability, procurement and landed costs.",
            "No circuit/driver/RF/thermal/read-range qualification is provided by a stock or price observation.",
            "Fitted value credits only installed units; catalog cash includes every explicitly paid surplus lot.",
            "No 50% or 80% delivered price or preserved functional qualification is demonstrated.",
        ],
    }
    destination = ROOT / "pn7160-rf-tuning-candidate-procurement.json"
    destination.write_text(json.dumps(output, indent=2) + "\n")
    for row in scenarios:
        print(row["label"], row["fitted_value_per_board"],
              row["catalog_cash_two_boards_before_assembly_overage_and_fees"],
              row["reduction_vs_frozen_pn532_fitted_percent"])


if __name__ == "__main__":
    main()
