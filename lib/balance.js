// DeepSeek 开放平台余额查询：读 env/凭据文件里的 API Key，调 /user/balance，带 60s 缓存。
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

let cache = { at: 0, key: null, data: null };

/** 依次从环境变量、$DSH_HOME/.credentials.yaml、~/.dsh/.credentials.yaml 读取官方 API Key。 */
export function readConfiguredKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const dirs = [process.env.DSH_HOME, path.join(HOME, '.dsh')].filter(Boolean);
  for (const d of dirs) {
    try {
      const t = fs.readFileSync(path.join(d, '.credentials.yaml'), 'utf8');
      const m = t.match(/DEEPSEEK_API_KEY["']?\s*:\s*["']?([A-Za-z0-9_-]{10,})["']?/);
      if (m) return m[1];
    } catch (_) { /* 文件不存在则跳过 */ }
  }
  return null;
}

/**
 * 查询余额。keyOverride 来自前端的本地设置（仅本机存储，经请求头传入）。
 * @returns {Promise<{ok:boolean, isAvailable?:boolean, balances?:Array<{currency:string,total:string}>, error?:string, needsKey?:boolean}>}
 */
export async function getBalance(keyOverride) {
  const key = (keyOverride || '').trim() || readConfiguredKey();
  if (!key) return { ok: false, needsKey: true, error: '未配置 DeepSeek API Key' };
  if (cache.data && cache.key === key && Date.now() - cache.at < 60000) return cache.data;
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const data = { ok: false, needsKey: res.status === 401, error: (j.error && j.error.message) || 'HTTP ' + res.status };
      if (res.status === 401) cache = { at: Date.now(), key, data };
      return data;
    }
    const data = {
      ok: true,
      isAvailable: !!j.is_available,
      balances: (j.balance_infos || []).map(b => ({ currency: b.currency, total: b.total_balance })),
    };
    cache = { at: Date.now(), key, data };
    return data;
  } catch (err) {
    return { ok: false, error: '网络错误: ' + String(err && err.message || err) };
  }
}
