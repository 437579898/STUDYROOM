/* ===========================================================
   wrongbook.js —— 错题本（左上角方形图标）
   收录 / 自动打标签 / 变式再练 / 批改 / 掌握状态
   =========================================================== */
import { $, el, toast, fmtDate, relTime, debounce, uid } from './util.js';
import { store } from './store.js';
import { renderInto, plainText } from './render.js';
import { callOnce, briefPersona } from './teacher.js';
import { getSectionWrap, getSubject, subjects } from './subject.js';
import { openModal, closeModal } from './overlay.js';
import { isStandalone } from './runtime.js';

const state = {
  subject: 'all',
  status: 'all',
  q: '',
  editingId: null,
  busy: false,
};

let dom = {};

/* ---------------------------- 列表 ---------------------------- */
function filtered() {
  let items = store.state.wrongbook.items.slice();
  if (state.subject !== 'all') items = items.filter((it) => it.subjectId === state.subject);
  if (state.status !== 'all') items = items.filter((it) => (it.status || 'new') === state.status);
  if (state.q) {
    const q = state.q.toLowerCase();
    items = items.filter((it) => [it.question, it.analysis, it.mine, it.right, (it.tags || []).join(' '), it.sectionLabel]
      .join(' ').toLowerCase().includes(q));
  }
  return items;
}

function renderTools() {
  const box = dom.tools;
  box.innerHTML = '';

  const r1 = el('div', { class: 'filter-row' }, [el('span', { class: 'lb', text: '学科' })]);
  const mk = (label, val, cur, onPick) => el('button', {
    class: 'chip' + (cur === val ? ' is-on' : ''), text: label, onclick: onPick,
  });
  r1.append(mk('全部', 'all', state.subject, () => { state.subject = 'all'; render(); }));
  for (const s of subjects()) r1.append(mk(s.name, s.id, state.subject, () => { state.subject = s.id; render(); }));
  box.append(r1);

  const r2 = el('div', { class: 'filter-row' }, [el('span', { class: 'lb', text: '状态' })]);
  for (const [label, val] of [['全部', 'all'], ['未掌握', 'new'], ['复习中', 'review'], ['已掌握', 'mastered']]) {
    r2.append(mk(label, val, state.status, () => { state.status = val; render(); }));
  }
  const search = el('input', { class: 'input', placeholder: '搜索题目 / 知识点', style: { maxWidth: '150px', marginLeft: 'auto', padding: '5px 9px', fontSize: '12.5px' } });
  search.value = state.q;
  search.addEventListener('input', debounce(() => { state.q = search.value.trim(); renderList(); }, 220));
  r2.append(search);
  box.append(r2);
}

function renderList() {
  const items = filtered();
  dom.count.textContent = items.length + ' / ' + store.state.wrongbook.items.length + ' 题';
  const box = dom.list;
  box.innerHTML = '';

  if (!items.length) {
    box.append(el('div', { class: 'empty' }, [
      el('span', { big: true, class: 'big', text: '□' }),
      el('div', { text: store.state.wrongbook.items.length ? '没有符合筛选条件的错题' : '错题本还是空的' }),
      el('div', { style: { fontSize: '12px', marginTop: '6px' }, text: '上课时点先生消息下面的「收录错题」，或点下面的按钮手动记一道。' }),
    ]));
    box.append(el('button', { class: 'btn', style: { width: '100%', justifyContent: 'center' }, text: '＋ 手动记一道错题', onclick: () => openCollect(null) }));
    return;
  }

  for (const it of items) box.append(card(it));
}

function statusLabel(s) {
  return s === 'mastered' ? '已掌握' : (s === 'review' ? '复习中' : '未掌握');
}

function card(it) {
  const node = el('div', { class: 'wb-card', dataset: { subject: it.subjectId || '', status: it.status || 'new' } });

  const head = el('div', { class: 'wb-card__head' });
  const subj = it.subjectId ? getSubject(it.subjectId) : null;
  if (subj) head.append(el('span', { class: 'tag tag--' + subj.id, text: subj.name }));
  for (const t of (it.tags || []).slice(0, 4)) head.append(el('span', { class: 'tag', text: t }));
  head.append(el('span', { class: 'sp' }));
  head.append(el('span', { class: 'state-pill', text: statusLabel(it.status), dataset: { s: it.status || 'new' } }));
  head.append(el('span', { class: 'wb-card__src', text: relTime(it.createdAt) }));
  node.append(head);

  const body = el('div', { class: 'wb-card__body' });

  if (it.sectionLabel) {
    body.append(el('div', { class: 'wb-card__src', style: { marginBottom: '8px' }, text: '出自　' + it.sectionLabel }));
  }

  body.append(section('题目', el('div', { class: 'md', html: '' }, []), it.question, 'wb-question'));
  if (it.mine) body.append(sectionRaw('我的答案 / 错在哪', el('div', { class: 'wb-answer wb-answer--wrong md' }), it.mine));
  if (it.right) body.append(sectionRaw('正确答案', el('div', { class: 'wb-answer wb-answer--right md' }), it.right));
  if (it.analysis) body.append(sectionRaw('解析', el('div', { class: 'md' }), it.analysis));
  if (!it.right && !it.analysis) {
    body.append(el('div', { style: { fontSize: '12.5px', color: 'var(--ink-3)' }, text: '还没有答案和解析——点下面的「让先生补全」。' }));
  }

  // 变式题
  for (const v of (it.variants || [])) {
    const vn = el('div', { class: 'variant' });
    vn.append(el('div', { class: 'variant__t' }, [
      el('span', { text: '变 式 题' }),
      el('span', { style: { fontSize: '11px', color: 'var(--ink-4)', letterSpacing: '0' }, text: relTime(v.createdAt) }),
    ]));
    const q = el('div', { class: 'variant__q md' });
    renderInto(q, v.question);
    vn.append(q);

    const ta = el('textarea', { class: 'textarea', placeholder: '把你的解答写在这里，写完点「让先生批改」' });
    ta.value = v.myAnswer || '';
    vn.append(ta);

    const row = el('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } }, [
      el('button', {
        class: 'btn btn--sm btn--primary', text: '让先生批改',
        onclick: async (e) => {
          const ans = ta.value.trim();
          if (!ans) { toast('先写点东西再批改', 'err'); return; }
          const btn = e.currentTarget;
          btn.disabled = true; btn.textContent = '批改中…';
          try {
            const text = await grade(it, v, ans);
            store.updateWrong(it.id, {
              variants: (it.variants || []).map((x) => x.id === v.id ? { ...x, myAnswer: ans, feedback: text } : x),
            });
            render();
            store.flushNow();
          } catch (err) {
            toast('批改失败：' + err.message, 'err');
            btn.disabled = false; btn.textContent = '让先生批改';
          }
        },
      }),
      el('button', { class: 'btn btn--sm btn--ghost', text: '清除作答', onclick: () => { ta.value = ''; } }),
    ]);
    vn.append(row);

    if (v.feedback) {
      const fb = el('div', { class: 'variant__fb md' });
      renderInto(fb, v.feedback);
      vn.append(fb);
    }
    body.append(vn);
  }

  node.append(body);

  const foot = el('div', { class: 'wb-card__foot' });
  foot.append(el('button', {
    class: 'btn btn--sm', text: '出变式题',
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '先生出题中…';
      try {
        const q = await makeVariant(it);
        const variants = (it.variants || []).concat([{ id: uid('v'), question: q, createdAt: Date.now() }]);
        store.updateWrong(it.id, { variants, status: it.status === 'new' ? 'review' : it.status });
        render();
      } catch (err) {
        toast('出题失败：' + err.message, 'err');
        btn.disabled = false; btn.textContent = '出变式题';
      }
    },
  }));
  if (!it.right || !it.analysis) {
    foot.append(el('button', {
      class: 'btn btn--sm', text: '让先生补全',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = '解析中…';
        try {
          const filled = await fillByAI(it);
          store.updateWrong(it.id, filled);
          render();
          toast('已补全答案与解析', 'ok');
        } catch (err) {
          toast('补全失败：' + err.message, 'err');
          btn.disabled = false; btn.textContent = '让先生补全';
        }
      },
    }));
  }
  foot.append(el('span', { class: 'sp', style: { flex: '1' } }));
  foot.append(el('button', {
    class: 'btn btn--sm', text: it.status === 'mastered' ? '标记未掌握' : '标记已掌握',
    onclick: () => {
      store.updateWrong(it.id, { status: it.status === 'mastered' ? 'review' : 'mastered' });
      render(); updateBadge();
    },
  }));
  foot.append(el('button', { class: 'btn btn--sm', text: '编辑', onclick: () => openCollect(it) }));
  foot.append(el('button', {
    class: 'btn btn--sm btn--danger', text: '删除',
    onclick: () => { if (confirm('删除这道错题？')) { store.removeWrong(it.id); render(); updateBadge(); } },
  }));
  node.append(foot);

  return node;

  function section(title, node2, md, cls) {
    const wrap = el('div', { class: 'wb-card__sec' }, [el('div', { class: 'wb-card__label', text: title })]);
    const holder = el('div', { class: 'md' });
    renderInto(holder, md);
    wrap.append(holder);
    return wrap;
  }
  function sectionRaw(title, holder, md) {
    const wrap = el('div', { class: 'wb-card__sec' }, [el('div', { class: 'wb-card__label', text: title })]);
    renderInto(holder, md);
    wrap.append(holder);
    return wrap;
  }
}

function render() {
  renderTools();
  renderList();
  updateBadge();
}

export function updateBadge() {
  const n = store.wrongCount();
  const b = document.getElementById('wb-badge');
  if (b) b.textContent = n ? String(n) : '';
}

/* ---------------------------- AI 动作 ---------------------------- */
function sectionLabelOf(it) {
  if (it.sectionId) {
    const w = getSectionWrap(it.sectionId);
    if (w) return w.subject.name + ' · ' + w.volume.name + ' · ' + w.chapter.name + ' · ' + w.section.no + ' ' + w.section.name;
  }
  return '';
}

async function fillByAI(it) {
  const subj = it.subjectId ? getSubject(it.subjectId) : null;
  const sys = briefPersona(subj ? subj.name : '') + '\n' +
    '现在学生在整理错题。请从下面的材料中提取信息，严格按 JSON 输出，不要输出任何多余文字、不要用代码块包裹。\n' +
    'JSON 字段：{"question":"干净的题干","right":"正确答案","analysis":"解析（含关键步骤与易错点，可用 Markdown，公式用 KaTeX）","tags":["知识点1","知识点2","知识点3"]}\n' +
    'tags 用 2~4 个精炼的知识点名词，例如「二次函数最值」「动量守恒条件」。';
  const user = '学科：' + (subj ? subj.name : '未指定') + '\n' +
    '出处：' + (sectionLabelOf(it) || '未指定') + '\n\n' +
    '题目/材料：\n' + it.question + '\n\n' +
    '学生的作答或错因：\n' + (it.mine || '（没写）');
  const res = await callOnce({ system: sys, user, temperature: 0.2, maxTokens: 1600 });
  const txt = String(res.text || '').replace(/^\x60{3}(?:json)?/i, '').replace(/\x60{3}$/, '');
  const m = /\{[\s\S]*\}/.exec(txt);
  if (!m) throw new Error('模型没有返回可解析的内容');
  const obj = JSON.parse(m[0]);
  return {
    question: obj.question || it.question,
    right: obj.right || it.right || '',
    analysis: obj.analysis || it.analysis || '',
    tags: Array.isArray(obj.tags) ? obj.tags.slice(0, 5) : (it.tags || []),
  };
}

async function makeVariant(it) {
  const subj = it.subjectId ? getSubject(it.subjectId) : null;
  const sys = briefPersona(subj ? subj.name : '') + '\n' +
    '请基于给定错题，出一道具「同类知识点、同等难度」的变式题：更换数值或情境，但考查的核心知识点、方法与易错点保持一致。\n' +
    '只输出题目本身，不要给答案，不要写「变式题」三个字，不要任何解释或前言。公式用 KaTeX。';
  const user = '出处：' + (sectionLabelOf(it) || '未指定') + '\n' +
    '知识点：' + ((it.tags || []).join('、') || '未标注') + '\n\n' +
    '原题：\n' + it.question + '\n\n' +
    '正确答案：\n' + (it.right || '（未记录）');
  const res = await callOnce({ system: sys, user, temperature: 0.7, maxTokens: 900 });
  const q = String(res.text || '').trim();
  if (!q) throw new Error('模型没有返回题目');
  return q;
}

async function grade(it, v, answer) {
  const subj = it.subjectId ? getSubject(it.subjectId) : null;
  const sys = briefPersona(subj ? subj.name : '') + '\n' +
    '现在批改学生的作答。要求：\n' +
    '1. 先用一行给出结论：**正确** / **部分正确** / **错误**。\n' +
    '2. 再指出具体问题（概念理解、计算、表述规范各占一行，没问题的就不写）。\n' +
    '3. 最后给出规范完整解答。\n' +
    '总长 350 字以内，不要寒暄，不要说「同学你好」。';
  const user = '题目：\n' + v.question + '\n\n' +
    '参考答案：\n' + (it.right || '（未记录，请自行判断）') + '\n\n' +
    '学生的作答：\n' + answer;
  const res = await callOnce({ system: sys, user, temperature: 0.3, maxTokens: 1200 });
  return String(res.text || '').trim() || '（批改结果为空）';
}

/* ---------------------------- 收录弹窗 ---------------------------- */
export function openCollect(payload) {
  const isEdit = payload && payload.id;
  state.editingId = isEdit ? payload.id : null;
  dom.mwTitle.textContent = isEdit ? '编辑错题' : '收录错题';

  const it = isEdit ? payload : (payload || {});
  dom.mwQuestion.value = it.question || '';
  dom.mwMine.value = it.mine || '';
  dom.mwRight.value = it.right || '';
  dom.mwAnalysis.value = it.analysis || '';
  dom.mwTags.value = (it.tags || []).join('、');
  dom.mwSource.value = sectionLabelOf(it) || '未指定';
  state.pendingSource = {
    subjectId: it.subjectId || null,
    sectionId: it.sectionId || null,
    sectionLabel: it.sectionLabel || sectionLabelOf(it) || '',
  };
  openModal('modal-wrong');
}

function readForm() {
  const tags = dom.mwTags.value.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  return {
    question: dom.mwQuestion.value.trim(),
    mine: dom.mwMine.value.trim(),
    right: dom.mwRight.value.trim(),
    analysis: dom.mwAnalysis.value.trim(),
    tags,
    ...(state.pendingSource || {}),
  };
}

/* ---------------------------- 对外 ---------------------------- */
export function initWrongbook() {
  dom = {
    drawer: $('#drawer-wrongbook'),
    tools: $('#wb-tools'),
    list: $('#wb-list'),
    count: $('#wb-count'),
    mwTitle: $('#mw-title'),
    mwQuestion: $('#mw-question'),
    mwMine: $('#mw-mine'),
    mwRight: $('#mw-right'),
    mwAnalysis: $('#mw-analysis'),
    mwTags: $('#mw-tags'),
    mwSource: $('#mw-source'),
  };

  $('#btn-wrongbook').addEventListener('click', () => toggleWrongbook());
  $('#wb-close').addEventListener('click', () => closeWrongbook());
  $('#wb-add').addEventListener('click', () => openCollect(null));

  $('#mw-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const data = readForm();
    if (!data.question) { toast('题目不能为空', 'err'); return; }

    if (state.editingId) store.updateWrong(state.editingId, data);
    else store.addWrong(data);
    closeModal('modal-wrong');
    render();

    // 等服务端真的写进磁盘再报成功，避免出现「提示已保存但其实没存上」
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '写入中…';
    try {
      const ok = await store.flushNow();
      if (ok) toast(isStandalone() ? '已保存到这台设备的浏览器' : '已写入服务端 data/state.json', 'ok');
      else toast('还没保存成功：' + ((store.lastError && store.lastError.message) || '未知原因') + '（左下角可重试）', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $('#mw-ai').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const draft = readForm();
    if (!draft.question) { toast('先把题目贴进来', 'err'); return; }
    btn.disabled = true; const old = btn.textContent; btn.textContent = '先生正在看题…';
    try {
      const filled = await fillByAI(draft);
      dom.mwQuestion.value = filled.question;
      dom.mwRight.value = filled.right;
      dom.mwAnalysis.value = filled.analysis;
      dom.mwTags.value = (filled.tags || []).join('、');
      toast('已补全，检查后保存', 'ok');
    } catch (err) {
      toast('补全失败：' + err.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  });

  render();
}

export function toggleWrongbook(force) {
  const open = force != null ? force : !dom.drawer.classList.contains('is-open');
  dom.drawer.classList.toggle('is-open', open);
  document.getElementById('btn-wrongbook').classList.toggle('is-on', open);
  if (open) render();
}

export function closeWrongbook() { toggleWrongbook(false); }
export function refreshWrongbook() { if (dom.drawer) render(); }

/** 从一条消息一键收录：预填题目，自动带出出处 */
export function collectFromMessage(msg, sectionId) {
  const w = getSectionWrap(sectionId);
  openCollect({
    question: String(msg.content || '').trim(),
    subjectId: w ? w.subject.id : null,
    sectionId: sectionId || null,
  });
  toast('已带入题干，可点「让先生补全」自动解析');
}
