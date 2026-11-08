#!/usr/bin/env bash
# Сборка готовых артефактов GambitFish:
#   dist/gambitfish.html          — автономный один файл (двойной щелчок)
#   dist/gambitfish-flask.tar.gz  — пакет для запуска Flask на Linux Mint
#   dist/УСТАНОВКА-Linux-Mint.md  — гайд
# Запуск: bash tools/build-dist.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DIST="$ROOT/dist"
STAGE="$DIST/gambitfish"
mkdir -p "$DIST"

echo "== 1. WASM =="
if [ ! -f web/public/gambitfish.wasm ]; then
    bash tools/build-wasm.sh
fi
ls -l web/public/gambitfish.wasm

echo "== 2. автономный файл =="
node tools/build-standalone.mjs

echo "== 3. пакет для Flask =="
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r server "$STAGE/server"
mkdir -p "$STAGE/web"
cp -r web/index.html "$STAGE/web/"
mkdir -p "$STAGE/web/public"
cp web/public/gambitfish.wasm "$STAGE/web/public/"
cp -r web/src "$STAGE/web/src"
cp -r web/assets "$STAGE/web/assets"
cp -r web/vendor "$STAGE/web/vendor"
mkdir -p "$STAGE/node"
cp node/*.mjs "$STAGE/node/" 2>/dev/null || true
cp tools/flask-start.sh "$STAGE/start.sh"
chmod +x "$STAGE/start.sh"
cp GAMBITFISH.md "$STAGE/README.md"
cp docs/УСТАНОВКА-Linux-Mint.md "$STAGE/УСТАНОВКА.md"
cp dist/gambitfish.html "$STAGE/gambitfish.html"
cp Copying.txt "$STAGE/COPYING.txt" 

# лишнее из server/
rm -rf "$STAGE/server/__pycache__"

tar -czf "$DIST/gambitfish-flask.tar.gz" -C "$DIST" gambitfish
SIZE=$(du -h "$DIST/gambitfish-flask.tar.gz" | cut -f1)
echo "   -> dist/gambitfish-flask.tar.gz ($SIZE)"

echo "== 4. итог =="
ls -lh "$DIST" | sed 's/^/   /'
