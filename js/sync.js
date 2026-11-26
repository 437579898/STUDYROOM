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
import { getAccessCode } from './api.js';

const DEVICE_KEY = 'study-room.device';
const SERVER_KEY = 'study-room.sync.server';
const PROVIDER_KEY = 'study-room.sync.provider';
const GH_KEY = 'study-room.sync.github';       // { owner, repo, branch, path, token } —— 只存在这台设备的浏览器里

let onExit = () => {};
let dom = null;
let state = null;        // 页面级 UI 状态
let busy = false;
const byId = (id) => document.getElementById(id);

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
    const local = s.english || {};
    const copy = JSON.parse(JSON.stringify(plan.english));
    // 保住本机的东西：偏好、正在写的草稿、本次会话计数
    copy.prefs = Object.assign({}, copy.prefs || {}, local.prefs || {});
    if (local.draft) copy.draft = JSON.parse(JSON.stringify(local.draft));
    if (local.session) copy.session = Object.assign({}, copy.session || {}, local.session);
    s.english = copy;
  }
  return s;
}

/* ---------------------------- GitHub 当云端 ---------------------------- */
/* 用 GitHub Contents API 把 devices/<设备id>.json 提交进你指定的仓库。
   建议 **私有仓库** + fine-grained token（只勾这一仓库的 Contents: Read and write）。
   Token 只存本机 localStorage，不发给任何第三方。 */

function ghCfg() {
  try { return JSON.parse(localStorage.getItem(GH_KEY) || '{}') || {}; } catch { return {}; }
}
function saveGhCfg(patch) {
  const next = Object.assign(ghCfg(), patch);
  try { localStorage.setItem(GH_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}
function provider() {
  const saved = localStorage.getItem(PROVIDER_KEY);
  if (saved === 'local' || saved === 'github') return saved;
  return isStandalone() ? 'github' : 'local';
}
function setProvider(v) {
  try { localStorage.setItem(PROVIDER_KEY, v); } catch { /* ignore */ }
}

export function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghRepoReady() {
  const c = ghCfg();
  return !!(c.owner && c.repo && c.token);
}

function ghApiBase() {
  const c = ghCfg();
  return (c.apiBase || 'https://api.github.com').replace(/\/+$/, '');
}

function ghUrl(path) {
  const c = ghCfg();
  const base = ghApiBase() + '/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) + '/contents/' + path;
  return c.branch ? base + '?ref=' + encodeURIComponent(c.branch) : base;
}

async function ghFetch(url, opts) {
  const c = ghCfg();
  const res = await fetch(url, Object.assign({}, opts || {}, {
    cache: 'no-store',
    headers: Object.assign({
      Authorization: 'Bearer ' + c.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'content-type': 'application/json',
    }, (opts && opts.headers) || {}),
  }));
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Token 无效或权限不够（需要 Contents: Read and write）');
    if (res.status === 404) throw new Error('仓库 / 分支 / 路径不存在，或 Token 看不到这个私有仓库');
    if (res.status === 422) throw new Error('提交被拒（分支不存在？或内容冲突）');
    throw new Error('GitHub ' + res.status + '：' + ((data && data.message) || text).slice(0, 120));
  }
  return data;
}

async function ghReadFile(path) {
  const data = await ghFetch(ghUrl(path));
  if (!data || Array.isArray(data) || !data.content) throw new Error('读不到 ' + path);
  return { text: b64ToUtf8(data.content), sha: data.sha, size: data.size };
}

async function ghList(dir) {
  try {
    const data = await ghFetch(ghUrl(encodeURI(dir)));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (/不存在/.test(String(e && e.message))) return [];
    throw e;
  }
}

async function ghWriteFile(path, text, message) {
  let sha = null;
  try {
    const cur = await ghFetch(ghUrl(path));
    if (cur && cur.sha) sha = cur.sha;
  } catch { /* 文件还不存在 */ }
  const body = {
    message: message || ('sync: ' + new Date().toISOString()),
    content: utf8ToB64(text),
  };
  const c = ghCfg();
  if (c.branch) body.branch = c.branch;
  if (sha) body.sha = sha;
  return ghFetch(ghUrl(path), { method: 'PUT', body: JSON.stringify(body) });
}

/* ---------------------------- 网络 ---------------------------- */
function codeHeader() {
  const code = (typeof getAccessCode === 'function' && getAccessCode()) || '';
  return code ? { 'x-access-code': code } : {};
}

async function syncFetch(path, opts) {
  const base = serverBase();
  const url = (base ? base + '/' : '') + path;
  const headers = Object.assign({ 'content-type': 'application/json' }, codeHeader(), (opts && opts.headers) || {});
  const res = await fetch(url, Object.assign({}, opts || {}, { headers }));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data || data.ok === false) {
    const msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

async function listDevices() {
  if (provider() === 'github') {
    const c = ghCfg();
    const dir = (c.path || 'devices').replace(/^\/+|\/+$/g, '');
    const items = (await ghList(dir)).filter((f) => f.type === 'file' && /\.json$/.test(f.name));
    const out = [];
    for (const f of items.slice(0, 12)) {
      try {
        const file = await ghReadFile(dir + '/' + f.name);
        const rec = JSON.parse(file.text);
        if (!rec || !rec.device || !rec.device.id) continue;
        out.push({
          id: rec.device.id,
          name: rec.device.name || f.name,
          platform: rec.device.platform || '',
          updatedAt: Number(rec.updatedAt || 0),
          bytes: Number(rec.bytes || file.size || 0),
          stats: rec.stats || null,
        });
      } catch { /* 单个文件坏了不影响别的 */ }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { ok: true, devices: out };
  }
  return syncFetch('api/sync/devices');
}

/** 先探一下服务端能力：能判断「没重启」「地址不对」「口令不对」三种常见失败 */
async function checkServer() {
  if (provider() === 'github') {
    const c = ghCfg();
    if (!c.owner || !c.repo || !c.token) return { ok: false, reason: 'NO_GH', message: '还没填 GitHub 仓库和 Token（在下面的「GitHub 仓库」卡片里填）。' };
    try {
      const res = await fetch(ghApiBase() + '/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo), {
        cache: 'no-store',
        headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json' },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'GH_AUTH', message: 'Token 无效，或没给 Contents: Read and write 权限。' };
      if (res.status === 404) return { ok: false, reason: 'GH_404', message: '找不到仓库 ' + c.owner + '/' + c.repo + '（拼写不对，或 Token 看不到私有仓库）。' };
      if (!res.ok) return { ok: false, reason: 'GH_' + res.status, message: 'GitHub 返回 ' + res.status };
      const repo = await res.json().catch(() => null);
      if (repo && repo.archived) return { ok: false, reason: 'GH_ARCHIVED', message: '这个仓库已归档，不能再提交。' };
      return { ok: true, features: ['github'], repo: c.owner + '/' + c.repo, private: !!(repo && repo.private) };
    } catch (e) {
      return { ok: false, reason: 'GH_NET', message: '连不上 GitHub：' + (e && e.message || e) };
    }
  }
  const base = serverBase();
  if (isStandalone() && !base) return { ok: false, reason: 'NO_SERVER', message: '还没填云端地址（纯网页模式没有自己的服务端）。' };
  try {
    const res = await fetch((base ? base + '/' : '') + 'api/health', { cache: 'no-store', headers: codeHeader() });
    if (res.status === 401) return { ok: false, reason: 'LOCKED', message: '这台服务器设了访问口令，先在设置里填口令再同步。' };
    if (!res.ok) return { ok: false, reason: 'HTTP_' + res.status, message: '服务端返回 ' + res.status + '，地址可能不对。' };
    const data = await res.json().catch(() => null);
    const features = (data && data.features) || [];
    if (data && data.name === 'study-room' && features.indexOf('sync') < 0) {
      const probe = await fetch((base ? base + '/' : '') + 'api/sync/devices', { cache: 'no-store', headers: codeHeader() }).catch(() => null);
      if (!probe || probe.status !== 200) {
        return { ok: false, reason: 'OLD_SERVER', message: '服务端还是旧版本（不认识同步接口）——把 node server.js 重启一次就好。' };
      }
    }
    if (!data || data.name !== 'study-room') return { ok: false, reason: 'NOT_SERVER', message: '这个地址不像书房服务端（/api/health 返回的不是它）。' };
    return { ok: true, features };
  } catch (e) {
    return { ok: false, reason: 'UNREACHABLE', message: '连不上 ' + (base || '当前地址') + '：' + (e && e.message || e) };
  }
}
async function pullDevice(id) {
  if (provider() === 'github') {
    const c = ghCfg();
    const dir = (c.path || 'devices').replace(/^\/+|\/+$/g, '');
    const file = await ghReadFile(dir + '/' + id + '.json');
    const rec = JSON.parse(file.text);
    return { ok: true, device: rec.device, updatedAt: rec.updatedAt, stats: rec.stats || null, snapshot: rec.snapshot };
  }
  return syncFetch('api/sync/snapshot?id=' + encodeURIComponent(id));
}

async function publishSelf() {
  const d = device();
  const stats = deviceStats(store.state);
  if (provider() === 'github') {
    const c = ghCfg();
    const dir = (c.path || 'devices').replace(/^\/+|\/+$/g, '');
    const rec = { device: d, stats, updatedAt: Date.now(), bytes: 0, snapshot: store.state };
    rec.bytes = new TextEncoder().encode(JSON.stringify(rec)).length;
    await ghWriteFile(dir + '/' + d.id + '.json', JSON.stringify(rec), 'sync: ' + d.name + ' · ' + new Date().toLocaleString('zh-CN'));
    return { ok: true, deviceId: d.id, updatedAt: rec.updatedAt, bytes: rec.bytes };
  }
  const body = { device: d, stats, snapshot: store.state };
  return syncFetch('api/sync/publish', { method: 'POST', body: JSON.stringify(body) });
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

  if (state.error) {
    dom.main.append(el('div', { class: 'sync-error', id: 'sync-error' }, [
      el('b', { text: '连不上云端：' }),
      el('span', { text: state.error }),
      el('div', { class: 'sync-error__hint', text: '常见原因：① node server.js 还是旧进程（改过 server.js 必须重启）；② 纯网页模式没填云端地址，或填的是手机在外面连不到的局域网地址；③ 服务端设了访问口令。' }),
      el('button', { class: 'en-btn', text: '再试一次', onclick: () => refreshDevices() }),
    ]));
  }

  const prov = provider();
  dom.main.append(el('div', { class: 'sync-provider' }, [
    el('span', { class: 'sync-provider__label', text: '存到哪' }),
    el('button', {
      class: 'en-btn' + (prov === 'local' ? ' en-btn--primary' : ''), dataset: { provider: 'local' },
      text: '本机服务器', onclick: () => { setProvider('local'); state.error = ''; state.confirm = null; state.plan = null; refreshDevices(); },
    }),
    el('button', {
      class: 'en-btn' + (prov === 'github' ? ' en-btn--primary' : ''), dataset: { provider: 'github' },
      text: 'GitHub 仓库', onclick: () => { setProvider('github'); state.error = ''; state.confirm = null; state.plan = null; refreshDevices(); },
    }),
  ]));

  if (prov === 'github') {
    const c = ghCfg();
    const field = (label, id, value, ph, type) => el('div', { class: 'sync-field' }, [
      el('label', { class: 'sync-label', text: label }),
      el('input', { class: 'input sync-input', id, type: type || 'text', value: value || '', placeholder: ph || '', autocomplete: 'off', spellcheck: 'false' }),
    ]);
    const card = el('div', { class: 'en-card en-card--wide sync-card', dataset: { sync: 'github' } }, [
      el('div', { class: 'en-card__head' }, [
        el('span', { class: 'en-card__icon', text: 'Git' }),
        el('span', { class: 'en-card__title', text: 'GitHub 仓库' }),
        el('span', { class: 'en-card__tag', text: c.owner ? (c.owner + '/' + c.repo) : '还没配置' }),
      ]),
      field('账号', 'gh-owner', c.owner, '你的 GitHub 用户名'),
      field('仓库', 'gh-repo', c.repo, '建议新建一个私有仓库，例如 study-room-sync'),
      field('分支', 'gh-branch', c.branch || 'main', 'main'),
      field('目录', 'gh-path', c.path || 'devices', 'devices'),
      field('Token', 'gh-token', c.token, 'fine-grained token：只勾这个仓库的 Contents: Read and write', 'password'),
      el('p', { class: 'en-hint', text: 'Token 只存在这台设备的浏览器里；仓库建议设成 Private。填好点「保存并连接」会真去访问一次 GitHub。' }),
      el('div', { class: 'en-card__acts' }, [
        el('button', {
          class: 'en-btn en-btn--primary', text: '保存并连接',
          onclick: () => {
            saveGhCfg({
              owner: (byId('gh-owner') || {}).value || '',
              repo: (byId('gh-repo') || {}).value || '',
              branch: (byId('gh-branch') || {}).value || '',
              path: (byId('gh-path') || {}).value || 'devices',
              token: (byId('gh-token') || {}).value || '',
            });
            state.error = '';
            refreshDevices();
          },
        }),
        el('button', {
          class: 'en-btn', text: '打开仓库页面',
          onclick: () => {
            const cc = ghCfg();
            if (!cc.owner || !cc.repo) { toast('先填账号和仓库', ''); return; }
            const a = el('a', { href: 'https://github.com/' + cc.owner + '/' + cc.repo, target: '_blank', rel: 'noopener' });
            document.body.append(a); a.click(); a.remove();
          },
        }),
      ]),
    ]);
    dom.main.append(card);
  }

  const mine = (state.devices || []).find((x) => x.id === d.id);

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
    el('p', { class: 'en-hint', text: mine
      ? ('本机上次上传：' + fmtTime(mine.updatedAt) + '（' + Math.round((mine.bytes || 0) / 1024) + ' KB）')
      : '本机还没上传过：点下面的按钮传一次，云端才会有这台设备。' }),
    state.lastTry ? el('p', { class: 'en-hint', text: '最近一次尝试：' + fmtTime(state.lastTry.at) + ' · ' + state.lastTry.what + (state.lastTry.ok ? ' · 成功' : ' · 失败') }) : null,
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
      el('span', { class: 'en-card__title', text: prov === 'github' ? 'GitHub 里的设备' : '云端设备' }),
      el('span', { class: 'en-card__tag', text: state.loading ? '读取中…' : (state.devices || []).length + ' 台' }),
    ]),
  ]);
  if (!state.devices || !state.devices.length) {
    devCard.append(el('p', { class: 'en-hint', text: state.loading
      ? '正在读取…'
      : (state.error ? '读不到设备列表（见上方红条）。'
        : (prov === 'github' ? '仓库里还没有设备记录。先在每台设备上点一次「上传本机进度到云端」。' : '云端还没有任何设备。先在每台设备上点一次「上传本机进度到云端」。')) }));
  } else {
    for (const dev of state.devices) {
      const isSelf = dev.id === d.id;
      const row = el('div', { class: 'sync-dev' + (state.picked === dev.id ? ' is-on' : ''), dataset: { device: dev.id } }, [
        el('span', { class: 'sync-dev__name', text: dev.name + (isSelf ? '（本机）' : '') }),
        el('span', { class: 'sync-dev__meta', text: fmtTime(dev.updatedAt) + ' · ' + Math.round((dev.bytes || 0) / 1024) + ' KB' }),
        el('span', { class: 'sync-dev__stats', text: statLine(dev.stats) }),
        isSelf ? el('span', { class: 'en-hint', text: '当前设备' }) : el('button', {
          class: 'en-btn', text: state.picked === dev.id ? '已选中' : '选中它',
          onclick: () => { state.picked = dev.id; state.mode = 'pick'; state.confirm = null; state.plan = null; render(); },
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
      state.confirm = null; state.plan = null; state.notice = '';
      render();
    },
  }, [el('span', { text: sub.name })])));

  const modeRow = el('div', { class: 'sync-modes' }, [
    el('button', {
      class: 'en-btn' + (state.mode === 'latest' ? ' en-btn--primary' : ''), dataset: { mode: 'latest' },
      text: '① 覆盖同步：用云端最新覆盖本机', onclick: () => { state.mode = 'latest'; state.confirm = null; state.plan = null; render(); },
    }),
    el('button', {
      class: 'en-btn' + (state.mode === 'pick' ? ' en-btn--primary' : ''), dataset: { mode: 'pick' },
      text: '② 替换：用选中设备替换本机', onclick: () => { state.mode = 'pick'; state.confirm = null; state.plan = null; render(); },
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
  state.error = '';
  render();
  const health = await checkServer();
  state.health = health;
  state.lastTry = { at: Date.now(), what: '读取设备列表', ok: false };
  if (!health.ok) {
    state.devices = [];
    state.error = health.message;
    state.loading = false;
    render();
    return;
  }
  try {
    const data = await listDevices();
    state.devices = data.devices || [];
    state.lastTry.ok = true;
  } catch (e) {
    state.devices = [];
    const msg = String((e && e.message) || e);
    state.error = /401|LOCKED|口令/.test(msg) ? '这台服务器设了访问口令，先在设置里输入口令再同步。' : ('读不到云端设备：' + msg);
  } finally {
    state.loading = false;
    render();
  }
}

async function doPublish() {
  if (busy) return;
  busy = true;
  state.notice = '正在上传…';
  state.error = '';
  render();
  try {
    const health = await checkServer();
    state.health = health;
    if (!health.ok) {
      state.error = health.message;
      state.notice = '';
      state.lastTry = { at: Date.now(), what: '上传', ok: false };
      return;
    }
    await store.flushNow();
    const res = await publishSelf();
    state.lastTry = { at: Date.now(), what: '上传', ok: true };
    state.notice = '已上传（' + Math.round((res.bytes || 0) / 1024) + ' KB，' + fmtTime(res.updatedAt) + '）';
    await refreshDevices();
  } catch (e) {
    state.error = '上传失败：' + (e && e.message || e);
    state.notice = '';
    state.lastTry = { at: Date.now(), what: '上传', ok: false };
    render();
  } finally {
    busy = false;
  }
}

function downloadBackup() {
  try {
    const text = JSON.stringify(store.state, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'study-room-backup-' + Date.now() + '.json' });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  } catch (e) {
    toast('本机备份下载失败（浏览器拦了），继续同步：' + (e && e.message || e), 'err');
    return false;
  }
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
      + (plan.english ? ' + 英语记录' : '')
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
  if (!state.plan) { state.notice = '没有可执行的计划，重新选一次。'; render(); return; }
  if (String(state.plan.subjects || '') !== String(state.subjects)) {
    state.confirm = null; state.plan = null;
    state.notice = '学科选择变了，请重新点一次「开始同步」。';
    render();
    return;
  }
  busy = true;
  try {
    downloadBackup();
    applyRestore(store.state, state.plan);
    store.touch({ type: 'sync' });
    const ok = await store.flushNow();
    state.notice = ok ? '已替换本机进度，正在刷新…' : '写盘失败：' + (store.lastError || '未知原因');
    render();
    if (ok) setTimeout(() => { try { location.reload(); } catch { /* ignore */ } }, 700);
  } finally {
    busy = false;
  }
}

/* ---------------------------- 生命周期 ---------------------------- */
export function initSync(opts) {
  onExit = (opts && opts.onExit) || (() => {});
  dom = { main: $('#sync-main'), back: $('#sync-back') };
  if (dom.back) dom.back.addEventListener('click', () => onExit());
  state = {
    devices: [], loading: false, mode: 'latest', picked: '',
    subjects: ['math', 'physics', 'biology', 'english'],
    notice: '', confirm: null, plan: null,
    error: '', health: null, lastTry: null,
  };
  render();
}

export function openSync() {
  if (!dom) return;
  state.error = '';
  state.notice = '';
  state.confirm = null;
  state.plan = null;
  render();
  refreshDevices();
}

export function closeSync() {}
