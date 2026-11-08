/* GambitFish native CLI: search a FEN, self-play, run mate tests. */
#include "engine.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/time.h>

static void print_move(Move m) { char b[8]; move_to_uci(m, b); printf("%s", b); }

static double now_s(void) {
    struct timeval tv;
    gettimeofday(&tv, 0);
    return tv.tv_sec + tv.tv_usec / 1e6;
}

int main(int argc, char** argv) {
    init_engine_tables();
    search_init();
    gambit_book_init();

    if (argc < 2) {
        printf("usage: %s fen [movetime] [depth] [gambit]\n", argv[0]);
        printf("       %s --mate\n", argv[0]);
        return 0;
    }
    if (!strcmp(argv[1], "--mate")) {
        const char* tests[] = {
            "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",           /* Ra8# */
            "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4", /* mate in 0? */
            "2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1",       /* mate in 3 */
            "8/8/8/8/8/6k1/6p1/6K1 w - - 0 1",                /* draw-ish */
        };
        int t;
        for (t = 0; t < 4; t++) {
            Position p;
            set_fen(&p, tests[t]);
            search_go(&p, 5000, 12, 1, 0);
            printf("test%d fen=%s\n  best=", t, tests[t]);
            print_move(SearchBest.best);
            printf(" score=%d depth=%d nodes=%llu time=%dms\n", SearchBest.score, SearchBest.depth,
                   (unsigned long long)SearchBest.nodes, SearchBest.timeMs);
        }
        return 0;
    }

    {
        Position p;
        int movetime = argc > 2 ? atoi(argv[2]) : 1000;
        int depth = argc > 3 ? atoi(argv[3]) : 64;
        int gambit = argc > 4 ? atoi(argv[4]) : 1;
        set_fen(&p, argv[1]);
        {
            Move list[MAX_MOVES * 2];
            int n = legal_moves(&p, list);
            if (!n) { printf("no legal moves\n"); return 0; }
        }
        search_go(&p, movetime, depth, gambit, 0);
        printf("best ");
        print_move(SearchBest.best);
        printf("\nscore cp %d\ndepth %d\nseldepth %d\nnodes %llu\ntime %d\npv ",
               SearchBest.score, SearchBest.depth, SearchBest.seldepth,
               (unsigned long long)SearchBest.nodes, SearchBest.timeMs);
        {
            int i;
            for (i = 0; i < SearchBest.pvLen; i++) { print_move(SearchBest.pv[i]); printf(" "); }
        }
        printf("\n");
    }
    return 0;
}
