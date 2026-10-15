/* ===========================================================
   render.js —— AI 输出的富文本渲染
   Markdown + KaTeX(含 mhchem 化学式) + 图/时间线/思维导图
   =========================================================== */
import { el, esc } from './util.js';
import { makePlotFigure, hydratePlots } from './math.js';

const marked = window.marked.marked || window.marked;
const katex = window.katex;

const KATEX = { throwOnError: false, strict: false, trust: false, output: 'html', macros: { '\\R': '\\mathbb{R}' } };

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
  start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src);
    if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer(t) {
    try { return katex.renderToString(t.text, { ...KATEX, displayMode: true }); }
    catch { return '<pre><code>' + esc(t.text) + '</code></pre>'; }
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
  renderer(t) { return '<mark class="fx">' + this.parser.parseInline(t.tokens) + '</mark>'; },
};

marked.use({ gfm: true, breaks: true, extensions: [highlight, blockMath, inlineMath] });

/* --------------------------- 清洗 --------------------------- */
const DANGEROUS = /<\s*\/?\s*(script|iframe|object|embed|link|meta|style|base|form|input|button)\b[^>]*>/gi;
export function sanitize(html) {
  return String(html || '')
    .replace(DANGEROUS, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src|xlink:href)\s*=\s*(?:"|')?\s*javascript:[^"'\s>]*/gi, ' href="#"');
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
const SPECIAL = new Set(['plot', 'svg', 'timeline', 'mindmap', 'followups', 'ask', 'chem', 'graph']);

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
