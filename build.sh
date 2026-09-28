#!/usr/bin/env bash
# Packs the extension into a loadable .xpi (a plain zip with manifest.json at its root).
# Output: dist/subdrop-<version>.xpi
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("manifest.json")).version)' 2>/dev/null \
          || python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
OUT="dist/subdrop-${VERSION}.xpi"

FILES="manifest.json parser.js content.js popup.html popup.js picker.html picker.js background.js"
for f in $FILES; do [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }; done

mkdir -p dist
rm -f "$OUT"

if command -v zip >/dev/null 2>&1; then
  zip -q "$OUT" $FILES
else
  python3 - "$OUT" $FILES <<'PY'
import sys, zipfile, os
out, files = sys.argv[1], sys.argv[2:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f, os.path.basename(f))
PY
fi

echo "built $OUT ($(wc -c < "$OUT") bytes)"
