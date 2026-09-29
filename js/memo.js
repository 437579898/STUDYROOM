/* ===========================================================
   memo.js —— 备忘录（右上角菱形图标）：就是一本随手记事本
   =========================================================== */
import { $, el, toast, debounce, relTime, fmtDateTime, uid } from './util.js';
import { store } from './store.js';
import { callOnce } from './teacher.js';
import { openModal, closeModal } from './overlay.js';

let dom = {};
let currentId = null;
let mode = 'list';   // list | edit

function items() {
  const q = (dom.search.value || '').trim().toLowerCase();
  let list = store.state.memos.items.slice();
  if (q) list = list.filter((n) => ((n.title || '') + '\n' + (n.body || '')).toLowerCase().includes(q));
  list.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  return list;
}

function render() {
  const list = items();
  dom.count.textContent = store.state.memos.items.length ? store.state.memos.items.length + ' 条' : '';
  dom.list.hidden = mode !== 'list';
  dom.editor.hidden = mode !== 'edit';

  if (mode === 'list') {
    dom.list.innerHTML = '';
    if (!list.length) {
      dom.list.append(el('div', { class: 'empty' }, [
        el('span', { class: 'big', text: '◇' }),
        el('div', { text: store.state.memos.items.length ? '没有匹配的笔记' : '还没有笔记' }),
        el('div', { style: { fontSize: '12px', marginTop: '6px' }, text: '随手记下公式、易错点、老师说过的话都行。' }),
      ]));
      return;
    }
    for (const n of list) {
      const node = el('button', {
        class: 'memo-item' + (n.pinned ? ' is-pin' : ''),
        onclick: () => openNote(n.id),
      }, [
        el('div', { class: 'memo-item__t' }, [
          n.pinned ? el('span', { class: 'pin', text: '◆' }) : null,
          el('span', { text: n.title || '（无标题）' }),
        ]),
        el('div', { class: 'memo-item__p', text: (n.body || '').slice(0, 120) || '（空）' }),
        el('div', { class: 'memo-item__d', text: relTime(n.updatedAt || n.createdAt) }),
      ]);
      dom.list.append(node);
    }
  } else {
    const n = store.state.memos.items.find((x) => x.id === currentId);
    if (!n) { mode = 'list'; render(); return; }
    if (document.activeElement !== dom.title) dom.title.value = n.title || '';
    if (document.activeElement !== dom.body) dom.body.value = n.body || '';
    dom.stamp.textContent = '最后修改　' + fmtDateTime(n.updatedAt || n.createdAt);
    dom.pin.textContent = n.pinned ? '◆ 已置顶' : '◇ 置顶';
  }
}

const save = debounce(() => {
  if (mode !== 'edit' || !currentId) return;
  store.updateMemo(currentId, { title: dom.title.value, body: dom.body.value });
  dom.stamp.textContent = '最后修改　' + fmtDateTime(Date.now());
}, 500);

function openNote(id) {
  currentId = id;
  mode = 'edit';
  render();
  dom.body.focus();
}

function backToList() {
  if (mode === 'edit' && currentId) {
    store.updateMemo(currentId, { title: dom.title.value, body: dom.body.value });
    store.flushNow();   // 别等防抖，直接落盘
  }
  mode = 'list';
  currentId = null;
  render();
}

function createNote() {
  const n = store.addMemo({ title: '', body: '' });
  currentId = n.id;
  mode = 'edit';
  render();
  dom.title.focus();
}

export function toggleMemo(force) {
  const open = force != null ? force : !dom.drawer.classList.contains('is-open');
  dom.drawer.classList.toggle('is-open', open);
  document.getElementById('btn-memo').classList.toggle('is-on', open);
  if (open) render();
}

export function closeMemo() { toggleMemo(false); }

export function initMemo() {
  dom = {
    drawer: $('#drawer-memo'),
    search: $('#memo-search'),
    list: $('#memo-list'),
    editor: $('#memo-editor'),
    title: $('#memo-title'),
    body: $('#memo-body'),
    count: $('#memo-count'),
    stamp: $('#memo-stamp'),
    pin: $('#btn-memo-pin'),
  };

  $('#btn-memo').addEventListener('click', () => toggleMemo());
  $('#memo-close').addEventListener('click', () => { backToList(); closeMemo(); });
  $('#memo-new').addEventListener('click', createNote);
  $('#memo-back').addEventListener('click', backToList);

  dom.search.addEventListener('input', debounce(render, 180));
  dom.title.addEventListener('input', save);
  dom.body.addEventListener('input', save);

  dom.pin.addEventListener('click', () => {
    const n = store.state.memos.items.find((x) => x.id === currentId);
    if (!n) return;
    store.updateMemo(currentId, { pinned: !n.pinned });
    render();
  });

  $('#memo-delete').addEventListener('click', () => {
    const n = store.state.memos.items.find((x) => x.id === currentId);
    if (!n) return;
    if (!confirm('删除这条笔记？')) return;
    store.removeMemo(currentId);
    backToList();
    toast('已删除');
  });

  $('#memo-ai').addEventListener('click', async (e) => {
    const body = dom.body.value.trim();
    if (!body) { toast('先写点内容', 'err'); return; }
    const btn = e.currentTarget;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '整理中…';
    try {
      const res = await callOnce({
        system: '你是一位高中老师。请把学生随手记的零散笔记整理成条理清晰的提纲：用 Markdown，分点，保留全部事实信息，不要添加原文没有的内容。公式保持 KaTeX 写法（$...$）。不要寒暄，直接输出整理结果。',
        user: body,
        temperature: 0.3,
        maxTokens: 1400,
      });
      const out = String(res.text || '').trim();
      if (!out) throw new Error('没有返回内容');
      dom.body.value = out;
      store.updateMemo(currentId, { body: out });
      toast('已整理', 'ok');
    } catch (err) {
      toast('整理失败：' + err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  });

  render();
}

export function refreshMemo() { if (dom.drawer) render(); }
