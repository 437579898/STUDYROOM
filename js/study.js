/* ===========================================================
   study.js —— 学习界面：章节树 / 对话 / 本节要点
   =========================================================== */
import { $, $$, el, toast, fmtTime, scrollToBottom, copyText, debounce } from './util.js';
import { store } from './store.js';
import { renderInto, plainText, extractFollowups } from './render.js';
import { askTeacher, openingInstruction } from './teacher.js';
import {
  getSubject, getSectionWrap, getVolumeWrap, subjectColor,
  siblings, neighbors, subjectStats, chapterStats,
} from './subject.js';

const QUICK = [
  ['从定义讲起', '请从最基础的定义讲起，把关键概念和符号含义交代清楚。'],
  ['举个例子', '请举一个典型例子，把刚才的知识点用上。'],
  ['来个例题', '请给一道本节典型的例题，先别给答案，等我先想。'],
  ['随堂检测', '请出 3 道随堂检测题，难度递增，先只给题目。'],
  ['讲讲易错点', '这一节考试里最容易错的地方是什么？请具体说明错因。'],
  ['串一下知识', '请把本节知识用一张思维导图串起来。'],
  ['总结本节', '请用要点形式总结本节，并给出需要背下来的结论。'],
  ['我有个疑问', ''],
];

const state = {
  sectionId: null,
  streaming: false,
  abort: null,
  autoScroll: true,
};

let dom = {};
let onEnterSection = () => {};

/* ============================ 顶栏 ============================ */
function renderTopbar() {
  const w = getSectionWrap(state.sectionId);
  const bar = dom.crumbs;
  bar.innerHTML = '';
  if (!w) return;
  const dot = el('span', { class: 'subj-dot', style: { background: subjectColor(w.subject.id), color: subjectColor(w.subject.id) } });
  bar.append(
    dot,
    el('span', { class: 'crumb', text: w.subject.name }),
    el('span', { class: 'sep', text: '›' }),
    el('span', { class: 'crumb', text: w.volume.name }),
    el('span', { class: 'sep', text: '›' }),
    el('span', { class: 'crumb', text: w.chapter.name }),
    el('span', { class: 'sep', text: '›' }),
    el('span', { class: 'crumb crumb--cur', text: w.section.no + ' ' + w.section.name }),
  );
  renderProgressPill();
}

function renderProgressPill() {
  const w = getSectionWrap(state.sectionId);
  if (!w) { dom.progressPill.textContent = ''; return; }
  const cs = chapterStats(w.chapter, store.state.progress);
  const ss = subjectStats(w.subject, store.state.progress);
  dom.progressPill.innerHTML = '本章 <b>' + cs.done + '/' + cs.total + '</b>　本科 <b>' + ss.done + '/' + ss.total + '</b>';
}

/* ============================ 左栏 ============================ */
function renderLeft() {
  const w = getSectionWrap(state.sectionId);
  const box = dom.leftBody;
  box.innerHTML = '';
  if (!w) return;
  const subject = w.subject;

  const collapsed = state.collapsedVolumes || (state.collapsedVolumes = {});
  for (const vol of subject.volumes) {
    const group = el('div', { class: 'vol-group' + (collapsed[vol.id] ? ' is-closed' : '') });
    const head = el('div', { class: 'vol-group__title', onclick: () => { collapsed[vol.id] = !collapsed[vol.id]; group.classList.toggle('is-closed'); } }, [
      el('span', { class: 'caret', text: '▾' }),
      el('span', { text: vol.name }),
      el('span', { class: 'badge2', text: vol.chapters.length + ' 章' }),
    ]);
    group.append(head);

    const list = el('div', { class: 'vol-group__list' });
    for (const chap of vol.chapters) {
      const block = el('div', { class: 'chap-block' });
      block.append(el('div', { class: 'chap-block__title', text: chap.no + ' ' + chap.name }));
      for (const sec of chap.sections) {
        const p = store.progressOf(sec.id);
        const mark = p.status === 'done' ? '✓' : (p.status === 'studying' ? '·' : '');
        block.append(el('button', {
          class: 'sec-link' + (sec.id === state.sectionId ? ' is-on' : ''),
          onclick: () => onEnterSection(sec.id),
        }, [
          el('span', { class: 'no', text: sec.no }),
          el('span', { class: 'nm', text: sec.name }),
          el('span', { class: 'mk', text: mark, dataset: { s: p.status } }),
        ]));
      }
      list.append(block);
    }
    group.append(list);
    box.append(group);
  }

  // 把当前节滚到视野内
  const cur = box.querySelector('.sec-link.is-on');
  if (cur) setTimeout(() => cur.scrollIntoView({ block: 'center' }), 60);
}

/* ============================ 右栏 ============================ */
function renderRight() {
  const w = getSectionWrap(state.sectionId);
  const box = dom.rightBody;
  box.innerHTML = '';
  if (!w) return;

  // 本章纲要
  const outline = el('div', { class: 'side-card' });
  outline.append(el('div', { class: 'side-card__t', text: '本 章 纲 要' }));
  const ol = el('div');
  for (const sec of w.chapter.sections) {
    ol.append(el('button', {
      class: 'outline-item' + (sec.id === state.sectionId ? ' is-cur' : ''),
      onclick: () => onEnterSection(sec.id),
      style: { width: '100%', textAlign: 'left', background: sec.id === state.sectionId ? 'rgba(232,207,140,.14)' : 'transparent' },
    }, [
      el('span', { class: 'dot' }),
      el('span', { text: sec.no + '　' + sec.name }),
    ]));
  }
  outline.append(ol);
  box.append(outline);

  // 学习统计
  const cs = chapterStats(w.chapter, store.state.progress);
  const ss = subjectStats(w.subject, store.state.progress);
  const p = store.progressOf(state.sectionId);
  const stat = el('div', { class: 'side-card' });
  stat.append(el('div', { class: 'side-card__t', text: '学 习 进 度' }));
  stat.append(el('div', { class: 'stat-row' }, [el('span', { text: '本节已进入' }), el('b', { text: (p.visits || 0) + ' 次' })]));
  stat.append(el('div', { class: 'stat-row' }, [el('span', { text: '本章完成' }), el('b', { text: cs.done + '/' + cs.total })]));
  stat.append(el('div', { class: 'bar' }, [el('i', { style: { width: Math.round(cs.rate * 100) + '%' } })]));
  stat.append(el('div', { class: 'stat-row', style: { marginTop: '8px' } }, [el('span', { text: '本科目完成' }), el('b', { text: ss.done + '/' + ss.total })]));
  stat.append(el('div', { class: 'bar' }, [el('i', { style: { width: Math.round(ss.rate * 100) + '%' } })]));
  const doneBtn = el('button', {
    class: 'btn btn--sm',
    style: { width: '100%', marginTop: '11px', justifyContent: 'center' },
    text: p.status === 'done' ? '✓ 已标记为学完' : '标记本节为「已学完」',
    onclick: () => {
      const isDone = store.progressOf(state.sectionId).status === 'done';
      store.markDone(state.sectionId, !isDone);
      toast(isDone ? '已取消标记' : '已标记学完，先生会记着这笔账', 'ok');
      renderRight(); renderProgressPill(); renderLeft(); onRefreshBook && onRefreshBook();
    },
  });
  stat.append(doneBtn);
  box.append(stat);

  // 快捷问法
  const ask = el('div', { class: 'side-card' });
  ask.append(el('div', { class: 'side-card__t', text: '可 以 这 样 问' }));
  const al = el('div', { class: 'ask-list' });
  for (const q of [
    '这一节和上一节有什么关系？',
    '这个结论的适用条件是什么？',
    '如果条件不成立会怎样？',
    '考试里这节一般怎么考？',
    '我上节课的内容有点忘了，帮我复习一下。',
  ]) {
    al.append(el('button', { class: 'ask-btn', text: q, onclick: () => send(q) }));
  }
  ask.append(al);
  box.append(ask);

  // 相邻节
  const nb = neighbors(state.sectionId);
  const nav = el('div', { class: 'side-card' });
  nav.append(el('div', { class: 'side-card__t', text: '上 下 一 节' }));
  const ml = el('div', { class: 'mini-list' });
  if (nb.prev) ml.append(el('button', { class: 'mini-item', onclick: () => onEnterSection(nb.prev.id) }, [el('span', { class: 'st', text: '上一节' }), el('span', { class: 'nm', text: nb.prev.name })]));
  if (nb.next) ml.append(el('button', { class: 'mini-item', onclick: () => onEnterSection(nb.next.id) }, [el('span', { class: 'st', text: '下一节' }), el('span', { class: 'nm', text: nb.next.name })]));
  nav.append(ml);
  box.append(nav);
}

let onRefreshBook = null;

/* ============================ 对话 ============================ */
function chatHero() {
  const w = getSectionWrap(state.sectionId);
  if (!w) return null;
  return el('div', { class: 'chat-hero' }, [
    el('div', { class: 'kicker', text: w.subject.name + ' · ' + w.volume.name + ' · ' + w.chapter.no }),
    el('h2', { text: w.section.name }),
    el('div', { class: 'sub', text: w.section.no + '　·　先生已就位' }),
  ]);
}

function messageNode(msg) {
  const isUser = msg.role === 'user';
  if (msg.hidden) return null;

  const bubble = el('div', { class: 'msg__bubble' });
  if (msg.pending) {
    bubble.append(el('div', { class: 'msg__waiting' }, [el('span', { class: 'spinner' }), el('span', { text: '先生正在斟酌…' })]));
  } else if (msg.error) {
    bubble.append(el('div', { text: msg.content }));
    if (msg.hint) bubble.append(el('div', { style: { marginTop: '8px', fontSize: '12.5px', opacity: '.85' }, text: msg.hint }));
  } else {
    renderInto(bubble, msg.content);
  }

  const main = el('div', { class: 'msg__main' });
  main.append(el('div', { class: 'msg__name' }, [
    el('span', { text: isUser ? '你' : '先生' }),
    el('span', { class: 'msg__time', text: fmtTime(msg.ts || Date.now()) }),
  ]));

  // 思考过程：默认折叠，想看点开。这样既不再"凭空出现又消失"，也不干扰正文。
  if (!isUser && msg.thinking && !msg.pending && !msg.error) {
    const det = el('details', { class: 'msg__think' });
    det.append(el('summary', {
      text: '思考过程' + (msg.thinkingCut ? '（原文 ' + msg.thinkingCut + ' 字，仅保留前 6000 字）' : '（' + msg.thinking.length + ' 字）'),
    }));
    det.append(el('div', { class: 'msg__think-body', text: msg.thinking }));
    main.append(det);
  }

  main.append(bubble);

  // 操作条
  const actions = el('div', { class: 'msg__actions' });
  if (!msg.pending && !msg.error) {
    actions.append(el('button', { class: 'btn btn--sm', text: '复制', onclick: () => copyText(msg.content) }));
    if (!isUser) {
      actions.append(el('button', {
        class: 'btn btn--sm', text: '收录错题',
        onclick: () => onCollect(msg),
      }));
      actions.append(el('button', {
        class: 'btn btn--sm', text: '继续展开',
        onclick: () => send('请把这一点再展开讲一些，我还没完全理解。'),
      }));
    }
    actions.append(el('button', {
      class: 'btn btn--sm btn--danger', text: '删除',
      onclick: () => { store.deleteMessage(state.sectionId, msg.id); renderChat(); },
    }));
  }
  main.append(actions);

  // 追问按钮
  const fus = extractFollowups(msg.content);
  if (fus.length && !msg.pending) {
    const box = el('div', { class: 'followups' });
    for (const q of fus) box.append(el('button', { class: 'followup', text: q, onclick: () => send(q) }));
    main.append(box);
  }

  return el('div', { class: 'msg ' + (isUser ? 'msg--user' : 'msg--teacher') + (msg.error ? ' msg--error' : ''), dataset: { mid: msg.id } }, [
    el('div', { class: 'msg__avatar', text: isUser ? '我' : '师' }),
    main,
  ]);
}

function renderChat() {
  const box = dom.messages;
  if (!box) return;
  box.innerHTML = '';
  if (!state.sectionId) return;
  const hero = chatHero();
  if (hero) box.append(hero);

  const chat = store.chatOf(state.sectionId);
  const visible = chat.messages.filter((m) => !m.hidden);
  if (!visible.length && !state.streaming) {
    box.append(el('div', { class: 'empty' }, [el('span', { class: 'big', text: '卷' }), el('div', { text: '先生正在翻开课本…' })]));
  }
  for (const m of chat.messages) {
    const n = messageNode(m);
    if (n) box.append(n);
  }
  requestAnimationFrame(() => { const s = dom.scroll; s.scrollTop = s.scrollHeight; });
}

/* ---------------------------- 发送 ---------------------------- */
async function send(text) {
  if (state.streaming) { toast('先生还在讲，先等等', ''); return; }
  const t = String(text || '').trim();
  if (!t) return;
  store.pushMessage(state.sectionId, { role: 'user', content: t });
  renderChat();
  await runTeacher();
}

async function runTeacher(opts = {}) {
  const sectionId = state.sectionId;
  const chat = store.chatOf(sectionId);
  const pendingMsg = store.pushMessage(sectionId, { role: 'assistant', content: '', pending: true });
  renderChat();

  state.streaming = true;
  state.abort = new AbortController();
  setComposerBusy(true);

  const liveBubble = () => {
    const node = dom.messages.querySelector('[data-mid="' + pendingMsg.id + '"] .msg__bubble');
    return node;
  };

  let acc = '';
  let think = '';
  let paintTimer = 0;
  let lastPaint = 0;

  const doPaint = () => {
    const b = liveBubble();
    if (!b) return;
    b.classList.add('is-streaming');
    b.innerHTML = '';

    if (!acc) {
      // 正文还没开始：只给一个干净的等待提示。
      // 注意不要把 reasoning_content 原文倒进气泡 —— 那是模型的草稿，不是讲给学生听的话，
      // 而且流式结束重绘时它又会消失，看起来像闪烁出错。
      b.append(el('div', { class: 'msg__waiting' }, [
        el('span', { class: 'spinner' }),
        el('span', { text: think ? '先生正在推敲…' : '先生正在读题…' }),
      ]));
      if (think) b.append(el('div', { class: 'msg__hint', text: '已经想了 ' + think.length + ' 字' }));
    } else {
      const body = el('div');
      renderInto(body, acc);
      b.append(body);
    }

    if (state.autoScroll) dom.scroll.scrollTop = dom.scroll.scrollHeight;
  };
  const paint = () => {
    if (paintTimer) return;
    const wait = Math.max(0, 90 - (performance.now() - lastPaint));
    paintTimer = setTimeout(() => {
      paintTimer = 0;
      lastPaint = performance.now();
      doPaint();
    }, wait);
  };

  try {
    const historyForApi = chat.messages.filter((m) => m.id !== pendingMsg.id);
    const res = await askTeacher({
      sectionId,
      history: historyForApi,
      text: null,
      signal: state.abort.signal,
      onDelta: (_d, full) => { acc = full; paint(); },
      onThink: (t) => { think = t; paint(); },
    });
    acc = res.text || acc;
    const THINK_CAP = 6000;
    store.updateMessage(sectionId, pendingMsg.id, {
      content: acc,
      pending: false,
      thinking: think ? think.slice(0, THINK_CAP) : undefined,
      thinkingCut: think.length > THINK_CAP ? think.length : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      store.updateMessage(sectionId, pendingMsg.id, { content: acc || '（已停止）', pending: false, stopped: true });
    } else {
      const noKey = e.status === 400 && /NO_API_KEY|API Key/.test(String(e.message));
      store.updateMessage(sectionId, pendingMsg.id, {
        content: '**连接不上模型服务。**\n\n' + String(e.message || e),
        pending: false, error: true,
        hint: noKey
          ? '点屏幕右下角的齿轮按钮，填入你的 DeepSeek API Key 后重试。'
          : '检查网络，或点右下角齿轮确认 API 地址 / 模型名是否正确。',
      });
    }
  } finally {
    if (paintTimer) { clearTimeout(paintTimer); paintTimer = 0; }
    state.streaming = false;
    state.abort = null;
    setComposerBusy(false);
    renderChat();
  }
}

function setComposerBusy(busy) {
  dom.send.disabled = false;
  dom.send.classList.toggle('is-stop', busy);
  dom.send.textContent = busy ? '■' : '➤';
  dom.send.title = busy ? '停止生成' : '发送';
  dom.input.disabled = false;
}

function stopStreaming() {
  if (state.abort) { try { state.abort.abort(); } catch { /* ignore */ } }
}

/* ---------------------------- 首次进入自动开讲 ---------------------------- */
async function ensureOpening() {
  const chat = store.chatOf(state.sectionId);
  if (chat.messages.some((m) => !m.hidden && m.role === 'assistant')) return;
  store.pushMessage(state.sectionId, { role: 'user', content: openingInstruction(state.sectionId), hidden: true });
  await runTeacher({ opening: true });
}

/* ============================ 对外 ============================ */
export function initStudy(opts = {}) {
  onEnterSection = opts.onEnterSection || (() => {});
  onCollect = opts.onCollect || (() => {});
  onRefreshBook = opts.onRefreshBook || null;

  dom = {
    crumbs: $('#crumbs'),
    progressPill: $('#progress-pill'),
    leftBody: $('#pane-left-body'),
    rightBody: $('#pane-right-body'),
    scroll: $('#chat-scroll'),
    messages: $('#messages'),
    input: $('#composer-input'),
    send: $('#btn-send'),
    main: $('#study-main'),
    jump: $('#jump-bottom'),
  };

  // 快捷指令
  const qr = $('#quick-row');
  for (const [label, text] of QUICK) {
    qr.append(el('button', {
      class: 'chip', text: label,
      onclick: () => { if (text) send(text); else dom.input.focus(); },
    }));
  }

  dom.send.addEventListener('click', () => {
    if (state.streaming) { stopStreaming(); return; }
    const v = dom.input.value;
    dom.input.value = '';
    dom.input.style.height = 'auto';
    send(v);
  });

  dom.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const v = dom.input.value;
      dom.input.value = '';
      autoGrow();
      send(v);
    }
  });
  dom.input.addEventListener('input', autoGrow);

  function autoGrow() {
    dom.input.style.height = 'auto';
    dom.input.style.height = Math.min(190, dom.input.scrollHeight) + 'px';
  }

  dom.scroll.addEventListener('scroll', () => {
    const near = dom.scroll.scrollHeight - dom.scroll.scrollTop - dom.scroll.clientHeight < 90;
    state.autoScroll = near;
    dom.jump.classList.toggle('is-on', !near);
  });
  dom.jump.addEventListener('click', () => { state.autoScroll = true; scrollToBottom(dom.scroll); dom.jump.classList.remove('is-on'); });

  // 侧栏开关
  $('#btn-toggle-left').addEventListener('click', (e) => {
    const on = dom.main.classList.toggle('no-left');
    e.currentTarget.classList.toggle('is-on', !on);
    store.setPref('leftOpen', !on);
  });
  $('#btn-toggle-right').addEventListener('click', (e) => {
    const on = dom.main.classList.toggle('no-right');
    e.currentTarget.classList.toggle('is-on', !on);
    store.setPref('rightOpen', !on);
  });
  $('#btn-clear-chat').addEventListener('click', () => {
    if (state.streaming) return;
    if (!confirm('清空本节的对话记录？错题本和进度不受影响。')) return;
    store.clearChat(state.sectionId);
    renderChat();
    toast('本节对话已清空');
    ensureOpening();
  });

  // 恢复侧栏状态
  if (store.state.prefs.leftOpen === false) { dom.main.classList.add('no-left'); $('#btn-toggle-left').classList.remove('is-on'); }
  if (store.state.prefs.rightOpen === false) { dom.main.classList.add('no-right'); $('#btn-toggle-right').classList.remove('is-on'); }

  renderChat();
}

let onCollect = () => {};

export async function openSection(sectionId, { silent = false } = {}) {
  state.sectionId = sectionId;
  store.setPref('lastSection', sectionId);
  store.markStudying(sectionId);
  renderTopbar();
  renderLeft();
  renderRight();
  renderChat();

  const chat = store.chatOf(sectionId);
  const hasVisible = chat.messages.some((m) => !m.hidden);
  if (!hasVisible && !silent) {
    await ensureOpening();
  }
}

export function currentSection() { return state.sectionId; }
export function collectFromMessage(msg) { onCollect(msg); }
export function sendToTeacher(text) { return send(text); }
