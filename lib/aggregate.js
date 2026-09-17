// dsh-usage-dashboard —— 解析 ~/.dsh/sessions 的 zstd 会话日志并聚合为用量数据
// 规则（侦察结论 2026-09-17，详见 README）：
//   - 同目录并存 session.v3.jsonl.zstd 时只解析 v3（v3 是全量重写，防双计）
//   - 旧版 usage 在 assistant/chunk(chunk.type==='usage')；v3 在 assistant/message 的 data.usage
//   - 流式时间戳兼容 time 与 time0+dt[] 增量数组，用于估算 Decode 速度
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const VERSION = 2;
const HOME = os.homedir();
export const SESSIONS_DIR = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'sessions')
  : path.join(HOME, '.dsh', 'sessions');
const GAP_CAP_MS = 5 * 60 * 1000;      // 会话内事件间隔超过 5 分钟不计入活跃时长
const MIN_SPAN_MS = 200;               // 流式跨度 <200ms 的消息不参与 Decode 速度统计
const TIME_FLOOR = 1577836800000;      // 2020-01-01：过滤个别会话文件里 time≈0 的脏事件

// ---------- zstd 多帧切分与解压 ----------
function extractFrames(buf) {
  const offs = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) {
      offs.push(i); i += 3;
    }
  }
  const chunks = [];
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end))); } catch (_) { /* 魔法数误报，跳过 */ }
  }
  return chunks;
}

// 从事件里提取时间范围（兼容 time 与 time0+dt[] 两种流式编码）
function evRange(e) {
  let st = Infinity, en = 0;
  const scan = o => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.time === 'number') { if (o.time < st) st = o.time; if (o.time > en) en = o.time; }
    if (typeof o.time0 === 'number') {
      if (o.time0 < st) st = o.time0;
      let t = o.time0;
      if (Array.isArray(o.dt)) for (const d of o.dt) t += d;
      if (t > en) en = t;
    }
  };
  const d = e.data || {};
  scan(d);
  if (d.chunk) scan(d.chunk);
  if (Array.isArray(d.stream)) for (const s of d.stream) { scan(s); if (s && s.chunk) scan(s.chunk); }
  return en > st ? [st, en] : null;
}

const dayKey = ts => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const hourKey = ts => dayKey(ts) + 'T' + String(new Date(ts).getHours()).padStart(2, '0') + ':00';

function blankDay(date) {
  return { date, tokens: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, userMsgs: 0, toolTotal: 0, reqTotal: 0, durationMs: 0, sessions: 0, byModel: {}, byTool: {} };
}

// ---------- 解析单个会话文件 ----------
function parseSessionFile(file, stat) {
  const buf = fs.readFileSync(file);
  const dirName = path.basename(path.dirname(file));
  const rec = {
    file, mtime: stat.mtimeMs, size: stat.size,
    id: dirName.replace(/^session-/, ''),
    project: path.basename(path.dirname(path.dirname(file))),
    activeMs: 0, start: Infinity, end: 0,
    days: {},  // date -> blankDay
    hours: {}, // 'YYYY-MM-DDTHH:00' -> blankDay（同结构，供今日按小时视图）
  };
  const addSeg = (t1, t2) => {
    if (!(t2 > t1)) return;
    if (t1 < rec.start) rec.start = t1;
    if (t2 > rec.end) rec.end = t2;
    rec.activeMs += Math.min(t2 - t1, GAP_CAP_MS);
    // 按天归属：以结束时间所在天记当天时长（跨天段归结束日，误差可忽略）
    const dk = dayKey(t2);
    if (!rec.days[dk]) rec.days[dk] = blankDay(dk);
    rec.days[dk].durationMs += Math.min(t2 - t1, GAP_CAP_MS);
  };

  const stepChunks = {};   // 旧版: turn:step -> {start,end,usage}
  const stepInfo = {};     // 旧版: turn:step -> {provider,model}（来自同组 assistant/message.source）
  let modelSelProvider = null;
  const toolSeen = new Set();
  let prevTime = null;
  let modelSel = null;

  const noteDay = ts => {
    const dk = dayKey(ts);
    if (!rec.days[dk]) rec.days[dk] = blankDay(dk);
    return rec.days[dk];
  };
  const noteHour = ts => {
    const hk = hourKey(ts);
    if (!rec.hours[hk]) rec.hours[hk] = blankDay(hk);
    return rec.hours[hk];
  };
  const noteBoth = ts => {
    const day = noteDay(ts);
    noteHour(ts);
    return day;
  };

  for (const raw of extractFrames(buf)) {
    for (const line of raw.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let e; try { e = JSON.parse(t); } catch (_) { continue; }
      const d = e.data || {};
      if (typeof e.time !== 'number' || e.time < TIME_FLOOR) continue;
      if (prevTime !== null) addSeg(prevTime, e.time);
      prevTime = e.time;

      switch (e.type) {
        case 'model/selection':
          if (d.model) modelSel = d.model;
          if (d.provider) modelSelProvider = d.provider;
          break;
        case 'session/title-llm-request':
        case 'web/deepseek-search-llm-request':
        case 'llm/retry':
          // 旁路 LLM 调用（标题生成/联网搜索辅助/重试）同样走官方 API 计费计数
          noteBoth(e.time).reqTotal++;
          break;
        case 'user/message':
          noteBoth(e.time).userMsgs++;
          break;
        case 'tool/call': {
          if (d.callId) { if (toolSeen.has(d.callId)) break; toolSeen.add(d.callId); }
          const name = d.name || 'unknown';
          const day = noteBoth(e.time);
          const hour = noteHour(e.time);
          day.byTool[name] = (day.byTool[name] || 0) + 1;
          day.toolTotal++;
          hour.byTool[name] = (hour.byTool[name] || 0) + 1;
          hour.toolTotal++;
          break;
        }
        case 'assistant/message': {
          const msg = d.message || {};
          const model = (msg.source && msg.source.model) || d.model || modelSel || 'deepseek';
          const prov = (msg.source && msg.source.provider) || d.provider || modelSelProvider || null;
          const key = d.turn + ':' + d.step;
          if (!stepInfo[key]) stepInfo[key] = { provider: prov, model };
          const u = d.usage || null;
          const rg = evRange(e);
          if (u && (u.outputTokens > 0 || u.inputTokens > 0) && prov === 'deepseek-official') {
            const day = noteBoth(e.time);
            const hour = noteHour(e.time);
            day.reqTotal++; hour.reqTotal++;
            const input = u.inputTokens || 0, output = u.outputTokens || 0,
              cacheRead = u.cacheReadTokens || 0, reasoning = u.reasoningTokens || 0;
            const tokens = u.totalTokens || (input + output + cacheRead);
            const bm = day.byModel[model] || (day.byModel[model] = { tokens: 0, input: 0, output: 0, cacheRead: 0, spanMs: 0, spanTokens: 0, reqs: 0 });
            const bh = hour.byModel[model] || (hour.byModel[model] = { tokens: 0, input: 0, output: 0, cacheRead: 0, spanMs: 0, spanTokens: 0, reqs: 0 });
            bm.reqs++; bh.reqs++;
            for (const b of [day, hour]) {
              b.tokens += tokens; b.input += input; b.output += output;
              b.cacheRead += cacheRead; b.reasoning += reasoning;
            }
            bm.tokens += tokens; bm.input += input; bm.output += output; bm.cacheRead += cacheRead;
            bh.tokens += tokens; bh.input += input; bh.output += output; bh.cacheRead += cacheRead;
            if (rg && output > 0 && rg[1] - rg[0] >= MIN_SPAN_MS) {
              bm.spanMs += rg[1] - rg[0]; bm.spanTokens += output;
              bh.spanMs += rg[1] - rg[0]; bh.spanTokens += output;
            }
          }
          break;
        }
        case 'assistant/chunk': {
          // 旧版：流块时间 + usage 都在这里
          const key = d.turn + ':' + d.step;
          const g = stepChunks[key] || (stepChunks[key] = { start: Infinity, end: 0, usage: null });
          const c = d.chunk || {};
          if (e.time < g.start) g.start = e.time;
          if (e.time > g.end) g.end = e.time;
          if (c.type === 'usage' && c.usage) g.usage = c.usage;
          break;
        }
        default: {
          // 旧版的 reasoning-chunks / text-chunks / tool-call-chunks 顶层事件也计入流式跨度
          if (/^(reasoning|text|tool-call)-chunks$/.test(e.type)) {
            const key = d.turn + ':' + d.step;
            const g = stepChunks[key] || (stepChunks[key] = { start: Infinity, end: 0, usage: null });
            const r = evRange(e);
            if (r) { if (r[0] < g.start) g.start = r[0]; if (r[1] > g.end) g.end = r[1]; }
          }
        }
      }
    }
  }

  // 旧版分组汇总成"消息"
  for (const key in stepChunks) {
    const g = stepChunks[key];
    if (!g.usage) continue;
    const info = stepInfo[key] || {};
    if ((info.provider || modelSelProvider || 'deepseek-official') !== 'deepseek-official') continue;
    const input = g.usage.inputTokens || 0, output = g.usage.outputTokens || 0,
      cacheRead = g.usage.cacheReadTokens || 0, reasoning = g.usage.reasoningTokens || 0;
    const tokens = g.usage.totalTokens || (input + output + cacheRead);
    const ts = g.end > 0 ? g.end : (g.usage.time || rec.start);
    if (!isFinite(ts)) continue;
    const day = noteDay(ts);
    const hour = noteHour(ts);
    day.reqTotal++; hour.reqTotal++;
    day.tokens += tokens; day.input += input; day.output += output;
    day.cacheRead += cacheRead; day.reasoning += reasoning;
    hour.tokens += tokens; hour.input += input; hour.output += output;
    hour.cacheRead += cacheRead; hour.reasoning += reasoning;
    const model = info.model || modelSel || 'deepseek';
    const bm = day.byModel[model] || (day.byModel[model] = { tokens: 0, input: 0, output: 0, cacheRead: 0, spanMs: 0, spanTokens: 0, reqs: 0 });
    const bh = hour.byModel[model] || (hour.byModel[model] = { tokens: 0, input: 0, output: 0, cacheRead: 0, spanMs: 0, spanTokens: 0, reqs: 0 });
    bm.reqs++; bh.reqs++;
    bm.tokens += tokens; bm.input += input; bm.output += output; bm.cacheRead += cacheRead;
    bh.tokens += tokens; bh.input += input; bh.output += output; bh.cacheRead += cacheRead;
    if (output > 0 && isFinite(g.start) && g.end - g.start >= MIN_SPAN_MS) {
      bm.spanMs += g.end - g.start; bm.spanTokens += output;
      bh.spanMs += g.end - g.start; bh.spanTokens += output;
    }
  }

  for (const dk in rec.days) if (dk < '2020') { rec.days[dk].tokens = 0; rec.days[dk].input = 0; rec.days[dk].output = 0; rec.days[dk].cacheRead = 0; rec.days[dk].durationMs = 0; }
  rec.sessions = 1;
  if (!isFinite(rec.start)) { rec.start = stat.mtimeMs; rec.end = stat.mtimeMs; }
  return rec;
}

// ---------- 会话目录扫描 + 缓存 ----------
const cache = new Map(); // file -> rec
const dirty = [];        // 脏数据诊断
let scanNote = '';

function scanSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) { scanNote = '未找到 ' + SESSIONS_DIR; return; }
  scanNote = '';
  const files = [];
  const visit = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { if (depth < 3) visit(full, depth + 1); }
      else if (/^session(\.v3)?\.jsonl\.zstd$/.test(ent.name)) files.push(full);
    }
  };
  visit(SESSIONS_DIR, 0);

  // 按会话目录去重：优先 v3
  const byDir = new Map();
  for (const f of files) {
    const dir = path.dirname(f);
    const isV3 = f.includes('.v3.');
    const cur = byDir.get(dir);
    if (!cur || (isV3 && !cur.isV3)) byDir.set(dir, { file: f, isV3 });
  }

  dirty.length = 0;
  for (const { file } of byDir.values()) {
    let st; try { st = fs.statSync(file); } catch (_) { continue; }
    const c = cache.get(file);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) continue;
    try {
      const rec = parseSessionFile(file, st);
      for (const dk in rec.days) if (dk < '2020') dirty.push({ file: rec.file.replace(HOME, '~'), day: dk, tokens: rec.days[dk].tokens });
      cache.set(file, rec);
    }
    catch (err) { console.error('[parse-fail]', file, err.message); }
  }
  // 清理已消失文件
  const alive = new Set([...byDir.values()].map(v => v.file));
  for (const f of [...cache.keys()]) if (!alive.has(f)) cache.delete(f);
}

// ---------- 聚合 ----------
export function aggregate() {
  scanSessions();
  const recs = [...cache.values()];
  const all = blankDay('__all__');
  const dayMap = new Map();
  let totalActiveMs = 0, sessionCount = 0;
  const modelTotals = {};

  for (const rec of recs) {
    sessionCount++;
    totalActiveMs += rec.activeMs;
    for (const dk in rec.days) {
      const src = rec.days[dk];
      if (!dayMap.has(dk)) dayMap.set(dk, blankDay(dk));
      const dst = dayMap.get(dk);
      dst.sessions++;
      dst.durationMs += src.durationMs;
      dst.userMsgs += src.userMsgs;
      dst.toolTotal += src.toolTotal;
      dst.reqTotal += src.reqTotal || 0;
      for (const k of ['tokens', 'input', 'output', 'cacheRead', 'reasoning']) dst[k] += src[k];
      for (const m in src.byModel) {
        const s = src.byModel[m];
        const t = dst.byModel[m] || (dst.byModel[m] = { tokens: 0, input: 0, output: 0, cacheRead: 0, spanMs: 0, spanTokens: 0, reqs: 0 });
        for (const k of ['tokens', 'input', 'output', 'cacheRead', 'spanMs', 'spanTokens', 'reqs']) t[k] += s[k] || 0;
        const g = modelTotals[m] || (modelTotals[m] = { model: m, tokens: 0, input: 0, output: 0, cacheRead: 0 });
        g.tokens += s.tokens; g.input += s.input; g.output += s.output; g.cacheRead += s.cacheRead;
      }
      for (const tl in src.byTool) dst.byTool[tl] = (dst.byTool[tl] || 0) + src.byTool[tl];
    }
  }

  for (const d of dayMap.values()) {
    for (const k of ['tokens', 'input', 'output', 'cacheRead', 'reasoning', 'userMsgs', 'toolTotal']) all[k] += d[k];
  }

  // 连续天数（以"有 token 消耗"的天为准）
  const datesWithUse = [...dayMap.values()].filter(d => d.tokens > 0).map(d => d.date).sort();
  const dnum = s => Number(s.replace(/-/g, ''));
  let longest = 0, curRun = 0, prev = null;
  for (const dt of datesWithUse) {
    curRun = prev !== null && dnum(dt) === dnum(prev) + 1 ? curRun + 1 : 1;
    if (curRun > longest) longest = curRun;
    prev = dt;
  }
  const today = new Date();
  const mk = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const todayKey = mk(today);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  let currentStreak = 0;
  const has = k => dayMap.has(k) && dayMap.get(k).tokens > 0;
  if (has(todayKey) || has(mk(yest))) {
    const cursor = new Date(has(todayKey) ? today : yest);
    for (;;) {
      if (!has(mk(cursor))) break;
      currentStreak++;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  // 补零到完整日期序列（首日到今天）
  const days = [];
  if (datesWithUse.length) {
    const first = new Date(datesWithUse[0] + 'T00:00:00');
    const last = new Date(todayKey + 'T00:00:00');
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      const k = mk(d);
      const src = dayMap.get(k);
      if (src) {
        days.push({
          date: src.date, tokens: src.tokens, input: src.input, output: src.output, cacheRead: src.cacheRead,
          toolCalls: src.toolTotal, reqs: src.reqTotal, sessions: src.sessions, durationMs: src.durationMs, userMsgs: src.userMsgs,
          byModel: src.byModel, byTool: src.byTool,
        });
      } else {
        days.push({ date: k, tokens: 0, input: 0, output: 0, cacheRead: 0, toolCalls: 0, sessions: 0, durationMs: 0, userMsgs: 0, byModel: {}, byTool: {} });
      }
    }
  }

  let peak = { date: '', tokens: 0 };
  for (const d of days) if (d.tokens > peak.tokens) peak = { date: d.date, tokens: d.tokens };

  // 按小时序列（最近 48 小时，供"今日"视图按小时聚合图表）
  const hourMap = new Map();
  for (const rec of recs) {
    for (const hk in rec.hours) {
      if (hk < '2020') continue;
      if (!hourMap.has(hk)) hourMap.set(hk, blankDay(hk));
      const dst = hourMap.get(hk), src = rec.hours[hk];
      dst.userMsgs += src.userMsgs; dst.toolTotal += src.toolTotal; dst.durationMs += src.durationMs;
      dst.reqTotal += src.reqTotal || 0;
      for (const k of ['tokens', 'input', 'output', 'cacheRead', 'reasoning']) dst[k] += src[k];
      for (const m in src.byModel) {
        const s = src.byModel[m];
        const t = dst.byModel[m] || (dst.byModel[m] = { tokens: 0, input: 0, output: 0, cacheRead: 0, spanMs: 0, spanTokens: 0, reqs: 0 });
        for (const k of ['tokens', 'input', 'output', 'cacheRead', 'spanMs', 'spanTokens', 'reqs']) t[k] += s[k] || 0;
      }
      for (const tl in src.byTool) dst.byTool[tl] = (dst.byTool[tl] || 0) + src.byTool[tl];
    }
  }
  // 全量保留（与 days 同范围），供前端所有范围做逐小时精确分时计费
  const hours = [...hourMap.values()].sort((a, b) => a.date < b.date ? -1 : 1)
    .map(h => ({ date: h.date, tokens: h.tokens, input: h.input, output: h.output, cacheRead: h.cacheRead, toolCalls: h.toolTotal, reqs: h.reqTotal, byModel: h.byModel, byTool: h.byTool }));

  return {
    version: VERSION,
    generatedAt: Date.now(),
    sessionsDir: SESSIONS_DIR,
    sessionCount,
    note: scanNote,
    dirty,
    totals: {
      tokens: all.tokens, input: all.input, output: all.output, cacheRead: all.cacheRead,
      toolCalls: all.toolTotal, userMsgs: all.userMsgs,
      durationMs: totalActiveMs,
    },
    peak,
    currentStreak,
    longestStreak: longest,
    days,
    hours,
  };
}
