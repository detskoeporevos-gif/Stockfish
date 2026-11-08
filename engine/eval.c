/*
  GambitFish — evaluation. Classical, tapered, with explicit gambit /
  initiative / sacrifice-compensation terms. GPL-3.0.
*/

#include "engine.h"
#include <stdlib.h>

int EvalWeight_Gambit = 100;      /* 0..200 : how much we trust the initiative */
int EvalWeight_Sacrifice = 100;   /* 0..200 : how much material we are willing to invest */

static const int PIECE_VALUE[7] = {0, 100, 320, 330, 500, 900, 0};
static const int PHASE_VALUE[7] = {0, 0, 1, 1, 2, 4, 0};

/* Piece-square tables, from White's point of view, a1 = index 0. */
static const int PST_MG[7][64] = {
    {0},
    { /* pawn */
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10,-20,-20, 10, 10,  5,
      5, -5,-10,  0,  0,-10, -5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5,  5, 10, 25, 25, 10,  5,  5,
     10, 10, 20, 30, 30, 20, 10, 10,
     50, 50, 50, 50, 50, 50, 50, 50,
      0,  0,  0,  0,  0,  0,  0,  0},
    { /* knight */
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50},
    { /* bishop */
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -20,-10,-10,-10,-10,-10,-10,-20},
    { /* rook */
      0,  0,  5, 10, 10,  5,  0,  0,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      5, 10, 10, 10, 10, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0},
    { /* queen */
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -10,  5,  5,  5,  5,  5,  0,-10,
      0,  0,  5,  5,  5,  5,  0, -5,
     -5,  0,  5,  5,  5,  5,  0, -5,
    -10,  0,  5,  5,  5,  5,  0,-10,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20},
    { /* king mg */
     20, 30, 10,  0,  0, 10, 30, 20,
     20, 20,  0,  0,  0,  0, 20, 20,
    -10,-20,-20,-20,-20,-20,-20,-10,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30},
};

static const int PST_EG[7][64] = {
    {0},
    { /* pawn eg */
      0,  0,  0,  0,  0,  0,  0,  0,
     90, 90, 90, 90, 90, 90, 90, 90,
     55, 55, 55, 55, 55, 55, 55, 55,
     30, 30, 30, 30, 30, 30, 30, 30,
     15, 15, 15, 15, 15, 15, 15, 15,
      5,  5,  5,  5,  5,  5,  5,  5,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0},
    { /* knight eg */
    -50,-40,-30,-25,-25,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -25,  5, 20, 25, 25, 20,  5,-25,
    -25,  5, 20, 25, 25, 20,  5,-25,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-25,-25,-30,-40,-50},
    { /* bishop eg */
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -20,-10,-10,-10,-10,-10,-10,-20},
    { /* rook eg */
      5,  5,  5,  5,  5,  5,  5,  5,
     10, 10, 10, 10, 10, 10, 10, 10,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0},
    { /* queen eg */
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5, 10, 10,  5,  0, -5,
     -5,  0,  5, 10, 10,  5,  0, -5,
    -10,  0,  5,  5,  5,  5,  0,-10,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20},
    { /* king eg */
    -50,-30,-30,-30,-30,-30,-30,-50,
    -30,-30,-10,  0,  0,-10,-30,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-30,-10,  0,  0,-10,-30,-30,
    -50,-30,-30,-30,-30,-30,-30,-50},
};

/* square mirroring helper: index with black perspective */
static inline int rel(int sq, int side) { return side == WHITE ? sq : (sq ^ 56); }

static U64 passed_mask(int side, int sq) {
    U64 m = 0;
    int r = sq >> 3, f = sq & 7, rr, ff;
    for (rr = (side == WHITE ? r + 1 : r - 1); rr >= 0 && rr < 8; rr += (side == WHITE ? 1 : -1))
        for (ff = f - 1; ff <= f + 1; ff++)
            if (ff >= 0 && ff < 8) m |= BB_SQUARE[rr * 8 + ff];
    return m;
}

static int forward_span(int side, int sq) {
    int r = sq >> 3;
    return side == WHITE ? 7 - r : r;
}

/* number of attacks a side has on the king zone of the enemy */
static int king_attack_units(const Position* p, int by, int enemyKing) {
    U64 zone = KING_ATTACKS[enemyKing] | BB_SQUARE[enemyKing];
    U64 occ = p->bb[WHITE][7] | p->bb[BLACK][7];
    U64 b, attackers = 0;
    int units;

    b = p->bb[by][KNIGHT];
    while (b) { int s = pop_lsb(&b); if (KNIGHT_ATTACKS[s] & zone) attackers |= BB_SQUARE[s]; }
    b = p->bb[by][BISHOP];
    while (b) { int s = pop_lsb(&b); if (bishop_attacks(s, occ) & zone) attackers |= BB_SQUARE[s]; }
    b = p->bb[by][ROOK];
    while (b) { int s = pop_lsb(&b); if (rook_attacks(s, occ) & zone) attackers |= BB_SQUARE[s]; }
    b = p->bb[by][QUEEN];
    while (b) { int s = pop_lsb(&b); if (queen_attacks(s, occ) & zone) attackers |= BB_SQUARE[s]; }
    b = p->bb[by][PAWN];
    while (b) { int s = pop_lsb(&b); if (PAWN_ATTACKS[by][s] & zone) attackers |= BB_SQUARE[s]; }

    units = popcount(attackers);
    units += 2 * popcount(p->bb[by][QUEEN] & (zone | KING_ATTACKS[enemyKing]));
    return units;
}

/* Is the king still in the centre without castling? */
static int king_exposed(const Position* p, int side) {
    int ksq = p->kingSq[side];
    int r = ksq >> 3, f = ksq & 7;
    int homeRank = side == WHITE ? 0 : 7;
    if (r != homeRank) return 0;
    if (f == 3 || f == 4) return 1;
    return 0;
}

static int pawn_shield(const Position* p, int side) {
    int ksq = p->kingSq[side];
    int f = ksq & 7, r = ksq >> 3;
    int shield = 0, df;
    int up = side == WHITE ? 1 : -1;
    for (df = -1; df <= 1; df++) {
        int ff = f + df;
        int rr = r + up;
        if (ff < 0 || ff > 7) continue;
        if (rr < 0 || rr > 7) continue;
        if (p->bb[side][PAWN] & BB_SQUARE[rr * 8 + ff]) shield += 12;
        else if (rr + up >= 0 && rr + up < 8 && (p->bb[side][PAWN] & BB_SQUARE[(rr + up) * 8 + ff])) shield += 5;
        else shield -= 10;
    }
    return shield;
}

int evaluate_material(const Position* p) {
    int c, t, sum = 0;
    for (c = 0; c < 2; c++)
        for (t = PAWN; t <= QUEEN; t++) {
            int n = popcount(p->bb[c][t]);
            sum += (c == WHITE ? n : -n) * PIECE_VALUE[t];
        }
    return sum;
}

int evaluate(const Position* p, int gambitMode) {
    int side, sq, scoreMg = 0, scoreEg = 0, phase = 0;
    int mat[2] = {0, 0};
    int bishopCount[2] = {0, 0};
    int pawnsOnFile[2][8];
    int rr, ff;
    U64 occ = p->bb[WHITE][7] | p->bb[BLACK][7];
    int attackWhite, attackBlack;

    for (ff = 0; ff < 8; ff++) { pawnsOnFile[0][ff] = 0; pawnsOnFile[1][ff] = 0; }
    for (sq = 0; sq < 64; sq++) {
        int pc = p->board[sq];
        int t, c;
        int mgv, egv;
        if (!pc) continue;
        c = PIECE_COLOR(pc); t = PIECE_TYPE(pc);
        phase += PHASE_VALUE[t];
        if (t == PAWN) pawnsOnFile[c][sq & 7]++;
        if (t == BISHOP) bishopCount[c]++;
        mgv = PIECE_VALUE[t] + PST_MG[t][rel(sq, c)];
        egv = PIECE_VALUE[t] + PST_EG[t][rel(sq, c)];
        /* mobility */
        {
            U64 att;
            int mob = 0;
            U64 own = p->bb[c][7];
            switch (t) {
            case KNIGHT: att = KNIGHT_ATTACKS[sq]; break;
            case BISHOP: att = bishop_attacks(sq, occ); break;
            case ROOK:   att = rook_attacks(sq, occ); break;
            case QUEEN:  att = queen_attacks(sq, occ); break;
            case KING:   att = 0; break;
            default:     att = 0; break;
            }
            if (t >= KNIGHT && t <= QUEEN) {
                mob = popcount(att & ~own);
                mgv += mob * (t == QUEEN ? 1 : 3);
                egv += mob * (t == QUEEN ? 1 : 2);
            }
        }
        /* rook on open / semi-open file */
        if (t == ROOK) {
            int f = sq & 7;
            if (!pawnsOnFile[c][f]) { mgv += 18; egv += 10; }
            else if (!pawnsOnFile[!c][f]) { mgv += 9; egv += 5; }
        }
        /* knight outpost */
        if (t == KNIGHT) {
            U64 enemyPawnAtt = 0;
            U64 ep = p->bb[!c][PAWN];
            while (ep) { int s = pop_lsb(&ep); enemyPawnAtt |= PAWN_ATTACKS[!c][s]; }
            if (!(enemyPawnAtt & BB_SQUARE[sq])) {
                int supported = (PAWN_ATTACKS[!c][sq] & p->bb[c][PAWN]) != 0;
                if (supported) { mgv += 22; egv += 10; }
            }
        }
        /* passed pawn */
        if (t == PAWN) {
            U64 pm = passed_mask(c, sq);
            if (!(pm & p->bb[!c][PAWN])) {
                int adv = forward_span(c, sq);
                int bonus = 8 + adv * adv * 3;
                mgv += bonus / 2;
                egv += bonus;
                if (adv >= 5) { egv += 20; mgv += 8; }
            }
            /* connected pawns */
            {
                int f = sq & 7, r = sq >> 3;
                int up = c == WHITE ? 1 : -1;
                if (f > 0 && (p->bb[c][PAWN] & BB_SQUARE[(r + up) * 8 + f - 1])) { mgv += 4; egv += 6; }
                if (f < 7 && (p->bb[c][PAWN] & BB_SQUARE[(r + up) * 8 + f + 1])) { mgv += 4; egv += 6; }
            }
        }
        if (c == WHITE) { scoreMg += mgv; scoreEg += egv; mat[WHITE] += PIECE_VALUE[t]; }
        else { scoreMg -= mgv; scoreEg -= egv; mat[BLACK] += PIECE_VALUE[t]; }
    }

    /* pawn structure: doubled / isolated */
    for (side = 0; side < 2; side++) {
        int sign = side == WHITE ? 1 : -1;
        for (ff = 0; ff < 8; ff++) {
            int n = pawnsOnFile[side][ff];
            if (n > 1) { scoreMg -= sign * 12 * (n - 1); scoreEg -= sign * 18 * (n - 1); }
            if (n && !(ff > 0 && pawnsOnFile[side][ff - 1]) && !(ff < 7 && pawnsOnFile[side][ff + 1])) {
                scoreMg -= sign * 12;
                scoreEg -= sign * 14;
            }
        }
        /* bishop pair */
        if (bishopCount[side] >= 2) { scoreMg += sign * 30; scoreEg += sign * 45; }
    }

    if (phase > 24) phase = 24;

    /* king safety */
    for (side = 0; side < 2; side++) {
        int sign = side == WHITE ? 1 : -1;
        int shield = pawn_shield(p, side);
        scoreMg += sign * shield;
        if (king_exposed(p, side)) scoreMg -= sign * 22;
    }

    attackWhite = king_attack_units(p, WHITE, p->kingSq[BLACK]);
    attackBlack = king_attack_units(p, BLACK, p->kingSq[WHITE]);

    /* king danger: scaled by enemy attackers, damped by own defenders */
    {
        int dangerW = attackBlack * attackBlack * 3;
        int dangerB = attackWhite * attackWhite * 3;
        if (king_exposed(p, WHITE)) { dangerW += dangerW / 2; }
        if (king_exposed(p, BLACK)) { dangerB += dangerB / 2; }
        scoreMg -= dangerW;
        scoreMg += dangerB;
    }

    /* ---- gambit / initiative terms ---- */
    {
        int wAttack = attackWhite + popcount(p->bb[WHITE][7] & ~(p->bb[WHITE][PAWN] | p->bb[WHITE][KING])) / 2;
        int bAttack = attackBlack + popcount(p->bb[BLACK][7] & ~(p->bb[BLACK][PAWN] | p->bb[BLACK][KING])) / 2;
        int matDiffW = mat[WHITE] - mat[BLACK];   /* >0 means White is up */
        int g = EvalWeight_Gambit;
        int s = EvalWeight_Sacrifice;

        /* The gambiteer's core idea: time is worth material.  When a side
           is behind on material but ahead on activity, part of the deficit
           is refunded.  The refund is capped so we do not blunder pieces
           in a dead position. */
        if (gambitMode && matDiffW < 0) {
            int deficit = -matDiffW;
            int initiative = wAttack - bAttack;
            int refund = initiative * 9;
            if (refund < 0) refund = 0;
            if (refund > deficit * 85 / 100) refund = deficit * 85 / 100;
            refund = refund * g / 100 * s / 100;
            scoreMg += refund;
            scoreEg += refund / 3;
        } else if (gambitMode && matDiffW > 0) {
            int deficit = matDiffW;
            int initiative = bAttack - wAttack;
            int refund = initiative * 9;
            if (refund < 0) refund = 0;
            if (refund > deficit * 85 / 100) refund = deficit * 85 / 100;
            refund = refund * g / 100 * s / 100;
            scoreMg -= refund;
            scoreEg -= refund / 3;
        }

        /* Uncastled / exposed king of the opponent is worth real material. */
        if (gambitMode) {
            int bonus;
            bonus = king_exposed(p, BLACK) ? 34 * g / 100 : 0;
            bonus += popcount(p->bb[WHITE][7] & ~p->bb[BLACK][PAWN]) > 0 ? 0 : 0;
            scoreMg += bonus;
            bonus = king_exposed(p, WHITE) ? 34 * g / 100 : 0;
            scoreMg -= bonus;
        }
    }

    {
        int mg = scoreMg, eg = scoreEg;
        int mix = (mg * phase + eg * (24 - phase)) / 24;
        mix += 8; /* tempo */
        mix = mix * (100 + (p->side == WHITE ? 1 : 1)) / 100;
        if (p->side == BLACK) mix = -mix;
        /* slight contempt to keep the game alive in dead draws */
        if (p->halfmove > 60) mix = mix / 2;
        return mix;
    }
}
