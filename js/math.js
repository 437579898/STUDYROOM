/* ===========================================================
   math.js —— 表达式解析 + 函数图像绘制
   AI 用 plot 代码块描述图像，这里负责真正画出来。
   =========================================================== */
import { el } from './util.js';

/* --------------------------- 词法分析 --------------------------- */
const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  cot: (x) => 1 / Math.tan(x), sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x),
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  ln: Math.log, log2: Math.log2, log10: Math.log10, lg: Math.log10,
  exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  max: Math.max, min: Math.min, pow: Math.pow, atan2: Math.atan2,
  log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: Math.PI * 2 };
const NAMES = [...Object.keys(FUNCS), ...Object.keys(CONSTS)].sort((a, b) => b.length - a.length);

function tokenize(src) {
  const s = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/，/g, ',');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (s[j] === 'e' || s[j] === 'E') {
        let k = j + 1;
        if (s[k] === '+' || s[k] === '-') k++;
        if (/[0-9]/.test(s[k] || '')) { while (k < s.length && /[0-9]/.test(s[k])) k++; j = k; }
      }
      out.push({ t: 'num', v: parseFloat(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z\u03c0]/.test(c)) {
      const rest = s.slice(i);
      let matched = null;
      for (const n of NAMES) if (rest.startsWith(n)) { matched = n; break; }
      if (matched) { out.push({ t: 'id', v: matched }); i += matched.length; }
      else { out.push({ t: 'id', v: c }); i += 1; }
      continue;
    }
    if ('+-*/^%(),'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error('无法识别的字符 ' + c);
  }
  return out;
}

/* --------------------------- 语法分析 --------------------------- */
function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (t) => { if (tokens[p] && tokens[p].t === t) { p++; return true; } return false; };
  const expect = (t) => { if (!eat(t)) throw new Error('表达式缺少 ' + t); };

  function expr() {
    let a = term();
    for (;;) {
      if (eat('+')) a = { t: 'bin', op: '+', a, b: term() };
      else if (eat('-')) a = { t: 'bin', op: '-', a, b: term() };
      else return a;
    }
  }
  function startsPrimary() {
    const tk = peek();
    return !!tk && (tk.t === 'num' || tk.t === 'id' || tk.t === '(');
  }
  function term() {
    let a = unary();
    for (;;) {
      if (eat('*')) a = { t: 'bin', op: '*', a, b: unary() };
      else if (eat('/')) a = { t: 'bin', op: '/', a, b: unary() };
      else if (eat('%')) a = { t: 'bin', op: '%', a, b: unary() };
      else if (startsPrimary()) a = { t: 'bin', op: '*', a, b: unary() };
      else return a;
    }
  }
  function unary() {
    if (eat('-')) return { t: 'un', op: '-', a: unary() };
    if (eat('+')) return unary();
    return power();
  }
  function power() {
    const a = primary();
    if (eat('^')) return { t: 'bin', op: '^', a, b: unary() };
    return a;
  }
  function primary() {
    const tk = peek();
    if (!tk) throw new Error('表达式不完整');
    if (tk.t === 'num') { p++; return { t: 'num', v: tk.v }; }
    if (tk.t === '(') { p++; const e = expr(); expect(')'); return e; }
    if (tk.t === 'id') {
      p++;
      const name = tk.v;
      if (eat('(')) {
        const args = [];
        if (!eat(')')) { args.push(expr()); while (eat(',')) args.push(expr()); expect(')'); }
        if (!FUNCS[name]) throw new Error('未知函数 ' + name);
        return { t: 'call', name, args };
      }
      if (name in CONSTS) return { t: 'num', v: CONSTS[name] };
      if (name in FUNCS) throw new Error('函数 ' + name + ' 缺少括号');
      return { t: 'var', name };
    }
    throw new Error('表达式有误');
  }

  const ast = expr();
  if (p < tokens.length) throw new Error('表达式尾部有多余内容');
  return ast;
}

const cache = new Map();
/** 编译表达式为 (x)=>number；失败时返回 NaN 函数并带 __error */
export function compile(src) {
  const key = String(src).trim();
  if (cache.has(key)) return cache.get(key);
  let fn;
  try {
    const ast = parse(tokenize(key));
    fn = (x) => evalNode(ast, x);
    const probe = fn(0.37);
    if (typeof probe !== 'number') throw new Error('表达式无法求值');
  } catch (e) {
    fn = () => NaN;
    fn.__error = e.message;
  }
  cache.set(key, fn);
  return fn;
}

function evalNode(n, x) {
  switch (n.t) {
    case 'num': return n.v;
    case 'var': return n.name === 'x' ? x : NaN;
    case 'un': return -evalNode(n.a, x);
    case 'bin': {
      const a = evalNode(n.a, x), b = evalNode(n.b, x);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '%': return a % b;
        case '^': return Math.pow(a, b);
      }
      return NaN;
    }
    case 'call': {
      const f = FUNCS[n.name];
      if (!f) return NaN;
      return f(...n.args.map((a) => evalNode(a, x)));
    }
  }
  return NaN;
}

/* --------------------------- 规格解析 --------------------------- */
const PALETTE = ['#7a4d22', '#b0453a', '#2f5c8a', '#2e6b45', '#8a6c14', '#6b3f8a', '#0f6f74'];

export function parsePlotSpec(text) {
  const spec = { title: '', x: null, y: null, curves: [], points: [], hlines: [], vlines: [], notes: [] };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const kv = /^([a-zA-Z]+)\s*[:：]\s*(.+)$/.exec(line);
    if (kv) {
      const k = kv[1].toLowerCase(), v = kv[2].trim();
      if (k === 'title' || k === '标题') { spec.title = v; continue; }
      if (k === 'x' || k === 'xrange' || k === 'x轴') { spec.x = nums(v); continue; }
      if (k === 'y' || k === 'yrange' || k === 'y轴') { spec.y = nums(v); continue; }
    }

    let m;
    if ((m = /^y\s*[=:]\s*(.+)$/i.exec(line))) {
      const parts = m[1].split('|').map((s) => s.trim());
      spec.curves.push({ expr: parts[0], color: parts[1] || null, label: parts[2] || parts[0] });
      continue;
    }
    if ((m = /^(?:hline|水平线)\s*[:：]?\s*(.+)$/i.exec(line))) {
      const parts = m[1].split('|').map((s) => s.trim());
      spec.hlines.push({ y: parseFloat(parts[0]), color: parts[1] || '#8a7a63' });
      continue;
    }
    if ((m = /^(?:vline|竖线)\s*[:：]?\s*(.+)$/i.exec(line))) {
      const parts = m[1].split('|').map((s) => s.trim());
      spec.vlines.push({ x: parseFloat(parts[0]), color: parts[1] || '#8a7a63' });
      continue;
    }
    if ((m = /^(?:point|点)\s*[:：]?\s*\(?\s*(-?[0-9.eE]+)\s*[,，]\s*(-?[0-9.eE]+)\s*\)?\s*(?:\|\s*(.*))?$/.exec(line))) {
      spec.points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), label: (m[3] || '').trim(), color: '#b0453a' });
      continue;
    }
    if ((m = /^(?:note|注)\s*[:：]\s*(.+)$/i.exec(line))) { spec.notes.push(m[1].trim()); continue; }

    if (/^[a-zA-Z0-9(.\-]/.test(line)) {
      const parts = line.split('|').map((s) => s.trim());
      spec.curves.push({ expr: parts[0].replace(/^y\s*=\s*/, ''), color: parts[1] || null, label: parts[2] || parts[0] });
    }
  }
  spec.curves.forEach((c, i) => { if (!c.color) c.color = PALETTE[i % PALETTE.length]; });
  return spec;
}

function nums(s) {
  const m = String(s).match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g);
  if (!m || m.length < 2) return null;
  const a = parseFloat(m[0]), b = parseFloat(m[1]);
  return a < b ? [a, b] : [b, a];
}

/* --------------------------- 绘图 --------------------------- */
function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if (norm <= 1) step = 1; else if (norm <= 2) step = 2; else if (norm <= 2.5) step = 2.5;
  else if (norm <= 5) step = 5; else step = 10;
  return step * mag;
}

function fmtTick(v, step) {
  if (Math.abs(v) < 1e-9) return '0';
  const rel = v / Math.PI;
  if (Math.abs(rel - Math.round(rel)) < 1e-9 && Math.abs(rel) >= 1 && Math.abs(rel) <= 6) {
    const n = Math.round(rel);
    if (n === 1) return 'π';
    if (n === -1) return '-π';
    return n + 'π';
  }
  const dec = Math.max(0, Math.min(4, -Math.floor(Math.log10(step))));
  return v.toFixed(dec).replace(/\.?0+$/, '') || '0';
}

export function drawPlot(canvas, spec) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const hostW = canvas.parentElement ? canvas.parentElement.clientWidth : 620;
  const cssW = Math.max(260, hostW - 24);
  const cssH = Math.round(Math.min(500, Math.max(230, cssW * 0.6)));

  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const pad = { l: 46, r: 18, t: 16, b: 34 };
  const W = cssW - pad.l - pad.r;
  const H = cssH - pad.t - pad.b;

  const parsed = spec.curves.map((c) => ({ ...c, fn: compile(c.expr) }));
  const broken = parsed.filter((c) => c.fn.__error);
  if (parsed.length && broken.length === parsed.length) {
    return { error: '无法解析表达式：' + broken.map((b) => b.expr + '（' + b.fn.__error + '）').join('；') };
  }

  const xr = spec.x || [-6.5, 6.5];
  const N = Math.max(360, Math.min(2400, Math.round(W * 2)));
  const samples = parsed.map((c) => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = xr[0] + (xr[1] - xr[0]) * (i / N);
      let y;
      try { y = c.fn(x); } catch { y = NaN; }
      if (!Number.isFinite(y) || Math.abs(y) > 1e6) y = NaN;
      pts.push([x, y]);
    }
    return pts;
  });

  let yr = spec.y;
  if (!yr) {
    let lo = Infinity, hi = -Infinity;
    for (const pts of samples) for (const p of pts) if (Number.isFinite(p[1])) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
    for (const p of spec.points) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
    for (const h of spec.hlines) { lo = Math.min(lo, h.y); hi = Math.max(hi, h.y); }
    if (!Number.isFinite(lo)) { lo = -5; hi = 5; }
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const m = (hi - lo) * 0.12;
    yr = [lo - m, hi + m];
  }

  const X = (x) => pad.l + ((x - xr[0]) / (xr[1] - xr[0])) * W;
  const Y = (y) => pad.t + H - ((y - yr[0]) / (yr[1] - yr[0])) * H;

  const xstep = niceStep(xr[1] - xr[0], 8);
  const ystep = niceStep(yr[1] - yr[0], 6);

  g.lineWidth = 1;
  g.font = '11px "Cascadia Mono", Consolas, monospace';
  g.strokeStyle = 'rgba(140,115,75,.18)';
  g.beginPath();
  for (let x = Math.ceil(xr[0] / xstep) * xstep; x <= xr[1] + 1e-9; x += xstep) {
    const px = Math.round(X(x)) + .5; g.moveTo(px, pad.t); g.lineTo(px, pad.t + H);
  }
  for (let y = Math.ceil(yr[0] / ystep) * ystep; y <= yr[1] + 1e-9; y += ystep) {
    const py = Math.round(Y(y)) + .5; g.moveTo(pad.l, py); g.lineTo(pad.l + W, py);
  }
  g.stroke();

  const ax = (yr[0] <= 0 && yr[1] >= 0) ? Y(0) : pad.t + H;
  const ay = (xr[0] <= 0 && xr[1] >= 0) ? X(0) : pad.l;
  g.strokeStyle = 'rgba(90,72,44,.75)';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(pad.l, Math.round(ax) + .5); g.lineTo(pad.l + W, Math.round(ax) + .5);
  g.moveTo(Math.round(ay) + .5, pad.t); g.lineTo(Math.round(ay) + .5, pad.t + H);
  g.stroke();

  g.fillStyle = 'rgba(90,72,44,.82)';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  for (let x = Math.ceil(xr[0] / xstep) * xstep; x <= xr[1] + 1e-9; x += xstep) {
    if (Math.abs(x) < 1e-9) continue;
    g.fillText(fmtTick(x, xstep), X(x), Math.min(pad.t + H + 15, Math.max(pad.t + 8, ax + 14)));
  }
  g.textAlign = 'right';
  for (let y = Math.ceil(yr[0] / ystep) * ystep; y <= yr[1] + 1e-9; y += ystep) {
    if (Math.abs(y) < 1e-9) continue;
    g.fillText(fmtTick(y, ystep), pad.l - 8, Y(y));
  }
  g.fillText('O', ay - 5, ax + 12);

  g.setLineDash([5, 4]);
  g.lineWidth = 1.2;
  for (const h of spec.hlines) {
    if (h.y < yr[0] || h.y > yr[1]) continue;
    g.strokeStyle = h.color;
    g.beginPath(); g.moveTo(pad.l, Y(h.y)); g.lineTo(pad.l + W, Y(h.y)); g.stroke();
  }
  for (const v of spec.vlines) {
    if (v.x < xr[0] || v.x > xr[1]) continue;
    g.strokeStyle = v.color;
    g.beginPath(); g.moveTo(X(v.x), pad.t); g.lineTo(X(v.x), pad.t + H); g.stroke();
  }
  g.setLineDash([]);

  g.lineWidth = 2.1;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const ySpan = yr[1] - yr[0];
  samples.forEach((pts, i) => {
    g.strokeStyle = parsed[i].color;
    g.beginPath();
    let pen = false, prevY = null;
    for (const p of pts) {
      const x = p[0], y = p[1];
      if (!Number.isFinite(y)) { pen = false; prevY = null; continue; }
      const jump = prevY !== null && Math.abs(y - prevY) > ySpan * 0.6;
      if (jump) { g.stroke(); g.beginPath(); pen = false; }
      const px = X(x), py = Y(Math.max(yr[0] - ySpan, Math.min(yr[1] + ySpan, y)));
      if (!pen) { g.moveTo(px, py); pen = true; } else g.lineTo(px, py);
      prevY = y;
    }
    g.stroke();
  });

  for (const p of spec.points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const px = X(p.x), py = Y(p.y);
    g.fillStyle = p.color;
    g.beginPath(); g.arc(px, py, 4.2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fffdf7'; g.lineWidth = 1.6; g.stroke();
    if (p.label) {
      g.fillStyle = '#7d2e21';
      g.font = '12.5px "KaiTi", "SimSun", serif';
      g.textAlign = 'left';
      g.fillText(p.label, px + 8, py - 10);
    }
  }

  return { error: null, curves: parsed.map((c) => ({ label: c.label, color: c.color, bad: !!c.fn.__error })) };
}

/** 把一段 plot 源码渲染成 figure 元素（延迟到插入 DOM 后再画） */
export function makePlotFigure(code, caption) {
  const spec = parsePlotSpec(code);
  const canvas = el('canvas');
  const legend = el('div', { class: 'plot-legend' });
  const note = el('div', { class: 'figure__note' });
  const fig = el('div', { class: 'figure', dataset: { figure: 'plot' } }, [
    caption ? el('div', { class: 'figure__cap', text: caption }) : null,
    el('div', { class: 'figure__body' }, [canvas]),
    legend, note,
    el('pre', { class: 'sr plot-src', text: code }),
  ]);

  fig.__draw = () => {
    const r = drawPlot(canvas, spec);
    legend.innerHTML = '';
    if (r.error) { note.textContent = r.error; canvas.style.display = 'none'; return; }
    canvas.style.display = '';
    note.textContent = '';
    for (const c of r.curves) {
      legend.append(el('span', { class: 'lg' }, [
        el('i', { class: 'sw', style: { background: c.color } }),
        c.label + (c.bad ? '（表达式有误）' : ''),
      ]));
    }
    if (spec.notes.length) note.textContent = spec.notes.join('　·　');
  };
  return fig;
}

export function hydratePlots(root) {
  (root || document).querySelectorAll('[data-figure="plot"]').forEach((fig) => {
    if (fig.dataset.drawn === '1') return;
    fig.dataset.drawn = '1';
    if (typeof fig.__draw === 'function') { try { fig.__draw(); } catch { /* ignore */ } }
  });
}
