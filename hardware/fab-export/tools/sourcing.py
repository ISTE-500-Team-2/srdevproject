"""Resolve every fitted part of a Fieldnote project to a JLCPCB/LCSC part number.

Inputs : <project>/design-data.json (ref -> MPN), the board (DNP / BOM-exclude flags),
         fab-export/sourcing-map.json (curated decisions), live JLC + LCSC stock (cached).
Outputs: list of per-MPN rows and a per-ref dict used by the BOM writer.
"""
import csv, json, os, re
import jlc_api

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP = os.path.join(HERE, "sourcing-map.json")
NOT_A_PART = {"", "PCB copper"}


def load_design(project_dir):
    p = os.path.join(project_dir, "design-data.json")
    if not os.path.exists(p):
        return {}
    with open(p) as f:
        return {x["ref"]: x for x in json.load(f).get("parts", [])}


def _cls(c):
    if not c:
        return ""
    t = c.get("componentLibraryType")
    if t == "base":
        return "Basic"
    return "Preferred Extended" if c.get("preferredComponentFlag") else "Extended"


def _jlc(lcsc, refresh, offline):
    if not lcsc:
        return None
    try:
        return jlc_api.jlc_part(lcsc, refresh=refresh)
    except Exception:
        if offline:
            return None
        raise


def _lcsc_stock(lcsc, refresh):
    try:
        return jlc_api.lcsc_detail(lcsc, refresh=refresh).get("stockNumber")
    except Exception:
        return None


def _auto_match(mpn, refresh):
    """Unmapped MPN: accept only a single exact-name hit from a real manufacturer."""
    try:
        hits = jlc_api.jlc_search(mpn, refresh=refresh)
    except Exception:
        return None
    ex = [c for c in hits if (c.get("componentModelEn") or "").upper() == mpn.upper()
          and c.get("componentBrandEn") != "JLCPCB Assembly"]
    return ex[0] if len(ex) == 1 else None


def resolve(project_dir, board, qty=10, refresh=False, extra_dnp=()):
    """-> (rows, per_ref). rows are grouped by design MPN (fitted parts only)."""
    design = load_design(project_dir)
    with open(MAP) as f:
        smap = json.load(f)["parts"]
    groups, per_ref = {}, {}
    for fp in board["footprints"]:
        ref = fp["ref"]
        d = design.get(ref, {})
        mpn = (fp["fields"].get("MPN") or d.get("mpn") or "").strip()
        dnp = fp["dnp"] or ref in extra_dnp
        if fp["no_bom"] or fp["board_only"] or mpn in NOT_A_PART and fp["no_pos"]:
            per_ref[ref] = {"ref": ref, "fitted": False, "reason": "not a component (BOM-excluded)"}
            continue
        if dnp:
            per_ref[ref] = {"ref": ref, "fitted": False, "reason": "DNP", "design_mpn": mpn}
            continue
        key = mpn or "?%s|%s" % (fp["value"], fp["fp"])
        g = groups.setdefault(key, {"design_mpn": mpn, "refs": [], "value": fp["value"],
                                    "fp": fp["fp"], "notes": set()})
        g["refs"].append(ref)
        if fp["value"] != g["value"]:
            g["value"] = g["value"]  # keep first; differing values share an MPN (e.g. '10k' / '10k 1%')
        if d and d.get("dnp") and not dnp:
            g["notes"].add("%s is DNP in design-data but fitted on the board" % ref)
    rows = []
    for key, g in groups.items():
        m = smap.get(g["design_mpn"])
        need = qty * len(g["refs"])
        floor = need * 2 + 10
        row = dict(g, need=need, alt_used=False, alts_text="", basic_alt="", check="")
        cands = []
        if m is None:
            hit = _auto_match(g["design_mpn"], refresh) if g["design_mpn"] else None
            if hit:
                cands = [{"lcsc": hit["componentCode"], "mfr": hit.get("componentBrandEn"),
                          "mpn": g["design_mpn"], "check": "AUTO-MATCHED by exact MPN, not reviewed"}]
                row["status"] = "auto-matched (unreviewed)"
            else:
                row.update(status="UNRESOLVED - add to sourcing-map.json", lcsc="", fit_mfr="",
                           fit_mpn=g["design_mpn"], jlc_class="", jlc_stock="", lcsc_stock="", jlc_desc="")
                rows.append(row)
                continue
            policy = "exact"
        else:
            policy = m.get("policy", "exact")
            row["check"] = m.get("check", "")
            row["basic_alt"] = m.get("basic_alt", "")
            if m.get("lcsc"):
                cands.append({"lcsc": m["lcsc"], "mfr": m.get("mfr"), "mpn": m.get("mpn", g["design_mpn"]),
                              "check": m.get("check", ""), "primary": True})
            for a in m.get("alts", []):
                cands.append(dict(a))
            row["alts_text"] = "; ".join("%s %s (%s)" % (a.get("mfr", ""), a.get("mpn", ""), a["lcsc"])
                                         for a in m.get("alts", []))
        info = []
        for c in cands:
            j = _jlc(c["lcsc"], refresh, offline=not refresh)
            c["jlc"] = j
            c["jlc_stock"] = (j or {}).get("stockCount")
            info.append("%s=%s" % (c["lcsc"], c["jlc_stock"]))
        chosen = None
        if policy == "consign":
            chosen = None
        else:
            pool = [c for c in cands if not (policy == "substitute" and c.get("primary"))]
            for c in pool:
                if (c["jlc_stock"] or 0) >= floor:
                    chosen = c
                    break
            if chosen is None and pool and policy != "substitute":
                # nothing meets the floor: take whichever has the most stock, flag it
                best = max(pool, key=lambda c: c["jlc_stock"] or 0)
                chosen = best if (best["jlc_stock"] or 0) >= need else None
        prim = next((c for c in cands if c.get("primary")), None)
        if chosen is None:
            if policy == "consign" or not cands:
                st = "CONSIGN"
            else:
                st = "CONSIGN / pre-order (no candidate has stock for %d pcs)" % need
            row.update(status=st, lcsc="", fit_mfr=(m or {}).get("mfr", ""), fit_mpn=g["design_mpn"],
                       jlc_class="", jlc_stock=(prim or {}).get("jlc_stock", ""),
                       lcsc_stock=_lcsc_stock(prim["lcsc"], refresh) if prim else "",
                       jlc_desc="")
        else:
            is_alt = not chosen.get("primary")
            st = row.get("status") or ("SUBSTITUTE" if is_alt else "as designed")
            if is_alt and prim is not None and policy == "exact":
                st = "SUBSTITUTE (design MPN stock %s < %d)" % (prim["jlc_stock"], floor)
            if (chosen["jlc_stock"] or 0) < floor:
                st += " - LOW STOCK"
            row.update(status=st, lcsc=chosen["lcsc"], fit_mfr=chosen.get("mfr") or "",
                       fit_mpn=chosen.get("mpn") or g["design_mpn"], alt_used=is_alt,
                       jlc_class=_cls(chosen["jlc"]), jlc_stock=chosen["jlc_stock"],
                       lcsc_stock=_lcsc_stock(chosen["lcsc"], refresh),
                       jlc_desc=((chosen["jlc"] or {}).get("describe") or "").strip(),
                       jlc_package=(chosen["jlc"] or {}).get("componentSpecificationEn") or "")
            if is_alt:
                row["check"] = chosen.get("check", "")
        row["stock_seen"] = ", ".join(info)
        row["refs"].sort(key=_refkey)
        rows.append(row)
        for r in row["refs"]:
            per_ref[r] = {"ref": r, "fitted": True, "lcsc": row["lcsc"], "fit_mpn": row["fit_mpn"],
                          "fit_mfr": row["fit_mfr"], "status": row["status"], "value": row["value"],
                          "design_mpn": row["design_mpn"], "jlc_class": row["jlc_class"]}
    rows.sort(key=lambda r: _refkey(r["refs"][0]))
    return rows, per_ref


def _refkey(ref):
    m = re.match(r"([A-Za-z_]+)(\d+)", ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


COLS = [("Designators", lambda r: " ".join(r["refs"])), ("Qty/board", lambda r: len(r["refs"])),
        ("Value", lambda r: r["value"]), ("KiCad footprint", lambda r: r["fp"]),
        ("Design MPN", lambda r: r["design_mpn"]), ("Fitted manufacturer", lambda r: r["fit_mfr"]),
        ("Fitted MPN", lambda r: r["fit_mpn"]), ("LCSC", lambda r: r["lcsc"]),
        ("JLC class", lambda r: r["jlc_class"]), ("JLC stock", lambda r: r["jlc_stock"]),
        ("LCSC stock", lambda r: r["lcsc_stock"]), ("Status", lambda r: r["status"]),
        ("Footprint fit vs JLC library", lambda r: r.get("fp_fit", "")),
        ("JLC library description", lambda r: r.get("jlc_desc", "")),
        ("Spec check / note", lambda r: r.get("check", "")),
        ("Reviewed alternates", lambda r: r.get("alts_text", "")),
        ("Basic-part option (cost-down, not selected)", lambda r: r.get("basic_alt", "")),
        ("Stock seen per candidate", lambda r: r.get("stock_seen", ""))]


def write_csv(rows, path):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow([c[0] for c in COLS])
        for r in rows:
            w.writerow(["" if c[1](r) is None else c[1](r) for c in COLS])
