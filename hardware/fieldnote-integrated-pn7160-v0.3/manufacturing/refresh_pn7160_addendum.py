#!/usr/bin/env python3
"""Read public exact-part listings into a separate, unadopted source addendum.

No login, quote, cart, upload, purchase, or changes to existing source evidence.
"""
import concurrent.futures
import datetime
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = ROOT / "pn7160-procurement-addendum-live-sources.json"


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def brand_choices(mpn):
    if mpn.startswith(("RC", "CC")):
        return {"yageo"}
    if mpn.startswith(("CBR", "C0603", "C0805")):
        return {"kemet"}
    if mpn.startswith("CL"):
        return {"samsungelectromechanics"}
    if mpn.startswith(("TPS", "BQ", "TUSB", "SN74")):
        return {"ti", "texasinstruments"}
    if mpn.startswith("PN"):
        return {"nxp", "nxpsemiconductors"}
    if mpn.startswith("NX"):
        return {"ndk"}
    if mpn.startswith("LPS"):
        return {"coilcraft"}
    if mpn.startswith(("BLM", "LQW")):
        return {"murata", "murataelectronics"}
    if mpn.startswith("BAV"):
        return {"diodes", "diodesincorporated"}
    if mpn.startswith("USBLC"):
        return {"st", "stmicroelectronics"}
    if mpn.startswith("APT"):
        return {"kingbright"}
    if mpn.startswith("TYPE-C"):
        return {"hro", "koreanhropartselec"}
    raise ValueError(f"Manufacturer binding missing for {mpn}")


def observe(item):
    code, expected = item
    url = f"https://www.lcsc.com/product-detail/{code}.html"
    output = {"mpn": expected, "lcsc_code": code, "url": url,
              "retrieved_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw, status = response.read(), response.status
        match = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', raw.decode(), re.S)
        if not match:
            raise ValueError("Public product data not present")
        product = next(v for v in walk(json.loads(match.group(1))) if v.get("productCode") == code
                       and "productPriceList" in v and "stockNumber" in v)
        output["observed_mpn"] = product["productModel"]
        output["observed_manufacturer"] = product["brandNameEn"]
        output["public_page_sha256"] = hashlib.sha256(raw).hexdigest()
        if product["productModel"] != expected:
            raise ValueError(f"Exact MPN mismatch: {product['productModel']} != {expected}")
        normalized = re.sub("[^a-z]", "", product["brandNameEn"].lower())
        if normalized not in brand_choices(expected):
            raise ValueError(f"Manufacturer mismatch: {product['brandNameEn']}")
        output.update({"http_status": status, "currency": "USD", "manufacturer_identity_checked": True,
                       "observed_stock_units": product["stockNumber"],
                       "minimum_order_quantity": product["minBuyNumber"], "order_multiple": product["split"],
                       "factory_pack_quantity": product["minPacketNumber"],
                       "supplier_package_description": product["encapStandard"],
                       "supplier_datasheet_url": product.get("pdfUrl"),
                       "price_breaks": [{"minimum_quantity": p["ladder"], "unit_price": p["usdPrice"]}
                                        for p in product["productPriceList"]],
                       "stock_reserved": False, "assembler_landed_quote": False,
                       "source_adopted": False, "mpn_substitution_approved": False})
    except Exception as exc:
        output["error"] = str(exc)
    return output


def main():
    old = json.loads(TARGET.read_text())
    parts = {v["lcsc_code"]: v["mpn"] for v in old["sources"]}
    parts.update({"C5353439": "APT2012SGC", "C5878906": "APT2012SECK", "C5875730": "APT2012SURCK"})
    selected = {code: parts[code] for code in sys.argv[1:]} if len(sys.argv) > 1 else parts
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(observe, selected.items()))
    combined = {row["lcsc_code"]: row for row in old["sources"]}
    combined.update({row["lcsc_code"]: row for row in records})
    TARGET.write_text(json.dumps({"schema_version": 1, "status": "Unadopted exact-part procurement research.",
                                 "scope": "Separate public stock and USD price observations; no BOM/CAD/source/manifest edits.",
                                 "sources": list(combined.values())}, indent=2) + "\n")
    for row in records:
        print(row["lcsc_code"], row["mpn"], row.get("observed_manufacturer"), row.get("observed_stock_units"),
              row.get("minimum_order_quantity"), row.get("price_breaks", [])[:1], row.get("error", ""))


if __name__ == "__main__":
    main()
