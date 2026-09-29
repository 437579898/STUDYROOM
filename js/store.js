/* ===========================================================
   store.js —— 学习数据（存在服务端，不用浏览器本地存储）
   =========================================================== */
import { api } from './api.js';
import { uid } from './util.js';

function blank() {
  return {
    version: 1,
    progress: {},                 // sectionId -> { status:'studying'|'done', visits, lastAt }
    chats: {},                    // sectionId -> { messages:[], updatedAt }
    wrongbook: { items: [] },
    memos: { items: [] },
    prefs: {
      lastSubject: null,
      lastVolume: null,
      lastSection: null,
      leftOpen: true,
      rightOpen: true,
    },
  };
}

function normalize(raw) {
  const s = blank();
  if (!raw || typeof raw !== 'object') return s;
  s.version = raw.version || 1;
  if (raw.progress && typeof raw.progress === 'object') s.progress = raw.progress;
  if (raw.chats && typeof raw.chats === 'object') {
    for (const [k, v] of Object.entries(raw.chats)) {
      if (v && Array.isArray(v.messages)) s.chats[k] = { messages: v.messages, updatedAt: v.updatedAt || Date.now() };
    }
  }
  if (raw.wrongbook && Array.isArray(raw.wrongbook.items)) s.wrongbook.items = raw.wrongbook.items;
  if (raw.memos && Array.isArray(raw.memos.items)) s.memos.items = raw.memos.items;
  if (raw.prefs && typeof raw.prefs === 'object') Object.assign(s.prefs, raw.prefs);
  return s;
}

class Store {
  constructor() {
    this.state = blank();
    this.listeners = new Set();
    this.ready = false;
    this.saving = false;
    this.pending = false;

    /** idle（已保存）| dirty（待保存）| saving（保存中）| error（失败） */
    this.status = 'idle';
    this.dirty = false;
    this.dirtySince = 0;
    this.lastSavedAt = 0;
    this.lastError = null;

    this.DEBOUNCE_MS = 500;
    this._timer = 0;
    this._waiters = [];
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt = {}) { for (const fn of this.listeners) { try { fn(evt, this.state); } catch (e) { console.error(e); } } }

  async init() {
    try {
      this.state = normalize(await api.loadState());
    } catch (e) {
      console.warn('读取服务端数据失败，改用内存态：', e.message);
      this.state = blank();
    }
    this.ready = true;
    this.emit({ type: 'ready' });
    return this.state;
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit({ type: 'status' });
  }

  /** 标记有改动，稍后批量落盘 */
  touch(evt) {
    if (!this.dirty) this.dirtySince = Date.now();
    this.dirty = true;
    if (this.status !== 'saving') this.setStatus('dirty');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = 0; this.flush(); }, this.DEBOUNCE_MS);
    this.emit(evt || { type: 'change' });
  }

  /** 取消防抖，立刻写盘。resolve(true) 表示服务端已确认收到 */
  flushNow() {
    clearTimeout(this._timer);
    this._timer = 0;
    return this.flush();
  }

  async flush() {
    if (!this.ready) return true;
    if (this.saving) {
      this.pending = true;
      return new Promise((resolve) => this._waiters.push(resolve));
    }
    this.saving = true;
    this.setStatus('saving');
    let ok = true;
    try {
      await api.saveState(this.state);
      this.lastSavedAt = Date.now();
      this.lastError = null;
      this.dirty = false;
      this.setStatus('idle');
      this.emit({ type: 'saved' });
    } catch (e) {
      ok = false;
      this.lastError = e;
      console.error('保存失败', e);
      this.setStatus('error');
      this.emit({ type: 'save-error', error: e });
    } finally {
      this.saving = false;
      if (this.pending) {
        this.pending = false;
        this.flush();          // 期间又有改动，再存一次
      } else {
        for (const w of this._waiters.splice(0)) w(ok);
      }
    }
    return ok;
  }

  /**
   * 页面隐藏/关闭前的尽力落盘。
   * 先走正常请求；若仍未成功且体积小于 64KB，再用 keepalive 补一枪。
   */
  async flushOnHide() {
    if (!this.ready || !this.dirty) return;
    try { await this.flushNow(); } catch { /* ignore */ }
    if (!this.dirty) return;
    // 服务端模式走 keepalive（有 64KB 上限）；纯网页模式写 IndexedDB
    try { await api.saveStateBeacon(this.state); } catch { /* ignore */ }
  }

  /* ------------------------- 进度 ------------------------- */
  progressOf(sectionId) {
    return this.state.progress[sectionId] || { status: 'new', visits: 0, lastAt: 0 };
  }
  markStudying(sectionId) {
    const p = this.progressOf(sectionId);
    if (p.status === 'done') { p.visits = (p.visits || 0) + 1; p.lastAt = Date.now(); }
    else { this.state.progress[sectionId] = { status: 'studying', visits: (p.visits || 0) + 1, lastAt: Date.now() }; }
    this.touch({ type: 'progress' });
  }
  markDone(sectionId, done = true) {
    const p = this.progressOf(sectionId);
    this.state.progress[sectionId] = { ...p, status: done ? 'done' : 'studying', lastAt: Date.now() };
    this.touch({ type: 'progress' });
  }

  /* ------------------------- 对话 ------------------------- */
  chatOf(sectionId) {
    if (!this.state.chats[sectionId]) this.state.chats[sectionId] = { messages: [], updatedAt: 0 };
    return this.state.chats[sectionId];
  }
  pushMessage(sectionId, msg) {
    const chat = this.chatOf(sectionId);
    const full = { id: uid('m'), ts: Date.now(), ...msg };
    chat.messages.push(full);
    chat.updatedAt = Date.now();
    this.touch({ type: 'chat', sectionId });
    return full;
  }
  updateMessage(sectionId, msgId, patch) {
    const chat = this.chatOf(sectionId);
    const m = chat.messages.find((x) => x.id === msgId);
    if (m) { Object.assign(m, patch); this.touch({ type: 'chat', sectionId }); }
    return m;
  }
  deleteMessage(sectionId, msgId) {
    const chat = this.chatOf(sectionId);
    chat.messages = chat.messages.filter((m) => m.id !== msgId);
    this.touch({ type: 'chat', sectionId });
  }
  clearChat(sectionId) {
    this.state.chats[sectionId] = { messages: [], updatedAt: Date.now() };
    this.touch({ type: 'chat', sectionId });
  }

  /* ------------------------- 错题本 ------------------------- */
  addWrong(item) {
    const full = {
      id: uid('w'),
      createdAt: Date.now(),
      status: 'new',
      tags: [],
      variants: [],
      ...item,
    };
    this.state.wrongbook.items.unshift(full);
    this.touch({ type: 'wrongbook' });
    return full;
  }
  updateWrong(id, patch) {
    const it = this.state.wrongbook.items.find((x) => x.id === id);
    if (it) { Object.assign(it, patch); this.touch({ type: 'wrongbook' }); }
    return it;
  }
  removeWrong(id) {
    this.state.wrongbook.items = this.state.wrongbook.items.filter((x) => x.id !== id);
    this.touch({ type: 'wrongbook' });
  }
  wrongCount() { return this.state.wrongbook.items.filter((x) => x.status !== 'mastered').length; }

  /* ------------------------- 备忘录 ------------------------- */
  addMemo(memo) {
    const full = { id: uid('n'), title: '', body: '', pinned: false, createdAt: Date.now(), updatedAt: Date.now(), ...memo };
    this.state.memos.items.unshift(full);
    this.touch({ type: 'memo' });
    return full;
  }
  updateMemo(id, patch) {
    const it = this.state.memos.items.find((x) => x.id === id);
    if (it) { Object.assign(it, patch, { updatedAt: Date.now() }); this.touch({ type: 'memo' }); }
    return it;
  }
  removeMemo(id) {
    this.state.memos.items = this.state.memos.items.filter((x) => x.id !== id);
    this.touch({ type: 'memo' });
  }

  /* ------------------------- 偏好 ------------------------- */
  setPref(k, v) {
    this.state.prefs[k] = v;
    this.touch({ type: 'prefs' });
  }
}

export const store = new Store();
