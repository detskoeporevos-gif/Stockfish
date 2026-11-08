/*
  GambitFish — «живой» комментатор.

  Каждый ход описывается конкретными признаками позиции (features.js)
  и складывается в фразу из большого банка (phrases.js). Комментарий
  всегда объясняет идею: что атаковано, куда смотрит фигура, какова
  компенсация за материал.

  GPL-3.0.
*/

import {
    Position, uciToMove, moveToSan, moveToUci, squareName, pieceType, pieceColor,
    WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, mFlags, mTo, mFrom,
    FLAG_CAPTURE, FLAG_CASTLE, FLAG_PROMOTION, FLAG_EP,
} from '../chess/chess.js';
import {
    analyzeMove, initiativeScore, materialBalance, kingAttackers, hangingPieces,
    pawnShieldMissing, kingVulnerability, isPassedPawn, pieceNameRu, attacksSquare, VALUE, countDevelopment,
} from './features.js';
import { GAMBITS, GAMBIT_BY_ID } from '../data/gambits.js';
import { makeRng, pick, shuffle } from './rng.js';
import {
    OPENERS, SACRIFICE_HINTS, COMPENSATION, COMPENSATION_THEMES, THREAT_TEXT,
    THREAT_DESCRIPTIONS, DEFENSIVE_TEXT, QUIET_TEXT, DEFENSE_TEXT, BLUNDER_TEXT,
    ENDING_TEXT, GAMBIT_INTRO, GAMBIT_RECOGNITION, SACRIFICE_KIND, TACTICAL_PATTERN,
    MATE_TEXT, SPECULATIVE_OPENING, COACH_NOTES, CHAT_LEADINS,
} from './phrases.js';

const files = 'abcdefgh';

/* ------------------------------------------------------------------ */
/*  Индекс дебютов по позициям (для узнавания гамбита)                 */
/* ------------------------------------------------------------------ */
let gambitIndex = null;

function buildGambitIndex() {
    const index = new Map(); // fen -> gambitId
    for (const g of GAMBITS) {
        const lines = [g.moves, ...(g.lines || [])];
        const signature = g.moves.length;
        for (const line of lines) {
            const pos = new Position();
            let step = 0;
            for (const u of line) {
                const m = uciToMove(pos, u);
                if (!m) break;
                pos.makeMove(m);
                step++;
                /* узнаём гамбит только после того, как сыграна его главная линия */
                if (step >= signature) {
                    const f = pos.fen();
                    if (!index.has(f)) index.set(f, g.id);
                }
            }
        }
    }
    return index;
}

export function gambitLookup(fen) {
    if (!gambitIndex) gambitIndex = buildGambitIndex();
    /* FEN содержит счётчики ходов — сравниваем только первые 4 поля */
    const key = fen.split(' ').slice(0, 4).join(' ');
    for (const [k, v] of gambitIndex) {
        if (k.split(' ').slice(0, 4).join(' ') === key) return GAMBIT_BY_ID[v];
    }
    return null;
}

/* ------------------------------------------------------------------ */
/*  Текстовые помощники                                               */
/* ------------------------------------------------------------------ */

function squareRu(sq) {
    return files[sq & 7] + ((sq >> 3) + 1);
}

function kingColorName(c) { return c === WHITE ? 'белого' : 'чёрного'; }

function sideName(c) { return c === WHITE ? 'белые' : 'чёрные'; }

function pieceGenitive(t) {
    return { 1: 'пешки', 2: 'коня', 3: 'слона', 4: 'ладьи', 5: 'ферзя', 6: 'короля' }[t] || 'фигуры';
}

function materialText(cp) {
    const abs = Math.abs(cp);
    if (abs < 60) return 'примерно равный материал';
    if (abs < 160) return 'пешка';
    if (abs < 300) return 'две пешки';
    if (abs < 400) return 'фигура';
    if (abs < 600) return 'фигура и пешка';
    if (abs < 800) return 'две фигуры';
    return 'серьёзный материальный перевес';
}

/* ------------------------------------------------------------------ */
/*  Основной класс                                                    */
/* ------------------------------------------------------------------ */

export class Commentator {
    constructor(options = {}) {
        this.level = options.level || 'normal';
        this.side = options.side || WHITE;
        this.gambitMode = options.gambitMode !== false;
        this.seedBase = options.seed || 'gambitfish';
        this.seenGambits = new Set();
        this.moveIndex = 0;
    }

    setSide(side) { this.side = side; }

    /* ---- комментарий к ходу ---- */
    comment(pos, move, meta = {}) {
        const f = analyzeMove(pos, move);
        const rng = makeRng(`${this.seedBase}:${f.fenBefore}:${f.uci}:${this.moveIndex++}`);
        const parts = [];

        const gambit = gambitLookup(f.fenBefore);
        const isMyMove = f.side === this.side;

        /* 1. узнавание гамбита */
        if (gambit && !this.seenGambits.has(gambit.id) && this.moveIndex <= 12) {
            this.seenGambits.add(gambit.id);
            const text = pick(rng, GAMBIT_RECOGNITION).replace('{name}', gambit.name);
            parts.push(text);
        }

        /* 2. жертва — главное, за чем мы пришли */
        if (f.isSacrifice && !f.mate) {
            parts.push(this.sacrificeSentence(pos, f, rng, gambit, isMyMove));
        } else if (f.capture && f.seeValue >= 100) {
            parts.push(this.captureSentence(pos, f, rng));
        } else if (f.check && !f.mate) {
            parts.push(this.checkSentence(pos, f, rng));
        } else if (f.castle) {
            parts.push(this.castleSentence(pos, f, rng));
        } else if (f.promotion) {
            parts.push(`Пешка {s} превращается в ${pieceNameRu(f.promotion)} — материал и темпы одновременно.`);
        } else {
            parts.push(this.quietSentence(pos, f, rng));
        }

        /* 3. конкретная идея хода */
        const idea = this.ideaSentence(pos, f, rng, gambit);
        if (idea) parts.push(idea);

        /* 4. угрозы, которые появились */
        const threat = this.threatSentence(pos, f, rng);
        if (threat) parts.push(threat);

        /* 5. позиционная оценка инициативы */
        if (this.level !== 'short' && (f.isSacrifice || rng() < 0.45)) {
            const pos2 = new Position(f.fenAfter);
            const init = initiativeScore(pos2, f.side);
            if (init >= 5) {
                parts.push(pick(rng, [
                    `Инициатива у ${sideName(f.side)} по моим меркам ${init.toFixed(1)} из 10 — это уже реальная компенсация.`,
                    `Считаю инициативу: ${init.toFixed(1)} из 10. Для гамбита вполне рабочая валюта.`,
                    `По шкале инициативы — ${init.toFixed(1)}/10. Материал прощает такие траты.`,
                ]));
            }
        }

        /* 6. обучающая вставка */
        if (this.level === 'coach' && rng() < 0.35) parts.push(pick(rng, COACH_NOTES));

        return this.render(pos, move, parts, rng);
    }

    render(pos, move, parts, rng) {
        const san = moveToSan(pos, move);
        const num = pos.fullmove;
        const prefix = pos.side === WHITE ? `${num}.` : `${num}...`;
        const head = `${prefix} ${san}`;
        let body = parts.filter(Boolean).join(' ');
        body = body.replace(/\{s\}/g, squareName(mTo(move)));
        if (!body) body = `Ход ${san}.`;
        return { head, text: body, san };
    }

    sacrificeSentence(pos, f, rng, gambit, isMyMove) {
        const kind = f.type === PAWN ? 'пешка'
            : f.type === KNIGHT ? 'конь'
                : f.type === BISHOP ? 'слон'
                    : f.type === ROOK ? 'ладья'
                        : f.type === QUEEN ? 'ферзь' : 'фигура';
        const kindText = f.exchangeSacrifice ? 'качество' : kind;
        const comp = this.compensationThemes(pos, f, gambit, rng);
        const openers = ['Жертва!', 'Вот она, жертва:', 'Отдаём материал:', 'Ключевой момент — жертва:', 'Смело: жертвуем.', 'И вот главное:'];
        const tail = pick(rng, SACRIFICE_HINTS);
        const lead = pick(rng, [
            `Отдана ${kindText} — ${tail.replace(/^— /, '')}`,
            `Жертвуем: ${kindText} уходит с доски. ${tail}`,
            `${kindText[0].toUpperCase()}${kindText.slice(1)} отдана. ${tail}`,
            `Материал: минус ${kindText}. ${tail}`,
        ]);
        let text = `${pick(rng, openers)} ${lead}`;
        if (comp.length) {
            text += ' ' + pick(rng, COMPENSATION).replace('{theme}', comp[0]);
            if (comp.length > 1) text += ` Плюс ${comp[1]}.`;
        }
        return text;
    }

    compensationThemes(pos, f, gambit, rng) {
        const themes = [];
        const after = new Position(f.fenAfter);
        const them = f.side ^ 1;
        const attackers = kingAttackers(after, f.side, them);
        const dev = countDevelopment(after, f.side);
        const vuln = kingVulnerability(after, them);

        if (f.threatsMate || attackers.length >= 3) themes.push(pick(rng, COMPENSATION_THEMES.attack));
        if (vuln >= 2) themes.push(pick(rng, COMPENSATION_THEMES.king));
        if (dev >= 2) themes.push(pick(rng, COMPENSATION_THEMES.development));
        if (f.passedPawn) themes.push('проходная пешка, которая связывает силы');
        if (f.emptiesCenter) themes.push(pick(rng, COMPENSATION_THEMES.center));
        if (!themes.length) themes.push(pick(rng, COMPENSATION_THEMES.time));
        if (themes.length < 2) themes.push(pick(rng, COMPENSATION_THEMES.lines));
        if (gambit) {
            const idea = gambit.ideas[Math.floor(rng() * gambit.ideas.length)];
            themes.push(idea);
        }
        return themes;
    }

    captureSentence(pos, f, rng) {
        const lead = pick(rng, ['Взятие.', 'Забираем материал.', 'Размен в нашу пользу.', 'Аккуратный съед:']);
        const detail = f.capturedName ? `С доски уходит ${f.capturedName} (${squareRu(f.to)}).` : '';
        const see = f.seeValue >= 200 ? ' Выигрыш чистый — размен в нашу пользу.' : '';
        const after = new Position(f.fenAfter);
        const extra = [];
        if (after.inCheck()) extra.push('И это с шахом — темп не потерян.');
        if (f.passedPawn) extra.push(`Пешка на ${squareRu(f.to)} становится проходной.`);
        return `${lead} ${detail}${see} ${extra.join(' ')}`.trim();
    }

    checkSentence(pos, f, rng) {
        if (f.doubleCheck) return 'Двойной шах! От него не отбиться обычным способом — король обязан идти.';
        const replies = new Position(f.fenAfter).legalMoves().length;
        if (replies === 1) return 'Шах, и у соперника ровно один ответ — позиция форсирована.';
        if (replies === 2) return 'Шах с двумя ответами: соперник выбирает из двух зол.';
        return pick(rng, [
            'Шах — темп, а в гамбите темп дороже пешки.',
            'Шах заставляет соперника защищаться, пока мы развиваемся.',
            'Шах с темпом — именно то, что нужно в такой позиции.',
        ]);
    }

    castleSentence(pos, f, rng) {
        const long = f.castling === 'long';
        const base = long ? 'Длинная рокировка: король в безопасности, ладья сразу на d-линии.' : 'Короткая рокировка: король укрыт, ладья готова к действию.';
        const after = new Position(f.fenAfter);
        const attackers = kingAttackers(after, f.side, f.side ^ 1);
        if (attackers.length >= 3) return base + ' Хотя атака соперника уже накапливается.';
        return base;
    }

    quietSentence(pos, f, rng) {
        const after = new Position(f.fenAfter);
        const attackers = kingAttackers(after, f.side, f.side ^ 1).length;
        const strong = f.toCenter <= 2.5 || f.toFile === 3 || f.toFile === 4;
        if (f.type === QUEEN) return pick(rng, ['Ферзь выходит на активную позицию.', 'Ферзь занимает диагональ и смотрит на короля.', 'Ферзь входит в игру — это всегда событие.']);
        if (f.type === ROOK) return pick(rng, ['Ладья занимает открытую линию.', 'Ладья переводится туда, где будет решающая борьба.']);
        if (f.type === BISHOP) return pick(rng, ['Слон выходит на большую диагональ.', 'Слон получает простор — его сила именно в диагоналях.']);
        if (f.type === KNIGHT) return pick(rng, ['Конь прыгает ближе к центру.', 'Конь ищет форпост — поле, которое не выбить пешкой.', 'Конь занял активную позицию.']);
        if (f.type === KING) return pick(rng, ['Король делает важный пешечный ход.', 'Король идёт вперёд — в эндшпиле он сильная фигура.']);
        if (f.type === PAWN && strong) return pick(rng, ['Пешка идёт в центр — заявка на пространство.', 'Пешечный ход в центре задаёт структуру всей партии.', 'Центр — это то, за что стоит бороться.']);
        if (f.type === PAWN && (f.toFile === 0 || f.toFile === 7)) return pick(rng, ['Фланговый ход — не всегда медленный: он готовит Bb2/Bg2 или подрыв.', 'Пешка на краю готовит большой план на фланге.']);
        return pick(rng, QUIET_TEXT);
    }

    ideaSentence(pos, f, rng, gambit) {
        const after = new Position(f.fenAfter);
        const them = f.side ^ 1;
        const ideas = [];

        /* что стало лучше */
        if (f.attackersAfter > f.attackersBefore)
            ideas.push(`Фигур, атакующих зону ${kingColorName(them)} короля, стало больше: ${f.attackersBefore} → ${f.attackersAfter}.`);

        const hanging = hangingPieces(after, f.side);
        const hangingPiecesList = hanging.filter((sq) => (VALUE[pieceType(after.board[sq])] || 0) >= 320);
        const hangingPawns = hanging.filter((sq) => pieceType(after.board[sq]) === PAWN);
        if (hangingPiecesList.length) {
            const names = hangingPiecesList.slice(0, 2).map((sq) => `${pieceNameRu(pieceType(after.board[sq]))} на ${squareRu(sq)}`);
            ideas.push(`Под боем ${names.join(' и ')} — соперник должен реагировать.`);
        } else if (hangingPawns.length && rng() < 0.5) {
            ideas.push(`Под ударом пешка на ${squareRu(hangingPawns[0])}.`);
        }

        const checkReplies = after.legalMoves().length;
        if (f.forcedReply) ideas.push('У соперника единственный ответ — вариант форсирован.');

        /* ослабления у соперника */
        const vuln = kingVulnerability(after, them);
        if (vuln >= 3) ideas.push(`Король соперника неуютно себя чувствует: пешечное прикрытие разбито, а фигур рядом мало.`);
        else if (vuln >= 2 && f.attackersAfter >= 3) ideas.push(`Прикрытие ${kingColorName(them)} короля уже не идеально — ${vuln} слабых полей вокруг.`);

        if (f.passedPawn) ideas.push(`Пешка ${squareRu(f.to)} — проходная, за ней открыта дорога.`);

        /* конкретика дебюта */
        if (gambit) {
            const plan = gambit.plans[Math.floor(rng() * gambit.plans.length)];
            if (rng() < 0.6) ideas.push(`Дебютная идея: ${plan}.`);
        }

        if (!ideas.length) {
            const dev = countDevelopment(after, f.side);
            if (dev >= 3) ideas.push(`Всего развитых фигур ${dev} — сопернику стоит поторопиться.`);
        }

        if (!ideas.length) return '';
        return shuffle(rng, ideas).slice(0, this.level === 'short' ? 1 : 2).join(' ');
    }

    threatSentence(pos, f, rng) {
        const after = new Position(f.fenAfter);
        if (f.mate) return pick(rng, MATE_TEXT);
        if (!after.inCheck()) return '';
        const replies = after.legalMoves();
        if (replies.length === 1) return `Ответ единственный: ${moveToSan(after, replies[0])}.`;
        return '';
    }

    /* ---- начальное приветствие ---- */
    welcome() {
        const rng = makeRng(this.seedBase + ':welcome');
        return {
            text: pick(rng, [
                'Здравствуйте! Я GambitFish — играю гамбиты и объясняю каждый ход.',
                'Привет. Я живу жертвами и готов объяснять свои идеи вслух.',
                'Начинаем. Я играю в гамбитном стиле и буду рассказывать, зачем тот или иной ход.',
            ]),
        };
    }

    /* ---- представление известных гамбитов ---- */
    gambitBlurb(id) {
        const g = GAMBIT_BY_ID[id];
        if (!g) return '';
        const rng = makeRng(this.seedBase + ':' + id);
        return [
            `${g.name} (${g.nameEn}), ${g.eco}.`,
            `Жертва: ${SACRIFICE_KIND[g.sacrifice] || 'материал'}. Материальный минус: ${materialText(g.material)}.`,
            `Идеи: ${g.ideas.slice(0, 3).join('; ')}.`,
            `Планы: ${g.plans.slice(0, 2).join('; ')}.`,
            g.defense && g.defense.length ? `Защита за соперника: ${g.defense[0]}.` : '',
            g.traps && g.traps.length ? `Ловушка: ${g.traps[0].note}.` : '',
            pick(rng, SPECULATIVE_OPENING),
        ].filter(Boolean).join(' ');
    }

    /* ---- разбор вопроса пользователя ---- */
    answerQuestion(pos, question) {
        const q = question.toLowerCase();
        const rng = makeRng(this.seedBase + ':q:' + q + pos.fen());
        const gambit = gambitLookup(pos.fen());
        if (/почему|зачем|объясн/.test(q) && gambit) {
            return `${pick(rng, CHAT_LEADINS)} мы в ${gambit.name}. ${gambit.ideas[Math.floor(rng() * gambit.ideas.length)].replace(/^/, 'Главная идея: ')}. Планы: ${gambit.plans.slice(0, 2).join('; ')}.`;
        }
        if (/план|что делать/.test(q)) {
            if (gambit) return `План за ${gambit.side === 'white' ? 'белых' : 'чёрных'}: ${gambit.plans.join('; ')}. Обороняться лучше так: ${gambit.defense[0]}.`;
            return 'В этой позиции я бы играл на активность: вывести все фигуры, найти слабый пункт и ударить именно туда.';
        }
        if (/жертв|гамбит/.test(q)) {
            const list = shuffle(rng, GAMBITS).slice(0, 3).map((g) => g.name).join(', ');
            return `Я знаю ${GAMBITS.length} гамбитов. Например: ${list}. Спросите про любой — расскажу идеи и ловушки.`;
        }
        if (/сила|эло|уровень/.test(q)) {
            return 'Я играю на уровне сильного клубного мастера: порядка 2400–2500 при быстром контроле и выше при дольше времени.';
        }
        return pick(rng, [
            'Хороший вопрос. В этой позиции всё решает конкретика: считайте форсированные варианты и не забывайте про слабые поля вокруг короля.',
            'Отвечу так: держите инициативу. В гамбитах материал — это разменная монета, а темпы — валюта.',
            'Я бы рекомендовал смотреть на активность фигур: если у вас больше фигур бьёт в зону короля, вы уже правы.',
        ]);
    }

    /* ---- итог партии ---- */
    ending(pos, history) {
        const rng = makeRng(this.seedBase + ':end:' + pos.fen());
        if (pos.isCheckmate()) return pick(rng, ENDING_TEXT.mate);
        if (pos.isStalemate()) return pick(rng, ENDING_TEXT.stalemate);
        if (pos.isInsufficientMaterial() || pos.halfmove >= 100) return pick(rng, ENDING_TEXT.draw);
        return pick(rng, ENDING_TEXT.draw);
    }
}

export default Commentator;
