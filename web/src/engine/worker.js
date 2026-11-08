/*
  GambitFish — Web Worker, который держит WASM-ядро.
  Общение: postMessage({id, cmd, ...}) -> postMessage({id, ok, result}).
  GPL-3.0.
*/

let wasm = null;
let ready = false;
const SCRATCH = 1 << 16; // 64 KiB — область для строк

function mem() { return new Uint8Array(wasm.memory.buffer); }

function writeString(str) {
    const bytes = new TextEncoder().encode(str + '\0');
    const view = mem();
    view.set(bytes, SCRATCH);
    return SCRATCH;
}

function readString(ptr) {
    const view = mem();
    let end = ptr;
    while (view[end]) end++;
    return new TextDecoder().decode(view.slice(ptr, end));
}

async function init(url) {
    const resp = await fetch(url);
    const buffer = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(buffer, {
        env: {
            now_ms: () => BigInt(Date.now()),
        },
    });
    wasm = instance.exports;
    wasm.gf_init();
    ready = true;
}

const handlers = {
    init: async ({ url }) => { await init(url); return true; },

    /* Установить позицию. */
    setFen: ({ fen }) => { wasm.gf_set_fen(writeString(fen)); return readString(wasm.gf_get_fen()); },

    getFen: () => readString(wasm.gf_get_fen()),

    legalMoves: () => readString(wasm.gf_legal_moves()),

    /* Анализ: возвращает оценку и главную линию, НЕ играя ход. */
    analyze: ({ movetime = 1000, depth = 64, gambitMode = 1, contempt = 0, weights = null }) => {
        if (weights) wasm.gf_set_gambit_weights(weights[0], weights[1]);
        const t0 = Date.now();
        /* gf_play_best играет ход — поэтому сохраняем FEN и восстанавливаем */
        const fen = readString(wasm.gf_get_fen());
        const pv = readString(wasm.gf_search(movetime, depth, gambitMode, contempt));
        const result = {
            pv,
            book: wasm.gf_last_from_book(),
            score: wasm.gf_last_score(),
            depth: wasm.gf_last_depth(),
            seldepth: wasm.gf_last_seldepth(),
            nodes: wasm.gf_last_nodes(),
            time: wasm.gf_last_time() || (Date.now() - t0),
        };
        wasm.gf_set_fen(writeString(fen));
        return result;
    },

    /* Поиск, который реально оставляет позицию неизменной (удобно для UI). */
    search: ({ movetime = 1000, depth = 64, gambitMode = 1, contempt = 0 }) => {
        const fen = readString(wasm.gf_get_fen());
        const pv = readString(wasm.gf_search(movetime, depth, gambitMode, contempt));
        const result = {
            pv,
            book: wasm.gf_last_from_book(),
            score: wasm.gf_last_score(),
            depth: wasm.gf_last_depth(),
            seldepth: wasm.gf_last_seldepth(),
            nodes: wasm.gf_last_nodes(),
            time: wasm.gf_last_time(),
        };
        wasm.gf_set_fen(writeString(fen));
        return result;
    },

    makeMove: ({ uci }) => wasm.gf_make_move(writeString(uci)),

    playBest: ({ movetime = 1000, depth = 64, gambitMode = 1, contempt = 0 }) => {
        const uci = readString(wasm.gf_play_best(movetime, depth, gambitMode, contempt));
        return {
            uci,
            book: wasm.gf_last_from_book(),
            score: wasm.gf_last_score(),
            depth: wasm.gf_last_depth(),
            nodes: wasm.gf_last_nodes(),
            time: wasm.gf_last_time(),
            fen: readString(wasm.gf_get_fen()),
        };
    },

    evaluate: ({ gambitMode = 1 }) => wasm.gf_evaluate(gambitMode),
    material: () => wasm.gf_material(),
    see: ({ uci }) => wasm.gf_see(writeString(uci)),
    setWeights: ({ gambit, sacrifice }) => { wasm.gf_set_gambit_weights(gambit, sacrifice); return true; },
    setBook: ({ on }) => { wasm.gf_set_book(on ? 1 : 0); return true; },
    perft: ({ depth }) => wasm.gf_perft(depth),
};

self.onmessage = async (ev) => {
    const { id, cmd, args } = ev.data;
    try {
        if (!ready && cmd !== 'init') throw new Error('движок ещё не загружен');
        const fn = handlers[cmd];
        if (!fn) throw new Error(`неизвестная команда ${cmd}`);
        const result = await fn(args || {});
        self.postMessage({ id, ok: true, result });
    } catch (err) {
        self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
    }
};
