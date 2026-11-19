/* ===========================================================
   render.js —— AI 输出的富文本渲染
   Markdown + KaTeX(含 mhchem 化学式) + 图/时间线/思维导图
   =========================================================== */
import { el, esc } from './util.js';
import { makePlotFigure, hydratePlots } from './math.js';

const marked = window.marked.marked || window.marked;
const katex = window.katex;

// throwOnError: true —— 出错时让 KaTeX 抛，我们用 catch 兜成 <code>。
// 原来设 false，KaTeX 会把整段源码染红铺在页面上（还带一大坨 title 提示框），
// 一次公式写错就整块内容看不清。
const KATEX = { throwOnError: true, strict: false, trust: false, output: 'html', macros: { '\\R': '\\mathbb{R}' } };

/* --------------------------- 数学扩展 --------------------------- */
const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) { const i = src.search(/\$(?!\$)/); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\$(?!\$)((?:\\.|[^$\\\n])+?)\$(?!\$)/.exec(src);
    if (m) return { type: 'inlineMath', raw: m[0], text: m[1] };
    return undefined;
  },
  renderer(t) {
    try { return katex.renderToString(t.text, { ...KATEX, displayMode: false }); }
    catch { return '<code>' + esc(t.text) + '</code>'; }
  },
};

const blockMath = {
  name: 'blockMath',
  level: 'block',
  // 只在「行首」报告位置。原来返回行中任意 $$ 的下标，会让 marked 的块解析
  // 把这一行从 $$ 处切开再拼回去——拼回来的 raw 里凭空多出换行符，
  // 于是 ==$$…$$== 这种强调直接被拆散（实测 raw 从
  //   "==$$a^2=…$$==" 变成 "==\n$$a^2=…\n$$=="）。
  // 行中的 $$ 由 inlineDisplayMath 负责。
  start(src) {
    const m = /\n\$\$/.exec(src);
    if (m) return m.index + 1;
    return src.startsWith('$$') ? 0 : undefined;
  },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
    if (!m) return undefined;
    // 不许跨空行。跨空行说明这两个 $$ 根本不在同一个段落里，
    // 典型是「==$$…$$==」这种写法：结尾的 $$ 后面跟着 "=="，
    // 惰性匹配会一路吃到后面某个段落的 $$ 为止，
    // 结果整段文字被当成一个公式丢给 KaTeX（真实踩过的坑）。
    if (/\n[ \t]*\n/.test(m[1])) return undefined;
    return { type: 'blockMath', raw: m[0], text: m[1].trim() };
  },
  renderer(t) {
    try { return katex.renderToString(t.text, { ...KATEX, displayMode: true }); }
    catch { return '<pre><code>' + esc(t.text) + '</code></pre>'; }
  },
};

/**
 * 行内出现的 $$...$$（display 公式）。
 * marked 的 blockMath 只在"行首"生效，而 ==$$…$$== 这种写法里 $$ 不在行首，
 * 于是 $$ 会被当普通字符、还可能被行内 $…$ 规则错配。
 * 这条规则补上行内位置，照样用 displayMode 渲染。
 */
const inlineDisplayMath = {
  name: 'inlineDisplayMath',
  level: 'inline',
  start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$(?!\$)/.exec(src);
    if (!m) return undefined;
    if (/\n[ \t]*\n/.test(m[1])) return undefined;   // 同样不跨空行
    return { type: 'inlineDisplayMath', raw: m[0], text: m[1].trim() };
  },
  renderer(t) {
    try { return katex.renderToString(t.text, { ...KATEX, displayMode: true }); }
    catch { return '<code>' + esc(t.text) + '</code>'; }
  },
};

/**
 * 关键公式强调：==...==  →  <mark class="fx">
 * 用 ==...== 而不是直接给所有公式上色，是为了让"先生"自己判断哪一条是重点。
 * 满屏都高亮等于没有重点 —— 这正是这次配色改造要修的病。
 * 内部照常走行内解析，所以 ==$GM = gR^2$== 里的公式会被 KaTeX 正常渲染。
 */
const highlight = {
  name: 'highlight',
  level: 'inline',
  start(src) { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^==(?=\S)([\s\S]*?\S)==(?!==)/.exec(src);
    if (m) return { type: 'highlight', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
    return undefined;
  },
  renderer(t) {
    // 里面若是一条独立公式（katex-display 是块级元素），mark 必须改成块级排版，
    // 否则 inline 的 mark 盒子高度塌成 0，背景只剩左右两条细边（实测踩过）。
    const block = (t.tokens || []).some((x) => x.type === 'inlineDisplayMath');
    return '<mark class="fx' + (block ? ' fx--block' : '') + '">' + this.parser.parseInline(t.tokens) + '</mark>';
  },
};

// 顺序有意义：highlight 最先（它整体吃掉 ==…== 再让内部重新走行内规则），
// inlineDisplayMath 必须在 inlineMath 之前，否则 $$ 的第二个 $ 会被当作行内公式开头。
marked.use({ gfm: true, breaks: true, extensions: [highlight, inlineDisplayMath, blockMath, inlineMath] });

/* --------------------------- 清洗 --------------------------- */
const DANGEROUS = /<\s*\/?\s*(script|iframe|object|embed|link|meta|style|base|form|input|button)\b[^>]*>/gi;
export function sanitize(html) {
  return String(html || '')
    .replace(DANGEROUS, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src|xlink:href)\s*=\s*(?:"|')?\s*javascript:[^"'\s>]*/gi, ' href="#"');
}

/* --------------------------- 立体几何（geo3d） ---------------------------
   为什么不用手写 svg 画立体图：svg 只认屏幕坐标，谁也不知道哪条棱被挡住了 ——
   模型只能凭感觉摆点，实测画出过 AD 比 BC 还长、底面翻过来、被挡的棱全实线的图。
   这里改成：模型只给「三维坐标 + 面」，由这段代码做投影、背面剔除、虚实线判定、
   淡色面着色、直角标记和标注避让，几何关系由坐标保证。
   语法（每行一条，中文冒号也认）：
     A: 0,0,0        （点名: x,y,z；x 向右、y 朝里、z 向上）
     面: ABCD, SAB   （按环绕顺序写顶点，法线朝外会自动纠正）
     直角: S,A,B     （在 A 处画直角标记，两边分别是 AS、AB）
     （投影固定用斜二测，不需要给视角）
     虚线: A-B       （可选，强制某条棱虚线，比如底面被挡的那条）
   ------------------------------------------------------------ */
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function mul3(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
function norm3(a) {
  const L = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / L, a[1] / L, a[2] / L];
}

function parseGeo3d(code) {
  const pts = [];
  const faces = [];
  const angles = [];
  const hide = new Set();
  let az = 128;
  let elev = 20;
  let soft = false;      // 淡面：默认不填充，只有写了「淡面:」才给面加很淡的颜色
  let flat = false;      // 正视图：把 y 方向的屏幕压缩比调小，更接近课本的重影感
  for (const raw of String(code == null ? '' : code).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (/^(面|faces?)$/i.test(key)) {
      for (const f of val.split(/[,，;；\s]+/)) {
        const names = f.replace(/[^A-Za-z0-9'′₁-₉]/g, '').split('');
        if (names.length >= 3) faces.push(names);
      }
      continue;
    }
    if (/^(直角|right|angle)$/i.test(key)) {
      // 支持「S,A,B」和「SAB」两种写法：先把分隔符全去掉，再按 3 个一组切
      const t = val.replace(/[^A-Za-z0-9]/g, '');
      for (let i = 0; i + 3 <= t.length; i += 3) angles.push(t.slice(i, i + 3).split(''));
      continue;
    }
    if (/^(淡面|fill|shade)$/i.test(key)) { soft = !/^(0|false|no|关|不)$/i.test(val); continue; }
    if (/^(正视图|flat)$/i.test(key)) { flat = true; continue; }
    if (/^(视角|view|camera)$/i.test(key)) {
      const v = val.split(/[,，\s]+/).map(Number);
      if (v.length >= 2 && v.every((x) => Number.isFinite(x))) { az = v[0]; elev = v[1]; }
      continue;
    }
    if (/^(虚线|hidden|dashed)$/i.test(key)) {
      // 同样支持「A-B」和「AB」：去掉分隔符后按 2 个一组切
      const t = val.replace(/[^A-Za-z0-9]/g, '');
      for (let i = 0; i + 2 <= t.length; i += 2) {
        const a = t[i];
        const b = t[i + 1];
        hide.add(a < b ? a + '|' + b : b + '|' + a);
      }
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9'′₁-₉]{0,3}$/.test(key)) {
      const v = val.split(/[,，\s]+/).map(Number);
      if (v.length === 3 && v.every((x) => Number.isFinite(x))) pts.push({ name: key, p: v });
    }
  }
  return { pts, faces, angles, hide, az, el: elev, soft, flat };
}

function makeGeo3dFigure(code, caption) {
  const shell = (kids) => el('div', { class: 'figure' }, [
    caption ? el('div', { class: 'figure__cap', text: caption }) : null,
    el('div', { class: 'figure__body' }, kids),
  ]);
  const g = parseGeo3d(code);
  if (g.pts.length < 4 || g.faces.length < 3) {
    return shell([el('div', { class: 'figure__err', text: 'geo3d 语法：至少 4 个点（A: 0,0,0）和 3 个面（面: ABCD, SAB）' })]);
  }
  const pos = new Map(g.pts.map((q) => [q.name, q.p]));
  const all = g.pts.map((q) => q.p);
  const centroid = [0, 1, 2].map((i) => all.reduce((s, v) => s + v[i], 0) / all.length);
  // 投影：**教科书斜二测**——x 向右、z 向上，y 朝观察者画成右下 45°，长度取真实的一半。
  // 所以 KY = KZ = 0.5·cos45° ≈ 0.354（不是随手调的"看着舒服"的角度）。
  // 「正视图:」再把纵深压一份，画「看着更扁」的示意图时才用。
  const K = g.flat ? 0.5 * 0.7071 * 0.75 : 0.5 * 0.7071;
  const KY = K;                    // y 方向在屏幕上的水平分量（向右）
  const KZ = K;                    // y 方向在屏幕上的竖直分量（屏幕上为负方向 = 向上，纵深朝右上）
  // 纵深朝「右上」才是课本的画法；朝右下看起来像物体倒向观察者。
  const proj = (p) => ({ x: p[0] + KY * p[1], y: -p[2] - KZ * p[1] });
  // 观察者在「前、上、右」这一侧（y 越小越近）。这个方向只影响虚实线判定，
  // 投影本身已经不依赖它；写反了会把轮廓线误判成被挡（所以这里必须和屏幕上"往里看"一致）。
  const viewT = norm3([KY, -1, -KZ]);
  // 射线与三角形求交（Möller–Trumbore），只用来判断"这个点在不在别的面后面"
  const rayTri = (orig, dir, a, b, c) => {
    const e1 = sub3(b, a);
    const e2 = sub3(c, a);
    const pv = cross3(dir, e2);
    const det = dot3(e1, pv);
    if (Math.abs(det) < 1e-9) return -1;
    const inv = 1 / det;
    const tv = sub3(orig, a);
    const u = dot3(tv, pv) * inv;
    if (u < 1e-4 || u > 1 - 1e-4) return -1;
    const qv = cross3(tv, e1);
    const v = dot3(dir, qv) * inv;
    if (v < 1e-4 || u + v > 1 - 1e-4) return -1;
    return dot3(e2, qv) * inv;
  };

  const faces = [];
  for (const names of g.faces) {
    const vs = names.map((n) => pos.get(n));
    if (vs.some((v) => !v) || vs.length < 3) continue;
    let n = norm3(cross3(sub3(vs[1], vs[0]), sub3(vs[2], vs[0])));
    if (!Number.isFinite(n[0]) || !Number.isFinite(n[1]) || !Number.isFinite(n[2])) continue;
    const fc = [0, 1, 2].map((i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
    if (dot3(n, sub3(fc, centroid)) < 0) n = mul3(n, -1);
    faces.push({ names, vs, n, front: dot3(n, viewT) > 1e-6 });
  }
  if (!faces.length) return shell([el('div', { class: 'figure__err', text: 'geo3d：面都不成立（顶点名写错？）' })]);

  const edges = new Map();
  for (const f of faces) {
    for (let i = 0; i < f.names.length; i++) {
      const a = f.names[i];
      const b = f.names[(i + 1) % f.names.length];
      if (!a || !b || a === b) continue;
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (!edges.has(key)) edges.set(key, { a: a < b ? a : b, b: a < b ? b : a, front: false });
      if (f.front) edges.get(key).front = true;
    }
  }

  const scr = g.pts.map((q) => ({ name: q.name, p: q.p, s: proj(q.p) }));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const q of scr) {
    minX = Math.min(minX, q.s.x);
    maxX = Math.max(maxX, q.s.x);
    minY = Math.min(minY, q.s.y);
    maxY = Math.max(maxY, q.s.y);
  }
  const W = 460;
  const H = 340;
  const PAD = 40;
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const ox = PAD + (W - 2 * PAD - spanX * scale) / 2 - minX * scale;
  const oy = PAD + (H - 2 * PAD - spanY * scale) / 2 - minY * scale;
  const S = (p) => { const s = proj(p); return { x: s.x * scale + ox, y: s.y * scale + oy }; };
  const f1 = (n) => Math.round(n * 10) / 10;

  const out = [];
  out.push('<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img">');
  const light = norm3([-0.35, 0.7, 0.62]);
  if (g.soft) {
    for (const f of faces) {
      if (!f.front) continue;
      const pts = f.vs.map((v) => S(v)).map((s) => f1(s.x) + ',' + f1(s.y)).join(' ');
      const lit = Math.max(0, dot3(f.n, light));
      const alpha = f1((0.04 + 0.03 * lit) * 100) / 100;
      out.push('<polygon points="' + pts + '" fill="#8a7a5e" fill-opacity="' + alpha + '" stroke="none"/>');
    }
  }
  // 「这一点是不是在别的面后面」：沿着朝观察者的方向打一条射线，看它戳不戳到别的面。
  // 这是教科书那种虚实线画法的判据 —— 只看面的朝向会把"底面那条边"误判成虚线。
  const occluded = (p) => {
    for (const f of faces) {
      for (let i = 1; i + 1 < f.vs.length; i++) {
        if (rayTri(p, viewT, f.vs[0], f.vs[i], f.vs[i + 1]) > 1e-3) return true;
      }
    }
    return false;
  };

  // 一条棱可能一半露一半藏（比如侧面那条斜棱被前面挡住），所以沿棱采样再切成段
  const N = 24;
  const raw = [];
  for (const e of edges.values()) {
    const pa = pos.get(e.a);
    const pb = pos.get(e.b);
    if (!pa || !pb) continue;
    const forceHide = g.hide.has(e.a + '|' + e.b);
    let cur = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = [
        pa[0] + (pb[0] - pa[0]) * t,
        pa[1] + (pb[1] - pa[1]) * t,
        pa[2] + (pb[2] - pa[2]) * t,
      ];
      const hid = forceHide || occluded(p);
      if (!cur) cur = { hidden: hid, t0: t, t1: t, pa, pb };
      else if (hid === cur.hidden) cur.t1 = t;
      else { raw.push(cur); cur = { hidden: hid, t0: t, t1: t, pa, pb }; }
    }
    if (cur) raw.push(cur);
  }
  const segs = [];
  for (const s of raw) {
    const at = (t) => S([
      s.pa[0] + (s.pb[0] - s.pa[0]) * t,
      s.pa[1] + (s.pb[1] - s.pa[1]) * t,
      s.pa[2] + (s.pb[2] - s.pa[2]) * t,
    ]);
    const A = at(s.t0);
    const B = at(s.t1);
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len < 1) continue;                    // 零长度碎段（顶点处采样误差）
    if (len < 3.5 && s.hidden) continue;      // 太短的虚线碎屑也丢掉
    segs.push({ hidden: s.hidden, A, B, len });
  }
  for (const s of segs) {
    if (!s.hidden) continue;
    out.push('<path d="M' + f1(s.A.x) + ' ' + f1(s.A.y) + 'L' + f1(s.B.x) + ' ' + f1(s.B.y) + '" fill="none" stroke="#2b2318" stroke-width="1.1" stroke-dasharray="5 4" stroke-linecap="round"/>');
  }
  for (const s of segs) {
    if (s.hidden) continue;
    out.push('<path d="M' + f1(s.A.x) + ' ' + f1(s.A.y) + 'L' + f1(s.B.x) + ' ' + f1(s.B.y) + '" fill="none" stroke="#2b2318" stroke-width="1.5" stroke-linecap="round"/>');
  }
  for (const tri of g.angles) {
    const O = pos.get(tri[1]);
    const A = pos.get(tri[0]);
    const B = pos.get(tri[2]);
    if (!O || !A || !B) continue;
    const ua = sub3(A, O);
    const ub = sub3(B, O);
    const la = Math.hypot(ua[0], ua[1], ua[2]);
    const lb = Math.hypot(ub[0], ub[1], ub[2]);
    if (!la || !lb) continue;
    const k = 0.2 * Math.min(la, lb);
    const p1 = add3(O, mul3(norm3(ua), k));
    const p2 = add3(O, add3(mul3(norm3(ua), k), mul3(norm3(ub), k)));
    const p3 = add3(O, mul3(norm3(ub), k));
    const q1 = S(p1);
    const q2 = S(p2);
    const q3 = S(p3);
    out.push('<path d="M' + f1(q1.x) + ' ' + f1(q1.y) + 'L' + f1(q2.x) + ' ' + f1(q2.y) + 'L' + f1(q3.x) + ' ' + f1(q3.y) + '" fill="none" stroke="#2b2318" stroke-width="1.1"/>');
  }
  const mid = S(centroid);
  for (const q of scr) {
    const s = S(q.p);
    out.push('<circle cx="' + f1(s.x) + '" cy="' + f1(s.y) + '" r="2.4" fill="#2b2318"/>');
    let dx = s.x - mid.x;
    let dy = s.y - mid.y;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L;
    dy /= L;
    const lx = s.x + dx * 15;
    const ly = s.y + dy * 15;
    const anchor = dx > 0.25 ? 'start' : (dx < -0.25 ? 'end' : 'middle');
    out.push('<text x="' + f1(lx) + '" y="' + f1(ly + 4.5) + '" font-family="KaiTi,SimSun,serif" font-size="13.5" fill="#2b2318" text-anchor="' + anchor + '">' + q.name + '</text>');
  }
  out.push('</svg>');
  return shell([el('div', { class: 'geo3d', html: out.join('') })]);
}

/* --------------------------- GeoGebra 3D（ggb） ---------------------------
   立体几何交给 GeoGebra：学生可以拖着转，看真正的三维。
   代价是它必须在浏览器里跑、且要从 geogebra.org 取一次脚本（约 37KB 的加载器 +
   3~6MB 的 app 资源），所以：
     · 默认不加载，点「打开 GeoGebra」才注入（一屏十几张图也不会卡）；
     · 脚本只取一次，之后走浏览器缓存；
     · 断网 / 被挡时给出明确提示，并允许「再试一次」；
     · 离线场景仍可用本地的 geo3d 静态图（teacher.js 里两种都写了）。
   语法：每行一条 GeoGebra 命令，坐标按题目数值写。
   ------------------------------------------------------------ */
const GGB_SRC = 'https://www.geogebra.org/apps/deployggb.js';
let ggbLoader = null;

function loadDeployGgb() {
  if (typeof window !== 'undefined' && window.GGBApplet) return Promise.resolve(window.GGBApplet);
  if (ggbLoader) return ggbLoader;
  ggbLoader = new Promise((resolve, reject) => {
    const hook = typeof window !== 'undefined' ? window.__SR_GGB_LOADER : null;
    if (typeof hook === 'function') {
      Promise.resolve().then(() => hook()).then(() => {
        if (window.GGBApplet) resolve(window.GGBApplet);
        else reject(new Error('测试桩没有提供 GGBApplet'));
      }).catch(reject);
      return;
    }
    const s = document.createElement('script');
    s.src = GGB_SRC;
    s.async = true;
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; fn(arg); };
    s.onload = () => {
      if (window.GGBApplet) finish(resolve, window.GGBApplet);
      else finish(reject, new Error('deployggb.js 里没有 GGBApplet'));
    };
    s.onerror = () => finish(reject, new Error('取不到 deployggb.js（网络或拦截）'));
    document.head.append(s);
    setTimeout(() => finish(reject, new Error('加载 GeoGebra 超过 20 秒')), 20000);
  });
  ggbLoader.catch(() => { ggbLoader = null; });   // 失败后允许重试
  return ggbLoader;
}

/* 从 ggb 文本里抓出「名 = (x, y, z)」形式的点，用于给 3D 视图取景。
   抓不到就跳过取景（轴/网格照样关掉），不会报错、也不要求模型改写法。 */
const GGB_PT = /^([A-Za-z][A-Za-z0-9_']*)\s*=\s*\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)\s*$/;
function ggbPoints(cmds) {
  const pts = [];
  for (const line of cmds) {
    const m = GGB_PT.exec(line);
    if (!m) continue;
    const p = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (!p.every((v) => Number.isFinite(v))) continue;
    pts.push({ name: m[1], p });
  }
  return pts;
}
function ggbBounds(pts) {
  if (!pts.length) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const q of pts) {
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], q.p[i]);
      hi[i] = Math.max(hi[i], q.p[i]);
    }
  }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
  return { lo, hi, pad: span * 0.18 };
}
/* 统一样式：模型只管几何，线宽 / 点大小 / 标签由这里定。
   这些命令失败也不报错——外观降级不该打断图。 */
function ggbStyleCommands(cmds, pts) {
  const out = [];
  const pointNames = new Set(pts.map((q) => q.name));
  for (const q of pts) {
    out.push('SetPointSize(' + q.name + ',3)');
    out.push('SetPointStyle(' + q.name + ',0)');
    out.push('ShowLabel(' + q.name + ',true)');
  }
  for (const line of cmds) {
    const m = /^([A-Za-z][A-Za-z0-9_']*)\s*=/.exec(line);
    if (!m || pointNames.has(m[1])) continue;
    out.push('SetLineThickness(' + m[1] + ',2)');
  }
  return out;
}

function makeGgbFigure(code, caption) {
  const cmds = String(code == null ? '' : code)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l[0] !== '#');
  const wrap = el('div', { class: 'figure' }, []);
  if (caption) wrap.append(el('div', { class: 'figure__cap', text: caption }));
  const body = el('div', { class: 'figure__body' });
  wrap.append(body);
  if (cmds.length < 2) {
    body.append(el('div', { class: 'figure__err', text: 'ggb 语法：每行一条 GeoGebra 命令，例如 A=(0,0,0)' }));
    return wrap;
  }

  const stage = el('div', { class: 'ggb__stage' });
  const btn = el('button', { class: 'btn btn--sm btn--primary', text: '打开 GeoGebra 立体图（可旋转）' });
  const note = el('div', { class: 'ggb__note', text: '在网页里跑 GeoGebra 3D · ' + cmds.length + ' 条命令 · 需要联网' });
  const bar = el('div', { class: 'ggb__bar' }, [btn, note]);
  body.append(el('div', { class: 'ggb' }, [stage, bar]));

  btn.addEventListener('click', async () => {
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = '正在加载 GeoGebra…';
    stage.classList.add('ggb__stage--loading');
    try {
      const GGBApplet = await loadDeployGgb();
      const host = el('div', { class: 'ggb__host' });
      stage.append(host);
      const w = Math.max(320, Math.min(720, (body.clientWidth || 640) - 8));
      const params = {
        appName: '3d',
        // 只留 3D 视图（T = 3D Graphics）。不加这条，左侧会留一列 A= B= C= 的代数区。
        perspective: 'T',
        width: w,
        height: Math.round(w * 0.62),
        showToolBar: false,
        showAlgebraInput: false,
        showMenuBar: false,
        showResetIcon: false,
        allowStyleBar: false,
        enableRightClick: false,
        enableLabelDrags: false,
        appletOnLoad: (api) => {
          stage.classList.remove('ggb__stage--loading');
          const bad = [];
          const run = (c) => {
            let ok = false;
            try { ok = api.evalCommand(c); } catch (e) { ok = false; }
            return ok;
          };
          try { if (api.setPerspective) api.setPerspective('T'); } catch (e) { /* 旧版没有 */ }
          for (const c of cmds) if (!run(c)) bad.push(c);
          // 坐标轴 / 网格：必须带 viewNumber=3（3D 视图），否则调用会被忽略
          try { if (api.setAxesVisible) api.setAxesVisible(3, false, false, false); } catch (e) { /* ignore */ }
          try { if (api.setGridVisible) api.setGridVisible(3, false); } catch (e) { /* ignore */ }
          const box = ggbBounds(ggbPoints(cmds));
          if (box) {
            try {
              api.setCoordSystem(
                box.lo[0] - box.pad, box.hi[0] + box.pad,
                box.lo[1] - box.pad, box.hi[1] + box.pad,
                box.lo[2] - box.pad, box.hi[2] + box.pad, true);
            } catch (e) { /* 取景失败就保持默认视图，不影响看图 */ }
          }
          for (const c of ggbStyleCommands(cmds, ggbPoints(cmds))) {
            try { api.evalCommand(c); } catch (e) { /* 样式失败不影响图 */ }
          }
          btn.remove();
          note.textContent = bad.length
            ? '有 ' + bad.length + ' 条命令 GeoGebra 没认出来（最多是命令名写错）：' + bad.slice(0, 2).join(' ; ')
            : '拖一下就能旋转；' + cmds.length + ' 条命令都执行成功了';
          note.classList.toggle('ggb__note--bad', bad.length > 0);
        },
      };
      new GGBApplet(params, true).inject(host);
    } catch (e) {
      stage.classList.remove('ggb__stage--loading');
      btn.dataset.busy = '';
      btn.disabled = false;
      btn.textContent = '再试一次';
      note.textContent = 'GeoGebra 没加载起来：' + (e && e.message ? e.message : e) + '（这台设备需要联网才能看动态图）';
      note.classList.add('ggb__note--bad');
    }
  });

  return wrap;
}

/* --------------------------- 各类型图块 --------------------------- */
function makeSvgFigure(code, caption) {
  const clean = String(code)
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return el('div', { class: 'figure' }, [
    caption ? el('div', { class: 'figure__cap', text: caption }) : null,
    el('div', { class: 'figure__body', html: clean }),
  ]);
}

function makeTimelineFigure(code, caption) {
  const wrap = el('div', { class: 'timeline' });
  for (const raw of String(code).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.replace(/^[-*]\s*/, '').split(/\s*[|｜]\s*|\s*[:：]\s*/);
    const when = parts[0] || '';
    const what = parts[1] || '';
    const more = parts.slice(2).join(' ').trim();
    wrap.append(el('div', { class: 'tl-item' }, [
      el('span', { class: 'tl-year', text: when }),
      el('span', { class: 'tl-text' }, [what, more ? el('span', { class: 'tl-sub', text: more }) : null]),
    ]));
  }
  return el('div', { class: 'figure' }, [
    caption ? el('div', { class: 'figure__cap', text: caption }) : null,
    el('div', { class: 'figure__body' }, [wrap]),
  ]);
}

function makeMindmapFigure(code, caption) {
  const lines = String(code).split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return el('div', { class: 'figure' });

  const nodes = lines.map((l) => {
    const indent = l.match(/^[\t ]*/)[0].replace(/\t/g, '  ').length;
    return { indent, text: l.trim().replace(/^[-*+]\s*/, '') };
  });

  function build(idx) {
    const node = nodes[idx];
    const kids = [];
    let i = idx + 1;
    while (i < nodes.length && nodes[i].indent > node.indent) {
      const c = build(i);
      kids.push(c.node);
      i = c.next;
    }
    const box = el('div', { class: 'mm-node' }, [el('span', { text: node.text })]);
    return {
      node: el('div', { class: 'mm-branch' }, [box, kids.length ? el('div', { class: 'mm-branches' }, kids) : null]),
      next: i,
    };
  }

  const built = build(0);
  const rootNode = built.node.firstElementChild;
  rootNode.className = 'mm-root';
  const branches = built.node.querySelector('.mm-branches');

  const mm = el('div', { class: 'mindmap' }, [rootNode, branches]);
  return el('div', { class: 'figure' }, [
    caption ? el('div', { class: 'figure__cap', text: caption }) : null,
    el('div', { class: 'figure__body' }, [mm]),
  ]);
}

function makeFollowups(code) {
  const box = el('div', { class: 'followups' });
  for (const raw of String(code).split(/\r?\n/)) {
    const q = raw.trim().replace(/^[-*+\d.、)\s]+/, '');
    if (!q) continue;
    box.append(el('button', { class: 'followup', text: q, dataset: { ask: q } }));
  }
  return box;
}

function makeChemBlock(code, display) {
  const tex = '\\ce{' + String(code).trim() + '}';
  try {
    return el('div', { class: 'ce-block', html: katex.renderToString(tex, { ...KATEX, displayMode: !!display }) });
  } catch {
    return el('pre', {}, [el('code', { text: code })]);
  }
}

/* --------------------------- 后处理 --------------------------- */
const SPECIAL = new Set(['plot', 'svg', 'geo3d', 'ggb', 'timeline', 'mindmap', 'followups', 'ask', 'chem', 'graph']);

function postProcess(root) {
  root.querySelectorAll('pre > code').forEach((codeEl) => {
    const m = /language-([\w-]+)/.exec(codeEl.className || '');
    if (!m) return;
    const lang = m[1].toLowerCase();
    if (!SPECIAL.has(lang)) return;

    const pre = codeEl.parentElement;
    const code = codeEl.textContent;

    const prev = pre.previousElementSibling;
    let caption = '';
    if (prev && /^(P|EM|STRONG)$/.test(prev.tagName) && prev.textContent.trim().length < 44 && !prev.querySelector('*')) {
      caption = prev.textContent.trim();
      prev.remove();
    }

    let node = null;
    if (lang === 'plot' || lang === 'graph') node = makePlotFigure(code, caption);
    else if (lang === 'svg') node = makeSvgFigure(code, caption);
    else if (lang === 'geo3d') node = makeGeo3dFigure(code, caption);
    else if (lang === 'ggb') node = makeGgbFigure(code, caption);
    else if (lang === 'timeline') node = makeTimelineFigure(code, caption);
    else if (lang === 'mindmap') node = makeMindmapFigure(code, caption);
    else if (lang === 'followups' || lang === 'ask') node = makeFollowups(code);
    else if (lang === 'chem') node = makeChemBlock(code, true);

    if (node) pre.replaceWith(node);
  });
}

/* --------------------------- 对外接口 --------------------------- */
export function renderFragment(markdown) {
  const html = sanitize(marked.parse(String(markdown || '')));
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const frag = tpl.content;
  postProcess(frag);
  hydratePlots(frag);
  return frag;
}

export function renderInto(node, markdown) {
  node.innerHTML = '';
  node.append(renderFragment(markdown));
  return node;
}

export function renderHTML(markdown) {
  const holder = el('div', { class: 'md' });
  holder.append(renderFragment(markdown));
  return holder.innerHTML;
}

const FENCE = /\x60{3}[\s\S]*?\x60{3}/g;
const TICK = /\x60([^\x60]*)\x60/g;

/**
 * 把累计文本按 Markdown 块切开 —— 流式增量渲染用。
 *
 * 为什么要感知围栏：plot 代码块和 $$...$$ 块**内部可以有空行**，
 * 直接按空行切会把这些块切坏（一张图被拆成两段）。
 * 这里跟踪围栏状态，围栏内的空行不切。
 *
 * 返回的数组里，**只有最后一块可能还没写完**，前面的都可以安全固化。
 */
export function splitBlocks(text) {
  const src = String(text == null ? '' : text);
  if (!src) return [];
  const lines = src.split('\n');
  const blocks = [];
  let cur = [];
  let fence = null;   // 'code' 或 'math'

  const flush = () => { if (cur.length) { blocks.push(cur.join('\n')); cur = []; } };

  for (const line of lines) {
    const t = line.trim();

    if (fence === 'code') {
      cur.push(line);
      if (/^\x60\x60\x60/.test(t)) fence = null;
      continue;
    }
    if (fence === 'math') {
      cur.push(line);
      if (/\$\$/.test(t)) fence = null;
      continue;
    }

    if (/^\x60\x60\x60/.test(t)) { fence = 'code'; cur.push(line); continue; }
    if (/^\$\$/.test(t)) {
      cur.push(line);
      const rest = t.slice(2);
      // 单行的 $$...$$ 自己就闭合了，不算开围栏
      if (!(rest.length > 0 && /\$\$\s*$/.test(rest))) fence = 'math';
      continue;
    }

    if (t === '') { flush(); continue; }
    cur.push(line);
  }
  flush();
  return blocks;
}

/** 纯文本预览（去掉 markdown 标记） */
export function plainText(markdown, max = 150) {
  let s = String(markdown || '')
    .replace(FENCE, ' [图] ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' [公式] ')
    .replace(/\$[^$\n]*\$/g, ' [公式] ')
    .replace(TICK, '$1')
    .replace(/[#*_>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

/** 抽出 AI 给出的追问建议（用于渲染成按钮） */
export function extractFollowups(markdown) {
  const m = /\x60{3}(?:followups|ask)\s*\n([\s\S]*?)\x60{3}/.exec(String(markdown || ''));
  if (!m) return [];
  return m[1].split(/\r?\n/).map((l) => l.trim().replace(/^[-*+\d.、)\s]+/, '')).filter(Boolean).slice(0, 5);
}
