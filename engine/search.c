/*
  GambitFish — search: PVS + TT + null move + LMR + killers/history,
  quiescence with SEE pruning, plus gambit-mode heuristics. GPL-3.0.
*/

#include "engine.h"
#include <string.h>
#include <stdlib.h>
#include <time.h>

#define TT_SIZE (1u << 20)
#define TT_MASK (TT_SIZE - 1)

typedef struct {
    U64  key;
    int32_t score;
    Move move;
    int16_t depth;
    uint8_t flag;   /* 0 empty, 1 exact, 2 alpha, 3 beta */
    uint8_t age;
} TTEntry;

static TTEntry TT[TT_SIZE];
static int TT_age = 0;

SearchResult SearchBest;
volatile int SearchStop = 0;
int UseOpeningBook = 1;
static int GambitMode = 1;
static int Contempt = 0;
static int64_t StartTime = 0;
static int TimeLimit = 0;
static U64 Nodes = 0;
static int SelDepth = 0;

static Move Killers[MAX_PLY][2];
static int History[2][64][64];
static Move CounterMove[2][64][64];
static U64 PvTable[MAX_PLY][MAX_PLY];
static int PvLen[MAX_PLY];

#if defined(__wasm__) && !defined(__wasi__)
extern int64_t gf_now_ms(void);
#else
#include <sys/time.h>
static int64_t gf_now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, 0);
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}
#endif

static int64_t now_ms(void) { return gf_now_ms(); }

void search_init(void) {
    memset(TT, 0, sizeof(TT));
    memset(Killers, 0, sizeof(Killers));
    memset(History, 0, sizeof(History));
    memset(CounterMove, 0, sizeof(CounterMove));
}

static inline int score_of_piece(int pc) {
    static const int V[8] = {0, 100, 320, 330, 500, 900, 20000, 0};
    return pc ? V[PIECE_TYPE(pc)] : 0;
}

/* MVV-LVA plus gambit appetite: when we are the gambiteer, capturing
   material is slightly less attractive if it forces us to release the
   initiative -- handled in eval, here we just reward captures. */
static int move_score(const Position* p, Move m, int ply, Move ttMove, Move prevMove) {
    int sc = 0;
    if (m == ttMove) return 1000000;
    if (M_FLAGS(m) & FLAG_CAPTURE) {
        int victim = p->board[M_TO(m)];
        if (M_FLAGS(m) & FLAG_EP) victim = MAKE_PIECE(!p->side, PAWN);
        sc = 100000 + score_of_piece(victim) * 8 - score_of_piece(p->board[M_FROM(m)]);
        if (M_FLAGS(m) & FLAG_PROMOTION) sc += 90000 + M_PROMO(m) * 100;
    } else if (M_FLAGS(m) & FLAG_PROMOTION) {
        sc = 90000 + M_PROMO(m) * 100;
    } else {
        if (m == Killers[ply][0]) sc = 80000;
        else if (m == Killers[ply][1]) sc = 70000;
        else {
            sc = History[p->side][M_FROM(m)][M_TO(m)];
            if (prevMove && CounterMove[p->side][M_FROM(prevMove)][M_TO(prevMove)] == m) sc += 20000;
        }
    }
    return sc;
}

static void sort_moves(const Position* p, Move* list, int* scores, int n) {
    int i, j;
    for (i = 1; i < n; i++) {
        Move m = list[i];
        int s = scores[i];
        for (j = i - 1; j >= 0 && scores[j] < s; j--) {
            list[j + 1] = list[j];
            scores[j + 1] = scores[j];
        }
        list[j + 1] = m;
        scores[j + 1] = s;
    }
}

static int is_repetition(const Position* p, U64* stack, int count) {
    int i;
    for (i = count - 2; i >= 0 && i >= count - p->halfmove - 1; i -= 2)
        if (stack[i] == p->key) return 1;
    return 0;
}

static int quiesce(Position* p, int alpha, int beta, int ply) {
    Move moves[MAX_MOVES * 2];
    int scores[MAX_MOVES * 2];
    int n, i;
    int stand, best;
    int inChk;

    Nodes++;
    if ((Nodes & 1023) == 0) {
        if (TimeLimit && now_ms() - StartTime >= TimeLimit) SearchStop = 1;
        if (SearchStop) return 0;
    }
    if (ply > SelDepth) SelDepth = ply;

    inChk = in_check(p);
    stand = inChk ? -VALUE_INFINITE : evaluate(p, GambitMode);
    if (!inChk) {
        if (stand >= beta) return stand;
        if (stand > alpha) alpha = stand;
        best = stand;
    } else best = -VALUE_INFINITE;

    if (ply >= MAX_PLY - 4) return inChk ? 0 : stand;

    n = inChk ? gen_moves(p, moves) : gen_tactical(p, moves);
    for (i = 0; i < n; i++) scores[i] = move_score(p, moves[i], ply, 0, 0);
    sort_moves(p, moves, scores, n);

    {
        int legalCount = 0;
        for (i = 0; i < n; i++) {
            Move m = moves[i];
            Undo u;
            Position* pp = p;
            pp->halfmove = pp->halfmove;
            make_move(p, m, &u);
            if (attacks_square(p, p->kingSq[!p->side], p->side)) { unmake_move(p, m, &u); continue; }
            legalCount++;
            if (!inChk) {
                if ((M_FLAGS(m) & FLAG_CAPTURE) && see(p, m) < 0) { unmake_move(p, m, &u); continue; }
            }
            {
                int v = -quiesce(p, -beta, -alpha, ply + 1);
                unmake_move(p, m, &u);
                if (SearchStop) return 0;
                if (v > best) {
                    best = v;
                    if (v > alpha) {
                        alpha = v;
                        if (v >= beta) return v;
                    }
                }
            }
        }
        (void)legalCount;
    }
    if (inChk && best == -VALUE_INFINITE) return -VALUE_MATE + ply;
    return best;
}

static int null_move_ok(const Position* p, int depth, int inChk, int ply) {
    if (inChk || depth < 3 || ply < 1) return 0;
    if (popcount(p->bb[p->side][7]) <= 6) return 0;
    /* zugzwang guard: no pawns and low material */
    if (!p->bb[p->side][PAWN] && evaluate_material(p) * (p->side == WHITE ? 1 : -1) > 300) return 0;
    return 1;
}

static int search(Position* p, int depth, int alpha, int beta, int ply, int allowNull, Move prevMove, U64* keyStack, int stackSize) {
    Move moves[MAX_MOVES * 2], bestMove = 0, ttMove = 0;
    int scores[MAX_MOVES * 2];
    int n, i, best = -VALUE_INFINITE, origAlpha = alpha;
    int inChk, ttScore, ttDepth, ttFlag, ttHit;
    TTEntry* te;
    int pvNode = beta - alpha > 1;

    if (SearchStop) return 0;
    if (ply >= MAX_PLY - 2) return evaluate(p, GambitMode);

    Nodes++;
    if ((Nodes & 1023) == 0) {
        if (TimeLimit && now_ms() - StartTime >= TimeLimit) { SearchStop = 1; return 0; }
    }
    if (ply > SelDepth) SelDepth = ply;

    for (i = 0; i < ply; i++) PvLen[i] = PvLen[i];
    PvLen[ply] = ply;

    /* draw detection */
    if (ply > 0) {
        if (p->halfmove >= 100) return Contempt;
        if (is_repetition(p, keyStack, stackSize)) return 0;
    }
    if (p->pieceCount[WHITE] <= 1 && p->pieceCount[BLACK] <= 1) return 0;

    memset(&PvTable[ply][ply], 0, sizeof(U64));
    PvTable[ply][ply] = 0;

    inChk = in_check(p);
    if (inChk) depth++;

    if (depth <= 0) return quiesce(p, alpha, beta, ply);

    /* mate distance pruning */
    if (alpha < -VALUE_MATE + ply) alpha = -VALUE_MATE + ply;
    if (beta > VALUE_MATE - ply - 1) beta = VALUE_MATE - ply - 1;
    if (alpha >= beta) return alpha;

    /* transposition table */
    te = &TT[p->key & TT_MASK];
    ttHit = (te->key == p->key && te->flag != 0);
    ttMove = ttHit ? te->move : 0;
    if (ttHit) {
        ttScore = te->score;
        ttDepth = te->depth;
        ttFlag = te->flag;
        if (ttScore > MATE_IN_MAX) ttScore -= ply;
        else if (ttScore < -MATE_IN_MAX) ttScore += ply;
        if (!pvNode && ttDepth >= depth) {
            if (ttFlag == 1) return ttScore;
            if (ttFlag == 2 && ttScore >= beta) return ttScore;
            if (ttFlag == 3 && ttScore <= alpha) return ttScore;
        }
    }

    /* static eval for pruning decisions */
    {
        int staticEval = inChk ? -VALUE_INFINITE : evaluate(p, GambitMode);

        /* reverse futility pruning */
        if (!pvNode && !inChk && depth <= 6 && staticEval - 85 * depth >= beta && abs(beta) < MATE_IN_MAX)
            return staticEval;

        /* razoring */
        if (!pvNode && !inChk && depth <= 3 && staticEval + 300 * depth < alpha) {
            int v = quiesce(p, alpha, beta, ply);
            if (v < alpha) return v;
        }

        /* null move pruning */
        if (allowNull && null_move_ok(p, depth, inChk, ply) && staticEval >= beta) {
            Undo u;
            int R = depth > 6 ? 3 : 2;
            int v;
            U64 savedKey = p->key, savedEp = (U64)p->ep;
            int savedHalf = p->halfmove;
            p->side = !p->side;
            p->ep = -1;
            p->key ^= ZOBRIST_SIDE;
            p->halfmove = 0;
            keyStack[stackSize] = p->key;
            v = -search(p, depth - R - 1, -beta, -beta + 1, ply + 1, 0, 0, keyStack, stackSize + 1);
            p->side = !p->side;
            p->key = savedKey;
            p->ep = (int)savedEp;
            p->halfmove = savedHalf;
            if (SearchStop) return 0;
            if (v >= beta) return v > MATE_IN_MAX ? beta : v;
        }

        /* futility pruning at shallow depth */
        if (!pvNode && !inChk && depth <= 4 && staticEval + 120 * depth <= alpha && abs(alpha) < MATE_IN_MAX) {
            int v = quiesce(p, alpha, beta, ply);
            if (v <= alpha) return v;
        }
    }

    n = gen_moves(p, moves);
    for (i = 0; i < n; i++) scores[i] = move_score(p, moves[i], ply, ttMove, prevMove);
    sort_moves(p, moves, scores, n);

    {
        int legal = 0, moveCount = 0;
        for (i = 0; i < n; i++) {
            Move m = moves[i];
            Undo u;
            int isQuiet = !(M_FLAGS(m) & (FLAG_CAPTURE | FLAG_EP | FLAG_PROMOTION));
            int v, newDepth;
            U64 childKey;

            make_move(p, m, &u);
            if (attacks_square(p, p->kingSq[!p->side], p->side)) { unmake_move(p, m, &u); continue; }
            legal++;
            moveCount++;

            /* SEE pruning of bad captures / quiet moves at low depth */
            if (!inChk && depth <= 5 && legal > 1) {
                if (isQuiet && depth <= 3 && see(p, m) < -100 * depth) { unmake_move(p, m, &u); continue; }
            }

            newDepth = depth - 1;
            childKey = p->key;
            keyStack[stackSize] = childKey;

            /* late move reduction */
            if (depth >= 3 && moveCount > 3 && isQuiet && !inChk) {
                int r = 1;
                if (moveCount > 8) r = 2;
                if (moveCount > 16) r = 3;
                if (pvNode && r > 1) r--;
                v = -search(p, newDepth - r, -alpha - 1, -alpha, ply + 1, 1, m, keyStack, stackSize + 1);
                if (v > alpha && r > 0)
                    v = -search(p, newDepth, -alpha - 1, -alpha, ply + 1, 1, m, keyStack, stackSize + 1);
            } else if (moveCount == 1) {
                v = -search(p, newDepth, -beta, -alpha, ply + 1, 1, m, keyStack, stackSize + 1);
            } else {
                v = -search(p, newDepth, -alpha - 1, -alpha, ply + 1, 1, m, keyStack, stackSize + 1);
            }
            if (SearchStop) { unmake_move(p, m, &u); return 0; }

            if (v > alpha && v < beta && moveCount > 1)
                v = -search(p, newDepth, -beta, -alpha, ply + 1, 1, m, keyStack, stackSize + 1);

            unmake_move(p, m, &u);
            if (SearchStop) return 0;

            if (v > best) {
                best = v;
                bestMove = m;
                if (v > alpha) {
                    alpha = v;
                    if (v >= beta) {
                        if (isQuiet) {
                            if (Killers[ply][0] != m) { Killers[ply][1] = Killers[ply][0]; Killers[ply][0] = m; }
                            History[p->side][M_FROM(m)][M_TO(m)] += depth * depth;
                            if (History[p->side][M_FROM(m)][M_TO(m)] > 200000) History[p->side][M_FROM(m)][M_TO(m)] /= 2;
                            if (prevMove) CounterMove[p->side][M_FROM(prevMove)][M_TO(prevMove)] = m;
                        }
                        break;
                    }
                }
            }
        }
        if (legal == 0) return inChk ? -VALUE_MATE + ply : 0;
    }

    /* store in TT */
    {
        int storeScore = best;
        if (storeScore > MATE_IN_MAX) storeScore += ply;
        else if (storeScore < -MATE_IN_MAX) storeScore -= ply;
        if (te->key != p->key || depth >= te->depth || te->age != TT_age) {
            te->key = p->key;
            te->score = storeScore;
            te->move = bestMove;
            te->depth = (int16_t)depth;
            te->flag = (uint8_t)(best >= beta ? 3 : (best > origAlpha ? 1 : 2));
            te->age = (uint8_t)TT_age;
        }
    }
    if (bestMove && ply < MAX_PLY - 1) {
        PvTable[ply][ply] = bestMove;
        PvLen[ply] = PvLen[ply + 1] > ply + 1 ? PvLen[ply + 1] : ply + 1;
    }
    return best;
}

void search_go(Position* p, int maxTimeMs, int depthLimit, int gambitMode, int contempt) {
    Move rootMoves[MAX_MOVES * 2], bookMove = 0;
    int rootScores[MAX_MOVES * 2];
    int n, i, d;
    U64 keyStack[1024];
    int stackSize = 0;
    U64 iterKey;
    Position work = *p;

    StartTime = now_ms();
    TimeLimit = maxTimeMs;
    GambitMode = gambitMode;
    Contempt = contempt;
    Nodes = 0;
    SelDepth = 0;
    SearchStop = 0;
    TT_age = (TT_age + 1) & 63;

    memset(&SearchBest, 0, sizeof(SearchBest));
    SearchBest.score = 0;

    if (in_check(&work) == 0 && popcount(work.bb[work.side][7]) == 0) { /* nothing */ }

    if (UseOpeningBook && probe_book(&work, &bookMove) && bookMove && is_legal(&work, bookMove)) {
        SearchBest.best = bookMove;
        SearchBest.bookMove = 1;
        SearchBest.depth = 1;
        SearchBest.score = 0;
        SearchBest.pv[0] = bookMove;
        SearchBest.pvLen = 1;
        SearchBest.timeMs = (int)(now_ms() - StartTime);
        return;
    }

    n = legal_moves(&work, rootMoves);
    if (n == 0) return;
    if (n == 1) {
        SearchBest.best = rootMoves[0];
        SearchBest.pv[0] = rootMoves[0];
        SearchBest.pvLen = 1;
        SearchBest.depth = 1;
        return;
    }

    keyStack[0] = work.key;
    iterKey = work.key;

    for (i = 0; i < n; i++) rootScores[i] = move_score(&work, rootMoves[i], 0, 0, 0);

    for (d = 1; d <= depthLimit; d++) {
        int alpha = -VALUE_INFINITE, beta = VALUE_INFINITE;
        int bestThis = -VALUE_INFINITE, bestIdx = -1;
        Move bestMoveIter = 0;
        Position rootPos;
        int any = 0;

        if (SearchStop) break;
        if (TimeLimit > 0 && d > 1 && now_ms() - StartTime > TimeLimit * 6 / 10) break;

        for (i = 0; i < n; i++) {
            Move m = rootMoves[i];
            Undo u;
            int v;
            rootPos = work;
            make_move(&rootPos, m, &u);
            if (attacks_square(&rootPos, rootPos.kingSq[!rootPos.side], rootPos.side)) continue;
            keyStack[1] = rootPos.key;
            if (i == 0)
                v = -search(&rootPos, d - 1, -beta, -alpha, 1, 1, m, keyStack, 2);
            else {
                v = -search(&rootPos, d - 1, -alpha - 1, -alpha, 1, 1, m, keyStack, 2);
                if (!SearchStop && v > alpha)
                    v = -search(&rootPos, d - 1, -beta, -alpha, 1, 1, m, keyStack, 2);
            }
            any = 1;
            if (SearchStop) break;
            rootScores[i] = (v == 0 ? 1 : v) + (d);  /* stable tie-break keeps ordering */
            if (v > bestThis) { bestThis = v; bestIdx = i; bestMoveIter = m; }
            if (v > alpha) alpha = v;
        }
        if (!any) break;

        if (bestIdx > 0) {
            /* move best to front for the next iteration */
            Move bm = rootMoves[bestIdx];
            int bs = rootScores[bestIdx];
            for (i = bestIdx; i > 0; i--) { rootMoves[i] = rootMoves[i - 1]; rootScores[i] = rootScores[i - 1]; }
            rootMoves[0] = bm;
            rootScores[0] = bs;
        }

        SearchBest.best = bestMoveIter;
        SearchBest.score = bestThis;
        SearchBest.depth = d;
        SearchBest.seldepth = SelDepth;
        SearchBest.nodes = Nodes;
        SearchBest.timeMs = (int)(now_ms() - StartTime);
        {
            int k = 0;
            SearchBest.pv[k++] = bestMoveIter;
            {
                int pl = 1;
                while (pl < MAX_PLY - 1 && PvTable[0][pl] && k < MAX_PLY - 1) {
                    SearchBest.pv[k++] = (Move)PvTable[0][pl];
                    pl++;
                }
            }
            SearchBest.pvLen = k;
        }

        if (bestThis > MATE_IN_MAX || bestThis < -MATE_IN_MAX) break;
        if (SearchStop) break;
        if (TimeLimit > 0 && now_ms() - StartTime > TimeLimit / 2) break;
    }
    (void)iterKey;
    if (!SearchBest.best) {
        SearchBest.best = rootMoves[0];
        SearchBest.pv[0] = rootMoves[0];
        SearchBest.pvLen = 1;
    }
    SearchBest.nodes = Nodes;
    SearchBest.timeMs = (int)(now_ms() - StartTime);
}
