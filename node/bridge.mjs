/*
  GambitFish — мостик Node → WASM для Flask-сервера.
  Читает JSON из stdin, пишет JSON в stdout:
    {"cmd":"analyze_pgn","pgn":"...","movetime":300}
    {"cmd":"search","fen":"...","movetime":1000}
    {"cmd":"gambits"}
  GPL-3.0.
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeEngine } from './engineAdapter.mjs';
import { parsePgn } from '../web/src/pgn/pgn.js';
import { analyzeGame, describeGame } from '../web/src/analysis/gameAnalyzer.js';
import { GAMBITS } from '../web/src/data/gambits.js';
import { Commentator } from '../web/src/commentary/commentator.js';
import { Position, uciToMove } from '../web/src/chess/chess.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => { data += c; });
        process.stdin.on('end', () => resolve(data));
    });
}

const engine = await new NodeEngine().init();
/* разбор партии не должен идти по книге: иначе оценки нулевые и «книжные» */
if (process.argv.includes('--no-book')) engine.setBook(false);
const commentator = new Commentator({ level: 'normal', side: 0, seed: 'server' });

const input = JSON.parse((await readStdin()) || '{}');
let out;

try {
    switch (input.cmd) {
    case 'gambits':
        out = { ok: true, gambits: GAMBITS };
        break;

    case 'search': {
        const res = await engine.analyze(input.fen, {
            movetime: input.movetime ?? 800,
            depth: input.depth ?? 64,
            gambitMode: input.gambitMode ?? 1,
        });
        const first = res.pv ? res.pv.split(' ')[0] : '';
        out = { ok: true, ...res, best: first };
        break;
    }

    case 'analyze_pgn': {
        const parsed = parsePgn(input.pgn || '');
        if (!parsed.moves.length) throw new Error('в PGN не найдено ходов');
        const result = await analyzeGame(parsed.moves, engine, {
            movetime: input.movetime ?? 300,
            gambitMode: input.gambitMode ?? 1,
            useBook: input.useBook !== false,
        });
        /* комментарии к ходам — из того же движка фраз */
        const notes = [];
        for (const mv of result.analysed) {
            try {
                const pos = new Position(mv.fenBefore);
                const move = uciToMove(pos, mv.uci);
                if (!move) continue;
                const cm = commentator.comment(pos, move);
                notes.push({ ply: mv.ply, san: mv.san, head: cm.head, text: cm.text, mark: mv.mark });
            } catch (err) {
                notes.push({ ply: mv.ply, san: mv.san, head: mv.san, text: '', mark: mv.mark });
            }
        }
        out = {
            ok: true,
            headers: parsed.headers,
            result: parsed.result,
            moves: result.analysed,
            summary: result.summary,
            notes,
            report: describeGame(result, commentator),
        };
        break;
    }

    case 'comment_position': {
        const pos = new Position(input.fen);
        const uci = input.uci;
        const m = uciToMove(pos, uci);
        if (!m) throw new Error('нелегальный ход');
        const cm = commentator.comment(pos, m);
        out = { ok: true, ...cm };
        break;
    }

    case 'gambit_info': {
        const g = GAMBITS.find((x) => x.id === input.id);
        if (!g) throw new Error('гамбит не найден');
        out = { ok: true, gambit: g, blurb: commentator.gambitBlurb(g.id) };
        break;
    }

    default:
        throw new Error(`неизвестная команда: ${input.cmd}`);
    }
} catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
}

process.stdout.write(JSON.stringify(out));
