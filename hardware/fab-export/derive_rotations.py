#!/usr/bin/env python3
"""derive_rotations.py <project_dir> [--refresh] [--qty N]

Fits every fitted part's JLC library footprint (JLCEDA/EasyEDA Official Library,
https://lceda.cn/ / https://easyeda.com) onto the KiCad footprint on the board and prints
the rotation correction it implies, the worst pad-centre error, and whether pad numbering
agrees. Read-only: use the output to review/extend rotation-corrections.json.
"""
import argparse, glob, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
import kicad_env
kicad_env.ensure_pcbnew()
import board as B, sourcing, jlc_api, rotfit, easyeda_fp as E


def find_pcb(project_dir):
    c = [p for p in glob.glob(os.path.join(project_dir, "*.kicad_pcb")) if not os.path.basename(p).startswith("_")]
    pref = [p for p in c if os.path.basename(p) == "fieldnote.kicad_pcb"]
    if pref:
        return pref[0]
    if len(c) != 1:
        raise SystemExit("expected exactly one .kicad_pcb in %s, found %s" % (project_dir, c))
    return c[0]


def fit_all(board, per_ref, refresh=False, fetch=True):
    """-> {ref: {status, theta, text, cand, epads, package, pins}}"""
    out = {}
    for fp in board["footprints"]:
        s = per_ref.get(fp["ref"], {})
        if not s.get("fitted") or not s.get("lcsc"):
            continue
        try:
            comp = jlc_api.easyeda_component(s["lcsc"], refresh=refresh) if fetch else jlc_api.easyeda_cached(s["lcsc"])
        except Exception as e:
            out[fp["ref"]] = {"status": "nodata", "text": "library fetch failed: %s" % e}
            continue
        if not comp:
            out[fp["ref"]] = {"status": "nodata", "text": "no JLC library footprint for %s" % s["lcsc"]}
            continue
        ep = E.pads(comp)
        cands = rotfit.fit(fp["pads"], ep)
        st, c, text = rotfit.classify(cands)
        out[fp["ref"]] = {"status": st, "theta": c["theta"] if c else None, "text": text, "cand": c,
                          "cands": cands, "epads": ep, "package": E.package_name(comp), "pins": E.pin_names(comp)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir"); ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--qty", type=int, default=10)
    a = ap.parse_args()
    board = B.load(find_pcb(a.project_dir))
    rows, per_ref = sourcing.resolve(a.project_dir, board, qty=a.qty)
    fits = fit_all(board, per_ref, refresh=a.refresh)
    seen = {}
    for fp in board["footprints"]:
        f = fits.get(fp["ref"])
        if not f:
            continue
        key = (fp["fp"], per_ref[fp["ref"]]["lcsc"])
        seen.setdefault(key, []).append(fp["ref"])
        if len(seen[key]) > 1:
            continue
        c = f.get("cand") or {}
        print("%-26s %-10s %-6s %-10s theta=%-4s err=%-5s off=(%+.2f,%+.2f) bbox=(%+.2f,%+.2f) %s | %s" % (
            fp["fp"], key[1], fp["ref"], f["status"], f.get("theta"),
            ("%.2f" % c["max_err"]) if c else "-", *(c.get("t") or (0, 0)), *(c.get("bbox_c") or (0, 0)),
            f.get("package", ""), f["text"]))
        if f["status"] in ("numbering", "nofit"):
            kn = {p["num"]: (p["fn"] or "") for p in fp["pads"]}
            print("      KiCad pins:", kn)
            print("      JLC   pins:", f.get("pins"))


if __name__ == "__main__":
    main()
