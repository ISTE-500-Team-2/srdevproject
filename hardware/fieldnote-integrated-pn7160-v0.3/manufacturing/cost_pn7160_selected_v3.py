#!/usr/bin/env python3
"""Price the adopted immutable PN7160 v3 selection into new artifacts only.

No CAD/BOM/frozen evidence writes, source substitutions, quote/cart/upload/order.
Supplier plans remain proposals. Includes minimum paid-lot and separate fitted
value scenarios; every surplus unit is charged to the catalog cash total.
"""
from collections import defaultdict
from copy import deepcopy
from decimal import Decimal as D
from pathlib import Path
import csv
import datetime
import hashlib
import importlib.util
import json

ROOT = Path(__file__).resolve().parent
NATIVE = ROOT.parent / "output/native-review-candidate-v3"
spec = importlib.util.spec_from_file_location("saved_cost_helpers", ROOT / "cost_pn7160.py")
cost = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cost)


def read(path):
    return json.loads(path.read_text(), parse_float=D)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def catalogue_source(mpn, url, stock, breaks, crawl, manufacturer):
    return {"mpn": mpn, "url": url, "observed_stock_units": stock,
            "currency": "USD", "minimum_order_quantity": 1, "order_multiple": 1,
            "price_breaks": [{"minimum_quantity": q, "unit_price": D(str(p))} for q, p in breaks],
            "checked_on": "2026-10-04", "catalog_crawl_age": crawl,
            "observed_manufacturer": manufacturer, "packaging": "Cut tape",
            "observation_kind": "Primary distributor catalog retrieved; stated crawl age retained",
            "stock_reserved": False, "supplier_plan_adopted": False,
            "manufacturer_traceability_for_PCBWay_purchase_verified": False,
            "notes": ["Cut tape selected; optional reeling fee excluded.",
                      "Refresh stock/rates and confirm assembler strip/overage/landed acceptance before procurement."]}


def plan(rows, quantities=None):
    quantities = quantities or {}
    result, installed, cash = [], D(0), D(0)
    for row in rows:
        mpn, source = row["design_mpn"], row["source"]
        q = quantities.get(mpn, row["minimum_catalog_purchase_quantity"])
        assert q >= row["fitted_quantity_two_boards"]
        assert q >= source["minimum_order_quantity"] and q % source["order_multiple"] == 0
        assert source["observed_stock_units"] is not None and source["observed_stock_units"] >= q
        rate = cost.price(q, source)
        fitted = D(row["fitted_quantity_two_boards"]) * rate
        paid = D(q) * rate
        installed += fitted
        cash += paid
        result.append({"design_mpn": mpn, "references": row["references"],
                       "quantity_per_board": row["quantity_per_board"],
                       "fitted_quantity_two_boards": row["fitted_quantity_two_boards"],
                       "paid_catalog_quantity": q, "paid_unit_rate": rate,
                       "paid_catalog_cost": paid, "fitted_attribution_two_boards": fitted,
                       "surplus_quantity": q - row["fitted_quantity_two_boards"],
                       "source": source, "supplier_plan_adopted": False})
    base = D("41.4653")
    return {"fitted_components_per_board": sum(r["quantity_per_board"] for r in result),
            "exact_fitted_mpns": len(result), "catalog_cash_two_boards": cash,
            "fitted_attribution_two_boards": installed, "fitted_attribution_per_board": installed / 2,
            "fitted_reduction_vs_frozen_pn532_percent": (1 - installed / (2 * base)) * 100,
            "50_percent_fitted_headroom_per_board": base / 2 - installed / 2,
            "numeric_50_percent_fitted_threshold_met": installed / 2 <= base / 2,
            "numeric_80_percent_fitted_threshold_met": installed / 2 <= base / 5,
            "delivered_50_or_80_percent_demonstrated": False,
            "actual_procurement_or_turnkey_cost": None, "parts": result}


def main():
    board = NATIVE / "fieldnote.kicad_pcb"
    design_file = NATIVE / "design-data.json"
    selection_file = ROOT / "pn7160-component-selection-review-final-v3.json"
    required_hashes = {
        board: "16c767ce38c3ed0bdd8345fea9010f13027d1d3d23fdc06d10d02107cebbdd65",
        design_file: "e5db89f4158c074e48b2796a4e05f75d80875480a6e508622d0e021d18e1c3fa",
        selection_file: "4cca1837dd1e4bbe1277054b217b8c94e76fa06b3d3f3a24a04668862a6bb50b",
    }
    for file, expected in required_hashes.items():
        assert sha(file) == expected, str(file)
    selection = read(selection_file)
    design = read(design_file)
    fitted = [p for p in design["parts"] if not p.get("dnp") and p.get("mpn") not in {None, "", "PCB copper"}]
    expected = {p["ref"]: p["mpn"] for p in selection["fitted_purchased_parts"]}
    assert {p["ref"]: p["mpn"] for p in fitted} == expected
    assert len(fitted) == selection["fitted_purchased_count"] == 78
    assert len(set(expected.values())) == selection["unique_fitted_mpns"] == 42
    for p in fitted:
        assert not p.get("dnp")
    assert expected["C28"] == expected["C29"] == "CC0603GRNPO9BN301"
    assert expected["C24"] == expected["C25"] == "CC0603GRNPO9BN331"
    csv_parts = list(csv.DictReader((NATIVE / "BOM.csv").open()))
    csv_fitted = {p["ref"]: p["mpn"] for p in csv_parts
                  if p["dnp"] == "False" and p["mpn"] not in {"", "PCB copper"}}
    assert csv_fitted == expected
    by_mpn = defaultdict(list)
    for p in fitted:
        by_mpn[p["mpn"]].append(p)
    frozen_file = ROOT / "pn7160-procurement.json"
    overlay_file = ROOT / "pn7160-procurement-addendum.json"
    advisory_file = ROOT / "pn7160-rf-tuning-candidate-procurement.json"
    live_file = ROOT / "pn7160-selected-v3-live-sources.json"
    frozen, overlay, advisory, live = [read(p) for p in [frozen_file, overlay_file, advisory_file, live_file]]
    assert overlay["frozen_comparison_sha256"] == sha(frozen_file)
    assert frozen["baseline"]["installed_value_per_board"] == D("41.4653")
    frozen_sources = {r["design_mpn"]: r["source"] for r in frozen["parts"]}
    overlay_sources = {r["design_mpn"]: deepcopy(r["source"]) for r in overlay["parts"]}
    fresh = {r["mpn"]: r for r in live["sources"] if "error" not in r and r["manufacturer_identity_checked"]}
    for mpn, source in list(overlay_sources.items()):
        actual_mpn = "TYPE-C-31-M-12" if mpn == "HRO TYPE-C-31-M-12" else mpn
        if actual_mpn in fresh:
            overlay_sources[mpn] = fresh[actual_mpn]
    # Exact order code and brand remain unchanged despite the HRO design prefix.
    assert overlay_sources["HRO TYPE-C-31-M-12"]["mpn"] == "TYPE-C-31-M-12"
    new300 = advisory["distributor_observations"][0]
    assert new300["mpn"] == "CC0603GRNPO9BN301" and new300["observed_stock_units"] == 1860
    frozen_sources["CC0603GRNPO9BN301"] = new300
    overlay_sources["CC0603GRNPO9BN301"] = new300
    # New same-MPN primary catalog observations, separated from frozen inputs.
    common_rc = [(1, .1), (10, .025), (25, .0188), (50, .015), (100, .0122)]
    refreshed = []
    for mpn, code, stock, crawl in [
        ("RC0603FR-07100KL", "726889", 596757, "today"),
        ("RC0603FR-071KL", "726843", 3253776, "today"),
        ("RC0603FR-074K7L", "727212", 4356337, "today"),
        ("RC0603FR-07887KL", "727417", 28662, "today"),
        ("RC0603FR-07150KL", "726959", 234753, "last week"),
        ("RC0603FR-07220KL", "727062", 129, "today"),
        ("RC0603FR-0747KL", "727253", 1543653, "today"),
    ]:
        refreshed.append(catalogue_source(mpn, f"https://www.digikey.com/en/products/detail/yageo/{mpn}/{code}",
                                         stock, common_rc, crawl, "YAGEO"))
    refreshed.append(catalogue_source("RC0603FR-078K66L", "https://www.digikey.com/en/products/detail/yageo/RC0603FR-078K66L/727393",
                                     139682, [(1, .11), (10, .027), (25, .0196), (50, .0158), (100, .0129)], "last week", "YAGEO"))
    refreshed.append(catalogue_source("RC0603JR-070RL", "https://www.digikey.com/en/products/detail/yageo/RC0603JR-070RL/726675",
                                     9345144, [(1, .1), (10, .012), (25, .0096), (50, .0084), (100, .0074)], "today", "YAGEO"))
    refreshed.append(catalogue_source("RC0603FR-0722RL", "https://www.mouser.com/en/ProductDetail/YAGEO/RC0603FR-0722RL?qs=diQw95jMAeMOsxb8bne7fg%3D%3D",
                                     336400, [(1, .12), (10, .012), (100, .01), (1000, .008)], "two days", "YAGEO"))
    for mpn, brand, code, stock, breaks, crawl in [
        ("APT2012SECK", "kingbright", "1747529", 40659, [(1, .2), (10, .136), (100, .0946)], "last week"),
        ("APT2012SGC", "kingbright", "1747530", 292525, [(1, .2), (10, .137), (100, .0953)], "three days"),
        ("APT2012SURCK", "kingbright", "1747532", 345792, [(1, .21), (10, .144), (100, .1002)], "today"),
        ("BAV199-7-F", "diodes-incorporated", "1033645", 265428, [(1, .3), (10, .181), (50, .1296)], "two days"),
        ("BLM18AG601SN1D", "murata-electronics", "584225", 1140466, [(1, .1), (10, .059), (50, .046)], "today"),
        ("SN74LVC1G04DBVR", "texas-instruments", "385716", 309656, [(1, .15), (10, .099), (100, .0735)], "today"),
        ("BQ24074RGTR", "texas-instruments", "2047269", 3922, [(1, 2.43), (10, 1.807), (25, 1.6496), (100, 1.4769)], "today"),
    ]:
        manufacturer = {"kingbright": "Kingbright", "diodes-incorporated": "Diodes Incorporated",
                        "murata-electronics": "Murata", "texas-instruments": "Texas Instruments"}[brand]
        refreshed.append(catalogue_source(mpn, f"https://www.digikey.com/en/products/detail/{brand}/{mpn}/{code}", stock, breaks, crawl, manufacturer))
    esp = deepcopy(next(r for r in overlay["additional_primary_distributor_observations"]
                        if r["mpn"] == "ESP32-C3-MINI-1-N4X"))
    esp.update({"checked_on": "2026-10-03", "catalog_crawl_age": "last week",
                "packaging": "Cut tape", "stock_reserved": False})
    overlay_sources["ESP32-C3-MINI-1-N4X"] = esp
    overlay_sources["BQ24074RGTR"] = next(r for r in refreshed if r["mpn"] == "BQ24074RGTR")
    all_sources = {mpn: [source] for mpn, source in overlay_sources.items()}
    for source in refreshed:
        all_sources.setdefault(source["mpn"], []).append(source)
    fair_rows, overlay_rows, cash_rows, cash_quantities, source_changes = [], [], [], {}, []
    for mpn, parts in sorted(by_mpn.items()):
        refs = [p["ref"] for p in parts]
        fps = list({p["fp"] for p in parts})
        fair_rows.append(cost.cost_row(mpn, refs, fps, frozen_sources[mpn]))
        overlay_rows.append(cost.cost_row(mpn, refs, fps, overlay_sources[mpn]))
        choices = [cost.cost_row(mpn, refs, fps, s) for s in all_sources[mpn]
                   if s["observed_stock_units"] is not None and s["observed_stock_units"] >= cost.purchase_quantity(2 * len(refs), s)]
        chosen = min(choices, key=lambda r: (r["optional_cash_optimized_purchase_cost"],
                                            r["optional_cash_optimized_purchase_quantity"], r["source"]["url"]))
        cash_rows.append(chosen)
        cash_quantities[mpn] = chosen["optional_cash_optimized_purchase_quantity"]
        previous = overlay_rows[-1]
        if chosen["source"]["url"] != previous["source"]["url"]:
            source_changes.append({"mpn": mpn, "references": refs,
                                   "previous_source": previous["source"]["url"], "proposed_source": chosen["source"]["url"],
                                   "previous_minimum_catalog_cash": previous["minimum_catalog_purchase_cost"],
                                   "proposed_paid_quantity": cash_quantities[mpn],
                                   "proposed_catalog_cash": chosen["optional_cash_optimized_purchase_cost"],
                                   "supplier_plan_adopted": False, "exact_selected_mpn_unchanged": True})
    fair = cost.summary(fair_rows)
    same_mpn_overlay = plan(overlay_rows)
    minimum_cash = plan(cash_rows, cash_quantities)
    optional_lots = plan(overlay_rows, {"C0805C226M8PACTU": 10, "CC0603GRNPO9BN331": 10,
                                       "CC0603GRNPO9BN301": 10})
    assert fair["installed_value_per_board"] == D("26.8088")
    assert same_mpn_overlay["catalog_cash_two_boards"] == D("54.2519")
    assert minimum_cash["catalog_cash_two_boards"] == D("51.4074")
    assert optional_lots["catalog_cash_two_boards"] == D("55.3119")
    assert optional_lots["fitted_attribution_per_board"] == D("20.5610")
    fixed = D("60.16")
    quote_file = ROOT.parent.parent / "fieldnote-integrated-v0.2/output/Fieldnote-PCBWay-quote-upload-20261003-2039/PCBWay-form-estimate.md"
    total_baseline = fixed + D("84.0475")
    fee_illustrations = [{"scenario": label, "catalog_cash": cash,
                         "hypothetical_same_fee_total_two_boards": fixed + cash,
                         "hypothetical_same_fee_average_per_assembled_board": (fixed + cash) / 2,
                         "hypothetical_cash_reduction_vs_frozen_pn532_minimum_catalog_plus_same_fee_percent": (1 - (fixed + cash) / total_baseline) * 100,
                         "actual_quote": False}
                        for label, cash in [("Frozen PN532 minimum catalog", D("84.0475")),
                                            ("Selected PN7160 fair minimum catalog", fair["minimum_catalog_purchase_without_assembly_overage"]),
                                            ("Selected PN7160 retained source-overlay minima", same_mpn_overlay["catalog_cash_two_boards"]),
                                            ("Selected PN7160 smallest demonstrated paid-lot plan", minimum_cash["catalog_cash_two_boards"]),
                                            ("Optional fitted-50% paid-lot plan", optional_lots["catalog_cash_two_boards"])]]
    input_paths = [board, design_file, selection_file, NATIVE / "BOM.csv", NATIVE / "source-revision.json",
                   NATIVE / "native-freeze-manifest.json", frozen_file, overlay_file, advisory_file, live_file, quote_file]
    frozen_tuning_selection = [{k: p.get(k) for k in ["ref", "mpn", "value", "fp", "dnp"]}
                              for p in sorted(design["parts"], key=lambda p: p["ref"])]
    selection_digest = hashlib.sha256(json.dumps(frozen_tuning_selection, sort_keys=True, separators=(",", ":"), default=float).encode()).hexdigest()
    result = {
        "schema_version": 1, "status": "ADOPTED_ENGINEERING_SELECTION_COST_REVIEW_NOT_PURCHASE_RELEASE",
        "written_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(), "assembled_boards": 2,
        "component_selection_adopted": True, "supplier_plans_adopted": False, "manufacturing_release": False,
        "immutable_native_candidate": "output/native-review-candidate-v3",
        "input_hashes": [{"path": str(p), "sha256": sha(p)} for p in input_paths],
        "variant_bom_selection_sha256": selection_digest,
        "fitted_parts_per_board": 78, "unique_exact_fitted_mpns": 42,
        "frozen_pn532_baseline": frozen["baseline"],
        "historical_frozen_pn7160_330pF": frozen["variant"],
        "selected_fair_nfc_only_comparison": {
            "scope": "Frozen fair source rates retained; only adopted C28/C29 value/order code and grouping updated. This fair ledger is not an executable procurement plan.",
            "totals": fair, "parts": fair_rows,
            "fitted_saving_per_board": D("41.4653") - fair["installed_value_per_board"],
            "fitted_component_reduction_percent": (1 - fair["installed_value_per_board"] / D("41.4653")) * 100,
        },
        "smallest_demonstrated_catalog_paid_lot_plan": minimum_cash,
        "same_exact_mpn_source_overlay_minimum_quantities": same_mpn_overlay,
        "optional_paid_lots_to_meet_numeric_50_percent_fitted_allowance": optional_lots,
        "cash_priority_source_changes": source_changes,
        "new_primary_distributor_observations": refreshed,
        "target_50_fitted_allowance_per_board": D("20.73265"),
        "target_80_fitted_allowance_per_board": D("8.29306"),
        "pcbway_fee_context": {"provenance_path": str(quote_file), "provenance_sha256": sha(quote_file),
                               "snapshot_scope": "PN532 form only, five fabricated and two assembled boards; not an accepted quote for this PN7160 candidate",
                               "fabrication_form_usd": D("31.16"), "assembly_form_usd": D("29"),
                               "subtotal_usd": fixed, "shipping_form_usd": D("28.95"),
                               "shipping_offset_form_discount_usd": D("-28.95"),
                               "promotion_eligibility_confirmed": False,
                               "setup_stencil_separately_itemized": False,
                               "same_fee_arithmetic_only": fee_illustrations,
                               "actual_pn7160_turnkey_quote": None},
        "source_refresh_scope": "32 exact public LCSC source records refreshed on 2026-10-04; new named primary distributor observations retain true crawl ages. Other saved supplier sources retain prior evidence and require refresh.",
        "limitations": [
            "Smallest paid-lot plan is the minimum among demonstrated source options, not a universal vendor optimum or executable cart.",
            "All surplus paid; fitted attribution excludes surplus and is not total purchase cash divided by boards.",
            "Historical fair sources include unavailable original RC0603FR-0722RL source; proposed cash plan uses stocked exact Mouser part.",
            "Exact MPN and manufacturer stay fixed in every source proposal; sources are not preapproved for assembler procurement.",
            "Manufacturer identity on public listings is checked, but PCBWay chain-of-custody/lot/landed traceability is not confirmed.",
            "Small cut strips/public MOQ may not meet PCBWay consignment overage/feeder rules; turnkey may use assembler-owned stock.",
            "Supplier freight, tariff/tax, markup, assembly overage, reeling, panels/rails, finish, setup and testing remain unquoted.",
            "Old form shipping promotion is conditional; without it add $28.95 to the identical-fee illustration.",
            "Neither delivered 50% nor 80% cost target is demonstrated; physical functional/RF/current/thermal qualification remains pending.",
            "Native freeze and every earlier fair/addendum/candidate cost artifact remain unchanged.",
        ],
    }
    output_file = ROOT / "pn7160-selected-v3-sourcing.json"
    cost.dump(result, output_file)
    csv_file = ROOT / "pn7160-selected-v3-smallest-paid-lots.csv"
    fields = ["mpn", "references", "fitted_quantity_two_boards", "paid_catalog_quantity", "paid_unit_rate_USD",
              "paid_catalog_cost_USD", "surplus_quantity", "source_url", "observation_date", "source_age"]
    with csv_file.open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        for row in minimum_cash["parts"]:
            s = row["source"]
            writer.writerow({"mpn": row["design_mpn"], "references": " ".join(row["references"]),
                             "fitted_quantity_two_boards": row["fitted_quantity_two_boards"],
                             "paid_catalog_quantity": row["paid_catalog_quantity"], "paid_unit_rate_USD": row["paid_unit_rate"],
                             "paid_catalog_cost_USD": row["paid_catalog_cost"], "surplus_quantity": row["surplus_quantity"],
                             "source_url": s["url"], "observation_date": s.get("retrieved_at_utc", s.get("checked_on", "saved snapshot")),
                             "source_age": s.get("catalog_crawl_age", s.get("crawl_age", s.get("observation_kind", "saved snapshot; refresh needed")))})
    print(json.dumps({"cash_plan_catalog": minimum_cash["catalog_cash_two_boards"],
                      "cash_plan_fitted_each": minimum_cash["fitted_attribution_per_board"],
                      "cash_plan_fitted_reduction": minimum_cash["fitted_reduction_vs_frozen_pn532_percent"],
                      "fair_fitted_each": fair["installed_value_per_board"],
                      "optional_lots_catalog": optional_lots["catalog_cash_two_boards"],
                      "optional_lots_fitted_each": optional_lots["fitted_attribution_per_board"],
                      "source_changes": len(source_changes), "selection_digest": selection_digest,
                      "output_sha256": sha(output_file), "csv_sha256": sha(csv_file)}, indent=2, default=float))


if __name__ == "__main__":
    main()
