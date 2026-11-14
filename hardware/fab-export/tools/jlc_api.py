"""Small cached client for the public JLCPCB parts search, LCSC product detail
and EasyEDA footprint endpoints. No credentials, no project data is sent - only
part numbers. Cache lives in fab-export/cache/ so runs are repeatable offline."""
import json, os, ssl, time, urllib.request, urllib.parse, hashlib

try:  # KiCad's bundled Python has no system CA store; fall back to certifi
    import certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # pragma: no cover
    _CTX = ssl.create_default_context()

CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def _fetch(url, data=None, key=None, refresh=False, binary=False):
    os.makedirs(CACHE, exist_ok=True)
    key = key or hashlib.sha1((url + (data or "")).encode()).hexdigest()
    path = os.path.join(CACHE, key)
    if os.path.exists(path) and not refresh:
        with open(path, "rb") as f:
            raw = f.read()
    else:
        hdr = {"User-Agent": UA, "Accept": "application/json"}
        if data is not None:
            hdr["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data.encode() if data else None, headers=hdr)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30, context=_CTX) as r:
                    raw = r.read()
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2 + attempt * 3)
        with open(path, "wb") as f:
            f.write(raw)
        time.sleep(0.4)
    return raw if binary else json.loads(raw)


def jlc_search(keyword, refresh=False, page_size=25):
    """JLCPCB assembly parts library search. Returns list of component dicts."""
    body = json.dumps({"keyword": keyword, "currentPage": 1, "pageSize": page_size})
    d = _fetch("https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/"
               "selectSmtComponentList/v2", body,
               key="jlcsearch_" + urllib.parse.quote(keyword, safe="") + ".json", refresh=refresh)
    return ((d.get("data") or {}).get("componentPageInfo") or {}).get("list") or []


def jlc_part(lcsc, refresh=False):
    """Exact lookup of one C-number in the JLC assembly library (None if absent)."""
    for c in jlc_search(lcsc, refresh=refresh):
        if c.get("componentCode") == lcsc:
            return c
    return None


def lcsc_detail(lcsc, refresh=False):
    d = _fetch("https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=" + lcsc,
               key="lcsc_" + lcsc + ".json", refresh=refresh)
    return d.get("result") or {}


def easyeda_component(lcsc, refresh=False):
    """Footprint + symbol record from the JLCEDA/EasyEDA Official Library
    (https://lceda.cn/ , https://easyeda.com). Returns None when the part has no
    library footprint. easyeda.com rate-limits hard (HTTP 403 after ~30 calls), so the
    lceda.cn mirror of the same library is tried first and calls are paced."""
    key = "ee_" + lcsc + ".json"
    path = os.path.join(CACHE, key)
    if os.path.exists(path) and not refresh:
        with open(path, "rb") as f:
            return json.loads(f.read()).get("result") or None
    last = None
    for host in ("lceda.cn", "easyeda.com"):
        try:
            d = _fetch("https://%s/api/products/%s/components?version=6.4.19.5" % (host, lcsc),
                       key=key, refresh=True)
            time.sleep(1.0)
            if d.get("result") or d.get("code") == 404:
                return d.get("result") or None
        except Exception as e:  # try the other host
            last = e
        if os.path.exists(path):
            os.remove(path)
    if last:
        raise last
    return None


def easyeda_cached(lcsc):
    """Cache-only variant (no network)."""
    path = os.path.join(CACHE, "ee_" + lcsc + ".json")
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return json.loads(f.read()).get("result") or None
