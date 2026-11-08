# GambitFish

Гамбитный движок на **WASM** с «живым» комментатором: играет жертвы,
объясняет идеи текстом и разбирает целые партии («авантюрные» — в первую очередь).

Это отдельный, самостоятельный движок (ядро написано с нуля на C), вдохновлённый
Stockfish и лицензированный так же — GPL-3.0. Он **не** использует NNUE-сеть
Stockfish: оценка классическая (материал + PST + мобильность + структура +
безопасность короля) с явными гамбитными членами.

## Что умеет

| Возможность | Где |
|---|---|
| Движок в браузере (120 КБ WASM, ~1.2 M узлов/с) | `engine/` → `web/public/gambitfish.wasm` |
| 44 гамбита и 167 вариантов, книга на 345 позиций | `web/src/data/gambits.js` → `engine/gambit_book.inc` |
| Живой комментатор: точные идеи + банки фраз | `web/src/commentary/` |
| Разбор PGN: точность, ACPL, метки `!! ! ?! ? ??`, индекс авантюрности | `web/src/analysis/gameAnalyzer.js` |
| Flask-сервер с API | `server/app.py` + `node/bridge.mjs` |
| Доска: `cm-chessboard` (MIT) + SVG-фигуры Cburnett | `web/vendor/`, `web/assets/` |
| Готовые артефакты: один автономный HTML и пакет Flask | `tools/build-dist.sh` → `dist/` |
| Полный набор тестов | `tools/check-all.sh` |

## Быстрый старт

```bash
./tools/run-flask.sh          # http://0.0.0.0:5000
# или без Flask:
node web/server.cjs           # http://0.0.0.0:5173
```

## Готовые сборки

```bash
bash tools/build-dist.sh
```

получается:

| файл | что это |
|---|---|
| `dist/gambitfish.html` | **автономный один файл** (~510 КБ): движок в base64, фигуры и стили внутри. Открывается двойным щелчком, работает офлайн |
| `dist/gambitfish-flask.tar.gz` | пакет для запуска Flask-версии: `start.sh`, `server/`, `web/`, `node/` |
| `docs/УСТАНОВКА-Linux-Mint.md` | пошаговый гайд для Linux Mint (зависимости, порт, автозапуск, разбор проблем) |

### Скачать готовое (без сборки)

Архивы лежат прямо в репозитории, в папке [`release/`](release/):

| Файл | Ссылка |
|---|---|
| Пакет Flask (zip) | <https://raw.githubusercontent.com/detskoeporevos-gif/Stockfish/arena/7cbe02f0-stockfish/release/gambitfish-flask.zip> |
| Пакет Flask (tar.gz) | <https://raw.githubusercontent.com/detskoeporevos-gif/Stockfish/arena/7cbe02f0-stockfish/release/gambitfish-flask.tar.gz> |
| Автономный HTML | <https://raw.githubusercontent.com/detskoeporevos-gif/Stockfish/arena/7cbe02f0-stockfish/release/gambitfish-standalone.html> |
| Гайд для Linux Mint | <https://raw.githubusercontent.com/detskoeporevos-gif/Stockfish/arena/7cbe02f0-stockfish/release/УСТАНОВКА-Linux-Mint.md> |

Из терминала:

```bash
curl -LO https://raw.githubusercontent.com/detskoeporevos-gif/Stockfish/arena/7cbe02f0-stockfish/release/gambitfish-flask.zip
unzip gambitfish-flask.zip && cd gambitfish && ./start.sh
```

Проверка автономного файла:

```bash
node tools/test-standalone.mjs
```

Сборка WASM (нужен `zig` или `clang` с `wasm-ld`):

```bash
./tools/build-wasm.sh
```

Проверка всего:

```bash
./tools/check-all.sh
```

## Как запускать через Flask

`server/app.py` — тонкий слой: статика + JSON API, тяжёлая работа уходит в
WASM через `node/bridge.mjs` (один процесс на запрос, обмен JSON по stdin/stdout).

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r server/requirements.txt
FLASK_PORT=5000 python server/app.py
```

### API

| Метод | Назначение |
|---|---|
| `GET /health` | состояние (WASM собран? node есть?) |
| `GET /api/gambits` | база гамбитов |
| `GET /api/gambit/<id>` | гамбит + расшифровка |
| `POST /api/search` | `{fen, movetime, depth}` → оценка и PV |
| `POST /api/comment` | `{fen, uci}` → комментарий к ходу |
| `POST /api/analyze` | `{pgn, movetime}` → полный разбор партии |

Пример:

```bash
curl -s -X POST localhost:5000/api/analyze -H 'Content-Type: application/json' \
  -d '{"pgn":"1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Bc4 g4 5. O-O gxf3 6. Qxf3","movetime":300}' |
  python3 -m json.tool | head -40
```

Ответ содержит: ходы с метками (`brilliant`, `blunder`, …), потерю оценки,
признак жертвы, `initiative` (0–10), `adventure` по каждому ходу, сводку
(точность, ACPL, число жертв, индекс авантюрности) и готовые тексты
комментариев.

## Как это устроено

### Ядро (`engine/`)

* `board.c` — битборды, магические таблицы, FEN, make/unmake, SEE, Zobrist.
* `movegen.c` — генерация ходов (легальность через псевдо-легальный проход).
* `eval.c` — оценка. Гамбитные члены:
  * **возврат материала за инициативу** — при дефиците материала часть
    отставания компенсируется активностью, но не больше 85 %;
  * **опасность короля** — квадратичный рост от числа атакующих фигур;
  * штраф за короля в центре, бонус за проходные и открытые линии.
* `search.c` — PVS, TT (1M записей), null-move, LMR, killer/history,
  quiescence с SEE-отсечением, mate distance pruning.
* `gambit.c` — дебютная книга, сгенерированная из `gambits.js`.
* `api.c` — C ABI для WASM.
* `shim.c`, `freestanding/` — минимальный libc для `wasm32-freestanding`.

Скорость: ~1.2 M узлов/с в браузере (глубина 11–12 при 1.5 с на ход),
сила — уровень сильного клубного игрока/мастера (~2400–2500 в быстром контроле).

### Комментатор (`web/src/commentary/`)

1. `features.js` вычисляет **факты** о ходе: жертву (SEE), предлагаемый
   материал, число атакующих фигур в зоне короля, проходные, висящие фигуры,
   уязвимость короля, инициативу (0–10).
2. `commentator.js` собирает фразу из банков `phrases.js`, подставляя факты:
   всегда про конкретику («под боем конь на f3», «атакуют короля: 1 → 3»),
   никогда не про «красивый ход» без причины.
3. Выбор фраз зависит от позиции и хода (детерминированный ГПСЧ), поэтому
   комментарии не повторяются, но и не «дрожат» при повторном разборе.

### Разбор партий

`analyzeGame()` считает оценку до/после каждого хода, переводит её в потерю
и ставит метку. Индекс авантюрности = оплаченный инициативой материальный
минус, усреднённый по партии с весом пика.

## Гамбиты

Королевский гамбит и его ветки (Муцио, Альгайер, Кизерицкий, слон, Фалькбеер),
Эванс, Датский, Гёринг, Смит–Морра, Бенко, Будапешт, Латышский, Тракслер,
Уилкс-Барре, «жареная печень», Блэкмар–Димер, Фром, Маршалл, Шлиман, Урусов,
Кокрейн, Теннисон, Милнер-Барри, Энглунд, Хэллоуин и др. — всего 44.

Каждый гамбит содержит: главную линию, варианты, жертвуемый материал, идеи
компенсации, планы, задачи защиты, ловушки и ключевые поля.

## Лицензия

GPL-3.0, как и Stockfish, от которого проект наследует дух и лицензию.
