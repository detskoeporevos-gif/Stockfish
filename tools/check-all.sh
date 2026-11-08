#!/usr/bin/env bash
# Полная проверка GambitFish: perft, книга, тактика, воркер, UI, self-play.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== книга гамбитов =="
node tools/verify-gambits.mjs

echo "== сборка WASM =="
./tools/build-wasm.sh >/dev/null
ls -la web/public/gambitfish.wasm

echo "== perft (нативная сборка) =="
cc -O2 -std=c11 -Iengine -o /tmp/gf-perft engine/tests/perft_test.c engine/board.c engine/movegen.c
/tmp/gf-perft | tail -2

echo "== тактика =="
node tools/tactics.mjs

echo "== воркер =="
node tools/test-worker.mjs

echo "== интерфейс =="
node tools/test-ui.mjs

echo "== self-play =="
node tools/selfplay.mjs 2 100

echo "ВСЁ ЗЕЛЁНОЕ ✔"
