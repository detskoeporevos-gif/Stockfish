#!/usr/bin/env node
/* Мини-сервер без зависимостей: раздаёт статику из web/ и отдаёт
   правильные MIME-типы для .wasm и ES-модулей. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WASM_DIR = path.join(ROOT, 'public');
const PORT = process.env.PORT ? +process.env.PORT : 5173;
const HOST = '0.0.0.0';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

function resolve(urlPath) {
    if (urlPath === '/') return path.join(ROOT, 'index.html');
    if (urlPath.endsWith('/gambitfish.wasm')) return path.join(WASM_DIR, 'gambitfish.wasm');
    const p = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    return p.startsWith(ROOT) ? p : null;
}

const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = resolve(urlPath);
    if (!filePath) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found: ' + urlPath); return; }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`GambitFish UI: http://${HOST}:${PORT}/`);
});
