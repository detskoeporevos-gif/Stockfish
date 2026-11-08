#!/usr/bin/env node
/*
  Проверяет легальность всех линий гамбитов (через web/src/chess/chess.js)
  и генерирует дебютную книгу engine/gambit_book.inc для C-движка.
  Запуск: node tools/verify-gambits.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Position, START_FEN, uciToMove, moveToSan } from '../web/src/chess/chess.js';
import { GAMBITS } from '../web/src/data/gambits.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let errors = 0;
const bookLines = [];
const seen = new Map();
const report = [];

for (const g of GAMBITS) {
    const lines = g.lines && g.lines.length ? g.lines : [g.moves];
    let okLines = 0;
    const ordered = [g.moves, ...lines];
    for (let li = 0; li < ordered.length; li++) {
        const line = ordered[li];
        const pos = new Position(START_FEN);
        let legal = true;
        const sans = [];
        for (const uci of line) {
            const m = uciToMove(pos, uci);
            if (!m) {
                console.error(`✗ ${g.id}: нелегальный ход ${uci} в линии: ${line.join(' ')}`);
                errors++;
                legal = false;
                break;
            }
            sans.push(moveToSan(pos, m));
            pos.makeMove(m);
        }
        if (legal) {
            okLines++;
            bookLines.push({ id: g.id, moves: line.join(' ') });
            if (g.id === report.find((r) => r.id === g.id)?.id) {
                report.find((r) => r.id === g.id).variants.push(sans.join(' '));
            } else {
                report.push({ id: g.id, name: g.name, variants: [sans.join(' ')] });
            }
        }
    }
    if (!okLines) console.error(`✗ ${g.id}: ни одной легальной линии`);
    if (seen.has(g.moves.join(' '))) console.error(`! дубликат главной линии: ${g.id} и ${seen.get(g.moves.join(' '))}`);
    seen.set(g.moves.join(' '), g.id);
}

/* дебютная книга: для каждой позиции — ход из каждой линии */
const rows = new Map();
for (const bl of bookLines) {
    const pos = new Position(START_FEN);
    for (const uci of bl.moves.split(' ')) {
        const m = uciToMove(pos, uci);
        if (!m) break;
        rows.set(pos.fen(), uci);
        pos.makeMove(m);
    }
}

const inc = [
    '/* Сгенерировано tools/verify-gambits.mjs — не редактировать вручную. */',
    'static const BookLine BOOK_LINES[] = {',
    ...bookLines.map((bl) => `    {"${bl.moves}", 4},`),
    '};',
    `static const int BOOK_LINE_COUNT = ${bookLines.length};`,
    '',
];
fs.writeFileSync(path.join(root, 'engine/gambit_book.inc'), inc.join('\n'));
fs.writeFileSync(path.join(root, 'web/src/data/gambit-lines.json'),
    JSON.stringify(report, null, 2) + '\n');

console.log(`гамбитов: ${GAMBITS.length}, линий в книге: ${bookLines.length}, позиций книги: ${rows.size}`);
console.log(errors ? `ОШИБОК: ${errors}` : 'все линии легальны ✔');
process.exit(errors ? 1 : 0);
