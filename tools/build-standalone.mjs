#!/usr/bin/env node
/*
  Сборка автономного одного файла GambitFish.

  Берёт web/ (index.html, CSS, ES-модули, SVG-ассеты, WASM) и складывает
  всё в dist/gambitfish.html:
    * JS приложения — один бандл (esbuild, IIFE) инлайном;
    * воркер движка — отдельный бандл, живёт в Blob-URL и несёт WASM
      внутри себя в base64 (файла рядом нет);
    * CSS — инлайном; SVG-фигуры/маркеры/стрелки — data-URI, отдаются
      библиотеке доски через подменённый XHR.

  Файл открывается двойным щелчком (file://) и не требует сервера.
  Для Flask ничего собирать не нужно — он раздаёт web/ как есть.

  Запуск:  node tools/build-standalone.mjs
  GPL-3.0.
*/
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const web = path.join(root, 'web');
const outDir = path.join(root, 'dist');
const outFile = path.join(outDir, 'gambitfish.html');

const read = (p) => fs.readFileSync(p, 'utf8');
const readBin = (p) => fs.readFileSync(p);

/* ------------------------------------------------------------------ */
/*  1. WASM в base64                                                  */
/* ------------------------------------------------------------------ */

const wasmPath = path.join(web, 'public/gambitfish.wasm');
if (!fs.existsSync(wasmPath)) {
    throw new Error('нет web/public/gambitfish.wasm — соберите движок: bash tools/build-wasm.sh');
}
const wasmB64 = readBin(wasmPath).toString('base64');

/* ------------------------------------------------------------------ */
/*  2. бандлы: приложение и воркер                                    */
/* ------------------------------------------------------------------ */

const common = {
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    write: false,
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
};

const built = await esbuild.build({ ...common, entryPoints: [path.join(web, 'src/ui/app.js')] });
const workerBuilt = await esbuild.build({ ...common, entryPoints: [path.join(web, 'src/engine/worker.js')] });

const appJs = built.outputFiles[0].text;

/* воркер: WASM eму отдаём из base64, а не сетью */
const workerJs = [
    `var __GF_WASM_B64__ = ${JSON.stringify(wasmB64)};`,
    `self.fetch = function (url) {
        if (/gambitfish\\.wasm/.test(String(url))) {
            var bin = atob(__GF_WASM_B64__);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return Promise.resolve({ arrayBuffer: function () { return Promise.resolve(bytes.buffer); } });
        }
        return Promise.reject(new Error('в автономном файле доступен только WASM движка'));
    };`,
    workerBuilt.outputFiles[0].text,
].join('\n');

/* ------------------------------------------------------------------ */
/*  3. ассеты                                                         */
/* ------------------------------------------------------------------ */

const dataUri = (p, mime) => `data:${mime};base64,${readBin(p).toString('base64')}`;

const SPRITES = {
    'assets/pieces/standard.svg': dataUri(path.join(web, 'assets/pieces/standard.svg'), 'image/svg+xml'),
    'assets/pieces/staunty.svg': dataUri(path.join(web, 'assets/pieces/staunty.svg'), 'image/svg+xml'),
    'assets/extensions/markers/markers.svg': dataUri(path.join(web, 'assets/extensions/markers/markers.svg'), 'image/svg+xml'),
    'assets/extensions/arrows/arrows.svg': dataUri(path.join(web, 'assets/extensions/arrows/arrows.svg'), 'image/svg+xml'),
};

const cssFiles = [
    'vendor/cm-chessboard/chessboard.css',
    'assets/extensions/markers/markers.css',
    'assets/extensions/arrows/arrows.css',
    'src/ui/board-theme.css',
    'src/ui/app.css',
];
const css = cssFiles.map((f) => `/* ==== ${f} ==== */\n${read(path.join(web, f))}`).join('\n');

/* ------------------------------------------------------------------ */
/*  4. обвязка                                                        */
/* ------------------------------------------------------------------ */

const bootstrap = `
(function () {
    /* SVG-спрайты: cm-chessboard грузит их через XHR — отдаём из памяти */
    var SPRITES = ${JSON.stringify(SPRITES)};
    var XHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
        var x = new XHR();
        var open = x.open.bind(x);
        x.open = function (method, url) {
            var key = String(url)
                .replace(/^https?:\\/\\/[^/]+\\//, '')
                .replace(/^\\.\\//, '')
                .replace(/^.*?assets\\//, 'assets/');
            if (SPRITES[key]) {
                var args = Array.prototype.slice.call(arguments);
                args[1] = SPRITES[key];
                return open.apply(x, args);
            }
            return open.apply(x, arguments);
        };
        return x;
    };

    /* признак автономной сборки: воркер берём из Blob, файлов рядом нет */
    window.__GF_STANDALONE__ = true;

    /* воркер движка: тот же код, но собранный в Blob со вшитым WASM */
    var WORKER_SRC = ${JSON.stringify(workerJs)};
    window.__GF_WORKER_URL__ = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
})();
`;

let out = read(path.join(web, 'index.html'));
out = out.replace(/<link rel="stylesheet"[^>]*>\s*/g, '');
out = out.replace(/<script type="module"[^>]*><\/script>\s*/g, '');
out = out.replace('</head>', `<style>\n${css}\n</style>\n</head>`);
out = out.replace('</body>', `<script>\n${bootstrap}\n</script>\n<script>\n${appJs}\n</script>\n</body>`);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, out);
/* отдельная копия воркера — пригодится, если захочется отдать его файлом */
fs.writeFileSync(path.join(outDir, 'gambitfish.worker.js'), workerJs);

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`собрано: ${path.relative(root, outFile)} (${kb} КБ)`);
console.log(`  приложение ${(appJs.length / 1024).toFixed(0)} КБ · воркер ${(workerJs.length / 1024).toFixed(0)} КБ · CSS ${(css.length / 1024).toFixed(0)} КБ`);
