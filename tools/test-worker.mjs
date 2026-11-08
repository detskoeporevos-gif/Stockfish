#!/usr/bin/env node
/* Проверка воркера движка без браузера: подменяем self/fetch/Worker-API. */
import fs from 'node:fs';

const wasmBuf = fs.readFileSync(new URL('../web/public/gambitfish.wasm', import.meta.url));
globalThis.fetch = async () => ({ arrayBuffer: async () => wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength) });
const outbox = [];
globalThis.self = {
    postMessage: (msg) => outbox.push(msg),
    onmessage: null,
};

await import('../web/src/engine/worker.js');

function call(id, cmd, args) {
    self.onmessage({ data: { id, cmd, args } });
    return new Promise((res) => {
        const tick = () => {
            const found = outbox.find((m) => m.id === id);
            if (found) res(found);
            else setTimeout(tick, 10);
        };
        tick();
    });
}

let fails = 0;
const check = (cond, label, extra = '') => {
    if (cond) console.log(`✓ ${label}`);
    else { console.log(`✗ ${label} ${extra}`); fails++; }
};

const r1 = await call(1, 'init', { url: 'gambitfish.wasm' });
check(r1.ok, 'init');

const r2 = await call(2, 'legalMoves');
check(r2.ok && r2.result.split(' ').length === 20, 'legalMoves старт', r2.result);

const r3 = await call(3, 'perft', { depth: 3 });
check(r3.ok && r3.result === 8902, 'perft 3 = 8902', String(r3.result));

const r4 = await call(4, 'search', { movetime: 300 });
check(r4.ok && /^[a-h][1-8][a-h][1-8]/.test(r4.result.pv), 'search выдаёт PV', JSON.stringify(r4.result));

/* книга: 1.e4 e5 2.f4 — должен быть ход из книги */
await call(5, 'setFen', { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' });
for (const [i, uci] of ['e2e4', 'e7e5', 'f2f4'].entries()) {
    await call(10 + i, 'makeMove', { uci });
}
const r6 = await call(20, 'search', { movetime: 200 });
check(r6.ok && r6.result.book === 1, 'дебютная книга активна', JSON.stringify(r6.result));

const r7 = await call(21, 'evaluate', { gambitMode: 1 });
check(r7.ok && typeof r7.result === 'number', 'evaluate', String(r7.result));

const r8 = await call(22, 'see', { uci: 'b2b4' });
check(r8.ok, 'see', String(r8.result));

const r9 = await call(23, 'playBest', { movetime: 300 });
check(r9.ok && r9.result.uci, 'playBest', JSON.stringify(r9.result));

console.log(fails ? `ОШИБОК: ${fails}` : 'воркер: всё в порядке ✔');
process.exit(fails ? 1 : 0);
