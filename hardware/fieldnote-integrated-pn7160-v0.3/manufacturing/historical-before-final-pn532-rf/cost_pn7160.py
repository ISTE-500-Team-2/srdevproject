#!/usr/bin/env python3
"""Reproduce two-board public component estimates from the locked exact BOM.

Reads saved supplier observations only; does not source, upload, quote, or order.
"""
from collections import defaultdict
from decimal import Decimal
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent
COUNT = 2
D = lambda value: Decimal(str(value))

PREFERRED = {
    "PN7160A1HN/C100E": "https://www.lcsc.com/product-detail/C3303788.html",
    "CL10B225KP8NNNC": "https://www.lcsc.com/product-detail/C100082.html",
    "NX2016SA-27.12MHZ-EXS00A-CS06346": "https://www.lcsc.com/product-detail/C3008209.html",
    "LQW18CAR16J00D": "https://www.digikey.com/en/products/detail/murata-electronics/LQW18CAR16J00D/9742068",
    "RC0603FR-072K2L": "https://www.digikey.com/en/products/detail/yageo/RC0603FR-072K2L/727016",
    "CRCW08051R30FKEAHP": "https://www.digikey.com/en/products/detail/vishay-dale/CRCW08051R30FKEAHP/2226646",
    "CC0603GRNPO9BN331": "https://www.digikey.com/en/products/detail/yageo/CC0603GRNPO9BN331/5883558",
    "CC0603GRNPO9BN131": "https://www.lcsc.com/product-detail/C519476.html",
    "CBR06C130F5GAC": "https://www.lcsc.com/product-detail/C2265569.html",
    "CC0603JRX7R9BB102": "https://www.lcsc.com/product-detail/C131031.html",
    "RC0603JR-070RL": "https://www.digikey.com/en/products/detail/yageo/RC0603JR-070RL/726675",
}


def read(path):
    return json.loads(path.read_text(), parse_float=Decimal)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def numeric(value):
    return float(value) if isinstance(value, Decimal) else value


def dump(value, path):
    path.write_text(json.dumps(value, indent=2, default=numeric) + "\n")


def purchase_quantity(qty, source):
    multiple = int(source["order_multiple"])
    assert multiple > 0
    minimum = int(source["minimum_order_quantity"])
    return ((max(qty, minimum) + multiple - 1) // multiple) * multiple


def price(qty, source):
    valid = [row for row in source["price_breaks"] if int(row["minimum_quantity"]) <= qty]
    if not valid:
        raise ValueError(f"No eligible unit-price tier for {qty} units: {source['url']}")
    return D(max(valid, key=lambda row: int(row["minimum_quantity"]))["unit_price"])


def cost_row(mpn, refs, footprints, source):
    fitted = COUNT * len(refs)
    minimum = purchase_quantity(fitted, source)
    rate = price(minimum, source)
    candidates = {minimum}
    for row in source["price_breaks"]:
        q = purchase_quantity(max(fitted, int(row["minimum_quantity"])), source)
        if source.get("observed_stock_units") is None or q <= source["observed_stock_units"]:
            candidates.add(q)
    cheapest = min(candidates, key=lambda qty: (D(qty) * price(qty, source), qty))
    rc_eligible = all(ref[0] in "RC" for ref in refs) and all(fp in {"C_0603", "C_0805", "R_0603", "R_0805"} for fp in footprints)
    consigned = purchase_quantity(max(50, fitted + 30), source) if rc_eligible else None
    return {
        "design_mpn": mpn,
        "references": sorted(refs),
        "quantity_per_board": len(refs),
        "fitted_quantity_two_boards": fitted,
        "source": source,
        "installed_unit_price": rate,
        "installed_value_two_boards": D(fitted) * rate,
        "minimum_catalog_purchase_quantity": minimum,
        "minimum_catalog_purchase_cost": D(minimum) * rate,
        "optional_cash_optimized_purchase_quantity": cheapest,
        "optional_cash_optimized_purchase_unit_price": price(cheapest, source),
        "optional_cash_optimized_purchase_cost": D(cheapest) * price(cheapest, source),
        "consigned_rc_rule_applies": rc_eligible,
        "consigned_rc_minimum_quantity": consigned,
        "consigned_rc_minimum_catalog_cost": D(consigned) * price(consigned, source) if consigned else None,
        "actual_turnkey_overage_quote": None,
    }


def summary(rows):
    installed = sum((row["installed_value_two_boards"] for row in rows), D(0))
    minimum = sum((row["minimum_catalog_purchase_cost"] for row in rows), D(0))
    optimized = sum((row["optional_cash_optimized_purchase_cost"] for row in rows), D(0))
    rc = sum((row["consigned_rc_minimum_catalog_cost"] for row in rows if row["consigned_rc_rule_applies"]), D(0))
    non_rc = sum((row["minimum_catalog_purchase_cost"] for row in rows if not row["consigned_rc_rule_applies"]), D(0))
    return {"fitted_components_per_board": sum(row["quantity_per_board"] for row in rows),
            "unique_fitted_mpns": len(rows),
            "installed_value_two_boards": installed,
            "installed_value_per_board": installed / COUNT,
            "minimum_catalog_purchase_without_assembly_overage": minimum,
            "optional_cash_optimized_catalog_purchase_without_assembly_overage": optimized,
            "consigned_rc_purchase_subtotal": rc,
            "non_rc_minimum_purchase_subtotal_without_required_overage": non_rc,
            "catalog_floor_with_consigned_rc_rule_only": rc + non_rc,
            "actual_procurement_cost": None,
            "delivered_assembled_cost": None}


def main():
    baseline_path = ROOT / "pn532-baseline-sourcing-snapshot.json"
    baseline = read(baseline_path)
    observations = read(ROOT / "pn7160-source-observations.json")
    live = read(ROOT / "lcsc-live-snapshots.json")
    variants = {(row["mpn"], row["url"]): row for row in observations["sources"]}
    variants.update({(row["mpn"], row["url"]): row for row in live["sources"] if "error" not in row})
    source_map = {}
    baseline_rows = []
    for row in baseline["parts"]:
        mpn = row["design_mpn"]
        p = row["public_price_snapshot"]
        source = {"url": p["source_url"], "currency": p["currency"],
                  "observed_stock_units": row["supply_snapshot"]["listed_stock_units"],
                  "minimum_order_quantity": p["minimum_order_quantity"], "order_multiple": p["order_multiple"],
                  "price_breaks": p["price_breaks"], "provenance": "Frozen reconciled PN532 source snapshot; no new sourcing credit.",
                  "frozen_installed_unit_price": p["installed_cost_unit_price"],
                  "notes": [row.get("package_and_selection_notes", "")],
                  "stock_reserved": False, "assembler_landed_quote": False}
        source_map[mpn] = source
        baseline_rows.append(cost_row(mpn, row["references"], [row["design_footprint"]], source))
    baseline_total = summary(baseline_rows)
    assert baseline_total["installed_value_two_boards"] == D("82.7306"), baseline_total
    for mpn, url in PREFERRED.items():
        source_map[mpn] = variants[(mpn, url)]

    design_path = PROJECT / "design-data.json"
    design = read(design_path)
    fitted = [part for part in design["parts"] if not part.get("dnp") and part.get("mpn") not in {"", None, "PCB copper"}]
    selected = {part["ref"]: part for part in fitted}
    required = {"U2": "PN7160A1HN/C100E", "Y1": "NX2016SA-27.12MHZ-EXS00A-CS06346",
                "C22": "CBR06C130F5GAC", "C23": "CBR06C130F5GAC", "L1": "LQW18CAR16J00D", "L2": "LQW18CAR16J00D",
                "C24": "CC0603GRNPO9BN331", "C25": "CC0603GRNPO9BN331", "C28": "CC0603GRNPO9BN331", "C29": "CC0603GRNPO9BN331",
                "C26": "CC0603GRNPO9BN131", "C27": "CC0603GRNPO9BN131", "R22": "CRCW08051R30FKEAHP", "R23": "CRCW08051R30FKEAHP",
                "C31": "CC0603JRX7R9BB102", "C37": "CC0603JRX7R9BB102", "R27": "RC0603JR-070RL",
                "U1": "ESP32-C3-MINI-1-N4X", "U3": "BQ24074RGTR", "U4": "TPS63031DSKR", "U6": "TUSB320LAIRWBR"}
    for ref, mpn in required.items():
        assert selected[ref]["mpn"] == mpn, f"Unexpected locked part: {ref}"
    for part in design["parts"]:
        if not part.get("dnp") and part["ref"][0] in "CRLUYDJ" and not part.get("mpn"):
            raise ValueError(f"Unpriced fitted physical part: {part['ref']}")
    by_mpn = defaultdict(list)
    for part in fitted:
        by_mpn[part["mpn"]].append(part)
    rows = [cost_row(mpn, [p["ref"] for p in parts], list({p["fp"] for p in parts}), source_map[mpn])
            for mpn, parts in sorted(by_mpn.items())]
    variant_total = summary(rows)
    bom = [{key: part.get(key) for key in ["ref", "mpn", "value", "fp", "dnp"]} for part in sorted(design["parts"], key=lambda p: p["ref"])]
    bom_hash = hashlib.sha256(json.dumps(bom, sort_keys=True, separators=(",", ":"), default=numeric).encode()).hexdigest()
    frozen_total = baseline_total["installed_value_two_boards"]
    candidate_total = variant_total["installed_value_two_boards"]
    baseline_by_ref = {ref: row for row in baseline["parts"] for ref in row["references"]}
    changes = []
    for part in sorted(design["parts"], key=lambda p: p["ref"]):
        old = baseline_by_ref.get(part["ref"])
        new = part.get("mpn") if not part.get("dnp") else None
        if old and old["design_mpn"] == new:
            continue
        if old or new in PREFERRED:
            changes.append({"reference": part["ref"], "baseline_mpn": old["design_mpn"] if old else None,
                            "variant_mpn": new, "variant_value": part.get("value"), "variant_dnp": part.get("dnp", False)})
    new_refs = {p["ref"] for p in design["parts"]}
    for ref, old in baseline_by_ref.items():
        if ref not in new_refs:
            changes.append({"reference": ref, "baseline_mpn": old["design_mpn"], "variant_mpn": None, "removed": True})
    original_pn532_rate = source_map["PN5321A3HN/C106,55"]["frozen_installed_unit_price"]
    pn532_source_overlay = frozen_total + COUNT * (D("13.4077") - D(original_pn532_rate))
    output = {
        "schema_version": 1, "project": "Fieldnote integrated PN7160 v0.3", "assembled_boards": COUNT,
        "status": "Engineering candidate component estimate; not procurement release or PCBWay quote.",
        "price_scope": "USD public part prices. Fitted value, MOQ/multiples, and optional cash-optimized lots are separate. No assembly, bare PCBs, shipping, taxes, tape service, procurement markup, or actual overage.",
        "baseline_snapshot_sha256": digest(baseline_path), "variant_design_sha256_at_calculation": digest(design_path),
        "variant_bom_selection_sha256": bom_hash,
        "baseline": baseline_total, "variant": variant_total,
        "comparison": {"installed_component_saving_two_boards": frozen_total - candidate_total,
                       "installed_component_saving_per_board": (frozen_total - candidate_total) / COUNT,
                       "installed_component_reduction_percent": (D(1) - candidate_total / frozen_total) * 100,
                       "optional_same_mpn_pn532_source_overlay_two_boards": pn532_source_overlay,
                       "optional_pn532_source_overlay_component_reduction_percent": (D(1) - candidate_total / pn532_source_overlay) * 100,
                       "optional_pn532_source_overlay_rate_usd": D("13.4077"),
                       "optional_pn532_source_overlay_url": "https://www.lcsc.com/product-detail/C28925.html",
                       "optional_source_overlay_is_separate_not_new_primary_baseline": True,
                       "50_percent_target_proven": False, "80_percent_target_proven": False,
                       "delivered_price_comparison_possible": False},
        "exact_reader_source_sensitivity": [{"supplier_url": row["url"], "reader_unit_price": row["price_breaks"][0]["unit_price"],
                                            "whole_candidate_installed_two_boards": candidate_total + COUNT * (D(row["price_breaks"][0]["unit_price"]) - D("4.041"))}
                                           for row in observations["sources"] if row["mpn"] == "PN7160A1HN/C100E"],
        "parts": rows, "baseline_rows_for_comparison": baseline_rows, "changes": sorted(changes, key=lambda r:r["reference"]),
        "unfitted": [{"ref": p["ref"], "mpn": p.get("mpn"), "value": p.get("value")} for p in design["parts"] if p.get("dnp")],
        "overage_rule": {"scope": "Illustrative PCBWay customer-consigned 0603/0805 R/C rule only; not automatic turnkey requirement.",
                         "required_quantity": "max(50, fitted two-board quantity +30), then source MOQ/multiple rounding.",
                         "source_url": "https://www.pcbway.com/assembly-faq.html",
                         "other_components": "Exact IC/connector overage, inductors, crystals, LED/switch allowances, and leader/trailer requirements require the assembler quote.",
                         "actual_complete_overage_cost": None},
        "procurement_gates": ["PCBWay exact-source/lot traceability and landed component prices, including NXP firmware/revision/MSL3 drypack handling.",
                              "Fresh stock/price quote for older DigiKey observations and unchanged source rows (including stock-zero RC0603FR-0722RL).",
                              "Electrical, RF, firmware, footprint, placement and routing signoff for the new circuit; no hardware functional-parity claim from BOM pricing.",
                              "Panel, bare-board quantity, stencil/setup/labor, programming/testing, supplier shipping, tax, tariff and assembler fees quote.",
                              "Ask that valuable unused parts be returned or stored; default unused-part return is not promised."],
    }
    dump(output, ROOT / "pn7160-procurement.json")
    print(json.dumps({"bom_selection_sha256": bom_hash, "baseline": baseline_total, "variant": variant_total,
                      "comparison": output["comparison"]}, default=numeric, indent=2))


if __name__ == "__main__":
    main()
