#!/usr/bin/env node
/*
  Самопроверка: движок играет сам с собой через WASM, каждый ход
  проверяется независимым JS-правилом. Ищет нелегальные ходы и падения.
  Запуск: node tools/selfplay.mjs [игр] [мс на ход]
*/
import fs from 'node:fs';
import { Position, uciToMove, moveToSan } from '../web/src/chess/chess.js';
import { Commentator } from '../web/src/commentary/commentator.js';

const games = +(process.argv[2] || 3);
const movetime = +(process.argv[3] || 120);

const buf = fs.readFileSync(new URL('../web/public/gambitfish.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(buf, { env: { now_ms: () => BigInt(Date.now()) } });
const e = instance.exports;
const mem = () => new Uint8Array(e.memory.buffer);
const SCRATCH = 1 << 16;
const write = (s) => { mem().set(new TextEncoder().encode(s + '\0'), SCRATCH); return SCRATCH; };
const read = (p) => { const m = mem(); let end = p; while (m[end]) end++; return new TextDecoder().decode(m.slice(p, end)); };

e.gf_init();
const commentator = new Commentator({ level: 'short', side: 0, seed: 'selfplay' });

let failures = 0;
for (let g = 0; g < games; g++) {
    const pos = new Position();
    e.gf_set_fen(write(pos.fen()));
    const moves = [];
    for (let ply = 0; ply < 200; ply++) {
        const legal = pos.legalMoves();
        if (!legal.length) break;
        const uci = read(e.gf_play_best(movetime, 64, 1, 0));
        const m = uciToMove(pos, uci);
        if (!m) {
            console.error(`✗ игра ${g}, полуход ${ply}: нелегальный ход ${uci} в ${pos.fen()}`);
            failures++;
            break;
        }
        /* комментатор не должен падать и должен выдавать текст */
        const cm = commentator.comment(pos, m);
        if (!cm.text || cm.text.length < 3) { console.error('✗ пустой комментарий'); failures++; }
        moves.push(moveToSan(pos, m));
        pos.makeMove(m);
        e.gf_set_fen(write(pos.fen()));
    }
    const fen = pos.fen();
    console.log(`игра ${g + 1}: ${moves.length} полуходов · ${pos.isCheckmate() ? 'мат' : pos.isStalemate() ? 'пат' : 'окончена'} · ${fen}`);
}
console.log(failures ? `ОШИБОК: ${failures}` : 'self-play без ошибок ✔');
process.exit(failures ? 1 : 0);
