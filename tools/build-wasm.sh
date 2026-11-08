#!/usr/bin/env bash
# Сборка GambitFish в WASM (freestanding, без Emscripten).
# Требуется zig (или clang с wasm-ld). Путь к zig можно задать в ZIG=...
set -euo pipefail
cd "$(dirname "$0")/.."
# ищем zig: сначала $ZIG, потом PATH, потом типичные места venv
ZIG="${ZIG:-}"
if [ -z "$ZIG" ]; then
  if command -v zig >/dev/null 2>&1; then ZIG="zig"
  elif [ -x /tmp/zigvenv/lib/python3.11/site-packages/ziglang/zig ]; then ZIG=/tmp/zigvenv/lib/python3.11/site-packages/ziglang/zig
  else echo "не найден zig (pip install ziglang, либо ZIG=/путь/к/zig)"; exit 1; fi
fi
export SDKROOT=
EXPORTS="gf_init gf_set_fen gf_get_fen gf_legal_moves gf_play_best gf_search gf_last_score gf_last_depth gf_last_nodes gf_last_time gf_last_from_book gf_last_seldepth gf_evaluate gf_material gf_see gf_is_capture gf_board_string gf_perft gf_play_uci gf_play_line gf_make_move gf_set_gambit_weights gf_set_book gf_in_check gf_legal_count gf_last_best gf_piece_at gf_side"
FLAGS=""
for f in $EXPORTS; do FLAGS="$FLAGS -Wl,--export=$f"; done
mkdir -p web/public
$ZIG cc -target wasm32-freestanding -O3 -std=c11 -DNDEBUG -DGAMBITFISH_HAS_BOOK \
  -Iengine/freestanding -Iengine -nostdlib \
  -Wl,--no-entry -Wl,--export-memory -Wl,--initial-memory=134217728 -Wl,--max-memory=268435456 \
  $FLAGS \
  -o web/public/gambitfish.wasm \
  engine/board.c engine/movegen.c engine/eval.c engine/search.c engine/gambit.c engine/api.c engine/shim.c
ls -la web/public/gambitfish.wasm
