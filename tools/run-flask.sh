#!/usr/bin/env bash
# Запуск Flask-версии GambitFish.
#   ./tools/run-flask.sh            # порт 5000
#   FLASK_PORT=8000 ./tools/run-flask.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f web/public/gambitfish.wasm ]; then
  echo "→ собираю WASM (нужен zig или clang с wasm-ld)"
  ./tools/build-wasm.sh
fi

PY="${PYTHON:-python3}"
if ! $PY -c "import flask" >/dev/null 2>&1; then
  echo "→ ставлю flask"
  $PY -m pip install --quiet -r server/requirements.txt
fi

exec $PY server/app.py
