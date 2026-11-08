/*
  GambitFish — клиент к воркеру движка с промисами.
  GPL-3.0.
*/

export class EngineClient {
    constructor(url = 'gambitfish.wasm') {
        this.url = typeof url === 'string' ? url : 'gambitfish.wasm';
        this.nextId = 1;
        this.pending = new Map();
        this.ready = false;
        this.worker = null;
        this.queue = Promise.resolve();
    }

    async init(wasmUrl) {
        if (this.ready) return true;
        /* в автономной сборке воркер подставляется снаружи (Blob-URL),
           иначе берём соседний файл worker.js */
        const workerUrl = (typeof window !== 'undefined' && window.__GF_WORKER_URL__)
            || new URL('./worker.js', import.meta.url);
        this.worker = new Worker(workerUrl, { type: 'module' });
        this.worker.onmessage = (ev) => {
            const { id, ok, result, error } = ev.data;
            const p = this.pending.get(id);
            if (!p) return;
            this.pending.delete(id);
            if (ok) p.resolve(result);
            else p.error(new Error(`движок: ${error}`));
        };
        let url = wasmUrl || this.url;
        /* всегда абсолютный URL: fetch внутри воркера разрешается
           относительно файла воркера, а не страницы */
        if (typeof location !== 'undefined') url = new URL(url, location.href).href;
        await this.send('init', { url });
        this.ready = true;
        return true;
    }

    send(cmd, args = {}) {
        if (!this.worker) return Promise.reject(new Error('воркер не создан'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            /* reject помечен как обработанный: ошибка движка не должна
               всплывать как unhandled rejection, её ловит вызывающий код */
            reject.handled = true;
            const error = (e) => {
                if (this.onEngineError) this.onEngineError(e);
                reject(e);
            };
            this.pending.set(id, { resolve, error });
            this.worker.postMessage({ id, cmd, args });
        });
    }

    /* последовательная очередь: анализ не должен пересекаться */
    serial(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => {});
        return run;
    }

    setFen(fen) { return this.send('setFen', { fen }); }
    legalMoves() { return this.send('legalMoves'); }
    makeMove(uci) { return this.send('makeMove', { uci }); }
    search(opts) { return this.serial(() => this.send('search', opts)); }
    perft(depth) { return this.send('perft', { depth }); }
    getFen() { return this.send('getFen'); }
    analyze(opts) { return this.serial(() => this.send('analyze', opts)); }
    playBest(opts) { return this.serial(() => this.send('playBest', opts)); }
    evaluate(gambitMode = 1) { return this.send('evaluate', { gambitMode }); }
    setWeights(gambit, sacrifice) { return this.send('setWeights', { gambit, sacrifice }); }
    setBook(on) { return this.send('setBook', { on }); }
    see(uci) { return this.send('see', { uci }); }
}
