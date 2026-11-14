"""Parse footprint pads and symbol pin names out of an EasyEDA (JLCEDA) std component
record. Source of the data: JLCEDA/EasyEDA Official Library (https://lceda.cn/,
https://easyeda.com). Used here only to compare pad layouts / zero-orientation with the
KiCad footprints on the board; nothing from the library is copied into the design."""
import math

U = 0.254  # EasyEDA std unit (10 mil) in mm


def pads(comp):
    """-> list of dicts {num, x, y, w, h, rot, hole} in mm, y DOWN (KiCad sense),
    relative to the EasyEDA footprint origin (the point JLC places)."""
    ds = comp["packageDetail"]["dataStr"]
    ox, oy = float(ds["head"]["x"]), float(ds["head"]["y"])
    out = []
    for s in ds["shape"]:
        f = s.split("~")
        if f[0] != "PAD":
            continue
        rot = float(f[11] or 0)
        w, h = float(f[4]) * U, float(f[5]) * U
        if abs(rot % 180 - 90) < 1:
            w, h = h, w
        out.append({"num": f[8], "x": (float(f[2]) - ox) * U, "y": (float(f[3]) - oy) * U,
                    "w": w, "h": h, "shape": f[1], "hole": float(f[9] or 0) * 2 * U,
                    "layer": f[6]})
    return out


def package_name(comp):
    return comp["packageDetail"]["title"]


def pin_names(comp):
    """symbol pin number -> pin name"""
    out = {}
    for s in comp["dataStr"]["shape"]:
        if not s.startswith("P~"):
            continue
        seg = s.split("^^")
        try:
            num = seg[0].split("~")[3]
            name = seg[3].split("~")[4]
            out[num] = name
        except IndexError:
            pass
    return out


def jlc_class(comp):
    return (comp["dataStr"]["head"].get("c_para") or {}).get("JLCPCB Part Class", "")
