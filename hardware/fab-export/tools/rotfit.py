"""Fit the JLC (EasyEDA library) footprint of a part onto the KiCad footprint used on the
board, to derive (a) the JLC CPL rotation correction and (b) a footprint-match figure.

Convention used everywhere in this package:
    kicad_local(y-up) = R(theta) * jlc_local(y-up) + t
    JLC CPL rotation  = (KiCad footprint rotation + theta) mod 360      (top side)
theta is the 'rotation correction' for that footprint/part pair.
"""
import math
import easyeda_fp as E


def _rot(x, y, deg):
    a = math.radians(deg)
    return (x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a))


def _norm(n):
    return str(n).strip().upper()


def fit(kpads, epads):
    """kpads: [{'num','lx','ly'}] (KiCad local, y-down). epads: easyeda_fp.pads() output.
    Returns list of candidate dicts sorted best-first:
      theta, max_err, rms_err, t (KiCad-local y-down offset of the JLC origin),
      bbox_c (KiCad-local y-down centre of the JLC pads' bounding box),
      nummap {kicad num -> jlc num}, ident (fraction of KiCad pads whose number matches)."""
    K = [(_norm(p["num"]), p["lx"], -p["ly"]) for p in kpads if p["num"] != "" or p.get("kind") != "npth"]
    K = [k for k in K if k[0] != ""]
    Eu = [(_norm(p["num"]), p["x"], -p["y"]) for p in epads]
    if not K or not Eu:
        return []
    kx = [k[1] for k in K]; ky = [k[2] for k in K]
    kc = ((min(kx) + max(kx)) / 2, (min(ky) + max(ky)) / 2)
    out = []
    for th in (0, 90, 180, 270):
        R = [(n,) + _rot(x, y, th) for n, x, y in Eu]
        rx = [r[1] for r in R]; ry = [r[2] for r in R]
        rc = ((min(rx) + max(rx)) / 2, (min(ry) + max(ry)) / 2)
        t0 = (kc[0] - rc[0], kc[1] - rc[1])
        # nearest-neighbour match, then refine translation once
        for _ in range(2):
            pairs = []
            for n, x, y in K:
                best = min(R, key=lambda r: (r[1] + t0[0] - x) ** 2 + (r[2] + t0[1] - y) ** 2)
                pairs.append(((n, x, y), best))
            t0 = (sum(k[1] - r[1] for k, r in pairs) / len(pairs),
                  sum(k[2] - r[2] for k, r in pairs) / len(pairs))
        errs = [math.hypot(r[1] + t0[0] - k[1], r[2] + t0[1] - k[2]) for k, r in pairs]
        nummap = {}
        ident = 0
        for k, r in pairs:
            nummap.setdefault(k[0], set()).add(r[0])
            ident += 1 if k[0] == r[0] else 0
        out.append({
            "theta": th, "max_err": max(errs), "rms_err": math.sqrt(sum(e * e for e in errs) / len(errs)),
            "t": (t0[0], -t0[1]),
            "bbox_c": (rc[0] + t0[0], -(rc[1] + t0[1])),
            "nummap": {k: sorted(v) for k, v in nummap.items()},
            "ident": ident / len(pairs), "n_k": len(K), "n_e": len(Eu),
        })
    out.sort(key=lambda c: (round(c["max_err"], 2), -c["ident"]))
    return out


def classify(cands, tol=0.30):
    """-> (status, chosen, text). status: 'ok' (unique geometry, numbers agree),
    'ok-sym' (several geometric fits, exactly one agrees by pad number),
    'symmetric' (non-polar 2-pad part, any fit is fine), 'numbering' (geometry fits but
    pad numbers disagree -> needs a human decision), 'nofit'."""
    if not cands:
        return "nodata", None, "no pads"
    good = [c for c in cands if c["max_err"] <= tol]
    if not good:
        c = cands[0]
        return "nofit", c, "best fit theta=%d max pad error %.2f mm (JLC %d pads vs KiCad %d)" % (
            c["theta"], c["max_err"], c["n_e"], c["n_k"])
    full = [c for c in good if c["ident"] > 0.999]
    if len(full) == 1:
        c = full[0]
        return ("ok" if len(good) == 1 else "ok-sym"), c, "theta=%d, max pad error %.2f mm" % (
            c["theta"], c["max_err"])
    if len(full) > 1:
        c = full[0]
        return "symmetric", c, "pad numbers match at theta=%s" % [x["theta"] for x in full]
    c = max(good, key=lambda x: x["ident"])
    return "numbering", c, "geometry fits at theta=%s but pad numbers differ (best ident %.0f%% at %d): %s" % (
        [x["theta"] for x in good], c["ident"] * 100, c["theta"],
        {k: v for k, v in list(c["nummap"].items())[:8]})


def jlc_pads_on_board(fp, epads, theta, t):
    """EasyEDA pads transformed into board coordinates (y-down) for footprint `fp`
    (dict from board.load) given correction theta and KiCad-local offset t."""
    import board as B
    res = []
    for p in epads:
        x, y = _rot(p["x"], -p["y"], theta)          # y-up
        lx, ly = x + t[0], -y + t[1]                 # KiCad local y-down
        dx, dy = B.rotate(lx, ly, fp["rot"])
        w, h = (p["w"], p["h"]) if theta % 180 == 0 else (p["h"], p["w"])
        if fp["rot"] % 180 == 90:
            w, h = h, w
        res.append({"num": p["num"], "x": fp["x"] + dx, "y": fp["y"] + dy, "w": w, "h": h})
    return res
