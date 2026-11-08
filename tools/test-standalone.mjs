#!/usr/bin/env node
/*
  Проверка автономной сборки dist/gambitfish.html: страница открывается
  из файла (без сервера), весь JS инлайновый, воркер собирается из Blob,
  WASM берётся из base64 внутри воркера. Проверяем, что доска нарисована
  и движок отвечает на ход.
*/
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const file = path.join(root, 'dist/gambitfish.html');
if (!fs.existsSync(file)) {
    console.error('нет dist/gambitfish.html — запустите tools/build-standalone.mjs');
    process.exit(1);
}

let fails = 0;
const errors = [];
const check = (cond, label, extra = '') => {
    if (cond) console.log(`✓ ${label}`);
    else { console.log(`✗ ${label} ${extra}`); fails++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* исходники Blob-объектов: их «воркер» и будет исполнять */
const blobs = new Map();
let currentWorker = null;
let workerSrc = '';

const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    url: 'file:///home/user/Stockfish/dist/gambitfish.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
        /* Blob/URL.createObjectURL — запоминаем исходник воркера */
        let seq = 0;
        window.Blob = class {
            constructor(parts) { this.__src = parts.join(''); }
        };
        window.URL.createObjectURL = (blob) => {
            const url = `blob:${++seq}`;
            blobs.set(url, blob.__src || '');
            return url;
        };

        /* Worker: исполняем код из Blob в этой же среде */
        class FakeWorker {
            constructor(url) {
                const src = blobs.get(String(url));
                if (!src) throw new Error('воркер без Blob-исходника: ' + url);
                workerSrc = src;
                this.onmessage = null;
                this.onerror = null;
                currentWorker = this;
                window.__gfWorkerSelf = {
                    onmessage: null,
                    addEventListener() {},
                    postMessage: (m) => { if (currentWorker.onmessage) currentWorker.onmessage({ data: m }); },
                };
                /* fetch внутри воркера должен отдавать WASM; сам код воркера
                   подменяет self.fetch, поэтому передаём тот же self */
                window.eval(`(function(self){${src}\n})(window.__gfWorkerSelf)`);
                /* в бандле воркера вызовы fetch/atob не квалифицированы:
                   в браузере это глобальные объекты воркера, здесь — окно */
                if (window.__gfWorkerSelf.fetch) window.fetch = window.__gfWorkerSelf.fetch;
            }
            postMessage(data) { window.setTimeout(() => window.__gfWorkerSelf.onmessage({ data }), 0); }
        }
        window.Worker = FakeWorker;

        /* SVG-спрайты библиотека грузит XHR-ом: в автономном файле это data-URI */
        window.XMLHttpRequest = class {
            open(method, url) {
                this.url = String(url);
                if (!/^(data:|blob:)/.test(this.url)) errors.push('XHR не data-URI: ' + this.url.slice(0, 60));
            }
            send() { this.response = ''; this.status = 200; if (this.onload) window.setTimeout(() => this.onload(), 0); }
        };

        /* jsdom не умеет SVG-трансформации — минимальный шим */
        const lists = new WeakMap();
        Object.defineProperty(window.SVGElement.prototype, 'transform', {
            get() {
                if (!lists.has(this)) {
                    const list = {
                        _items: [],
                        numberOfItems: 0,
                        appendItem(t) { this._items.push(t); this.numberOfItems = this._items.length; return t; },
                        removeItem(i) { this._items.splice(i, 1); this.numberOfItems = this._items.length; },
                    };
                    lists.set(this, list);
                }
                return { baseVal: lists.get(this) };
            },
            configurable: true,
        });
        window.SVGSVGElement.prototype.createSVGTransform = function () {
            return { setTranslate() {}, setScale() {}, matrix: {} };
        };

        window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
    },
});

const { window } = dom;
dom.virtualConsole.on('jsdomError', (e) => errors.push(String(e.message)));

/* ждём загрузки модулей страницы */
const loadWait = new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
});
await loadWait;
await sleep(2500);

const { document } = window;
const html = fs.readFileSync(file, 'utf8');
check(!/src="[^"]*\.js"/.test(html), 'внешних js-файлов нет');
check(!/<link rel="stylesheet"/.test(html), 'внешних css-файлов нет');
check(/автономный файл/.test(document.querySelector('#footer-mode').textContent), 'подпись автономной сборки',
    document.querySelector('#footer-mode').textContent);
check(workerSrc.includes('gf_search') || workerSrc.length > 10000, 'воркер собран в Blob',
    String(workerSrc.length));

const boardEl = document.querySelector('#board');
const squares = boardEl.querySelectorAll('rect.square, .gf-simple-square');
check(squares.length === 64, 'доска нарисована', String(squares.length));
check(/готов/i.test(document.querySelector('#chip-engine').textContent), 'движок загружен из base64',
    document.querySelector('#chip-engine').textContent);

const click = (sq) => {
    const el = boardEl.querySelector(`[data-square="${sq}"]`);
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
click('e2');
await sleep(80);
click('e4');
await sleep(5000);
const moves = [...document.querySelectorAll('#move-list .mv')].map((b) => b.textContent);
check(moves[0] === 'e4', 'ход игрока принят', JSON.stringify(moves));
check(moves.length >= 2, 'движок ответил', JSON.stringify(moves));
check(errors.length === 0, 'нет ошибок окружения', JSON.stringify(errors.slice(0, 3)));
if (fails) console.log('--- чат ---\n' + document.querySelector('#chat-log').textContent.slice(0, 600));

console.log(fails ? `ОШИБОК: ${fails}` : 'АВТОНОМНЫЙ ФАЙЛ: всё в порядке ✔');
process.exit(fails ? 1 : 0);
