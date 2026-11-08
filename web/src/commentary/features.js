/*
  GambitFish — извлечение шахматных признаков хода для комментатора.
  Всё считается по конкретной позиции, поэтому фразы всегда точные.
  GPL-3.0.
*/

import {
    Position, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
    FLAG_CAPTURE, FLAG_EP, FLAG_CASTLE, FLAG_PROMOTION,
    mFrom, mTo, mFlags, mPromo, pieceType, pieceColor, makePiece,
    squareName, moveToSan, moveToUci, KNIGHT_ATTACKS, KING_COUNT, KING_ATTACKS, KNIGHT_COUNT,
} from '../chess/chess.js';

const PIECE_RU = { 1: 'пешка', 2: 'конь', 3: 'слон', 4: 'ладья', 5: 'ферзь', 6: 'король' };
const PIECE_RU_NOM = { 1: 'пешка', 2: 'конь', 3: 'слон', 4: 'ладья', 5: 'ферзь', 6: 'король' };
export const pieceNameRu = (t) => PIECE_RU[t] || 'фигура';

export const VALUE = { 1: 100, 2: 320, 3: 330, 4: 500, 5: 900, 6: 0 };

export function centerDistance(sq) {
    const r = sq >> 3, f = sq & 7;
    return Math.max(Math.abs(r - 3.5), Math.abs(f - 3.5));
}

/* король на исходном положении и без рокировки */
export function kingStillHome(pos, color) {
    const ksq = pos.kingSquare(color);
    return color === WHITE ? ksq === 4 : ksq === 60;
}

export function kingHasCastled(pos, color) {
    const ksq = pos.kingSquare(color);
    if (color === WHITE) return ksq === 6 || ksq === 2 || ksq === 1 || ksq === 5;
    return ksq === 62 || ksq === 58 || ksq === 57 || ksq === 61;
}

export function pawnShieldMissing(pos, color) {
    const ksq = pos.kingSquare(color);
    if (ksq < 0) return 0;
    const r = ksq >> 3, f = ksq & 7;
    const up = color === WHITE ? 1 : -1;
    let missing = 0;
    for (let df = -1; df <= 1; df++) {
        const ff = f + df, rr = r + up;
        if (ff < 0 || ff > 7 || rr < 0 || rr > 7) continue;
        if (pos.board[rr * 8 + ff] !== makePiece(color, PAWN)) missing++;
    }
    return missing;
}

export function materialBalance(pos) {
    let w = 0, b = 0;
    for (let sq = 0; sq < 64; sq++) {
        const p = pos.board[sq];
        if (!p) continue;
        const v = VALUE[pieceType(p)] || 0;
        if (pieceColor(p) === WHITE) w += v; else b += v;
    }
    return { white: w, black: b, diff: w - b };
}

/* фигуры, которые атакуют зону вокруг короля */
export function kingAttackers(pos, byColor, victimColor) {
    const ksq = pos.kingSquare(victimColor);
    if (ksq < 0) return [];
    const zone = new Set([ksq, ...Array.from(KING_ATTACKS.subarray(ksq * 8, ksq * 8 + KING_COUNT[ksq]))]);
    const out = [];
    for (let sq = 0; sq < 64; sq++) {
        const p = pos.board[sq];
        if (!p || pieceColor(p) !== byColor) continue;
        if (attacksSquare(pos, sq, ksq)) { out.push(sq); continue; }
        const t = pieceType(p);
        let hits = false;
        if (t === KNIGHT) {
            for (let i = 0; i < KNIGHT_COUNT[sq]; i++) if (zone.has(KNIGHT_ATTACKS[sq * 8 + i])) { hits = true; break; }
        } else if (t === PAWN) {
            const dir = byColor === WHITE ? 1 : -1;
            const f = sq & 7;
            const a = f > 0 ? sq + 8 * dir - 1 : -1;
            const b = f < 7 ? sq + 8 * dir + 1 : -1;
            if ((a >= 0 && zone.has(a)) || (b >= 0 && zone.has(b))) hits = true;
        } else if (t === KING) {
            for (let i = 0; i < KING_COUNT[sq]; i++) if (zone.has(KING_ATTACKS[sq * 8 + i])) { hits = true; break; }
        } else {
            for (let i = 0; i < KING_COUNT[sq]; i++) if (zone.has(KING_ATTACKS[sq * 8 + i]) && attacksSquare(pos, sq, KING_ATTACKS[sq * 8 + i])) { hits = true; break; }
        }
        if (hits) out.push(sq);
    }
    return out;
}

/* проходная пешка */
export function isPassedPawn(pos, sq) {
    const p = pos.board[sq];
    if (!p || pieceType(p) !== PAWN) return false;
    const c = pieceColor(p);
    const r = sq >> 3, f = sq & 7;
    for (let rr = r + (c === WHITE ? 1 : -1); rr >= 0 && rr < 8; rr += (c === WHITE ? 1 : -1)) {
        for (let ff = f - 1; ff <= f + 1; ff++) {
            if (ff < 0 || ff > 7) continue;
            const q = pos.board[rr * 8 + ff];
            if (q && q === makePiece(c ^ 1, PAWN)) return false;
        }
    }
    return true;
}

export function doubleCheck(pos) {
    /* вызывается ПОСЛЕ хода: сколько фигур атакуют короля на ходу */
    const ksq = pos.kingSquare(pos.side);
    let n = 0;
    for (let sq = 0; sq < 64; sq++) {
        const p = pos.board[sq];
        if (!p || pieceColor(p) !== (pos.side ^ 1)) continue;
        if (attacksSquare(pos, sq, ksq)) n++;
    }
    return n;
}

function attacksSquare(pos, from, target) {
    const p = pos.board[from];
    if (!p) return false;
    const t = pieceType(p), c = pieceColor(p);
    const r = from >> 3, f = from & 7;
    const tr = target >> 3, tf = target & 7;
    if (t === KNIGHT) {
        const d = Math.abs(r - tr) * 10 + Math.abs(f - tf);
        return (d === 12 || d === 21);
    }
    if (t === KING) return Math.max(Math.abs(r - tr), Math.abs(f - tf)) === 1;
    if (t === PAWN) {
        const dir = c === WHITE ? 1 : -1;
        return tr - r === dir && Math.abs(tf - f) === 1;
    }
    const dirs = t === ROOK ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
        : t === BISHOP ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
            : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
            if (rr === tr && ff === tf) return true;
            if (pos.board[rr * 8 + ff]) break;
            rr += dr; ff += df;
        }
    }
    return false;
}

export function attacksBetween(pos, from, to) {
    return attacksSquare(pos, from, to);
}

/* сколько фигур соперника атаковано после хода */
export function hangingPieces(pos, byColor) {
    const out = [];
    for (let sq = 0; sq < 64; sq++) {
        const p = pos.board[sq];
        if (!p || pieceColor(p) !== (byColor ^ 1)) continue;
        for (let s2 = 0; s2 < 64; s2++) {
            const q = pos.board[s2];
            if (!q || pieceColor(q) !== byColor) continue;
            if (attacksSquare(pos, s2, sq)) { out.push(sq); break; }
        }
    }
    return out;
}

/* фигуры под связкой к ферзю/королю */
export function pinnedPieces(pos, color) {
    const out = [];
    for (let sq = 0; sq < 64; sq++) {
        const p = pos.board[sq];
        if (!p || pieceColor(p) !== color) continue;
        if (pieceType(p) === KING) continue;
        const before = pos.board.slice();
        /* убираем фигуру и смотрим, не атакуется ли король/ферзь */
        const kingSq = pos.kingSquare(color);
        pos.board[sq] = 0;
        const kingHit = attacksSquareRaw(before, sq, kingSq, color ^ 1);
        pos.board[sq] = before[sq] && before[sq];
        pos.board[sq] = before[sq];
        if (kingHit) out.push(sq);
    }
    return out;
}

function attacksSquareRaw(board, ignoreSq, target, byColor) {
    const p = board[ignoreSq];
    const r = target >> 3, f = target & 7;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
            const q = board[rr * 8 + ff];
            if (q) {
                if (pieceColor(q) === byColor) {
                    const t = pieceType(q);
                    const straight = dr === 0 || df === 0;
                    if (t === QUEEN || (straight ? t === ROOK : t === BISHOP)) return true;
                }
                break;
            }
            rr += dr; ff += df;
        }
    }
    return false;
}

/* форсированные ходы соперника после нашего хода */
export function replies(pos) {
    return pos.legalMoves();
}

export function isForced(pos) {
    return pos.legalMoves().length === 1;
}

/* главный анализ одного хода */
export function analyzeMove(pos, move) {
    if (!move) return null;
    const fenBefore = pos.fen();
    const side = pos.side;
    const them = side ^ 1;
    const from = mFrom(move), to = mTo(move), flags = mFlags(move);
    const movingPiece = pos.board[from];
    const type = pieceType(movingPiece);
    const san = moveToSan(pos, move);
    const uci = moveToUci(move);

    const matBefore = materialBalance(pos);
    const attackersBefore = kingAttackers(pos, side, them);
    const theirAttackersBefore = kingAttackers(pos, them, side);

    const captured = (flags & FLAG_EP) ? makePiece(them, PAWN) : pos.board[to];
    const seeValue = pos.see(move);

    /* делаем ход, чтобы увидеть последствия */
    const undo = pos.makeMove(move);
    const check = pos.inCheck();
    const mate = pos.isCheckmate();
    const stalemate = pos.isStalemate();
    const legalCnt = pos.legalMoves().length;
    const dbl = check ? doubleCheck(pos) : 0;
    const theirKing = pos.kingSquare(them);
    const attackersAfter = kingAttackers(pos, side, them);
    const matAfter = materialBalance(pos);
    const passed = isPassedPawn(pos, to);
    const promoSq = (flags & FLAG_PROMOTION) ? to : -1;
    const hanging = hangingPieces(pos, side);
    const recaptureSquares = [];

    pos.unmakeMove(undo);

    /* предлагаем ли материал: есть ли у соперника взятие с выигрышем */
    let offerSee = 0, offerUci = '', offerTo = -1;
    {
        const probe = new Position(fenBefore);
        const u = probe.makeMove(move);
        for (const r of probe.legalMoves()) {
            if (!(mFlags(r) & FLAG_CAPTURE)) continue;
            const v = probe.see(r);
            if (v > offerSee) { offerSee = v; offerUci = moveToUci(r); offerTo = mTo(r); }
        }
        probe.unmakeMove(u);
    }

    const sacrificed = (seeValue < -60) || ((captured ? VALUE[pieceType(captured)] : 0) < VALUE[type] - 40 && (flags & FLAG_CAPTURE));
    const isSacrifice = seeValue < -50;
    const exchangeSacrifice = !!(flags & FLAG_CAPTURE) && VALUE[type] - VALUE[pieceType(captured || 1)] >= 100 && seeValue < 0;

    return {
        fenBefore,
        fenAfter: (() => { const u = pos.makeMove(move); const f = pos.fen(); pos.unmakeMove(u); return f; })(),
        side,
        san,
        uci,
        from,
        to,
        type,
        pieceName: PIECE_RU[type],
        flags,
        capture: !!(flags & FLAG_CAPTURE),
        capturedType: captured ? pieceType(captured) : 0,
        capturedName: captured ? PIECE_RU[pieceType(captured)] : '',
        check,
        mate,
        stalemate,
        doubleCheck: dbl > 1,
        castle: !!(flags & FLAG_CASTLE),
        promotion: (flags & FLAG_PROMOTION) ? mPromo(move) : 0,
        enPassant: !!(flags & FLAG_EP),
        seeValue,
        isSacrifice,
        offersMaterial: offerSee >= 150,
        offerSee,
        offerUci,
        offerTo,
        exchangeSacrifice,
        matDiffBefore: matBefore.diff,
        matDiffAfter: matAfter.diff,
        attackersBefore: attackersBefore.length,
        attackersAfter: attackersAfter.length,
        theirAttackersBefore: theirAttackersBefore.length,
        passedPawn: passed,
        legalCnt,
        forcedReply: legalCnt === 1 && !mate && !stalemate,
        theirKingSquare: theirKing,
        hangingCount: hanging.length,
        fromName: squareName(from),
        toName: squareName(to),
        fromCenter: centerDistance(from),
        toCenter: centerDistance(to),
        toFile: to & 7,
        toRank: to >> 3,
        givesInitiative: attackersAfter.length > theirAttackersBefore.length + 1,
        emptiesCenter: centerDistance(to) < centerDistance(from),
        movesKing: type === KING,
        castling: (flags & FLAG_CASTLE) ? (to > from ? 'short' : 'long') : '',
        threatsMate: mate,
        recaptureSquares,
    };
}

/* оценка «живости» инициативы: 0..10 */
export function initiativeScore(pos, side) {
    const them = side ^ 1;
    let s = 0;
    s += kingAttackers(pos, side, them).length * 1.6;
    s += hangingPieces(pos, side).length * 0.8;
    const dev = countDevelopment(pos, side);
    s += (dev - 4) * 0.7;
    const ksq = pos.kingSquare(them);
    if (ksq >= 0 && pawnShieldMissing(pos, them) >= 2) s += 1.5;
    if (kingStillHome(pos, them) && pos.castling === 0) s += 1.0;
    return Math.max(0, Math.min(10, Math.round(s * 10) / 10));
}

function countDevelopment(pos, color) {
    let n = 0;
    const homeRank = color === WHITE ? 0 : 7;
    for (let sq = 0; sq < 64; sq++) {
        const p = pos.board[sq];
        if (!p || pieceColor(p) !== color) continue;
        if (pieceType(p) === KING || pieceType(p) === PAWN) continue;
        const r = sq >> 3;
        if (r !== homeRank) n++;
    }
    return n;
}

export { attacksSquare, countDevelopment, PIECE_RU, PIECE_RU_NOM };

/* Насколько король уязвим: 0 (укрыт) .. 4+ (гуляет по доске).
   Формула не зависит от того, рокировал ли король — важно только,
   есть ли рядом свои пешки и насколько он выдвинут. */
export function kingVulnerability(pos, color) {
    const ksq = pos.kingSquare(color);
    if (ksq < 0) return 0;
    const r = ksq >> 3, f = ksq & 7;
    const up = color === WHITE ? 1 : -1;
    const homeRank = color === WHITE ? 0 : 7;
    let missing = 0;
    for (let df = -1; df <= 1; df++) {
        const ff = f + df;
        if (ff < 0 || ff > 7) continue;
        let found = false;
        for (const dr of [up, 2 * up]) {
            const rr = r + dr;
            if (rr < 0 || rr > 7) continue;
            if (pos.board[rr * 8 + ff] === makePiece(color, PAWN)) { found = true; break; }
        }
        if (!found) missing++;
    }
    let score = missing;
    if (f === 3 || f === 4) score += 1;          /* король в центре */
    if (f === 0 || f === 1 || f === 6 || f === 7) score -= 1;
    /* король ушёл с последней горизонтали — но только если он не рокировался */
    if (r !== homeRank && (f === 3 || f === 4)) score += 1;
    return Math.max(0, score);
}
