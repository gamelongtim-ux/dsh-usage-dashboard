// dsh-usage-dashboard —— 独立运行模式（不装进 dsh 时用）
// 启动：node server.js → http://127.0.0.1:7900
// 装进 dsh 的方式见 README：dsh plugin add 后由 dsh 自带 Web 服务在 /usage-dashboard 提供同样页面。
'use strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from './lib/aggregate.js';

const PORT = Number(process.env.PORT || 7900);
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/data') {
    let data;
    try { data = aggregate(); } catch (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(err && err.message || err) })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  p = path.normalize(p).replace(/^([.][.][\\/])+/, '');
  const file = path.join(PUB, p);
  if (!file.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fsRead(file, res);
});

import { readFile } from 'node:fs/promises';
function fsRead(file, res) {
  readFile(file).then(buf => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  }).catch(() => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('[dsh-usage-dashboard] http://localhost:' + PORT);
});
