'use strict';
/* dsh 用量总览 —— 纯前端，无依赖，图表手写 SVG。
   主题：从 dsh 宿主界面同步 --dsw-* 变量到本页 --u-*（Light/Dark/System 自动跟随）；
   独立运行时使用 :root 里的暗色兜底值。
   粒度：「今日」视图按小时（24 桶），近 7 日 / 近 30 日按天。 */

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
let RANGE = 7;
let barDim = 'model', barUnit = 'tokens';
let chartTab = 'trend';
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
function fmtCost(n) { return '¥' + (n >= 100 ? trim1(n) : n >= 1 ? n.toFixed(2) : n.toFixed(3)); }
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
/* 今日 24 个小时桶（无数据补零），hour 形如 '2026-09-17T14:00' */
function todayHours() {
  const map = new Map((DATA.hours || []).map(h => [h.date, h]));
  const tk = todayKeyStr();
  const out = [];
  for (let h = 0; h < 24; h++) {
    const key = tk + 'T' + String(h).padStart(2, '0') + ':00';
    const src = map.get(key);
    out.push(src || { date: key, byModel: {}, byTool: {} });
  }
  return out;
}
/* 当前范围的数据桶：今日=按小时，其余=按天 */
function bucketDays() {
  return RANGE === 1 ? officialDays(todayHours()) : officialDays(rangeDays());
}

/* 官方模型归一化：日志里的历史/限时 id 全部映射到 dsh 官方 provider 的 4 个模型显示名，
   非 deepseek 官方模型返回 null（不参与统计）。 */
function normalizeModel(name) {
  const m = String(name || '').toLowerCase();
  if (!m.startsWith('deepseek-')) return null;
  if (m === 'deepseek-flash' || m.includes('v4.1-flash')) return 'DeepSeek-V4.1-Flash';
  if (m.includes('vision')) return 'DeepSeek-V4-Flash-Vision-Exp';
  if (m.includes('v4-pro') || m.includes('pro')) return 'DeepSeek-V4-Pro';
  if (m.includes('v4-flash') || m === 'deepseek-v4') return 'DeepSeek-V4-Flash';
  // 官方文档：未识别的遗留 id 由 DeepSeek-V4.1-Flash 服务
  return 'DeepSeek-V4.1-Flash';
}
/* 官方模型过滤视图：tokens/命中率等口径只计官方模型（归一化后）；工具统计保持全量 */
function officialDays(days) {
  return days.map(d => {
    const bm = {};
    let tokens = 0, input = 0, cacheRead = 0;
    for (const [m, v] of Object.entries(d.byModel || {})) {
      const n = normalizeModel(m);
      if (!n) continue;
      const t = bm[n] || (bm[n] = { tokens: 0, input: 0, output: 0, cacheRead: 0, spanMs: 0, spanTokens: 0 });
      for (const k of ['tokens', 'input', 'output', 'cacheRead', 'spanMs', 'spanTokens']) t[k] += v[k] || 0;
      tokens += v.tokens || 0;
      input += v.input || 0;
      cacheRead += v.cacheRead || 0;
    }
    return { ...d, ofByModel: bm, ofTokens: tokens, ofInput: input, ofCacheRead: cacheRead };
  });
}
function modelTotalsOf(days) {
  const map = new Map();
  for (const d of days) for (const [m, v] of Object.entries(d.ofByModel)) map.set(m, (map.get(m) || 0) + (v.tokens || 0));
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, tokens]) => ({ name, tokens }));
}
function toolTotalsInRange(days) {
  const map = new Map();
  for (const d of days) for (const t in d.byTool) map.set(t, (map.get(t) || 0) + d.byTool[t]);
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}
function sumField(days, f) { return days.reduce((s, d) => s + (d[f] || 0), 0); }
function hitRate(days) {
  const hit = sumField(days, 'ofCacheRead'), miss = sumField(days, 'ofInput');
  const tot = hit + miss;
  return tot > 0 ? hit / tot : null;
}
function priceTable() {
  try { return JSON.parse(localStorage.getItem('dshPrices_v1') || '{}'); } catch (_) { return {}; }
}
function modelCost(day, model) {
  const p = priceTable()[model];
  const m = day.ofByModel[model];
  if (!p || !m) return 0;
  return ((m.input || 0) * (p.input || 0) + (m.cacheRead || 0) * (p.cacheRead || 0) + (m.output || 0) * (p.output || 0)) / 1e6;
}
function priceTableEmpty() {
  const t = priceTable();
  return !Object.values(t).some(p => (p.input || 0) + (p.cacheRead || 0) + (p.output || 0) > 0);
}

/* ---------------- 主题桥：同步 dsh 宿主变量 ----------------
   取值优先级：宿主变量（带对比度校验）→ 宿主弹窗实际背景色 → 暗色兜底。 */
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
/** 从候选变量里挑第一个与背景对比度 >=3 的值；都不达标则取第一个有值的。 */
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
  const set = (local, v) => {
    document.documentElement.style.setProperty(local, v || THEME_FALLBACK[local]);
  };
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

/* ---------------- 折线图 ---------------- */
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
  const { series, labels, yFmt, H = 300, rowFmt, labelX } = opts;
  const lx = labelX || md;
  container.innerHTML = '';
  if (!labels.length || !series.length) return;
  const W = container.clientWidth || 860;
  const padL = 46, padR = 30, padT = 14, padB = 26;
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
  labels.forEach((lb, i) => {
    if (i % step !== 0 && i !== labels.length - 1) return;
    const t = svgEl('text', { x: X(i), y: H - 7, 'text-anchor': 'middle', class: 'axx' });
    t.textContent = lx(lb);
    svg.appendChild(t);
  });

  for (const s of series) {
    let run = [];
    const flush = () => {
      if (run.length > 1) svg.appendChild(svgEl('path', { d: smoothPath(run), fill: 'none', stroke: s.color, 'stroke-width': 2.2, 'stroke-linecap': 'round' }));
      else if (run.length === 1) svg.appendChild(svgEl('circle', { cx: run[0].x, cy: run[0].y, r: 2.4, fill: s.color }));
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

/* ---------------- 每日 Token 趋势 ---------------- */
function renderTrend() {
  const days = bucketDays();
  const isHour = RANGE === 1;
  const models = modelTotalsOf(days).slice(0, 5);
  const leg = $('#trendLegend');
  leg.innerHTML = '';
  models.forEach((m, i) => {
    const it = document.createElement('span');
    it.className = 'legend-item';
    it.innerHTML = `<span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${m.name}`;
    leg.appendChild(it);
  });
  const labels = days.map(d => d.date);
  const series = models.map((m, i) => ({
    name: m.name, color: PALETTE[i % PALETTE.length],
    values: days.map(d => (d.ofByModel[m.name] && d.ofByModel[m.name].tokens) || 0),
  }));
  renderLineChart($('#trendChart'), {
    series, labels, H: 300, yFmt: fmtTokens,
    labelX: isHour ? (lb => lb.slice(11, 16)) : undefined,
    tipSuffix: i => fmtTokens(days[i].ofTokens) + ' tokens',
  });
}

/* ---------------- 模型用量环图 ---------------- */
function arcPath(cx, cy, r, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  return `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1}`;
}
function renderDonut() {
  const days = bucketDays();
  const models = modelTotalsOf(days);
  const total = models.reduce((s, m) => s + m.tokens, 0);
  const items = models.slice(0, 6).map((m, i) => ({ name: m.name, value: m.tokens, color: PALETTE[i % PALETTE.length] }));
  if (models.length > 6) {
    items.push({ name: '其他', value: models.slice(6).reduce((s, m) => s + m.tokens, 0), color: OTHER_COLOR });
  }
  const box = $('#donut');
  box.innerHTML = '';
  const SZ = 230, cx = SZ / 2, cy = SZ / 2, r = 78, sw = 30, gap = 0.045;
  const svg = svgEl('svg', { viewBox: `0 0 ${SZ} ${SZ}`, width: SZ, height: SZ });
  let a = -Math.PI / 2;
  if (total <= 0) {
    svg.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: 'var(--u-card2)', 'stroke-width': sw }));
  } else {
    for (const it of items) {
      const frac = it.value / total;
      const a1 = a + frac * Math.PI * 2;
      const aEnd = items.length === 1 ? a + Math.PI * 2 * 0.9999 : a1 - Math.min(gap, frac * Math.PI * 2 * 0.4);
      if (aEnd > a) svg.appendChild(svgEl('path', { d: arcPath(cx, cy, r, a, aEnd), fill: 'none', stroke: it.color, 'stroke-width': sw }));
      a = a1;
    }
  }
  const t1 = svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', fill: 'var(--u-text)', 'font-size': 21, 'font-weight': 600 });
  t1.textContent = fmtTokens(total);
  const t2 = svgEl('text', { x: cx, y: cy + 19, 'text-anchor': 'middle', fill: 'var(--u-muted)', 'font-size': 12 });
  t2.textContent = 'tokens';
  svg.appendChild(t1); svg.appendChild(t2);
  box.appendChild(svg);

  const lg = $('#donutLegend');
  lg.innerHTML = '';
  for (const it of items) {
    const pct = total > 0 ? (it.value / total * 100) : 0;
    const row = document.createElement('div');
    row.className = 'mrow';
    row.innerHTML = `<span class="dot" style="background:${it.color};margin-top:5px"></span>
      <span class="mname"><span class="n1">${it.name}</span><div class="n2">${fmtTokens(it.value)} tokens</div></span>
      <span class="pct">${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%</span>`;
    lg.appendChild(row);
  }
}

/* ---------------- 顶部统计（4 项） ---------------- */
function renderActivity() {
  const t = DATA.totals;
  const today = officialDays(DATA.days.length ? [DATA.days[DATA.days.length - 1]] : []);
  const todayTokens = sumField(today, 'ofTokens');
  const cur = officialDays(rangeDays()), prev = officialDays(prevDays());
  const hrC = hitRate(cur), hrP = hitRate(prev);
  const tiles = [
    { v: fmtTokens(todayTokens), l: '今日 Token' },
    { v: fmtTokens(t.tokens), l: '累计 Token 数' },
    { v: fmtTokens(DATA.peak.tokens), l: `峰值 Token 数 <span class="info" title="峰值出现在 ${DATA.peak.date ? cmd(DATA.peak.date) : '-'}">ⓘ</span>` },
    { v: hrC == null ? '-' : Math.round(hrC * 100) + '%', d: hrC != null && hrP != null ? `<span class="delta ${hrC >= hrP ? 'up' : 'down'}">${hrC >= hrP ? '+' : ''}${Math.round((hrC - hrP) * 100)}%</span>` : '', l: 'Cache 命中率' },
  ];
  const box = $('#activityTiles');
  box.innerHTML = '';
  for (const x of tiles) {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = `<div class="v">${x.v}${x.d || ''}</div><div class="l">${x.l}</div>`;
    box.appendChild(d);
  }
}

/* ---------------- 消耗堆叠柱（今日按小时，多日按天） ---------------- */
function renderBars() {
  const days = bucketDays();
  const isHour = RANGE === 1;
  const unitSeg = $('#unitSeg'), priceBtn = $('#priceBtn');
  let series = [], valueOf, fmtVal, totalLabel;
  if (barDim === 'model') {
    unitSeg.classList.remove('disabled');
    priceBtn.style.display = barUnit === 'cost' ? '' : 'none';
    const ms = modelTotalsOf(days);
    series = ms.map((m, i) => ({ key: m.name, color: PALETTE[i % PALETTE.length] }));
    if (barUnit === 'cost') {
      valueOf = (d, k) => modelCost(d, k);
      fmtVal = fmtCost;
      totalLabel = v => '估算费用总量: <b>' + fmtCost(v) + '</b>';
    } else {
      valueOf = (d, k) => (d.ofByModel[k] && d.ofByModel[k].tokens) || 0;
      fmtVal = v => fmtTokens(v) + ' tokens';
      totalLabel = v => '消耗总量: <b>' + fmtTokens(v) + ' tokens</b>';
    }
  } else {
    unitSeg.classList.add('disabled');
    priceBtn.style.display = 'none';
    const ts = toolTotalsInRange(days).slice(0, 8);
    series = ts.map((t, i) => ({ key: t.name, color: PALETTE[i % PALETTE.length] }));
    if (ts.length > 8) {
      const restNames = ts.slice(8).map(t => t.name);
      series.push({ key: '其他', color: OTHER_COLOR, rest: restNames });
    }
    valueOf = (d, k) => {
      const s = series.find(x => x.key === k);
      if (s && s.rest) return s.rest.reduce((acc, n) => acc + (d.byTool[n] || 0), 0);
      return d.byTool[k] || 0;
    };
    fmtVal = v => fmtInt(v) + ' 次';
    totalLabel = v => '调用总量: <b>' + fmtInt(v) + ' 次</b>';
  }

  const leg = $('#barLegend');
  leg.innerHTML = '';
  const totals = new Map(series.map(s => [s.key, days.reduce((acc, d) => acc + valueOf(d, s.key), 0)]));
  series
    .slice()
    .sort((a, b) => (totals.get(b.key) || 0) - (totals.get(a.key) || 0))
    .forEach(s => {
      const it = document.createElement('span');
      it.className = 'legend-item check' + (hiddenBars.has(s.key) ? ' off' : '');
      it.innerHTML = `<span class="sq" style="background:${s.color}"></span>${s.key}: ${fmtVal(totals.get(s.key) || 0)}`;
      it.addEventListener('click', () => {
        if (hiddenBars.has(s.key)) hiddenBars.delete(s.key); else hiddenBars.add(s.key);
        renderBars();
      });
      leg.appendChild(it);
    });

  const visible = series.filter(s => !hiddenBars.has(s.key));
  $('#barTotal').innerHTML = totalLabel(visible.reduce((s, ser) => s + (totals.get(ser.key) || 0), 0)) +
    (barUnit === 'cost' && barDim === 'model' && priceTableEmpty() ? ' <span style="color:var(--u-warn)">· 尚未设置单价，请点「单价设置」</span>' : '');

  const box = $('#barChart');
  box.innerHTML = '';
  if (!days.length || !visible.length) return;
  const W = box.clientWidth || 860, H = 300;
  const padL = 46, padR = 30, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const dayTotals = days.map(d => visible.reduce((s, ser) => s + valueOf(d, ser.key), 0));
  const maxV = Math.max(1, ...dayTotals);
  const Y = v => padT + ih - (v / maxV) * ih;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
  for (let g = 0; g <= 4; g++) {
    const gv = maxV * g / 4, gy = Y(gv);
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: gy, y2: gy, class: g > 0 ? 'grid' : 'grid0', 'stroke-dasharray': g > 0 ? '3,5' : undefined }));
    const t = svgEl('text', { x: padL - 9, y: gy + 4, 'text-anchor': 'end', class: 'ax' });
    t.textContent = barDim === 'tool' ? fmtInt(gv) : (barUnit === 'cost' ? fmtCost(gv) : fmtTokens(gv));
    svg.appendChild(t);
  }
  const slot = iw / days.length;
  const bw = Math.max(4, Math.min(28, isHour ? slot * 0.72 : slot * 0.5));
  const X = i => padL + slot * i + (slot - bw) / 2;
  const step = Math.max(1, Math.ceil(days.length / (isHour ? 8 : 7)));
  days.forEach((d, i) => {
    if (i % step !== 0 && i !== days.length - 1) return;
    const t = svgEl('text', { x: X(i) + bw / 2, y: H - 7, 'text-anchor': 'middle', class: 'axx' });
    t.textContent = isHour ? d.date.slice(11, 16) : md(d.date);
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
    const title = (isHour ? days[idx].date.slice(11, 16) : md(days[idx].date)) + ' · ' + fmtVal(dayTotals[idx]);
    showTip(tipHTML(title, rows.length ? rows : [{ color: '#8b929a', name: '—', value: '0' }]), ev.clientX, ev.clientY);
  });
  overlay.addEventListener('mouseleave', hideTip);
  svg.appendChild(overlay);
  box.appendChild(svg);
}

/* ---------------- 系统健康度（今日按小时） ---------------- */
function renderHealth() {
  const days = bucketDays();
  const isHour = RANGE === 1;
  $('#healthRange').textContent = RANGE === 1 ? '今日' : RANGE === 7 ? '近 7 日' : '近 30 日';
  const names = modelTotalsOf(days).map(m => m.name)
    .filter(n => days.some(d => d.ofByModel[n] && d.ofByModel[n].spanTokens > 0))
    .slice(0, 4);
  const leg = $('#healthLegend');
  leg.innerHTML = '';
  names.forEach((n, i) => {
    const it = document.createElement('span');
    it.className = 'legend-item';
    it.innerHTML = `<span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${n} 高峰期均 Decode 速度`;
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

/* ---------------- 余额 ---------------- */
function storedApiKey() { try { return localStorage.getItem('dshUsageApiKey') || ''; } catch (_) { return ''; } }
async function loadBalance() {
  const dot = $('#balDot'), val = $('#balVal'), sub = $('#balSub');
  let b;
  try {
    const key = storedApiKey();
    b = await fetch('api/balance', { headers: key ? { 'x-dsh-key': key } : {} }).then(r => r.json());
  } catch (err) { b = { ok: false, error: '网络错误' }; }
  if (b.ok && b.balances && b.balances.length) {
    const info = b.balances[0];
    const num = parseFloat(info.total);
    dot.className = 'dot ' + (b.isAvailable ? 'ok' : 'bad');
    val.className = 'bal-val';
    val.textContent = fmtMoney(num, info.currency);
    sub.className = 'bal-sub';
    sub.textContent = b.isAvailable ? '账户可用 · ' + info.currency : '账户不可用';
  } else {
    dot.className = 'dot bad';
    val.className = 'bal-val err';
    val.textContent = b.needsKey ? '未配置 API Key' : '余额查询失败';
    sub.className = 'bal-sub bad';
    sub.textContent = b.error || '';
  }
}
const keyDlg = $('#keyDlg');
$('#balKeyBtn').addEventListener('click', () => {
  $('#keyInput').value = storedApiKey();
  keyDlg.showModal();
});
$('#keyCancel').addEventListener('click', () => keyDlg.close());
$('#keyClear').addEventListener('click', () => { $('#keyInput').value = ''; });
$('#keySave').addEventListener('click', () => {
  try { localStorage.setItem('dshUsageApiKey', $('#keyInput').value.trim()); } catch (_) {}
  keyDlg.close();
  loadBalance();
});

/* ---------------- 高度自适应（消除 iframe 内滚动条） ---------------- */
function postHeight() {
  if (parent === window) return;
  try {
    parent.postMessage({ type: 'dsh-usage:height', h: Math.ceil(document.documentElement.getBoundingClientRect().height) }, location.origin);
  } catch (_) {}
}

/* ---------------- 单价设置 ---------------- */
const priceDlg = $('#priceDlg');
function openPriceDlg() {
  const days = bucketDays();
  const names = new Set(modelTotalsOf(days).map(m => m.name));
  const saved = priceTable();
  for (const k in saved) names.add(k);
  const rows = $('#priceRows');
  rows.innerHTML = '<div class="prow head"><span>模型</span><span>输入 ¥/M</span><span>缓存命中 ¥/M</span><span>输出 ¥/M</span></div>';
  for (const n of names) {
    const p = saved[n] || {};
    const row = document.createElement('div');
    row.className = 'prow';
    row.innerHTML = `<span class="mnm" title="${n}">${n}</span>
      <input data-m="${n}" data-f="input" type="number" step="any" min="0" value="${p.input ?? ''}" placeholder="0">
      <input data-m="${n}" data-f="cacheRead" type="number" step="any" min="0" value="${p.cacheRead ?? ''}" placeholder="0">
      <input data-m="${n}" data-f="output" type="number" step="any" min="0" value="${p.output ?? ''}" placeholder="0">`;
    rows.appendChild(row);
  }
  priceDlg.showModal();
}
$('#priceBtn').addEventListener('click', openPriceDlg);
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
  renderActivity();
  renderTrend();
  renderDonut();
  applyChartTab();
  renderBars();
  renderHealth();
  const t = new Date(DATA.generatedAt);
  $('#foot').textContent = `数据源 ${DATA.sessionsDir} · ${DATA.sessionCount} 个会话 · 更新于 ${t.toLocaleTimeString('zh-CN', { hour12: false })}`;
  requestAnimationFrame(postHeight);
}

function applyChartTab() {
  const trend = chartTab === 'trend';
  $('#trendPane').style.display = trend ? '' : 'none';
  $('#donutPane').style.display = trend ? 'none' : '';
  for (const b of $('#chartTabSeg').children) b.classList.toggle('on', b.dataset.tab === chartTab);
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
$('#chartTabSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  chartTab = b.dataset.tab;
  applyChartTab();
  postHeight();
});
$('#unitSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  barUnit = b.dataset.unit;
  for (const x of $('#unitSeg').children) x.classList.toggle('on', x === b);
  if (barUnit === 'cost' && barDim === 'model' && priceTableEmpty()) openPriceDlg();
  renderBars();
});
$('#dimSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  barDim = b.dataset.dim;
  for (const x of $('#dimSeg').children) x.classList.toggle('on', x === b);
  hiddenBars.clear();
  renderBars();
});
$('#refreshBtn').addEventListener('click', () => { load(); loadBalance(); });

let rsTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rsTimer);
  rsTimer = setTimeout(() => { renderAll(); postHeight(); }, 200);
});

/* 主题同步：800ms 轮询宿主变量（Appearance 切换即时生效） */
applyTheme();
setInterval(applyTheme, 800);

/* 余额 60s 自动刷新 */
loadBalance();
setInterval(loadBalance, 60000);

load();
