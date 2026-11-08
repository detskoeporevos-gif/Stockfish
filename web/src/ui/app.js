/*
  GambitFish — сборка интерфейса: игра с движком, комментарии,
  база гамбитов, настройки. GPL-3.0.
*/

import {
    Position, WHITE, BLACK, START_FEN, uciToMove, moveToSan, moveToUci, mFrom, mTo,
    mFlags, mPromo, FLAG_PROMOTION,
} from '../chess/chess.js';
import { BoardView } from './board.js';
import { EngineClient } from '../engine/client.js';
import { Commentator, gambitLookup } from '../commentary/commentator.js';
import { analyzeMove } from '../commentary/features.js';
import { GAMBITS, GAMBIT_BY_ID } from '../data/gambits.js';
import { parsePgn } from '../pgn/pgn.js';
import { analyzeGame, describeGame, MARK } from '../analysis/gameAnalyzer.js';

const $ = (sel) => document.querySelector(sel);

const state = {
    pos: new Position(),
    history: [],       // {uci, san, fenBefore, fenAfter, analysis}
    playerSide: WHITE,
    engineSide: BLACK,
    thinking: false,
    gameOver: false,
    lastAnalysis: null,
    settings: {
        level: 'master',
        movetime: 1500,
        appetite: 120,
        gambit: 120,
        book: true,
        comments: true,
        commentLevel: 'normal',
        side: 'white',
    },
};

const LEVELS = {
    club: { depth: 6, movetimeScale: 0.5 },
    master: { depth: 64, movetimeScale: 1 },
    grandmaster: { depth: 64, movetimeScale: 2 },
    max: { depth: 64, movetimeScale: 4 },
};

const engine = new EngineClient('gambitfish.wasm');

/* адаптер под интерфейс analyze(fen, opts), которого ждёт разбор партий */
const analyzeAdapter = {
    async analyze(fen, opts = {}) {
        await engine.setFen(fen);
        return engine.search({
            movetime: opts.movetime ?? 300,
            depth: opts.depth ?? 64,
            gambitMode: opts.gambitMode ?? 1,
            contempt: 0,
        });
    },
};
const commentator = new Commentator({ level: 'normal', side: WHITE, seed: 'gambitfish' });
const board = new BoardView($('#board'), { onMove: onBoardMove });

/* ------------------------------------------------------------------ */
/*  Чат                                                               */
/* ------------------------------------------------------------------ */

function addMessage(kind, html, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = `gf-msg ${kind}`;
    const avatar = document.createElement('div');
    avatar.className = 'gf-avatar';
    avatar.textContent = kind === 'user' ? '🙋' : kind === 'system' ? 'ⓘ' : '♞';
    const bubble = document.createElement('div');
    bubble.className = 'gf-bubble';
    bubble.innerHTML = html;
    wrap.append(avatar, bubble);
    const log = $('#chat-log');
    log.appendChild(wrap);
    if (opts.scroll !== false) log.scrollTop = log.scrollHeight;
    /* ограничим длину лога */
    while (log.children.length > 400) log.removeChild(log.firstChild);
    return bubble;
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sayComment(head, text) {
    if (!state.settings.comments) return;
    addMessage('engine', `<span class="san">${escapeHtml(head)}</span>${escapeHtml(text)}`);
}

/* ------------------------------------------------------------------ */
/*  Ходы                                                              */
/* ------------------------------------------------------------------ */

function pushMove(move, opts = {}) {
    const pos = state.pos;
    const san = moveToSan(pos, move);
    const uci = moveToUci(move);
    const fenBefore = pos.fen();
    let analysis = null;
    try {
        analysis = analyzeMove(pos, move);
    } catch (err) {
        console.warn('analyze failed', err);
    }
    pos.makeMove(move);
    const entry = { uci, san, fenBefore, fenAfter: pos.fen(), analysis, byEngine: !!opts.byEngine };
    state.history.push(entry);
    renderMoveList();

    if (state.settings.comments && analysis) {
        const cm = commentator.comment(new Position(fenBefore), move);
        sayComment(cm.head, cm.text);
    }

    updateBoard();
    checkGameEnd();
    return entry;
}

function updateBoard() {
    const last = state.history[state.history.length - 1];
    const lastMove = last ? uciToMove(new Position(last.fenBefore), last.uci) : null;
    board.setPosition(state.pos, {
        legal: state.pos.legalMoves(),
        lastMove,
        flipped: state.playerSide === BLACK,
    });
}

function renderMoveList() {
    const box = $('#move-list');
    box.innerHTML = '';
    let i = 0;
    const startFullmove = 1;
    let num = startFullmove;
    let white = true;
    while (i < state.history.length) {
        const rowNum = document.createElement('div');
        rowNum.className = 'num';
        rowNum.textContent = `${num}.`;
        box.appendChild(rowNum);
        for (let k = 0; k < 2 && i < state.history.length; k++) {
            const e = state.history[i];
            const btn = document.createElement('button');
            btn.className = 'mv' + (e.analysis && e.analysis.isSacrifice ? ' sac' : '');
            btn.textContent = e.san;
            btn.dataset.index = String(i);
            btn.addEventListener('click', () => showPositionAt(i));
            box.appendChild(btn);
            i++;
        }
        num++;
        white = !white;
    }
    const cur = box.querySelector('.mv:last-child');
    if (cur) cur.classList.add('current');
}

function showPositionAt(index) {
    const entry = state.history[index];
    if (!entry) return;
    const pos = new Position(entry.fenAfter);
    const info = analyzeMove(new Position(entry.fenBefore), uciToMove(new Position(entry.fenBefore), entry.uci));
    board.setPosition(pos, { legal: [], lastMove: null, flipped: state.playerSide === BLACK });
    board.hintSquares([]);
    $('#engine-info').textContent = [
        `позиция после ${entry.san}`,
        info ? `материал: ${(info.matDiffAfter / 100).toFixed(2)}` : '',
        info && info.isSacrifice ? 'жертва' : '',
    ].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ */
/*  Игра                                                              */
/* ------------------------------------------------------------------ */

async function onBoardMove({ from, to, moves }) {
    if (state.gameOver) return;
    if (state.pos.side !== state.playerSide) return;
    if (moves.length > 1) {
        showPromotionPicker(moves, (m) => afterPlayerMove(m));
        return;
    }
    afterPlayerMove(moves[0]);
}

function afterPlayerMove(move) {
    board.setSelection(-1);
    pushMove(move);
    if (!state.gameOver) engineTurn();
}

function showPromotionPicker(moves, cb) {
    const host = $('#board');
    const overlay = document.createElement('div');
    overlay.className = 'gf-promo';
    const inner = document.createElement('div');
    const glyphs = { 5: '♕', 4: '♖', 3: '♗', 2: '♘' };
    for (const m of moves) {
        const b = document.createElement('button');
        b.textContent = glyphs[mPromo(m)] || '♕';
        b.addEventListener('click', () => { overlay.remove(); cb(m); });
        inner.appendChild(b);
    }
    overlay.appendChild(inner);
    host.appendChild(overlay);
}

async function engineTurn() {
    if (state.gameOver || state.pos.side === state.playerSide) return;
    state.thinking = true;
    const level = LEVELS[state.settings.level] || LEVELS.master;
    const base = state.settings.movetime * level.movetimeScale;
    $('#engine-status').textContent = 'думает…';
    $('#engine-status').className = 'pill loading';
    try {
        await engine.setFen(state.pos.fen());
        const res = await engine.search({
            movetime: Math.round(base),
            depth: level.depth,
            gambitMode: 1,
            contempt: 0,
        });
        if (res && res.pv) {
            const uci = res.pv.split(' ')[0];
            const move = uciToMove(state.pos, uci);
            if (move) {
                pushMove(move, { byEngine: true });
            }
        }
        $('#engine-info').textContent = [
            `глубина ${res.depth}/${res.seldepth}`,
            `оценка ${(res.score / 100).toFixed(2)}`,
            `узлов ${(res.nodes / 1000).toFixed(0)}k`,
            `${res.time} мс`,
            res.book ? 'книга' : '',
            res.pv ? `pv: ${res.pv}` : '',
        ].filter(Boolean).join(' · ');
        updateEvalBar(res.score);
        $('#engine-speed').textContent = `${(res.nodes / Math.max(1, res.time) / 1000).toFixed(2)} Mузл/с`;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error(err);
        addMessage('system', `Ошибка движка: ${escapeHtml(String(err.message || err))}`);
    } finally {
        state.thinking = false;
        $('#engine-status').textContent = 'готов';
        $('#engine-status').className = 'pill ok';
    }
}

function updateEvalBar(cp) {
    const clamped = Math.max(-800, Math.min(800, cp));
    const pct = 50 + (clamped / 800) * 50;
    const fill = $('#eval-fill');
    if (cp >= 0) {
        fill.style.inset = `0 ${100 - pct}% 0 0`;
        fill.style.background = 'linear-gradient(90deg,#e9e4d8,#ffffff)';
    } else {
        fill.style.inset = `0 0 0 ${pct}%`;
        fill.style.background = 'linear-gradient(90deg,#1b1f27,#3a4252)';
    }
    $('#eval-text').textContent = (cp / 100).toFixed(2);
}

function checkGameEnd() {
    const pos = state.pos;
    let text = '';
    if (pos.isCheckmate()) {
        const winner = pos.side === WHITE ? 'чёрные' : 'белые';
        text = `Мат! Победа: ${winner}.`;
    } else if (pos.isStalemate()) {
        text = 'Пат — ничья.';
    } else if (pos.isInsufficientMaterial()) {
        text = 'Ничья: недостаточно материала.';
    } else if (pos.halfmove >= 100) {
        text = 'Ничья по правилу 50 ходов.';
    }
    if (text) {
        state.gameOver = true;
        $('#board-message').textContent = text;
        $('#board-message').classList.remove('hidden');
        addMessage('system', escapeHtml(text));
        if (state.settings.comments) {
            addMessage('engine', escapeHtml(commentator.ending(pos, state.history)));
        }
    }
}

function newGame() {
    state.pos = new Position(START_FEN);
    state.history = [];
    state.gameOver = false;
    commentator.seenGambits.clear();
    $('#board-message').classList.add('hidden');
    $('#move-list').innerHTML = '';
    $('#engine-info').textContent = '';
    $('#chat-log').innerHTML = '';
    let side = state.settings.side;
    if (side === 'random') side = Math.random() < 0.5 ? 'white' : 'black';
    state.playerSide = side === 'white' ? WHITE : BLACK;
    state.engineSide = state.playerSide ^ 1;
    commentator.setSide(state.playerSide);
    updateBoard();
    addMessage('system', escapeHtml(`Новая партия. Вы играете ${side === 'white' ? 'белыми' : 'чёрными'}.`));
    addMessage('engine', escapeHtml(
        state.playerSide === BLACK
            ? 'Я начинаю. Гамбит — это моя стихия, так что держитесь.'
            : 'Я готов. Играю гамбиты и буду объяснять каждый свой ход.',
    ));
    if (state.engineSide === WHITE) engineTurn();
}

function undo() {
    if (state.thinking) return;
    /* отменяем два полухода: свой и ответ движка */
    let removed = 0;
    while (state.history.length && removed < 2) {
        const last = state.history[state.history.length - 1];
        state.history.pop();
        state.pos = new Position(last.fenBefore);
        removed++;
        if (state.pos.side === state.playerSide) break;
    }
    state.gameOver = false;
    $('#board-message').classList.add('hidden');
    renderMoveList();
    updateBoard();
}

async function hint() {
    await engine.setFen(state.pos.fen());
    const res = await engine.search({ movetime: 1200, depth: 64, gambitMode: 1, contempt: 0 });
    if (!res || !res.pv) return;
    const pv = res.pv.split(' ');
    const first = uciToMove(state.pos, pv[0]);
    if (!first) return;
    board.hintSquares([mFrom(first), mTo(first)]);
    $('#engine-info').textContent = `подсказка: ${pv.join(' ')} · ${(res.score / 100).toFixed(2)} · глубина ${res.depth}`;
    updateEvalBar(res.score);
}

async function explainPosition() {
    await engine.setFen(state.pos.fen());
    const res = await engine.search({ movetime: 1500, depth: 64, gambitMode: 1, contempt: 0 });
    if (!res || !res.pv) return;
    const pv = res.pv.split(' ');
    const line = pv.slice(0, 5).map((u) => {
        const probe = new Position(state.pos.fen());
        const parts = [];
        return u;
    });
    const gambit = gambitLookup(state.pos.fen());
    const stat = [
        `Оценка ${(res.score / 100).toFixed(2)} (глубина ${res.depth}).`,
        `Главная линия: ${pv.slice(0, 6).join(' ')}.`,
        gambit ? `Дебют: ${gambit.name}. Идеи: ${gambit.ideas[0]}` : '',
    ].filter(Boolean).join(' ');
    addMessage('engine', escapeHtml(stat));
    updateEvalBar(res.score);
}

/* ------------------------------------------------------------------ */
/*  Разбор PGN                                                        */
/* ------------------------------------------------------------------ */

const SAMPLE_PGN = `[Event "Гамбит Муцио — пример"]
[White "Атака"]
[Black "Защита"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Bc4 g4 5. O-O gxf3 6. Qxf3 Qf6
7. e5 Qxe5 8. d3 Bh6 9. Nc3 Ne7 10. Nd5 Kd8 11. Bxf4 Qd4+ 12. Kh1 1-0`;

let reviewCache = null;

async function reviewPgn() {
    const text = $('#pgn-input').value.trim();
    if (!text) { addMessage('system', 'Вставьте PGN в поле слева.'); return; }
    const parsed = parsePgn(text);
    if (!parsed.moves.length) { addMessage('system', 'В PGN не найдено ходов.'); return; }
    const movetime = +(document.querySelector('#review-movetime').value || 300);

    const progressWrap = $('#review-progress');
    const fill = $('#review-progress-fill');
    progressWrap.classList.remove('hidden');
    $('#review-report').textContent = 'Считаю…';
    $('#review-moves').innerHTML = '';

    const res = await analyzeGame(parsed.moves, analyzeAdapter, {
        movetime,
        onProgress: (i, n) => { fill.style.width = `${Math.round((i / n) * 100)}%`; },
    });
    reviewCache = res;
    progressWrap.classList.add('hidden');

    const report = describeGame(res, commentator);
    $('#review-report').textContent = report + '\n\n' + (parsed.headers.White ? `${parsed.headers.White} — ${parsed.headers.Black} (${parsed.result})` : '');
    const box = $('#review-moves');
    box.innerHTML = '';
    for (const m of res.analysed) {
        const el = document.createElement('span');
        const mark = MARK[m.mark] || MARK.good;
        el.className = mark.cls;
        el.textContent = `${m.san}${mark.symbol}`;
        el.title = `${mark.label} · потеря ${(m.lossCp / 100).toFixed(2)} · оценка ${(m.evalAfter / 100).toFixed(2)}${m.sacrifice ? ' · жертва' : ''}`;
        el.addEventListener('click', () => {
            const pos = new Position(m.fenAfter);
            board.setPosition(pos, { legal: [], lastMove: uciToMove(new Position(m.fenBefore), m.uci) });
            addMessage('engine', escapeHtml(commentator.comment(new Position(m.fenBefore), uciToMove(new Position(m.fenBefore), m.uci)).text));
        });
        box.appendChild(el);
    }
    addMessage('engine', escapeHtml(`Разбор готов: ${res.analysed.length} полуходов, точность ${res.summary.white.accuracy}% / ${res.summary.black.accuracy}%, индекс авантюрности ${res.summary.adventureIndex}/10.`));
}

/* ------------------------------------------------------------------ */
/*  База гамбитов                                                     */
/* ------------------------------------------------------------------ */

function renderGambits(filter = '') {
    const box = $('#gambit-list');
    box.innerHTML = '';
    const q = filter.toLowerCase();
    const list = GAMBITS.filter((g) => !q
        || g.name.toLowerCase().includes(q)
        || g.nameEn.toLowerCase().includes(q)
        || g.tags.some((t) => t.includes(q)));
    for (const g of list) {
        const card = document.createElement('div');
        card.className = 'gf-gambit-card';
        card.innerHTML = `
            <h4>${escapeHtml(g.name)}</h4>
            <p>${escapeHtml(g.nameEn)} · ${escapeHtml(g.eco)} · ${g.side === 'white' ? 'за белых' : 'за чёрных'}</p>
            <p>${g.tags.slice(0, 3).map((t) => `<span class="gf-tag">${escapeHtml(t)}</span>`).join('')}</p>`;
        card.addEventListener('click', () => showGambit(g));
        box.appendChild(card);
    }
}

function showGambit(g) {
    const detail = $('#gambit-detail');
    const lines = (g.lines || []).slice(0, 3).map((line) => {
        const pos = new Position(START_FEN);
        const sans = [];
        for (const u of line) {
            const m = uciToMove(pos, u);
            if (!m) break;
            sans.push(moveToSan(pos, m));
            pos.makeMove(m);
        }
        return sans.join(' ');
    });
    detail.innerHTML = `
        <h3>${escapeHtml(g.name)}</h3>
        <p><strong>${escapeHtml(g.nameEn)}</strong> · ${escapeHtml(g.eco)} · минус: ${escapeHtml(String(g.material / 100))} пешки</p>
        <p><strong>Идеи:</strong></p>
        <ul>${g.ideas.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
        <p><strong>Планы:</strong></p>
        <ul>${g.plans.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
        <p><strong>Как защищаться:</strong></p>
        <ul>${g.defense.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
        ${g.traps && g.traps.length ? `<p><strong>Ловушки:</strong></p><ul>${g.traps.map((t) => `<li>${escapeHtml(t.note)}</li>`).join('')}</ul>` : ''}
        <p><strong>Ключевые поля:</strong> ${g.keySquares.map((s) => `<span class="gf-tag">${escapeHtml(s)}</span>`).join('')}</p>
        <p><strong>Варианты:</strong><br>${lines.map(escapeHtml).join('<br>')}</p>
        <button class="ghost" id="play-gambit">Играть этот гамбит</button>`;
    $('#play-gambit').addEventListener('click', () => startGambit(g));
    addMessage('engine', escapeHtml(commentator.gambitBlurb(g.id)));
}

function startGambit(g) {
    newGame();
    /* играем линию за ту сторону, которая жертвует */
    const line = g.moves;
    const sacrificing = g.side === 'white' ? WHITE : BLACK;
    state.playerSide = sacrificing;
    state.engineSide = sacrificing ^ 1;
    commentator.setSide(sacrificing);
    updateBoard();
    addMessage('system', escapeHtml(`Гамбит: ${g.name}. Вы играете за ${sacrificing === WHITE ? 'белых' : 'чёрных'}.`));
    if (state.pos.side !== state.playerSide) engineTurn();
    loadTab('chat');
}

/* ------------------------------------------------------------------ */
/*  Вкладки и настройки                                               */
/* ------------------------------------------------------------------ */

function loadTab(name) {
    document.querySelectorAll('.gf-tabs button').forEach((b) => {
        b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
        p.classList.toggle('active', p.dataset.panel === name);
    });
}

document.querySelectorAll('.gf-tabs button').forEach((b) => {
    b.addEventListener('click', () => loadTab(b.dataset.tab));
});

function bindSettings() {
    $('#opt-side').addEventListener('change', (e) => {
        state.settings.side = e.target.value;
        newGame();
    });
    $('#opt-level').addEventListener('change', (e) => { state.settings.level = e.target.value; });
    $('#opt-movetime').addEventListener('change', (e) => { state.settings.movetime = +e.target.value; });
    $('#opt-appetite').addEventListener('input', (e) => {
        state.settings.appetite = +e.target.value;
        $('#opt-appetite-val').textContent = `${e.target.value}%`;
        engine.setWeights(state.settings.gambit, state.settings.appetite).catch(() => {});
    });
    $('#opt-gambit').addEventListener('input', (e) => {
        state.settings.gambit = +e.target.value;
        $('#opt-gambit-val').textContent = `${e.target.value}%`;
        engine.setWeights(state.settings.gambit, state.settings.appetite).catch(() => {});
    });
    $('#opt-book').addEventListener('change', (e) => {
        state.settings.book = e.target.checked;
        engine.setBook(e.target.checked).catch(() => {});
    });
    $('#opt-comments').addEventListener('change', (e) => { state.settings.comments = e.target.checked; });
    $('#opt-comment-level').addEventListener('change', (e) => {
        state.settings.commentLevel = e.target.value;
        commentator.level = e.target.value;
    });
}

/* ------------------------------------------------------------------ */
/*  Старт                                                            */
/* ------------------------------------------------------------------ */

async function boot() {
    bindSettings();
    renderGambits();
    $('#gambit-filter').addEventListener('input', (e) => renderGambits(e.target.value));

    $('#chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#chat-input');
        const q = input.value.trim();
        if (!q) return;
        input.value = '';
        addMessage('user', escapeHtml(q));
        const answer = commentator.answerQuestion(state.pos, q);
        setTimeout(() => addMessage('engine', escapeHtml(answer)), 180);
    });

    $('#btn-new').addEventListener('click', newGame);
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-flip').addEventListener('click', () => {
        board.flipped = !board.flipped;
        updateBoard();
    });
    $('#btn-hint').addEventListener('click', () => hint().catch(() => {}));
    $('#btn-review').addEventListener('click', () => reviewPgn().catch((e) => addMessage('system', escapeHtml(String(e.message || e)))));
    $('#btn-review-sample').addEventListener('click', () => {
        $('#pgn-input').value = SAMPLE_PGN;
    });
    $('#btn-analyze').addEventListener('click', () => explainPosition().catch(() => {}));

    const status = $('#engine-status');
    try {
        await engine.init('gambitfish.wasm');
        status.textContent = 'WASM готов';
        status.className = 'pill ok';
        await engine.setWeights(state.settings.gambit, state.settings.appetite);
        await engine.setBook(true);
    } catch (err) {
        status.textContent = 'WASM ошибка';
        status.className = 'pill';
        addMessage('system', `Не удалось загрузить движок: ${escapeHtml(String(err.message || err))}`);
        console.error(err);
    }
    newGame();
}

boot();
