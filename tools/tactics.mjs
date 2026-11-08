#!/usr/bin/env node
/* Проверка тактики: набор позиций с известным лучшим ходом. */
import fs from 'node:fs';
import { Position, uciToMove, moveToSan } from '../web/src/chess/chess.js';

const CASES = [
    ['r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', ['h5f7']],           // мат в 1
    ['6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', ['a1a8']],                                               // мат в 1
    ['r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PPP2PPP/R3R1K1 w - - 1 0', ['d5d8']],                          // мат в 1
    ['2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', ['g3g6']],                        // мат в 3 (Греко)
    ['8/8/8/8/8/6k1/6p1/6K1 w - - 0 1', []],                                                          // пат
    ['r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', []],                 // сложная, без проверки
    ['2r3k1/p4p2/3Rp2p/1p2P1pK/8/1P4P1/P3Q2P/1q6 b - - 0 1', ['b1g6']],                              // мат в 2
    ['8/8/8/8/8/2k5/2p5/2K5 b - - 0 1', []],
];

const buf = fs.readFileSync(new URL('../web/public/gambitfish.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(buf, { env: { now_ms: () => BigInt(Date.now()) } });
const e = instance.exports;
const mem = () => new Uint8Array(e.memory.buffer);
const write = (s) => { mem().set(new TextEncoder().encode(s + '\0'), 1 << 16); return 1 << 16; };
const read = (p) => { const m = mem(); let end = p; while (m[end]) end++; return new TextDecoder().decode(m.slice(p, end)); };
e.gf_init();

let ok = 0, fail = 0;
for (const [fen, expected] of CASES) {
    const pos = new Position(fen);
    if (!pos.legalMoves().length) { console.log(`позиция без ходов: ${fen}`); continue; }
    e.gf_set_fen(write(fen));
    const pv = read(e.gf_search(1500, 64, 1, 0));
    const best = pv.split(' ')[0];
    const san = (() => { const m = uciToMove(pos, best); return m ? moveToSan(pos, m) : best; })();
    if (!expected.length) { console.log(`· ${fen} -> ${san} (без проверки)`); continue; }
    if (expected.includes(best)) { ok++; console.log(`✓ ${san} (${best}) score ${e.gf_last_score()}`); }
    else { fail++; console.log(`✗ ${san} (${best}), ожидался ${expected.join('/')} score ${e.gf_last_score()} depth ${e.gf_last_depth()}`); }
}
console.log(`тактика: ${ok} верно, ${fail} ошибок`);
process.exit(fail ? 1 : 0);
