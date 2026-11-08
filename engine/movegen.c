/*
  GambitFish — move generation. GPL-3.0.
*/

#include "engine.h"
#include <stdlib.h>

static const int PROMO_ORDER[4] = {QUEEN, KNIGHT, ROOK, BISHOP};

static int gen_pawn_moves(const Position* p, Move* out, int onlyTactical) {
    int n = 0;
    int side = p->side, opp = !side;
    U64 pawns = p->bb[side][PAWN];
    U64 occ = p->bb[WHITE][7] | p->bb[BLACK][7];
    U64 enemies = p->bb[opp][7];
    int up = side == WHITE ? 8 : -8;
    int startRank = side == WHITE ? 1 : 6;
    int promoRank = side == WHITE ? 6 : 1;
    U64 b = pawns;

    while (b) {
        int from = pop_lsb(&b);
        int r = from >> 3;
        int to = from + up;
        /* pushes */
        if (to >= 0 && to < 64 && !p->board[to]) {
            if (r == promoRank) {
                out[n++] = MOVE(from, to, QUEEN, FLAG_PROMOTION);
                out[n++] = MOVE(from, to, KNIGHT, FLAG_PROMOTION);
                if (!onlyTactical) {
                    out[n++] = MOVE(from, to, ROOK, FLAG_PROMOTION);
                    out[n++] = MOVE(from, to, BISHOP, FLAG_PROMOTION);
                }
            } else if (!onlyTactical) {
                out[n++] = MOVE(from, to, 0, 0);
                if (r == startRank) {
                    int to2 = from + 2 * up;
                    if (!p->board[to2]) out[n++] = MOVE(from, to2, 0, FLAG_DOUBLE);
                }
            }
        }
        /* captures */
        {
            U64 caps = PAWN_ATTACKS[side][from] & enemies;
            while (caps) {
                int t = pop_lsb(&caps);
                if (t >> 3 == (side == WHITE ? 7 : 0)) {
                    out[n++] = MOVE(from, t, QUEEN, FLAG_PROMOTION | FLAG_CAPTURE);
                    out[n++] = MOVE(from, t, KNIGHT, FLAG_PROMOTION | FLAG_CAPTURE);
                    if (!onlyTactical) {
                        out[n++] = MOVE(from, t, ROOK, FLAG_PROMOTION | FLAG_CAPTURE);
                        out[n++] = MOVE(from, t, BISHOP, FLAG_PROMOTION | FLAG_CAPTURE);
                    }
                } else out[n++] = MOVE(from, t, 0, FLAG_CAPTURE);
            }
        }
        /* en passant */
        if (p->ep >= 0 && (PAWN_ATTACKS[side][from] & BB_SQUARE[p->ep]))
            out[n++] = MOVE(from, p->ep, 0, FLAG_CAPTURE | FLAG_EP);
    }
    (void)occ;
    return n;
}

static int gen_piece_moves(const Position* p, Move* out, int onlyTactical) {
    int n = 0, side = p->side, opp = !side;
    U64 occ = p->bb[WHITE][7] | p->bb[BLACK][7];
    U64 own = p->bb[side][7];
    U64 enemies = p->bb[opp][7];
    int t;

    for (t = KNIGHT; t <= KING; t++) {
        U64 b = p->bb[side][t];
        while (b) {
            int from = pop_lsb(&b);
            U64 att;
            switch (t) {
            case KNIGHT: att = KNIGHT_ATTACKS[from]; break;
            case BISHOP: att = bishop_attacks(from, occ); break;
            case ROOK:   att = rook_attacks(from, occ); break;
            case QUEEN:  att = queen_attacks(from, occ); break;
            default:     att = KING_ATTACKS[from]; break;
            }
            att &= ~own;
            {
                U64 caps = att & enemies;
                U64 quiets = onlyTactical ? 0 : (att & ~enemies);
                while (caps) { int to = pop_lsb(&caps); out[n++] = MOVE(from, to, 0, FLAG_CAPTURE); }
                while (quiets) { int to = pop_lsb(&quiets); out[n++] = MOVE(from, to, 0, 0); }
            }
        }
    }

    /* castling */
    if (!onlyTactical) {
        int ks = side == WHITE ? 4 : 60;
        int ksq = p->kingSq[side];
        if (ksq == ks) {
            if (side == WHITE) {
                if ((p->castling & 1) && !p->board[5] && !p->board[6] &&
                    !attacks_square(p, 4, BLACK) && !attacks_square(p, 5, BLACK) && !attacks_square(p, 6, BLACK))
                    out[n++] = MOVE(4, 6, 0, FLAG_CASTLE);
                if ((p->castling & 2) && !p->board[3] && !p->board[2] && !p->board[1] &&
                    !attacks_square(p, 4, BLACK) && !attacks_square(p, 3, BLACK) && !attacks_square(p, 2, BLACK))
                    out[n++] = MOVE(4, 2, 0, FLAG_CASTLE);
            } else {
                if ((p->castling & 4) && !p->board[61] && !p->board[62] &&
                    !attacks_square(p, 60, WHITE) && !attacks_square(p, 61, WHITE) && !attacks_square(p, 62, WHITE))
                    out[n++] = MOVE(60, 62, 0, FLAG_CASTLE);
                if ((p->castling & 8) && !p->board[59] && !p->board[58] && !p->board[57] &&
                    !attacks_square(p, 60, WHITE) && !attacks_square(p, 59, WHITE) && !attacks_square(p, 58, WHITE))
                    out[n++] = MOVE(60, 58, 0, FLAG_CASTLE);
            }
        }
    }
    return n;
}

int gen_moves(const Position* p, Move* out) {
    int n = gen_pawn_moves(p, out, 0);
    n += gen_piece_moves(p, out + n, 0);
    return n;
}

int gen_tactical(const Position* p, Move* out) {
    int n = gen_pawn_moves(p, out, 1);
    n += gen_piece_moves(p, out + n, 1);
    return n;
}

int gen_quiet(const Position* p, Move* out, int skipUnderpromo) {
    int n = 0;
    Move tmp[MAX_MOVES * 4];
    int total = gen_moves(p, tmp);
    int i;
    for (i = 0; i < total; i++) {
        Move m = tmp[i];
        if (M_FLAGS(m) & (FLAG_CAPTURE | FLAG_EP)) continue;
        if (skipUnderpromo && (M_FLAGS(m) & FLAG_PROMOTION) && M_PROMO(m) != QUEEN) continue;
        out[n++] = m;
    }
    return n;
}

int is_legal(const Position* p, Move m) {
    Position copy = *p;
    Undo u;
    int ok;
    make_move(&copy, m, &u);
    ok = !attacks_square(&copy, copy.kingSq[!copy.side], copy.side);
    return ok;
}

int legal_moves(Position* p, Move* out) {
    Move tmp[MAX_MOVES * 4];
    int n = gen_moves(p, tmp);
    int i, k = 0;
    for (i = 0; i < n; i++) {
        if (is_legal(p, tmp[i])) out[k++] = tmp[i];
    }
    return k;
}
