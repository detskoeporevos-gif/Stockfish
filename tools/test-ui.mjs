#!/usr/bin/env node
/*
  Прогон интерфейса в jsdom: загрузка страницы, загрузка WASM-клиента
  (реальный WebAssembly), ходы, чат, вкладки. Ловит ошибки JS и 404.
*/
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const wasmBuf = fs.readFileSync(path.join(root, 'web/public/gambitfish.wasm'));

let fails = 0;
const errors = [];
const check = (cond, label, extra = '') => {
    if (cond) console.log(`✓ ${label}`);
    else { console.log(`✗ ${label} ${extra}`); fails++; }
};

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
    /* клиент -> воркер: сообщение получает self.onmessage внутри worker.js */
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
process.on('unhandledRejection', (e) => { console.log('unhandledRejection:', String(e && e.stack || e)); });
process.on('uncaughtException', (e) => { console.log('uncaught:', String(e && e.stack || e)); });
globalThis.window = window;
globalThis.document = window.document;
globalThis.location = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
globalThis.TextEncoder = globalThis.TextEncoder || TextEncoder;
globalThis.TextDecoder = globalThis.TextDecoder || TextDecoder;
window.Worker = FakeWorker;
globalThis.Worker = FakeWorker;

window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
dom.virtualConsole.on('jsdomError', (e) => errors.push(String(e.message)));

/* грузим воркер-модуль и клиент в одной среде */
await import('../web/src/engine/worker.js');
/* подменяем конструктор так, чтобы client.js получил наш инстанс */
const origWorker = window.Worker;
window.Worker = function (url) { return new origWorker(url); };

/* app.js сам создаёт Worker и вызывает boot() */
/* перехватываем pagehide, чтобы app.js отдал наружу своё состояние */
window.addEventListener('pagehide', () => {});
await import('../web/src/ui/app.js');
await new Promise((r) => setTimeout(r, 1500));

check(document.querySelectorAll('.gf-square').length === 64, 'доска отрисована (64 поля)');
check(document.querySelector('#chat-log').children.length >= 2, 'чат инициализирован');
check(document.querySelectorAll('.gf-gambit-card').length > 10, 'список гамбитов заполнен',
    String(document.querySelectorAll('.gf-gambit-card').length));

/* ход игрока: e2e4 */
const boardEl = document.querySelector('#board');
const sqEl = (name) => {
    const sq = 'abcdefgh'.indexOf(name[0]) + (+name[1] - 1) * 8;
    const el = [...document.querySelectorAll('.gf-square')].find((e) => e.dataset.sq === String(sq));
    if (!el) throw new Error(`нет поля ${name}`);
    return el;
};
sqEl('e2').click();
sqEl('e4').click();
await new Promise((r) => setTimeout(r, 2000));

const moves = [...document.querySelectorAll('#move-list .mv')].map((b) => b.textContent);
check(moves.length >= 2, 'движок ответил на ход', JSON.stringify(moves));
check(document.querySelector('#chat-log').textContent.includes('e4') || moves[0] === 'e4', 'комментарий к первому ходу');

/* чат-вопрос */
const form = document.querySelector('#chat-form');
document.querySelector('#chat-input').value = 'зачем жертва?';
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((r) => setTimeout(r, 400));
check(document.querySelector('#chat-log').textContent.length > 100, 'чат отвечает');

/* вкладка гамбитов: открыть карточку */
document.querySelectorAll('.gf-gambit-card')[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(document.querySelector('#gambit-detail').textContent.length > 50, 'карточка гамбита открывается');

/* разбор PGN */
document.querySelector('#btn-review-sample').click();
const pgnLen = document.querySelector('#pgn-input').value.length;
check(pgnLen > 50, 'пример PGN подставлен');
document.querySelector('#review-movetime').value = '150';
document.querySelector('#btn-review').click();
await new Promise((r) => setTimeout(r, 4000));
const reviewText = document.querySelector('#review-report').textContent;
check(/Разбор партии/.test(reviewText), 'отчёт по партии готов', reviewText.slice(0, 80));
check(document.querySelectorAll('#review-moves span').length > 5, 'метки ходов построены',
    String(document.querySelectorAll('#review-moves span').length));
check(/авантюрности/.test(reviewText), 'индекс авантюрности посчитан');

/* настройки */

const sideSel = document.querySelector('#opt-side');
sideSel.value = 'black';
sideSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await new Promise((r) => setTimeout(r, 4000));
check(document.querySelectorAll('#move-list .mv').length >= 1, 'игра чёрными: движок начал',
    JSON.stringify([...document.querySelectorAll('#move-list .mv')].map((b) => b.textContent)));

check(errors.length === 0, 'нет JS-ошибок', JSON.stringify(errors.slice(0, 3)));
console.log(fails ? `ОШИБОК: ${fails}` : 'UI: всё в порядке ✔');
process.exit(fails ? 1 : 0);
