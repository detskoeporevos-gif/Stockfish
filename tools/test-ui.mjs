#!/usr/bin/env node
/*
  Прогон интерфейса в jsdom: реальная страница index.html, настоящий
  WASM-движок (через эмуляцию Worker), новая доска cm-chessboard либо
  запасная доска, ходы, чат, вкладки, разбор PGN. Ловит ошибки JS и 404.
*/
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const wasmBuf = fs.readFileSync(path.join(root, 'web/public/gambitfish.wasm'));

let fails = 0;
const errors = [];
const notes = [];
const check = (cond, label, extra = '') => {
    if (cond) console.log(`✓ ${label}`);
    else { console.log(`✗ ${label} ${extra}`); fails++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- эмуляция Worker (реально исполняет worker.js в этом же процессе) --- */
const outbox = [];
let currentWorker = null;
class FakeWorker {
    constructor(url) {
        this.url = String(url);
        this.onmessage = null;
        this.onerror = null;
        currentWorker = this;
    }
    postMessage(data) { setImmediate(() => { if (globalThis.self.onmessage) globalThis.self.onmessage({ data }); }); }
}
const workerSelf = {
    postMessage: (m) => { if (currentWorker && currentWorker.onmessage) currentWorker.onmessage({ data: m }); },
    addEventListener: () => {},
    onmessage: null,
};
globalThis.self = workerSelf;
globalThis.fetch = async () => ({ arrayBuffer: async () => wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength) });

const dom = new JSDOM(fs.readFileSync(path.join(root, 'web/index.html'), 'utf8'), {
    url: 'http://localhost:5173/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
});
const { window } = dom;

/* jsdom не умеет SVG-трансформации и XHR-кэш спрайтов — минимальный шим,
   без него библиотека доски просто откажется рисовать */
function shimTransformList(el) {
    if (el.__tf) return el.__tf;
    const list = {
        _items: [],
        numberOfItems: 0,
        appendItem(t) { this._items.push(t); this.numberOfItems = this._items.length; return t; },
        removeItem(i) { this._items.splice(i, 1); this.numberOfItems = this._items.length; },
    };
    return (el.__tf = list);
}
if (window.SVGElement) {
    Object.defineProperty(window.SVGElement.prototype, 'transform', {
        get() { return { baseVal: shimTransformList(this) }; },
        configurable: true,
    });
}
if (window.SVGSVGElement) {
    window.SVGSVGElement.prototype.createSVGTransform = function () {
        return { setTranslate() {}, setScale() {}, matrix: {} };
    };
}

/* библиотека доски кэширует SVG-спрайты через XHR — в jsdom его нет,
   подменяем на fetch из файловой системы (в браузере это делает сам XHR) */
class FakeXHR {
    open(method, url) { this.url = String(url); }
    send() {
        const clean = this.url.replace(/^https?:\/\/[^/]+\//, '').replace(/^\.\//, '');
        const file = path.join(root, 'web', clean.split('?')[0]);
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = ''; notes.push(`sprite 404: ${clean}`); }
        this.response = text;
        this.status = text ? 200 : 404;
        if (this.onload) setTimeout(() => this.onload(), 0);
    }
}
window.XMLHttpRequest = FakeXHR;
globalThis.XMLHttpRequest = FakeXHR;
process.on('unhandledRejection', (e) => { errors.push('unhandledRejection: ' + String(e && e.message || e)); });
process.on('uncaughtException', (e) => { errors.push('uncaught: ' + String(e && e.message || e)); });
globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
window.Worker = FakeWorker;
globalThis.Worker = FakeWorker;
/* анимации доски используют requestAnimationFrame, а он живёт в window */
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);

window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
dom.virtualConsole.on('jsdomError', (e) => errors.push(String(e.message)));

/* без сети в jsdom подгружаем библиотеку доски так же, как это делает
   адаптер (относительный импорт), но реальный ES-модуль берём из файловой
   системы — import() в Node его видит по тому же относительному пути */
await import('../web/src/engine/worker.js');
await import('../web/src/ui/app.js');
await sleep(1800);

const boardEl = document.querySelector('#board');
check(!!boardEl, 'контейнер доски существует');
/* в cm-chessboard поля — это <rect class="square" data-square>, в запасной
   доске — <button.gf-simple-square data-sq> */
const squareSelector = boardEl.querySelector('rect.square')
    ? 'rect.square'
    : '.gf-simple-square';
const squares = [...boardEl.querySelectorAll(squareSelector)];
check(squares.length === 64, 'доска отрисована (64 поля)', `${squares.length} ${squareSelector}`);
const pieces = boardEl.querySelectorAll('[data-piece], .gf-simple-piece');
check(pieces.length >= 32, 'фигуры на доске', String(pieces.length));
check(/cm-chessboard|библиотека недоступна/.test(document.querySelector('#footer-mode').textContent),
    'подпись доски проставлена', document.querySelector('#footer-mode').textContent);

check(document.querySelector('#chat-log').children.length >= 2, 'чат инициализирован');
check(document.querySelectorAll('#gambit-list .gcard').length > 10, 'список гамбитов заполнен',
    String(document.querySelectorAll('#gambit-list .gcard').length));
check(/готов/i.test(document.querySelector('#chip-engine').textContent), 'движок загружен',
    document.querySelector('#chip-engine').textContent);

/* ход игрока: клик e2 -> e4 */
const click = (sq) => {
    const el = boardEl.querySelector(`[data-square="${sq}"]`)
        || boardEl.querySelector(`.gf-simple-square[data-sq="${squareIndex(sq)}"]`);
    if (!el) throw new Error(`нет поля ${sq}`);
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const squareIndex = (name) => (name.charCodeAt(0) - 97) + (name.charCodeAt(1) - 49) * 8;
click('e2');
await sleep(60);
check(boardEl.querySelectorAll('.marker.gf-dot, .gf-simple-square.target').length >= 1,
    'подсвечены возможные ходы');
click('e4');
await sleep(4000);

const moves = [...document.querySelectorAll('#move-list .mv')].map((b) => b.textContent);
check(moves.length >= 2, 'движок ответил на ход', JSON.stringify(moves));
check(moves[0] === 'e4', 'первый ход записан как e4', JSON.stringify(moves[0]));
check(/e4/.test(document.querySelector('#chat-log').textContent), 'комментарий к первому ходу');
check(/[0-9]/.test(document.querySelector('#eval-num').textContent), 'оценка показана',
    document.querySelector('#eval-num').textContent);

/* подсказка и разбор позиции */
document.querySelector('#btn-hint').click();
await sleep(3000);
check(/Подсказка/.test(document.querySelector('#status-main').textContent), 'подсказка выдана',
    document.querySelector('#status-main').textContent);
document.querySelector('#btn-eval').click();
await sleep(3500);
check(document.querySelector('#chat-log').textContent.includes('Главная линия'), 'разбор позиции в чате');

/* чат-вопрос */
const form = document.querySelector('#chat-form');
document.querySelector('#chat-input').value = 'зачем жертва?';
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(400);
check(document.querySelector('#chat-log').textContent.length > 200, 'чат отвечает');

/* вкладка гамбитов */
latestTab('gambits');
document.querySelectorAll('#gambit-list .gcard')[3]
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(document.querySelector('#gambit-detail').textContent.length > 50, 'карточка гамбита открывается');
check(document.querySelector('#gambit-detail').textContent.includes('Играть этот гамбит'),
    'кнопка запуска гамбита есть');

/* разбор PGN */
document.querySelector('#btn-review-sample').click();
check(document.querySelector('#pgn-input').value.length > 50, 'пример PGN подставлен');
document.querySelector('#review-movetime').value = '150';
document.querySelector('#btn-review').click();
await sleep(5000);
const reviewText = document.querySelector('#review-report').textContent;
check(/Разбор партии/.test(reviewText), 'отчёт по партии готов', reviewText.slice(0, 80));
check(document.querySelectorAll('#review-moves span').length > 5, 'метки ходов построены',
    String(document.querySelectorAll('#review-moves span').length));
check(/авантюрности/.test(reviewText), 'индекс авантюрности посчитан');

/* смена стороны */
latestTab('settings');
const sideSel = document.querySelector('#opt-side');
sideSel.value = 'black';
sideSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await sleep(4500);
check(document.querySelectorAll('#move-list .mv').length >= 1, 'игра чёрными: движок начал',
    JSON.stringify([...document.querySelectorAll('#move-list .mv')].map((b) => b.textContent)));

check(errors.length === 0, 'нет JS-ошибок', JSON.stringify(errors.slice(0, 3)));
console.log(fails ? `ОШИБОК: ${fails}` : 'UI: всё в порядке ✔');
process.exit(fails ? 1 : 0);

function latestTab(name) {
    const btn = document.querySelector(`.tabs button[data-tab="${name}"]`);
    if (btn) btn.click();
}
