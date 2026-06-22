#!/usr/bin/env bash
# Build a Chromium-compatible package (MV3, side_panel + service worker) from the
# shared source. The only browser-specific bits are the manifest and the
# background entry point; everything else (sidebar, options, content, lib) is
# identical and runs on both Firefox and Chromium thanks to browser-polyfill.
#
# Output: ai-sidebar-chrome-<version>.zip  → load in chrome://extensions
# (Developer mode → "Load unpacked" on the unzipped folder, or drag the zip).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VER="$(python3 -c "import json;print(json.load(open('manifest.chrome.json'))['version'])")"
OUT=".build-chrome"
ZIP="ai-sidebar-chrome-${VER}.zip"

rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"
cp -r LICENSE README.md icons src vendor "$OUT/"
cp manifest.chrome.json "$OUT/manifest.json"

# Zip with Python (no dependency on the `zip` binary).
python3 - "$OUT" "$ZIP" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in files:
            if f == ".DS_Store":
                continue
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, src))
PY
echo "Built $ZIP ($(stat -c%s "$ZIP") bytes)"
