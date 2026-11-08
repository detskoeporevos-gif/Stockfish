/*
  GambitFish — прямой адаптер к WASM для Node.js (без воркера).
  Используется сервером и тестами.
  GPL-3.0.
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM = path.join(here, '..', 'web', 'public', 'gambitfish.wasm');

export class NodeEngine {
    constructor(wasmPath = DEFAULT_WASM) {
        this.wasmPath = wasmPath;
        this.wasm = null;
        this.scratch = 1 << 16;
    }

    async init() {
        if (this.wasm) return this;
        const buf = fs.readFileSync(this.wasmPath);
        const { instance } = await WebAssembly.instantiate(buf, {
            env: { now_ms: () => BigInt(Date.now()) },
        });
        this.wasm = instance.exports;
        this.wasm.gf_init();
        return this;
    }

    mem() { return new Uint8Array(this.wasm.memory.buffer); }

    write(s) {
        this.mem().set(new TextEncoder().encode(s + '\0'), this.scratch);
        return this.scratch;
    }

    read(ptr) {
        const m = this.mem();
        let end = ptr;
        while (m[end]) end++;
        return new TextDecoder().decode(m.slice(ptr, end));
    }

    setFen(fen) { this.wasm.gf_set_fen(this.write(fen)); return this; }

    setBook(on) { this.wasm.gf_set_book(on ? 1 : 0); return this; }

    setMultiPV(on) {
        if (this.wasm.gf_set_multipv) this.wasm.gf_set_multipv(on ? 1 : 0);
        return this;
    }

    legalMoves() { return this.read(this.wasm.gf_legal_moves()).split(' ').filter(Boolean); }

    /* интерфейс, совместимый с gameAnalyzer */
    async analyze(fen, { movetime = 300, depth = 64, gambitMode = 1, contempt = 0 } = {}) {
        this.setFen(fen);
        const pv = this.read(this.wasm.gf_search(movetime, depth, gambitMode, contempt));
        const hasSecond = this.wasm.gf_last_has_second ? this.wasm.gf_last_has_second() : 0;
        return {
            pv,
            lines: hasSecond ? [
                { score: this.wasm.gf_last_score(), pv },
                { score: this.wasm.gf_last_score2(), pv: this.read(this.wasm.gf_last_pv2()) },
            ] : [{ score: this.wasm.gf_last_score(), pv }],
            score: this.wasm.gf_last_score(),
            depth: this.wasm.gf_last_depth(),
            seldepth: this.wasm.gf_last_seldepth(),
            nodes: this.wasm.gf_last_nodes(),
            time: this.wasm.gf_last_time(),
            book: this.wasm.gf_last_from_book(),
        };
    }

    perft(depth) { return this.wasm.gf_perft(depth); }
}

export default NodeEngine;
