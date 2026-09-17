'use strict';
/* dsh 用量总览 —— 纯前端，无依赖，图表手写 SVG */

const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in (attrs || {})) if (attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
  return e;
}

const PALETTE = ['#4C8DFF', '#3ECF8E', '#A78BFA', '#F87171', '#FB923C', '#22D3EE', '#FACC15', '#F472B6', '#34D399', '#60A5FA'];
const OTHER_COLOR = '#5b636c';
const HEAT_COLORS = ['#1b3a66', '#2563b8', '#3b82f6', '#7fb3f8'];

let DATA = null;
let RANGE = 7;
let heatMode = 'daily';
let barDim = 'model', barUnit = 'tokens';
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
  for (const r of rows) {
    h += `<div class="tr"><span class="nm"><span class="dot" style="background:${r.color}"></span>${r.name}</span><span>${r.value}</span></div>`;
  }
  return h;
}

/* ---------------- 数据辅助 ---------------- */
function rangeDays() { const n = DATA.days.length; return DATA.days.slice(Math.max(0, n - RANGE)); }
function prevDays() { const n = DATA.days.length; return DATA.days.slice(Math.max(0, n - 2 * RANGE), Math.max(0, n - RANGE)); }
function modelTotalsInRange(days) {
  const map = new Map();
  for (const d of days) for (const m in d.byModel) map.set(m, (map.get(m) || 0) + (d.byModel[m].tokens || 0));
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, tokens]) => ({ name, tokens }));
}
function toolTotalsInRange(days) {
  const map = new Map();
  for (const d of days) for (const t in d.byTool) map.set(t, (map.get(t) || 0) + d.byTool[t]);
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}
function sumField(days, f) { return days.reduce((s, d) => s + (d[f] || 0), 0); }
function hitRate(days) {
  const hit = sumField(days, 'cacheRead'), miss = sumField(days, 'input');
  const tot = hit + miss;
  return tot > 0 ? hit / tot : null;
}
function priceTable() {
  try { return JSON.parse(localStorage.getItem('dshPrices_v1') || '{}'); } catch (_) { return {}; }
}
function modelCost(day, model) {
  const p = priceTable()[model];
  const m = day.byModel[model];
  if (!p || !m) return 0;
  return ((m.input || 0) * (p.input || 0) + (m.cacheRead || 0) * (p.cacheRead || 0) + (m.output || 0) * (p.output || 0)) / 1e6;
}
function priceTableEmpty() {
  const t = priceTable();
  return !Object.values(t).some(p => (p.input || 0) + (p.cacheRead || 0) + (p.output || 0) > 0);
}

/* ---------------- 折线图（趋势 / 健康度共用） ---------------- */
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
  const { series, labels, yFmt, H = 300, rowFmt } = opts;
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
    const attrs = { x1: padL, x2: W - padR, y1: gy, y2: gy, stroke: '#21262c', 'stroke-width': 1 };
    if (g > 0) attrs['stroke-dasharray'] = '3,5';
    svg.appendChild(svgEl('line', attrs));
    const t = svgEl('text', { x: padL - 9, y: gy + 4, 'text-anchor': 'end', fill: '#6b727b', 'font-size': 11 });
    t.textContent = yFmt(gv);
    svg.appendChild(t);
  }
  const step = Math.max(1, Math.ceil(labels.length / 7));
  labels.forEach((lb, i) => {
    if (i % step !== 0 && i !== labels.length - 1) return;
    const t = svgEl('text', { x: X(i), y: H - 7, 'text-anchor': 'middle', fill: '#6b727b', 'font-size': 11.5 });
    t.textContent = md(lb);
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

  const guide = svgEl('line', { y1: padT, y2: padT + ih, stroke: '#3c434c', 'stroke-width': 1, opacity: 0 });
  svg.appendChild(guide);
  const dots = series.map(s => { const c = svgEl('circle', { r: 3.4, fill: s.color, stroke: '#15181c', 'stroke-width': 1.5, opacity: 0 }); svg.appendChild(c); return c; });

  const overlay = svgEl('rect', { x: padL - iw / (2 * Math.max(1, labels.length - 1) || 1), y: padT, width: iw + 40, height: ih, fill: 'transparent' });
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
    rows.sort((a, b) => parseFloat(b.value) - parseFloat(a.value) || 0);
    showTip(tipHTML(`${md(labels[idx])}${opts.tipSuffix ? ' - ' + opts.tipSuffix(idx) : ''}`, rows), ev.clientX, ev.clientY);
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
  const days = rangeDays();
  const models = modelTotalsInRange(days).slice(0, 5);
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
    values: days.map(d => (d.byModel[m.name] && d.byModel[m.name].tokens) || 0),
  }));
  renderLineChart($('#trendChart'), {
    series, labels, H: 300, yFmt: fmtTokens,
    tipSuffix: i => fmtTokens(days[i].tokens) + ' tokens',
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
  const days = rangeDays();
  const models = modelTotalsInRange(days);
  const total = models.reduce((s, m) => s + m.tokens, 0);
  const items = models.slice(0, 6).map((m, i) => ({ name: m.name, value: m.tokens, color: PALETTE[i % PALETTE.length] }));
  if (models.length > 6) {
    const rest = models.slice(6).reduce((s, m) => s + m.tokens, 0);
    items.push({ name: '其他', value: rest, color: OTHER_COLOR });
  }
  const box = $('#donut');
  box.innerHTML = '';
  const SZ = 230, cx = SZ / 2, cy = SZ / 2, r = 78, sw = 30, gap = 0.045;
  const svg = svgEl('svg', { viewBox: `0 0 ${SZ} ${SZ}`, width: SZ, height: SZ });
  let a = -Math.PI / 2;
  if (total <= 0) {
    svg.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: '#23272d', 'stroke-width': sw }));
  } else {
    for (const it of items) {
      const frac = it.value / total;
      const a1 = a + frac * Math.PI * 2;
      const aEnd = items.length === 1 ? a + Math.PI * 2 * 0.9999 : a1 - Math.min(gap, frac * Math.PI * 2 * 0.4);
      if (aEnd > a) svg.appendChild(svgEl('path', { d: arcPath(cx, cy, r, a, aEnd), fill: 'none', stroke: it.color, 'stroke-width': sw }));
      a = a1;
    }
  }
  const t1 = svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', fill: '#e6e9ec', 'font-size': 21, 'font-weight': 600 });
  t1.textContent = fmtTokens(total);
  const t2 = svgEl('text', { x: cx, y: cy + 19, 'text-anchor': 'middle', fill: '#8b929a', 'font-size': 12 });
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

/* ---------------- 活跃度 ---------------- */
function renderActivity() {
  const t = DATA.totals;
  const tiles = [
    { v: fmtTokens(t.tokens), l: '累计 Token 数' },
    { v: fmtTokens(DATA.peak.tokens), l: `峰值 Token 数 <span class="info" title="峰值出现在 ${DATA.peak.date ? cmd(DATA.peak.date) : '-'}">ⓘ</span>` },
    { v: fmtDur(t.durationMs), l: '累计使用时长', mid: true },
    { v: `${DATA.currentStreak} 天`, l: '当前连续天数' },
    { v: `${DATA.longestStreak} 天`, l: '最长连续天数' },
  ];
  const box = $('#activityTiles');
  box.innerHTML = '';
  for (const x of tiles) {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = `<div class="v${x.mid ? ' mid' : ''}">${x.v}</div><div class="l">${x.l}</div>`;
    box.appendChild(d);
  }
}

/* ---------------- Token 活动热力图 ---------------- */
function kd(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
function renderHeat() {
  const box = $('#heatmap');
  box.innerHTML = '';
  if (!DATA.days.length) return;
  const byDate = new Map(DATA.days.map(d => [d.date, d]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const endWeekStart = new Date(today); endWeekStart.setDate(today.getDate() - today.getDay());
  const start = new Date(endWeekStart); start.setDate(endWeekStart.getDate() - 52 * 7);

  const cols = [];
  for (const w = new Date(start); w <= endWeekStart; w.setDate(w.getDate() + 7)) {
    const col = [];
    for (let i = 0; i < 7; i++) { const d = new Date(w); d.setDate(w.getDate() + i); col.push(d); }
    cols.push(col);
  }
  const daily = cols.map(col => col.map(dt => {
    const k = kd(dt);
    const d = byDate.get(k);
    return { key: k, tokens: d ? d.tokens : 0, tools: d ? d.toolCalls : 0, valid: !!d };
  }));
  const weekly = daily.map(col => col.reduce((s, c) => s + c.tokens, 0));
  const cumulative = []; let acc = 0;
  for (const w of weekly) { acc += w; cumulative.push(acc); }

  let max = 0;
  if (heatMode === 'daily') max = Math.max(0, ...daily.flat().map(c => c.tokens));
  else if (heatMode === 'weekly') max = Math.max(0, ...weekly);
  else max = acc;
  const level = v => v <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil(Math.sqrt(v / max) * 4));
  const colorOf = v => v <= 0 ? null : HEAT_COLORS[level(v) - 1];
  const colColor = weekly.map((w, i) => heatMode === 'weekly' ? colorOf(w) : heatMode === 'cumulative' ? colorOf(cumulative[i]) : null);

  const scroll = document.createElement('div');
  scroll.className = 'heat-scroll';
  const grid = document.createElement('div');
  grid.className = 'heat-grid';
  const cells = [];
  daily.forEach((col, ci) => {
    col.forEach((c, ri) => {
      const cell = document.createElement('div');
      cell.className = 'heat-cell';
      if (!c.valid) cell.classList.add('empty');
      const col = colColor[ci];
      const own = colorOf(c.tokens);
      const bg = col || own;
      if (bg) cell.style.background = bg;
      cell.dataset.i = ci * 7 + ri;
      grid.appendChild(cell);
      cells.push(c);
    });
  });
  grid.addEventListener('mousemove', ev => {
    const cell = ev.target.closest('.heat-cell');
    if (!cell) { hideTip(); return; }
    const c = cells[+cell.dataset.i];
    showTip(tipHTML(cmd(c.key), [
      { color: '#8b929a', name: 'tokens', value: fmtTokens(c.tokens) },
      { color: '#8b929a', name: '工具调用', value: c.tools + ' 次' },
    ]), ev.clientX, ev.clientY);
  });
  grid.addEventListener('mouseleave', hideTip);
  scroll.appendChild(grid);

  const months = document.createElement('div');
  months.className = 'heat-months';
  let prevM = -1;
  daily.forEach((col, ci) => {
    const sp = document.createElement('span');
    const mid = col[Math.min(3, col.length - 1)];
    const m = +mid.key.split('-')[1] - 1;
    if (m !== prevM && ci < daily.length - 1) { sp.textContent = (m + 1) + '月'; prevM = m; }
    months.appendChild(sp);
  });
  scroll.appendChild(months);
  box.appendChild(scroll);
}

/* ---------------- 用量趋势 ---------------- */
function deltaHTML(cur, prev, digits = 0, suffix = '%', inverse = false) {
  if (prev == null || !isFinite(prev) || prev === 0) return '';
  const pct = (cur - prev) / Math.abs(prev) * 100;
  const good = inverse ? pct <= 0 : pct >= 0;
  const sign = pct >= 0 ? '+' : '';
  return `<span class="delta ${good ? 'up' : 'down'}">${sign}${pct.toFixed(digits)}${suffix}</span>`;
}
function renderUsageTiles() {
  const cur = rangeDays(), prev = prevDays();
  const hrC = hitRate(cur), hrP = hitRate(prev);
  const tokC = sumField(cur, 'tokens'), tokP = sumField(prev, 'tokens');
  const avgC = tokC / Math.max(1, cur.length), avgP = prev.length ? tokP / prev.length : null;
  const box = $('#usageTiles');
  box.innerHTML = '';
  const tiles = [
    { v: hrC == null ? '-' : Math.round(hrC * 100) + '%', d: hrC != null && hrP != null ? `<span class="delta ${hrC >= hrP ? 'up' : 'down'}">${hrC >= hrP ? '+' : ''}${Math.round((hrC - hrP) * 100)}%</span>` : '', l: 'Cache 命中率' },
    { v: fmtTokens(tokC), d: deltaHTML(tokC, tokP), l: 'Token 总数' },
    { v: fmtTokens(avgC), d: deltaHTML(avgC, avgP), l: '日均 Token' },
  ];
  for (const x of tiles) {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = `<div class="v">${x.v}${x.d}</div><div class="l">${x.l}</div>`;
    box.appendChild(d);
  }
}

function renderBars() {
  const days = rangeDays();
  const unitSeg = $('#unitSeg'), priceBtn = $('#priceBtn');
  let series = [], valueOf, fmtVal, totalLabel;
  if (barDim === 'model') {
    unitSeg.classList.remove('disabled');
    priceBtn.style.display = barUnit === 'cost' ? '' : 'none';
    const ms = modelTotalsInRange(days);
    series = ms.map((m, i) => ({ key: m.name, color: PALETTE[i % PALETTE.length] }));
    if (barUnit === 'cost') {
      valueOf = (d, k) => modelCost(d, k);
      fmtVal = fmtCost;
      totalLabel = v => '估算费用总量: <b>' + fmtCost(v) + '</b>';
    } else {
      valueOf = (d, k) => (d.byModel[k] && d.byModel[k].tokens) || 0;
      fmtVal = v => fmtTokens(v) + ' tokens';
      totalLabel = v => '消耗总量: <b>' + fmtTokens(v) + ' tokens</b>';
    }
  } else {
    unitSeg.classList.add('disabled');
    priceBtn.style.display = 'none';
    const ts = toolTotalsInRange(days).slice(0, 8);
    series = ts.map((t, i) => ({ key: t.name, color: PALETTE[i % PALETTE.length] }));
    if (ts.length > 8) series.push({ key: '其他', color: OTHER_COLOR, rest: ts.slice(8).map(t => t.name) });
    valueOf = (d, k) => {
      if (k === '其他' && series.find(s => s.key === '其他')) return series.find(s => s.key === '其他').rest.reduce((s, n) => s + (d.byTool[n] || 0), 0);
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
    (barUnit === 'cost' && barDim === 'model' && priceTableEmpty() ? ' <span style="color:#f87171">· 尚未设置单价，请点击右上角「单价设置」</span>' : '');

  const box = $('#barChart');
  box.innerHTML = '';
  if (!days.length || !visible.length) return;
  const W = box.clientWidth || 860, H = 320;
  const padL = 46, padR = 14, padT = 12, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const dayTotals = days.map(d => visible.reduce((s, ser) => s + valueOf(d, ser.key), 0));
  const maxV = Math.max(1, ...dayTotals);
  const Y = v => padT + ih - (v / maxV) * ih;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H });
  for (let g = 0; g <= 4; g++) {
    const gv = maxV * g / 4, gy = Y(gv);
    const attrs = { x1: padL, x2: W - padR, y1: gy, y2: gy, stroke: '#21262c', 'stroke-width': 1 };
    if (g > 0) attrs['stroke-dasharray'] = '3,5';
    svg.appendChild(svgEl('line', attrs));
    const t = svgEl('text', { x: padL - 9, y: gy + 4, 'text-anchor': 'end', fill: '#6b727b', 'font-size': 11 });
    t.textContent = barDim === 'tool' ? fmtInt(gv) : (barUnit === 'cost' ? fmtCost(gv) : fmtTokens(gv));
    svg.appendChild(t);
  }
  const slot = iw / days.length;
  const bw = Math.max(5, Math.min(28, slot * 0.5));
  const X = i => padL + slot * i + (slot - bw) / 2;
  const step = Math.max(1, Math.ceil(days.length / 7));
  days.forEach((d, i) => {
    if (i % step !== 0 && i !== days.length - 1) return;
    const t = svgEl('text', { x: X(i) + bw / 2, y: H - 7, 'text-anchor': 'middle', fill: '#6b727b', 'font-size': 11.5 });
    t.textContent = md(d.date);
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
    const unitName = barDim === 'tool' ? '调用' : (barUnit === 'cost' ? '估算' : 'tokens');
    showTip(tipHTML(`${md(days[idx].date)} · ${fmtVal(dayTotals[idx])}`, rows.length ? rows : [{ color: '#8b929a', name: unitName, value: '0' }]), ev.clientX, ev.clientY);
  });
  overlay.addEventListener('mouseleave', hideTip);
  svg.appendChild(overlay);
  box.appendChild(svg);
}

/* ---------------- 系统健康度 ---------------- */
function renderHealth() {
  const days = rangeDays();
  $('#healthRange').textContent = RANGE === 7 ? '近 7 日' : '近 30 日';
  const names = modelTotalsInRange(days).map(m => m.name)
    .filter(n => days.some(d => d.byModel[n] && d.byModel[n].spanTokens > 0))
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
      const m = d.byModel[n];
      return m && m.spanTokens > 0 && m.spanMs > 0 ? m.spanTokens / m.spanMs * 1000 : null;
    }),
  }));
  renderLineChart($('#healthChart'), {
    series, labels: days.map(d => d.date), H: 260,
    yFmt: v => v >= 100 ? Math.round(v) + '' : v.toFixed(1),
    rowFmt: v => v.toFixed(1) + ' tok/s',
  });
}

/* ---------------- 单价设置 ---------------- */
const dlg = $('#priceDlg');
function openPriceDlg() {
  const days = rangeDays();
  const names = new Set(modelTotalsInRange(days).map(m => m.name));
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
  dlg.showModal();
}
$('#priceBtn').addEventListener('click', openPriceDlg);
$('#priceCancel').addEventListener('click', () => dlg.close());
$('#priceSave').addEventListener('click', () => {
  const table = {};
  for (const inp of $('#priceRows').querySelectorAll('input')) {
    const m = inp.dataset.m, f = inp.dataset.f, v = parseFloat(inp.value);
    if (!isFinite(v) || v <= 0) continue;
    (table[m] || (table[m] = {}))[f] = v;
  }
  localStorage.setItem('dshPrices_v1', JSON.stringify(table));
  dlg.close();
  renderAll();
});

/* ---------------- 总渲染与事件 ---------------- */
function renderAll() {
  if (!DATA) return;
  const empty = !DATA.days.length;
  $('#emptyBanner').style.display = empty ? '' : 'none';
  if (empty) return;
  renderTrend();
  renderDonut();
  renderActivity();
  renderHeat();
  renderUsageTiles();
  renderBars();
  renderHealth();
  const t = new Date(DATA.generatedAt);
  $('#foot').textContent = `数据源 ${DATA.sessionsDir} · ${DATA.sessionCount} 个会话 · 更新于 ${t.toLocaleTimeString('zh-CN', { hour12: false })}`;
}

async function load() {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  try {
    const r = await fetch('api/data'); // 相对路径：独立模式(/)与插件模式(/usage-dashboard/)都成立
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
$('#heatSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  heatMode = b.dataset.mode;
  for (const x of $('#heatSeg').children) x.classList.toggle('on', x === b);
  renderHeat();
});
$('#unitSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  barUnit = b.dataset.unit;
  for (const x of $('#unitSeg').children) x.classList.toggle('on', x === b);
  if (barUnit === 'cost' && barDim === 'model' && priceTableEmpty()) openPriceDlg();
  renderAll();
});
$('#dimSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button');
  if (!b) return;
  barDim = b.dataset.dim;
  for (const x of $('#dimSeg').children) x.classList.toggle('on', x === b);
  hiddenBars.clear();
  renderBars();
  renderDonut(); // 中心单位随 barUnit 变化
});
$('#refreshBtn').addEventListener('click', load);

let rsTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rsTimer);
  rsTimer = setTimeout(renderAll, 200);
});

load();
