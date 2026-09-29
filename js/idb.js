/* ===========================================================
   idb.js —— 纯网页模式下的数据存储
   优先用 IndexedDB（容量大，几十 MB 到几 GB）；
   拿不到就退回 localStorage（只有 5MB，但总比不能用强）。
   =========================================================== */

const DB_NAME = 'study-room';
const DB_VERSION = 1;
const STORE = 'kv';
const LS_PREFIX = 'study-room.kv.';

let dbPromise = null;
let useFallback = false;

/* ---------------- localStorage 兜底 ---------------- */
function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function lsSet(key, value) {
  const raw = JSON.stringify(value);
  try {
    localStorage.setItem(LS_PREFIX + key, raw);
  } catch (e) {
    throw new Error('本机存储空间不够了（localStorage 上限约 5MB）。'
      + '建议在设置里导出存档后清空本机数据。原始错误：' + (e && e.name));
  }
  return true;
}
function lsDel(key) {
  try { localStorage.removeItem(LS_PREFIX + key); } catch { /* ignore */ }
  return true;
}
function lsBytes() {
  let n = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) n += (localStorage.getItem(k) || '').length * 2;
    }
  } catch { /* ignore */ }
  return n;
}

/* ---------------- IndexedDB ---------------- */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('NO_IDB')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('打不开本地数据库'));
    req.onblocked = () => reject(new Error('本地数据库被另一个标签页占用'));
  });
  return dbPromise;
}

const FALLBACK_CODES = ['NO_IDB', 'SecurityError', 'InvalidStateError'];

function shouldFallback(err) {
  if (typeof indexedDB === 'undefined') return true;
  const name = (err && (err.name || err.message)) || '';
  return FALLBACK_CODES.some((c) => String(name).includes(c));
}

/* ---------------- 对外 ---------------- */
export async function idbGet(key) {
  if (useFallback) return lsGet(key);
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    if (shouldFallback(e)) { useFallback = true; console.warn('IndexedDB 不可用，改用 localStorage：', e && e.message); return lsGet(key); }
    throw e;
  }
}

export async function idbSet(key, value) {
  if (useFallback) return lsSet(key, value);
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('写入失败'));
      tx.onabort = () => reject(tx.error || new Error('写入被中止（多半是空间不够）'));
    });
  } catch (e) {
    if (shouldFallback(e)) { useFallback = true; return lsSet(key, value); }
    throw e;
  }
}

export async function idbDel(key) {
  if (useFallback) return lsDel(key);
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    if (shouldFallback(e)) { useFallback = true; return lsDel(key); }
    throw e;
  }
}

/** 用了哪种存储 + 大概占了多少 */
export async function idbEstimate() {
  const backend = useFallback ? 'localStorage' : 'IndexedDB';
  if (useFallback) return { backend, usage: lsBytes(), quota: 5 * 1024 * 1024 };
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { backend, usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch { /* ignore */ }
  return { backend, usage: 0, quota: 0 };
}

/** 当前实际用的是哪种后端（诊断用） */
export const storageBackend = () => (useFallback ? 'localStorage' : 'IndexedDB');
