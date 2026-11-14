#!/usr/bin/env python3
"""Read public exact-part pages; never log in, upload a BOM, or create a quote."""
import concurrent.futures
import datetime
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PARTS = {
    "C3303788": "PN7160A1HN/C100E",
    "C100082": "CL10B225KP8NNNC",
    "C3008209": "NX2016SA-27.12MHZ-EXS00A-CS06346",
    "C95177": "RC0603JR-070RL",
    "C313850": "CRCW08051R00FKEAHP",
    "C519488": "CC0603FRNPO9BN130",
    "C519562": "CC0603FRNPO9BN331",
    "C327195": "CC0603GRNPO9BN331",
    "C519476": "CC0603GRNPO9BN131",
    "C3841235": "CC0603GRNPO9BN361",
    "C2265569": "CBR06C130F5GAC",
    "C131031": "CC0603JRX7R9BB102",
}


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def observe(item):
    code, expected = item
    url = f"https://www.lcsc.com/product-detail/{code}.html"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            status = response.status
        html = raw.decode("utf-8")
        match = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
        if not match:
            raise ValueError("Public product JSON not present")
        data = json.loads(match.group(1))
        matches = [v for v in walk(data) if v.get("productCode") == code
                   and "productPriceList" in v and "stockNumber" in v]
        if not matches:
            raise ValueError("Exact product price/stock object not found")
        product = matches[0]
        if product.get("productModel") != expected:
            raise ValueError(f"MPN mismatch: {product.get('productModel')!r} != {expected!r}")
        return {
            "mpn": expected,
            "lcsc_code": code,
            "url": url,
            "retrieved_at_utc": now,
            "http_status": status,
            "public_page_sha256": hashlib.sha256(raw).hexdigest(),
            "currency": "USD",
            "observed_stock_units": product["stockNumber"],
            "minimum_order_quantity": product["minBuyNumber"],
            "order_multiple": product["split"],
            "factory_pack_quantity": product["minPacketNumber"],
            "price_breaks": [{"minimum_quantity": v["ladder"], "unit_price": v["usdPrice"]}
                             for v in product["productPriceList"]],
            "stock_reserved": False,
            "assembler_landed_quote": False,
            "notes": ["Live public product-page JSON; no authenticated account or order.",
                      "Factory full-reel size is distinct from minimum order quantity.",
                      "Source traceability, shipping, taxes, reel service, and assembler markup are unquoted."],
        }
    except Exception as exc:
        return {"mpn": expected, "lcsc_code": code, "url": url,
                "retrieved_at_utc": now, "error": str(exc)}


def main():
    selected = {code: PARTS[code] for code in sys.argv[1:]} if len(sys.argv) > 1 else PARTS
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(observe, selected.items()))
    target = ROOT / "lcsc-live-snapshots.json"
    previous = json.loads(target.read_text())["sources"] if target.exists() else []
    combined = {row["lcsc_code"]: row for row in previous}
    combined.update({row["lcsc_code"]: row for row in records})
    output = {"schema_version": 1, "scope": "Public live source observations; not a purchase cart or PCBWay quote.",
              "sources": list(combined.values())}
    target.write_text(json.dumps(output, indent=2) + "\n")
    for row in records:
        print(row["lcsc_code"], row["mpn"], row.get("observed_stock_units"),
              row.get("minimum_order_quantity"), row.get("price_breaks", [])[:2], row.get("error", ""))


if __name__ == "__main__":
    main()
