/*
  GambitFish — парсер PGN (без зависимостей).
  Поддерживает заголовки, комментарии {...}, варианты (...), NAG ($1..$255),
  нумерацию, результаты. Варианты сохраняются как дерево, но для разбора
  берётся главная линия.
  GPL-3.0.
*/

import { Position, uciToMove, parseSan, moveToSan, moveToUci, START_FEN } from '../chess/chess.js';

/* разбиение на токены */
function tokenize(text) {
    const tokens = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === '{') {
            const end = text.indexOf('}', i);
            const body = text.slice(i + 1, end < 0 ? n : end);
            tokens.push({ type: 'comment', value: body.trim() });
            i = end < 0 ? n : end + 1;
            continue;
        }
        if (ch === ';') {
            const end = text.indexOf('\n', i);
            tokens.push({ type: 'comment', value: text.slice(i + 1, end < 0 ? n : end).trim() });
            i = end < 0 ? n : end + 1;
            continue;
        }
        if (ch === '(') {
            /* вариант: пропускаем, но помечаем */
            let depth = 0;
            let j = i;
            for (; j < n; j++) {
                if (text[j] === '(') depth++;
                else if (text[j] === ')') { depth--; if (!depth) { j++; break; } }
            }
            tokens.push({ type: 'variation', value: text.slice(i + 1, j - 1).trim() });
            i = j;
            continue;
        }
        if (ch === '[') {
            const end = text.indexOf(']', i);
            const line = text.slice(i + 1, end < 0 ? n : end);
            const m = /^\s*(\w+)\s+"([^"]*)"\s*$/.exec(line);
            if (m) tokens.push({ type: 'header', key: m[1], value: m[2] });
            i = end < 0 ? n : end + 1;
            continue;
        }
        if (/\s/.test(ch)) { i++; continue; }
        /* слово */
        let j = i;
        while (j < n && !/[\s{;(]/.test(text[j])) j++;
        const word = text.slice(i, j);
        i = j;
        if (/^\d+\.(\.\.)?$/.test(word)) continue;
        if (/^\d+\.\.\.$/.test(word)) continue;
        if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(word)) { tokens.push({ type: 'result', value: word }); continue; }
        if (/^\$\d+$/.test(word)) { tokens.push({ type: 'nag', value: +word.slice(1) }); continue; }
        tokens.push({ type: 'move', value: word });
    }
    return tokens;
}

/* NAG -> символ */
export function nagToSymbol(nag) {
    const map = {
        1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!',
        7: '□', 10: '=', 13: '∞', 14: '⩲', 15: '⩱', 16: '±', 17: '∓',
        18: '+−', 19: '−+', 36: '↑', 40: '→',
    };
    return map[nag] || '';
}

/*
  Разбор PGN. Возвращает:
  { headers, result, moves: [{ san, uci, nag, comment, fenBefore, fenAfter }],
    variations: [{ afterPly, san }] }
*/
export function parsePgn(text, options = {}) {
    const tokens = tokenize(text);
    const headers = {};
    const moves = [];
    const variations = [];
    let result = '*';
    let startFen = START_FEN;
    let pos = null;

    for (const tok of tokens) {
        if (tok.type === 'header') {
            headers[tok.key] = tok.value;
            if (tok.key === 'FEN') startFen = tok.value;
            continue;
        }
        if (tok.type === 'result') { result = tok.value; continue; }
        if (tok.type === 'comment') {
            if (moves.length) moves[moves.length - 1].comment = (moves[moves.length - 1].comment || '') + ' ' + tok.value;
            continue;
        }
        if (tok.type === 'nag') {
            if (moves.length) moves[moves.length - 1].nag = tok.value;
            continue;
        }
        if (tok.type === 'variation') {
            variations.push({ afterPly: moves.length, text: tok.value });
            continue;
        }
        if (tok.type === 'move') {
            if (!pos) pos = new Position(startFen);
            let m = parseSan(pos, tok.value);
            let uci = '';
            if (!m) {
                /* возможно это координатная нотация */
                const guess = tok.value.replace(/[+#!?]/g, '');
                if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(guess)) {
                    m = uciToMove(pos, guess);
                    if (m) uci = guess;
                }
            }
            if (!m) {
                if (options.strict) throw new Error(`не удалось разобрать ход: ${tok.value}`);
                continue;
            }
            const san = tok.value.replace(/[!?]+$/, '');
            uci = uci || moveToUci(m);
            const fenBefore = pos.fen();
            pos.makeMove(m);
            moves.push({ san, uci, nag: 0, comment: '', fenBefore, fenAfter: pos.fen(), ply: moves.length });
        }
    }

    return { headers, result, startFen, moves, variations };
}

/* Обратная запись (для сохранения разобранной партии) */
export function writePgn(headers, moves, result = '*') {
    const lines = Object.entries(headers).map(([k, v]) => `[${k} "${v}"]`);
    const body = [];
    let num = 1;
    let white = true;
    if (headers.FEN) {
        const p = new Position(headers.FEN);
        num = p.fullmove;
        white = p.side === 0;
    }
    for (const m of moves) {
        const san = m.san + (m.nag ? nagToSymbol(m.nag) : '');
        if (white) body.push(`${num}.`);
        else if (m.ply === 0 || body.length === 0) body.push(`${num}...`);
        body.push(san);
        if (!white) num++;
        white = !white;
    }
    return `${lines.join('\n')}\n\n${body.join(' ')} ${result}\n`;
}

export default { parsePgn, writePgn, nagToSymbol };
