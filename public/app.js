'use strict';
/* dsh 用量信息 —— DeepSeek 开放平台「用量信息」同款布局，数据来自 dsh 会话日志。
   主题：从 dsh 宿主界面同步 --dsw-* 变量到本页 --u-*（Light/Dark/System 自动跟随）。
   粒度：「今天」视图按小时（24 桶），近 7 天 / 近 30 天按天。
   计费：官方价格表分时估算（高峰/空闲），可在「单价设置」按模型覆盖。 */

const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in (attrs || {})) if (attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
  return e;
}

const PALETTE = ['#4C8DFF', '#3ECF8E', '#A78BFA', '#F87171', '#FB923C', '#22D3EE', '#FACC15', '#F472B6', '#34D399', '#60A5FA'];
const OTHER_COLOR = '#8b929a';

let DATA = null;
let RANGE = 1;
let barDim = 'model';
const hiddenBars = new Set();

/* ---------------- 格式化 ---------------- */
const trim1 = x => String(Math.round(x * 10) / 10);
function fmtTokens(n) {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1e8) return trim1(n / 1e8) + '亿';
  if (n >= 1e4) return trim1(n / 1e4) + '万';
  return Math.round(n).toLocaleString('en-US');
}
function fmtInt(n) { return Math.round(n).toLocaleString('en-US'); }
function fmtMoney(n, currency) {
  const sym = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : (currency ? currency + ' ' : '');
  return sym + (Math.abs(n) >= 100 ? trim1(n) : n.toFixed(2));
}
function fmtCost(n) { return '¥' + (Math.abs(n) >= 100 ? trim1(n) : n >= 1 ? n.toFixed(2) : n.toFixed(3)); }
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${mm}分`;
  return `${mm}分钟`;
}
const md = ds => { const p = ds.split('-'); return `${+p[1]}月${+p[2]}日`; };
const cmd = ds => { const p = ds.split('-'); return `${p[0]}年${+p[1]}月${+p[2]}日`; };

/* ---------------- tooltip ---------------- */
const tip = $('#tip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 12;
  if (left + r.width > innerWidth - 8) left = Math.max(8, x - r.width - 14);
  if (top < 8) top = y + 18;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideTip() { tip.style.display = 'none'; }
function tipHTML(title, rows) {
  let h = `<div class="tt">${title}</div>`;
  for (const r of rows) h += `<div class="tr"><span class="nm"><span class="dot" style="background:${r.color}"></span>${r.name}</span><span>${r.value}</span></div>`;
  return h;
}

/* ---------------- 数据辅助 ---------------- */
function rangeDays() { const n = DATA.days.length; return DATA.days.slice(Math.max(0, n - RANGE)); }
function prevDays() { const n = DATA.days.length; return DATA.days.slice(Math.max(0, n - 2 * RANGE), Math.max(0, n - RANGE)); }
function todayKeyStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayHours() {
  const map = new Map((DATA.hours || []).map(h => [h.date, h]));
  const tk = todayKeyStr();
  const out = [];
  for (let h = 0; h < 24; h++) {
    const key = tk + 'T' + String(h).padStart(2, '0') + ':00';
    out.push(map.get(key) || { date: key, byModel: {}, byTool: {} });
  }
  return out;
}
function bucketDays() {
  return RANGE === 1 ? officialDays(todayHours()) : officialDays(rangeDays());
}

/* 官方模型归一化：日志里的历史/限时 id 全部映射到 dsh 官方 provider 的 4 个模型显示名 */
function normalizeModel(name) {
  const m = String(name || '').toLowerCase();
  if (!m.startsWith('deepseek-')) return null;
  if (m === 'deepseek-flash' || m.includes('v4.1-flash')) return 'DeepSeek-V4.1-Flash';
  if (m.includes('vision')) return 'DeepSeek-V4-Flash-Vision-Exp';
  if (m.includes('v4-pro') || m.includes('pro')) return 'DeepSeek-V4-Pro';
  if (m.includes('v4-flash') || m === 'deepseek-v4') return 'DeepSeek-V4-Flash';
  return 'DeepSeek-V4.1-Flash';
}
function officialDays(days) {
  return days.map(d => {
    const bm = {};
    let tokens = 0, input = 0, cacheRead = 0;
    for (const [m, v] of Object.entries(d.byModel || {})) {
      const n = normalizeModel(m);
      if (!n) continue;
      const t = bm[n] || (bm[n] = { tokens: 0, input: 0, output: 0, cacheRead: 0, spanMs: 0, spanTokens: 0, reqs: 0 });
      for (const k of ['tokens', 'input', 'output', 'cacheRead', 'spanMs', 'spanTokens', 'reqs']) t[k] += v[k] || 0;
      tokens += v.tokens || 0;
      input += v.input || 0;
      cacheRead += v.cacheRead || 0;
    }
    return { ...d, ofByModel: bm, ofTokens: tokens, ofInput: input, ofCacheRead: cacheRead };
  });
}
function modelTotalsOf(days) {
  const map = new Map();
  for (const d of days) for (const [m, v] of Object.entries(d.ofByModel)) {
    const t = map.get(m) || { tokens: 0, reqs: 0 };
    t.tokens += v.tokens || 0;
    t.reqs += v.reqs || 0;
    map.set(m, t);
  }
  return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens).map(([name, t]) => ({ name, ...t }));
}
function toolTotalsInRange(days) {
  const map = new Map();
  for (const d of days) for (const t in d.byTool) map.set(t, (map.get(t) || 0) + d.byTool[t]);
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}
function hitRate(days) {
  const hit = sumField(days, 'ofCacheRead'), miss = sumField(days, 'ofInput');
  const tot = hit + miss;
  return tot > 0 ? hit / tot : null;
}
function sumField(days, f) { return days.reduce((s, d) => s + (d[f] || 0), 0); }

/* ---------------- 计费（官方价格表分时估算） ---------------- */
/* 官方价格（¥/百万 tokens）：高峰=周一至五 9:00-12:00、14:00-18:00（北京时间）；空闲为高峰一半。
   遗留 id（deepseek-v4-flash* 等）按官方说明由 V4.1-Flash 同价服务。 */
const OFFICIAL_PRICES = {
  'DeepSeek-V4.1-Flash': { hitP: 0.04, hitO: 0.02, missP: 2, missO: 1, outP: 8, outO: 4 },
  'DeepSeek-V4-Flash': { hitP: 0.04, hitO: 0.02, missP: 2, missO: 1, outP: 8, outO: 4 },
  'DeepSeek-V4-Flash-Vision-Exp': { hitP: 0.04, hitO: 0.02, missP: 2, missO: 1, outP: 8, outO: 4 },
  'DeepSeek-V4-Pro': { hitP: 0.3, hitO: 0.15, missP: 9, missO: 4.5, outP: 27, outO: 13.5 },
};
function priceTable() {
  try { return JSON.parse(localStorage.getItem('dshPrices_v1') || '{}'); } catch (_) { return {}; }
}
function priceTableEmpty() { return !Object.keys(priceTable()).length; }
function isPeakLocal(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const day = d.getDay(), h = d.getHours();
  return day >= 1 && day <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
}
/** 模型分时单价：用户自定义（字段级回落）否则内置官方价。 */
function modelPrices(m) {
  const base = OFFICIAL_PRICES[m] || OFFICIAL_PRICES['DeepSeek-V4.1-Flash'];
  const custom = priceTable()[m] || {};
  const pick = (k, fb) => {
    const v = parseFloat(custom[k]);
    return isFinite(v) && v > 0 ? v : (isFinite(parseFloat(custom[fb])) && parseFloat(custom[fb]) > 0 ? parseFloat(custom[fb]) : base[k]);
  };
  return {
    hitP: pick('hitP', 'input'), missP: pick('missP', 'input'),
    hitO: pick('hitO', 'cacheRead'), missO: pick('missO', 'input'),
    outP: pick('outP', 'output'), outO: pick('outO', 'output'),
  };
}
/** 单桶费用估算：官方分时价（可被「单价设置」按字段覆盖）。 */
function bucketCost(day) {
  let cost = 0;
  for (const [m, v] of Object.entries(day.ofByModel || {})) {
    const dp = modelPrices(m);
    const peak = isPeakLocal(day.date);
    const miss = peak ? dp.missP : dp.missO;
    const hit = peak ? dp.hitP : dp.hitO;
    const out = peak ? dp.outP : dp.outO;
    cost += ((v.input || 0) * miss + (v.cacheRead || 0) * hit + (v.output || 0) * out) / 1e6;
  }
  return cost;
}
/** 单模型单桶费用 */
function modelCost(day, model) {
  const v = day.ofByModel[model];
  if (!v) return 0;
  return bucketCost({ date: day.date, ofByModel: { [model]: v } });
}
/** 天桶费用：按星期的高峰时长占比混合高峰/空闲价（小时桶则精确分时）。 */
function dayCost(day) {
  if (day.date && day.date.includes('T')) return bucketCost(day);
  const d = new Date(day.date + 'T00:00:00');
  const weekday = d.getDay() >= 1 && d.getDay() <= 5;
  const f = weekday ? 7 / 24 : 0; // 高峰小时占比
  let cost = 0;
  for (const [m, v] of Object.entries(day.ofByModel || {})) {
    const dp = modelPrices(m);
    const miss = f * dp.missP + (1 - f) * dp.missO;
    const hit = f * dp.hitP + (1 - f) * dp.hitO;
    const out = f * dp.outP + (1 - f) * dp.outO;
    cost += ((v.input || 0) * miss + (v.cacheRead || 0) * hit + (v.output || 0) * out) / 1e6;
  }
  return cost;
}

/* ---------------- 主题桥：同步 dsh 宿主变量 ---------------- */
const THEME_VARS = {
  bg: ['--dsw-specific-sidebar-fill', '--dsw-alias-bg-layer-2'],
  card: ['--dsw-alias-bg-layer-3'],
  card2: ['--dsw-alias-bg-layer-2'],
  card3: ['--dsw-alias-bg-layer-1'],
  border: ['--dsw-alias-border-l1'],
  border2: ['--dsw-alias-border-l2'],
  text: ['--dsw-alias-label-primary'],
  text2: ['--dsw-alias-label-secondary'],
  muted: ['--dsw-alias-label-caption', '--dsw-alias-label-tertiary', '--dsw-alias-label-secondary'],
  muted2: ['--dsw-alias-label-tertiary', '--dsw-alias-label-caption', '--dsw-alias-label-secondary'],
  blue: ['--dsw-alias-button-info-fill'],
  green: ['--dsw-alias-state-success-primary'],
  red: ['--dsw-alias-state-error-primary'],
  warn: ['--dsw-alias-state-warn-primary'],
  tip: ['--dsw-alias-tooltip-bg'],
};
const THEME_FALLBACK = {
  '--u-bg': '#2c2c2e', '--u-card': '#353638', '--u-card2': '#2c2c2e', '--u-card3': '#232324',
  '--u-border': '#ffffff0f', '--u-border2': '#ffffff1f',
  '--u-text': '#f9fafb', '--u-text2': '#cfd3d6', '--u-muted': '#81858c', '--u-muted2': '#adb2b8',
  '--u-blue': '#679efe', '--u-green': '#22c55e', '--u-red': '#f25a5a', '--u-warn': '#f59e0b',
  '--u-tip': '#43454a', '--u-tip-text': '#f9fafb',
};
function hexLum(v) {
  const m = /#([0-9a-f]{3,8})/i.exec(v || '');
  if (!m) return null;
  let c = m[1];
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  c = c.slice(0, 6);
  const f = x => { const t = parseInt(x, 16) / 255; return t <= 0.03928 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.slice(0, 2)) + 0.7152 * f(c.slice(2, 4)) + 0.0722 * f(c.slice(4, 6));
}
function contrast(a, b) {
  const la = hexLum(a), lb = hexLum(b);
  if (la == null || lb == null) return 99;
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
function pickReadable(cs, names, bg) {
  let first = '';
  for (const n of names) {
    const v = (cs.getPropertyValue(n) || '').trim();
    if (!v) continue;
    if (!first) first = v;
    if (contrast(v, bg) >= 3) return v;
  }
  return first;
}
function applyTheme() {
  let cs = null, dlgBg = '';
  try {
    if (parent && parent !== window) {
      const pd = parent.document;
      const dlg = pd.querySelector('[role="dialog"], dialog');
      if (dlg) dlgBg = getComputedStyle(dlg).backgroundColor.trim();
      const cands = [pd.body, pd.documentElement, ...pd.querySelectorAll('[class]')].slice(0, 300);
      for (const el of cands) {
        if (!el) continue;
        if (getComputedStyle(el).getPropertyValue('--dsw-alias-bg-base').trim()) { cs = parent.getComputedStyle(el); break; }
      }
    }
  } catch (_) { /* 独立模式或跨域 */ }
  const set = (local, v) => document.documentElement.style.setProperty(local, v || THEME_FALLBACK[local]);
  const bg = dlgBg || (cs ? (cs.getPropertyValue('--dsw-alias-bg-layer-2') || '').trim() : '') || THEME_FALLBACK['--u-bg'];
  set('--u-bg', bg);
  for (const key of ['card', 'card2', 'card3', 'border', 'border2', 'blue', 'green', 'red', 'warn', 'tip']) {
    let v = '';
    if (cs) for (const n of THEME_VARS[key]) { v = (cs.getPropertyValue(n) || '').trim(); if (v) break; }
    set('--u-' + key, v);
  }
  const cardBg = document.documentElement.style.getPropertyValue('--u-card').trim() || bg;
  const read = names => cs ? pickReadable(cs, names, cardBg) : '';
  set('--u-text', read(THEME_VARS.text));
  set('--u-text2', read(THEME_VARS.text2));
  set('--u-muted', read(THEME_VARS.muted));
  set('--u-muted2', read(THEME_VARS.muted2));
  const tipBg = document.documentElement.style.getPropertyValue('--u-tip').trim() || THEME_FALLBACK['--u-tip'];
  set('--u-tip-text', contrast('#111111', tipBg) >= 3 ? '#111111' : '#f9fafb');
}

/* ---------------- 折线/面积图 ---------------- */
function smoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += `C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6},${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6},${p2.x},${p2.y}`;
  }
  return d;
}

function renderLineChart(container, opts) {
  const { series, labels, yFmt, H = 260, rowFmt, labelX, area = false } = opts;
  const lx = labelX || md;
  container.innerHTML = '';
  if (!labels.length || !series.length) return;
  const W = container.clientWidth || 860;
  const padL = 52, padR = 20, padT = 14, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxV = Math.max(1, ...series.flatMap(s => s.values.filter(v => v != null)));
  const X = i => padL + (labels.length === 1 ? iw / 2 : i * (iw / (labels.length - 1)));
  const Y = v => padT + ih - (v / maxV) * ih;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H });

  for (let g = 0; g <= 4; g++) {
    const gv = maxV * g / 4, gy = Y(gv);
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: gy, y2: gy, class: g > 0 ? 'grid' : 'grid0', 'stroke-dasharray': g > 0 ? '3,5' : undefined }));
    const t = svgEl('text', { x: padL - 9, y: gy + 4, 'text-anchor': 'end', class: 'ax' });
    t.textContent = yFmt(gv);
    svg.appendChild(t);
  }
  const step = Math.max(1, Math.ceil(labels.length / 8));
  const labeled = [];
  labels.forEach((lb, i) => { if (i % step === 0) labeled.push(i); });
  if (labeled.length && labeled[labeled.length - 1] !== labels.length - 1 && labels.length - 1 - labeled[labeled.length - 1] < Math.ceil(step * 0.6)) labeled.pop();
  labeled.push(labels.length - 1);
  [...new Set(labeled)].forEach(i => {
    const t = svgEl('text', { x: X(i), y: H - 7, 'text-anchor': 'middle', class: 'axx' });
    t.textContent = lx(labels[i]);
    svg.appendChild(t);
  });

  for (const s of series) {
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const d = smoothPath(run);
        if (area) svg.appendChild(svgEl('path', { d: d + `L${run[run.length - 1].x},${padT + ih}L${run[0].x},${padT + ih}Z`, fill: s.color, opacity: .18, stroke: 'none' }));
        svg.appendChild(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.2, 'stroke-linecap': 'round' }));
      } else if (run.length === 1) {
        svg.appendChild(svgEl('circle', { cx: run[0].x, cy: run[0].y, r: 2.4, fill: s.color }));
      }
      run = [];
    };
    s.values.forEach((v, i) => { if (v == null) flush(); else run.push({ x: X(i), y: Y(v) }); });
    flush();
  }

  const guide = svgEl('line', { y1: padT, y2: padT + ih, class: 'guide' });
  svg.appendChild(guide);
  const dots = series.map(s => { const c = svgEl('circle', { r: 3.4, fill: s.color, stroke: 'var(--u-card)', 'stroke-width': 1.5, opacity: 0 }); svg.appendChild(c); return c; });

  const overlay = svgEl('rect', { x: padL - 30, y: padT, width: iw + 60, height: ih, fill: 'transparent' });
  overlay.addEventListener('mousemove', ev => {
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    let idx = 0, best = 1e18;
    for (let i = 0; i < labels.length; i++) { const d2 = Math.abs(X(i) - mx); if (d2 < best) { best = d2; idx = i; } }
    guide.setAttribute('x1', X(idx)); guide.setAttribute('x2', X(idx)); guide.setAttribute('opacity', 1);
    const rows = [];
    series.forEach((s, si) => {
      const v = s.values[idx];
      dots[si].setAttribute('cx', X(idx));
      dots[si].setAttribute('cy', v == null ? padT + ih : Y(v));
      dots[si].setAttribute('opacity', v == null ? 0 : 1);
      if (v != null) rows.push({ color: s.color, name: s.name, value: rowFmt ? rowFmt(v) : yFmt(v) });
    });
    showTip(tipHTML(`${lx(labels[idx])}${opts.tipSuffix ? ' - ' + opts.tipSuffix(idx) : ''}`, rows), ev.clientX, ev.clientY);
  });
  overlay.addEventListener('mouseleave', () => {
    guide.setAttribute('opacity', 0);
    dots.forEach(d => d.setAttribute('opacity', 0));
    hideTip();
  });
  svg.appendChild(overlay);
  container.appendChild(svg);
}

/* ---------------- 堆叠柱状图 ---------------- */
function renderStackedBars(container, opts) {
  const { days, series, valueOf, fmtVal, H = 280, labelX, title } = opts;
  const isHour = RANGE === 1;
  const lx = labelX || md;
  container.innerHTML = '';
  if (!days.length || !series.length) return;
  const W = container.clientWidth || 860, hh = H;
  const padL = 52, padR = 20, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = hh - padT - padB;
  const visible = series.filter(s => !hiddenBars.has(s.key));
  const totals = days.map(d => visible.reduce((s, ser) => s + valueOf(d, ser.key), 0));
  const maxV = Math.max(1, ...totals);
  const Y = v => padT + ih - (v / maxV) * ih;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${hh}`, height: hh });
  for (let g = 0; g <= 4; g++) {
    const gv = maxV * g / 4, gy = Y(gv);
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: gy, y2: gy, class: g > 0 ? 'grid' : 'grid0', 'stroke-dasharray': g > 0 ? '3,5' : undefined }));
    const t = svgEl('text', { x: padL - 9, y: gy + 4, 'text-anchor': 'end', class: 'ax' });
    t.textContent = fmtVal(gv);
    svg.appendChild(t);
  }
  const slot = iw / days.length;
  const bw = Math.max(4, Math.min(30, isHour ? slot * 0.72 : slot * 0.5));
  const X = i => padL + slot * i + (slot - bw) / 2;
  const step = Math.max(1, Math.ceil(days.length / 8));
  const labeled = [];
  days.forEach((d, i) => { if (i % step === 0) labeled.push(i); });
  if (labeled.length && labeled[labeled.length - 1] !== days.length - 1 && days.length - 1 - labeled[labeled.length - 1] < Math.ceil(step * 0.6)) labeled.pop();
  labeled.push(days.length - 1);
  [...new Set(labeled)].forEach(i => {
    const t = svgEl('text', { x: X(i) + bw / 2, y: hh - 7, 'text-anchor': 'middle', class: 'axx' });
    t.textContent = lx(days[i].date);
    svg.appendChild(t);
  });
  days.forEach((d, i) => {
    let yCur = padT + ih;
    for (const ser of visible) {
      const v = valueOf(d, ser.key);
      if (v <= 0) continue;
      const h = Math.max(1.5, (v / maxV) * ih);
      yCur -= h;
      svg.appendChild(svgEl('rect', { x: X(i), y: yCur, width: bw, height: h, fill: ser.color, rx: 1.5 }));
    }
  });
  const overlay = svgEl('rect', { x: padL, y: padT, width: iw, height: ih, fill: 'transparent' });
  overlay.addEventListener('mousemove', ev => {
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    let idx = Math.floor((mx - padL) / slot);
    idx = Math.max(0, Math.min(days.length - 1, idx));
    const rows = visible
      .map(ser => ({ color: ser.color, name: ser.key, value: fmtVal(valueOf(days[idx], ser.key)), raw: valueOf(days[idx], ser.key) }))
      .filter(r => r.raw > 0)
      .sort((a, b) => b.raw - a.raw);
    showTip(tipHTML(`${lx(days[idx].date)} · ${fmtVal(totals[idx])}`, rows.length ? rows : [{ color: '#8b929a', name: '—', value: '0' }]), ev.clientX, ev.clientY);
  });
  overlay.addEventListener('mouseleave', hideTip);
  svg.appendChild(overlay);
  if (title) {
    const t = svgEl('text', { x: padL, y: padT - 2, class: 'ax' });
    t.textContent = title;
    svg.insertBefore(t, svg.firstChild);
  }
  container.appendChild(svg);
}

/* ---------------- 消费金额图 + 图例 ---------------- */
function renderCostChart() {
  const days = bucketDays();
  const isHour = RANGE === 1;
  const models = modelTotalsOf(days);
  const series = models.map((m, i) => ({ key: m.name, color: PALETTE[i % PALETTE.length] }));
  const valueOf = (d, k) => k === '__cost__' ? d.cost : modelCost(d, k);

  let seriesFinal, valFn, fmtVal;
  if (barDim === 'model') {
    seriesFinal = series;
    valFn = (d, k) => modelCost(d, k);
    fmtVal = v => fmtCost(v);
  } else {
    seriesFinal = [{ key: '__calls__', color: PALETTE[0] }];
    valFn = (d, k) => d.reqs || 0;
    fmtVal = v => fmtInt(v) + ' 次';
  }

  const leg = $('#costLegend');
  leg.innerHTML = '';
  seriesFinal.forEach(s => {
    const total = days.reduce((acc, d) => acc + valFn(d, s.key), 0);
    const it = document.createElement('span');
    it.className = 'legend-item check' + (hiddenBars.has(s.key) ? ' off' : '');
    it.innerHTML = `<span class="sq" style="background:${s.color}"></span>${s.key === '__calls__' ? '请求次数' : s.key}: ${fmtVal(total)}`;
    it.addEventListener('click', () => {
      if (hiddenBars.has(s.key)) hiddenBars.delete(s.key); else hiddenBars.add(s.key);
      renderCostChart();
    });
    leg.appendChild(it);
  });
  const vis = seriesFinal.filter(s => !hiddenBars.has(s.key));
  const grand = days.reduce((acc, d) => acc + vis.reduce((s, ser) => s + valFn(d, ser.key), 0), 0);
  $('#costChartTotal').textContent = (isHour ? '今日 ' : RANGE === 7 ? '近 7 天 ' : '近 30 天 ') + fmtVal(grand);

  renderStackedBars($('#costChart'), {
    days,
    series: vis,
    valueOf: valFn,
    fmtVal,
    H: 280,
    labelX: isHour ? (lb => lb.slice(11, 16)) : undefined,
  });
}

/* ---------------- 每模型分区（请求次数面积图 + Tokens 柱状图） ---------------- */
function renderModelSections() {
  const days = bucketDays();
  const isHour = RANGE === 1;
  const models = modelTotalsOf(days).filter(m => m.tokens > 0 || m.reqs > 0);
  const box = $('#modelSections');
  box.innerHTML = '';
  if (!models.length) return;
  const labels = days.map(d => d.date);
  const labelX = isHour ? (lb => lb.slice(11, 16)) : undefined;

  for (const m of models) {
    const sec = document.createElement('div');
    sec.className = 'model-section';
    const h = document.createElement('h3');
    h.textContent = m.name;
    sec.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'two-charts';

    const reqCard = document.createElement('div');
    reqCard.className = 'chart-card';
    const reqTitle = document.createElement('div');
    reqTitle.className = 'chtitle';
    reqTitle.innerHTML = `API 请求次数 <b>${fmtInt(m.reqs)}</b>`;
    reqCard.appendChild(reqTitle);
    const reqChart = document.createElement('div');
    reqChart.className = 'chart';
    reqCard.appendChild(reqChart);
    grid.appendChild(reqCard);

    const tokCard = document.createElement('div');
    tokCard.className = 'chart-card';
    const tokTitle = document.createElement('div');
    tokTitle.className = 'chtitle';
    tokTitle.innerHTML = `Tokens <b>${fmtTokens(m.tokens)}</b>`;
    tokCard.appendChild(tokTitle);
    const tokChart = document.createElement('div');
    tokChart.className = 'chart';
    tokCard.appendChild(tokChart);
    grid.appendChild(tokCard);

    sec.appendChild(grid);
    box.appendChild(sec);

    renderLineChart(reqChart, {
      series: [{ name: m.name, color: PALETTE[0], values: days.map(d => (d.ofByModel[m.name] && d.ofByModel[m.name].reqs) || 0) }],
      labels, H: 220, yFmt: v => fmtInt(v), rowFmt: v => fmtInt(v) + ' 次',
      labelX, area: true,
    });
    renderStackedBars(tokChart, {
      days,
      series: [{ key: m.name, color: PALETTE[0] }],
      valueOf: (d, k) => (d.ofByModel[k] && d.ofByModel[k].tokens) || 0,
      fmtVal: v => fmtTokens(v),
      H: 220,
      labelX,
    });
  }
}

/* ---------------- 顶部卡与统计 ---------------- */
function renderTopCards() {
  const allDays = officialDays(DATA.days);
  const totalCost = allDays.reduce((s, d) => s + dayCost(d), 0);
  $('#totalCostVal').textContent = fmtMoney(totalCost, 'CNY');
}
function renderStats() {
  const days = bucketDays();
  const cost = days.reduce((s, d) => s + dayCost(d), 0);
  const reqs = sumField(days, 'reqs') || sumField(days, 'reqTotal');
  const tokens = sumField(days, 'ofTokens');
  $('#statCost').textContent = fmtMoney(cost, 'CNY');
  $('#statReqs').textContent = fmtInt(reqs);
  $('#statTokens').textContent = fmtInt(tokens);
}

/* ---------------- 余额 ---------------- */
function storedApiKey() { try { return localStorage.getItem('dshUsageApiKey') || ''; } catch (_) { return ''; } }
async function loadBalance() {
  const val = $('#balVal'), sub = $('#balSub');
  let b;
  try {
    const key = storedApiKey();
    b = await fetch('api/balance', { headers: key ? { 'x-dsh-key': key } : {} }).then(r => r.json());
  } catch (err) { b = { ok: false, error: '网络错误' }; }
  if (b.ok && b.balances && b.balances.length) {
    const info = b.balances[0];
    val.textContent = fmtMoney(parseFloat(info.total), info.currency);
    val.className = 'tv';
    sub.textContent = b.isAvailable ? '账户可用 · ' + info.currency : '账户不可用';
    sub.className = 'tsub' + (b.isAvailable ? '' : ' bad');
  } else {
    val.textContent = b.needsKey ? '未配置 Key' : '查询失败';
    val.className = 'tv err';
    sub.textContent = b.error || '';
    sub.className = 'tsub bad';
  }
}
const keyDlg = $('#keyDlg');
$('#keyLink').addEventListener('click', e => { e.preventDefault(); openKeyDlg(); });
function openKeyDlg() {
  $('#keyInput').value = storedApiKey();
  keyDlg.showModal();
  attachDialogCenter(keyDlg);
}
$('#keyCancel').addEventListener('click', () => keyDlg.close());
$('#keyClear').addEventListener('click', () => { $('#keyInput').value = ''; });
$('#keySave').addEventListener('click', () => {
  try { localStorage.setItem('dshUsageApiKey', $('#keyInput').value.trim()); } catch (_) {}
  keyDlg.close();
  loadBalance();
});

/* ---------------- 导出 CSV ---------------- */
$('#exportBtn').addEventListener('click', () => {
  const days = bucketDays();
  const rows = [['时间', '模型', '请求次数', '输入 tokens', '缓存命中 tokens', '输出 tokens', 'Tokens', '费用(¥估算)']];
  for (const d of days) {
    const t = isHour() ? d.date.slice(11, 16) : d.date;
    const models = Object.keys(d.ofByModel);
    if (!models.length) rows.push([t, '-', '', '', '', '', fmtTokens(d.ofTokens), dayCost(d).toFixed(4)]);
    for (const m of models) {
      const v = d.ofByModel[m];
      rows.push([t, m, v.reqs || 0, v.input || 0, v.cacheRead || 0, v.output || 0, v.tokens || 0, modelCostOf(d, m).toFixed(4)]);
    }
  }
  const csv = '\ufeff' + rows.map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `dsh-usage-${todayKeyStr()}${RANGE === 1 ? '-hourly' : ''}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});
function isHour() { return RANGE === 1; }
function modelCostOf(day, model) {
  const v = day.ofByModel[model];
  if (!v) return 0;
  return bucketCost({ date: day.date, ofByModel: { [model]: v } });
}

/* ---------------- 高度自适应 ---------------- */
/* ---------------- 弹窗定位（嵌入模式：跟随宿主可视区域居中） ---------------- */
function visibleCenterInDoc() {
  if (parent === window) return null;
  try {
    const pd = parent.document;
    const frame = pd.querySelector('iframe[title="Usage dashboard"]');
    if (!frame) return null;
    let scroller = pd.scrollingElement || pd.documentElement;
    let iframeTop = 0, el = frame;
    while (el && el !== pd.body) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) { scroller = el; break; }
      iframeTop += el.offsetTop || 0;
      el = el.parentElement;
    }
    return { scroller, iframeTop, top: Math.max(0, scroller.scrollTop - iframeTop), h: scroller.clientHeight };
  } catch (_) { return null; }
}
/** 打开弹窗后调用：把 <dialog> 放到宿主可视区域中央，并随宿主滚动跟随。 */
function attachDialogCenter(dlg) {
  const v = visibleCenterInDoc();
  if (!v) return;
  const place = () => {
    const h = dlg.offsetHeight || 320;
    const center = v.top + v.h / 2;
    dlg.style.position = 'absolute';
    dlg.style.margin = '0';
    dlg.style.left = '50%';
    dlg.style.transform = 'translateX(-50%)';
    dlg.style.top = Math.max(8, center - h / 2) + 'px';
    dlg.style.maxHeight = Math.max(240, v.h - 24) + 'px';
    dlg.style.overflowY = 'auto';
  };
  place();
  v.scroller.addEventListener('scroll', place);
  window.addEventListener('resize', place);
  dlg.addEventListener('close', () => {
    v.scroller.removeEventListener('scroll', place);
    window.removeEventListener('resize', place);
  }, { once: true });
}

function postHeight() {
  if (parent === window) return;
  try {
    parent.postMessage({ type: 'dsh-usage:height', h: Math.ceil(document.documentElement.getBoundingClientRect().height) }, location.origin);
  } catch (_) {}
}

/* ---------------- 单价设置 ---------------- */
const priceDlg = $('#priceDlg');
$('#priceBtn').addEventListener('click', () => {
  const days = bucketDays();
  const names = new Set(modelTotalsOf(days).map(m => m.name));
  const saved = priceTable();
  for (const k in saved) names.add(k);
  const rows = $('#priceRows');
  rows.innerHTML = '<div class="prow head"><span>模型 / 时段</span><span>输入 ¥/M</span><span>缓存命中 ¥/M</span><span>输出 ¥/M</span></div>';
  for (const n of names) {
    const dp = modelPrices(n);
    const cur = saved[n] || {};
    for (const [suffix, tag, vals] of [['高峰', 'P', dp], ['空闲', 'O', dp]]) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML = `<span class="mnm" title="${n}">${n} · ${suffix}</span>
        <input data-m="${n}" data-t="${tag}" data-f="miss${tag}" type="number" step="any" min="0" value="${cur['miss' + tag] ?? vals['miss' + tag]}">
        <input data-m="${n}" data-t="${tag}" data-f="hit${tag}" type="number" step="any" min="0" value="${cur['hit' + tag] ?? vals['hit' + tag]}">
        <input data-m="${n}" data-t="${tag}" data-f="out${tag}" type="number" step="any" min="0" value="${cur['out' + tag] ?? vals['out' + tag]}">`;
      rows.appendChild(row);
    }
  }
  priceDlg.showModal();
  attachDialogCenter(priceDlg);
});
$('#priceCancel').addEventListener('click', () => priceDlg.close());
$('#priceSave').addEventListener('click', () => {
  const table = {};
  for (const inp of $('#priceRows').querySelectorAll('input')) {
    const m = inp.dataset.m, f = inp.dataset.f, v = parseFloat(inp.value);
    if (!isFinite(v) || v <= 0) continue;
    (table[m] || (table[m] = {}))[f] = v;
  }
  localStorage.setItem('dshPrices_v1', JSON.stringify(table));
  priceDlg.close();
  renderAll();
});

/* ---------------- 总渲染与事件 ---------------- */
function renderAll() {
  if (!DATA) return;
  const empty = !DATA.days.length;
  $('#emptyBanner').style.display = empty ? '' : 'none';
  if (empty) { postHeight(); return; }
  renderTopCards();
  renderStats();
  renderCostChart();
  renderModelSections();
  renderHealth();
  const t = new Date(DATA.generatedAt);
  $('#foot').textContent = `数据源 ${DATA.sessionsDir} · ${DATA.sessionCount} 个会话 · 更新于 ${t.toLocaleTimeString('zh-CN', { hour12: false })}`;
  requestAnimationFrame(postHeight);
}

function renderHealth() {
  const days = bucketDays();
  const isHour = RANGE === 1;
  $('#healthRange').textContent = RANGE === 1 ? '今天' : RANGE === 7 ? '近 7 天' : '近 30 天';
  const names = modelTotalsOf(days).map(m => m.name)
    .filter(n => days.some(d => d.ofByModel[n] && d.ofByModel[n].spanTokens > 0))
    .slice(0, 4);
  const leg = $('#healthLegend');
  leg.innerHTML = '';
  names.forEach((n, i) => {
    const it = document.createElement('span');
    it.className = 'legend-item';
    it.innerHTML = `<span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${n}`;
    leg.appendChild(it);
  });
  const series = names.map((n, i) => ({
    name: n, color: PALETTE[i % PALETTE.length],
    values: days.map(d => {
      const m = d.ofByModel[n];
      return m && m.spanTokens > 0 && m.spanMs > 0 ? m.spanTokens / m.spanMs * 1000 : null;
    }),
  }));
  renderLineChart($('#healthChart'), {
    series, labels: days.map(d => d.date), H: 240,
    yFmt: v => v >= 100 ? String(Math.round(v)) : v.toFixed(1),
    rowFmt: v => v.toFixed(1) + ' tok/s',
    labelX: isHour ? (lb => lb.slice(11, 16)) : undefined,
  });
}

async function load() {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  try {
    const r = await fetch('api/data');
    DATA = await r.json();
    renderAll();
  } catch (err) {
    $('#foot').textContent = '加载失败: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

$('#rangeSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  RANGE = +b.dataset.range;
  for (const x of $('#rangeSeg').children) x.classList.toggle('on', x === b);
  renderAll();
});
$('#dimSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  barDim = b.dataset.dim;
  for (const x of $('#dimSeg').children) x.classList.toggle('on', x === b);
  hiddenBars.clear();
  renderCostChart();
});
$('#refreshBtn').addEventListener('click', () => { load(); loadBalance(); });

let rsTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rsTimer);
  rsTimer = setTimeout(() => { renderAll(); postHeight(); }, 200);
});

applyTheme();
setInterval(applyTheme, 800);
loadBalance();
setInterval(loadBalance, 60000);
load();
