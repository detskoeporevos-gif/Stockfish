/*
  GambitFish — адаптер доски.

  Основной путь: cm-chessboard (MIT, ES-модуль, SVG-фигуры staunty из
  ./assets/pieces/staunty.svg). Запасной путь: лёгкая доска на div/глифах,
  если библиотека недоступна.

  Интерфейс: setPosition(pos, {legal, lastMove, flipped}), onSquare(cb),
  setSelection(sq), hintSquares([a, b]), setCheck(sq).
  GPL-3.0.
*/

import {
    WHITE, pieceType, pieceColor, mFrom, mTo, mFlags, FLAG_CAPTURE,
    squareName, squareIndex, START_FEN,
} from '../chess/chess.js';

const GLYPHS = {
    1: '\u265F', 2: '\u265E', 3: '\u265D', 4: '\u265C', 5: '\u265B', 6: '\u265A',
    9: '\u265F', 10: '\u265E', 11: '\u265D', 12: '\u265C', 13: '\u265B', 14: '\u265A',
};

export function pieceCode(pc) {
    if (!pc) return '';
    return (pieceColor(pc) === WHITE ? 'w' : 'b') + ' pnbrqk'[pieceType(pc)];
}

/* ------------------------------------------------------------------ */
/*  cm-chessboard                                                     */
/* ------------------------------------------------------------------ */

/* свои типы маркеров: класс задаёт цвет в board-theme.css,
   срез (slice) берётся из markers.svg библиотеки */
const GF_MARKER = {
    lastFrom: { class: 'gf-last-a', slice: 'markerSquare' },
    lastTo: { class: 'gf-last-b', slice: 'markerSquare' },
    selected: { class: 'gf-sel', slice: 'markerCircle' },
    check: { class: 'gf-check', slice: 'markerSquare' },
    move: { class: 'gf-dot', slice: 'markerDot' },
    capture: { class: 'gf-cap', slice: 'markerCircle' },
};

export class CmBoard {
    constructor(Chessboard, host, opts = {}) {
        this.kind = 'cm';
        this.host = host;
        this.onSquare = opts.onSquare || (() => {});
        this.flipped = false;
        this.selected = -1;
        this.hint = null;
        this.Chessboard = Chessboard;
        this.board = new Chessboard(host, {
            position: START_FEN,
            orientation: 'white',
            responsive: true,
            assetsUrl: opts.assetsUrl || './assets/',
            style: {
                cssClass: 'gf-cm',
                borderType: 'none',
                showCoordinates: true,
                pieces: {
                    type: 'svgSprite',
                    file: 'pieces/standard.svg',
                    tileSize: 40,
                },
                animationDuration: opts.animation === false ? 0 : 160,
            },
            extensions: [
                {
                    class: Chessboard.__Arrows,
                    props: { slice: 'arrowDefault' },
                },
                {
                    class: Chessboard.__Markers,
                    props: { autoMarkers: null },
                },
            ],
        });
        /* клик по клетке: библиотека рисует <rect data-square="e4"> */
        host.addEventListener('click', (ev) => {
            const el = ev.target.closest && ev.target.closest('[data-square]');
            if (!el) return;
            const sq = el.getAttribute('data-square');
            if (sq) this.onSquare(squareIndex(sq));
        });
        this.boardEl = host;
    }

    static async create(host, opts) {
        const [mod, arrows, markers] = await Promise.all([
            import('../../vendor/cm-chessboard/Chessboard.js'),
            import('../../vendor/cm-chessboard/extensions/arrows/Arrows.js'),
            import('../../vendor/cm-chessboard/extensions/markers/Markers.js'),
        ]);
        const Ctor = mod.Chessboard;
        Ctor.__Arrows = arrows.Arrows;
        Ctor.__Markers = markers.Markers;
        return new CmBoard(Ctor, host, opts);
    }

    /* правление маркерами идёт через сам объект board (библиотека
       приделывает addMarker/removeMarkers/addArrow/removeArrows) */
    clearMarkers() {
        for (const t of Object.values(GF_MARKER)) {
            try { this.board.removeMarkers(t); } catch (e) { /* нет расширения */ }
        }
        try { this.board.removeArrows(); } catch (e) { /* нет расширения */ }
    }

    setPosition(pos, opts = {}) {
        this.pos = pos;
        if (opts.flipped !== undefined) this.flipped = opts.flipped;
        this.legal = opts.legal || pos.legalMoves();
        this.lastMove = opts.lastMove || null;
        this.selected = -1;
        const orientation = this.flipped ? 'black' : 'white';
        const turning = this.board.getOrientation() !== orientation && !this.turning;
        /* setOrientation асинхронный и не допускает второй вызов в очереди,
           поэтому переворот не ждём: маркеры рисуем после смены позиции */
        if (turning) {
            this.turning = true;
            this.board.setOrientation(orientation, false)
                .catch(() => {})
                .finally(() => { this.turning = false; });
        }
        this.board.setPosition(pos.fen(), false);
        this.renderMarkers();
    }

    renderMarkers() {
        const b = this.board;
        if (!b || !this.pos || !b.addMarker) return;
        this.clearMarkers();
        if (this.pos.inCheck()) {
            const k = this.pos.kingSquare(this.pos.side);
            if (k >= 0) b.addMarker(GF_MARKER.check, squareName(k));
        }
        if (this.lastMove) {
            b.addMarker(GF_MARKER.lastFrom, squareName(mFrom(this.lastMove)));
            b.addMarker(GF_MARKER.lastTo, squareName(mTo(this.lastMove)));
        }
        if (this.selected >= 0) {
            b.addMarker(GF_MARKER.selected, squareName(this.selected));
            for (const m of this.legal) {
                if (mFrom(m) !== this.selected) continue;
                const capture = !!(mFlags(m) & FLAG_CAPTURE) || !!this.pos.board[mTo(m)];
                b.addMarker(capture ? GF_MARKER.capture : GF_MARKER.move, squareName(mTo(m)));
            }
        }
        if (this.hint) {
            try {
                b.addArrow({ class: 'arrow-info' }, squareName(this.hint[0]), squareName(this.hint[1]));
            } catch (e) { /* ignore */ }
        }
    }

    setSelection(sq) {
        this.selected = sq === null || sq === undefined ? -1 : sq;
        this.renderMarkers();
    }

    hintSquares(squares) {
        this.hint = squares && squares.length >= 2 ? squares : null;
        this.renderMarkers();
    }

    highlightSquares(squares) { this.hintSquares(squares); }
}

/* ------------------------------------------------------------------ */
/*  запасная доска                                                    */
/* ------------------------------------------------------------------ */

export class SimpleBoard {
    constructor(host, opts = {}) {
        this.kind = 'simple';
        this.host = host;
        this.onSquare = opts.onSquare || (() => {});
        this.flipped = false;
        this.selected = -1;
        this.legal = [];
        this.build();
    }

    build() {
        this.host.classList.add('gf-simple-board');
        this.host.innerHTML = '';
        this.cells = [];
        for (let order = 0; order < 64; order++) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'gf-simple-square';
            el.addEventListener('click', () => {
                if (el.dataset.sq !== undefined) this.onSquare(Number(el.dataset.sq));
            });
            this.host.appendChild(el);
            this.cells.push(el);
        }
    }

    static async create(host, opts) { return new SimpleBoard(host, opts); }

    setPosition(pos, opts = {}) {
        this.pos = pos;
        if (opts.flipped !== undefined) this.flipped = opts.flipped;
        this.legal = opts.legal || pos.legalMoves();
        this.lastMove = opts.lastMove || null;
        this.selected = -1;
        this.render();
    }

    render() {
        const pos = this.pos;
        const checkSq = pos.inCheck() ? pos.kingSquare(pos.side) : -1;
        const targets = new Set();
        for (const m of this.legal) if (mFrom(m) === this.selected) targets.add(mTo(m));
        for (let order = 0; order < 64; order++) {
            const row = this.flipped ? order >> 3 : 7 - (order >> 3);
            const col = this.flipped ? 7 - (order & 7) : order & 7;
            const sq = row * 8 + col;
            const el = this.cells[order];
            el.dataset.sq = String(sq);
            el.className = 'gf-simple-square ' + (((sq >> 3) + (sq & 7)) & 1 ? 'light' : 'dark');
            if (this.lastMove && (mFrom(this.lastMove) === sq || mTo(this.lastMove) === sq)) el.classList.add('last');
            if (this.selected === sq) el.classList.add('selected');
            if (sq === checkSq) el.classList.add('check');
            if (targets.has(sq)) el.classList.add('target');
            if (this.hint && this.hint.includes(sq)) el.classList.add('hint');
            const pc = pos.board[sq];
            el.innerHTML = pc
                ? '<span class="gf-simple-piece ' + (pieceColor(pc) === WHITE ? 'white' : 'black') + '">' + GLYPHS[pc] + '</span>'
                : '';
            if (row === 7) el.insertAdjacentHTML('beforeend', '<span class="gf-simple-file">' + 'abcdefgh'[sq & 7] + '</span>');
            if (col === 0) el.insertAdjacentHTML('beforeend', '<span class="gf-simple-rank">' + ((sq >> 3) + 1) + '</span>');
        }
    }

    setSelection(sq) {
        this.selected = sq === null || sq === undefined ? -1 : sq;
        this.render();
    }

    hintSquares(squares) {
        this.hint = squares || null;
        this.render();
    }
}

/* фабрика: пробуем cm-chessboard, при ошибке — простая доска */
export async function createBoard(host, opts = {}) {
    if (!host) throw new Error('нет контейнера доски');
    if (opts.preferSimple) return SimpleBoard.create(host, opts);
    try {
        return await CmBoard.create(host, opts);
    } catch (err) {
        console.warn('cm-chessboard недоступен, использую простую доску:', err && err.message);
        host.innerHTML = '';
        return SimpleBoard.create(host, opts);
    }
}
