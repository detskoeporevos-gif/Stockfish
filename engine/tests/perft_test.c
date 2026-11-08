#include "../engine.h"
#include <stdio.h>
#include <string.h>
#include <time.h>

static U64 perft(Position* p, int depth) {
    Move list[MAX_MOVES * 4];
    Undo u;
    int n, i;
    U64 nodes = 0;
    if (depth == 0) return 1;
    n = gen_moves(p, list);
    for (i = 0; i < n; i++) {
        make_move(p, list[i], &u);
        if (!attacks_square(p, p->kingSq[!p->side], p->side))
            nodes += depth == 1 ? 1 : perft(p, depth - 1);
        unmake_move(p, list[i], &u);
    }
    return nodes;
}

int main(void) {
    const char* fens[6] = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
        "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
        "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
        "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
        "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10",
    };
    U64 expect[6][6] = {
        {20, 400, 8902, 197281, 4865609, 119060324},
        {48, 2039, 97862, 4085603, 193690690, 0},
        {14, 191, 2812, 43238, 674624, 11030083},
        {6, 264, 9467, 422333, 15833292, 706045033},
        {44, 1486, 62379, 2103487, 89941194, 0},
        {46, 2079, 89890, 3894594, 164075551, 0},
    };
    int f, d, fail = 0;
    Position p;
    init_engine_tables();
    for (f = 0; f < 6; f++) {
        for (d = 1; d <= 5; d++) {
            U64 n;
            if (!expect[f][d-1]) break;
            set_fen(&p, fens[f]);
            n = perft(&p, d);
            if (n != expect[f][d-1]) {
                printf("FAIL fen%d depth%d: got %llu expected %llu\n", f, d, (unsigned long long)n, (unsigned long long)expect[f][d-1]);
                fail = 1;
            } else printf("ok fen%d depth%d = %llu\n", f, d, (unsigned long long)n);
            if (d >= 4) break;
        }
    }
    /* FEN roundtrip */
    set_fen(&p, fens[1]);
    {
        char buf[128];
        get_fen(&p, buf);
        if (strcmp(buf, fens[1])) printf("FEN mismatch: %s\n", buf);
        else printf("fen roundtrip ok\n");
    }
    printf(fail ? "PERFT FAILED\n" : "PERFT OK\n");
    return fail;
}
