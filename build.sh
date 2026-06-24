#!/usr/bin/env bash
# Build clean per-browser MediaSniff packages into dist/.
#   dist/chrome/  + mediasniff-chrome-<ver>.zip   (Chromium: service_worker manifest)
#   dist/firefox/ + mediasniff-firefox-<ver>.zip  (Firefox:  background.scripts manifest)
#
# The two browsers require opposite MV3 background formats — Chromium forbids
# "background.scripts", Firefox's validator requires it — so each gets its own
# manifest. Everything else is shared.
set -euo pipefail
cd "$(dirname "$0")"

VER="$(node -p "require('./manifest.json').version" 2>/dev/null || echo dev)"

# Files shared by both builds (manifests are added per-target below).
SRC=(background.js popup.html popup.css popup.js lib icons README.md LICENSE)

rm -rf dist
mkdir -p dist/chrome dist/firefox

for target in chrome firefox; do
  for f in "${SRC[@]}"; do cp -r "$f" "dist/$target/"; done
done
cp manifest.json         dist/chrome/manifest.json
cp manifest.firefox.json dist/firefox/manifest.json

zipdir() {  # <srcdir> <relative-out.zip>
  local d="$1" out
  out="$(pwd)/$2"
  rm -f "$out"
  if command -v zip >/dev/null 2>&1; then
    ( cd "$d" && zip -qr -X "$out" . )
  else
    python3 - "$d" "$out" <<'PY'
import shutil, sys
src, out = sys.argv[1], sys.argv[2]
shutil.make_archive(out[:-4] if out.endswith(".zip") else out, "zip", src)
PY
  fi
}

zipdir dist/chrome  "dist/mediasniff-chrome-$VER.zip"
zipdir dist/firefox "dist/mediasniff-firefox-$VER.zip"

echo "Built MediaSniff v$VER:"
ls -1 dist/*.zip
echo "Unpacked dirs: dist/chrome/  dist/firefox/"
