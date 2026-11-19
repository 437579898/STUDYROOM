/* ===========================================================
   assistant.js —— 复习助手（能看到全部学习记录的那个对话助手）
   学生的问题不是「这道题怎么做」，而是「我好像学过、但想不起来在哪」。
   所以这里的做法不是再开一个聊天窗口，而是：
     1. 把 state 里的**全部**记录（每节课的对话、错题本、备忘录、进度）摊平成档案；
     2. 按问题做关键词检索，挑出相关片段 + 最近的记录，拼成上下文；
     3. 让模型**只根据这些记录**回答，并标出处（科目 · 章 · 节 + 日期）；
     4. 回答下面列出被引用的章节，点一下直接跳过去。
   纯本地检索 + api.chat 现成的双模式通道，没有新增服务端接口。
   =========================================================== */
import { $, el, toast, relTime, fmtDate } from './util.js';
import { store } from './store.js';
import { getSectionWrap, sectionRef } from './subject.js';
import { renderInto } from './render.js';
import { api } from './api.js';
import { openModal, closeModal } from './overlay.js';

const TOP_K = 10;              // 送给模型的相关片段条数
const EXCERPT = 700;           // 每条片段最多保留字数
const OPENING_TAG = '（学生刚刚打开';   // 开场指令不是学习记录，不进档案

/* ===================== 档案：把 state 摊平成一条条记录 ===================== */

/** 某一节的规范称呼：数学 · 第1册 · 1.2 集合间的基本关系 */
export function sectionLabel(sectionId) {
  const w = getSectionWrap(sectionId);
  if (!w) return String(sectionId || '未知章节');
  return w.subject.name + ' · ' + w.volume.name + ' · ' + sectionRef(w.section);
}

function clean(text) {
  let s = String(text || '');
  s = s.replace(/\r/g, '');
  s = s.replace(/^（学生刚刚打开[\s\S]*$/m, '');   // 开场指令整段不要
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** 摊平所有对话 —— 这是「能看到全部记录」的数据来源 */
export function buildArchive(state) {
  const out = [];
  const chats = (state && state.chats) || {};
  for (const [sid, chat] of Object.entries(chats)) {
    const msgs = (chat && chat.messages) || [];
    const label = sectionLabel(sid);
    for (const m of msgs) {
      const text = clean(m && m.content);
      if (!text) continue;
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      out.push({
        sid,
        label,
        role: m.role,
        text,
        ts: Number(m.ts) || Number(chat.updatedAt) || 0,
      });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/* ===================== 检索：中文没有空格，按 2~3 字切片 ===================== */

export function tokenize(q) {
  const s = String(q || '').toLowerCase();
  const tokens = new Set();
  // 连续的汉字串切成相邻 2 字、3 字组合
  for (const run of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= run.length; i++) tokens.add(run.slice(i, i + n));
    }
    if (run.length === 1) tokens.add(run);
  }
  // 英文 / 数字 / 公式里的符号
  for (const w of s.match(/[a-z0-9_+\-=^.]{2,}/g) || []) tokens.add(w);
  // 去掉"我上次学到哪"这类高频虚词组合，避免全库命中
  const stop = new Set(['上次', '一下', '什么', '怎么', '哪个', '哪些', '记不', '忘了', '学过', '节课']);
  for (const w of Array.from(tokens)) if (stop.has(w)) tokens.delete(w);
  return Array.from(tokens);
}

function countOf(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j < 0) break;
    n++; i = j + needle.length;
    if (n > 4) break;          // 一条记录里重复出现，收益递减
  }
  return n;
}

export function scoreItem(item, tokens) {
  if (!tokens.length) return 0;
  const body = item.text.toLowerCase();
  const head = item.label.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    const inBody = countOf(body, t);
    const inHead = countOf(head, t);
    score += inBody * (t.length >= 3 ? 1.6 : 1) + inHead * 3;
  }
  if (item.role === 'assistant') score *= 0.9;   // 先生的讲解通常很长，权重略降
  return score;
}

/** 选出相关记录：先按分数取前 K，再按时间排回去（模型更容易连成"先后"） */
export function pickRelevant(archive, question, k = TOP_K) {
  const tokens = tokenize(question);
  const scored = archive
    .map((it) => ({ it, score: scoreItem(it, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.it);

  // 最近 3 条无条件带上：学生问"上次学到哪"时，检索命中率靠它兜底
  const recent = archive.slice(-3);
  const seen = new Set();
  const merged = [];
  for (const it of scored.concat(recent)) {
    const key = it.ts + '|' + it.sid + '|' + it.text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(it);
  }
  merged.sort((a, b) => a.ts - b.ts);
  return merged;
}

/* ===================== 概览 + 上下文 ===================== */

function dayOf(ts) {
  if (!ts) return '日期不明';
  return fmtDate(ts);
}

export function buildOverview(state) {
  const progress = (state && state.progress) || {};
  const entries = Object.entries(progress)
    .map(([sid, p]) => ({ sid, ...(p || {}) }))
    .filter((x) => x.status && x.status !== 'new')
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const done = entries.filter((x) => x.status === 'done').length;
  const wrong = ((state && state.wrongbook && state.wrongbook.items) || []);
  const memos = ((state && state.memos && state.memos.items) || []);
  const lines = [];
  lines.push('- 学过的节：' + entries.length + ' 节（已完成 ' + done + ' 节，进行中 ' + (entries.length - done) + ' 节）');
  if (entries.length) {
    const last = entries[0];
    lines.push('- 最近一次打开：' + sectionLabel(last.sid) + '（' + relTime(last.lastAt || 0) + '）');
    lines.push('- 最近学过：' + entries.slice(0, 6).map((x) => sectionLabel(x.sid).replace(/^.*?· /, '') + '（' + relTime(x.lastAt || 0) + '）').join('；'));
  } else {
    lines.push('- 还没有学习记录');
  }
  lines.push('- 错题本：' + wrong.length + ' 题' + (wrong.length ? '，未掌握 ' + wrong.filter((w) => w.status !== 'mastered').length + ' 题' : ''));
  if (wrong.length) {
    lines.push('- 最近的错题：' + wrong.slice(0, 4).map((w) => '「' + String(w.question || '').replace(/\s+/g, ' ').slice(0, 28) + '…」').join('；'));
  }
  lines.push('- 备忘录：' + memos.length + ' 条' + (memos.length ? '，最近：' + memos.slice(0, 3).map((n) => n.title || String(n.body || '').slice(0, 16) || '（无标题）').join('；') : ''));
  return lines.join('\n');
}

export function buildContext(state, question) {
  const archive = buildArchive(state);
  const picked = pickRelevant(archive, question);
  const parts = [];
  parts.push('【档案概览】');
  parts.push(buildOverview(state));
  parts.push('');
  parts.push('【与问题相关的记录】（来自真实对话，按时间先后）');
  if (!picked.length) {
    parts.push('（没有任何对话记录）');
  } else {
    for (const it of picked) {
      const body = it.text.length > EXCERPT ? it.text.slice(0, EXCERPT) + '…（后略）' : it.text;
      parts.push('[' + dayOf(it.ts) + '] ' + it.label + ' · ' + (it.role === 'user' ? '学生' : '先生') + '：');
      parts.push(body);
      parts.push('');
    }
  }
  if (question) {
    const tokens = tokenize(question);
    if (!picked.length || !tokens.length) {
      parts.push('（检索没有命中：请如实告诉学生「记录里没有」，并告诉他最近学过什么）');
    }
  }
  return { context: parts.join('\n'), picked, archive };
}

export const SYSTEM_PROMPT = [
  '你是「书房助教」，这名高中学生的私人复习助手。',
  '你能看到他在「高中学习书房」里的全部记录：每一节课和先生的对话、错题本、备忘录、学习进度。',
  '',
  '回答规则：',
  '1. 只依据下面给出的【档案概览】和【与问题相关的记录】回答。记录里没有的，直接说「记录里没有」，不要编造章节、日期、题目或结论。',
  '2. 引用必须给出处：科目 · 册 · 节（有日期就带日期）。可以引用原话，过长就截断并写「…」。',
  '3. 先给一句直接结论，再给要点。整段控制在 200 字左右，能列清单就列清单，不要复述整堂课。',
  '4. 学生最常见的三种问法是：上次学到哪 / 这块我到底学过没有 / 把最近的错题和笔记串一下。前两种要直接给位置和时间，第三种要给「先后顺序 + 你现在最该补的那个点」。',
  '5. 用中文，语气像同桌，不要「同学你好」「希望对你有帮助」这类客套。',
].join('\n');

/** 组装发给模型的 messages（含本窗口前几轮，保持指代） */
export function buildMessages(state, question, thread) {
  const { context, picked } = buildContext(state, question);
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }];
  const history = (thread || []).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-6);
  for (const m of history) msgs.push({ role: m.role, content: String(m.content || '').slice(0, 1500) });
  msgs.push({ role: 'user', content: '【学习记录】\n' + context + '\n\n【学生的问题】\n' + question });
  return { messages: msgs, picked };
}

/* ===================== 界面 ===================== */

let ui = null;
let busy = false;
let abortCtl = null;
let onPickSection = null;

const QUICK = [
  '我上次学到哪了？',
  '这周学了些什么？',
  '把最近的错题串一遍，我该补哪个点？',
  '向量那一块我到底学到哪一节了？',
];

function thread() {
  if (!store.state.assistant) store.state.assistant = { messages: [] };
  if (!Array.isArray(store.state.assistant.messages)) store.state.assistant.messages = [];
  return store.state.assistant.messages;
}

function pushMsg(msg) {
  const full = Object.assign({ id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now() }, msg);
  thread().push(full);
  store.touch({ type: 'assistant' });
  return full;
}

function citeChips(cites) {
  if (!cites || !cites.length) return null;
  const wrap = el('div', { class: 'asst-cites' });
  wrap.append(el('span', { class: 'asst-cites__label', text: '参考记录' }));
  const seen = new Set();
  for (const c of cites) {
    if (seen.has(c.sid)) continue;
    seen.add(c.sid);
    wrap.append(el('button', {
      class: 'asst-cite',
      title: '打开这一节',
      text: c.label,
      onclick: () => {
        closeAssistant();
        if (onPickSection) onPickSection(c.sid);
      },
    }));
  }
  return wrap;
}

function messageNode(m) {
  const box = el('div', { class: 'asst-msg asst-msg--' + (m.role === 'user' ? 'me' : 'ai'), dataset: { mid: m.id } });
  box.append(el('div', { class: 'asst-msg__who', text: m.role === 'user' ? '我' : '书房助教' }));
  const bubble = el('div', { class: 'asst-msg__bubble' });
  if (m.pending && !m.content) {
    bubble.append(el('div', { class: 'asst-waiting' }, [el('span', { class: 'spinner' }), el('span', { text: '正在翻你的记录…' })]));
  } else if (m.role === 'assistant') {
    renderInto(bubble, m.content || '');
  } else {
    bubble.textContent = m.content || '';
  }
  box.append(bubble);
  if (m.role === 'assistant' && m.cites && m.cites.length) box.append(citeChips(m.cites));
  return box;
}

function archiveCard() {
  const state = store.state;
  const archive = buildArchive(state);
  const sections = Object.keys((state && state.chats) || {}).filter((sid) => {
    const c = state.chats[sid];
    return c && (c.messages || []).some((m) => clean(m.content));
  });
  const card = el('div', { class: 'asst-card' });
  card.append(el('div', { class: 'asst-card__title', text: '我手上的记录' }));
  card.append(el('div', { class: 'asst-card__row' }, [
    el('b', { text: String(sections.length) }), el('span', { text: ' 节课有对话' }),
    el('i', { text: '·' }),
    el('b', { text: String(archive.length) }), el('span', { text: ' 条消息' }),
  ]));
  const progress = (state && state.progress) || {};
  const studied = Object.entries(progress).filter(([, p]) => p && p.status && p.status !== 'new').length;
  card.append(el('div', { class: 'asst-card__row' }, [
    el('b', { text: String(studied) }), el('span', { text: ' 节有进度' }),
    el('i', { text: '·' }),
    el('b', { text: String(((state.wrongbook && state.wrongbook.items) || []).length) }), el('span', { text: ' 道错题' }),
    el('i', { text: '·' }),
    el('b', { text: String(((state.memos && state.memos.items) || []).length) }), el('span', { text: ' 条备忘录' }),
  ]));
  const recent = archive.slice(-1)[0];
  card.append(el('div', { class: 'asst-card__hint', text: recent ? ('最近一条记录：' + relTime(recent.ts) + ' · ' + recent.label) : '还没有记录，先去上一节课吧' }));
  const chips = el('div', { class: 'asst-quick' });
  for (const q of QUICK) chips.append(el('button', { class: 'chip', text: q, onclick: () => ask(q) }));
  card.append(chips);
  return card;
}

function renderThread() {
  if (!ui) return;
  const list = ui.list;
  list.innerHTML = '';
  const msgs = thread();
  if (!msgs.length) { list.append(archiveCard()); return; }
  for (const m of msgs) list.append(messageNode(m));
  list.scrollTop = list.scrollHeight;
}

function setBusy(v) {
  busy = v;
  if (!ui) return;
  ui.send.disabled = v;
  ui.input.disabled = v;
  ui.send.classList.toggle('is-busy', v);
  ui.foot.textContent = v ? '正在检索记录并整理…' : '只依据你的学习记录回答，出处可点开';
}

async function ask(question) {
  const q = String(question || '').trim();
  if (!q || busy) return;
  closeArchiveCardOnly();
  pushMsg({ role: 'user', content: q });
  const pending = pushMsg({ role: 'assistant', content: '', pending: true, cites: [] });
  renderThread();
  ui.input.value = '';
  setBusy(true);
  abortCtl = new AbortController();

  let acc = '';
  let paintAt = 0;
  const paint = (force) => {
    if (!force && performance.now() - paintAt < 160) return;
    paintAt = performance.now();
    const node = ui.list.querySelector('[data-mid="' + pending.id + '"] .asst-msg__bubble');
    if (node) { node.innerHTML = ''; renderInto(node, acc); ui.list.scrollTop = ui.list.scrollHeight; }
  };

  try {
    const built = buildMessages(store.state, q, thread().filter((m) => m.id !== pending.id));
    const res = await api.chat({
      messages: built.messages,
      temperature: 0.4,
      maxTokens: 1200,
      signal: abortCtl.signal,
      onDelta: (_d, full) => { acc = full; paint(false); },
    });
    acc = res.text || acc;
    if (!acc.trim()) {
      acc = res.upstreamError ? '（这次没拿到回复：' + res.upstreamError + '）' : '（这次没拿到回复，再问一次试试）';
    }
    const cites = [];
    for (const it of built.picked) {
      if (!cites.some((c) => c.sid === it.sid)) cites.push({ sid: it.sid, label: it.label });
    }
    store.updateAssistantMessage(pending.id, { content: acc, pending: false, cites });
    renderThread();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      store.updateAssistantMessage(pending.id, { content: acc || '（已取消）', pending: false });
    } else {
      const msg = (e && e.message) || '请求失败';
      store.updateAssistantMessage(pending.id, {
        content: '**没能问到。** ' + msg + (e && e.needCode ? '\n\n（这台设备还没通过访问口令，先在锁屏里输入口令）' : ''),
        pending: false,
      });
    }
    renderThread();
  } finally {
    setBusy(false);
    abortCtl = null;
  }
}

function closeArchiveCardOnly() {
  const card = ui && ui.list.querySelector('.asst-card');
  if (card) card.remove();
}

export function initAssistant(opts = {}) {
  onPickSection = opts.onPickSection || null;
  const modal = $('#modal-assistant');
  if (!modal) return;

  const list = $('#asst-list');
  const input = $('#asst-input');
  const send = $('#asst-send');
  const foot = $('#asst-foot');
  ui = { modal, list, input, send, foot };

  const submit = () => ask(input.value);
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  input.addEventListener('focus', () => { if (input.value === '' && !thread().length) renderThread(); });

  $('#asst-clear').addEventListener('click', () => {
    if (!thread().length) return;
    store.clearAssistant();
    renderThread();
    toast('已清空助手的对话（学习记录本身不动）', '');
  });
  $('#asst-close').addEventListener('click', () => closeAssistant());

  const btn = $('#btn-assistant');
  if (btn) btn.addEventListener('click', () => toggleAssistant());

  store.on((evt) => {
    if (evt.type === 'assistant' && busy) return;   // 流式期间由 ask 自己刷
    if (evt.type === 'assistant' && modal.classList.contains('is-open')) renderThread();
  });
}

export function openAssistant() {
  const modal = $('#modal-assistant');
  if (!modal) return;
  openModal('modal-assistant');
  renderThread();
  setTimeout(() => { if (ui) ui.input.focus(); }, 60);
}

export function closeAssistant() {
  const modal = $('#modal-assistant');
  if (!modal) return;
  closeModal('modal-assistant');
  if (abortCtl) { try { abortCtl.abort(); } catch { /* ignore */ } }
}

export function toggleAssistant(force) {
  const modal = $('#modal-assistant');
  if (!modal) return false;
  const want = typeof force === 'boolean' ? force : !modal.classList.contains('is-open');
  if (want) openAssistant(); else closeAssistant();
  return want;
}

export function assistantBusy() { return busy; }
