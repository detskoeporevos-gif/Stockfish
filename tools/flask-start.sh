#!/usr/bin/env bash
# GambitFish — запуск готового Flask-пакета (Linux Mint / любой Linux).
#
#   ./start.sh              # http://127.0.0.1:5000
#   ./start.sh 8000         # свой порт
#   PORT=8000 ./start.sh    # то же через переменную
#
# Скрипт сам находит python3/node, создаёт .venv, ставит Flask и запускает сервер.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PORT="${1:-${PORT:-${FLASK_PORT:-5000}}}"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- python3
PY=""
for cand in python3 python3.12 python3.11 python3.10 python3.9; do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
[ -n "$PY" ] || die "Не найден python3. Установите:  sudo apt install python3 python3-venv python3-pip"

# ---------------------------------------------------------------- node
# node нужен только для подсчёта поиска: ищем и в PATH, и в типовых местах
find_node() {
    for cand in node nodejs; do
        command -v "$cand" >/dev/null 2>&1 && { command -v "$cand"; return 0; }
    done
    for cand in "$HOME/.local/node/bin/node" "$HOME/.nvm/current/bin/node" \
                "/usr/local/bin/node" "/snap/bin/node"; do
        [ -x "$cand" ] && { echo "$cand"; return 0; }
    done
    if [ -d "$HOME/.nvm/versions/node" ]; then
        local newest
        newest="$(ls -1d "$HOME/.nvm/versions/node"/*/ 2>/dev/null | sort -V | tail -1)"
        [ -n "$newest" ] && [ -x "$newest/bin/node" ] && { echo "$newest/bin/node"; return 0; }
    fi
    return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "$NODE_BIN" ]; then
    say ""
    say "⚠ node не найден — движок в браузере работать не сможет."
    say ""
    say "  Вариант 1, без установки (рекомендую):"
    say "      откройте файл gambitfish.html двойным щелчком"
    say "      или запустите:  xdg-open \"$HERE/gambitfish.html\""
    say ""
    say "  Вариант 2, поставить Node без apt:"
    say "      curl -fsSLO https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz"
    say "      tar -xf node-v20.18.0-linux-x64.tar.xz"
    say "      mkdir -p ~/.local/node && cp -r node-v20.18.0-linux-x64/* ~/.local/node/"
    say "      export PATH=\"\$HOME/.local/node/bin:\$PATH\""
    say ""
    say "  Вариант 3, через apt (если apt здоров):"
    say "      sudo dpkg --configure -a && sudo apt --fix-broken install"
    say "      sudo apt install -y nodejs"
    say ""
    if [ -t 0 ]; then
        read -r -p "Открыть автономную версию сейчас? [y/N] " answer
        case "${answer:-n}" in
            [yYдД]*) xdg-open "$HERE/gambitfish.html" >/dev/null 2>&1 || say "Откройте вручную: $HERE/gambitfish.html" ;;
        esac
    fi
    die "остановлено: нет node"
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
say "→ node: $NODE_BIN ($("$NODE_BIN" --version))"

# ---------------------------------------------------------------- venv
if [ ! -x .venv/bin/python ]; then
    say "→ создаю окружение .venv"
    "$PY" -m venv .venv || die "Нет пакета python3-venv. Установите:  sudo apt install python3-venv"
fi

if ! .venv/bin/python -c "import flask" >/dev/null 2>&1; then
    say "→ ставлю Flask"
    .venv/bin/pip install --quiet --upgrade pip || true
    .venv/bin/pip install --quiet -r server/requirements.txt \
        || die "не удалось поставить Flask (проверьте интернет или поставьте python3-flask)"
fi

say "→ GambitFish: http://127.0.0.1:$PORT"
say "  автономная версия: http://127.0.0.1:$PORT/standalone"
say "  (остановить — Ctrl+C)"
FLASK_PORT="$PORT" exec .venv/bin/python server/app.py
