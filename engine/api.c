/*
  GambitFish — C ABI used by the WASM build and by the native bench tool.
  GPL-3.0.
*/

#include "engine.h"
#include <string.h>
#include <stdlib.h>
#include <time.h>

static Position GPos;
static char LineBuf[65536];
static char FenBuf[256];

void gf_init(void) {
    init_engine_tables();
    search_init();
    gambit_book_init();
    set_fen(&GPos, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
}

void gf_set_fen(const char* fen) {
    set_fen(&GPos, fen);
}

void gf_play_uci(const char* uci) {
    Move m = parse_move(&GPos, uci);
    if (m) {
        Undo u;
        make_move(&GPos, m, &u);
    }
}

/* Apply a sequence of UCI moves separated by spaces. Returns moves applied. */
int gf_play_line(const char* line) {
    int count = 0;
    char buf[8];
    int bi = 0;
    const char* s = line;
    set_fen(&GPos, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    while (*s) {
        if (*s == ' ') {
            if (bi) { buf[bi] = 0; { Move m = parse_move(&GPos, buf); if (!m) return count; { Undo u; make_move(&GPos, m, &u); count++; } } }
            bi = 0;
        } else if (bi < 7) buf[bi++] = *s;
        s++;
    }
    if (bi) { buf[bi] = 0; { Move m = parse_move(&GPos, buf); if (!m) return count; { Undo u; make_move(&GPos, m, &u); count++; } } }
    return count;
}

const char* gf_get_fen(void) {
    get_fen(&GPos, FenBuf);
    return FenBuf;
}

int gf_in_check(void) { return in_check(&GPos); }
int gf_side(void) { return GPos.side; }

int gf_legal_count(void) {
    Move list[MAX_MOVES * 2];
    return legal_moves(&GPos, list);
}

const char* gf_legal_moves(void) {
    Move list[MAX_MOVES * 2];
    int n = legal_moves(&GPos, list);
    int i;
    char* o = LineBuf;
    o[0] = 0;
    for (i = 0; i < n; i++) {
        char b[8];
        move_to_uci(list[i], b);
        if (i) { *o++ = ' '; }
        strcpy(o, b);
        o += strlen(b);
    }
    return LineBuf;
}

static const char* pv_to_string(void) {
    char* o = LineBuf;
    int i;
    o[0] = 0;
    for (i = 0; i < SearchBest.pvLen && i < 64; i++) {
        char b[8];
        move_to_uci(SearchBest.pv[i], b);
        if (i) { *o++ = ' '; }
        strcpy(o, b);
        o += strlen(b);
    }
    return LineBuf;
}

/* Search. Returns PV as a string ("e2e4 e7e5 ..."), score and depth are
   written through the out pointers. */
const char* gf_search(int maxTimeMs, int depth, int gambitMode, int contempt) {
    search_go(&GPos, maxTimeMs, depth, gambitMode, contempt);
    return pv_to_string();
}

/* MultiPV: 0 — вторая линия не нужна, 1 — считать и её. */
void gf_set_multipv(int on) { MultiPV = on ? 2 : 1; }

/* Вторая линия последнего поиска: "uci ..." (пусто, если её нет). */
const char* gf_last_pv2(void) {
    static char buf[512];
    char* o = buf;
    int i;
    o[0] = 0;
    for (i = 0; i < SearchBest.pv2Len && i < 16; i++) {
        char b[8];
        move_to_uci(SearchBest.pv2[i], b);
        if (i) { *o++ = ' '; }
        strcpy(o, b);
        o += strlen(b);
    }
    return buf;
}

int gf_last_score2(void) { return SearchBest.hasSecond ? SearchBest.score2 : 0; }
int gf_last_has_second(void) { return SearchBest.hasSecond; }

int gf_last_score(void) {
    int s = SearchBest.score;
    return s;
}

int gf_last_depth(void) { return SearchBest.depth; }
int gf_last_seldepth(void) { return SearchBest.seldepth; }
int gf_last_nodes(void) { return (int)(SearchBest.nodes & 0x7fffffff); }
int gf_last_time(void) { return SearchBest.timeMs; }
int gf_last_from_book(void) { return SearchBest.bookMove; }
int gf_last_best(void) { return (int)SearchBest.best; }

/* Play the engine's best move on the internal board and return its uci. */
const char* gf_play_best(int maxTimeMs, int depth, int gambitMode, int contempt) {
    static char buf[8];
    Move m;
    search_go(&GPos, maxTimeMs, depth, gambitMode, contempt);
    m = SearchBest.best;
    if (!m) { buf[0] = 0; return buf; }
    move_to_uci(m, buf);
    {
        Undo u;
        if (parse_move(&GPos, buf)) make_move(&GPos, parse_move(&GPos, buf), &u);
    }
    return buf;
}

/* Evaluate the current position from the side-to-move perspective. */
int gf_evaluate(int gambitMode) { return evaluate(&GPos, gambitMode); }
int gf_material(void) { return evaluate_material(&GPos); }

/* Static exchange evaluation for a move given in UCI. */
int gf_see(const char* uci) {
    Move m = parse_move(&GPos, uci);
    if (!m) return 0;
    return see(&GPos, m);
}

int gf_is_capture(const char* uci) {
    Move m = parse_move(&GPos, uci);
    if (!m) return 0;
    return (M_FLAGS(m) & FLAG_CAPTURE) ? 1 : 0;
}

/* Piece placement as a 64 character string, a1 first. */
const char* gf_board_string(void) {
    static char out[65];
    static const char* chars = ".PNBRQK..pnbrqk.";
    int i;
    for (i = 0; i < 64; i++) {
        int pc = GPos.board[i];
        out[i] = pc ? chars[pc] : '.';
    }
    out[64] = 0;
    return out;
}

/* piece code at square (a1=0) */
int gf_piece_at(int sq) { return (sq >= 0 && sq < 64) ? GPos.board[sq] : 0; }

/* perft for testing from JS */
unsigned int gf_perft(int depth) {
    /* simple recursive perft on a copy */
    extern unsigned int gf_perft_rec(void*, int);
    return gf_perft_rec(&GPos, depth);
}

unsigned int gf_perft_rec(void* posPtr, int depth) {
    Position* p = (Position*)posPtr;
    Move list[MAX_MOVES * 2];
    Undo u;
    int n, i;
    unsigned int nodes = 0;
    if (depth == 0) return 1;
    n = gen_moves(p, list);
    for (i = 0; i < n; i++) {
        make_move(p, list[i], &u);
        if (!attacks_square(p, p->kingSq[!p->side], p->side))
            nodes += depth == 1 ? 1 : gf_perft_rec(p, depth - 1);
        unmake_move(p, list[i], &u);
    }
    return nodes;
}

void gf_set_gambit_weights(int gambit, int sacrifice) {
    EvalWeight_Gambit = gambit;
    EvalWeight_Sacrifice = sacrifice;
}

void gf_set_book(int on) { UseOpeningBook = on ? 1 : 0; }

/* Make the engine move (must be legal in the current position). */
int gf_make_move(const char* uci) {
    Move m = parse_move(&GPos, uci);
    if (!m) return 0;
    {
        Undo u;
        make_move(&GPos, m, &u);
    }
    return 1;
}

/* undo support: keep a small stack */
static Undo UndoStack[1024];
static Move UndoMove[1024];
static int UndoTop = 0;

void gf_reset_undo(void) { UndoTop = 0; }
