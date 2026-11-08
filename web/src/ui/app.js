/*
  GambitFish — контроллер интерфейса.
  Доска: cm-chessboard (SVG-фигуры), с запасным вариантом.
  GPL-3.0.
*/

import {
    Position, WHITE, BLACK, START_FEN, uciToMove, moveToSan, moveToUci,
    mFrom, mTo, mPromo, pieceType, pieceColor,
} from '../chess/chess.js';
import { createBoard } from './boardAdapter.js';
import { EngineClient } from '../engine/client.js';
import { Commentator, gambitLookup } from '../commentary/commentator.js';
import { analyzeMove } from '../commentary/features.js';
import { GAMBITS, GAMBIT_BY_ID } from '../data/gambits.js';
import { parsePgn } from '../pgn/pgn.js';
import { analyzeGame, describeGame, MARK } from '../analysis/gameAnalyzer.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const LEVELS = {
    club: { depth: 6, scale: 0.5 },
    master: { depth: 64, scale: 1 },
    grandmaster: { depth: 64, scale: 2 },
    max: { depth: 64, scale: 4 },
};

const state = {
    pos: new Position(START_FEN),
    history: [],
    playerSide: WHITE,
    thinking: false,
    gameOver: false,
    autoPlay: false,
    settings: {
        side: 'white',
        level: 'master',
        movetime: 1500,
        appetite: 120,
        gambit: 120,
        book: true,
        comments: true,
        commentLevel: 'normal',
    },
};

const engine = new EngineClient(new URL('./gambitfish.wasm', document.baseURI).href);
const commentator = new Commentator({ level: 'normal', side: WHITE, seed: 'gambitfish' });
let board = null;

/* адаптер под интерфейс analyze(fen, opts) для разбора партий */
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

/* ------------------------------------------------------------------ */
/*  утилиты                                                           */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function addMessage(kind, html) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${kind}`;
    const ava = document.createElement('div');
    ava.className = 'ava';
    ava.textContent = kind === 'user' ? '🙋' : kind === 'system' ? 'ⓘ' : '♞';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = html;
    wrap.append(ava, bubble);
    const log = $('#chat-log');
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 300) log.removeChild(log.firstChild);
    return bubble;
}

function sayComment(head, text) {
    if (!state.settings.comments) return;
    addMessage('engine', `<span class="san">${esc(head)}</span>${esc(text)}`);
}

function fmtScore(cp) {
    if (Math.abs(cp) > 30000 - 200) {
        const mateIn = Math.ceil((30000 - Math.abs(cp)) / 2) * Math.sign(cp);
        return `#${Math.abs(mateIn)}`;
    }
    return (cp / 100).toFixed(2);
}

function updateEval(cp) {
    $('#eval-num').textContent = fmtScore(cp);
    const clamped = Math.max(-900, Math.min(900, cp));
    const pct = 50 + (clamped / 900) * 48;
    const fill = $('#eval-fill');
    if (cp >= 0) {
        fill.style.marginLeft = '0%';
        fill.style.width = `${pct}%`;
        fill.style.background = 'linear-gradient(90deg,#f3ecdd,#ffffff)';
    } else {
        fill.style.marginLeft = `${pct}%`;
        fill.style.width = `${100 - pct}%`;
        fill.style.background = 'linear-gradient(90deg,#2a3242,#4c5870)';
    }
}

function setStatus(main, pv = '') {
    $('#status-main').textContent = main;
    $('#status-pv').textContent = pv;
}

/* ------------------------------------------------------------------ */
/*  отрисовка                                                         */
/* ------------------------------------------------------------------ */

function redraw(opts = {}) {
    const last = state.history[state.history.length - 1];
    const lastMove = last ? uciToMove(new Position(last.fenBefore), last.uci) : null;
    board.setPosition(state.pos, {
        legal: state.pos.legalMoves(),
        lastMove,
        flipped: opts.flipped !== undefined ? opts.flipped : state.playerSide === BLACK,
    });
    /* кто ходит */
    $('#player-top').classList.toggle('active', state.pos.side !== state.playerSide);
    $('#player-bottom').classList.toggle('active', state.pos.side === state.playerSide);
    const whiteBottom = state.playerSide === WHITE;
    $('#player-top .who .sub').textContent = whiteBottom ? 'чёрные' : 'белые';
    $('#player-bottom .who .sub').textContent = whiteBottom ? 'белые' : 'чёрные';
}

function renderMoves() {
    const box = $('#move-list');
    box.innerHTML = '';
    let i = 0;
    let num = 1;
    while (i < state.history.length) {
        const n = document.createElement('div');
        n.className = 'num';
        n.textContent = `${num}.`;
        box.appendChild(n);
        for (let k = 0; k < 2 && i < state.history.length; k++, i++) {
            const e = state.history[i];
            const btn = document.createElement('button');
            btn.className = 'mv' + (e.analysis && e.analysis.isSacrifice ? ' sac' : '');
            btn.textContent = e.san;
            btn.title = e.analysis ? `оценка ${fmtScore(e.evalCp || 0)}` : e.san;
            btn.addEventListener('click', () => previewPly(i));
            if (i === state.history.length - 1) btn.classList.add('current');
            box.appendChild(btn);
        }
        num++;
    }
    box.scrollTop = box.scrollHeight;
}

let previewIndex = -1;
function previewPly(i) {
    const e = state.history[i];
    if (!e) return;
    previewIndex = i;
    const pos = new Position(e.fenAfter);
    const last = uciToMove(new Position(e.fenBefore), e.uci);
    board.setPosition(pos, { legal: [], lastMove: last, flipped: state.playerSide === BLACK });
    $$('#move-list .mv').forEach((b, idx) => b.classList.toggle('current', idx === i));
}

/* ------------------------------------------------------------------ */
/*  ход                                                               */
/* ------------------------------------------------------------------ */

function onSquare(sq) {
    if (!board || !state.pos) return;
    if (state.gameOver || state.thinking || state.autoPlay) return;
    if (state.pos.side !== state.playerSide) return;
    if (previewIndex >= 0) { previewIndex = -1; redraw(); }

    const pos = state.pos;
    const legal = pos.legalMoves();
    const pc = pos.board[sq];

    if (board.selected >= 0 && sq !== board.selected) {
        const cands = legal.filter((m) => mFrom(m) === board.selected && mTo(m) === sq);
        if (cands.length === 1) {
            board.setSelection(-1);
            playMove(cands[0]);
            return;
        }
        if (cands.length > 1) {
            board.setSelection(-1);
            choosePromotion(cands, (m) => playMove(m));
            return;
        }
    }
    if (pc && pieceColor(pc) === pos.side && legal.some((m) => mFrom(m) === sq)) {
        board.setSelection(board.selected === sq ? -1 : sq);
    } else {
        board.setSelection(-1);
    }
}

function choosePromotion(moves, cb) {
    const overlay = $('#board-overlay');
    const colors = { 5: '♕', 4: '♖', 3: '♗', 2: '♘' };
    overlay.classList.remove('hidden');
    overlay.innerHTML = '<div class="promo"><p>Выберите фигуру</p><div class="promo-row"></div></div>';
    const row = overlay.querySelector('.promo-row');
    for (const t of [5, 4, 3, 2]) {
        const m = moves.find((x) => mPromo(x) === t);
        if (!m) continue;
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = colors[t];
        b.style.fontSize = '1.6rem';
        b.addEventListener('click', () => {
            overlay.classList.add('hidden');
            overlay.innerHTML = '';
            cb(m);
        });
        row.appendChild(b);
    }
}

function playMove(move) {
    const pos = state.pos;
    const fenBefore = pos.fen();
    const san = moveToSan(pos, move);
    const uci = moveToUci(move);
    let analysis = null;
    try { analysis = analyzeMove(pos, move); } catch (e) { analysis = null; }
    pos.makeMove(move, { silent: true });
    state.history.push({ uci, san, fenBefore, fenAfter: pos.fen(), analysis, evalCp: 0 });

    if (state.settings.comments && analysis) {
        const cm = commentator.comment(new Position(fenBefore), move);
        sayComment(cm.head, cm.text);
    }
    renderMoves();
    redraw();
    checkEnd();
    if (!state.gameOver) scheduleEngine();
}

function checkEnd() {
    const pos = state.pos;
    let text = '';
    if (pos.isCheckmate()) text = `Мат! Победа ${pos.side === WHITE ? 'чёрных' : 'белых'}.`;
    else if (pos.isStalemate()) text = 'Пат — ничья.';
    else if (pos.isInsufficientMaterial()) text = 'Ничья: недостаточно материала.';
    else if (pos.halfmove >= 100) text = 'Ничья по правилу 50 ходов.';
    if (!text) return;
    state.gameOver = true;
    state.autoPlay = false;
    const overlay = $('#board-overlay');
    overlay.classList.remove('hidden');
    overlay.innerHTML = `<div><h3 style="margin:.2rem 0 .5rem">${esc(text)}</h3>
        <p class="muted" style="margin:0 0 .7rem">${esc(commentator.ending(pos, state.history))}</p>
        <button class="btn primary" id="overlay-new">Новая партия</button></div>`;
    overlay.querySelector('#overlay-new').addEventListener('click', () => newGame());
    addMessage('system', esc(text));
    setStatus(text);
}

/* ------------------------------------------------------------------ */
/*  движок                                                            */
/* ------------------------------------------------------------------ */

function scheduleEngine() {
    if (state.gameOver) return;
    const engineToMove = state.autoPlay || state.pos.side !== state.playerSide;
    if (!engineToMove) return;
    engineTurn();
}

async function engineTurn() {
    if (state.thinking || state.gameOver) return;
    state.thinking = true;
    const level = LEVELS[state.settings.level] || LEVELS.master;
    const movetime = Math.round(state.settings.movetime * level.scale);
    const chip = $('#chip-engine');
    chip.textContent = 'думает…';
    chip.className = 'chip loading';
    setStatus('Движок думает…');
    try {
        await engine.setFen(state.pos.fen());
        const res = await engine.search({ movetime, depth: level.depth, gambitMode: 1, contempt: 0 });
        if (!res || !res.pv) throw new Error('пустой ответ движка');
        const uci = res.pv.split(' ')[0];
        const move = uciToMove(state.pos, uci);
        if (!move) throw new Error(`движок предложил нелегальный ход ${uci}`);
        const side = state.pos.side;

        /* фиксируем оценку для хода */
        const fenBefore = state.pos.fen();
        const analysis = analyzeMove(state.pos, move);
        const san = moveToSan(state.pos, move);
        state.pos.makeMove(move, { silent: true });
        state.history.push({
            uci, san, fenBefore, fenAfter: state.pos.fen(), analysis, evalCp: res.score,
            byEngine: true, book: !!res.book,
        });
        if (state.settings.comments && analysis) {
            const cm = commentator.comment(new Position(fenBefore), move);
            const bookTag = res.book ? '<span class="tag">книга</span>' : '';
            addMessage('engine', `<span class="san">${esc(cm.head)}</span>${esc(cm.text)}${bookTag}`);
        }
        renderMoves();
        redraw();

        const sideSign = side === WHITE ? 1 : -1;
        updateEval(res.score * sideSign);
        const nps = res.nodes && res.time ? `${(res.nodes / res.time / 1000).toFixed(2)} Mузл/с` : '—';
        $('#chip-speed').textContent = nps;
        $('#engine-info').textContent = [
            `ход: ${san}${res.book ? ' (книга)' : ''}`,
            `глубина ${res.depth}${res.seldepth ? `/${res.seldepth}` : ''}`,
            `оценка ${fmtScore(res.score)}`,
            `узлов ${res.nodes}`,
            `${res.time} мс`,
            res.pv ? `pv: ${res.pv}` : '',
        ].filter(Boolean).join(' · ');
        setStatus(`Ход движка: ${san}`, res.pv ? res.pv.split(' ').slice(0, 6).join(' ') : '');
        checkEnd();
    } catch (err) {
        addMessage('system', `Ошибка движка: ${esc(err.message || err)}`);
        setStatus('Ошибка движка');
        chip.textContent = 'ошибка';
        chip.className = 'chip err';
    } finally {
        state.thinking = false;
        if (!state.gameOver) {
            chip.textContent = 'WASM готов';
            chip.className = 'chip ok';
        }
    }
    /* автоигра продолжается */
    if (state.autoPlay && !state.gameOver) setTimeout(() => engineTurn(), 250);
}

/* ------------------------------------------------------------------ */
/*  команды интерфейса                                                */
/* ------------------------------------------------------------------ */

function newGame() {
    state.pos = new Position(START_FEN);
    state.history = [];
    state.gameOver = false;
    state.autoPlay = false;
    previewIndex = -1;
    commentator.seenGambits.clear();
    $('#board-overlay').classList.add('hidden');
    $('#board-overlay').innerHTML = '';
    $('#chat-log').innerHTML = '';
    $('#move-list').innerHTML = '';
    $('#engine-info').textContent = '';
    updateEval(0);
    setStatus('Готов');

    let side = state.settings.side;
    if (side === 'random') side = Math.random() < 0.5 ? 'white' : 'black';
    state.playerSide = side === 'white' ? WHITE : BLACK;
    commentator.setSide(state.playerSide);
    redraw();
    addMessage('system', esc(`Новая партия. Вы играете ${side === 'white' ? 'белыми' : 'чёрными'}.`));
    addMessage('engine', esc(state.playerSide === BLACK
        ? 'Я начинаю. Гамбит — моя стихия: держитесь.'
        : 'Я готов. Играю гамбиты и буду объяснять каждый ход.'));
    if (state.pos.side !== state.playerSide) engineTurn();
}

function undo() {
    if (state.thinking) return;
    let removed = 0;
    while (state.history.length && removed < 2) {
        const last = state.history.pop();
        state.pos = new Position(last.fenBefore);
        removed++;
        if (state.pos.side === state.playerSide) break;
    }
    state.gameOver = false;
    state.autoPlay = false;
    $('#board-overlay').classList.add('hidden');
    previewIndex = -1;
    renderMoves();
    redraw();
    setStatus('Ход отменён');
}

async function hint() {
    if (state.thinking) return;
    setStatus('Ищу подсказку…');
    await engine.setFen(state.pos.fen());
    const res = await engine.search({ movetime: 1200, depth: 64, gambitMode: 1, contempt: 0 });
    const pv = (res.pv || '').split(' ').filter(Boolean);
    const m = pv[0] ? uciToMove(state.pos, pv[0]) : 0;
    if (!m) return;
    board.hintSquares([mFrom(m), mTo(m)]);
    const sign = state.pos.side === WHITE ? 1 : -1;
    updateEval(res.score * sign);
    setStatus(`Подсказка: ${moveToSan(state.pos, m)} · ${fmtScore(res.score)} · глубина ${res.depth}`, pv.slice(0, 6).join(' '));
}

async function explain() {
    if (state.thinking) return;
    setStatus('Разбираю позицию…');
    await engine.setFen(state.pos.fen());
    const res = await engine.search({ movetime: 1500, depth: 64, gambitMode: 1, contempt: 0 });
    const gambit = gambitLookup(state.pos.fen());
    const mat = analyzeMaterial(state.pos);
    const lines = [
        `Оценка ${fmtScore(res.score)} на глубине ${res.depth}.`,
        `Материал: ${mat > 0 ? '+' : ''}${(mat / 100).toFixed(2)} в пользу ${mat >= 0 ? 'белых' : 'чёрных'}.`,
        res.pv ? `Главная линия: ${res.pv.split(' ').slice(0, 6).join(' ')}.` : '',
        gambit ? `Похоже на ${gambit.name}. ${gambit.ideas[0]}` : '',
    ].filter(Boolean).join(' ');
    addMessage('engine', esc(lines));
    setStatus('Разбор готов', res.pv || '');
}

function analyzeMaterial(pos) {
    const V = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 0 };
    let sum = 0;
    for (let sq = 0; sq < 64; sq++) {
        const p = pos.board[sq];
        if (!p) continue;
        sum += (pieceColor(p) === WHITE ? 1 : -1) * (V[pieceType(p)] || 0);
    }
    return sum;
}

/* ------------------------------------------------------------------ */
/*  база гамбитов                                                     */
/* ------------------------------------------------------------------ */

function sansOfLine(line) {
    const pos = new Position(START_FEN);
    const out = [];
    for (const u of line) {
        const m = uciToMove(pos, u);
        if (!m) break;
        out.push(moveToSan(pos, m));
        pos.makeMove(m, { silent: true });
    }
    return out;
}

function renderGambits(filter = '') {
    const box = $('#gambit-list');
    const q = filter.trim().toLowerCase();
    box.innerHTML = '';
    const list = GAMBITS.filter((g) => !q
        || g.name.toLowerCase().includes(q)
        || g.nameEn.toLowerCase().includes(q)
        || g.eco.toLowerCase().includes(q)
        || g.tags.some((t) => t.toLowerCase().includes(q)));
    for (const g of list) {
        const card = document.createElement('div');
        card.className = 'gcard';
        card.dataset.id = g.id;
        card.innerHTML = `<h4>${esc(g.name)}</h4>
            <p>${esc(g.nameEn)} · ${esc(g.eco)} · ${g.side === 'white' ? 'за белых' : 'за чёрных'}</p>
            <div>${g.tags.slice(0, 3).map((t) => `<span class="gtag">${esc(t)}</span>`).join('')}</div>`;
        card.addEventListener('click', () => showGambit(g.id));
        box.appendChild(card);
    }
    if (!list.length) box.innerHTML = '<p class="muted">Ничего не найдено.</p>';
}

function showGambit(id) {
    const g = GAMBIT_BY_ID[id];
    if (!g) return;
    $$('#gambit-list .gcard').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
    const detail = $('#gambit-detail');
    const variations = (g.lines || []).slice(0, 3).map((line) => sansOfLine(line).join(' '));
    detail.innerHTML = `
        <h3>${esc(g.name)}</h3>
        <div class="meta">${esc(g.nameEn)} · ${esc(g.eco)} · минус материала: ${(g.material / 100).toFixed(0)}</div>
        <h5>идеи</h5>
        <ul>${g.ideas.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <h5>планы</h5>
        <ul>${g.plans.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <h5>как защищаться</h5>
        <ul>${g.defense.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        ${g.traps && g.traps.length ? `<h5>ловушки</h5><ul>${g.traps.map((t) => `<li>${esc(t.note)}</li>`).join('')}</ul>` : ''}
        <h5>ключевые поля</h5>
        <div>${g.keySquares.map((s) => `<span class="gtag">${esc(s)}</span>`).join('')}</div>
        <h5>варианты</h5>
        ${variations.map((v) => `<div class="variation">${esc(v)}</div>`).join('')}
        <button class="btn primary" id="play-gambit" style="margin-top:.6rem">Играть этот гамбит</button>`;
    detail.querySelector('#play-gambit').addEventListener('click', () => startGambit(g.id));
    addMessage('engine', esc(commentator.gambitBlurb(g.id)));
}

function startGambit(id) {
    const g = GAMBIT_BY_ID[id];
    if (!g) return;
    newGame();
    const sacrificing = g.side === 'white' ? WHITE : BLACK;
    state.playerSide = sacrificing;
    commentator.setSide(sacrificing);
    redraw();
    loadTab('chat');
    addMessage('system', esc(`Гамбит: ${g.name}. Вы за ${sacrificing === WHITE ? 'белых' : 'чёрных'}.`));
    if (state.pos.side !== state.playerSide) engineTurn();
}

/* ------------------------------------------------------------------ */
/*  разбор PGN                                                        */
/* ------------------------------------------------------------------ */

const SAMPLE_PGN = `[Event "Гамбит Муцио — пример"]
[White "Атака"]
[Black "Защита"]
[Result "1-0"]

1. e4 e5 2. f4 exf4 3. Nf3 g5 4. Bc4 g4 5. O-O gxf3 6. Qxf3 Qf6
7. e5 Qxe5 8. d3 Bh6 9. Nc3 Ne7 10. Nd5 Kd8 11. Bxf4 Qd4+ 12. Kh1 1-0`;

async function reviewPgn() {
    const text = $('#pgn-input').value.trim();
    if (!text) { addMessage('system', 'Вставьте PGN в поле разбора.'); return; }
    const parsed = parsePgn(text);
    if (!parsed.moves.length) { addMessage('system', 'В PGN не нашлось ходов.'); return; }
    const movetime = +(($('#review-movetime') || {}).value || 300);
    const progress = $('#review-progress');
    const fill = $('#review-progress-fill');
    progress.classList.remove('hidden');
    $('#review-report').textContent = 'Считаю партию…';
    $('#review-moves').innerHTML = '';
    try {
        const res = await analyzeGame(parsed.moves, analyzeAdapter, {
            movetime,
            useBook: false,
            onProgress: (i, n) => { fill.style.width = `${Math.round((i / n) * 100)}%`; },
        });
        $('#review-report').textContent = `${describeGame(res, commentator)}

${parsed.headers.White || ''} ${parsed.headers.White || parsed.headers.Black ? '— ' + (parsed.headers.Black || '') : ''} ${parsed.result}`.trim();
        const box = $('#review-moves');
        box.innerHTML = '';
        for (const m of res.analysed) {
            const el = document.createElement('span');
            const mark = MARK[m.mark] || MARK.good;
            el.className = mark.cls;
            el.textContent = `${m.san}${mark.symbol}`;
            el.title = `${mark.label} · потеря ${(m.lossCp / 100).toFixed(2)} · оценка ${fmtScore(m.evalAfter)}`
                + (m.sacrifice ? ' · жертва' : '') + (m.bestSan || m.bestWas ? ` · лучше ${m.bestSan || m.bestWas}` : '');
            el.addEventListener('click', () => {
                const fenBefore = new Position(m.fenBefore);
                const move = uciToMove(fenBefore, m.uci);
                board.setPosition(new Position(m.fenAfter), { legal: [], lastMove: move, flipped: state.playerSide === BLACK });
                if (move) {
                    const cm = commentator.comment(fenBefore, move);
                    addMessage('engine', `<span class="san">${esc(cm.head)}</span>${esc(cm.text)}`);
                }
            });
            box.appendChild(el);
        }
        addMessage('engine', esc(`Разбор: ${res.analysed.length} полуходов, точность ${res.summary.white.accuracy}% / ${res.summary.black.accuracy}%, индекс авантюрности ${res.summary.adventureIndex}/10.`));
    } catch (err) {
        $('#review-report').textContent = `Ошибка разбора: ${err.message || err}`;
    } finally {
        progress.classList.add('hidden');
    }
}

/* ------------------------------------------------------------------ */
/*  вкладки, настройки, старт                                         */
/* ------------------------------------------------------------------ */

function loadTab(name) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

function bindUi() {
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => loadTab(b.dataset.tab)));

    $('#btn-new').addEventListener('click', newGame);
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-flip').addEventListener('click', () => {
        board.flipped = !board.flipped;
        redraw({ flipped: board.flipped });
    });
    $('#btn-hint').addEventListener('click', () => hint().catch((e) => setStatus(`Ошибка: ${e.message}`)));
    $('#btn-eval').addEventListener('click', () => explain().catch((e) => setStatus(`Ошибка: ${e.message}`)));
    $('#btn-auto').addEventListener('click', () => {
        state.autoPlay = !state.autoPlay;
        $('#btn-auto').classList.toggle('primary', state.autoPlay);
        if (state.autoPlay) engineTurn();
    });

    $('#chat-form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const input = $('#chat-input');
        const q = input.value.trim();
        if (!q) return;
        input.value = '';
        addMessage('user', esc(q));
        const answer = commentator.answerQuestion(state.pos, q);
        setTimeout(() => addMessage('engine', esc(answer)), 160);
    });

    $$('.hintchip').forEach((b) => b.addEventListener('click', () => {
        const q = b.dataset.q;
        addMessage('user', esc(q));
        setTimeout(() => addMessage('engine', esc(commentator.answerQuestion(state.pos, q))), 140);
    }));

    $('#gambit-filter').addEventListener('input', (e) => renderGambits(e.target.value));
    $('#btn-review').addEventListener('click', () => reviewPgn());
    $('#btn-review-sample').addEventListener('click', () => {
        $('#pgn-input').value = SAMPLE_PGN;
        loadTab('review');
    });

    $('#opt-side').addEventListener('change', (e) => { state.settings.side = e.target.value; newGame(); });
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

let booted = false;
async function boot() {
    if (booted) return;
    booted = true;
    bindUi();
    renderGambits();

    board = await createBoard($('#board'), {
        onSquare,
        assetsUrl: new URL('./assets/', document.baseURI).href,
    });
    /* подпись в подвале: автономную сборку подписываем отдельно */
    const boardLabel = board.kind === 'cm'
        ? 'доска: cm-chessboard + фигуры Cburnett'
        : 'доска: встроенная (библиотека недоступна)';
    $('#footer-mode').textContent = (typeof window !== 'undefined' && window.__GF_STANDALONE__)
        ? `автономный файл · ${boardLabel}`
        : boardLabel;

    const chip = $('#chip-engine');
    try {
        await engine.init(new URL('./gambitfish.wasm', document.baseURI).href);
        chip.textContent = 'WASM готов';
        chip.className = 'chip ok';
        await engine.setWeights(state.settings.gambit, state.settings.appetite);
        await engine.setBook(true);
        $('#chip-book').textContent = `книга: ${GAMBITS.length} гамбита`;
    } catch (err) {
        chip.textContent = 'WASM не загрузился';
        chip.className = 'chip err';
        addMessage('system', `Не удалось загрузить движок: ${esc(err.message || err)}. Играть можно, но без комментариев движка.`);
    }
    newGame();
}

window.addEventListener('DOMContentLoaded', () => { boot(); });
if (document.readyState !== 'loading') boot();
