/*
  GambitFish — разбор целых партий («авантюрных» в первую очередь).

  Для каждой позиции берётся оценка движка, затем ходы классифицируются
  по потере оценки: brilliancy / отличный / хороший / неточность /
  ошибка / грубая ошибка. Отдельно считаются жертвы и «авантюрность»
  (доля инициативы в дефиците материала).

  Работает и в браузере (через EngineClient/воркер), и в Node
  (через прямой адаптер над WASM) — интерфейс один: analyze(fen, opts).
  GPL-3.0.
*/

import { Position, uciToMove, moveToSan, moveToUci } from '../chess/chess.js';
import { analyzeMove, initiativeScore, materialBalance, kingVulnerability } from '../commentary/features.js';

export const MARK = {
    brilliant: { symbol: '!!', label: 'блестяще', cls: 'brilliant' },
    great: { symbol: '!', label: 'сильный ход', cls: 'great' },
    good: { symbol: '', label: 'хорошо', cls: 'good' },
    inaccuracy: { symbol: '?!', label: 'неточность', cls: 'inaccuracy' },
    mistake: { symbol: '?', label: 'ошибка', cls: 'mistake' },
    blunder: { symbol: '??', label: 'грубая ошибка', cls: 'blunder' },
    book: { symbol: '📖', label: 'книга', cls: 'book' },
    forced: { symbol: '□', label: 'вынужденно', cls: 'forced' },
};

/* «лучше было» должно быть в SAN: в UCI игроку это читать невозможно */
function uciToSan(fen, uci) {
    if (!fen || !uci) return '';
    try {
        const pos = new Position(fen);
        const m = uciToMove(pos, uci);
        return m ? moveToSan(pos, m) : uci;
    } catch (e) { return uci; }
}

const WIN = (cp) => 1 / (1 + Math.exp(-cp / 320));
const cpToWin = (cp) => Math.max(0, Math.min(1, WIN(Math.max(-2000, Math.min(2000, cp)))));

/*
  engine: объект с методом analyze(fen, {movetime, depth, gambitMode}) ->
          { score, pv, depth, nodes, time, book }
*/
export async function analyzeGame(moves, engine, opts = {}) {
    const movetime = opts.movetime ?? 350;
    const depth = opts.depth ?? 64;
    const onProgress = opts.onProgress || (() => {});
    const gambitMode = opts.gambitMode ?? 1;
    const onlyMainLine = true;
    /* разбор позиций не должен идти по дебютной книге: иначе вся партия
       окажется «книжной» с нулевыми потерями и нулевым отчётом */
    if (opts.useBook === false && typeof engine.setBook === 'function') {
        try { await engine.setBook(false); } catch (e) { /* движок без книги */ }
    }

    const positions = [];
    /* оценка стартовой позиции */
    const startFen = moves.length ? moves[0].fenBefore : opts.startFen;
    onProgress(0, moves.length + 1);
    /* оценка после каждой позиции; книга отключена — иначе вся партия
       окажется «книжной» с нулевыми потерями */
    const opts2 = { movetime, depth, gambitMode };
    const parse = (res) => {
        const lines = (res && res.lines && res.lines.length) ? res.lines
            : [{ score: res.score, pv: res.pv, depth: res.depth }];
        return { ...res, lines };
    };
    let prev = parse(await engine.analyze(startFen, opts2));
    positions.push({ ply: -1, fen: startFen, evalCp: prev.score, pv: prev.pv, book: prev.book });

    const analysed = [];
    for (let i = 0; i < moves.length; i++) {
        const mv = moves[i];
        const cur = parse(await engine.analyze(mv.fenAfter, opts2));
        const pos = new Position(mv.fenBefore);
        const move = uciToMove(pos, mv.uci);
        let feat = null;
        try { feat = move ? analyzeMove(pos, move) : null; } catch (e) { feat = null; }

        /* оценка всегда с точки зрения стороны, сделавшей ход */
        const sign = pos.side === 0 ? 1 : -1;
        const evalBefore = prev.score * sign;      // до хода
        /* если сыгранный ход есть во второй линии поиска, честнее брать
           оценку из неё: иначе потеря считается по «лучшей» линии */
        const played = mv.uci;
        let evalAfter = cur.score * -sign;         // после хода, для той же стороны
        if (cur.lines && cur.lines.length > 1) {
            const hit = cur.lines.find((l) => l.pv && l.pv.split(' ')[0] === played);
            if (hit) evalAfter = hit.score * -sign;
        }
        /* разные глубины на соседних позициях дают ложные потери;
           сглаживаем: слишком большой скачок при малой глубине не считаем */
        let lossCp = Math.max(0, evalBefore - evalAfter);
        const shallow = Math.min(prev.depth || 0, cur.depth || 0);
        if (shallow <= 2 && lossCp > 100) lossCp = 0;
        const bestWas = prev.pv ? prev.pv.split(' ')[0] : '';
        /* «лучше было» — SAN лучшего хода в той позиции */

        let mark = 'good';
        const mat = feat ? materialBalance(pos) : null;
        /* жертвой считаем отдачу материала, но не рокировку: там материал
           «предлагается» косвенно, это отдельная метка allowsSacrifice */
        const sac = feat ? (feat.isSacrifice || (feat.offersMaterial && !feat.castle)) : false;
        const allowsSac = feat ? (feat.offersMaterial && feat.castle) : false;

        if (prev.book) mark = 'book';
        else if (lossCp >= 250) mark = 'blunder';
        else if (lossCp >= 130) mark = 'mistake';
        else if (lossCp >= 60) mark = 'inaccuracy';
        else if (bestWas && played === bestWas && (sac || feat?.offersMaterial) && lossCp < 40) mark = 'brilliant';
        else if (bestWas && played === bestWas && lossCp < 15) mark = 'great';

        /* «вынужденный» ход: единственный легальный */
        const wasForced = pos.legalMoves().length === 1;
        if (wasForced) mark = 'forced';

        /* «авантюрность»: дефицит материала, оплаченный инициативой */
        const posAfter = new Position(mv.fenAfter);
        const init = initiativeScore(posAfter, pos.side);
        const diff = mat ? (pos.side === 0 ? mat.diff : -mat.diff) : 0;
        /* «авантюрность» = оплаченный инициативой материальный минус */
        const def = Math.max(0, -diff / 100);
        const adventure = Math.round(def * (0.6 + init / 10) * 10) / 10;

        analysed.push({
            ...mv,
            mark,
            lossCp,
            evalBefore,
            evalAfter,
            bestWas,
            bestSan: uciToSan(mv.fenBefore, bestWas),
            bestScore: prev.score,
            scoreAfter: cur.score,
            depth: cur.depth,
            sacrifice: sac,
            allowsSacrifice: allowsSac,
            sacrificeKind: feat && sac ? feat.type : 0,
            offer: feat ? feat.offerUci : '',
            see: feat ? feat.seeValue : 0,
            initiative: init,
            adventure,
            check: feat ? feat.check : false,
            mate: feat ? feat.mate : false,
            san: mv.san || (move ? moveToSan(pos, move) : mv.uci),
        });
        positions.push({ ply: i, fen: mv.fenAfter, evalCp: cur.score, pv: cur.pv, book: cur.book });
        prev = cur;
        onProgress(i + 1, moves.length + 1);
    }

    /* сводка */
    const summary = {
        white: makeStats(analysed, 0),
        black: makeStats(analysed, 1),
        sacrifices: analysed.filter((m) => m.sacrifice).length,
        /* «рискованные» решения: материал отдан косвенно (например, рокировка
           в Муцио, после которой сносится фигура) */
        risky: analysed.filter((m) => m.allowsSacrifice && !m.sacrifice).length,
        adventureIndex: 0,
        mostAdventurous: null,
        marks: analysed.map((m) => ({ san: m.san, mark: m.mark, lossCp: m.lossCp })),
        evalGraph: analysed.map((m) => Math.round(m.evalAfter)),
    };
    {
        /* индекс: средняя авантюрность + пик; 0..10 */
        const avg = analysed.length ? analysed.reduce((a, m) => a + m.adventure, 0) / analysed.length : 0;
        const peak = analysed.reduce((a, m) => Math.max(a, m.adventure), 0);
        summary.adventureAverage = Math.round(avg * 10) / 10;
        summary.adventurePeak = Math.round(peak * 10) / 10;
        summary.adventureIndex = Math.min(10, Math.round((avg * 0.6 + peak * 0.4) * 10) / 10);
    }
    summary.mostAdventurous = analysed.slice().sort((a, b) => b.adventure - a.adventure)[0] || null;

    /* точность по формуле, близкой к lichess */
    for (const key of ['white', 'black']) {
        const st = summary[key];
        st.accuracy = st.moves ? Math.max(0, Math.min(100,
            Math.round(103.1668 * Math.exp(-0.04354 * Math.min(st.acpl, 2000) / 100) - 3.1669))) : 0;
    }
    return { analysed, positions, summary };
}

function makeStats(analysed, side) {
    const mine = analysed.filter((m, idx) => idx % 2 === side);
    const counts = { brilliant: 0, great: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, book: 0, forced: 0 };
    let loss = 0;
    let sacrifice = 0;
    for (const m of mine) {
        counts[m.mark] = (counts[m.mark] || 0) + 1;
        loss += m.lossCp;
        if (m.sacrifice) sacrifice++;
    }
    return {
        moves: mine.length,
        ...counts,
        acpl: mine.length ? Math.round(loss / mine.length) : 0,
        sacrifices: sacrifice,
    };
}

/* Человекочитаемый разбор партии */
export function describeGame(result, commentator) {
    const s = result.summary;
    const lines = [];
    lines.push(`Разбор партии: ${result.analysed.length} полуходов.`);
    lines.push(`Точность: белые ${s.white.accuracy}% (ACPL ${s.white.acpl}), чёрные ${s.black.accuracy}% (ACPL ${s.black.acpl}).`);
    lines.push(`Жертв: ${s.sacrifices}. Рискованных решений: ${s.risky || 0}. Индекс авантюрности: ${s.adventureIndex}/10.`);
    const worst = result.analysed.slice().sort((a, b) => b.lossCp - a.lossCp)[0];
    if (worst && worst.lossCp > 100) {
        lines.push(`Ключевой перелом: ${worst.san} (потеря ${(worst.lossCp / 100).toFixed(2)}); лучше было ${worst.bestSan || worst.bestWas}.`);
    }
    const brill = result.analysed.filter((m) => m.mark === 'brilliant');
    if (brill.length) lines.push(`Лучшие моменты: ${brill.slice(0, 4).map((m) => m.san).join(', ')}.`);
    const sacs = result.analysed.filter((m) => m.sacrifice).slice(0, 5);
    if (sacs.length) {
        lines.push('Жертвы в партии:');
        for (const m of sacs) {
            const kind = m.sacrificeKind === 2 ? 'конь' : m.sacrificeKind === 3 ? 'слон'
                : m.sacrificeKind === 4 ? 'ладья' : m.sacrificeKind === 5 ? 'ферзь' : 'пешка';
            lines.push(`  ${m.san} — ${kind}, инициатива ${m.initiative}/10, авантюрность ${m.adventure}.`);
        }
    }
    return lines.join('\n');
}

export default analyzeGame;
