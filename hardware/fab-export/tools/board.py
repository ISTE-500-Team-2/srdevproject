"""Read-only view of a KiCad board through pcbnew. Nothing here saves the board."""
import math
from collections import Counter

FP_THT, FP_SMD, FP_NOPOS, FP_NOBOM, FP_BOARD_ONLY, FP_DNP = 1, 2, 4, 8, 16, 64


def _mm(v):
    import pcbnew
    return pcbnew.ToMM(v)


def unrotate(dx, dy, deg):
    """board delta (KiCad y-down) -> footprint-local (y-down) for a footprint at `deg`."""
    a = math.radians(deg)
    return (dx * math.cos(a) - dy * math.sin(a), dx * math.sin(a) + dy * math.cos(a))


def rotate(lx, ly, deg):
    """footprint-local (y-down) -> board delta (y-down) for a footprint at `deg` (CCW on screen)."""
    a = math.radians(deg)
    return (lx * math.cos(a) + ly * math.sin(a), -lx * math.sin(a) + ly * math.cos(a))


def load(pcb_path):
    import pcbnew
    b = pcbnew.LoadBoard(pcb_path)
    ds = b.GetDesignSettings()
    bb = b.GetBoardEdgesBoundingBox()
    out = {
        "path": pcb_path,
        "copper_layers": b.GetCopperLayerCount(),
        "thickness": _mm(ds.GetBoardThickness()),
        "bbox": (_mm(bb.GetX()), _mm(bb.GetY()), _mm(bb.GetX() + bb.GetWidth()),
                 _mm(bb.GetY() + bb.GetHeight())),
        "footprints": [], "vias": [], "track_widths": Counter(),
    }
    for f in b.GetFootprints():
        p = f.GetPosition()
        attr = f.GetAttributes()
        rot = f.GetOrientationDegrees()
        flipped = f.IsFlipped()
        fields = {}
        try:
            for fld in f.GetFields():
                fields[fld.GetName()] = fld.GetText()
        except Exception:
            pass
        fp = {
            "ref": f.GetReference(), "value": f.GetValue(),
            "fp": str(f.GetFPID().GetUniStringLibItemName()),
            "x": _mm(p.x), "y": _mm(p.y), "rot": rot % 360, "side": "B" if flipped else "F",
            "smd": bool(attr & FP_SMD), "tht": bool(attr & FP_THT),
            "dnp": bool(attr & FP_DNP) or f.IsDNP(),
            "no_bom": bool(attr & FP_NOBOM), "no_pos": bool(attr & FP_NOPOS),
            "board_only": bool(attr & FP_BOARD_ONLY), "fields": fields, "pads": [],
        }
        for pad in f.Pads():
            q = pad.GetPosition()
            dx, dy = _mm(q.x - p.x), _mm(q.y - p.y)
            lx, ly = unrotate(dx, dy, rot)
            if flipped:
                lx = -lx
            at = pad.GetAttribute()
            kind = {pcbnew.PAD_ATTRIB_PTH: "pth", pcbnew.PAD_ATTRIB_SMD: "smd",
                    pcbnew.PAD_ATTRIB_NPTH: "npth"}.get(at, "conn")
            layer = pcbnew.B_Cu if flipped else pcbnew.F_Cu
            try:
                sz = pad.GetSize(layer)
            except TypeError:
                sz = pad.GetSize()
            dr = pad.GetDrillSize()
            fp["pads"].append({
                "num": pad.GetNumber(), "x": _mm(q.x), "y": _mm(q.y), "lx": lx, "ly": ly,
                "w": _mm(sz.x), "h": _mm(sz.y),
                "rot": (pad.GetOrientationDegrees() - rot) % 360, "kind": kind,
                "drill": (_mm(dr.x), _mm(dr.y)), "net": pad.GetNetname(),
                "fn": pad.GetPinFunction(),
            })
        out["footprints"].append(fp)
    for t in b.GetTracks():
        cls = t.GetClass()
        if cls == "PCB_VIA":
            try:
                dia = _mm(t.GetWidth(pcbnew.F_Cu))
            except TypeError:
                dia = _mm(t.GetWidth())
            out["vias"].append({"x": _mm(t.GetPosition().x), "y": _mm(t.GetPosition().y),
                                "drill": _mm(t.GetDrillValue()), "dia": dia,
                                "type": int(t.GetViaType())})
        else:
            out["track_widths"][round(_mm(t.GetWidth()), 4)] += 1
    out["footprints"].sort(key=lambda f: _refkey(f["ref"]))
    return out


def _refkey(ref):
    import re
    m = re.match(r"([A-Za-z_]+)(\d+)", ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


def refkey(ref):
    return _refkey(ref)


def drill_census(board):
    """Expected drill hits from the board database: {'pth': Counter, 'npth': Counter}
    keyed by a hole label ('0.200' round, '0.60x1.70' slot)."""
    pth, npth = Counter(), Counter()
    for v in board["vias"]:
        pth["%.3f" % v["drill"]] += 1
    for f in board["footprints"]:
        for p in f["pads"]:
            dx, dy = p["drill"]
            if dx <= 0 or p["kind"] not in ("pth", "npth"):
                continue
            lab = "%.3f" % dx if abs(dx - dy) < 1e-6 else "%.2fx%.2f" % (min(dx, dy), max(dx, dy))
            (pth if p["kind"] == "pth" else npth)[lab] += 1
    return {"pth": pth, "npth": npth}
