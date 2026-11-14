"""Locate KiCad's bundled Python / kicad-cli and re-exec the calling script under it
when `pcbnew` is not importable (so the scripts can be started with any python3)."""
import os, sys

KICAD_PY_CANDIDATES = [
    os.environ.get("KICAD_PYTHON", ""),
    "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3",
    "/usr/lib/kicad/bin/python3",
]
KICAD_CLI_CANDIDATES = [
    os.environ.get("KICAD_CLI", ""),
    "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
    "/usr/bin/kicad-cli", "/usr/local/bin/kicad-cli",
]


def kicad_cli():
    for c in KICAD_CLI_CANDIDATES:
        if c and os.path.exists(c):
            return c
    raise SystemExit("kicad-cli not found; set KICAD_CLI")


def ensure_pcbnew():
    """Import pcbnew, re-executing under KiCad's Python if needed."""
    try:
        import pcbnew  # noqa
        return pcbnew
    except ImportError:
        if os.environ.get("_FAB_REEXEC"):
            raise
        for c in KICAD_PY_CANDIDATES:
            if c and os.path.exists(c):
                env = dict(os.environ, _FAB_REEXEC="1")
                os.execve(c, [c] + sys.argv, env)
        raise SystemExit("KiCad Python not found; set KICAD_PYTHON")
