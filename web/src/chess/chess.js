/*
  GambitFish — JavaScript chess rules (mirror of the C engine core).
  Used by the UI for notation, navigation and by the commentator for
  feature extraction.  GPL-3.0.
*/

export const WHITE = 0;
export const BLACK = 1;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const EMPTY = 0;

export const FLAG_CAPTURE = 1, FLAG_EP = 2, FLAG_CASTLE = 4, FLAG_DOUBLE = 8, FLAG_PROMOTION = 16;

export const FILES = 'abcdefgh';
export const PIECE_CHARS = '.PNBRQK..pnbrqk.';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const isWhitePiece = (p) => p >= 1 && p <= 6;
export const isBlackPiece = (p) => p >= 9 && p <= 14;
export const pieceType = (p) => p & 7;
export const pieceColor = (p) => (p & 8 ? BLACK : WHITE);
export const makePiece = (c, t) => (c === WHITE ? t : t | 8);
export const pieceChar = (p) => (p ? PIECE_CHARS[p] : '.');
export const squareName = (sq) => FILES[sq & 7] + ((sq >> 3) + 1);
export const squareIndex = (name) => (name.charCodeAt(0) - 97) + (name.charCodeAt(1) - 49) * 8;

/* ------------------------------------------------------------------ */
/* pre-computed attack tables                                          */
/* ------------------------------------------------------------------ */

const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_DELTAS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export const KNIGHT_ATTACKS = new Int32Array(64 * 8);
export const KING_ATTACKS = new Int32Array(64 * 8);
export const KNIGHT_COUNT = new Uint8Array(64);
export const KING_COUNT = new Uint8Array(64);

function build() {
    for (let sq = 0; sq < 64; sq++) {
        const r = sq >> 3, f = sq & 7;
        let n = 0;
        for (const [dr, df] of KNIGHT_DELTAS) {
            const rr = r + dr, ff = f + df;
            if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) KNIGHT_ATTACKS[sq * 8 + n++] = rr * 8 + ff;
        }
        KNIGHT_COUNT[sq] = n;
        n = 0;
        for (const [dr, df] of KING_DELTAS) {
            const rr = r + dr, ff = f + df;
            if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) KING_ATTACKS[sq * 8 + n++] = rr * 8 + ff;
        }
        KING_COUNT[sq] = n;
    }
}
build();

export function knightTargets(sq) { return KNIGHT_ATTACKS.subarray(sq * 8, sq * 8 + KNIGHT_COUNT[sq]); }
export function kingTargets(sq) { return KING_ATTACKS.subarray(sq * 8, sq * 8 + KING_COUNT[sq]); }

/* ------------------------------------------------------------------ */
/* move helpers                                                        */
/* ------------------------------------------------------------------ */

export const mv = (from, to, promo = 0, flags = 0) => from | (to << 6) | (promo << 12) | (flags << 15);
export const mFrom = (m) => m & 63;
export const mTo = (m) => (m >> 6) & 63;
export const mPromo = (m) => (m >> 12) & 7;
export const mFlags = (m) => m >> 15;

export function moveToUci(m) {
    let s = squareName(mFrom(m)) + squareName(mTo(m));
    if (mFlags(m) & FLAG_PROMOTION) s += ' nbrq'[mPromo(m)];
    return s;
}

/* ------------------------------------------------------------------ */
/* Position                                                            */
/* ------------------------------------------------------------------ */

export class Position {
    constructor(fen = START_FEN) {
        this.board = new Int8Array(64);
        this.side = WHITE;
        this.castling = 0;
        this.ep = -1;
        this.halfmove = 0;
        this.fullmove = 1;
        this.setFen(fen);
    }

    clone() {
        const p = Object.create(Position.prototype);
        p.board = this.board.slice();
        p.side = this.side;
        p.castling = this.castling;
        p.ep = this.ep;
        p.halfmove = this.halfmove;
        p.fullmove = this.fullmove;
        p.history = this.history ? this.history.slice() : [];
        return p;
    }

    setFen(fen) {
        this.board.fill(0);
        this.ep = -1;
        this.halfmove = 0;
        this.fullmove = 1;
        this.castling = 0;
        const parts = fen.trim().split(/\s+/);
        let sq = 56;
        for (const ch of parts[0]) {
            if (ch === '/') { sq -= 16; continue; }
            if (ch >= '1' && ch <= '8') { sq += +ch; continue; }
            const idx = PIECE_CHARS.indexOf(ch);
            if (idx > 0) this.board[sq++] = idx;
        }
        this.side = parts[1] === 'b' ? BLACK : WHITE;
        const cr = parts[2] || '-';
        if (cr !== '-') {
            if (cr.includes('K')) this.castling |= 1;
            if (cr.includes('Q')) this.castling |= 2;
            if (cr.includes('k')) this.castling |= 4;
            if (cr.includes('q')) this.castling |= 8;
        }
        const epPart = parts[3] || '-';
        if (epPart !== '-') this.ep = squareIndex(epPart);
        this.halfmove = parts[4] ? +parts[4] : 0;
        this.fullmove = parts[5] ? +parts[5] : 1;
    }

    fen() {
        let out = '';
        for (let r = 7; r >= 0; r--) {
            let empty = 0;
            for (let f = 0; f < 8; f++) {
                const pc = this.board[r * 8 + f];
                if (!pc) empty++;
                else {
                    if (empty) { out += empty; empty = 0; }
                    out += PIECE_CHARS[pc];
                }
            }
            if (empty) out += empty;
            if (r) out += '/';
        }
        out += ' ' + (this.side === WHITE ? 'w' : 'b') + ' ';
        if (!this.castling) out += '-';
        else {
            if (this.castling & 1) out += 'K';
            if (this.castling & 2) out += 'Q';
            if (this.castling & 4) out += 'k';
            if (this.castling & 8) out += 'q';
        }
        out += ' ' + (this.ep < 0 ? '-' : squareName(this.ep));
        out += ' ' + this.halfmove + ' ' + this.fullmove;
        return out;
    }

    pieceAt(sq) { return this.board[sq]; }

    colorAt(sq) { const p = this.board[sq]; return p ? pieceColor(p) : -1; }

    kingSquare(color) {
        for (let sq = 0; sq < 64; sq++) if (this.board[sq] === makePiece(color, KING)) return sq;
        return -1;
    }

    /* squares attacked by a side (bitboard-free, returns Set of indices) */
    attackedSquares(color) {
        const att = new Set();
        for (let sq = 0; sq < 64; sq++) {
            const pc = this.board[sq];
            if (!pc || pieceColor(pc) !== color) continue;
            const t = pieceType(pc);
            if (t === KNIGHT) {
                for (const to of knightTargets(sq)) att.add(to);
            } else if (t === KING) {
                for (const to of kingTargets(sq)) att.add(to);
            } else if (t === PAWN) {
                const dir = color === WHITE ? 1 : -1;
                const f = sq & 7;
                if (f > 0) att.add(sq + 8 * dir - 1);
                if (f < 7) att.add(sq + 8 * dir + 1);
            } else if (t === ROOK || t === QUEEN || t === BISHOP) {
                const dirs = t === ROOK ? ROOK_DIRS : t === BISHOP ? BISHOP_DIRS : ROOK_DIRS.concat(BISHOP_DIRS);
                for (const [dr, df] of dirs) {
                    let r = (sq >> 3) + dr, f = (sq & 7) + df;
                    while (r >= 0 && r < 8 && f >= 0 && f < 8) {
                        const to = r * 8 + f;
                        att.add(to);
                        if (this.board[to]) break;
                        r += dr; f += df;
                    }
                }
            }
        }
        return att;
    }

    isAttacked(sq, byColor) {
        const r = sq >> 3, f = sq & 7;
        /* pawns */
        const pawndir = byColor === WHITE ? -1 : 1;
        for (const df of [-1, 1]) {
            const rr = r + pawndir, ff = f + df;
            if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
                const p = this.board[rr * 8 + ff];
                if (p && pieceColor(p) === byColor && pieceType(p) === PAWN) return true;
            }
        }
        for (const to of knightTargets(sq)) {
            const p = this.board[to];
            if (p && pieceColor(p) === byColor && pieceType(p) === KNIGHT) return true;
        }
        for (const to of kingTargets(sq)) {
            const p = this.board[to];
            if (p && pieceColor(p) === byColor && pieceType(p) === KING) return true;
        }
        for (const dirs of [ROOK_DIRS, BISHOP_DIRS]) {
            const isRook = dirs === ROOK_DIRS;
            for (const [dr, df] of dirs) {
                let rr = r + dr, ff = f + df;
                while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
                    const to = rr * 8 + ff;
                    const p = this.board[to];
                    if (p) {
                        if (pieceColor(p) === byColor) {
                            const t = pieceType(p);
                            if (t === QUEEN || (isRook ? t === ROOK : t === BISHOP)) return true;
                        }
                        break;
                    }
                    rr += dr; ff += df;
                }
            }
        }
        return false;
    }

    inCheck() { return this.isAttacked(this.kingSquare(this.side), this.side ^ 1); }

    /* pseudo legal move generation */
    generatePseudo() {
        const moves = [];
        const side = this.side;
        const them = side ^ 1;
        for (let sq = 0; sq < 64; sq++) {
            const pc = this.board[sq];
            if (!pc || pieceColor(pc) !== side) continue;
            const t = pieceType(pc);
            if (t === PAWN) {
                const dir = side === WHITE ? 1 : -1;
                const startRank = side === WHITE ? 1 : 6;
                const promoRank = side === WHITE ? 6 : 1;
                const r = sq >> 3, f = sq & 7;
                const one = sq + 8 * dir;
                if (one >= 0 && one < 64 && !this.board[one]) {
                    if (r === promoRank) {
                        for (const pr of [QUEEN, KNIGHT, ROOK, BISHOP]) moves.push(mv(sq, one, pr, FLAG_PROMOTION));
                    } else {
                        moves.push(mv(sq, one, 0, 0));
                        if (r === startRank) {
                            const two = one + 8 * dir;
                            if (!this.board[two]) moves.push(mv(sq, two, 0, FLAG_DOUBLE));
                        }
                    }
                }
                for (const df of [-1, 1]) {
                    const ff = f + df;
                    if (ff < 0 || ff > 7) continue;
                    const to = (r + dir) * 8 + ff;
                    if (to < 0 || to > 63) continue;
                    const target = this.board[to];
                    if (target && pieceColor(target) === them) {
                        if (r === promoRank) {
                            for (const pr of [QUEEN, KNIGHT, ROOK, BISHOP]) moves.push(mv(sq, to, pr, FLAG_PROMOTION | FLAG_CAPTURE));
                        } else moves.push(mv(sq, to, 0, FLAG_CAPTURE));
                    } else if (!target && to === this.ep) {
                        moves.push(mv(sq, to, 0, FLAG_CAPTURE | FLAG_EP));
                    }
                }
            } else if (t === KNIGHT) {
                for (const to of knightTargets(sq)) {
                    const target = this.board[to];
                    if (target && pieceColor(target) === side) continue;
                    moves.push(mv(sq, to, 0, target ? FLAG_CAPTURE : 0));
                }
            } else if (t === KING) {
                for (const to of kingTargets(sq)) {
                    const target = this.board[to];
                    if (target && pieceColor(target) === side) continue;
                    moves.push(mv(sq, to, 0, target ? FLAG_CAPTURE : 0));
                }
            } else {
                const dirs = t === ROOK ? ROOK_DIRS : t === BISHOP ? BISHOP_DIRS : ROOK_DIRS.concat(BISHOP_DIRS);
                const r = sq >> 3, f = sq & 7;
                for (const [dr, df] of dirs) {
                    let rr = r + dr, ff = f + df;
                    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
                        const to = rr * 8 + ff;
                        const target = this.board[to];
                        if (target) {
                            if (pieceColor(target) !== side) moves.push(mv(sq, to, 0, FLAG_CAPTURE));
                            break;
                        }
                        moves.push(mv(sq, to, 0, 0));
                        rr += dr; ff += df;
                    }
                }
            }
        }
        /* castling */
        const kingSq = side === WHITE ? 4 : 60;
        if (this.board[kingSq] === makePiece(side, KING)) {
            const them2 = side ^ 1;
            if (side === WHITE) {
                if ((this.castling & 1) && !this.board[5] && !this.board[6] &&
                    !this.isAttacked(4, them2) && !this.isAttacked(5, them2) && !this.isAttacked(6, them2))
                    moves.push(mv(4, 6, 0, FLAG_CASTLE));
                if ((this.castling & 2) && !this.board[3] && !this.board[2] && !this.board[1] &&
                    !this.isAttacked(4, them2) && !this.isAttacked(3, them2) && !this.isAttacked(2, them2))
                    moves.push(mv(4, 2, 0, FLAG_CASTLE));
            } else {
                if ((this.castling & 4) && !this.board[61] && !this.board[62] &&
                    !this.isAttacked(60, them2) && !this.isAttacked(61, them2) && !this.isAttacked(62, them2))
                    moves.push(mv(60, 62, 0, FLAG_CASTLE));
                if ((this.castling & 8) && !this.board[59] && !this.board[58] && !this.board[57] &&
                    !this.isAttacked(60, them2) && !this.isAttacked(59, them2) && !this.isAttacked(58, them2))
                    moves.push(mv(60, 58, 0, FLAG_CASTLE));
            }
        }
        return moves;
    }

    makeMove(m) {
        const undo = {
            move: m,
            captured: 0,
            moved: this.board[mFrom(m)],
            castling: this.castling,
            ep: this.ep,
            halfmove: this.halfmove,
            fullmove: this.fullmove,
        };
        const from = mFrom(m), to = mTo(m), flags = mFlags(m);
        const side = this.side, them = side ^ 1;
        const moved = this.board[from];

        this.halfmove++;
        if (flags & FLAG_EP) {
            const capSq = to + (side === WHITE ? -8 : 8);
            undo.captured = this.board[capSq];
            this.board[capSq] = 0;
            this.halfmove = 0;
            undo.epSquare = capSq;
        } else if (this.board[to]) {
            undo.captured = this.board[to];
            this.board[to] = 0;
            this.halfmove = 0;
        }

        this.board[from] = 0;
        if (flags & FLAG_CASTLE) {
            const r = side === WHITE ? 0 : 7;
            if (to > from) { this.board[r * 8 + 7] = 0; this.board[r * 8 + 5] = makePiece(side, ROOK); }
            else { this.board[r * 8] = 0; this.board[r * 8 + 3] = makePiece(side, ROOK); }
        }
        this.board[to] = (flags & FLAG_PROMOTION) ? makePiece(side, mPromo(m)) : moved;
        if ((flags & FLAG_PROMOTION) || pieceType(moved) === PAWN) this.halfmove = 0;

        this.ep = (flags & FLAG_DOUBLE) ? (from + to) >> 1 : -1; // eslint-disable-line no-mixed-operators

        let cr = this.castling;
        if (pieceType(moved) === KING) cr &= ~(side === WHITE ? 3 : 12);
        if (from === 0 || to === 0) cr &= ~2;
        if (from === 7 || to === 7) cr &= ~1;
        if (from === 56 || to === 56) cr &= ~8;
        if (from === 63 || to === 63) cr &= ~4;
        this.castling = cr;

        this.side = them;
        if (side === BLACK) this.fullmove++;
        return undo;
    }

    unmakeMove(undo) {
        const m = undo.move;
        const from = mFrom(m), to = mTo(m), flags = mFlags(m);
        const side = this.side ^ 1;
        this.side = side;
        this.castling = undo.castling;
        this.ep = undo.ep;
        this.halfmove = undo.halfmove;
        this.fullmove = undo.fullmove;

        if (flags & FLAG_CASTLE) {
            const r = side === WHITE ? 0 : 7;
            if (to > from) { this.board[r * 8 + 5] = 0; this.board[r * 8 + 7] = makePiece(side, ROOK); }
            else { this.board[r * 8 + 3] = 0; this.board[r * 8] = makePiece(side, ROOK); }
        }
        this.board[from] = undo.moved;
        this.board[to] = 0;
        if (undo.captured) {
            const capSq = (flags & FLAG_EP) ? undo.epSquare : to;
            this.board[capSq] = undo.captured;
        }
    }

    isLegal(m) {
        const u = this.makeMove(m);
        const bad = this.isAttacked(this.kingSquare(this.side ^ 1), this.side);
        this.unmakeMove(u);
        return !bad;
    }

    legalMoves() {
        const out = [];
        for (const m of this.generatePseudo()) if (this.isLegal(m)) out.push(m);
        return out;
    }

    legalMovesUci() { return this.legalMoves().map(moveToUci); }

    /* --- game state helpers --- */
    isCheckmate() { return this.inCheck() && this.legalMoves().length === 0; }

    isStalemate() { return !this.inCheck() && this.legalMoves().length === 0; }

    isInsufficientMaterial() {
        const pieces = [];
        for (let sq = 0; sq < 64; sq++) {
            const p = this.board[sq];
            if (!p) continue;
            const t = pieceType(p);
            if (t === PAWN || t === ROOK || t === QUEEN) return false;
            if (t !== KING) pieces.push({ t, color: pieceColor(p), sq });
        }
        if (pieces.length === 0) return true;
        if (pieces.length === 1) return true;
        if (pieces.length === 2 && pieces.every((p) => p.t === BISHOP)) {
            const light = pieces.map((p) => ((p.sq >> 3) + (p.sq & 7)) & 1);
            if (light[0] === light[1]) return true;
        }
        return false;
    }

    /* Static exchange evaluation — рекурсивная форма, как в C-ядре. */
    see(m) {
        const VALUES = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 20000 };
        const from = mFrom(m), to = mTo(m), flags = mFlags(m);
        const occ = new Uint8Array(64);
        for (let sq = 0; sq < 64; sq++) occ[sq] = this.board[sq] ? 1 : 0;
        occ[from] = 0;
        if (flags & FLAG_EP) occ[to + (this.side === WHITE ? -8 : 8)] = 0;

        let targetVal = 0;
        if (flags & FLAG_EP) targetVal = VALUES[PAWN];
        else if (this.board[to]) targetVal = VALUES[pieceType(this.board[to])];
        let myVal = VALUES[pieceType(this.board[from])];
        if (flags & FLAG_PROMOTION) {
            targetVal += VALUES[mPromo(m)] - VALUES[PAWN];
            myVal = VALUES[mPromo(m)];
        }
        if (!targetVal) return 0;
        const rec = this._seeRec(to, this.side ^ 1, myVal, occ, VALUES);
        return targetVal - rec;
    }

    _seeRec(to, side, targetVal, occ, VALUES) {
        const att = [];
        for (const s of this._attackersBy(to, side, occ)) if (occ[s]) att.push(s);
        if (!att.length) return 0;
        let best = att[0], bestVal = 1e9;
        for (const s of att) {
            const v = VALUES[pieceType(this.board[s])] || 100;
            if (v < bestVal) { bestVal = v; best = s; }
        }
        occ[best] = 0;
        const gain = targetVal - this._seeRec(to, side ^ 1, bestVal, occ, VALUES);
        occ[best] = 1;
        return gain > 0 ? gain : 0;
    }

    /* все фигуры цвета col, которые бьют поле sq (occ — карта занятости) */
    _attackersBy(sq, col, occ) {
        const res = [];
        const r = sq >> 3, f = sq & 7;
        for (let s = 0; s < 64; s++) {
            if (!occ[s]) continue;
            const p = this.board[s];
            if (!p || pieceColor(p) !== col) continue;
            const t = pieceType(p);
            const sr = s >> 3, sf = s & 7;
            if (t === KNIGHT) {
                const dd = Math.abs(sr - r) * 10 + Math.abs(sf - f);
                if (dd === 12 || dd === 21) res.push(s);
            } else if (t === KING) {
                if (Math.max(Math.abs(sr - r), Math.abs(sf - f)) === 1) res.push(s);
            } else if (t === PAWN) {
                const dir = col === WHITE ? 1 : -1;
                if (r - sr === dir && Math.abs(sf - f) === 1) res.push(s);
            } else {
                const straight = t === ROOK;
                const diag = t === BISHOP;
                const dr = Math.sign(r - sr), df = Math.sign(f - sf);
                const okDir = straight ? (dr === 0 || df === 0) && !(dr !== 0 && df !== 0)
                    : diag ? Math.abs(r - sr) === Math.abs(f - sf)
                        : (dr === 0 || df === 0 || Math.abs(r - sr) === Math.abs(f - sf));
                if (!okDir || (dr === 0 && df === 0)) continue;
                let rr = sr + dr, ff = sf + df, blocked = false;
                while (rr !== r || ff !== f) {
                    if (rr < 0 || rr > 7 || ff < 0 || ff > 7) { blocked = true; break; }
                    if (occ[rr * 8 + ff]) { blocked = true; break; }
                    rr += dr; ff += df;
                }
                if (!blocked) res.push(s);
            }
        }
        return res;
    }
}

/* ------------------------------------------------------------------ */
/* SAN                                                                 */
/* ------------------------------------------------------------------ */

export function moveToSan(pos, m) {
    const from = mFrom(m), to = mTo(m), flags = mFlags(m);
    const piece = pos.board[from];
    const type = pieceType(piece);
    const isCapture = !!(flags & FLAG_CAPTURE) || !!pos.board[to];
    let san = '';

    if (flags & FLAG_CASTLE) {
        san = to > from ? 'O-O' : 'O-O-O';
    } else if (type === PAWN) {
        if (isCapture) san += FILES[from & 7] + 'x';
        san += squareName(to);
        if (flags & FLAG_PROMOTION) san += '=' + ' NBRQ'[mPromo(m)];
    } else {
        san += ' PNBRQK'[type];
        /* disambiguation */
        const rivals = [];
        for (const o of pos.legalMoves()) {
            if (o === m) continue;
            if (mTo(o) !== to) continue;
            const op = pos.board[mFrom(o)];
            if (pieceType(op) !== type) continue;
            rivals.push(mFrom(o));
        }
        if (rivals.length) {
            const sameFile = rivals.some((s) => (s & 7) === (from & 7));
            const sameRank = rivals.some((s) => (s >> 3) === (from >> 3));
            if (!sameFile) san += FILES[from & 7];
            else if (!sameRank) san += String((from >> 3) + 1);
            else san += squareName(from);
        }
        if (isCapture) san += 'x';
        san += squareName(to);
    }

    const undo = pos.makeMove(m);
    if (pos.inCheck()) san += pos.legalMoves().length ? '+' : '#';
    pos.unmakeMove(undo);
    return san;
}

export function uciToMove(pos, uci) {
    for (const m of pos.legalMoves()) if (moveToUci(m) === uci) return m;
    return 0;
}

export function parseSan(pos, san) {
    const clean = san.replace(/[+#!?]+$/, '');
    for (const m of pos.legalMoves()) if (moveToSan(pos, m) === clean) return m;
    return 0;
}

/* number each move of a game: returns [{number, san, uci, fenAfter, side}] */
export function annotateLine(fen, ucis) {
    const pos = new Position(fen);
    const out = [];
    let num = pos.fullmove;
    let white = pos.side === WHITE;
    for (const u of ucis) {
        const m = uciToMove(pos, u);
        if (!m) break;
        const san = moveToSan(pos, m);
        const f0 = pos.fen();
        pos.makeMove(m);
        out.push({ number: num, white, san, uci: u, fenBefore: f0, fenAfter: pos.fen() });
        if (!white) num++;
        white = !white;
    }
    return out;
}
