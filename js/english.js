/* ===========================================================
   english.js —— 英语板块
   词汇：把「草稿本 5 斜杠法」搬到屏幕上（隔天默写，累计 5 次毕业）
   作文：自由工作台（写 / 我的表达库 / 问题池 / 复盘），不排课、不给范文
   =========================================================== */
import { $, el, toast } from './util.js';
import { store } from './store.js';
import { explainWord, reviewEssay, extractVault } from './english-teacher.js';

const DATA = window.ENGLISH || { words: [], chunks: [], prompts: [], levels: [] };
const LEVELS = DATA.levels && DATA.levels.length ? DATA.levels : [];
const ALL_LEVEL_IDS = LEVELS.map((l) => l.id);
const LEVEL_IDS_ALL = ALL_LEVEL_IDS.concat(['user']);
const CHUNK_GROUPS = (DATA.chunkGroups && DATA.chunkGroups.length)
  ? DATA.chunkGroups
  : [{ id: 'verb', name: '动词搭配' }, { id: 'prep', name: '介词连词短语' }];
const CHUNK_GROUP_IDS = CHUNK_GROUPS.map((g) => g.id);
const chunkGroupOf = (c) => c.group || 'verb';
const DAY = 86400000;
const FUNCS = ['开头', '建议', '结尾', '描写', '情绪', '转折'];
const STRUCTS = ['倒装', '非谓语', '被动', '从句', '强调', '名词化', '普通句'];

const byId = (id) => document.getElementById(id);

let dom = null;
let tab = 'blocks';         // blocks | vocab | chunk | write | vault | issues | review
let path = ['blocks'];      // 导航栈：返回键 / Esc 逐级后退
let session = null;
let active = false;
let hooks = { onExit: () => {} };
let timer = { on: false, startAt: 0, base: 0, tick: 0 };
let busy = false;
let result = null;          // 最近一次批改 { essay, review, candidates }
let autoExplained = {};

/* ---------------------------- 状态 ---------------------------- */
export function englishState() {
  const st = store.state;
  if (!st.english || typeof st.english !== 'object') st.english = {};
  const e = st.english;
  if (!e.words || typeof e.words !== 'object') e.words = {};
  if (!e.chunks || typeof e.chunks !== 'object') e.chunks = {};
  if (!Array.isArray(e.userWords)) e.userWords = [];
  if (!Array.isArray(e.vault)) e.vault = [];
  if (!Array.isArray(e.issues)) e.issues = [];
  if (!Array.isArray(e.essays)) e.essays = [];
  if (!e.session || typeof e.session !== 'object') e.session = { date: '', passed: 0, failed: 0, newLearned: 0 };
  if (!e.draft || typeof e.draft !== 'object') e.draft = { promptId: '', text: '', skeleton: ['', '', ''] };
  if (!e.prefs || typeof e.prefs !== 'object') e.prefs = {};
  const p = e.prefs;
  if (typeof p.newPerDay !== 'number') p.newPerDay = 10;
  if (typeof p.reviewCap !== 'number') p.reviewCap = 15;
  if (typeof p.cadenceDays !== 'number') p.cadenceDays = 2;
  // 旧版是“每天上限 30/10”，改成“每组 15 复习 + 10 新词”（可开多组），只在第一次迁移时改一次
  if (!p.capsTuned) { p.reviewCap = 15; p.newPerDay = 10; p.capsTuned = true; }
  if (p.dictation !== 'A' && p.dictation !== 'B' && p.dictation !== 'C') p.dictation = 'A';
  if (typeof p.timeLimitApp !== 'number') p.timeLimitApp = 20;
  if (typeof p.timeLimitCont !== 'number') p.timeLimitCont = 35;
  if (typeof p.stageTimer !== 'boolean') p.stageTimer = true;
  if (typeof p.goalWords !== 'number' || p.goalWords < 500) p.goalWords = 3500;
  if (!e.days || typeof e.days !== 'object') e.days = {};
  // 词汇分级筛选：默认全选；旧 state 没有这个字段就补全
  if (!Array.isArray(p.chunkGroups) || !p.chunkGroups.length) p.chunkGroups = CHUNK_GROUP_IDS.slice();
  p.chunkGroups = p.chunkGroups.filter((id) => CHUNK_GROUP_IDS.indexOf(id) >= 0);
  if (!p.chunkGroups.length) p.chunkGroups = CHUNK_GROUP_IDS.slice();
  if (!Array.isArray(p.levels) || !p.levels.length) p.levels = LEVEL_IDS_ALL.slice();
  p.levels = p.levels.filter((id) => LEVEL_IDS_ALL.indexOf(id) >= 0);
  if (!p.levels.length) p.levels = LEVEL_IDS_ALL.slice();
  // 词库升级到课标 3871 词后，先把「高考基础」（义务教育已学）从默认勾选里去掉一次；用户之后手动打开不会再动
  if (!p.levelsTuned) {
    p.levels = p.levels.filter((id) => id !== 'basic');
    if (!p.levels.length) p.levels = LEVEL_IDS_ALL.slice();
    p.levelsTuned = true;
  }
  // 词库换过之后，旧档位 id 可能一个词都没有（例如只剩「导入」）——自动回落到有词的档位
  const bankLevels = new Set((DATA.words || []).map((w) => w.level || 'mid'));
  if ((e.userWords || []).length) bankLevels.add('user');
  if (!p.levels.some((id) => bankLevels.has(id))) {
    const prefer = ['hi', 'mid', 'extra', 'sense', 'user'].filter((id) => bankLevels.has(id));
    p.levels = prefer.length ? prefer : LEVEL_IDS_ALL.filter((id) => bankLevels.has(id));
  }
  reconcileRecords();
  return e;
}

const levelOf = (w) => w.level || (w.addedBy === 'user' ? 'user' : 'mid');

let wordIndexById = null;
function bankWord(id) {
  if (!wordIndexById) {
    wordIndexById = new Map();
    for (const w of (DATA.words || [])) wordIndexById.set(w.id, w);
    for (const w of (englishState().userWords || [])) wordIndexById.set(w.id, w);
  }
  return wordIndexById.get(id) || null;
}

let lastRecordCount = -1;
/** 词库换过之后：能按词形对上的旧记录合并回来；对不上的原样留着（不删），并在进度页点名 */
function reconcileRecords() {
  const st = store.state;
  if (!st.english || !st.english.words || typeof st.english.words !== 'object') return;
  const n = Object.keys(st.english.words).length;
  if (n === lastRecordCount) return;
  lastRecordCount = n;
  const e = st.english;
  const byWord = new Map();
  for (const w of (DATA.words || [])) byWord.set(String(w.w).toLowerCase(), w.id);
  for (const w of (e.userWords || [])) byWord.set(String(w.w).toLowerCase(), w.id);
  for (const id of Object.keys(e.words)) {
    if (wordIndexById && wordIndexById.has(id)) continue;
    const key = id.startsWith('w-') ? id.slice(2) : id;
    const target = byWord.get(key.toLowerCase());
    if (!target || target === id) continue;
    const src = e.words[id];
    const dst = e.words[target] || { marks: 0, seen: 0, miss: 0, shaky: 0, dueAt: 0, learned: false, lastDay: '', lastAt: 0 };
    dst.marks = Math.max(dst.marks || 0, src.marks || 0);
    dst.seen = (dst.seen || 0) + (src.seen || 0);
    dst.miss = (dst.miss || 0) + (src.miss || 0);
    dst.shaky = (dst.shaky || 0) + (src.shaky || 0);
    dst.dueAt = Math.min(dst.dueAt || 0, src.dueAt || 0) || (dst.dueAt || 0);
    dst.learned = !!(dst.learned || src.learned);
    dst.lastAt = Math.max(dst.lastAt || 0, src.lastAt || 0);
    if (!dst.lastDay) dst.lastDay = src.lastDay || '';
    e.words[target] = dst;
    delete e.words[id];
  }
}
function activeLevels() {
  return new Set(englishState().prefs.levels);
}

const allWords = () => DATA.words.concat(englishState().userWords);

function dayStart(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dueStamp(days) { return dayStart() + days * DAY + 8 * 3600000; }
function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/** 复习队列：先到期，再补新词；受 reviewCap / newPerDay 限制 */
export function englishQueue() {
  const e = englishState();
  const due = [];
  const fresh = [];
  const on = activeLevels();
  for (const w of allWords()) {
    if (!on.has(levelOf(w))) continue;
    const r = e.words[w.id];
    if (r && r.learned) continue;
    if (r && r.seen) { if (r.dueAt <= dayStart() + 20 * 3600000) due.push(w); }
    else fresh.push(w);
  }
  due.sort((a, b) => ((e.words[a.id] || {}).dueAt || 0) - ((e.words[b.id] || {}).dueAt || 0));
  const rank = { hi: 0, mid: 1, extra: 2, sense: 3, basic: 4, user: 5 };
  fresh.sort((a, b) => (rank[levelOf(a)] || 9) - (rank[levelOf(b)] || 9) || String(a.w).localeCompare(String(b.w)));
  // 单次一组：复习 ≤ reviewCap，新词 ≤ newPerDay；做完可以再开一组
  return due.slice(0, e.prefs.reviewCap).concat(fresh.slice(0, e.prefs.newPerDay));
}

export function englishDueCount() {
  const e = englishState();
  const on = activeLevels();
  let n = 0;
  for (const w of allWords()) {
    if (!on.has(levelOf(w))) continue;
    const r = e.words[w.id];
    if (r && r.seen && !r.learned && r.dueAt <= dayStart() + 20 * 3600000) n++;
  }
  return n;
}

export function isEnglishActive() { return active; }

/* ---------------------------- 判定 ---------------------------- */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s,，.。;；:：!！?？'"“”‘’()（）\-—…]/g, '');
}
/** 中文义自动比对：只做辅助，最终由学生自评 */
export function matchMeaning(input, cn) {
  const a = norm(input);
  if (!a) return false;
  const segs = String(cn || '').split(/[；;、，,／/]/).map(norm).filter(Boolean);
  for (const s of segs) {
    if (s === a) return true;
    if (s.includes(a) && a.length >= 2) return true;
    if (a.includes(s) && s.length >= 2) return true;
  }
  return false;
}

function bumpDay(kind, graduated) {
  const e = englishState();
  const key = todayKey();
  const d = e.days[key] || { pass: 0, fail: 0, maybe: 0, grad: 0 };
  d[kind] = (d[kind] || 0) + 1;
  if (graduated) d.grad = (d.grad || 0) + 1;
  e.days[key] = d;
  const keys = Object.keys(e.days).sort();
  if (keys.length > 60) { for (const k of keys.slice(0, keys.length - 60)) delete e.days[k]; }
}

function recordOf(id) {
  const e = englishState();
  if (!e.words[id]) {
    e.words[id] = { marks: 0, dueAt: 0, seen: 0, miss: 0, learned: false, addedBy: 'builtin', lastAt: 0, lastDay: '', note: '' };
  }
  return e.words[id];
}

function currentWord() {
  if (!session) return null;
  return session.queue[session.i] || null;
}

function modeFor(word) {
  const e = englishState();
  if (e.prefs.dictation === 'B') return 'cn2en';
  if (e.prefs.dictation === 'C') {
    const r = e.words[word.id];
    return (r && r.marks >= 3) ? 'cn2en' : 'en2cn';
  }
  return 'en2cn';
}

/* ---------------------------- 入口 ---------------------------- */
export function initEnglish(opts) {
  hooks = Object.assign({ onExit: () => {} }, opts || {});
  dom = {
    view: $('#view-english'),
    main: byId('en-main'),
    title: byId('en-title'),
    pill: byId('en-due-pill'),
    back: byId('en-back'),
  };
  if (!dom.view || !dom.main) return;
  if (dom.back) dom.back.addEventListener('click', () => back());
  document.addEventListener('keydown', onKey);
  englishState();
}

function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') {
    back();
    e.preventDefault();
    return;
  }
  if (tab === 'write' && (e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
    e.preventDefault();
    store.touch({ type: 'english' });
    toast('草稿已保存', 'ok');
    return;
  }
  if (tab === 'vocab' && session && session.revealed) {
    if (e.key === '1') { judge('ok'); e.preventDefault(); }
    else if (e.key === '2') { judge('maybe'); e.preventDefault(); }
    else if (e.key === '3') { judge('no'); e.preventDefault(); }
  }
  if (tab === 'chunk' && session && session.revealed) {
    if (e.key === '1') { judgeChunk('ok'); e.preventDefault(); }
    else if (e.key === '2') { judgeChunk('maybe'); e.preventDefault(); }
    else if (e.key === '3') { judgeChunk('no'); e.preventDefault(); }
  }
}

function exit() {
  stopTimer();
  hooks.onExit();
}

export function openEnglish(block) {
  active = true;
  if (dom && dom.view) { dom.view.classList.remove('is-leaving'); dom.view.classList.add('is-active'); }
  englishState();
  path = ['blocks'];
  if (block === 'vocab') { startVocab(); path.push('vocab'); }
  else if (block === 'chunk') { startChunk(); path.push('chunk'); }
  else if (block === 'write' || block === 'vault' || block === 'issues' || block === 'review' || block === 'progress') {
    tab = block; path.push(block); render();
  } else { tab = 'blocks'; render(); }
}

export function closeEnglish() {
  active = false;
  stopTimer();
  if (dom && dom.view) dom.view.classList.remove('is-active');
}

function go(next) {
  if (path[path.length - 1] !== next) path.push(next);
  tab = next;
  if (next === 'vocab') startVocab();
  else if (next === 'chunk') startChunk();
  else render();
}

/** 同级切换（写 / 表达库 / 问题池 / 复盘）：不叠栈，返回时直接回板块页 */
function goTab(next) {
  path = ['blocks', next];
  tab = next;
  render();
}

/** 返回上一级：板块页再按才回书桌 */
function back() {
  if (path.length <= 1) { exit(); return; }
  path.pop();
  const prev = path[path.length - 1] || 'blocks';
  tab = prev;
  if (prev === 'vocab') startVocab();
  else if (prev === 'chunk') startChunk();
  else render();
}

/* ---------------------------- 渲染骨架 ---------------------------- */
function render() {
  if (!dom || !dom.main) return;
  dom.main.innerHTML = '';
  if (dom.title) dom.title.textContent = tab === 'blocks' ? '英 语' : ('英语 · ' + tabName(tab));
  if (dom.pill) {
    const n = englishDueCount();
    dom.pill.textContent = n ? ('待复习 ' + n) : '今日已清';
    dom.pill.dataset.on = n ? '1' : '0';
  }
  if (tab === 'blocks') renderBlocks();
  else if (tab === 'vocab') renderVocab();
  else if (tab === 'chunk') renderChunk();
  else if (tab === 'write') renderWrite();
  else if (tab === 'vault') renderVault();
  else if (tab === 'issues') renderIssues();
  else if (tab === 'review') renderReviewList();
  else if (tab === 'progress') renderProgress();
}

function tabName(t) {
  return ({ vocab: '词汇', chunk: '搭配', write: '写', vault: '表达库', issues: '问题池', review: '复盘', progress: '总进度' })[t] || '';
}

/* ---------------------------- 板块页 ---------------------------- */
function renderBlocks() {
  const e = englishState();
  const stats = { due: englishDueCount(), fresh: 0, learned: 0, total: 0 };
  const counts = {};
  const on = activeLevels();
  for (const w of allWords()) {
    const lv = levelOf(w);
    counts[lv] = (counts[lv] || 0) + 1;
    if (!on.has(lv)) continue;
    const r = e.words[w.id];
    stats.total++;
    if (r && r.learned) stats.learned++;
    else if (!r || !r.seen) stats.fresh++;
    else stats.waiting = (stats.waiting || 0) + 1;
  }
  const cDue = chunkDueCount();
  const cLearned = chunkLearnedCount();
  const lastEssay = e.essays[0];
  const openIssues = e.issues.length;

  const wrap = el('div', { class: 'en-blocks' });

  wrap.append(el('div', { class: 'en-card', dataset: { block: 'vocab' } }, [
    el('div', { class: 'en-card__head' }, [
      el('span', { class: 'en-card__icon', text: '词' }),
      el('span', { class: 'en-card__title', text: '词汇' }),
      el('span', { class: 'en-card__tag', text: '默写 · 5 斜杠毕业' }),
    ]),
    el('p', { class: 'en-card__desc', text: '隔天默写一次；想起来画一斜杠，满 5 次毕业，不再进总复习。' }),
    el('div', { class: 'en-stats' }, [
      stat('待复习', stats.due),
      stat('新词', stats.fresh),
      stat('已毕业', stats.learned),
    ]),
    levelChips(counts),
    el('p', { class: 'en-card__meta', text: '当前档位 ' + stats.total + ' 词（词库共 ' + allWords().length + ' 词，未勾选的档不参与）' }),
    stats.waiting && !stats.due ? el('p', { class: 'en-hint', text: '在学 ' + stats.waiting + ' 词今天不到期，明天再来；进度都在，可在「总进度」里核对。' }) : null,
    el('p', { class: 'en-card__meta', text: '固定搭配：到期 ' + cDue + ' · 已毕业 ' + cLearned + ' / ' + (DATA.chunks || []).length }),
    el('div', { class: 'en-card__acts' }, [
      el('button', { class: 'en-btn en-btn--primary', text: '开始默写', onclick: () => go('vocab') }),
      el('button', { class: 'en-btn', text: cDue ? ('搭配复习（' + cDue + '）') : '搭配加练', onclick: () => go('chunk') }),
      el('button', { class: 'en-btn', text: '导入词表', onclick: () => { tab = 'vocab'; session = null; renderImport(); } }),
      el('button', { class: 'en-btn', text: '仅英文导出', onclick: exportEnglishOnly }),
    ]),
  ]));

  wrap.append(el('div', { class: 'en-card', dataset: { block: 'write' } }, [
    el('div', { class: 'en-card__head' }, [
      el('span', { class: 'en-card__icon', text: '文' }),
      el('span', { class: 'en-card__title', text: '作文' }),
      el('span', { class: 'en-card__tag', text: '写 · 表达库 · 问题池 · 复盘' }),
    ]),
    el('p', { class: 'en-card__desc', text: '不排课、不给范文：写一篇，攒你自己的句子，把毛病一条条看清楚。' }),
    el('div', { class: 'en-stats' }, [
      stat('作文', e.essays.length),
      stat('表达卡', e.vault.length),
      stat('问题', openIssues),
    ]),
    el('p', { class: 'en-card__meta', text: lastEssay
      ? ('上一篇：' + (lastEssay.title || '未命名') + ' · ' + (lastEssay.score ? lastEssay.score.total : '—') + ' 分 · ' + Math.round((lastEssay.timing && lastEssay.timing.total || 0) / 60) + ' 分钟')
      : '还没写过；建议先从应用文开始，限时 20 分钟。' }),
    el('div', { class: 'en-card__acts' }, [
      el('button', { class: 'en-btn en-btn--primary', text: '写一篇', onclick: () => go('write') }),
      el('button', { class: 'en-btn', text: '表达库', onclick: () => go('vault') }),
      el('button', { class: 'en-btn', text: '问题池', onclick: () => go('issues') }),
    ]),
  ]));

  // 今日建议：把「先做什么」写清楚，省得每次都要自己想
  const lines = [];
  if (stats.due) lines.push(el('div', { class: 'en-today__line' }, [
    '今天有 ', el('b', { text: String(stats.due) }), ' 个到期词，先默写一轮（约 ' + Math.max(2, Math.round(stats.due * 0.35)) + ' 分钟）。',
  ]));
  else lines.push(el('div', { class: 'en-today__line' }, [
    '今天没有到期词；可以练一组新词（', el('b', { text: String(Math.min(stats.fresh, e.prefs.newPerDay)) }), ' 个）或写一篇作文。',
  ]));
  lines.push(el('div', { class: 'en-today__line' }, [
    '作文：应用文卡在 30 分钟的话，先按「骨架 4 分钟 → 正文 15 分钟」拆开练。',
  ]));
  if (cDue) lines.push(el('div', { class: 'en-today__line' }, [
    '另有 ', el('b', { text: String(cDue) }), ' 个固定搭配到期，点「搭配复习」一条过一遍。',
  ]));
  if (e.issues.length) lines.push(el('div', { class: 'en-today__line' }, [
    '问题池里有 ', el('b', { text: String(e.issues.length) }), ' 条待复盘，挑最多的那一类看。',
  ]));

  wrap.append(el('div', { class: 'en-card en-card--wide' }, [
    el('div', { class: 'en-card__head' }, [
      el('span', { class: 'en-card__title', text: '今天' }),
      el('span', { class: 'en-card__tag', text: '到期 ' + stats.due + ' · 新词 ' + stats.fresh + ' · 毕业 ' + stats.learned }),
    ]),
    el('div', { class: 'en-today' }, [
      el('div', { class: 'en-today__lines' }, lines),
      el('div', { class: 'en-card__acts' }, [
        el('button', { class: 'en-btn en-btn--primary', text: stats.due ? '先默写' : '练一组新词', onclick: () => go('vocab') }),
        el('button', { class: 'en-btn', text: '写一篇', onclick: () => go('write') }),
      ]),
    ]),
  ]));

  const steps = [
    ['每天 3 分钟', '默写到期的词：想起来点 1，想不起来点 2；满 5 次斜杠就毕业，不再打扰你。'],
    ['错了就停一下', '点「讲一下」，把搭配或易混的那条抄回你的草稿本——屏幕上的讲解不代替手写。'],
    ['每篇只练一件事', '作文页先选 1–2 个句式做目标，写完整篇后只改「下次只改的一件事」。'],
  ];
  wrap.append(el('div', { class: 'en-card en-card--wide' }, [
    el('div', { class: 'en-card__head' }, [
      el('span', { class: 'en-card__title', text: '怎么用' }),
      el('span', { class: 'en-card__tag', text: '和你的草稿本配合，不替代它' }),
    ]),
    el('div', { class: 'en-steps' }, steps.map((s) => el('div', { class: 'en-step' }, [
      el('div', { class: 'en-step__t', text: s[0] }),
      el('div', { class: 'en-step__b', text: s[1] }),
    ]))),
  ]));

  dom.main.append(wrap);
}

function levelChips(counts) {
  const box = el('div', { class: 'en-levels' });
  const on = activeLevels();
  for (const lv of LEVELS) {
    const n = counts[lv.id] || 0;
    box.append(el('button', {
      class: 'en-level' + (on.has(lv.id) ? ' is-on' : ''), title: lv.desc || '', dataset: { level: lv.id },
      onclick: () => toggleLevel(lv.id),
    }, [el('span', { text: lv.name }), el('span', { class: 'en-level__n', text: String(n) })]));
  }
  if (counts.user) {
    box.append(el('button', {
      class: 'en-level' + (on.has('user') ? ' is-on' : ''), title: '从草稿本导入的词', dataset: { level: 'user' },
      onclick: () => toggleLevel('user'),
    }, [el('span', { text: '导入' }), el('span', { class: 'en-level__n', text: String(counts.user) })]));
  }
  return box;
}

function toggleLevel(id) {
  const e = englishState();
  const has = e.prefs.levels.indexOf(id) >= 0;
  if (has && e.prefs.levels.length === 1) { toast('至少留一档', ''); return; }
  e.prefs.levels = has ? e.prefs.levels.filter((x) => x !== id) : e.prefs.levels.concat([id]);
  if (id === 'user') {
    // 导入词不算进主档位，单独靠 chip 控制；这里只需要刷新
  }
  store.touch({ type: 'english' });
  session = null;
  render();
}

function levelName(w) {
  const id = levelOf(w);
  if (id === 'user') return '导入';
  const lv = LEVELS.find((l) => l.id === id);
  return lv ? lv.name : '';
}

function stat(label, value) {
  return el('div', { class: 'en-stat' }, [
    el('span', { class: 'en-stat__n', text: String(value) }),
    el('span', { class: 'en-stat__l', text: label }),
  ]);
}

function bar(progress) {
  const box = el('span', { class: 'en-marks' });
  for (let i = 0; i < 5; i++) box.append(el('span', { class: 'en-mark' + (i < progress ? ' is-on' : '') }));
  return box;
}

/* ---------------------------- 词汇 ---------------------------- */
function startVocab(random) {
  tab = 'vocab';
  let queue = englishQueue();
  if (random) {
    const on = activeLevels();
    const pool = allWords().filter((w) => on.has(levelOf(w)) && !recordOf(w.id).learned);
    queue = pool.slice().sort(() => Math.random() - 0.5).slice(0, 10);
  }
  session = { queue, i: 0, revealed: false, raw: '', auto: false, passed: 0, failed: 0, graduated: 0 };
  render();
}

function renderVocab() {
  const e = englishState();
  if (!session) session = { queue: englishQueue(), i: 0, revealed: false, raw: '', auto: false, passed: 0, failed: 0, graduated: 0 };
  const total = session.queue.length;
  const w = currentWord();

  const head = el('div', { class: 'en-vocabhead' }, [
    el('span', { class: 'en-progress', text: total ? ('第 ' + Math.min(session.i + 1, total) + ' / ' + total + ' 个') : '队列空' }),
    el('span', { class: 'en-hint', text: '模式：' + (e.prefs.dictation === 'A' ? '英→中' : e.prefs.dictation === 'B' ? '中→英' : '混合') }),
    el('span', { class: 'en-hint', text: '间隔 ' + e.prefs.cadenceDays + ' 天 · 单组：复习 ≤' + e.prefs.reviewCap + '、新词 ≤' + e.prefs.newPerDay }),
    el('span', { class: 'en-hint', text: '今日：会 ' + ((e.days[todayKey()] || {}).pass || 0) + ' · 没想起 ' + ((e.days[todayKey()] || {}).fail || 0) + ' · 新毕业 ' + ((e.days[todayKey()] || {}).grad || 0) }),
    el('span', { class: 'en-hint', text: '档位：' + e.prefs.levels.map((id) => ((LEVELS.find((l) => l.id === id) || {}).name || '导入')).join('、') }),
  ]);
  dom.main.append(head);

  if (!total || !w) {
    dom.main.append(el('div', { class: 'en-empty' }, [
      el('p', { text: session.i >= total && total ? '这一组完成了。' : '当前没有到期词，也没有新词了。' }),
      el('p', { class: 'en-hint', text: session.i >= total && total
        ? ('本组：通过 ' + session.passed + ' · 没想起 ' + session.failed + ' · 新毕业 ' + session.graduated
          + '　|　今日累计：会 ' + ((e.days[todayKey()] || {}).pass || 0) + ' · 没想起 ' + ((e.days[todayKey()] || {}).fail || 0)
          + ' · 新毕业 ' + ((e.days[todayKey()] || {}).grad || 0))
        : '可以把档位调宽一点，或者隔天再来；同一个词今天只记一个斜杠。' }),
      el('div', { class: 'en-card__acts' }, [
        el('button', { class: 'en-btn en-btn--primary', text: '再来一组（≤' + e.prefs.reviewCap + ' 复 · ≤' + e.prefs.newPerDay + ' 新）', onclick: () => { session = null; startVocab(); } }),
        el('button', { class: 'en-btn', text: '加练（随机 10 个）', onclick: () => startVocab(true) }),
        el('button', { class: 'en-btn', text: '全选档位', onclick: () => { englishState().prefs.levels = LEVEL_IDS_ALL.slice(); store.touch({ type: 'english' }); session = null; startVocab(); } }),
        el('button', { class: 'en-btn', text: '回板块', onclick: () => go('blocks') }),
        el('button', { class: 'en-btn', text: '导入词表', onclick: renderImport }),
      ]),
    ]));
    return;
  }

  const mode = modeFor(w);
  const rec = recordOf(w.id);
  const card = el('div', { class: 'en-wordcard' });

  if (!session.revealed) {
    card.append(el('div', { class: 'en-word', text: mode === 'en2cn' ? w.w : w.cn.split(/[；;、，,]/)[0] }));
    if (w.ipa) card.append(el('div', { class: 'en-word__ipa', text: '/' + w.ipa + '/' }));
    card.append(el('div', { class: 'en-word__pos', text: (mode === 'en2cn' ? (w.pos || '') : '写出英文') + (levelName(w) ? '　·　' + levelName(w) : '') }));
    card.append(bar(rec.marks));
    const input = el('input', {
      class: 'input en-input',
      id: 'en-answer',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: mode === 'en2cn' ? '写出中文义（核心意思即可）' : '写出英文拼写',
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitAnswer(); } });
    card.append(input);
    card.append(el('div', { class: 'en-card__acts' }, [
      el('button', { class: 'en-btn en-btn--pass', text: '我会', title: '认识就直接过：记一个斜杠，2 天后再来', onclick: () => judge('ok') }),
      el('button', { class: 'en-btn en-btn--primary', text: '提交', onclick: () => submitAnswer() }),
      el('button', { class: 'en-btn', text: '想不起来，直接看', onclick: () => { session.raw = ''; submitAnswer(true); } }),
    ]));
    card.append(el('p', { class: 'en-hint', text: '提示：认识就点「我会」直接过（不输入）；写不出就「直接看」。这一轮的目的是暴露不会的词。' }));
  } else {
    const recNow = recordOf(w.id);
    card.append(el('div', { class: 'en-word en-word--small', text: w.w + '　' + (w.pos || '') }));
    if (w.ipa) card.append(el('div', { class: 'en-word__ipa', text: '/' + w.ipa + '/　' + levelName(w) }));
    else card.append(el('div', { class: 'en-word__pos', text: levelName(w) }));
    card.append(bar(recNow.marks));
    card.append(el('div', { class: 'en-answerbox' }, [
      el('div', { class: 'en-answerbox__row' }, [
        el('span', { class: 'en-answerbox__k', text: '你的答案' }),
        el('span', { class: 'en-answerbox__v', text: session.raw || '（直接看了）' }),
      ]),
      el('div', { class: 'en-answerbox__row' }, [
        el('span', { class: 'en-answerbox__k', text: '标准义' }),
        el('span', { class: 'en-answerbox__v', text: w.cn }),
      ]),
      session.auto ? el('div', { class: 'en-auto', text: '机器认为：可能对（还是你自己定）' }) : null,
    ]));
    if (w.collocations && w.collocations.length) {
      card.append(el('ul', { class: 'en-collocs' }, w.collocations.slice(0, 3).map((c) =>
        el('li', { text: c.ph + '　' + c.cn }))));
    }
    if (w.confusions && w.confusions.length) {
      card.append(el('p', { class: 'en-confuse', text: '易混：' + w.confusions[0].diff }));
    }
    card.append(el('div', { class: 'en-card__acts' }, [
      el('button', { class: 'en-btn en-btn--primary', text: '算我会（1）', onclick: () => judge('ok') }),
      el('button', { class: 'en-btn', text: '可能会忘（2）', onclick: () => judge('maybe') }),
      el('button', { class: 'en-btn', text: '没想起来（3）', onclick: () => judge('no') }),
      el('button', { class: 'en-btn', text: '讲一下', onclick: () => explainCurrent(w) }),
      el('button', { class: 'en-btn', text: '收进错题本', onclick: () => toWrongbook(w) }),
    ]));
    const noteBox = el('div', { class: 'en-note', id: 'en-note', text: recNow.note || '' });
    card.append(noteBox);
  }

  dom.main.append(card);
  const input = byId('en-answer');
  if (input) input.focus();
}

function submitAnswer(skip) {
  const w = currentWord();
  if (!w) return;
  if (!skip) {
    const input = byId('en-answer');
    const raw = input ? input.value.trim() : '';
    if (!raw) { toast('先写点什么，或点「想不起来，直接看」', ''); return; }
    session.raw = raw;
    session.auto = modeFor(w) === 'en2cn' ? matchMeaning(raw, w.cn) : norm(raw) === norm(w.w);
  } else {
    session.raw = '';
    session.auto = false;
  }
  session.revealed = true;
  render();
}

function judge(grade) {
  const w = currentWord();
  if (!w) return;
  const e = englishState();
  const rec = recordOf(w.id);
  const today = todayKey();
  const firstTime = !rec.seen;
  rec.seen++;
  rec.lastAt = Date.now();
  const pass = grade === 'ok';
  if (pass) {
    if (rec.lastDay !== today) {
      rec.marks = Math.min(5, rec.marks + 1);
      rec.lastDay = today;
    }
    if (rec.marks >= 5) { rec.learned = true; rec.dueAt = 0; session.graduated++; }
    else rec.dueAt = dueStamp(e.prefs.cadenceDays);
    session.passed++;
  } else if (grade === 'maybe') {
    // 想起来了但没底：这次不给斜杠，明天就再来一遍
    rec.shaky = (rec.shaky || 0) + 1;
    rec.dueAt = dueStamp(1);
    session.maybe = (session.maybe || 0) + 1;
  } else {
    rec.miss = (rec.miss || 0) + 1;
    rec.dueAt = dueStamp(1);
    session.failed++;
  }
  bumpDay(pass ? 'pass' : (grade === 'maybe' ? 'maybe' : 'fail'), rec.learned && firstTime ? 1 : 0);
  if (firstTime) e.session.newLearned = (e.session.newLearned || 0) + 1;
  store.touch({ type: 'english' });
  session.i++;
  session.revealed = false;
  session.raw = '';
  session.auto = false;
  render();
}

async function explainCurrent(w) {
  const rec = recordOf(w.id);
  const box = byId('en-note');
  if (!box) return;
  if (rec.note) { box.textContent = rec.note; return; }
  if (autoExplained[w.id]) { toast('正在讲，稍等', ''); return; }
  autoExplained[w.id] = true;
  box.textContent = '先生正在讲…';
  try {
    const text = await explainWord(w, (delta) => { box.textContent = (box.textContent === '先生正在讲…' ? '' : box.textContent) + delta; });
    rec.note = text || box.textContent;
    store.touch({ type: 'english' });
  } catch (err) {
    box.textContent = '没能问到：' + (err && err.message || '未知错误');
  } finally {
    autoExplained[w.id] = false;
  }
}

function toWrongbook(w) {
  const rec = englishState().words[w.id] || {};
  store.addWrong({
    question: w.w + (w.pos ? ' (' + w.pos + ')' : ''),
    mine: '',
    right: w.cn,
    analysis: (w.collocations || []).map((c) => c.ph + ' ' + c.cn).join('；'),
    subjectId: 'english',
    sectionId: null,
    sectionLabel: '英语 · 词汇',
    tags: ['英语', '词汇'],
    source: 1,
  });
  toast('已收进错题本', 'ok');
}


/* ---------------------------- 固定搭配 10 题 ---------------------------- */
function activeChunkGroups() { return new Set(englishState().prefs.chunkGroups); }

/** 搭配队列：先到期，再补新搭配；受档位（动词/介词）过滤 */
export function chunkQueue() {
  const e = englishState();
  const on = activeChunkGroups();
  const due = [];
  const fresh = [];
  for (const c of (DATA.chunks || [])) {
    if (!on.has(chunkGroupOf(c))) continue;
    const r = e.chunks[c.id];
    if (r && r.learned) continue;
    if (r && r.seen) { if (r.dueAt <= dayStart() + 20 * 3600000) due.push(c); }
    else fresh.push(c);
  }
  due.sort((a, b) => ((e.chunks[a.id] || {}).dueAt || 0) - ((e.chunks[b.id] || {}).dueAt || 0));
  return due.concat(fresh).slice(0, 10);
}

export function chunkDueCount() {
  const e = englishState();
  const on = activeChunkGroups();
  let n = 0;
  for (const c of (DATA.chunks || [])) {
    if (!on.has(chunkGroupOf(c))) continue;
    const r = e.chunks[c.id];
    if (r && r.seen && !r.learned && r.dueAt <= dayStart() + 20 * 3600000) n++;
  }
  return n;
}

function chunkLearnedCount() {
  const e = englishState();
  return (DATA.chunks || []).filter((c) => (e.chunks[c.id] || {}).learned).length;
}

function chunkState() {
  const e = englishState();
  if (!e.chunks || typeof e.chunks !== 'object') e.chunks = {};
  return e.chunks;
}

function startChunk(force) {
  const queue = force
    ? (DATA.chunks || []).slice().sort(() => Math.random() - 0.5).slice(0, 10)
    : chunkQueue();
  session = { queue, i: 0, revealed: false, raw: '', auto: false, passed: 0, failed: 0, graduated: 0, kind: 'chunk' };
  tab = 'chunk';
  render();
}

function chunkChips() {
  const box = el('div', { class: 'en-levels' });
  const on = activeChunkGroups();
  for (const gp of CHUNK_GROUPS) {
    const n = (DATA.chunks || []).filter((c) => chunkGroupOf(c) === gp.id).length;
    box.append(el('button', {
      class: 'en-level' + (on.has(gp.id) ? ' is-on' : ''), title: gp.desc || '', dataset: { group: gp.id },
      onclick: () => toggleChunkGroup(gp.id),
    }, [el('span', { text: gp.name }), el('span', { class: 'en-level__n', text: String(n) })]));
  }
  return box;
}

function toggleChunkGroup(id) {
  const e = englishState();
  const has = e.prefs.chunkGroups.indexOf(id) >= 0;
  if (has && e.prefs.chunkGroups.length === 1) { toast('至少留一档', ''); return; }
  e.prefs.chunkGroups = has ? e.prefs.chunkGroups.filter((x) => x !== id) : e.prefs.chunkGroups.concat([id]);
  store.touch({ type: 'english' });
  session = null;
  render();
}

function renderChunk() {
  if (!session || session.kind !== 'chunk') { startChunk(); return; }
  const total = session.queue.length;
  const c = session.queue[session.i];
  const head = el('div', { class: 'en-vocabhead' }, [
    el('span', { class: 'en-progress', text: total ? ('搭配 ' + Math.min(session.i + 1, total) + ' / ' + total) : '今天的搭配都复习完了' }),
    el('span', { class: 'en-hint', text: '看中文，写出固定搭配；写不出来就点「直接看」' }),
    el('span', { class: 'en-hint', text: '和单词同一套：想起来 +1，满 5 次毕业' }),
  ]);
  dom.main.append(head);
  dom.main.append(chunkChips());

  if (!c) {
    dom.main.append(el('div', { class: 'en-empty' }, [
      el('p', { text: '这一轮完成了。' }),
      el('p', { class: 'en-hint', text: '对 ' + session.passed + ' · 错 ' + session.failed + ' · 新毕业 ' + session.graduated + '。错的已进错题本。' }),
      el('div', { class: 'en-card__acts' }, [
        el('button', { class: 'en-btn en-btn--primary', text: '加练一组', onclick: () => startChunk(true) }),
        el('button', { class: 'en-btn', text: '回板块', onclick: () => go('blocks') }),
      ]),
    ]));
    return;
  }

  const card = el('div', { class: 'en-wordcard' });
  if (!session.revealed) {
    card.append(el('div', { class: 'en-word en-word--small', text: c.cn }));
    card.append(el('div', { class: 'en-word__pos', text: (c.type || '固定搭配') + '　·　' + (chunkGroupOf(c) === 'prep' ? '介词连词短语' : '动词搭配') }));
    card.append(bar((chunkState()[c.id] || {}).marks || 0));
    const inp = el('input', { class: 'input en-input', id: 'en-chunk-answer', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '写出英文搭配' });
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submitChunk(); } });
    card.append(inp);
    card.append(el('div', { class: 'en-card__acts' }, [
      el('button', { class: 'en-btn en-btn--primary', text: '提交', onclick: () => submitChunk() }),
      el('button', { class: 'en-btn', text: '直接看', onclick: () => submitChunk(true) }),
    ]));
  } else {
    card.append(el('div', { class: 'en-word en-word--small', text: c.ph }));
    card.append(el('div', { class: 'en-word__pos', text: c.cn }));
    if (c.note) card.append(el('p', { class: 'en-confuse', text: c.note }));
    if (c.example) card.append(el('p', { class: 'en-note', text: c.example.en + (c.example.cn ? '　' + c.example.cn : '') }));
    card.append(el('div', { class: 'en-answerbox' }, [
      el('div', { class: 'en-answerbox__row' }, [
        el('span', { class: 'en-answerbox__k', text: '你的答案' }),
        el('span', { class: 'en-answerbox__v', text: session.raw || '（直接看了）' }),
      ]),
      session.auto ? el('div', { class: 'en-auto', text: '机器认为：可能对（还是你自己定）' }) : null,
    ]));
    card.append(el('div', { class: 'en-card__acts' }, [
      el('button', { class: 'en-btn en-btn--primary', text: '算我会（1）', onclick: () => judgeChunk('ok') }),
      el('button', { class: 'en-btn', text: '可能会忘（2）', onclick: () => judgeChunk('maybe') }),
      el('button', { class: 'en-btn', text: '没想起来（3）', onclick: () => judgeChunk('no') }),
      el('button', { class: 'en-btn', text: '收进错题本', onclick: () => chunkToWrongbook(c) }),
    ]));
  }
  dom.main.append(card);
  const i2 = byId('en-chunk-answer');
  if (i2) i2.focus();
}

function submitChunk(skip) {
  const c = session && session.queue[session.i];
  if (!c) return;
  if (!skip) {
    const raw = (byId('en-chunk-answer') || {}).value || '';
    if (!raw.trim()) { toast('先写点什么，或点「直接看」', ''); return; }
    session.raw = raw.trim();
    session.auto = norm(session.raw) === norm(c.ph);
  } else {
    session.raw = '';
    session.auto = false;
  }
  session.revealed = true;
  render();
}

function judgeChunk(grade) {
  const c = session && session.queue[session.i];
  if (!c) return;
  const e = englishState();
  const st = chunkState();
  const rec = st[c.id] || { marks: 0, dueAt: 0, seen: 0, miss: 0, learned: false, lastDay: '', lastAt: 0 };
  const today = todayKey();
  const pass = grade === 'ok';
  rec.seen = (rec.seen || 0) + 1;
  rec.lastAt = Date.now();
  if (pass) {
    if (rec.lastDay !== today) { rec.marks = Math.min(5, (rec.marks || 0) + 1); rec.lastDay = today; }
    if (rec.marks >= 5) { rec.learned = true; rec.dueAt = 0; session.graduated++; }
    else rec.dueAt = dueStamp(e.prefs.cadenceDays);
    session.passed++;
  } else if (grade === 'maybe') {
    rec.shaky = (rec.shaky || 0) + 1;
    rec.dueAt = dueStamp(1);
    session.maybe = (session.maybe || 0) + 1;
  } else {
    rec.miss = (rec.miss || 0) + 1;
    rec.dueAt = dueStamp(1);
    session.failed++;
    chunkToWrongbook(c, true);
  }
  bumpDay(pass ? 'pass' : (grade === 'maybe' ? 'maybe' : 'fail'), 0);
  st[c.id] = rec;
  store.touch({ type: 'english' });
  session.i++;
  session.revealed = false;
  session.raw = '';
  session.auto = false;
  render();
}

function chunkToWrongbook(c, silent) {
  store.addWrong({
    question: c.cn + '（搭配）',
    mine: '',
    right: c.ph,
    analysis: (c.note || '') + (c.example ? '　例：' + c.example.en : ''),
    subjectId: 'english',
    sectionId: null,
    sectionLabel: '英语 · 固定搭配',
    tags: ['英语', '搭配'],
    source: 1,
  });
  if (!silent) toast('已收进错题本', 'ok');
}

/* ---------------------------- 导入 / 导出 ---------------------------- */
function renderImport() {
  dom.main.innerHTML = '';
  if (dom.title) dom.title.textContent = '英语 · 导入词表';
  const ta = el('textarea', {
    class: 'en-textarea', id: 'en-import', spellcheck: 'false',
    placeholder: '一行一个。三种写法都行：\nword\nword 中文义\nword,pos,中文义',
  });
  dom.main.append(el('div', { class: 'en-import' }, [
    el('p', { class: 'en-hint', text: '粘贴你要背的词；重复的会自动跳过。导入的词和内置词同一套复习流程。' }),
    ta,
    el('div', { class: 'en-card__acts' }, [
      el('button', { class: 'en-btn en-btn--primary', text: '导入', onclick: () => doImport(ta) }),
      el('button', { class: 'en-btn', text: '取消', onclick: () => { session = null; go('blocks'); } }),
    ]),
  ]));
  ta.focus();
}

function doImport(ta) {
  const text = ta && ta.value || '';
  const e = englishState();
  const known = new Set(allWords().map((w) => w.w.toLowerCase()));
  let added = 0, skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    let w = '', pos = '', cn = '';
    if (raw.indexOf(',') >= 0) {
      const f = raw.split(',');
      w = (f[0] || '').trim();
      pos = (f[1] || '').trim();
      cn = (f.slice(2).join(',') || '').trim();
    } else {
      const m = raw.match(/^([A-Za-z][A-Za-z'\- ]*?)\s+(.+)$/);
      if (m) { w = m[1].trim(); cn = m[2].trim(); }
      else w = raw;
    }
    if (!w) continue;
    if (known.has(w.toLowerCase())) { skipped++; continue; }
    known.add(w.toLowerCase());
    e.userWords.push({
      id: 'u-' + w.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      w,
      pos,
      cn: cn || '（待补中文义）',
      band: 'user',
      level: 'user',
      addedBy: 'user',
      collocations: [],
      confusions: [],
    });
    added++;
  }
  store.touch({ type: 'english' });
  toast('导入 ' + added + ' 个' + (skipped ? '，跳过重复 ' + skipped + ' 个' : ''), 'ok');
  session = null;
  go('blocks');
}

function download(name, text) {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (err) { /* ignore */ } }, 1000);
    toast('已导出 ' + name, 'ok');
  } catch (err) {
    toast('导出失败：' + (err && err.message || ''), 'err');
  }
}

function exportEnglishOnly() {
  const words = allWords().map((w) => w.w).sort((a, b) => a.localeCompare(b));
  download('english-words.txt', words.join('\n') + '\n');
}

/* ---------------------------- 作文：写 ---------------------------- */
function promptOf(id) {
  return DATA.prompts.find((p) => p.id === id) || null;
}

function renderWrite() {
  const e = englishState();
  const d = e.draft;
  if (!d.promptId && DATA.prompts.length) d.promptId = DATA.prompts[0].id;
  const p = promptOf(d.promptId) || DATA.prompts[0];

  dom.main.append(el('div', { class: 'en-tabs' }, [
    tabBtn('写', 'write'), tabBtn('表达库', 'vault'), tabBtn('问题池', 'issues'), tabBtn('复盘', 'review'), tabBtn('进度', 'progress'),
  ]));

  const left = el('div', { class: 'en-write__left' });
  const right = el('div', { class: 'en-write__right' });

  if (p) {
    const sel = el('select', { class: 'input en-select', id: 'en-prompt' });
    for (const it of DATA.prompts) {
      const extra = it.kind === 'cont'
        ? ' · ' + [it.emotion, it.setting].filter(Boolean).join(' / ')
        : '';
      sel.append(el('option', { value: it.id, text: (it.kind === 'app' ? '应用文 · ' : '续写 · ') + it.title + extra }));
    }
    sel.value = p.id;
    sel.addEventListener('change', () => {
      e.draft.promptId = sel.value;
      store.touch({ type: 'english' });
      render();
    });
    left.append(sel);
    left.append(el('div', { class: 'en-prompt' }, [
      el('p', { class: 'en-prompt__scenario', text: p.scenario }),
      el('ul', { class: 'en-prompt__points' }, p.points.map((x) => el('li', { text: x }))),
      el('p', { class: 'en-hint', text: '字数 ' + p.words + ' · 建议 ' + p.minutes + ' 分钟' + (p.traps && p.traps.length ? ' · 易错：' + p.traps[0] : '') }),
    ]));
  }

  const skel = el('div', { class: 'en-skel' }, [
    el('p', { class: 'en-hint', text: '骨架先行（60 秒，可跳过）：目的 / 要点 / 收束，用中文或短语写。' }),
  ]);
  for (let i = 0; i < 3; i++) {
    const inp = el('input', { class: 'input en-skel__line', id: 'en-skel-' + i, value: d.skeleton[i] || '', placeholder: ['目的/开头', '要点一（+要点二）', '收束/期待'][i] });
    inp.addEventListener('input', () => { d.skeleton[i] = inp.value; store.touch({ type: 'english' }); });
    skel.append(inp);
  }
  left.append(skel);

  const ta = el('textarea', { class: 'en-textarea en-textarea--write', id: 'en-text', spellcheck: 'false', placeholder: '在这里写…（Ctrl+S 存草稿）' });
  ta.value = d.text || '';
  ta.addEventListener('input', () => {
    d.text = ta.value;
    store.touch({ type: 'english' });
    updateMeter();
  });
  left.append(ta);

  const meter = el('div', { class: 'en-meter', id: 'en-meter' });
  const timerText = el('span', { class: 'en-timer', id: 'en-timer', text: fmtTimer() });
  left.append(el('div', { class: 'en-writebar' }, [
    meter, timerText,
    el('button', { class: 'en-btn', text: '开始计时', onclick: () => { startTimer(); render(); } }),
    el('button', { class: 'en-btn', text: '停止', onclick: () => { stopTimer(); render(); } }),
    el('button', { class: 'en-btn', text: '存草稿', onclick: () => { store.touch({ type: 'english' }); toast('草稿已保存', 'ok'); } }),
    el('button', { class: 'en-btn en-btn--primary', text: busy ? '先生在看…' : '请先生看', onclick: askReview }),
  ]));

  right.append(el('p', { class: 'en-hint', text: '批改只从你写的句子出发：不改写成范文，只指出问题、给三条「用你自己的词」的升级。' }));
  if (result) renderResult(right, result);
  else right.append(el('div', { class: 'en-empty' }, [
    el('p', { text: '写完点「请先生看」，会得到三样东西：' }),
    el('ul', { class: 'en-prompt__points' }, [
      el('li', { text: '四行分数（内容 / 语言 / 结构 / 总分）' }),
      el('li', { text: '逐句问题，每条都引你的原文' }),
      el('li', { text: '三条只用你自己词汇的升级句' }),
    ]),
    el('p', { class: 'en-hint', text: '不会给范文，也不会给万能句。' }),
  ]));

  dom.main.append(el('div', { class: 'en-write' }, [left, right]));
  updateMeter();
  if (timer.on) startTick();
}

function tabBtn(label, key) {
  return el('button', {
    class: 'en-tab' + (tab === key ? ' is-on' : ''),
    text: label,
    onclick: () => goTab(key),
  });
}

function updateMeter() {
  const ta = byId('en-text');
  const box = byId('en-meter');
  if (!ta || !box) return;
  const words = countWords(ta.value);
  box.textContent = words + ' 词';
  box.dataset.ok = words >= 70 ? '1' : '0';
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function fmtTimer() {
  const ms = timer.base + (timer.on ? Date.now() - timer.startAt : 0);
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

function startTimer() {
  if (timer.on) return;
  timer.on = true;
  timer.startAt = Date.now();
  startTick();
}
function stopTimer() {
  if (!timer.on) return;
  timer.base += Date.now() - timer.startAt;
  timer.on = false;
  clearInterval(timer.tick);
  timer.tick = 0;
}
function startTick() {
  clearInterval(timer.tick);
  timer.tick = setInterval(() => {
    const t = byId('en-timer');
    if (t) t.textContent = fmtTimer();
    else { clearInterval(timer.tick); timer.tick = 0; }
  }, 1000);
}
function timerTotal() { return timer.base + (timer.on ? Date.now() - timer.startAt : 0); }

async function askReview() {
  if (busy) return;
  const e = englishState();
  const d = e.draft;
  const ta = byId('en-text');
  const text = (ta ? ta.value : d.text || '').trim();
  if (!text) { toast('先写点东西', ''); return; }
  const p = promptOf(d.promptId);
  busy = true;
  render();
  try {
    const review = await reviewEssay({
      kind: p ? p.kind : 'app',
      title: p ? p.title : '',
      scenario: p ? p.scenario : '',
      points: p ? p.points : [],
      traps: p ? p.traps : [],
      text,
      target: p ? p.words : '',
    });
    const essay = {
      id: 'e-' + Date.now().toString(36),
      promptId: d.promptId,
      title: p ? p.title : '自由写作',
      kind: p ? p.kind : 'app',
      text,
      words: countWords(text),
      timing: { total: Math.round(timerTotal() / 1000), phases: null },
      focus: [],
      score: review.score || null,
      review,
      stats: review.stats || null,
      vaultUsed: [],
      createdAt: Date.now(),
    };
    e.essays.unshift(essay);
    for (const it of (review.issues || [])) {
      e.issues.unshift({ id: 'i-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: it.type || '其他', quote: it.quote || '', fix: it.fix || '', essayId: essay.id, at: Date.now() });
    }
    d.text = '';
    d.skeleton = ['', '', ''];
    timer = { on: false, startAt: 0, base: 0, tick: 0 };
    store.touch({ type: 'english' });
    result = { essay, review, candidates: null };
    toast('批改完成', 'ok');
  } catch (err) {
    toast('批改失败：' + (err && err.message || '先生没看懂格式'), 'err');
  } finally {
    busy = false;
    render();
  }
}

function renderResult(box, r) {
  const rv = r.review || {};
  const sc = rv.score || r.essay.score || {};
  const rows = [['内容', sc.content], ['语言', sc.language], ['结构', sc.structure], ['总分', sc.total]];
  box.append(el('div', { class: 'en-score' }, rows.map(([k, v]) =>
    el('div', { class: 'en-score__row' }, [
      el('span', { class: 'en-score__k', text: k }),
      el('span', { class: 'en-score__bar' }, [el('i', { style: { width: Math.max(0, Math.min(100, Number(v) || 0)) + '%' } })]),
      el('span', { class: 'en-score__v', text: String(v == null ? '—' : v) }),
    ]))));

  if (rv.issues && rv.issues.length) {
    box.append(el('p', { class: 'en-sub', text: '问题' }));
    box.append(el('ul', { class: 'en-issues' }, rv.issues.map((it) =>
      el('li', { class: 'en-issue' }, [
        el('span', { class: 'en-issue__type', text: it.type || '问题' }),
        el('span', { class: 'en-issue__quote', text: '「' + (it.quote || '') + '」' }),
        el('span', { class: 'en-issue__fix', text: it.fix || '' }),
      ]))));
  }

  if (rv.upgrades && rv.upgrades.length) {
    box.append(el('p', { class: 'en-sub', text: '用你自己的词升级' }));
    box.append(el('ul', { class: 'en-upgrades' }, rv.upgrades.map((u) =>
      el('li', { class: 'en-upgrade' + (u.weak ? ' is-weak' : '') }, [
        el('span', { class: 'en-upgrade__from', text: u.from || '' }),
        el('span', { class: 'en-upgrade__arrow', text: '→' }),
        el('span', { class: 'en-upgrade__to', text: u.to || '' }),
        el('span', { class: 'en-upgrade__why', text: u.weak ? '（原文里找不到这句，已降级为方向提示）' : (u.why || '') }),
      ]))));
  }

  if (rv.nextTip) box.append(el('p', { class: 'en-tip', text: '下一步只改一件事：' + rv.nextTip }));

  const acts = el('div', { class: 'en-card__acts' });
  acts.append(el('button', { class: 'en-btn', text: '提取可复用表达', onclick: () => doExtract(r) }));
  acts.append(el('button', { class: 'en-btn', text: '再来一题', onclick: () => { result = null; render(); } }));
  box.append(acts);

  if (r.candidates) {
    box.append(el('p', { class: 'en-sub', text: '候选表达（来自你自己的句子）' }));
    box.append(el('ul', { class: 'en-cands' }, r.candidates.map((c) =>
      el('li', { class: 'en-cand' }, [
        el('span', { class: 'en-cand__en', text: c.en || '' }),
        el('span', { class: 'en-cand__cn', text: c.cn || '' }),
        el('button', { class: 'en-btn en-btn--mini', text: '入库', onclick: () => addVault(c) }),
      ]))));
  }
}

async function doExtract(r) {
  const ta = $('.en-textarea--write');
  const text = (r.essay && r.essay.text) || (ta ? ta.value : '');
  if (!text) { toast('没有原文', ''); return; }
  try {
    const out = await extractVault({ text });
    r.candidates = (out.candidates || []).slice(0, 5);
    render();
  } catch (err) {
    toast('提取失败：' + (err && err.message || ''), 'err');
  }
}

function addVault(c) {
  const e = englishState();
  e.vault.unshift({
    id: 'v-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    en: c.en || '', cn: c.cn || '',
    func: c.func || '通用', structure: c.structure || '普通句', scene: c.scene || '通用',
    source: 'essay', uses: 0, lastUsedAt: 0, createdAt: Date.now(),
  });
  store.touch({ type: 'english' });
  toast('已入库', 'ok');
  render();
}

/* ---------------------------- 表达库 ---------------------------- */
function renderVault() {
  dom.main.append(el('div', { class: 'en-tabs' }, [
    tabBtn('写', 'write'), tabBtn('表达库', 'vault'), tabBtn('问题池', 'issues'), tabBtn('复盘', 'review'), tabBtn('进度', 'progress'),
  ]));
  const e = englishState();
  const q = el('input', { class: 'input en-search', id: 'en-vault-q', placeholder: '搜你的句子（英文或中文）' });
  q.addEventListener('input', () => paintVaultList());
  const en = el('input', { class: 'input', id: 'en-vault-en', placeholder: '英文句子' });
  const cn = el('input', { class: 'input', id: 'en-vault-cn', placeholder: '中文说明（这条好在哪）' });
  const funcSel = el('select', { class: 'input en-select', id: 'en-vault-func' }, FUNCS.map((f) => el('option', { value: f, text: f })));
  const strSel = el('select', { class: 'input en-select', id: 'en-vault-struct' }, STRUCTS.map((s) => el('option', { value: s, text: s })));
  const body = el('div', { class: 'en-vault', id: 'en-vault-list' });

  dom.main.append(el('div', { class: 'en-panel' }, [
    el('div', { class: 'en-vault__add' }, [en, cn, funcSel, strSel,
      el('button', { class: 'en-btn en-btn--primary', text: '加一条', onclick: () => {
        if (!en.value.trim()) { toast('先写句子', ''); return; }
        addVault({ en: en.value.trim(), cn: cn.value.trim(), func: funcSel.value, structure: strSel.value });
        en.value = ''; cn.value = '';
      } })]),
    q,
    body,
  ]));
  paintVaultList();
  function paintVaultList() {
    const box = byId('en-vault-list');
    if (!box) return;
    const kw = (byId('en-vault-q') || {}).value || '';
    const list = e.vault.filter((v) => !kw || (v.en + ' ' + v.cn).toLowerCase().indexOf(kw.toLowerCase()) >= 0);
    box.innerHTML = '';
    if (!list.length) { box.append(el('p', { class: 'en-hint', text: '还没有表达卡。写一篇、点「提取可复用表达」，或直接在上面手动加。' })); return; }
    for (const v of list) {
      box.append(el('div', { class: 'en-vcard' }, [
        el('div', { class: 'en-vcard__en', text: v.en }),
        el('div', { class: 'en-vcard__cn', text: v.cn || '' }),
        el('div', { class: 'en-vcard__meta' }, [
          el('span', { class: 'en-chip', text: v.func || '通用' }),
          el('span', { class: 'en-chip', text: v.structure || '普通句' }),
          el('span', { class: 'en-hint', text: '用过 ' + (v.uses || 0) + ' 次' }),
          el('button', { class: 'en-btn en-btn--mini', text: '用过', onclick: () => { v.uses = (v.uses || 0) + 1; v.lastUsedAt = Date.now(); store.touch({ type: 'english' }); paintVaultList(); } }),
          el('button', { class: 'en-btn en-btn--mini', text: '删', onclick: () => { e.vault = e.vault.filter((x) => x.id !== v.id); store.touch({ type: 'english' }); paintVaultList(); } }),
        ]),
      ]));
    }
  }
}

/* ---------------------------- 问题池 ---------------------------- */
function renderIssues() {
  dom.main.append(el('div', { class: 'en-tabs' }, [
    tabBtn('写', 'write'), tabBtn('表达库', 'vault'), tabBtn('问题池', 'issues'), tabBtn('复盘', 'review'), tabBtn('进度', 'progress'),
  ]));
  const e = englishState();
  const counts = {};
  for (const it of e.issues) counts[it.type || '其他'] = (counts[it.type || '其他'] || 0) + 1;
  const types = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const box = el('div', { class: 'en-panel' });
  if (!types.length) {
    box.append(el('p', { class: 'en-hint', text: '还没有问题记录。写一篇、批改一次，问题会自动汇总到这里。' }));
  } else {
    const max = counts[types[0]] || 1;
    for (const t of types) {
      box.append(el('div', { class: 'en-issuebar' }, [
        el('span', { class: 'en-issuebar__t', text: t }),
        el('span', { class: 'en-issuebar__bar' }, [el('i', { style: { width: Math.round(counts[t] / max * 100) + '%' } })]),
        el('span', { class: 'en-issuebar__n', text: String(counts[t]) }),
      ]));
    }
    box.append(el('p', { class: 'en-sub', text: '最近的问题' }));
    for (const it of e.issues.slice(0, 20)) {
      box.append(el('div', { class: 'en-issue' }, [
        el('span', { class: 'en-issue__type', text: it.type || '问题' }),
        el('span', { class: 'en-issue__quote', text: '「' + (it.quote || '') + '」' }),
        el('span', { class: 'en-issue__fix', text: it.fix || '' }),
      ]));
    }
  }
  dom.main.append(box);
}

/* ---------------------------- 复盘 ---------------------------- */
function renderReviewList() {
  dom.main.append(el('div', { class: 'en-tabs' }, [
    tabBtn('写', 'write'), tabBtn('表达库', 'vault'), tabBtn('问题池', 'issues'), tabBtn('复盘', 'review'), tabBtn('进度', 'progress'),
  ]));
  const e = englishState();
  const box = el('div', { class: 'en-panel' });
  if (!e.essays.length) {
    box.append(el('p', { class: 'en-hint', text: '还没有作文记录。' }));
  } else {
    box.append(el('div', { class: 'en-reviewlist' }, e.essays.map((it) =>
      el('div', { class: 'en-reviewrow' }, [
        el('span', { class: 'en-reviewrow__t', text: it.title || '未命名' }),
        el('span', { class: 'en-reviewrow__s', text: (it.score && it.score.total != null ? it.score.total : '—') + ' 分' }),
        el('span', { class: 'en-reviewrow__w', text: (it.words || 0) + ' 词' }),
        el('span', { class: 'en-reviewrow__m', text: Math.round((it.timing && it.timing.total || 0) / 60) + ' 分' }),
        el('span', { class: 'en-reviewrow__d', text: new Date(it.createdAt).toLocaleDateString() }),
      ]))));
  }
  dom.main.append(box);
}


/* ---------------------------- 总进度 ---------------------------- */
function vocabProgress() {
  const e = englishState();
  const all = allWords();
  const out = {
    total: all.length, grad: 0, learning: 0, fresh: 0, due: 0, shaky: 0,
    byLevel: {}, shakyList: [], learningList: [], orphans: 0,
  };
  const bankSet = new Set(all.map((w) => w.id));
  out.orphans = Object.keys(e.words || {}).filter((id) => !bankSet.has(id)).length;
  for (const w of all) {
    const r = e.words[w.id];
    const lv = levelOf(w);
    if (!out.byLevel[lv]) out.byLevel[lv] = { total: 0, grad: 0, learning: 0, fresh: 0 };
    const b = out.byLevel[lv];
    b.total++;
    if (r && r.learned) { out.grad++; b.grad++; }
    else if (r && r.seen) {
      out.learning++; b.learning++;
      if (r.dueAt <= dayStart() + 20 * 3600000) out.due++;
      const bad = (r.miss || 0) + (r.shaky || 0);
      if ((r.miss || 0) >= 2 || (r.shaky || 0) >= 2) { out.shaky++; out.shakyList.push({ w, r, bad }); }
      out.learningList.push({ w, r });
    } else { out.fresh++; b.fresh++; }
  }
  out.shakyList.sort((a, b) => b.bad - a.bad);
  out.learningList.sort((a, b) => String(a.r.dueAt || 0).localeCompare(String(b.r.dueAt || 0)));
  const ch = e.chunks || {};
  out.chunkTotal = (DATA.chunks || []).length;
  out.chunkGrad = (DATA.chunks || []).filter((c) => (ch[c.id] || {}).learned).length;
  return out;
}

function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

function progBar(a, b, cls) {
  return el('div', { class: 'en-prog__bar' + (cls ? ' ' + cls : '') }, [
    el('i', { style: { width: Math.max(0, Math.min(100, pct(a, b))) + '%' } }),
  ]);
}

function renderProgress() {
  const e = englishState();
  const p = vocabProgress();
  const goal = e.prefs.goalWords;
  dom.main.append(el('div', { class: 'en-tabs' }, [
    tabBtn('写', 'write'), tabBtn('表达库', 'vault'), tabBtn('问题池', 'issues'), tabBtn('复盘', 'review'), tabBtn('进度', 'progress'),
  ]));

  const box = el('div', { class: 'en-panel en-prog' });
  box.append(el('div', { class: 'en-prog__head' }, [
    el('span', { class: 'en-card__title', text: '词汇总进度' }),
    el('span', { class: 'en-card__tag', text: '词库 ' + p.total + ' 词 · 目标 ' + goal + ' 词' }),
  ]));

  box.append(el('div', { class: 'en-prog__big' }, [
    el('div', { class: 'en-prog__num' }, [
      el('b', { text: String(p.grad) }), el('span', { text: '已毕业' }),
    ]),
    el('div', { class: 'en-prog__num' }, [
      el('b', { text: String(p.learning) }), el('span', { text: '在学' }),
    ]),
    el('div', { class: 'en-prog__num' }, [
      el('b', { text: String(p.fresh) }), el('span', { text: '没开始' }),
    ]),
    el('div', { class: 'en-prog__num' }, [
      el('b', { text: String(p.due) }), el('span', { text: '今天该复习' }),
    ]),
  ]));

  box.append(el('div', { class: 'en-prog__line' }, [
    el('span', { text: '词库：毕业 ' + p.grad + ' / ' + p.total }), progBar(p.grad, p.total),
    el('span', { class: 'en-hint', text: pct(p.grad, p.total) + '%' }),
  ]));
  box.append(el('div', { class: 'en-prog__line' }, [
    el('span', { text: '3500 词目标：' + p.grad + ' / ' + goal }), progBar(p.grad, goal, 'is-goal'),
    el('span', { class: 'en-hint', text: pct(p.grad, goal) + '%' }),
  ]));
  box.append(el('p', { class: 'en-hint', text: p.total >= goal
    ? ('词库 ' + p.total + ' 词，已覆盖 ' + goal + ' 词目标：接下来看毕业率。')
    : ('词库还只有 ' + p.total + ' 词：把草稿本上的词导入进来，分母才会追上 ' + goal + '（导入的词也算进度）。') }));

  // 按档位
  box.append(el('p', { class: 'en-sub', text: '按档位' }));
  for (const lv of LEVELS) {
    const b = p.byLevel[lv.id] || { total: 0, grad: 0, learning: 0, fresh: 0 };
    box.append(el('div', { class: 'en-prog__lv' }, [
      el('span', { class: 'en-prog__lvn', text: lv.name }),
      el('span', { class: 'en-prog__lvs', text: '毕业 ' + b.grad + ' / ' + b.total + '　在学 ' + b.learning + '　没开始 ' + b.fresh }),
      progBar(b.grad, b.total),
    ]));
  }
  if (p.byLevel.user) {
    const b = p.byLevel.user;
    box.append(el('div', { class: 'en-prog__lv' }, [
      el('span', { class: 'en-prog__lvn', text: '导入' }),
      el('span', { class: 'en-prog__lvs', text: '毕业 ' + b.grad + ' / ' + b.total }),
      progBar(b.grad, b.total),
    ]));
  }

  // 搭配
  box.append(el('p', { class: 'en-sub', text: '固定搭配' }));
  box.append(el('div', { class: 'en-prog__line' }, [
    el('span', { text: '毕业 ' + p.chunkGrad + ' / ' + p.chunkTotal }), progBar(p.chunkGrad, p.chunkTotal, 'is-chunk'),
  ]));

  // 最近 7 天
  box.append(el('p', { class: 'en-sub', text: '最近 7 天' }));
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const t = Date.now() - i * 86400000;
    const d = new Date(t);
    const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    days.push({ key, label: (d.getMonth() + 1) + '/' + d.getDate(), rec: e.days[key] || null });
  }
  const maxDay = Math.max(1, ...days.map((x) => x.rec ? ((x.rec.pass || 0) + (x.rec.maybe || 0) + (x.rec.fail || 0)) : 0));
  box.append(el('div', { class: 'en-days' }, days.map((x) => {
    const r = x.rec || {};
    const n = (r.pass || 0) + (r.maybe || 0) + (r.fail || 0);
    return el('div', { class: 'en-day', title: x.key + '：会 ' + (r.pass || 0) + ' · 可能忘 ' + (r.maybe || 0) + ' · 没想起 ' + (r.fail || 0) }, [
      el('div', { class: 'en-day__bar' }, [el('i', { style: { height: Math.max(4, Math.round(n / maxDay * 100)) + '%' } })]),
      el('div', { class: 'en-day__n', text: String(n) }),
      el('div', { class: 'en-day__l', text: x.label }),
    ]);
  })));
  const today = e.days[todayKey()] || {};
  box.append(el('p', { class: 'en-hint', text: '今天：会 ' + (today.pass || 0) + ' · 可能会忘 ' + (today.maybe || 0) + ' · 没想起来 ' + (today.fail || 0) + ' · 新毕业 ' + (today.grad || 0) }));

  // 在学（有记录但今天不到期的也算，明确告诉用户进度还在）
  if (p.learningList.length) {
    box.append(el('p', { class: 'en-sub', text: '在学 ' + p.learningList.length + ' 词（斜杠 / 下次复习）' }));
    box.append(el('ul', { class: 'en-shaky' }, p.learningList.slice(0, 10).map((x) =>
      el('li', { class: 'en-shaky__row' }, [
        el('span', { class: 'en-shaky__w', text: x.w.w }),
        el('span', { class: 'en-hint', text: '斜杠 ' + (x.r.marks || 0) + '/5' }),
        el('span', { class: 'en-hint', text: x.r.dueAt ? ('到期 ' + new Date(x.r.dueAt).toLocaleDateString('zh-CN')) : '—' }),
        el('span', { class: 'en-shaky__cn', text: x.w.cn }),
      ]))));
  }
  if (p.orphans) {
    box.append(el('p', { class: 'en-hint', text: '有 ' + p.orphans + ' 条旧记录对不上当前词库（已保留在存档里，没有删）。换词库时请先备份 data/state.json。' }));
  }

  // 易忘
  if (p.shakyList.length) {
    box.append(el('p', { class: 'en-sub', text: '易忘（错得最多的）' }));
    box.append(el('ul', { class: 'en-shaky' }, p.shakyList.slice(0, 6).map((x) =>
      el('li', { class: 'en-shaky__row' }, [
        el('span', { class: 'en-shaky__w', text: x.w.w }),
        el('span', { class: 'en-shaky__cn', text: x.w.cn }),
        el('span', { class: 'en-hint', text: '错 ' + (x.r.miss || 0) + ' · 虚 ' + (x.r.shaky || 0) }),
      ]))));
  }

  dom.main.append(box);
}

/* ---------------------------- 测试出口 ---------------------------- */
export function englishTestApi() {
  return {
    tab: () => tab,
    path: () => path.slice(),
    session: () => session,
    judge: judge,
    queue: englishQueue,
    state: englishState,
    matchMeaning: matchMeaning,
    countWords: countWords,
  };
}
