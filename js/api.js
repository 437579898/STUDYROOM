/* ===========================================================
   api.js —— 数据与模型调用
   两种运行模式：
     服务端模式：数据存服务端 data/，模型请求经服务端转发（Key 不出本机服务端）
     纯网页模式：数据存浏览器 IndexedDB，模型请求由浏览器直连服务商
                 （DeepSeek 支持 CORS，实测预检返回 access-control-allow-origin）
   =========================================================== */
import { idbGet, idbSet, idbDel, idbEstimate } from './idb.js';
import { isStandalone } from './runtime.js';

/* ===================== 访问口令（只有服务端模式用得上） ===================== */
let ACCESS_CODE = '';
export function setAccessCode(code) { ACCESS_CODE = String(code || ''); }
export function getAccessCode() { return ACCESS_CODE; }

function buildHeaders(extra) {
  const h = Object.assign({ 'content-type': 'application/json' }, extra || {});
  if (ACCESS_CODE) h['x-access-code'] = ACCESS_CODE;
  return h;
}

function makeError(message, extra) {
  const e = new Error(message);
  Object.assign(e, extra || {});
  return e;
}

/* ===================== 纯网页模式的本地配置 ===================== */
const CONFIG_KEY = 'study-room.config';
const CODE_KEY = 'study-room.access-code';

export const LOCAL_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.6,
  maxTokens: 4096,
  apiKey: '',
};

function readLocalConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return Object.assign({}, LOCAL_DEFAULTS, raw ? JSON.parse(raw) : {});
  } catch {
    return Object.assign({}, LOCAL_DEFAULTS);
  }
}

function writeLocalConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

function maskLocal(cfg) {
  const key = String(cfg.apiKey || '');
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    hasKey: key.length > 0,
    keyHint: key ? key.slice(0, 6) + '···' + key.slice(-4) : '',
    keyExtracted: false,
    keyWarning: null,
    hasCode: false,
  };
}

/** 与服务端 extractKey 行为一致：把粘贴内容里的密钥抠出来 */
export function extractKeyClient(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
  s = s.replace(/^\s*bearer\s+/i, '');
  s = s.trim();
  const m = /(sk-[A-Za-z0-9_-]{8,})/.exec(s);
  return m ? { key: m[1], extracted: m[1] !== s } : { key: s, extracted: false };
}

/** 与服务端 validateKey 行为一致：说清楚第几个字符有问题 */
export function validateKeyClient(key) {
  if (!key) return null;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code > 126 || code < 33) {
      const kind = code > 0x2e80 ? '汉字或中文标点' : (code === 32 ? '空格' : '不可见字符');
      return 'API Key 里第 ' + (i + 1) + ' 个字符是「' + key[i] + '」（' + kind + '），'
        + '密钥只能由字母、数字、- 和 _ 组成。通常是把「API Key：」这类前缀一起复制进去了。';
    }
  }
  if (key.length < 20) return 'API Key 看起来太短了（只有 ' + key.length + ' 个字符）。';
  return null;
}

function normalizeBaseUrlClient(raw) {
  let s = String(raw == null ? '' : raw).replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
  if (!s) return LOCAL_DEFAULTS.baseUrl;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[\w.-]+\.[a-z]{2,}/i.test(s)) return 'https://' + s.replace(/\/+$/, '');
    throw makeError('API 地址要以 http:// 或 https:// 开头');
  }
  return s.replace(/\/+$/, '');
}

/* ===================== 服务端模式的小工具 ===================== */
async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, Object.assign({}, opts, { headers: buildHeaders(opts.headers) }));
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    throw makeError((data && (data.message || data.error)) || ('HTTP ' + res.status), {
      status: res.status, payload: data, needCode: !!(data && data.needCode),
    });
  }
  return data;
}

/* ===================== SSE 解析（两种模式共用） ===================== */
async function consumeStream(res, { onDelta, onThink }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let thinking = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (!delta) continue;
      if (delta.reasoning_content) {
        thinking += delta.reasoning_content;
        if (onThink) onThink(thinking);
      }
      if (delta.content) {
        full += delta.content;
        if (onDelta) onDelta(delta.content, full);
      }
    }
  }
  return { text: full, thinking };
}

/* ===================== 纯网页模式：浏览器直连模型 ===================== */
async function directChat({ messages, temperature, maxTokens, signal, onDelta, onThink, stream }) {
  const cfg = readLocalConfig();
  if (!cfg.apiKey) {
    throw makeError('还没有配置 API Key。点右下角齿轮，填入你的 DeepSeek API Key。', { status: 400, error: 'NO_API_KEY' });
  }
  const bad = validateKeyClient(cfg.apiKey);
  if (bad) throw makeError(bad, { status: 400, error: 'BAD_API_KEY' });

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + cfg.apiKey,
        accept: stream === false ? 'application/json' : 'text/event-stream',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: stream !== false,
        temperature: temperature != null ? temperature : cfg.temperature,
        max_tokens: maxTokens != null ? maxTokens : cfg.maxTokens,
      }),
      signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw makeError('连不上模型服务：' + (e && e.message ? e.message : '网络错误')
      + '（纯网页模式下是浏览器直接连服务商，请检查网络，以及该服务的地址是否允许跨域访问）', { status: 0 });
  }

  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    const msg = (payload && payload.error && payload.error.message) || (payload && payload.message) || ('HTTP ' + res.status);
    throw makeError(msg, { status: res.status, payload });
  }

  if (stream === false) {
    const data = await res.json();
    return { data, text: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '' };
  }
  const r = await consumeStream(res, { onDelta, onThink });
  return r;
}

/* ===================== 对外接口 ===================== */
export const api = {
  async health() {
    if (isStandalone()) return { ok: true, name: 'study-room-standalone' };
    return jsonFetch('api/health');
  },

  /* ---------------- 数据 ---------------- */
  async loadState() {
    if (isStandalone()) {
      const s = await idbGet('state');
      return s || null;
    }
    const d = await jsonFetch('api/state');
    return d ? d.state : null;
  },

  async saveState(state) {
    if (isStandalone()) {
      await idbSet('state', state);
      return { ok: true, savedAt: Date.now() };
    }
    return jsonFetch('api/state', { method: 'POST', body: JSON.stringify({ state }) });
  },

  /** 页面关闭前的尽力落盘 */
  async saveStateBeacon(state) {
    if (isStandalone()) {
      // IndexedDB 没有 keepalive 的概念，正常写一次即可（页面卸载前通常能完成）
      await idbSet('state', state);
      return true;
    }
    const body = JSON.stringify({ state });
    // keepalive 请求有 64KB 上限，超了浏览器会直接丢弃
    if (body.length >= 60000) return false;
    try {
      await fetch('api/state', {
        method: 'POST', headers: buildHeaders(), body, keepalive: true,
      });
      return true;
    } catch { return false; }
  },

  /* ---------------- 配置 ---------------- */
  async loadConfig() {
    if (isStandalone()) return maskLocal(readLocalConfig());
    const d = await jsonFetch('api/config');
    return d.config;
  },

  async saveConfig(patch) {
    const r = await api.saveConfigFull(patch);
    return r.config;
  },

  async saveConfigFull(patch) {
    if (isStandalone()) {
      const cur = readLocalConfig();
      const next = Object.assign({}, cur);
      const notices = [];

      if (typeof patch.baseUrl === 'string') next.baseUrl = normalizeBaseUrlClient(patch.baseUrl);
      if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
      if (typeof patch.temperature === 'number' && Number.isFinite(patch.temperature)) next.temperature = patch.temperature;
      if (typeof patch.maxTokens === 'number' && Number.isFinite(patch.maxTokens)) next.maxTokens = patch.maxTokens;

      if (typeof patch.apiKey === 'string' && patch.apiKey !== '') {
        const ex = extractKeyClient(patch.apiKey);
        const bad = validateKeyClient(ex.key);
        if (bad) throw makeError(bad, { status: 400, error: 'BAD_API_KEY' });
        next.apiKey = ex.key;
        if (ex.extracted) notices.push('已从粘贴内容中自动取出密钥 ' + ex.key.slice(0, 5) + '···' + ex.key.slice(-4));
      }
      if (patch.clearKey === true) next.apiKey = '';

      writeLocalConfig(next);
      return { config: maskLocal(next), notices };
    }

    const d = await jsonFetch('api/config', { method: 'POST', body: JSON.stringify(patch) });
    return { config: d.config, notices: d.notices || [] };
  },

  /* ---------------- 对话 ---------------- */
  async chat(opts) {
    if (isStandalone()) return directChat(Object.assign({}, opts, { stream: true }));
    const { messages, temperature, maxTokens, signal, onDelta, onThink } = opts;
    const res = await fetch('api/chat', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ messages, stream: true, temperature, maxTokens }),
      signal,
    });
    if (!res.ok) {
      let payload = null;
      try { payload = await res.json(); } catch { /* ignore */ }
      throw makeError((payload && (payload.message || payload.error)) || ('HTTP ' + res.status), {
        status: res.status, payload, needCode: !!(payload && payload.needCode),
      });
    }
    return consumeStream(res, { onDelta, onThink });
  },

  async chatOnce(messages, extra = {}) {
    if (isStandalone()) {
      const r = await directChat(Object.assign({ messages, stream: false }, extra));
      return r.data;
    }
    const d = await jsonFetch('api/chat', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ messages, stream: false }, extra)),
    });
    return d.data;
  },

  /* ---------------- 纯网页模式专属 ---------------- */
  async storageInfo() {
    if (!isStandalone()) return null;
    return idbEstimate();
  },

  async resetLocalData() {
    if (!isStandalone()) return false;
    await idbDel('state');
    return true;
  },
};

export { CONFIG_KEY, CODE_KEY };
