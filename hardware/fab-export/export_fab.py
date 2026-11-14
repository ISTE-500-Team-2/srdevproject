#!/usr/bin/env python3
"""export_fab.py <project_dir> <out_dir> [--build usb|field] [--qty N] [--refresh] [--offline]

JLCPCB-style fabrication + assembly package for a Fieldnote KiCad project:
  gerbers/   all copper, mask, silk, paste and Edge.Cuts (kicad-cli, Protel extensions, X2)
  drill/     Excellon, PTH and NPTH separate, metric, plus drill map
  <name>-BOM-JLC.csv   Comment, Designator, Footprint, LCSC   (fitted parts only; no DNP / test points / solder jumpers)
  <name>-CPL-JLC.csv   Designator, Mid X, Mid Y, Layer, Rotation   (JLC rotation/offset corrections applied)
  sourcing.csv         every fitted part: MPN, LCSC, class, stock, status, spec note, footprint fit vs JLC library
  rotation-report.csv  per placed part: KiCad rotation, correction, JLC rotation, fit error, source of the correction
  orientation-overlay.svg/.png   JLC library pads (red) drawn over the board pads (grey), pin-1 dots
  FAB-NOTES.md         stackup, finish, rules, panel/edge notes, DNP, consigned parts, assembly risks
  checks.json          sanity checks (layer count, drill hits vs board, CPL count, BOM lines)

Read-only on the project: the board is loaded through pcbnew and never saved.
--build usb (default) leaves J6 (field header, back-side THT) unfitted; --build field lists it as a hand-fit THT part.
"""
import argparse, csv, glob, json, math, os, re, shutil, subprocess, sys, hashlib
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "tools"))
import kicad_env
kicad_env.ensure_pcbnew()
import board as B, sourcing, rotfit, easyeda_fp as E          # noqa: E402
from derive_rotations import find_pcb, fit_all                 # noqa: E402

LAYERS = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu", "F.Mask", "B.Mask", "F.SilkS", "B.SilkS", "F.Paste", "B.Paste", "Edge.Cuts"]
CORR = os.path.join(HERE, "rotation-corrections.json")
AUTO_OK = ("ok", "ok-sym", "symmetric")


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("command failed: %s\n%s%s" % (" ".join(cmd), r.stdout, r.stderr))
    return r.stdout


# ------------------------------------------------------------------ CAM -----------------------------------------------
def cam(pcb, out):
    cli = kicad_env.kicad_cli()
    g, d = os.path.join(out, "gerbers"), os.path.join(out, "drill")
    for x in (g, d):
        shutil.rmtree(x, ignore_errors=True); os.makedirs(x)
    run([cli, "pcb", "export", "gerbers", "--layers", ",".join(LAYERS), "--subtract-soldermask", "--precision", "6",
         "--check-zones", "-o", g + os.sep, pcb])
    run([cli, "pcb", "export", "drill", "--format", "excellon", "--excellon-units", "mm", "--excellon-separate-th",
         "--excellon-zeros-format", "decimal", "--excellon-oval-format", "route", "--generate-map", "--map-format", "gerberx2",
         "-o", d + os.sep, pcb])
    return g, d


def gerber_functions(gdir):
    out = {}
    for p in sorted(glob.glob(os.path.join(gdir, "*"))):
        if p.endswith(".gbrjob"):
            continue
        m = re.search(r"%TF\.FileFunction,([^*]*)\*%", open(p, errors="replace").read())
        out[os.path.basename(p)] = m.group(1) if m else "?"
    return out


def excellon_hits(path):
    tools, hits, cur, slot = {}, Counter(), None, False
    for line in open(path, errors="replace"):
        line = line.strip()
        m = re.match(r"T(\d+)C([\d.]+)", line)
        if m:
            tools[m.group(1)] = float(m.group(2)); continue
        m = re.match(r"T(\d+)$", line)
        if m:
            cur = m.group(1); continue
        if line.startswith("G00X") or line.startswith("X") and cur:
            if line.startswith("G00"):
                slot = True
            hits["%.3f" % tools[cur]] += 1
        # route-mode slots: G00 start then M15 ... M16/M17; count the G00 line only
    return hits, slot


# ------------------------------------------------------------------ rotations / CPL -------------------------------------
def corrections():
    return json.load(open(CORR))["corrections"] if os.path.exists(CORR) else {}


def resolve_rotation(fp, s, fit, corr):
    key = "%s|%s" % (fp["fp"], s.get("lcsc") or "-")
    c = corr.get(key)
    if c is not None:
        th = c["theta"]
        cand = next((x for x in (fit or {}).get("cands", []) if x["theta"] == th), None)
        t = tuple(c["offset"]) if isinstance(c.get("offset"), list) else (cand["t"] if cand else (0.0, 0.0))
        return th, t, "curated: " + c["why"], cand["max_err"] if cand else None, key
    if fit and fit.get("status") in AUTO_OK:
        cand = fit["cand"]
        return cand["theta"], cand["t"], "auto (%s, %s)" % (fit["status"], fit["text"]), cand["max_err"], key
    reason = (fit or {}).get("text", "no fit data")
    return 0, (0.0, 0.0), "REVIEW: no reliable correction (%s)" % reason, None, key


def polarity_check(fp, fit, theta):
    """For 2-pad polar parts: compare KiCad pin function (A/K/+/-) with the JLC symbol pin name on the pad it lands on."""
    names = lambda s: {"A": "A", "ANODE": "A", "+": "A", "K": "K", "CATHODE": "K", "C": "K", "-": "K"}.get((s or "").strip().upper())
    if not fit or not fit.get("cands"):
        return ""
    cand = next((x for x in fit["cands"] if x["theta"] == theta), None)
    if not cand:
        return ""
    bad = []
    for kn, jn in cand["nummap"].items():
        kf = next((p["fn"] for p in fp["pads"] if p["num"].upper() == kn), "")
        jf = (fit.get("pins") or {}).get(jn[0], "")
        a, b = names(kf), names(jf)
        if a and b and a != b:
            bad.append("%s(%s)->%s(%s)" % (kn, kf, jn[0], jf))
    return "POLARITY MISMATCH " + " ".join(bad) if bad else ""


# ------------------------------------------------------------------ overlay --------------------------------------------
def overlay(board, placed, path_svg):
    x0, y0, x1, y1 = board["bbox"]
    S = 1800 / (x1 - x0)
    P = lambda x, y: ((x - x0) * S + 10, (y - y0) * S + 10)
    side = max(x1 - x0, y1 - y0) * S + 40          # square canvas: Quick Look thumbnails crop to a square
    o = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" font-family="Helvetica" font-size="9">' % (side, side),
         '<rect width="100%" height="100%" fill="white"/>',
         '<rect x="10" y="10" width="%.1f" height="%.1f" fill="none" stroke="#bbb"/>' % ((x1 - x0) * S, (y1 - y0) * S)]
    for fp in board["footprints"]:
        for p in fp["pads"]:
            w, h = (p["w"], p["h"]) if (fp["rot"] + p["rot"]) % 180 == 0 else (p["h"], p["w"])
            a = P(p["x"] - w / 2, p["y"] - h / 2)
            o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="#cfcfcf" stroke="#999" stroke-width="0.5"/>' % (a + (w * S, h * S)))
    for row in placed:
        fp, ep = row["fp"], row["jlc_pads"]
        col = "#d22" if not row["flag"] else "#e08000"
        for p in ep:
            a = P(p["x"] - p["w"] / 2, p["y"] - p["h"] / 2)
            o.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" fill="none" stroke="%s" stroke-width="1"/>' % (a + (p["w"] * S, p["h"] * S, col)))
            if p["num"] in ("1", "A1"):
                c = P(p["x"], p["y"]); o.append('<circle cx="%.1f" cy="%.1f" r="2.5" fill="%s"/>' % (c + (col,)))
        k1 = next((p for p in fp["pads"] if p["num"] in ("1", "A1")), None)
        if k1:
            c = P(k1["x"], k1["y"]); o.append('<circle cx="%.1f" cy="%.1f" r="4" fill="none" stroke="#06c" stroke-width="1.2"/>' % c)
        c = P(fp["x"], fp["y"])
        o.append('<text x="%.1f" y="%.1f" fill="#060" text-anchor="middle">%s %d&#176;</text>' % (c[0], c[1] - 6, fp["ref"], row["rot"]))
    o.append('<text x="14" y="%d" font-size="13">grey: board pads | red: JLC library pads at the CPL rotation (orange = needs review) | '
             'red dot: JLC pin 1 | blue ring: KiCad pad 1</text>' % ((y1 - y0) * S + 30))
    o.append("</svg>")
    open(path_svg, "w").write("\n".join(o))
    png = None
    if shutil.which("qlmanage"):
        d = os.path.dirname(path_svg)
        subprocess.run(["qlmanage", "-t", "-s", "2400", "-o", d, path_svg], capture_output=True)
        cand = path_svg + ".png"
        if os.path.exists(cand):
            png = path_svg[:-4] + ".png"; os.replace(cand, png)
    return png


# ------------------------------------------------------------------ notes ----------------------------------------------
def stackup_text(pcb):
    t = open(pcb).read()
    m = re.search(r"\(stackup\n(.*?)\n\t\t\)", t, re.S)
    rows = []
    if m:
        for lm in re.finditer(r'\(layer "([^"]+)"\s*\(type "([^"]+)"\)(.*?)\n\t\t\t\)', m.group(1), re.S):
            th = re.search(r"\(thickness ([\d.]+)\)", lm.group(3))
            rows.append((lm.group(1), lm.group(2), float(th.group(1)) if th else None))
    fin = re.search(r'\(copper_finish "([^"]+)"\)', t)
    return rows, fin.group(1) if fin else "?"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir"); ap.add_argument("out_dir")
    ap.add_argument("--build", choices=("usb", "field"), default="usb")
    ap.add_argument("--qty", type=int, default=10)
    ap.add_argument("--refresh", action="store_true", help="re-query JLC/LCSC/EasyEDA instead of using the cache")
    ap.add_argument("--offline", action="store_true", help="cache only; no network")
    a = ap.parse_args()
    proj, out = os.path.abspath(a.project_dir), os.path.abspath(a.out_dir)
    os.makedirs(out, exist_ok=True)
    pcb = find_pcb(proj)
    name = os.path.splitext(os.path.basename(pcb))[0]
    board = B.load(pcb)
    extra_dnp = ("J6",) if a.build == "usb" else ()
    rows, per_ref = sourcing.resolve(proj, board, qty=a.qty, refresh=a.refresh, extra_dnp=extra_dnp)
    fits = fit_all(board, per_ref, refresh=a.refresh, fetch=not a.offline)
    corr = corrections()

    gdir, ddir = cam(pcb, out)

    # ---- CPL + rotation report ----
    placed, cpl, rot_rows, tht_fitted = [], [], [], []
    for fp in board["footprints"]:
        s = per_ref.get(fp["ref"], {})
        if not s.get("fitted"):
            continue
        if fp["tht"] or fp["side"] != "F":
            tht_fitted.append(fp["ref"]); continue
        fit = fits.get(fp["ref"])
        th, t, why, err, key = resolve_rotation(fp, s, fit, corr)
        dx, dy = B.rotate(t[0], t[1], fp["rot"]) if math.hypot(*t) > .02 else (0.0, 0.0)
        X, Y = fp["x"] + dx, fp["y"] + dy
        jrot = (fp["rot"] + th) % 360
        pol = polarity_check(fp, fit, th)
        flag = ("REVIEW" in why) or bool(pol)
        cpl.append([fp["ref"], "%.4f" % X, "%.4f" % (-Y), "Top", "%g" % round(jrot, 3)])
        rot_rows.append([fp["ref"], fp["fp"], s.get("lcsc") or "", "%g" % fp["rot"], th, "%g" % jrot,
                         "" if err is None else "%.3f" % err, "%.3f,%.3f" % tuple(t), why, pol])
        if fit and fit.get("epads"):
            jp = rotfit.jlc_pads_on_board(fp, fit["epads"], th, t)
            placed.append({"fp": fp, "jlc_pads": jp, "rot": jrot, "flag": flag})
    with open(os.path.join(out, "%s-CPL-JLC.csv" % name), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"]); w.writerows(cpl)
    with open(os.path.join(out, "rotation-report.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Designator", "KiCad footprint", "LCSC", "KiCad rot", "Correction", "JLC rot", "Max pad err mm (at correction)",
                    "JLC origin offset (KiCad local mm)", "Source", "Polarity check"])
        w.writerows(rot_rows)

    # ---- BOM ----
    bom = []
    for r in rows:
        refs = [x for x in r["refs"] if x not in tht_fitted]
        if not refs:
            continue
        comment = r["value"] if r["lcsc"] else "%s - CONSIGN %s" % (r["value"], r["fit_mpn"])
        bom.append([comment, ",".join(refs), r.get("jlc_package") or r["fp"], r["lcsc"]])
    with open(os.path.join(out, "%s-BOM-JLC.csv" % name), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["Comment", "Designator", "Footprint", "LCSC"]); w.writerows(bom)

    # ---- sourcing.csv (with footprint fit) ----
    for r in rows:
        f0 = fits.get(r["refs"][0]) if r["refs"] else None
        r["fp_fit"] = "%s: %s" % (f0["status"], f0["text"]) if f0 else ("no LCSC part" if not r["lcsc"] else "")
        ck = "%s|%s" % (r["fp"], r["lcsc"] or "-")
        if ck in corr:
            r["fp_fit"] += " | REVIEWED correction %d deg: %s" % (corr[ck]["theta"], corr[ck]["why"])
    sourcing.write_csv(rows, os.path.join(out, "sourcing.csv"))

    # ---- checks ----
    funcs = gerber_functions(gdir)
    copper = [v for v in funcs.values() if v.startswith("Copper")]
    census = {}
    for kind, cnt in B.drill_census(board).items():     # an oval 'WxL' slot is one Excellon tool of diameter W
        c = Counter()
        for lab, n in cnt.items():
            c["%.3f" % float(lab.split("x")[0]) if "x" in lab else lab] += n
        census[kind] = c
    exc = {}
    for p in glob.glob(os.path.join(ddir, "*.drl")):
        kind = "npth" if "NPTH" in os.path.basename(p) else "pth"
        exc[kind] = excellon_hits(p)[0]
    smt_fitted = sorted((fp["ref"] for fp in board["footprints"] if per_ref.get(fp["ref"], {}).get("fitted")
                         and not fp["tht"] and fp["side"] == "F"), key=B.refkey)
    review = [r[0] for r in rot_rows if r[8].startswith("REVIEW") or r[9]]
    checks = {
        "board": pcb, "board_sha256": sha(pcb), "build": a.build,
        "gerber_files": funcs, "gerber_layer_count": len(funcs), "copper_layers_in_gerbers": len(copper),
        "copper_layers_on_board": board["copper_layers"], "expected_layers": len(LAYERS),
        "drill_hits_excellon": {k: dict(v) for k, v in exc.items()},
        "drill_hits_board": {k: dict(v) for k, v in census.items()},
        "drill_hits_match": all(dict(exc.get(k, {})) == dict(census[k]) for k in ("pth", "npth")),
        "cpl_rows": len(cpl), "fitted_smt_parts": len(smt_fitted), "cpl_matches_fitted_smt": len(cpl) == len(smt_fitted),
        "bom_lines": len(bom), "bom_designators": sum(len(b[1].split(",")) for b in bom),
        "bom_lines_without_lcsc": [b[1] for b in bom if not b[3]],
        "fitted_tht_not_in_cpl": tht_fitted,
        "unfitted": sorted([k for k, v in per_ref.items() if not v.get("fitted")], key=B.refkey),
        "rotation_review": review,
    }
    checks["ok"] = (checks["gerber_layer_count"] == len(LAYERS) and checks["copper_layers_in_gerbers"] == board["copper_layers"]
                    and checks["drill_hits_match"] and checks["cpl_matches_fitted_smt"])
    json.dump(checks, open(os.path.join(out, "checks.json"), "w"), indent=2)
    png = overlay(board, placed, os.path.join(out, "orientation-overlay.svg"))

    # ---- FAB-NOTES ----
    st, finish = stackup_text(pcb)
    cu = [(n, th) for n, ty, th in st if ty == "copper"]
    total = sum(th for _, _, th in st if th)
    oz = lambda th: "%.1f oz (%.1f um)" % (th / .035, th * 1000)
    consign = [r for r in rows if not r["lcsc"]]
    subs = [r for r in rows if r["lcsc"] and r.get("alt_used")]
    vias = Counter("%.2f/%.2f" % (v["dia"], v["drill"]) for v in board["vias"])
    notes = ["# Fabrication and assembly notes - %s" % os.path.basename(proj), "",
             "Board: `%s` (SHA-256 `%s`). Build variant: **%s**. Generated by `fab-export/export_fab.py`; do not edit by hand." % (
                 os.path.basename(pcb), checks["board_sha256"], a.build.upper()), "",
             "## PCB", "",
             "| Item | Requirement |", "|---|---|",
             "| Layers | %d copper: F.Cu (signal) / In1.Cu (solid GND plane) / In2.Cu (signal + GND pour) / B.Cu |" % board["copper_layers"],
             "| Thickness | %.2f mm nominal (copper + dielectric %.3f mm, plus mask), FR-4 TG >= 135 |" % (board["thickness"], sum(th for _, ty, th in st if th and ty in ('copper', 'core', 'prepreg'))),
             "| Copper | outer %s finished; inner %s. Inner 1 oz is NOT required (5V_FIELD has a B.Cu twin; see the v0.5.2 README) |" % (
                 oz(cu[0][1]) if cu else "?", oz(cu[1][1]) if len(cu) > 1 else "?"),
             "| Stackup | " + " / ".join("%s %s" % (n, ("%.4g mm" % th) if th else "") for n, ty, th in st if ty in ("copper", "core", "prepreg")) +
             " (JLC JLC04161H-7628 or equivalent 1.6 mm 4-layer; impedance not controlled) |",
             "| Surface finish | %s (QFN/VQFN-HR/X2QFN lands; flat finish required) |" % finish,
             "| Min track / space | 0.15 mm / 0.15 mm |",
             "| Vias | %s (diameter/drill mm); all tented both sides; no via-in-pad, no fill/cap needed |" % ", ".join("%s x%d" % kv for kv in sorted(vias.items())),
             "| Min hole-to-hole | 0.25 mm; copper-to-edge 0.25 mm |",
             "| Solder mask | green (any), both sides; openings 1:1 with pads (mask expansion 0 in the Gerbers); do not add more than 0.05 mm |",
             "| Silkscreen | white, top only (bottom has none) |",
             "| Outline | non-rectangular (top tab x 47-60, notch x 3-11.5, right step at y 37, antenna cut-out): **CNC-routed edges only, no V-score**. "
             "C41/C42/C44 and the USB-C shell sit near the right/top edges - no V-cut, no mouse-bite tab within 3 mm of them |",
             "| Panel | single board or JLC panel with routed tabs + mouse bites placed on the long bottom edge (x 0-48) only |",
             "| Electrical test | yes (flying probe) |", "",
             "## Assembly", "",
             "- Single-sided SMT, top side only. CPL: `%s-CPL-JLC.csv` (%d parts), BOM: `%s-BOM-JLC.csv` (%d lines)." % (name, len(cpl), name, len(bom)),
             "- Coordinates are KiCad absolute (Mid Y negated, as in a KiCad position file) and match the Gerbers' origin.",
             "- Rotations already include the JLC-library corrections in `rotation-report.csv`; check the DFM preview against "
             "`orientation-overlay.png` and the polarity notes below before confirming.",
             "- Not fitted (%s build): %s." % (a.build.upper(), ", ".join(checks["unfitted"])),
             "- Test points (TP*), solder jumpers (JP1 copper bridge 1-2, JP2 open) and ANT1 (PCB coil) are not components.",
             "- J6 (Samtec FTSH-105, back-side THT): " + ("not fitted in the USB build." if a.build == "usb" else "fitted by hand after SMT (not in the CPL)."),
             "- Stencil 0.10-0.12 mm; apertures 1:1 (TI RUX0012A / NXP HVQFN40 recommend 100% coverage at 0.1 mm).", ""]
    if consign:
        notes += ["## Consigned / not orderable at JLC", ""] + ["- %s: %s %s - %s" % (" ".join(r["refs"]), r["fit_mfr"], r["fit_mpn"], r.get("check", "")) for r in consign] + [
            "", "Supply these to JLC (consignment / Global Sourcing) or mark them 'do not place' and hand-fit. The BOM lists them with an empty LCSC field.", ""]
    if subs:
        notes += ["## Substitutions (design MPN not orderable in quantity)", ""] + ["- %s: design %s -> fitted %s %s (%s). %s" % (
            " ".join(r["refs"]), r["design_mpn"], r["fit_mfr"], r["fit_mpn"], r["lcsc"], r.get("check", "")) for r in subs] + [""]
    notes += ["## Key part checks", "",
              "- U10 TPS2121RUXR: footprint and pin map verified against TI SLVSEA3F (RUX0012A drawing 4224010/A) - PASS, see `fab-export/U10-FOOTPRINT-CHECK.md`.",
              "- Y1 NDK NX2016SA-27.12M-EXS00A-CS06346 (C3008209): 27.12 MHz, CL 10 pF, ESR 60 ohm (LCSC) / <=100 ohm (NXP limit); C22/C23 13 pF give 6.5 pF + ~3 pF stray = ~10 pF. "
              "JLC stock is JLC-held (LCSC shows 0) - do not substitute a CL 6 pF 2016 crystal.",
              "- U12 TLV803SDBZR: SOT-23 pin 1 GND / 2 RESET / 3 VDD (TI SBVS157E), JLC library symbol agrees.", ""]
    notes += ["## Orientation / polarity watch list", ""]
    for r in rot_rows:
        if r[1].split("_")[0] in ("LED", "Buzzer", "SOD323", "SOD523") or r[0] in ("D4", "D5", "D6", "D7", "BZ1", "U1", "J1") or r[8].startswith(("REVIEW", "curated")) or r[9]:
            notes.append("- **%s** (%s, %s): KiCad %s deg -> JLC %s deg; %s %s" % (r[0], r[1], r[2], r[3], r[5], r[8], r[9]))
    notes += ["", "## Checks", "", "```", json.dumps({k: checks[k] for k in ("gerber_layer_count", "copper_layers_in_gerbers", "drill_hits_match",
                                                                         "cpl_rows", "fitted_smt_parts", "bom_lines", "rotation_review", "ok")}, indent=1), "```", ""]
    open(os.path.join(out, "FAB-NOTES.md"), "w").write("\n".join(notes))
    print(json.dumps({"ok": checks["ok"], "gerbers": checks["gerber_layer_count"], "drill_match": checks["drill_hits_match"], "cpl": len(cpl),
                      "fitted_smt": len(smt_fitted), "bom_lines": len(bom), "review": review, "overlay_png": bool(png)}))


if __name__ == "__main__":
    main()
