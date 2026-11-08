/*
  GambitFish — отрисовка доски и взаимодействие мышью/пальцем.
  GPL-3.0.
*/

import { WHITE, squareName, pieceType, pieceColor, mFrom, mTo, mFlags, FLAG_CAPTURE } from '../chess/chess.js';

const GLYPHS = {
    1: '\u265F', 2: '\u265E', 3: '\u265D', 4: '\u265C', 5: '\u265B', 6: '\u265A',
    9: '\u265F', 10: '\u265E', 11: '\u265D', 12: '\u265C', 13: '\u265B', 14: '\u265A',
};

export class BoardView {
    constructor(root, opts = {}) {
        this.root = root;
        this.flipped = false;
        this.onMove = opts.onMove || (() => {});
        this.selected = -1;
        this.legal = [];
        this.lastMove = null;
        this.checkSquare = -1;
        this.highlight = [];
        this.build();
    }

    build() {
        this.root.classList.add('gf-board');
        this.root.innerHTML = '';
        this.squares = [];
        for (let i = 0; i < 64; i++) {
            const sq = document.createElement('button');
            sq.type = 'button';
            sq.className = 'gf-square';
            sq.dataset.index = i;
            /* клик передаёт НОМЕР поля (он обновляется в render), а не порядок в разметке */
            sq.addEventListener('click', () => this.handleClick(Number(sq.dataset.sq)));
            this.root.appendChild(sq);
            this.squares.push(sq);
        }
        /* координаты */
        this.coords = document.createElement('div');
        this.coords.className = 'gf-coords';
        this.root.appendChild(this.coords);
    }

    /* номер поля -> элемент */
    elementFor(sq) { return this.squareEl(sq); }

    /* index на доске (0..63, a1=0) -> элемент */
    squareEl(sq) {
        const row = this.flipped ? 7 - (sq >> 3) : (sq >> 3);
        const col = this.flipped ? 7 - (sq & 7) : (sq & 7);
        const order = (7 - row) * 8 + col;
        return this.squares[order];
    }

    setPosition(pos, opts = {}) {
        this.pos = pos;
        this.flipped = opts.flipped !== undefined ? opts.flipped : this.flipped;
        this.legal = opts.legal || pos.legalMoves();
        this.lastMove = opts.lastMove || null;
        this.selected = opts.selected !== undefined ? opts.selected : this.selected;
        this.render();
    }

    render() {
        const pos = this.pos;
        if (!pos) return;
        const checkSq = pos.inCheck() ? pos.kingSquare(pos.side) : -1;
        const targets = new Set();
        if (this.selected >= 0) {
            for (const m of this.legal) if (mFrom(m) === this.selected) targets.add(mTo(m));
        }
        for (let order = 0; order < 64; order++) {
            const row = 7 - Math.floor(order / 8);
            const col = order % 8;
            const sq = this.flipped
                ? (row ^ 7) * 8 + (col ^ 7)
                : row * 8 + col;
            const el = this.squares[order];
            const pc = pos.board[sq];
            const light = ((sq >> 3) + (sq & 7)) & 1;
            el.className = `gf-square ${light ? 'light' : 'dark'}`;
            el.dataset.sq = String(sq);
            el.innerHTML = '';
            if (this.lastMove && (mFrom(this.lastMove) === sq || mTo(this.lastMove) === sq)) el.classList.add('last');
            if (this.selected === sq) el.classList.add('selected');
            if (sq === checkSq) el.classList.add('check');
            if (this.highlight.includes(sq)) el.classList.add('hint');
            if (targets.has(sq)) el.classList.add(pc ? 'target-capture' : 'target');
            if (pc) {
                const span = document.createElement('span');
                span.className = `gf-piece ${pieceColor(pc) === WHITE ? 'white' : 'black'}`;
                span.textContent = GLYPHS[pc];
                el.appendChild(span);
            }
            if (col === (this.flipped ? 7 : 0) && row === 0) {
                const lbl = document.createElement('span');
                lbl.className = 'gf-rank';
                lbl.textContent = String((sq >> 3) + 1);
                el.appendChild(lbl);
            }
            if (row === 7) {
                const lbl = document.createElement('span');
                lbl.className = 'gf-file';
                lbl.textContent = 'abcdefgh'[sq & 7];
                el.appendChild(lbl);
            }
        }
    }

    setSelection(sq) {
        this.selected = sq;
        this.render();
    }

    handleClick(sq) {
        if (!this.pos) return;
        const pc = this.pos.board[sq];
        if (this.selected >= 0 && sq !== this.selected) {
            const moves = this.legal.filter((m) => mFrom(m) === this.selected && mTo(m) === sq);
            if (moves.length) {
                /* выбор превращения */
                const promo = moves.filter((m) => (mFlags(m) & 16));
                if (promo.length > 1) {
                    this.onMove({ from: this.selected, to: sq, moves: promo });
                    return;
                }
                this.onMove({ from: this.selected, to: sq, moves });
                return;
            }
        }
        if (pc && pieceColor(pc) === this.pos.side && this.legal.some((m) => mFrom(m) === sq)) {
            this.setSelection(this.selected === sq ? -1 : sq);
        } else {
            this.setSelection(-1);
        }
    }

    hintSquares(squares) {
        this.highlight = squares.map((s) => (typeof s === 'string' ? 'abcdefgh'.indexOf(s[0]) + (+s[1] - 1) * 8 : s));
        this.render();
    }
}
