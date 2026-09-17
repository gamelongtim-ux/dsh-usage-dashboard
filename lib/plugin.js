// dsh-usage-dashboard —— cordis 插件：在 dsh 自带 Web 服务上挂 /usage-dashboard
// 复刻 ZCode 风格的用量总览（活跃度热力图 / 用量趋势 / 系统健康度 / Token 趋势 / 模型环图），
// 数据实时解析 $DSH_HOME（默认 ~/.dsh）下的会话日志。
'use strict';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { aggregate } from './aggregate.js';
import { getBalance } from './balance.js';

/** Stable Cordis plugin name. */
const name = 'usage-dashboard';
/** Services required before the route can be claimed. */
const inject = ['webServer'];

const Config = z.object({
  /** 挂载前缀；重定向与静态资源都按它提供 */
  path: z.string().default('/usage-dashboard'),
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/**
 * Register the dashboard prefix route on the host webserver.
 * @param {object} ctx - plugin context carrying the webServer service.
 * @param {{path?: string}} config - validated {@link Config}.
 */
function apply(ctx, config) {
  const routePath = '/' + String(config.path ?? '/usage-dashboard').replace(/^\/+|\/+$/g, '');
  const pubRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', 'public'));
  const send = (res, code, type, body) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: routePath,
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
        return;
      }
      let rest;
      try { rest = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); }
      catch (_) { send(res, 400, 'text/plain; charset=utf-8', 'bad request'); return; }
      rest = rest.slice(routePath.length);
      if (rest === '') { // 无尾斜杠时补齐，让页面里的相对路径指向本前缀
        res.writeHead(302, { location: routePath + '/' });
        res.end();
        return;
      }
      if (rest === '/' || rest === '') rest = '/index.html';
      if (rest === '/api/data') {
        try { send(res, 200, 'application/json; charset=utf-8', JSON.stringify(aggregate())); }
        catch (error) { send(res, 500, 'application/json', JSON.stringify({ error: String(error && error.message || error) })); }
        return;
      }
      if (rest === '/api/balance') {
        const headerKey = req.headers['x-dsh-key'];
        getBalance(typeof headerKey === 'string' ? headerKey : undefined)
          .then(b => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(b)))
          .catch(error => send(res, 500, 'application/json', JSON.stringify({ ok: false, error: String(error && error.message || error) })));
        return;
      }
      const target = normalize(join(pubRoot, rest));
      if (target !== pubRoot && !target.startsWith(pubRoot + sep)) {
        send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
        return;
      }
      try {
        const body = await readFile(target);
        send(res, 200, MIME[extname(target)] ?? 'application/octet-stream', body);
      } catch (error) {
        send(res, 404, 'text/plain; charset=utf-8', 'not found');
      }
    },
  }), 'usage-dashboard: route');
}

export { Config, apply, inject, name };
