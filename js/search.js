/* ===========================================================
   search.js —— 章节 / 概念搜索
   数据源三层：
     1. 结构层：科目 / 册 / 章 / 节名（内置目录）
     2. 概念层：window.CONCEPTS（每个节 3~6 个概念关键词）
     3. 已有数据：错题本的题目与标签、备忘录正文
   =========================================================== */
import { $, el, esc, toast } from './util.js';
import { subjects, getSubject } from './subject.js';
import { store } from './store.js';

const CONCEPTS = window.CONCEPTS || {};

/* 预建索引：科目 → 册 → 章 → 节 */
const INDEX = [];
for (const s of subjects()) {
  for (const v of s.volumes || []) {
    for (const c of v.chapters || []) {
      for (const sec of c.sections || []) {
        INDEX.push({
          sectionId: sec.id,
          subject: s, volume: v, chapter: c, section: sec,
          concepts: CONCEPTS[sec.id] || [],
        });
      }
    }
  }
}

/** 命中高亮（先转义再插标签，避免 XSS） */
function hl(text, q) {
  const raw = String(text == null ? '' : text);
  if (!q) return esc(raw);
  const i = raw.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(raw);
  return esc(raw.slice(0, i))
    + '<span class="search-item__hit">' + esc(raw.slice(i, i + q.length)) + '</span>'
    + esc(raw.slice(i + q.length));
}

/** 给一条章节记录打分。返回 0 表示不匹配。 */
function scoreSection(rec, q) {
  let sc = 0;
  const why = [];

  const nm = rec.section.name;
  if (nm === q) { sc += 200; why.push('节名完全相同'); }
  else if (nm.includes(q)) { sc += nm.startsWith(q) ? 120 : 80; why.push('节名'); }

  // 概念层的权重故意给得高：搜「配方法」应该直接命中相关章节，
  // 而不是淹没在标题的模糊匹配里。
  for (const k of rec.concepts) {
    if (k === q) { sc += 150; why.push('概念「' + k + '」'); }
    else if (k.includes(q) || q.includes(k)) { sc += 70; why.push('概念「' + k + '」'); }
  }

  if (rec.chapter.name.includes(q)) { sc += 45; why.push('章名'); }
  if (rec.volume.name.includes(q)) { sc += 20; why.push('册名'); }
  if (rec.subject.name.includes(q)) { sc += 15; why.push('科目'); }

  return { sc, why };
}

function searchSections(q) {
  const out = [];
  for (const rec of INDEX) {
    const r = scoreSection(rec, q);
    if (r.sc > 0) out.push({ type: 'section', rec, score: r.sc, why: r.why });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 40);
}

function searchWrongbook(q) {
  const items = (store.state.wrongbook && store.state.wrongbook.items) || [];
  const out = [];
  for (const it of items) {
    const hay = [it.question, it.analysis, it.mine, it.right, (it.tags || []).join(' '), it.sectionLabel]
      .join(' ').toLowerCase();
    if (hay.includes(q)) out.push({ type: 'wrong', item: it });
    if (out.length >= 8) break;
  }
  return out;
}

function searchMemos(q) {
  const items = (store.state.memos && store.state.memos.items) || [];
  const out = [];
  for (const n of items) {
    const hay = ((n.title || '') + ' ' + (n.body || '')).toLowerCase();
    if (hay.includes(q)) out.push({ type: 'memo', item: n });
    if (out.length >= 6) break;
  }
  return out;
}

/* ============================ 界面 ============================ */
let dom = {};
let flat = [];       // 当前可键盘上下选择的条目
let sel = 0;
let hooks = { onPickSection: () => {}, onOpenDrawer: () => {} };

function buildRows(q) {
  const rows = [];
  if (!q) {
    // 空查询：给一点引导，而不是空白
    if (!Object.keys(CONCEPTS).length) {
      rows.push({ kind: 'hint', text: '概念索引未加载，目前只能按章节名搜索' });
    }
    rows.push({ kind: 'group', text: '可 以 这 样 搜' });
    rows.push({ kind: 'hint', text: '章节名：诱导公式、动量守恒、细胞呼吸' });
    rows.push({ kind: 'hint', text: '概念词：配方法、洛伦兹力、奇变偶不变、同源染色体' });
    rows.push({ kind: 'hint', text: '你自己的内容：错题里的题目与知识点、备忘录正文' });
    return rows;
  }

  const secs = searchSections(q);
  const wrongs = searchWrongbook(q);
  const memos = searchMemos(q);

  if (!secs.length && !wrongs.length && !memos.length) {
    rows.push({ kind: 'empty', text: '没有找到「' + q + '」' });
    rows.push({ kind: 'hint', text: '试试只搜关键词里的两个字，比如「诱导」「动量」「呼吸」' });
    return rows;
  }

  if (secs.length) {
    rows.push({ kind: 'group', text: '章 节 · ' + secs.length });
    for (const r of secs) rows.push({ kind: 'section', data: r });
  }
  if (wrongs.length) {
    rows.push({ kind: 'group', text: '错 题 本 · ' + wrongs.length });
    for (const r of wrongs) rows.push({ kind: 'wrong', data: r });
  }
  if (memos.length) {
    rows.push({ kind: 'group', text: '备 忘 录 · ' + memos.length });
    for (const r of memos) rows.push({ kind: 'memo', data: r });
  }
  return rows;
}

function sectionRow(r, q) {
  const rec = r.data.rec;
  const node = el('button', { class: 'search-item', dataset: { kind: 'section' } }, [
    el('div', { class: 'search-item__path', html: esc(rec.subject.name) + ' › ' + esc(rec.volume.name) + ' › ' + esc(rec.chapter.name) }),
    el('div', { class: 'search-item__name', html: esc(rec.section.no) + '　' + hl(rec.section.name, q) }),
  ]);
  if (rec.concepts.length) {
    const tags = el('div', { class: 'search-item__tags' });
    for (const k of rec.concepts.slice(0, 5)) {
      tags.append(el('span', { class: 'search-item__tag', html: hl(k, q) }));
    }
    node.append(tags);
  }
  const why = r.data.why || [];
  if (why.length) node.append(el('div', { class: 'search-item__why', text: '命中：' + why.slice(0, 3).join('　') }));
  return node;
}

function wrongRow(r, q) {
  const it = r.data.item;
  const node = el('button', { class: 'search-item', dataset: { kind: 'wrong' } }, [
    el('div', { class: 'search-item__path', text: '错题本　' + (it.sectionLabel || '') }),
    el('div', { class: 'search-item__name', html: hl(String(it.question || '').slice(0, 60), q) }),
  ]);
  if ((it.tags || []).length) {
    const tags = el('div', { class: 'search-item__tags' });
    for (const t of it.tags.slice(0, 4)) tags.append(el('span', { class: 'search-item__tag', html: hl(t, q) }));
    node.append(tags);
  }
  return node;
}

function memoRow(r, q) {
  const n = r.data.item;
  return el('button', { class: 'search-item', dataset: { kind: 'memo' } }, [
    el('div', { class: 'search-item__path', text: '备忘录' }),
    el('div', { class: 'search-item__name', html: hl(n.title || '（无标题）', q) }),
    el('div', { class: 'search-item__why', html: hl(String(n.body || '').slice(0, 50), q) }),
  ]);
}

function render(q) {
  const rows = buildRows(q);
  dom.results.innerHTML = '';
  flat = [];
  sel = 0;

  for (const row of rows) {
    if (row.kind === 'group') { dom.results.append(el('div', { class: 'search-group', text: row.text })); continue; }
    if (row.kind === 'hint') { dom.results.append(el('div', { class: 'search-item__why', style: { padding: '4px 10px' }, text: row.text })); continue; }
    if (row.kind === 'empty') { dom.results.append(el('div', { class: 'empty', text: row.text })); continue; }

    let node;
    if (row.kind === 'section') node = sectionRow(row, q);
    else if (row.kind === 'wrong') node = wrongRow(row, q);
    else node = memoRow(row, q);

    node.addEventListener('click', () => activate(flat.length));
    dom.results.append(node);
    flat.push(row);
  }

  dom.count.textContent = q ? (flat.length + ' 条结果') : '';
  paintSel();
}

function paintSel() {
  const nodes = dom.results.querySelectorAll('.search-item');
  nodes.forEach((n, i) => n.classList.toggle('is-sel', i === sel));
  const cur = nodes[sel];
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function activate(i) {
  const row = flat[i];
  if (!row) return;
  if (row.kind === 'section') {
    closeSearch();
    hooks.onPickSection(row.data.rec.sectionId);
  } else if (row.kind === 'wrong') {
    closeSearch();
    hooks.onOpenDrawer('wrongbook');
  } else if (row.kind === 'memo') {
    closeSearch();
    hooks.onOpenDrawer('memo');
  }
}

export function openSearch() {
  dom.pop.hidden = false;
  dom.input.value = '';
  render('');
  setTimeout(() => dom.input.focus(), 30);
}

export function closeSearch() { if (dom.pop) dom.pop.hidden = true; }
export function toggleSearch() { if (dom.pop.hidden) openSearch(); else closeSearch(); }

export function initSearch(opts) {
  hooks.onPickSection = opts.onPickSection || (() => {});
  hooks.onOpenDrawer = opts.onOpenDrawer || (() => {});

  dom = {
    pop: $('#search-pop'),
    input: $('#search-input'),
    results: $('#search-results'),
    count: $('#search-count'),
  };

  $('#btn-search').addEventListener('click', toggleSearch);
  $('#search-close').addEventListener('click', closeSearch);

  dom.input.addEventListener('input', () => render(dom.input.value.trim()));
  dom.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (flat.length) { sel = (sel + 1) % flat.length; paintSel(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (flat.length) { sel = (sel - 1 + flat.length) % flat.length; paintSel(); } }
    else if (e.key === 'Enter') { e.preventDefault(); activate(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
}

/** 概念索引加载情况（设置面板里可以显示一句） */
export function conceptStats() {
  const n = Object.keys(CONCEPTS).length;
  return { sections: INDEX.length, indexed: n };
}
