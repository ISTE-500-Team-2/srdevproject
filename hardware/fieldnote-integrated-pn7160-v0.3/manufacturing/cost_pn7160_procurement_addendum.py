#!/usr/bin/env python3
"""Calculate a separate, unadopted exact-MPN sourcing overlay from saved data."""
import importlib.util
import json
from pathlib import Path
from decimal import Decimal as D
import hashlib

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("frozen_cost", ROOT / "cost_pn7160.py")
cost = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cost)


def read(path):
    return json.loads(path.read_text(), parse_float=D)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    frozen_path = ROOT / "pn7160-procurement.json"
    frozen = read(frozen_path)
    live_path = ROOT / "pn7160-procurement-addendum-live-sources.json"
    live = read(live_path)
    design = read(ROOT.parent / "design-data.json")
    bom = [{k: p.get(k) for k in ["ref", "mpn", "value", "fp", "dnp"]}
           for p in sorted(design["parts"], key=lambda p: p["ref"])]
    bom_hash = hashlib.sha256(json.dumps(bom, sort_keys=True, separators=(",", ":"), default=float).encode()).hexdigest()
    assert bom_hash == frozen["variant_bom_selection_sha256"] == "92be82f1138088033270ca046bac0298bbd11a10b9a72e66bb2ea564259eff08"
    assert frozen["baseline"]["installed_value_two_boards"] == D("82.9306")
    assert frozen["variant"]["installed_value_two_boards"] == D("53.6576")
    footprints = {p["ref"]: p["fp"] for p in design["parts"]}
    sources = {p["mpn"]: p for p in live["sources"] if "error" not in p and p.get("manufacturer_identity_checked")}
    rows, changed = [], []
    for old in frozen["parts"]:
        mpn = old["design_mpn"]
        chosen = old["source"]
        fresh = sources.get(mpn)
        if mpn == "HRO TYPE-C-31-M-12":
            # Existing BOM includes a manufacturer prefix; the exact supplier code
            # is TYPE-C-31-M-12, bound to Korean Hroparts at the same C165948 URL.
            fresh = sources.get("TYPE-C-31-M-12")
        if fresh:
            purchase_qty = cost.purchase_quantity(old["fitted_quantity_two_boards"], fresh)
            valid_stock = fresh["observed_stock_units"] >= purchase_qty
            if valid_stock and (cost.price(purchase_qty, fresh) < old["installed_unit_price"]
                                or mpn == "LPS3015-152MRC" or fresh["url"] == chosen["url"]):
                chosen = fresh
        row = cost.cost_row(mpn, old["references"], [footprints[r] for r in old["references"]], chosen)
        row["source_adopted"] = False
        row["exact_mpn_and_manufacturer_unchanged"] = True
        row["source_refresh_scope"] = "Live public product data with manufacturer check" if chosen is fresh else "Retained saved distributor price; refresh still required before procurement"
        rows.append(row)
        if chosen is fresh and (fresh["url"] != old["source"]["url"] or row["installed_unit_price"] != old["installed_unit_price"]):
            changed.append({"mpn": mpn, "references": old["references"], "original_source": old["source"]["url"],
                            "proposed_source": chosen["url"], "observed_manufacturer": fresh["observed_manufacturer"],
                            "old_rate": old["installed_unit_price"], "proposed_rate": row["installed_unit_price"],
                            "fitted_saving_two_boards": old["installed_value_two_boards"] - row["installed_value_two_boards"],
                            "minimum_purchase_qty": row["minimum_catalog_purchase_quantity"],
                            "minimum_purchase_cost": row["minimum_catalog_purchase_cost"],
                            "observed_stock": fresh["observed_stock_units"], "retrieved_at_utc": fresh["retrieved_at_utc"],
                            "manufacturer_traceability_verified_independently": False, "source_adopted": False})
    totals = cost.summary(rows)
    baseline = frozen["baseline"]["installed_value_per_board"]
    unchanged = frozen["variant"]["installed_value_per_board"]
    overlay = totals["installed_value_per_board"]
    target = {str(p): {"fitted_target_per_board": baseline * (D(1) - D(p) / 100),
                      "remaining_fitted_saving_from_frozen_candidate_per_board": unchanged - baseline * (D(1) - D(p) / 100),
                      "remaining_fitted_saving_from_overlay_per_board": overlay - baseline * (D(1) - D(p) / 100),
                      "fitted_target_demonstrated": overlay <= baseline * (D(1) - D(p) / 100),
                      "two_board_turnkey_target_demonstrated": False} for p in [50, 80]}
    available = {r["design_mpn"]: r for r in rows}
    assert available["RC0603FR-0722RL"]["source"]["observed_stock_units"] >= 100
    assert available["LPS3015-152MRC"]["source"]["observed_stock_units"] >= 2
    assert totals["fitted_components_per_board"] == 78 and totals["unique_fitted_mpns"] == 41
    cash_optimized_attribution = sum((D(row["fitted_quantity_two_boards"]) * row["optional_cash_optimized_purchase_unit_price"] for row in rows), D(0))
    small_lot_installed, small_lot_cash, small_lot_parts = D(0), D(0), []
    small_lot_override = {"CC0603GRNPO9BN331": 10, "C0805C226M8PACTU": 10}
    for row in rows:
        qty = small_lot_override.get(row["design_mpn"], row["minimum_catalog_purchase_quantity"])
        assert qty >= row["fitted_quantity_two_boards"]
        assert qty >= row["source"]["minimum_order_quantity"] and qty % row["source"]["order_multiple"] == 0
        assert row["source"]["observed_stock_units"] is not None and row["source"]["observed_stock_units"] >= qty
        rate = cost.price(qty, row["source"])
        small_lot_installed += D(row["fitted_quantity_two_boards"]) * rate
        small_lot_cash += D(qty) * rate
        if row["design_mpn"] in small_lot_override:
            small_lot_parts.append({"mpn": row["design_mpn"], "references": row["references"], "fitted_quantity": row["fitted_quantity_two_boards"],
                                    "paid_catalog_quantity": qty, "paid_unit_rate": rate, "paid_catalog_cost": D(qty) * rate,
                                    "surplus_quantity": qty - row["fitted_quantity_two_boards"], "source_url": row["source"]["url"]})
    assert small_lot_installed == D("41.1380") and small_lot_cash == D("54.0819")
    small_lot = {"status": "UNADOPTED_EXPLICIT_PAID_LOTS_NOT_DELIVERED_QUOTE", "installed_value_two_boards": small_lot_installed,
                 "installed_value_per_board": small_lot_installed / 2, "catalog_lot_spend_two_boards_before_assembly_overage": small_lot_cash,
                 "component_reduction_vs_frozen_pn532_percent": (1 - small_lot_installed / (2 * baseline)) * 100,
                 "estimated_50_percent_fitted_threshold_met": small_lot_installed / 2 <= target["50"]["fitted_target_per_board"],
                 "estimated_80_percent_fitted_threshold_met": False, "50_percent_fitted_headroom_per_board": target["50"]["fitted_target_per_board"] - small_lot_installed / 2,
                 "two_board_turnkey_50_or_80_percent_demonstrated": False, "actual_procurement_cost": None,
                 "sources_adopted": False, "explicit_lot_changes": small_lot_parts,
                 "remaining_quote_gates": "Exact distributor stock/rate refresh, tape/actual assembler overage and landed prices; installed value attributes only fitted units, while full surplus lots are charged in catalog spend."}
    observations = [
        {"mpn": "RC0603FR-0722RL", "manufacturer": "YAGEO", "url": "https://www.mouser.com/en/ProductDetail/YAGEO/RC0603FR-0722RL?qs=diQw95jMAeMOsxb8bne7fg%3D%3D",
         "observation_kind": "Primary distributor indexed page, crawled two days before this check", "checked_local_date": "2026-10-03", "observed_stock_units": 336400,
         "currency": "USD", "minimum_order_quantity": 1, "order_multiple": 1,
         "price_breaks": [{"minimum_quantity": 1, "unit_price": D(".12")}, {"minimum_quantity": 10, "unit_price": D(".012")}, {"minimum_quantity": 100, "unit_price": D(".01")}, {"minimum_quantity": 1000, "unit_price": D(".008")}],
         "minimum_purchase_for_four": D(".48"), "optional_ten_piece_lot_cost": D(".12"), "mouse_reel_fee_excluded_usd": 7,
         "source_adopted": False, "mpn_substitution_approved": False},
        {"mpn": "ESP32-C3-MINI-1-N4X", "manufacturer": "Espressif Systems", "url": "https://www.mouser.com/en/ProductDetail/Espressif-Systems/ESP32-C3-MINI-1-N4X?qs=sGAEpiMZZMu3sxpa5v1qrhsPVXYeIr6WaCDCqeWXxSE%3D",
         "observation_kind": "Primary distributor indexed page, crawled last week", "checked_local_date": "2026-10-03", "observed_stock_units": 3221,
         "currency": "USD", "minimum_order_quantity": 1, "order_multiple": 1,
         "price_breaks": [{"minimum_quantity": 1, "unit_price": D("3.26")}, {"minimum_quantity": 10, "unit_price": D("2.82")}, {"minimum_quantity": 25, "unit_price": D("2.63")}, {"minimum_quantity": 100, "unit_price": D("2.45")}],
         "two_piece_cost": D("6.52"), "cheaper_exact_low_quantity_source_found": False, "source_adopted": False},
    ]
    output = {"schema_version": 1, "status": "SEPARATE_UNADOPTED_PROCUREMENT_ADDENDUM_NOT_PURCHASE_RELEASE", "checked_local_date": "2026-10-03",
              "quantity": "Two assembled boards; no battery, DNP/copper excluded", "frozen_comparison_path": frozen_path.name, "frozen_comparison_sha256": sha(frozen_path),
              "frozen_pn532_source_sha256": frozen["baseline_snapshot_sha256"], "bom_selection_sha256": bom_hash,
              "package_catalog_path": "v03-package-catalog.json", "package_catalog_sha256_at_review": sha(ROOT / "v03-package-catalog.json"),
              "live_observations_path": live_path.name, "live_observations_sha256": sha(live_path),
              "no_mpn_substitutions_needed_for_identified_gaps": True, "mpn_substitutions_approved": [], "sources_adopted": [],
              "scope": "Partial same-MPN/current-manufacturer sourcing overlay. The other rows retain saved exact sources, not a fully current executable cart. Quote-time stock, traceability, tape, overage, fees and shipping remain open.",
              "gap_resolution": {"R3_R4": "Same exact YAGEO MPN available at live LCSC C107701 and indexed Mouser; former DigiKey source stock-zero.",
                                 "L3": "Exact Coilcraft MRC live LCSC price/stock available. Manufacturer direct page shows $1 but machine-ready leader/trailer for sub-reel tape costs $25; not included as free."},
              "frozen_baseline_per_board": baseline, "frozen_candidate_per_board": unchanged,
              "frozen_candidate_fitted_reduction_percent": frozen["comparison"]["installed_component_reduction_percent"],
              "overlay": totals, "overlay_fitted_reduction_vs_frozen_pn532_percent": (1 - overlay / baseline) * 100,
              "overlay_fitted_saving_vs_frozen_candidate_per_board": unchanged - overlay, "targets": target,
              "optional_cash_optimized_lots_attributed_fitted_value_two_boards": cash_optimized_attribution,
              "explicit_paid_small_lot_scenario": small_lot,
              "changed_source_rows": changed, "parts": rows, "additional_primary_distributor_observations": observations,
              "rejected_or_out_of_stock_live_observations": [p for p in live["sources"] if "error" in p or p.get("observed_stock_units") == 0],
              "primary_specs": {"usb_series_resistors": "https://yageogroup.com/component-documentation/download/specsheet/RC0603FR-0722RL",
                                "coilcraft_exact": "https://www.coilcraft.com/en-us/products/power/shielded-inductors/ferrite-drum/lps/lps3015/lps3015-152/",
                                "tps_lifecycle": "https://www.ti.com/product/TPS63031", "cc_lifecycle": "https://www.ti.com/product/TUSB320LAI", "charger_lifecycle": "https://www.ti.com/product/BQ24074"},
              "procurement_gates": ["PCBWay traceable exact manufacturers/ordering codes, lot/drypack and landed BOM acceptance; catalog authenticity claims alone do not prove authorized provenance.",
                                     "Confirm every retained saved supplier price and stock at quote time, especially exact RF passive parts; indexed pages are not live reservations.",
                                     "Quote actual turnkey overage, strips, reeling, panels, PCB finish, assembly/testing, supplier freight, tax, tariff and promotion eligibility.",
                                     "No substitutions preapproved. Any future MPN change requires hardware owner and assembly-clearance exact-family/spec review, updated package/source evidence and audits before adoption."]}
    cost.dump(output, ROOT / "pn7160-procurement-addendum.json")
    print(json.dumps({"overlay": totals, "reduction_percent": output["overlay_fitted_reduction_vs_frozen_pn532_percent"], "targets": target, "explicit_small_lots": small_lot,
                      "changed_sources": len(changed)}, indent=2, default=float))


if __name__ == "__main__":
    main()
