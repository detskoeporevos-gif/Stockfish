/*
  GambitFish — board representation, attack tables, move making, SEE.
  GPL-3.0. See engine.h for the data layout.
*/

#include "engine.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

U64 BB_SQUARE[64];
U64 BB_RANK[8];
U64 BB_FILE[8];
U64 BB_BETWEEN[64][64];
U64 BB_LINE[64][64];
U64 KNIGHT_ATTACKS[64];
U64 KING_ATTACKS[64];
U64 PAWN_ATTACKS[2][64];
U64 RAY[64][8];
U64 ZOBRIST[2][16][64];
U64 ZOBRIST_CASTLE[16];
U64 ZOBRIST_EP[65];
U64 ZOBRIST_SIDE;
int PASSED_MASK[2][64];
int SQUARE_IS_LIGHT[64];

/* ------------------------------------------------------------------ */
/*  Magic bitboards: fixed magic numbers (plain, readable, portable)   */
/* ------------------------------------------------------------------ */

typedef struct {
    U64  mask;
    U64  magic;
    U64* attacks;
    int  shift;
} MagicBB;

static MagicBB magicRook[64];
static MagicBB magicBishop[64];

static U64 tableRook[64][4096];
static U64 tableBishop[64][4096];

static int slider_shift(int sq) {
    /* number of relevant bits depends on square: corners 12, edges 11, else 10 */
    int r = sq / 8, f = sq % 8;
    int bitsR = 64 - ((r == 0 || r == 7) ? 1 : 0) - ((f == 0 || f == 7) ? 1 : 0);
    (void)bitsR;
    return 64 - ((r == 0 || r == 7) ? 1 : 0) - ((f == 0 || f == 7) ? 1 : 0) - 1 + 0;
}

/* Deterministic PRNG (xorshift64*) for stable magic search. */
static U64 rng_state = 0x9E3779B97F4A7C15ULL;
static U64 rnd64(void) {
    U64 x = rng_state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    rng_state = x;
    return x * 0x2545F4914F6CDD1DULL;
}
static U64 rnd_sparse(void) { return rnd64() & rnd64() & rnd64(); }

U64 rook_attacks_slow(int sq, U64 occ) {
    U64 a = 0;
    int r = sq >> 3, f = sq & 7, i;
    for (i = r + 1; i <= 7; i++) { a |= BB_SQUARE[i * 8 + f]; if (occ & BB_SQUARE[i * 8 + f]) break; }
    for (i = r - 1; i >= 0; i--) { a |= BB_SQUARE[i * 8 + f]; if (occ & BB_SQUARE[i * 8 + f]) break; }
    for (i = f + 1; i <= 7; i++) { a |= BB_SQUARE[r * 8 + i]; if (occ & BB_SQUARE[r * 8 + i]) break; }
    for (i = f - 1; i >= 0; i--) { a |= BB_SQUARE[r * 8 + i]; if (occ & BB_SQUARE[r * 8 + i]) break; }
    return a;
}

U64 bishop_attacks_slow(int sq, U64 occ) {
    U64 a = 0;
    int r = sq >> 3, f = sq & 7, i, j;
    for (i = r + 1, j = f + 1; i <= 7 && j <= 7; i++, j++) { a |= BB_SQUARE[i * 8 + j]; if (occ & BB_SQUARE[i * 8 + j]) break; }
    for (i = r + 1, j = f - 1; i <= 7 && j >= 0; i++, j--) { a |= BB_SQUARE[i * 8 + j]; if (occ & BB_SQUARE[i * 8 + j]) break; }
    for (i = r - 1, j = f + 1; i >= 0 && j <= 7; i--, j++) { a |= BB_SQUARE[i * 8 + j]; if (occ & BB_SQUARE[i * 8 + j]) break; }
    for (i = r - 1, j = f - 1; i >= 0 && j >= 0; i--, j--) { a |= BB_SQUARE[i * 8 + j]; if (occ & BB_SQUARE[i * 8 + j]) break; }
    return a;
}

static U64 epochTable[64][4096];
static int epochTag = 0;

static void init_magics(void) {
    int sq;
    memset(epochTable, 0, sizeof(epochTable));
    for (sq = 0; sq < 64; sq++) {
        int isRook;
        for (isRook = 0; isRook < 2; isRook++) {
            MagicBB* m = isRook ? &magicRook[sq] : &magicBishop[sq];
            U64 edge = 0, occs[4096], refs[4096];
            int bits, n, i, b;
            int r = sq >> 3, f = sq & 7;
            /* classic CPW mask: drop the far edge squares of every ray of this square */
            edge = ((BB_RANK[0] | BB_RANK[7]) & ~BB_RANK[r]) | ((BB_FILE[0] | BB_FILE[7]) & ~BB_FILE[f]);
            m->mask = (isRook ? rook_attacks_slow(sq, 0) : bishop_attacks_slow(sq, 0)) & ~edge;
            bits = popcount(m->mask);
            m->shift = 64 - bits;
            m->attacks = isRook ? tableRook[sq] : tableBishop[sq];
            n = 1 << bits;
            for (i = 0; i < n; i++) {
                U64 subset = m->mask, occ = 0;
                for (b = 0; b < bits; b++) {
                    int s2 = pop_lsb(&subset);
                    if (i & (1 << b)) occ |= BB_SQUARE[s2];
                }
                occs[i] = occ;
                refs[i] = isRook ? rook_attacks_slow(sq, occ) : bishop_attacks_slow(sq, occ);
            }
            for (;;) {
                U64 magic = rnd_sparse();
                int ok = 1;
                epochTag++;
                for (i = 0; i < n; i++) {
                    unsigned idx = (unsigned)((occs[i] * magic) >> m->shift);
                    if (epochTable[sq][idx] != epochTag) {
                        epochTable[sq][idx] = epochTag;
                        m->attacks[idx] = refs[i];
                    } else if (m->attacks[idx] != refs[i]) { ok = 0; break; }
                }
                if (ok) { m->magic = magic; break; }
            }
        }
    }
}

static inline U64 magic_index(const MagicBB* m, U64 occ) {
    return (U64)(((occ & m->mask) * m->magic) >> m->shift);
}

U64 rook_attacks(int sq, U64 occ) { return magicRook[sq].attacks[magic_index(&magicRook[sq], occ)]; }
U64 bishop_attacks(int sq, U64 occ) { return magicBishop[sq].attacks[magic_index(&magicBishop[sq], occ)]; }
U64 queen_attacks(int sq, U64 occ) { return rook_attacks(sq, occ) | bishop_attacks(sq, occ); }

/* ------------------------------------------------------------------ */
/*  Table init                                                         */
/* ------------------------------------------------------------------ */

static int popcount64(U64 b) { return popcount(b); }

void init_engine_tables(void) {
    int sq, i, t, c;
    for (i = 0; i < 8; i++) {
        BB_RANK[i] = 0xFFULL << (i * 8);
        BB_FILE[i] = 0x0101010101010101ULL << i;
    }
    for (sq = 0; sq < 64; sq++) {
        BB_SQUARE[sq] = 1ULL << sq;
        SQUARE_IS_LIGHT[sq] = ((sq >> 3) + (sq & 7)) & 1;
    }
    for (sq = 0; sq < 64; sq++) {
        int r = sq >> 3, f = sq & 7;
        U64 k = 0, n = 0;
        int dr, df;
        for (dr = -1; dr <= 1; dr++)
            for (df = -1; df <= 1; df++) {
                int rr = r + dr, ff = f + df;
                if ((dr || df) && rr >= 0 && rr < 8 && ff >= 0 && ff < 8) k |= BB_SQUARE[rr * 8 + ff];
            }
        KING_ATTACKS[sq] = k;
        {
            int d[8][2] = {{1, 2}, {2, 1}, {2, -1}, {1, -2}, {-1, -2}, {-2, -1}, {-2, 1}, {-1, 2}};
            for (i = 0; i < 8; i++) {
                int rr = r + d[i][0], ff = f + d[i][1];
                if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) n |= BB_SQUARE[rr * 8 + ff];
            }
        }
        KNIGHT_ATTACKS[sq] = n;
        PAWN_ATTACKS[WHITE][sq] = 0;
        PAWN_ATTACKS[BLACK][sq] = 0;
        if (r < 7) {
            if (f > 0) PAWN_ATTACKS[WHITE][sq] |= BB_SQUARE[sq + 7];
            if (f < 7) PAWN_ATTACKS[WHITE][sq] |= BB_SQUARE[sq + 9];
        }
        if (r > 0) {
            if (f > 0) PAWN_ATTACKS[BLACK][sq] |= BB_SQUARE[sq - 9];
            if (f < 7) PAWN_ATTACKS[BLACK][sq] |= BB_SQUARE[sq - 7];
        }
        /* rays: 0=N 1=S 2=E 3=W 4=NE 5=NW 6=SE 7=SW, including the blocker square */
        for (i = 0; i < 8; i++) {
            U64 ray = 0;
            int rr = r, ff = f;
            for (;;) {
                switch (i) {
                case 0: rr++; break;
                case 1: rr--; break;
                case 2: ff++; break;
                case 3: ff--; break;
                case 4: rr++; ff++; break;
                case 5: rr++; ff--; break;
                case 6: rr--; ff++; break;
                case 7: rr--; ff--; break;
                }
                if (rr < 0 || rr > 7 || ff < 0 || ff > 7) break;
                ray |= BB_SQUARE[rr * 8 + ff];
            }
            RAY[sq][i] = ray;
        }
    }
    /* between/line tables */
    for (int a = 0; a < 64; a++)
        for (int b = 0; b < 64; b++) {
            BB_BETWEEN[a][b] = 0;
            BB_LINE[a][b] = 0;
            if (a == b) continue;
            int dr = (b >> 3) - (a >> 3), df = (b & 7) - (a & 7);
            if (dr == 0) {
                int lo = a < b ? a : b, hi = a < b ? b : a;
                for (int s = lo + 1; s < hi; s++) BB_BETWEEN[a][b] |= BB_SQUARE[s];
                BB_LINE[a][b] = BB_RANK[a >> 3];
            } else if (df == 0) {
                int lo = a < b ? a : b, hi = a < b ? b : a;
                for (int s = lo + 8; s < hi; s += 8) BB_BETWEEN[a][b] |= BB_SQUARE[s];
                BB_LINE[a][b] = BB_FILE[a & 7];
            } else if (abs(dr) == abs(df)) {
                int sr = dr > 0 ? 1 : -1, sf = df > 0 ? 1 : -1;
                int rr = a >> 3, ff = a & 7;
                int br = b >> 3, bf = b & 7;
                while (rr != br || ff != bf) {
                    rr += sr; ff += sf;
                    if (rr == br && ff == bf) break;
                    BB_BETWEEN[a][b] |= BB_SQUARE[rr * 8 + ff];
                }
                rr = a >> 3; ff = a & 7;
                while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { BB_LINE[a][b] |= BB_SQUARE[rr * 8 + ff]; rr += sr; ff += sf; }
                rr = (a >> 3) - sr; ff = (a & 7) - sf;
                while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) { BB_LINE[a][b] |= BB_SQUARE[rr * 8 + ff]; rr -= sr; ff -= sf; }
            }
        }
    /* passed pawn masks as bitboards kept in PASSED_MASK (cast to int is unsafe;
       computed on the fly instead) — see passed_mask() in eval.c */
    /* zobrist */
    for (c = 0; c < 2; c++)
        for (t = 0; t < 16; t++)
            for (sq = 0; sq < 64; sq++) ZOBRIST[c][t][sq] = rnd64();
    for (i = 0; i < 16; i++) ZOBRIST_CASTLE[i] = rnd64();
    for (i = 0; i < 65; i++) ZOBRIST_EP[i] = rnd64();
    ZOBRIST_SIDE = rnd64();
    init_magics();
    (void)popcount64;
}

/* ------------------------------------------------------------------ */
/*  FEN                                                                */
/* ------------------------------------------------------------------ */

static int char_to_piece(char ch) {
    switch (ch) {
    case 'P': return 1; case 'N': return 2; case 'B': return 3; case 'R': return 4; case 'Q': return 5; case 'K': return 6;
    case 'p': return 9; case 'n': return 10; case 'b': return 11; case 'r': return 12; case 'q': return 13; case 'k': return 14;
    }
    return 0;
}

static char piece_to_char(int p) {
    const char* up = ".PNBRQK";
    const char* lo = ".pnbrqk";
    if (!p) return '.';
    return (p & 8) ? lo[p & 7] : up[p & 7];
}

void set_fen(Position* p, const char* fen) {
    int sq, i;
    memset(p, 0, sizeof(*p));
    p->ep = -1;
    p->halfmove = 0;
    p->fullmove = 1;
    for (sq = 0; sq < 64; sq++) p->board[sq] = 0;
    /* board part */
    sq = 56;
    for (i = 0; fen[i] && fen[i] != ' '; i++) {
        char ch = fen[i];
        if (ch == '/') { sq -= 16; continue; }
        if (ch >= '1' && ch <= '8') { sq += ch - '0'; continue; }
        int pc = char_to_piece(ch);
        if (pc) { p->board[sq] = (int8_t)pc; sq++; }
    }
    /* side */
    while (fen[i] == ' ') i++;
    p->side = (fen[i] == 'b') ? BLACK : WHITE;
    while (fen[i] && fen[i] != ' ') i++;
    while (fen[i] == ' ') i++;
    p->castling = 0;
    if (fen[i] == '-') i++;
    else {
        for (; fen[i] && fen[i] != ' '; i++) {
            switch (fen[i]) {
            case 'K': p->castling |= 1; break;
            case 'Q': p->castling |= 2; break;
            case 'k': p->castling |= 4; break;
            case 'q': p->castling |= 8; break;
            }
        }
    }
    while (fen[i] == ' ') i++;
    if (fen[i] && fen[i] != '-') {
        int f = fen[i] - 'a', r = fen[i + 1] - '1';
        if (f >= 0 && f < 8 && r >= 0 && r < 8) p->ep = r * 8 + f;
        i += 2;
    } else if (fen[i] == '-') i++;
    while (fen[i] == ' ') i++;
    if (fen[i]) {
        int n = atoi(fen + i);
        p->halfmove = n;
        while (fen[i] && fen[i] != ' ') i++;
        while (fen[i] == ' ') i++;
        if (fen[i]) p->fullmove = atoi(fen + i);
    }
    /* rebuild bitboards and keys */
    p->key = 0;
    p->pawnKey = 0;
    p->pieceCount[0] = p->pieceCount[1] = 0;
    p->kingSq[0] = p->kingSq[1] = 0;
    memset(p->bb, 0, sizeof(p->bb));
    for (sq = 0; sq < 64; sq++) {
        int pc = p->board[sq];
        if (!pc) continue;
        int c = PIECE_COLOR(pc), t = PIECE_TYPE(pc);
        p->bb[c][t] |= BB_SQUARE[sq];
        p->bb[c][7] |= BB_SQUARE[sq];
        p->key ^= ZOBRIST[c][t][sq];
        if (t == PAWN) p->pawnKey ^= ZOBRIST[c][PAWN][sq];
        if (t != PAWN) p->pieceCount[c]++;
        if (t == KING) p->kingSq[c] = sq;
    }
    p->key ^= ZOBRIST_CASTLE[p->castling];
    if (p->ep >= 0) p->key ^= ZOBRIST_EP[p->ep];
    if (p->side == BLACK) p->key ^= ZOBRIST_SIDE;
    if (p->fullmove < 1) p->fullmove = 1;
}

void get_fen(const Position* p, char* out) {
    char* o = out;
    int r, f;
    for (r = 7; r >= 0; r--) {
        int empty = 0;
        for (f = 0; f < 8; f++) {
            int pc = p->board[r * 8 + f];
            if (!pc) empty++;
            else {
                if (empty) { *o++ = (char)('0' + empty); empty = 0; }
                *o++ = piece_to_char(pc);
            }
        }
        if (empty) *o++ = (char)('0' + empty);
        if (r) *o++ = '/';
    }
    *o++ = ' ';
    *o++ = p->side == WHITE ? 'w' : 'b';
    *o++ = ' ';
    if (!p->castling) *o++ = '-';
    else {
        if (p->castling & 1) *o++ = 'K';
        if (p->castling & 2) *o++ = 'Q';
        if (p->castling & 4) *o++ = 'k';
        if (p->castling & 8) *o++ = 'q';
    }
    *o++ = ' ';
    if (p->ep < 0) *o++ = '-';
    else { *o++ = (char)('a' + (p->ep & 7)); *o++ = (char)('1' + (p->ep >> 3)); }
    sprintf(o, " %d %d", p->halfmove, p->fullmove);
}

/* ------------------------------------------------------------------ */
/*  Attacks                                                            */
/* ------------------------------------------------------------------ */

U64 attackers_to(const Position* p, int sq, U64 occ) {
    U64 atk = 0;
    U64 occAll = p->bb[WHITE][7] | p->bb[BLACK][7];
    (void)occAll;
    atk |= KNIGHT_ATTACKS[sq] & (p->bb[WHITE][KNIGHT] | p->bb[BLACK][KNIGHT]);
    atk |= KING_ATTACKS[sq] & (p->bb[WHITE][KING] | p->bb[BLACK][KING]);
    atk |= PAWN_ATTACKS[BLACK][sq] & p->bb[WHITE][PAWN];
    atk |= PAWN_ATTACKS[WHITE][sq] & p->bb[BLACK][PAWN];
    atk |= rook_attacks(sq, occ) & (p->bb[WHITE][ROOK] | p->bb[BLACK][ROOK] | p->bb[WHITE][QUEEN] | p->bb[BLACK][QUEEN]);
    atk |= bishop_attacks(sq, occ) & (p->bb[WHITE][BISHOP] | p->bb[BLACK][BISHOP] | p->bb[WHITE][QUEEN] | p->bb[BLACK][QUEEN]);
    return atk;
}

/* is square `sq` attacked by color `by`? */
int attacks_square(const Position* p, int sq, int by) {
    U64 occ = p->bb[WHITE][7] | p->bb[BLACK][7];
    if (KNIGHT_ATTACKS[sq] & p->bb[by][KNIGHT]) return 1;
    if (KING_ATTACKS[sq] & p->bb[by][KING]) return 1;
    if (p->bb[by][PAWN] & PAWN_ATTACKS[!by][sq]) return 1;
    if (rook_attacks(sq, occ) & (p->bb[by][ROOK] | p->bb[by][QUEEN])) return 1;
    if (bishop_attacks(sq, occ) & (p->bb[by][BISHOP] | p->bb[by][QUEEN])) return 1;
    return 0;
}

int in_check(const Position* p) {
    return attacks_square(p, p->kingSq[p->side], !p->side);
}

int piece_on(const Position* p, int sq) { return p->board[sq]; }

/* ------------------------------------------------------------------ */
/*  Make / unmake                                                      */
/* ------------------------------------------------------------------ */

static void add_piece(Position* p, int sq, int pc) {
    int c = PIECE_COLOR(pc), t = PIECE_TYPE(pc);
    p->board[sq] = (int8_t)pc;
    p->bb[c][t] |= BB_SQUARE[sq];
    p->bb[c][7] |= BB_SQUARE[sq];
    p->key ^= ZOBRIST[c][t][sq];
    if (t == PAWN) p->pawnKey ^= ZOBRIST[c][PAWN][sq];
    if (t != PAWN) p->pieceCount[c]++;
    if (t == KING) p->kingSq[c] = sq;
}

static void remove_piece(Position* p, int sq) {
    int pc = p->board[sq];
    int c = PIECE_COLOR(pc), t = PIECE_TYPE(pc);
    p->board[sq] = 0;
    p->bb[c][t] &= ~BB_SQUARE[sq];
    p->bb[c][7] &= ~BB_SQUARE[sq];
    p->key ^= ZOBRIST[c][t][sq];
    if (t == PAWN) p->pawnKey ^= ZOBRIST[c][PAWN][sq];
    if (t != PAWN) p->pieceCount[c]--;
}

void make_move(Position* p, Move m, Undo* u) {
    int from = M_FROM(m), to = M_TO(m), flags = M_FLAGS(m);
    int side = p->side;
    int moved = p->board[from];

    u->move = m;
    u->captured = 0;
    u->moved = moved;
    u->castling = p->castling;
    u->ep = p->ep;
    u->halfmove = p->halfmove;
    u->key = p->key;

    p->key ^= ZOBRIST_CASTLE[p->castling];
    if (p->ep >= 0) p->key ^= ZOBRIST_EP[p->ep];
    p->ep = -1;
    p->halfmove++;

    if (flags & FLAG_EP) {
        int capSq = to + (side == WHITE ? -8 : 8);
        u->captured = p->board[capSq];
        remove_piece(p, capSq);
        p->halfmove = 0;
    } else if (p->board[to]) {
        u->captured = p->board[to];
        remove_piece(p, to);
        p->halfmove = 0;
    }

    if (flags & FLAG_CASTLE) {
        int r = side == WHITE ? 0 : 7;
        if (to > from) {
            remove_piece(p, r * 8 + 7);
            add_piece(p, r * 8 + 5, MAKE_PIECE(side, ROOK));
        } else {
            remove_piece(p, r * 8);
            add_piece(p, r * 8 + 3, MAKE_PIECE(side, ROOK));
        }
    }

    remove_piece(p, from);
    if (flags & FLAG_PROMOTION) {
        add_piece(p, to, MAKE_PIECE(side, M_PROMO(m)));
        p->halfmove = 0;
    } else {
        add_piece(p, to, moved);
        if (PIECE_TYPE(moved) == PAWN) p->halfmove = 0;
    }

    if (flags & FLAG_DOUBLE) p->ep = (from + to) >> 1;

    {
        int cr = p->castling;
        if (PIECE_TYPE(moved) == KING) cr &= ~(side == WHITE ? 3 : 12);
        if (from == 0 || to == 0) cr &= ~2;
        if (from == 7 || to == 7) cr &= ~1;
        if (from == 56 || to == 56) cr &= ~8;
        if (from == 63 || to == 63) cr &= ~4;
        p->castling = cr;
    }

    p->side = !side;
    p->key ^= ZOBRIST_SIDE;
    p->key ^= ZOBRIST_CASTLE[p->castling];
    if (p->ep >= 0) p->key ^= ZOBRIST_EP[p->ep];
    if (side == BLACK) p->fullmove++;
}

void unmake_move(Position* p, Move m, Undo* u) {
    int from = M_FROM(m), to = M_TO(m), flags = M_FLAGS(m);
    int side = !p->side;

    if (side == BLACK) p->fullmove--;
    p->side = side;

    remove_piece(p, to);
    add_piece(p, from, u->moved);

    if (flags & FLAG_CASTLE) {
        int r = side == WHITE ? 0 : 7;
        if (to > from) {
            remove_piece(p, r * 8 + 5);
            add_piece(p, r * 8 + 7, MAKE_PIECE(side, ROOK));
        } else {
            remove_piece(p, r * 8 + 3);
            add_piece(p, r * 8, MAKE_PIECE(side, ROOK));
        }
    }

    if (u->captured) {
        int capSq = to;
        if (flags & FLAG_EP) capSq = to + (side == WHITE ? -8 : 8);
        add_piece(p, capSq, u->captured);
    }

    p->castling = u->castling;
    p->ep = u->ep;
    p->halfmove = u->halfmove;
    p->key = u->key;
}

/* ------------------------------------------------------------------ */
/*  SEE — static exchange evaluation on a square                       */
/* ------------------------------------------------------------------ */

static const int SEE_VALUE[8] = {0, 100, 320, 330, 500, 900, 20000, 0};

/* Сколько материала выиграет сторона `side`, продолжая взятия на поле `to`.
   targetVal — стоимость фигуры, которая стоит на `to` и будет съедена. */
static int see_rec(const Position* p, int to, int side, int targetVal, U64 occ) {
    U64 att = attackers_to(p, to, occ) & occ & p->bb[side][7];
    int bestSq = -1, bestVal = 1000000, gain;
    U64 b = att;
    if (!att) return 0;
    while (b) {
        int sq = pop_lsb(&b);
        int t = PIECE_TYPE(p->board[sq]);
        int v = SEE_VALUE[t ? t : PAWN];
        if (v < bestVal) { bestVal = v; bestSq = sq; }
    }
    occ &= ~BB_SQUARE[bestSq];
    gain = targetVal - see_rec(p, to, !side, bestVal, occ);
    return gain > 0 ? gain : 0;
}

int see(const Position* p, Move m) {
    int from = M_FROM(m), to = M_TO(m), flags = M_FLAGS(m);
    U64 occ = (p->bb[WHITE][7] | p->bb[BLACK][7]) & ~BB_SQUARE[from];
    if (flags & FLAG_EP) occ &= ~BB_SQUARE[to + (p->side == WHITE ? -8 : 8)];
    int targetVal, myVal, rec;

    targetVal = p->board[to] ? SEE_VALUE[PIECE_TYPE(p->board[to])] : 0;
    if (flags & FLAG_EP) targetVal = SEE_VALUE[PAWN];
    myVal = SEE_VALUE[PIECE_TYPE(p->board[from])];
    if (flags & FLAG_PROMOTION) {
        targetVal += SEE_VALUE[M_PROMO(m)] - SEE_VALUE[PAWN];
        myVal = SEE_VALUE[PAWN];
    }
    if (!targetVal) return 0;   /* тихий ход — материального выигрыша нет */
    rec = see_rec(p, to, !p->side, myVal, occ);
    return targetVal - rec;
}

/* ------------------------------------------------------------------ */
/*  UCI helpers                                                        */
/* ------------------------------------------------------------------ */

int move_to_uci(Move m, char* out) {
    static const char* promoChars = "  nbrq";
    int from = M_FROM(m), to = M_TO(m);
    if (!m) { out[0] = '0'; out[1] = '0'; out[2] = '0'; out[3] = '0'; out[4] = 0; return 4; }
    out[0] = (char)('a' + (from & 7));
    out[1] = (char)('1' + (from >> 3));
    out[2] = (char)('a' + (to & 7));
    out[3] = (char)('1' + (to >> 3));
    out[4] = 0;
    if (M_FLAGS(m) & FLAG_PROMOTION) {
        out[4] = promoChars[M_PROMO(m)];
        out[5] = 0;
    }
    return (int)strlen(out);
}

Move parse_move(const Position* p, const char* str) {
    Move list[MAX_MOVES];
    int n = legal_moves((Position*)p, list);
    int i;
    for (i = 0; i < n; i++) {
        char buf[8];
        move_to_uci(list[i], buf);
        if (!strcmp(buf, str)) return list[i];
    }
    /* allow "e1g1" style for castling written as "e1h1" */
    return 0;
}
