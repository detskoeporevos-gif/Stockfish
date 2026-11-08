/*
  GambitFish — opening book of gambits. The book is generated from
  web/src/data/gambits.js by tools/gen_book.cjs into gambit_book.inc.
  Each entry is a move sequence starting from the initial position.
  GPL-3.0.
*/

#include "engine.h"
#include <string.h>
#include <stdlib.h>

typedef struct {
    const char* moves;   /* space separated UCI moves from the start position */
    int   weight;
} BookLine;

#ifdef GAMBITFISH_HAS_BOOK
#include "gambit_book.inc"
#else
static const BookLine BOOK_LINES[] = {{"", 0}};
static const int BOOK_LINE_COUNT = 0;
#endif

#define BOOK_TABLE_SIZE 8192

typedef struct {
    U64  key;
    Move move;
} BookEntry;

static BookEntry bookTable[BOOK_TABLE_SIZE];
static int bookReady = 0;
static int bookEntries = 0;

static void book_add(U64 key, Move m) {
    unsigned idx = (unsigned)(key & (BOOK_TABLE_SIZE - 1));
    unsigned start = idx;
    do {
        if (bookTable[idx].key == key) return;   /* приоритет у первых (главных) линий */
        if (bookTable[idx].key == 0) {
            bookTable[idx].key = key ? key : 1;
            bookTable[idx].move = m;
            bookEntries++;
            return;
        }
        idx = (idx + 1) & (BOOK_TABLE_SIZE - 1);
    } while (idx != start);
}

void gambit_book_init(void) {
    int i;
    if (bookReady) return;
    bookReady = 1;
    memset(bookTable, 0, sizeof(bookTable));
    for (i = 0; i < BOOK_LINE_COUNT; i++) {
        Position p;
        const char* s = BOOK_LINES[i].moves;
        char buf[8];
        int bi;
        set_fen(&p, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        while (*s) {
            Move m;
            bi = 0;
            while (*s && *s != ' ' && bi < 7) buf[bi++] = *s++;
            buf[bi] = 0;
            while (*s == ' ') s++;
            if (!bi) break;
            m = parse_move(&p, buf);
            if (!m) break;
            book_add(p.key, m);
            {
                Undo u;
                make_move(&p, m, &u);
            }
        }
    }
}

int gambit_book_probe(const Position* p, Move* out) {
    unsigned idx;
    unsigned start;
    if (!bookReady) gambit_book_init();
    if (!bookEntries) return 0;
    idx = (unsigned)(p->key & (BOOK_TABLE_SIZE - 1));
    start = idx;
    do {
        if (bookTable[idx].key == p->key) {
            *out = bookTable[idx].move;
            return 1;
        }
        if (bookTable[idx].key == 0) return 0;
        idx = (idx + 1) & (BOOK_TABLE_SIZE - 1);
    } while (idx != start);
    return 0;
}

int probe_book(const Position* p, Move* out) { return gambit_book_probe(p, out); }
