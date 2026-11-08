"""
GambitFish — Flask-сервер.

Что делает:
  * раздаёт собранный интерфейс (web/) и WASM-движок;
  * даёт API для разбора «авантюрных» партий (PGN), поиска ходов,
    комментариев и базы гамбитов;
  * вся тяжёлая работа идёт в WASM через node/bridge.mjs (тот же движок,
    что и в браузере), поэтому Python-процесс остаётся тонким.

Запуск:
    ./tools/run-flask.sh            # http://0.0.0.0:5000
    FLASK_PORT=8000 python server/app.py

GPL-3.0.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
PUBLIC_DIR = WEB_DIR / "public"
BRIDGE = ROOT / "node" / "bridge.mjs"

app = Flask(__name__, static_folder=None)
app.config["JSON_AS_ASCII"] = False
try:                                   # Flask >= 2.3
    app.json.ensure_ascii = False
except Exception:                      # noqa: BLE001
    pass


# --------------------------------------------------------------------------
#  мостик к WASM
# --------------------------------------------------------------------------

def node_binary() -> str:
    """Ищем node не только в PATH: часто он стоит локально (nvm, ~/.local/node)."""
    exe = shutil.which("node") or shutil.which("nodejs")
    if exe:
        return exe
    home = Path.home()
    candidates = [
        home / ".local" / "node" / "bin" / "node",
        home / ".nvm" / "current" / "bin" / "node",
        Path("/usr/local/bin/node"),
        Path("/snap/bin/node"),
    ]
    # nvm ставит версии в ~/.nvm/versions/node/vX.Y.Z/bin/node
    nvm_root = home / ".nvm" / "versions" / "node"
    if nvm_root.is_dir():
        candidates += sorted(nvm_root.glob("*/bin/node"), reverse=True)
    for path in candidates:
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise RuntimeError(
        "не найден node — он нужен для WASM-движка. "
        "Установите: sudo apt install nodejs, либо распакуйте Node в ~/.local/node. "
        "Без Node работает автономный файл gambitfish-standalone.html."
    )


def call_engine(payload: dict[str, Any], timeout: float = 300.0,
                no_book: bool = False) -> dict[str, Any]:
    """Один вызов node/bridge.mjs. Обмен — JSON через stdin/stdout."""
    if not BRIDGE.exists():
        raise RuntimeError(f"нет файла мостика: {BRIDGE}")
    wasm = PUBLIC_DIR / "gambitfish.wasm"
    if not wasm.exists():
        raise RuntimeError(
            "не собран WASM: запустите tools/build-wasm.sh (нужен zig или clang+wasm-ld)"
        )
    proc = subprocess.run(
        [node_binary(), str(BRIDGE)] + (["--no-book"] if no_book else []),
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=str(ROOT),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"движок упал: {proc.stderr.strip()[:400]}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:  # pragma: no cover
        raise RuntimeError(f"движок вернул не JSON: {proc.stdout[:300]}") from exc
    if not data.get("ok"):
        raise RuntimeError(data.get("error", "неизвестная ошибка движка"))
    return data


# --------------------------------------------------------------------------
#  статика
# --------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/gambitfish.wasm")
def wasm():
    return send_from_directory(PUBLIC_DIR, "gambitfish.wasm", mimetype="application/wasm")


@app.route("/standalone")
def standalone():
    """Автономная версия одним файлом — открывается без Node и WASM-сервера."""
    for name in ("gambitfish.html", "web/standalone.html", "gambitfish-standalone.html"):
        candidate = ROOT / name
        if candidate.exists():
            return send_from_directory(candidate.parent, candidate.name, mimetype="text/html")
    return (
        jsonify({"ok": False, "error": "нет автономной сборки: соберите bash tools/build-dist.sh"}),
        404,
    )


@app.route("/src/<path:sub>")
def sources(sub: str):
    return send_from_directory(WEB_DIR / "src", sub)


@app.route("/assets/<path:sub>")
def assets(sub: str):
    """SVG-фигуры, спрайты маркеров и стрелок для доски."""
    resp = send_from_directory(WEB_DIR / "assets", sub)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.route("/vendor/<path:sub>")
def vendor(sub: str):
    """cm-chessboard (MIT) — вендоренная библиотека доски."""
    resp = send_from_directory(WEB_DIR / "vendor", sub)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.route("/health")
def health():
    try:
        node_path: str | None = node_binary()
    except RuntimeError:
        node_path = None
    return jsonify({
        "ok": True,
        "wasm": (PUBLIC_DIR / "gambitfish.wasm").exists(),
        "node": bool(node_path),
        "nodePath": node_path,
        "standalone": (ROOT / "gambitfish.html").exists(),
        "version": "1.0",
    })


# --------------------------------------------------------------------------
#  API
# --------------------------------------------------------------------------

@app.post("/api/analyze")
def api_analyze():
    body = request.get_json(silent=True) or {}
    pgn = body.get("pgn", "")
    if not pgn.strip():
        return jsonify({"ok": False, "error": "пустой PGN"}), 400
    try:
        data = call_engine({
            "cmd": "analyze_pgn",
            "pgn": pgn,
            "movetime": int(body.get("movetime", 300)),
            "gambitMode": int(body.get("gambitMode", 1)),
            "useBook": bool(body.get("useBook", False)),
        }, no_book=not bool(body.get("useBook", False)))
        return jsonify(data)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.post("/api/search")
def api_search():
    body = request.get_json(silent=True) or {}
    fen = body.get("fen", "")
    if not fen:
        return jsonify({"ok": False, "error": "нужен FEN"}), 400
    try:
        return jsonify(call_engine({
            "cmd": "search",
            "fen": fen,
            "movetime": int(body.get("movetime", 800)),
            "depth": int(body.get("depth", 64)),
            "gambitMode": int(body.get("gambitMode", 1)),
        }))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.post("/api/comment")
def api_comment():
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(call_engine({
            "cmd": "comment_position",
            "fen": body.get("fen", ""),
            "uci": body.get("uci", ""),
        }))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/gambits")
def api_gambits():
    try:
        data = call_engine({"cmd": "gambits"}, timeout=60)
        return jsonify(data)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/gambit/<gid>")
def api_gambit(gid: str):
    try:
        return jsonify(call_engine({"cmd": "gambit_info", "id": gid}, timeout=60))
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 500


def main() -> None:
    port = int(os.environ.get("FLASK_PORT", "5000"))
    host = os.environ.get("FLASK_HOST", "0.0.0.0")
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    print(f"GambitFish (Flask) → http://{host}:{port}/", file=sys.stderr)
    app.run(host=host, port=port, debug=debug)


if __name__ == "__main__":
    main()
