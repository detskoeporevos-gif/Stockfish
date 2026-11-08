/*
  GambitFish — a from-scratch, WASM-targeted chess engine specialised in
  gambit play and sacrifices. Derived in spirit from Stockfish (GPL-3.0),
  this file is part of GambitFish and distributed under GPL-3.0.
*/

#ifndef GAMBITFISH_ENGINE_H
#define GAMBITFISH_ENGINE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint64_t U64;
typedef uint32_t Move;
typedef int32_t  Value;

/* ---------------- constants ---------------- */
enum { WHITE = 0, BLACK = 1 };
enum { PAWN = 1, KNIGHT, BISHOP, ROOK, QUEEN, KING };
enum { EMPTY = 0 };
#define MAKE_PIECE(c, t) ((c) == WHITE ? (t) : (t) | 8)
#define PIECE_TYPE(p) ((p) & 7)
#define PIECE_COLOR(p) (((p) & 8) ? BLACK : WHITE)
#define IS_WP(p) ((p) >= 1 && (p) <= 6)
#define IS_BP(p) ((p) >= 9 && (p) <= 14)

enum {
    FLAG_CAPTURE    = 1,
    FLAG_EP         = 2,
    FLAG_CASTLE     = 4,
    FLAG_DOUBLE     = 8,
    FLAG_PROMOTION  = 16
};

#define MOVE(f, t, pr, fl) ((Move)((f) | ((t) << 6) | ((pr) << 12) | ((fl) << 15)))
#define M_FROM(m)    ((int)((m) & 63))
#define M_TO(m)      ((int)(((m) >> 6) & 63))
#define M_PROMO(m)   ((int)(((m) >> 12) & 7))
#define M_FLAGS(m)   ((int)((m) >> 15))
#define M_IS_CAP(m)  (((m) >> 15) & FLAG_CAPTURE)
#define M_IS_EP(m)   (((m) >> 15) & FLAG_EP)
#define M_IS_CASTLE(m) (((m) >> 15) & FLAG_CASTLE)

#define MAX_PLY   128
#define MAX_MOVES 256

#define VALUE_INFINITE 32000
#define VALUE_MATE     31000
#define MATE_IN_MAX    (VALUE_MATE - MAX_PLY)
#define VALUE_NONE     32001

#define SQ_A1 0
#define SQ_H8 63

/* ---------------- position ---------------- */
typedef struct {
    int8_t  board[64];      /* 0 empty, 1..6 white P,N,B,R,Q,K, 9..14 black */
    U64     bb[2][8];       /* [color][type 1..6] + [color][7] = occupancy */
    int     side;           /* WHITE / BLACK */
    int     castling;       /* bit0 W-oo, bit1 W-ooo, bit2 B-oo, bit3 B-ooo */
    int     ep;             /* en-passant target square or -1 */
    int     halfmove;
    int     fullmove;
    U64     key;            /* zobrist */
    U64     pawnKey;
    int     pieceCount[2];  /* number of non-pawn pieces incl. king */
    int     kingSq[2];      /* cached king squares */
} Position;

typedef struct {
    Move move;
    int  captured;   /* piece code or 0 */
    int  moved;
    int  castling;
    int  ep;
    int  halfmove;
    U64  key;
} Undo;

/* ---------------- globals ---------------- */
extern U64 BB_SQUARE[64];
extern U64 BB_RANK[8];
extern U64 BB_FILE[8];
extern U64 BB_BETWEEN[64][64];
extern U64 BB_LINE[64][64];
extern U64 KNIGHT_ATTACKS[64];
extern U64 KING_ATTACKS[64];
extern U64 PAWN_ATTACKS[2][64];
extern U64 RAY[64][8];     /* 0=N 1=S 2=E 3=W 4=NE 5=NW 6=SE 7=SW */
extern U64 ZOBRIST[2][16][64];
extern U64 ZOBRIST_CASTLE[16];
extern U64 ZOBRIST_EP[65];
extern U64 ZOBRIST_SIDE;
extern int   PASSED_MASK[2][64];
extern int   SQUARE_IS_LIGHT[64];

void init_engine_tables(void);

/* bit helpers */
static inline int lsb(U64 b) { return __builtin_ctzll(b); }
static inline int msb(U64 b) { return 63 - __builtin_clzll(b); }
static inline int popcount(U64 b) { return __builtin_popcountll(b); }
static inline int pop_lsb(U64* b) { int s = lsb(*b); *b &= *b - 1; return s; }

/* board.c */
U64  rook_attacks(int sq, U64 occ);
U64  bishop_attacks(int sq, U64 occ);
U64  queen_attacks(int sq, U64 occ);
int  attacks_square(const Position* p, int sq, int byColor);
int  in_check(const Position* p);
int  legal_moves(Position* p, Move* out);
int  is_legal(const Position* p, Move m);
int  piece_on(const Position* p, int sq);
void set_fen(Position* p, const char* fen);
void get_fen(const Position* p, char* out);
void make_move(Position* p, Move m, Undo* u);
void unmake_move(Position* p, Move m, Undo* u);
U64  attackers_to(const Position* p, int sq, U64 occ);
int  see(const Position* p, Move m);
int  move_to_uci(Move m, char* out);
Move parse_move(const Position* p, const char* str);

/* movegen.c */
int  gen_moves(const Position* p, Move* out);       /* pseudo-legal */
int  gen_tactical(const Position* p, Move* out);    /* captures + promotions */
int  gen_quiet(const Position* p, Move* out, int skipUnderpromo);

/* eval.c */
int  evaluate(const Position* p, int gambitMode);
extern int EvalWeight_Gambit;      /* 0..200 (100 = normal) */
extern int EvalWeight_Sacrifice;   /* appetite for material imbalance */
int  evaluate_material(const Position* p);

/* search.c */
typedef struct {
    int  depth;
    int  seldepth;
    int  score;
    Move best;
    int  pvLen;
    Move pv[MAX_PLY];
    U64  nodes;
    int  timeMs;
    int  bookMove;      /* 1 if best came from book */
} SearchResult;

void search_init(void);
void search_go(Position* p, int maxTimeMs, int depthLimit, int gambitMode, int contempt);
extern SearchResult SearchBest;
extern volatile int SearchStop;
extern int UseOpeningBook;
int  probe_book(const Position* p, Move* out);
void gambit_book_init(void);
const char* gf_search(int maxTimeMs, int depth, int gambitMode, int contempt);
void gf_init(void);


/* gambit.c — opening book + gambit knowledge tables */
int  gambit_book_probe(const Position* p, Move* out);

#ifdef __cplusplus
}
#endif

#endif
