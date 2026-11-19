/* ===========================================================
   study.js —— 学习界面：章节树 / 对话 / 本节要点
   =========================================================== */
import { $, $$, el, toast, fmtTime, scrollToBottom, copyText, debounce } from './util.js';
import { store } from './store.js';
import { renderInto, plainText, extractFollowups, splitBlocks } from './render.js';
import { prepareShot, toDataUrl, shotsNode, MAX_SHOTS } from './shots.js';
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
  opening: false,          // 开场请求进行中，防止重复点
  msgLimit: 30,            // 当前渲染最近多少条对话
  pendingShots: [],        // 输入框里待发送的图片（已上传，存 url）
  shotBusy: 0,             // 正在压缩/上传的图片张数
  manyShotHinted: false,   // 一次发很多图时只提示一次
};

/* 本次会话里打开过的章节（只存在内存里，刷新页面即清空）。
   用来做左侧章节树的"灰色字体"状态。 */
const visitedThisSession = new Set();

/* 对话分页：一次只渲染最近这么多条 */
const MSG_PAGE = 30;

/* 由 initStudy 注入，用于在对话/流式输出期间开启「磨砂聚焦」 */
let studySetFocusMode = () => {};
const markVisited = (id) => { if (id) visitedThisSession.add(id); };

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

/**
 * 该节是否"生成过会话" —— 紫色状态的判定依据。
 * 用「至少一条非错误、非 pending 的 assistant 消息」，
 * 这样请求失败、或还在生成中的都不算，避免误判成"学过"。
 * 注意不要用 store.chatOf()，它会顺手创建空记录。
 */
function hasConversation(sectionId) {
  const chats = store.state.chats || {};
  const c = chats[sectionId];
  if (!c || !Array.isArray(c.messages)) return false;
  return c.messages.some((m) => m.role === 'assistant' && !m.error && !m.pending);
}

/* ============================ 左栏 ============================ */

/** 加载模式：'next' = 只预加载下一级（默认）；'none' = 看到哪一级加载哪一级 */
function loadMode() {
  return (store.state.prefs && store.state.prefs.loadMode) || 'next';
}

/** 一个小节的按钮。状态优先级：当前选中 > 灰(本次打开) > 紫(有会话) > 正常 */
function secButton(sec) {
  const isOn = sec.id === state.sectionId;
  let cls = 'sec-link';
  if (isOn) cls += ' is-on';
  else if (visitedThisSession.has(sec.id)) cls += ' is-visited';
  else if (hasConversation(sec.id)) cls += ' has-chat';

  return el('button', { class: cls, onclick: () => onEnterSection(sec.id) }, [
    el('span', { class: 'no', text: sec.no }),
    el('span', { class: 'nm', text: sec.name }),
  ]);
}

/**
 * 左栏章节树 —— 按需构建。
 *
 * 原来这里会把该科的**全部册/章/节**一次性建好（物理 6 册 27 章 125 节 → 591 个元素），
 * 折叠只是 CSS 隐藏，DOM 一直存在。现在改成：
 *   next 模式：只建当前册；其他册点开时才建
 *   none 模式：只建当前章；同册其他章点标题才建
 * 折叠状态与"已展开的章"都记在内存里，切章节时不丢。
 */
function renderLeft() {
  const w = getSectionWrap(state.sectionId);
  const box = dom.leftBody;
  if (!box) return;
  box.innerHTML = '';
  if (!w) return;

  const subject = w.subject;
  const mode = loadMode();
  const collapsed = state.collapsedVolumes || (state.collapsedVolumes = {});
  const expandedChaps = state.expandedChaps || (state.expandedChaps = {});

  for (const vol of subject.volumes) {
    const isCurVol = vol.id === w.volume.id;
    // 默认：当前册展开，其他册收起
    if (collapsed[vol.id] === undefined) collapsed[vol.id] = !isCurVol;

    const group = el('div', { class: 'vol-group' + (collapsed[vol.id] ? ' is-closed' : '') });
    const list = el('div', { class: 'vol-group__list' });
    let painted = false;

    const paint = () => {
      list.innerHTML = '';
      for (const chap of vol.chapters) {
        const isCurChap = chap.id === w.chapter.id;
        const block = el('div', { class: 'chap-block' });
        const title = el('div', { class: 'chap-block__title', text: chap.no + ' ' + chap.name });

        const shouldBuild = (mode === 'next') || isCurChap || !!expandedChaps[chap.id];

        if (shouldBuild) {
          block.append(title);
          for (const sec of chap.sections) block.append(secButton(sec));
        } else {
          title.classList.add('is-lazy');
          title.append(el('span', { class: 'lazy-hint', text: chap.sections.length + ' 节' }));
          title.addEventListener('click', () => { expandedChaps[chap.id] = true; paint(); });
          block.append(title);
        }
        list.append(block);
      }
    };

    const ensurePainted = () => { if (!painted) { painted = true; paint(); } };

    const head = el('div', {
      class: 'vol-group__title',
      onclick: () => {
        collapsed[vol.id] = !collapsed[vol.id];
        group.classList.toggle('is-closed', collapsed[vol.id]);
        if (!collapsed[vol.id]) ensurePainted();
      },
    }, [
      el('span', { class: 'caret', text: '▾' }),
      el('span', { text: vol.name }),
      el('span', { class: 'badge2', text: vol.chapters.length + ' 章' }),
    ]);

    group.append(head, list);
    box.append(group);

    if (!collapsed[vol.id]) ensurePainted();
  }

  const cur = box.querySelector('.sec-link.is-on');
  if (cur) setTimeout(() => cur.scrollIntoView({ block: 'center' }), 60);
}

/**
 * 重建左栏章节树。设置面板切换「载入模式」后要立刻看到效果 ——
 * renderLeft 每次都现读 loadMode()，所以直接重画就行。
 * 还没进学习界面（dom.leftBody 不存在）时静默返回。
 */
export function refreshTree() {
  try { renderLeft(); } catch { /* 未初始化 */ }
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

/* 一次回复没写完的四种情形（由 api.js 的 consumeStream 判定，存在 msg.cut 上） */
const CUT_TEXT = {
  length: '这次先生想得太久了：思考把输出的字数额度用光了，正文一个字都没来得及写。',
  upstream: '这次回复被上游掐断了：思考过程收到了，正文一个字都没有。',
  truncated: '这次回复在中途断了（没收到结束标记）：思考过程收到了，正文一个字都没有。',
  partial: '这条回答没写完就断了，上面只是已经写出来的部分。',
};

/** 判断一条回复是不是"没写完"。
    新消息由 api.js 判定后写在 msg.cut 上；旧消息（这个字段还不存在的年代）
    只能从"正文为空 + 有思考"反推 —— 否则它就是一张永远的白卡片。 */
function cutOf(msg) {
  if (msg.cut) return msg.cut;
  if (msg.pending || msg.error || msg.stopped) return '';
  if (String(msg.content || '').trim()) return '';
  return msg.thinking ? 'truncated' : '';
}

/** 「重来一次」：删掉这条残缺消息，用同样的历史重新问一遍 */
function retryTeacher(msg) {
  if (state.streaming) { toast('先生还在讲，先等等', ''); return; }
  if (msg && msg.id) store.deleteMessage(state.sectionId, msg.id);
  renderChat();
  runTeacher();
}

function messageNode(msg) {
  const isUser = msg.role === 'user';
  if (msg.hidden) return null;

  // 必须带 md 类：content.css 里 39 条 Markdown 规则全挂在 .md 下，
  // 漏了它的话标题、表格、引用、代码块、公式间距在对话里全都不会生效。
  const bubble = el('div', { class: 'msg__bubble md' });
  if (msg.pending) {
    bubble.append(el('div', { class: 'msg__waiting' }, [el('span', { class: 'spinner' }), el('span', { text: '先生正在斟酌…' })]));
  } else if (msg.error) {
    bubble.append(el('div', { text: msg.content }));
    if (msg.hint) bubble.append(el('div', { style: { marginTop: '8px', fontSize: '12.5px', opacity: '.85' }, text: msg.hint }));
  } else {
    const shots = shotsNode(msg.images);
    if (shots) bubble.append(shots);
    // renderInto 会写 innerHTML，所以文字必须放在自己的容器里 ——
    // 直接 renderInto(bubble, …) 会把上面刚加进去的缩略图整个抹掉。
    if (String(msg.content || '').trim()) {
      const body = el('div', { class: 'msg__text md' });
      renderInto(body, msg.content);
      bubble.append(body);
    }
  }
  // 没写完的回复：必须在气泡里说清楚，别留一张白纸让人以为消息被吞了
  const cut = isUser ? '' : cutOf(msg);
  if (cut) bubble.append(el('div', { class: 'msg__cut', text: CUT_TEXT[cut] || CUT_TEXT.truncated }));

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
    const hasText = !!String(msg.content || '').trim();
    if (hasText) actions.append(el('button', { class: 'btn btn--sm', text: '复制', onclick: () => copyText(msg.content) }));
    if (!isUser && hasText) {
      actions.append(el('button', {
        class: 'btn btn--sm', text: '收录错题',
        onclick: () => onCollect(msg),
      }));
      actions.append(el('button', {
        class: 'btn btn--sm', text: '继续展开',
        onclick: () => send('请把这一点再展开讲一些，我还没完全理解。'),
      }));
    }
    if (!isUser && cutOf(msg)) {
      actions.append(el('button', {
        class: 'btn btn--sm btn--retry', text: '重来一次',
        onclick: () => retryTeacher(msg),
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

/**
 * 开场卡片 —— 代替原来的"进章节就自动开口"。
 * 先生不再主动发言，只有点了这个按钮才发第一次请求。
 * （这同时消除了全站唯一的隐式 token 消耗。）
 */
function startCard() {
  const w = getSectionWrap(state.sectionId);
  const sibs = w ? w.chapter.sections : [];
  const idx = w ? sibs.findIndex((s) => s.id === state.sectionId) : -1;

  const card = el('div', { class: 'start-card' });
  card.append(el('div', { class: 'start-card__rule' }));
  card.append(el('div', { class: 'start-card__kicker', text: w ? (w.subject.name + ' · ' + w.volume.name + ' · ' + w.chapter.no) : '' }));
  card.append(el('div', { class: 'start-card__title', text: w ? w.section.no + '　' + w.section.name : '本节' }));
  card.append(el('div', { class: 'start-card__meta', text: w ? ('本章第 ' + (idx + 1) + ' / ' + sibs.length + ' 节') : '' }));

  if (w) {
    const others = sibs.filter((x) => x.id !== state.sectionId).map((x) => x.no);
    if (others.length) card.append(el('div', { class: 'start-card__sib', text: '本章还有：' + others.join('　') }));
  }

  const btn = el('button', { class: 'btn btn--primary start-card__btn', text: '开 始 本 节 课' });
  btn.addEventListener('click', async () => {
    if (state.opening) return;
    state.opening = true;
    btn.disabled = true;
    btn.textContent = '先生正在备课…';
    try {
      await ensureOpening();
    } finally {
      state.opening = false;
    }
  });
  card.append(btn);
  card.append(el('div', { class: 'start-card__hint', text: '先生不会自动开口。也可以直接在下面提问。' }));
  return card;
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
    box.append(startCard());
  }

  // 分页：只渲染最近 msgLimit 条。
  // 原来是把该节全部历史一次建完，一节聊 50 条、每条带公式，
  // 按实测 78ms/条算就是约 4 秒的卡死 —— 聊得越久越慢。
  const from = Math.max(0, visible.length - state.msgLimit);
  if (from > 0) {
    box.append(el('button', {
      class: 'load-earlier',
      onclick: (e) => {
        state.msgLimit += MSG_PAGE;
        const keep = dom.scroll.scrollHeight - dom.scroll.scrollTop;
        renderChat();
        // 尽量让视野停在原处，不要把用户甩到底部
        requestAnimationFrame(() => { dom.scroll.scrollTop = dom.scroll.scrollHeight - keep; });
        e.currentTarget.blur();
      },
      text: '▲ 载入更早的 ' + Math.min(from, MSG_PAGE) + ' 条（该节共 ' + visible.length + ' 条）',
    }));
  }
  for (let i = from; i < visible.length; i++) box.append(messageNode(visible[i]));

  requestAnimationFrame(() => { const s = dom.scroll; s.scrollTop = s.scrollHeight; });
}

/* ---------------------------- 发送 ---------------------------- */
async function send(text) {
  if (state.streaming) { toast('先生还在讲，先等等', ''); return false; }
  if (state.shotBusy) { toast('图片还在处理，等一下', ''); return false; }
  const t = String(text || '').trim();
  const shots = state.pendingShots.slice();
  if (!t && !shots.length) return false;
  store.pushMessage(state.sectionId, {
    role: 'user',
    content: t || (shots.length === 1 ? '（拍了张图）' : '（拍了 ' + shots.length + ' 张图）'),
    images: shots.map((x) => ({ url: x.url, w: x.w, h: x.h, bytes: x.bytes, name: x.name })),
  });
  state.pendingShots = [];
  renderShots();
  renderChat();
  await runTeacher();
  return true;
}

async function runTeacher(opts = {}) {
  const sectionId = state.sectionId;
  const chat = store.chatOf(sectionId);
  const pendingMsg = store.pushMessage(sectionId, { role: 'assistant', content: '', pending: true });
  renderChat();

  state.streaming = true;
  state.abort = new AbortController();
  setComposerBusy(true);
  studySetFocusMode(true);

  const liveBubble = () => {
    const node = dom.messages.querySelector('[data-mid="' + pendingMsg.id + '"] .msg__bubble');
    return node;
  };

  let acc = '';
  let think = '';
  let paintTimer = 0;
  let lastPaint = 0;
  // ---- 增量渲染的状态 ----
  let bodyEl = null;     // 盛放已固化块的容器
  let tailEl = null;     // 只重渲染的"最后一块"
  let committed = 0;     // 已固化的块数

  const stickToBottom = () => {
    if (!state.autoScroll) return;
    // 直接赋值 scrollTop 是瞬时的。以前这里配合 CSS 的 scroll-behavior:smooth，
    // 每 90ms 就会重启一次平滑滚动动画，滚动永远停不下来 —— 卡顿主因之一。
    const s = dom.scroll;
    s.scrollTop = s.scrollHeight;
  };

  const resetStreamDom = (b) => {
    b.innerHTML = '';
    bodyEl = el('div', { class: 'msg__body' });
    tailEl = el('div', { class: 'blk blk--tail' });
    bodyEl.append(tailEl);
    b.append(bodyEl);
    committed = 0;
  };

  const doPaint = () => {
    const b = liveBubble();
    if (!b) return;
    b.classList.add('is-streaming');

    if (!acc) {
      // 正文还没开始：只给一个干净的等待提示。
      // 不要把 reasoning_content 原文倒进来 —— 那是模型的草稿，不是讲给学生听的话。
      bodyEl = null; tailEl = null; committed = 0;
      b.innerHTML = '';
      b.append(el('div', { class: 'msg__waiting' }, [
        el('span', { class: 'spinner' }),
        el('span', { text: think ? '先生正在推敲…' : '先生正在读题…' }),
      ]));
      if (think) b.append(el('div', { class: 'msg__hint', text: '已经想了 ' + think.length + ' 字' }));
      stickToBottom();
      return;
    }

    if (!bodyEl || !b.contains(bodyEl)) resetStreamDom(b);

    const blocks = splitBlocks(acc);
    if (!blocks.length) { stickToBottom(); return; }

    // 关键优化：除最后一块（可能还没写完）外，其余每块只渲染一次，之后再也不碰。
    // 原做法是每次刷新都 innerHTML='' 重建整条回答，重跑全部 Markdown 解析 + KaTeX ——
    // 实测比这个慢 10.4 倍（10.4ms vs 1.0ms / 次）。
    const ready = blocks.length - 1;
    for (let i = committed; i < ready; i++) {
      const node = el('div', { class: 'blk' });
      renderInto(node, blocks[i]);
      bodyEl.insertBefore(node, tailEl);
    }
    if (ready > committed) committed = ready;

    // 只重渲染尾块（通常是最后那个还在增长的段落）
    tailEl.innerHTML = '';
    renderInto(tailEl, blocks[blocks.length - 1]);

    stickToBottom();
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

  let imageData = [];
  try {
    const historyForApi = chat.messages.filter((m) => m.id !== pendingMsg.id);
    // 只把「最后一条用户消息」的图片带给模型（历史里的图片只留一句标记，见 teacher.js）
    const lastUser = [...historyForApi].reverse().find((m) => m.role === 'user' && !m.hidden);
    if (lastUser && Array.isArray(lastUser.images) && lastUser.images.length) {
      imageData = (await Promise.all(lastUser.images.map((it) => toDataUrl(it.url)))).filter(Boolean);
    }
    const res = await askTeacher({
      sectionId,
      history: historyForApi,
      images: imageData,
      text: null,
      signal: state.abort.signal,
      onDelta: (_d, full) => { acc = full; paint(); },
      onThink: (t) => { think = t; paint(); },
    });
    acc = res.text || acc;
    const THINK_CAP = 6000;

    // 这一路流到底正常收尾没有？以前不看，于是「只收到思考、没有正文」也被当成
    // 一次正常答复存下来 —— 界面上就是一张白卡片（2026-11 真实踩过）。
    let cut = '';
    if (res.upstreamError) cut = 'upstream';
    else if (res.finishReason === 'length') cut = 'length';
    else if (!res.sawDone && !res.finishReason) cut = 'truncated';
    if (cut && acc.trim()) cut = 'partial';

    store.updateMessage(sectionId, pendingMsg.id, {
      content: acc,
      pending: false,
      thinking: think ? think.slice(0, THINK_CAP) : undefined,
      thinkingCut: think.length > THINK_CAP ? think.length : undefined,
      cut: cut || undefined,
      finish: res.finishReason || undefined,
      upstreamError: res.upstreamError || undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      store.updateMessage(sectionId, pendingMsg.id, { content: acc || '（已停止）', pending: false, stopped: true });
    } else {
      const noKey = e.status === 400 && /NO_API_KEY|API Key/.test(String(e.message));
      const noVision = /image|vision|multimodal|图片|不支持/i.test(String(e.message)) && imageData.length > 0;
      store.updateMessage(sectionId, pendingMsg.id, {
        content: '**连接不上模型服务。**\n\n' + String(e.message || e),
        pending: false, error: true,
        hint: noKey
          ? '点屏幕右下角的齿轮按钮，填入你的 DeepSeek API Key 后重试。'
          : (noVision
            ? '当前模型看不了图片：点右下角齿轮，在「识图模型」里填一个支持视觉的模型（gpt-4o / qwen-vl-max / glm-4v）。'
            : '检查网络，或点右下角齿轮确认 API 地址 / 模型名是否正确。'),
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

/* ---------------------------- 图片（识图） ---------------------------- */

function renderShots() {
  const box = dom.shots;
  if (!box) return;
  box.innerHTML = '';
  const shots = state.pendingShots;
  const busy = state.shotBusy > 0;
  box.hidden = !shots.length && !busy;
  for (const s of shots) {
    const cell = el('div', { class: 'composer__shot' });
    const img = el('img', { src: s.url, alt: s.name || '图片' });
    cell.append(img);
    cell.append(el('button', {
      class: 'composer__shot-x', type: 'button', title: '移除这张图', text: '✕',
      onclick: () => {
        state.pendingShots = state.pendingShots.filter((x) => x !== s);
        renderShots();
      },
    }));
    box.append(cell);
  }
  if (busy) {
    const cell = el('div', { class: 'composer__shot composer__shot--busy' });
    cell.append(el('span', { class: 'spinner' }));
    cell.append(el('span', { class: 'composer__shot-note', text: '处理中' }));
    box.append(cell);
  }
}

async function addFiles(files) {
  const list = Array.from(files || []).filter((f) => /^image\//.test(f.type || ''));
  if (!list.length) { toast('只能发图片（JPG / PNG / WebP / GIF）', 'err'); return; }
  const room = MAX_SHOTS - state.pendingShots.length;
  if (room <= 0) { toast('一条消息最多 ' + MAX_SHOTS + ' 张图', 'err'); return; }
  const take = list.slice(0, room);
  if (list.length > room) toast('只收了前 ' + room + ' 张（上限 ' + MAX_SHOTS + '）', '');
  if (state.pendingShots.length + take.length > 6 && !state.manyShotHinted) {
    state.manyShotHinted = true;
    toast('图片有点多，先生可能一次看不过来这里所有细节，必要时分两条发。', '');
  }
  for (const file of take) {
    state.shotBusy++;
    renderShots();
    try {
      state.pendingShots.push(await prepareShot(file));
    } catch (e) {
      toast('这张图没加上：' + (e && e.message ? e.message : e), 'err');
    } finally {
      state.shotBusy--;
      renderShots();
    }
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
    attach: $('#btn-attach'),
    file: $('#file-input'),
    shots: $('#composer-shots'),
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
    // 旧写法是「先清空输入框再 send」，而 send 在流式/图片处理中会直接 return，
    // 于是你刚打的字凭空消失。现在先确认能发，再清空。
    if (!v.trim() && !state.pendingShots.length) { dom.input.focus(); return; }
    if (state.shotBusy) { toast('图片还在处理，等一下', ''); return; }
    dom.input.value = '';
    dom.input.style.height = 'auto';
    send(v);
  });

  // 发图片：按钮 / 粘贴 / 拖进来，三条路都收
  if (dom.attach && dom.file) {
    dom.attach.addEventListener('click', () => dom.file.click());
    dom.file.addEventListener('change', () => {
      addFiles(dom.file.files);
      dom.file.value = '';
    });
  }
  dom.input.addEventListener('paste', (e) => {
    const files = (e.clipboardData && e.clipboardData.files) || [];
    const imgs = Array.from(files).filter((f) => /^image\//.test(f.type || ''));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  });
  const hasImage = (e) => {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types && Array.from(dt.types).indexOf('Files') >= 0) return true;
    return Array.from(dt.items || []).some((it) => it.kind === 'file');
  };
  if (dom.main) {
    dom.main.addEventListener('dragover', (e) => {
      if (!hasImage(e)) return;
      e.preventDefault();
      dom.main.classList.add('is-dragover');
    });
    dom.main.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && dom.main.contains(e.relatedTarget)) return;
      dom.main.classList.remove('is-dragover');
    });
    dom.main.addEventListener('drop', (e) => {
      if (!hasImage(e)) return;
      e.preventDefault();
      dom.main.classList.remove('is-dragover');
      addFiles(e.dataTransfer && e.dataTransfer.files);
    });
  }
  renderShots();

  dom.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (state.streaming) { toast('先生还在讲，先等等', ''); return; }
      const v = dom.input.value;
      if (!v.trim() && !state.pendingShots.length) return;
      if (state.shotBusy) { toast('图片还在处理，等一下', ''); return; }
      dom.input.value = '';
      autoGrow();
      send(v);
    }
  });
  dom.input.addEventListener('input', autoGrow);

  /* 磨砂聚焦：把左右面板压下去，注意力落在纸面上
     规则（用户定的）：
       左键点对话区（含输入框、消息、快捷条）→ 进入
       左键点左右侧栏 → 取消
       右键任意位置 → 取消
       其它（顶栏按钮、角落图标、弹窗）→ 不改
     以前是「输入框失焦就取消」，等于点屏幕任意位置都会取消，太容易被误触。 */
  const setFocusMode = (on) => {
    if ((store.state.prefs && store.state.prefs.focusMode) === false) return;
    document.body.classList.toggle('chat-focus', !!on);
  };
  const focusState = () => document.body.classList.contains('chat-focus');

  dom.input.addEventListener('focus', () => setFocusMode(true));

  document.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;              // 右键交给下面的 contextmenu
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('.pane--left, .pane--right')) setFocusMode(false);
    else if (t.closest('.chat-pane')) setFocusMode(true);
  }, true);

  document.addEventListener('contextmenu', () => {
    if (focusState()) setFocusMode(false);
  }, true);

  // 隔离罩：盖在左右侧栏上，接住第一次点击（只退出聚焦，不穿透到章节链接）
  for (const pane of [document.querySelector('.pane--left'), document.querySelector('.pane--right')]) {
    if (!pane) continue;
    // 罩子上不放任何文字：它的作用是"让注意力回到对话"，写一句提示反而把人拽回来
    const veil = el('div', { class: 'pane-veil', 'aria-hidden': 'true' });
    veil.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      setFocusMode(false);
    });
    pane.append(veil);
  }

  studySetFocusMode = setFocusMode;

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
  state.msgLimit = MSG_PAGE;   // 切换章节时重置分页
  store.setPref('lastSection', sectionId);
  store.markStudying(sectionId);
  markVisited(sectionId);   // 本次会话标记（灰色字体），刷新页面即清空
  renderTopbar();
  renderLeft();
  renderRight();
  renderChat();

  // 这里原本会自动调用 ensureOpening()（每次进新章节自动发一次请求）。
  // 已移除：改为由开场卡片上的「开始本节课」按钮触发，避免在你还没决定学哪一节时
  // 就消耗 token，也避免刚进页面就开始流式渲染造成卡顿。
  void silent;
}

export function currentSection() { return state.sectionId; }
export function collectFromMessage(msg) { onCollect(msg); }
export function sendToTeacher(text) { return send(text); }

/** 把一张已经处理好的图片放进待发送区（测试和「从别处带入图片」都用它） */
export function addShot(shot) {
  if (!shot || !shot.url) return false;
  if (state.pendingShots.length >= MAX_SHOTS) { toast('一条消息最多 ' + MAX_SHOTS + ' 张图', 'err'); return false; }
  state.pendingShots.push(shot);
  renderShots();
  return true;
}

export function pendingShotCount() { return state.pendingShots.length; }
