/**
 * 云端同步：把整份学习进度上传到这台服务器的 data/sync，或从别的设备那里拉一份回来覆盖本机。
 * 两种模式：
 *   1) 覆盖同步 —— 用云端最新的一份快照覆盖本机（只替换勾选的学科）
 *   2) 替换 —— 用指定设备的快照替换本机（同样只替换勾选的学科）
 * 纯网页模式（GitHub Pages / 本地打开）没有 server，需要在页面里填服务器地址，走 CORS 调过去。
 */
import { $, el, toast } from './util.js';
import { store } from './store.js';
import { CURRICULUM } from './subject.js';
import { isStandalone } from './runtime.js';

const DEVICE_KEY = 'study-room.device';
const SERVER_KEY = 'study-room.sync.server';

let onExit = () => {};
let dom = null;
let state = null;        // 页面级 UI 状态
let busy = false;

/* ---------------------------- 设备身份 ---------------------------- */
function guessName() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return '安卓设备';
  if (/iPhone|iPad/i.test(ua)) return 'iOS 设备';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows 电脑';
  return '某台设备';
}

export function device() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null'); } catch { /* ignore */ }
  if (!d || !d.id) {
    d = {
      id: 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
      name: guessName(),
      platform: String(navigator.userAgent || '').slice(0, 80),
    };
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(d)); } catch { /* ignore */ }
  }
  return d;
}

function saveDevice(patch) {
  const d = Object.assign(device(), patch);
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(d)); } catch { /* ignore */ }
  return d;
}

function serverBase() {
  if (!isStandalone()) return '';
  return String(localStorage.getItem(SERVER_KEY) || '').replace(/\/+$/, '');
}

/* ---------------------------- 统计 ---------------------------- */
function sectionIdsOf(subject) {
  const ids = [];
  for (const v of subject.volumes || []) {
    for (const ch of v.chapters || []) {
      for (const sec of ch.sections || []) if (sec && sec.id) ids.push(sec.id);
    }
  }
  return ids;
}

export function deviceStats(src) {
  const s = src || {};
  const out = { subjects: {}, english: null, updatedAt: Date.now() };
  for (const sub of (CURRICULUM.subjects || [])) {
    if (!sub.volumes || !sub.volumes.length) continue;
    let total = 0, studied = 0, done = 0;
    for (const id of sectionIdsOf(sub)) {
      total++;
      const p = (s.progress || {})[id];
      if (p) { studied++; if (p.status === 'done') done++; }
    }
    out.subjects[sub.id] = { name: sub.name, total, studied, done };
  }
  const en = s.english || {};
  const recs = Object.values(en.words || {});
  out.english = {
    learned: recs.filter((r) => r && r.learned).length,
    learning: recs.filter((r) => r && r.seen && !r.learned).length,
    marks: recs.reduce((a, r) => a + (r.marks || 0), 0),
    chunks: Object.values(en.chunks || {}).filter((r) => r && r.learned).length,
  };
  return out;
}

/* ---------------------------- 计划与落地 ---------------------------- */
/** 从一份快照里挑出要替换进本机的部分（subjects: ['math','physics','biology','english']） */
export function buildRestorePlan(snapshot, subjects) {
  const subs = Array.isArray(subjects) ? subjects : [];
  const snap = snapshot || {};
  const clearIds = [];
  const progress = {};
  for (const sub of (CURRICULUM.subjects || [])) {
    if (subs.indexOf(sub.id) < 0) continue;
    for (const id of sectionIdsOf(sub)) clearIds.push(id);
  }
  for (const [id, p] of Object.entries(snap.progress || {})) {
    if (clearIds.indexOf(id) >= 0) progress[id] = p;
  }
  const wrong = ((snap.wrongbook && snap.wrongbook.items) || []).filter((it) => subs.indexOf(it.subjectId) >= 0);
  const english = subs.indexOf('english') >= 0 && snap.english ? snap.english : null;
  return { subjects: subs, progress, wrongbook: wrong, english, clearIds };
}

/** 把计划落到 state 上：选中的学科「整体替换」，其余学科不动；英语只替换学习记录，保留本机偏好 */
export function applyRestore(target, plan) {
  const s = target;
  for (const id of plan.clearIds) delete s.progress[id];
  Object.assign(s.progress, plan.progress);
  if (plan.wrongbook) {
    s.wrongbook = s.wrongbook || { items: [] };
    s.wrongbook.items = (s.wrongbook.items || []).filter((it) => plan.subjects.indexOf(it.subjectId) < 0)
      .concat(plan.wrongbook.map((it) => JSON.parse(JSON.stringify(it))));
  }
  if (plan.english) {
    const localPrefs = (s.english && s.english.prefs) || {};
    const copy = JSON.parse(JSON.stringify(plan.english));
    copy.prefs = Object.assign({}, copy.prefs || {}, localPrefs);
    s.english = copy;
  }
  return s;
}

/* ---------------------------- 网络 ---------------------------- */
async function syncFetch(path, opts) {
  const base = serverBase();
  const url = (base ? base + '/' : '') + path;
  const res = await fetch(url, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data || data.ok === false) {
    const msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

const listDevices = () => syncFetch('api/sync/devices');
const pullDevice = (id) => syncFetch('api/sync/snapshot?id=' + encodeURIComponent(id));

async function publishSelf() {
  const d = device();
  const stats = deviceStats(store.state);
  const body = { device: d, stats, snapshot: store.state };
  const res = await syncFetch('api/sync/publish', { method: 'POST', body: JSON.stringify(body) });
  return res;
}

/* ---------------------------- 界面 ---------------------------- */
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statLine(st) {
  const parts = [];
  if (st && st.subjects) {
    for (const k of ['math', 'physics', 'biology']) {
      const s = st.subjects[k];
      if (s) parts.push(s.name + ' ' + s.done + '/' + s.total);
    }
  }
  if (st && st.english) parts.push('词汇 ' + st.english.learned + ' 毕业');
  return parts.join(' · ') || '没有统计';
}

function render() {
  if (!dom) return;
  dom.main.innerHTML = '';
  const d = device();

  /* 本机 */
  const selfCard = el('div', { class: 'en-card en-card--wide sync-card', dataset: { sync: 'self' } }, [
    el('div', { class: 'en-card__head' }, [
      el('span', { class: 'en-card__icon', text: '本' }),
      el('span', { class: 'en-card__title', text: '本机' }),
      el('span', { class: 'en-card__tag', text: d.id }),
    ]),
    el('div', { class: 'sync-row' }, [
      el('label', { class: 'sync-label', text: '设备名' }),
      (() => {
        const inp = el('input', { class: 'input sync-input', id: 'sync-name', type: 'text', value: d.name, maxlength: '20' });
        inp.addEventListener('change', () => {
          saveDevice({ name: inp.value.trim() || guessName() });
          state.notice = '设备名已更新';
          render();
        });
        return inp;
      })(),
    ]),
    el('p', { class: 'en-hint', text: '平台：' + (d.platform || '未知') + '　·　数据：' + (isStandalone() ? '本浏览器 IndexedDB' : '这台服务器的 data/state.json') }),
    el('p', { class: 'en-card__meta', text: statLine(deviceStats(store.state)) }),
    el('div', { class: 'en-card__acts' }, [
      el('button', { class: 'en-btn en-btn--primary', text: '上传本机进度到云端', onclick: () => doPublish() }),
      el('button', { class: 'en-btn', text: '下载本机存档（备份）', onclick: downloadBackup }),
    ]),
  ]);
  dom.main.append(selfCard);

  /* 纯网页模式：服务器地址 */
  if (isStandalone()) {
    dom.main.append(el('div', { class: 'en-card en-card--wide sync-card', dataset: { sync: 'server' } }, [
      el('div', { class: 'en-card__head' }, [
        el('span', { class: 'en-card__icon', text: '云' }),
        el('span', { class: 'en-card__title', text: '云端地址' }),
      ]),
      el('p', { class: 'en-hint', text: '纯网页模式没有自己的服务端，这里要填那台跑 node server.js 的电脑地址（同一局域网即可），例如 http://192.168.1.5:8787。' }),
      (() => {
        const inp = el('input', { class: 'input sync-input', id: 'sync-server', type: 'text', placeholder: 'http://192.168.1.5:8787', value: serverBase() });
        inp.addEventListener('change', () => {
          localStorage.setItem(SERVER_KEY, inp.value.trim());
          state.notice = '云端地址已保存';
          refreshDevices();
        });
        return inp;
      })(),
    ]));
  }

  /* 云端设备 */
  const devCard = el('div', { class: 'en-card en-card--wide sync-card', dataset: { sync: 'devices' } }, [
    el('div', { class: 'en-card__head' }, [
      el('span', { class: 'en-card__icon', text: '云' }),
      el('span', { class: 'en-card__title', text: '云端设备' }),
      el('span', { class: 'en-card__tag', text: state.loading ? '读取中…' : (state.devices || []).length + ' 台' }),
    ]),
  ]);
  if (!state.devices || !state.devices.length) {
    devCard.append(el('p', { class: 'en-hint', text: state.loading ? '正在读取…' : '云端还没有任何设备。先在每台设备上点一次「上传本机进度到云端」。' }));
  } else {
    for (const dev of state.devices) {
      const isSelf = dev.id === d.id;
      const row = el('div', { class: 'sync-dev' + (state.picked === dev.id ? ' is-on' : ''), dataset: { device: dev.id } }, [
        el('span', { class: 'sync-dev__name', text: dev.name + (isSelf ? '（本机）' : '') }),
        el('span', { class: 'sync-dev__meta', text: fmtTime(dev.updatedAt) + ' · ' + Math.round((dev.bytes || 0) / 1024) + ' KB' }),
        el('span', { class: 'sync-dev__stats', text: statLine(dev.stats) }),
        isSelf ? el('span', { class: 'en-hint', text: '当前设备' }) : el('button', {
          class: 'en-btn', text: state.picked === dev.id ? '已选中' : '选中它',
          onclick: () => { state.picked = dev.id; state.mode = 'pick'; render(); },
        }),
      ]);
      devCard.append(row);
    }
  }
  devCard.append(el('div', { class: 'en-card__acts' }, [
    el('button', { class: 'en-btn', text: '刷新设备列表', onclick: () => refreshDevices() }),
  ]));
  dom.main.append(devCard);

  /* 同步方式 */
  const subjects = [
    { id: 'math', name: '数学' }, { id: 'physics', name: '物理' },
    { id: 'biology', name: '生物' }, { id: 'english', name: '英语' },
  ];
  const chips = el('div', { class: 'en-levels' }, subjects.map((sub) => el('button', {
    class: 'en-level' + (state.subjects.indexOf(sub.id) >= 0 ? ' is-on' : ''),
    dataset: { subject: sub.id },
    onclick: () => {
      const i = state.subjects.indexOf(sub.id);
      if (i >= 0) { if (state.subjects.length === 1) { toast('至少留一科', ''); return; } state.subjects.splice(i, 1); }
      else state.subjects.push(sub.id);
      render();
    },
  }, [el('span', { text: sub.name })])));

  const modeRow = el('div', { class: 'sync-modes' }, [
    el('button', {
      class: 'en-btn' + (state.mode === 'latest' ? ' en-btn--primary' : ''), dataset: { mode: 'latest' },
      text: '① 覆盖同步：用云端最新覆盖本机', onclick: () => { state.mode = 'latest'; render(); },
    }),
    el('button', {
      class: 'en-btn' + (state.mode === 'pick' ? ' en-btn--primary' : ''), dataset: { mode: 'pick' },
      text: '② 替换：用选中设备替换本机', onclick: () => { state.mode = 'pick'; render(); },
    }),
  ]);

  const planCard = el('div', { class: 'en-card en-card--wide sync-card', dataset: { sync: 'plan' } }, [
    el('div', { class: 'en-card__head' }, [
      el('span', { class: 'en-card__icon', text: '换' }),
      el('span', { class: 'en-card__title', text: '同步方式' }),
    ]),
    el('p', { class: 'en-hint', text: state.notice || '选一种方式，勾选要同步的学科，然后点下面的按钮。同步前会自动把本机存档下载一份。' }),
    modeRow,
    el('p', { class: 'en-sub', text: '要同步的学科' }),
    chips,
    el('div', { class: 'en-card__acts' }, [
      el('button', {
        class: 'en-btn en-btn--primary', id: 'sync-go',
        text: state.confirm ? '确认替换本机进度' : '开始同步',
        onclick: () => (state.confirm ? doRestore() : askRestore()),
      }),
      state.confirm ? el('button', { class: 'en-btn', text: '取消', onclick: () => { state.confirm = null; render(); } }) : null,
    ]),
  ]);
  if (state.plan) {
    planCard.append(el('p', { class: 'en-hint', text: '将替换：' + state.plan.summary }));
  }
  dom.main.append(planCard);

  dom.main.append(el('p', { class: 'en-hint sync-foot', text: '同步只换「进度 / 错题 / 英语学习记录」，不动这台设备的模型配置、访问口令和界面偏好。' }));
}

async function refreshDevices() {
  if (!dom) return;
  state.loading = true;
  render();
  try {
    const data = await listDevices();
    state.devices = data.devices || [];
    state.notice = '';
  } catch (e) {
    state.devices = [];
    state.notice = '读不到云端：' + (e && e.message || e) + (isStandalone() ? '（检查上面的云端地址）' : '');
  } finally {
    state.loading = false;
    render();
  }
}

async function doPublish() {
  if (busy) return;
  busy = true;
  state.notice = '正在上传…';
  render();
  try {
    await store.flushNow();
    const res = await publishSelf();
    state.notice = '已上传（' + Math.round((res.bytes || 0) / 1024) + ' KB，' + fmtTime(res.updatedAt) + '）';
    await refreshDevices();
  } catch (e) {
    state.notice = '上传失败：' + (e && e.message || e);
    render();
  } finally {
    busy = false;
  }
}

function downloadBackup() {
  const text = JSON.stringify(store.state, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'study-room-backup-' + Date.now() + '.json' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function pickTarget() {
  const d = device();
  const list = (state.devices || []).filter((x) => x.id !== d.id);
  if (state.mode === 'latest') {
    return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  }
  return list.find((x) => x.id === state.picked) || null;
}

async function askRestore() {
  const target = pickTarget();
  if (!target) {
    state.notice = state.mode === 'latest' ? '云端还没有别的设备，先上传一份再来。' : '先在设备列表里点「选中它」。';
    render();
    return;
  }
  state.notice = '正在读取「' + target.name + '」的存档…';
  render();
  try {
    const snap = await pullDevice(target.id);
    const plan = buildRestorePlan(snap.snapshot, state.subjects);
    state.plan = plan;
    state.target = target;
    const n = Object.keys(plan.progress).length;
    state.plan.summary = '「' + target.name + '」的 ' + n + ' 节进度'
      + (state.subjects.indexOf('english') >= 0 ? ' + 英语记录' : '')
      + '（学科：' + state.subjects.join('/') + '）';
    state.confirm = true;
    state.notice = '即将用「' + target.name + '」替换本机进度，确认后执行；本机存档会先下载一份。';
  } catch (e) {
    state.notice = '读取失败：' + (e && e.message || e);
    state.confirm = null;
  }
  render();
}

async function doRestore() {
  if (busy) return;
  busy = true;
  try {
    downloadBackup();
    applyRestore(store.state, state.plan);
    store.touch({ type: 'sync' });
    const ok = await store.flushNow();
    state.notice = ok ? '已替换本机进度，正在刷新…' : '写盘失败：' + (store.lastError || '未知原因');
    render();
    if (ok) setTimeout(() => location.reload(), 700);
  } finally {
    busy = false;
  }
}

/* ---------------------------- 生命周期 ---------------------------- */
export function initSync(opts) {
  onExit = (opts && opts.onExit) || (() => {});
  dom = { main: $('#sync-main'), back: $('#sync-back') };
  if (dom.back) dom.back.addEventListener('click', () => onExit());
  state = { devices: [], loading: false, mode: 'latest', picked: '', subjects: ['math', 'physics', 'biology', 'english'], notice: '', confirm: null, plan: null };
  render();
}

export function openSync() {
  if (!dom) return;
  state.notice = '';
  state.confirm = null;
  state.plan = null;
  render();
  refreshDevices();
}

export function closeSync() {}
