#!/usr/bin/env bash
# Run from any directory; needs Pandoc and Chrome/Chromium. No cloud access.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
command -v pandoc >/dev/null || { echo 'Install Pandoc first.' >&2; exit 1; }
chrome=${CHROME_BIN:-'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}
[[ -x "$chrome" ]] || { echo 'Set CHROME_BIN to your Chrome/Chromium executable.' >&2; exit 1; }
pandoc docs/SPONSOR-HANDOFF.md --resource-path=docs --lua-filter=docs/print/links.lua --standalone --syntax-highlighting=none --embed-resources --css docs/print/sponsor.css --metadata title='ARBOR · Sponsor setup & operations' -o docs/print/ARBOR-Sponsor-Guide.html
"$chrome" --headless --no-pdf-header-footer --print-to-pdf="$root/docs/print/ARBOR-Sponsor-Guide.pdf" "file://$root/docs/print/ARBOR-Sponsor-Guide.html"
