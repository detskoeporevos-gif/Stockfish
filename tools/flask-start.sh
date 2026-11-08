#!/usr/bin/env bash
# GambitFish — запуск готового Flask-пакета (Linux Mint / любой Linux).
#
#   ./start.sh              # http://127.0.0.1:5000
#   ./start.sh 8000         # свой порт
#   PORT=8000 ./start.sh    # то же через переменную
#
# Скрипт сам находит python3, создаёт .venv, ставит Flask и запускает сервер.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PORT="${1:-${PORT:-${FLASK_PORT:-5000}}}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "✗ Не найден python3. Установите:  sudo apt install python3 python3-venv python3-pip"
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "✗ Не найден node. Установите:  sudo apt install nodejs npm"
    exit 1
fi

if [ ! -x .venv/bin/python ]; then
    echo "→ создаю окружение .venv"
    python3 -m venv .venv || {
        echo "✗ Нет пакета python3-venv. Установите:  sudo apt install python3-venv"
        exit 1
    }
fi

if ! .venv/bin/python -c "import flask" >/dev/null 2>&1; then
    echo "→ ставлю Flask"
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet -r server/requirements.txt
fi

echo "→ GambitFish: http://127.0.0.1:$PORT"
echo "  (остановить — Ctrl+C)"
FLASK_PORT="$PORT" exec .venv/bin/python server/app.py
