/* ===========================================================
   settings.js —— 设置（模型配置 / 访问口令 / 版面 / 本机数据）
   同时适配「本机服务端」和「纯网页」两种运行模式
   =========================================================== */
import { $, el, toast } from './util.js';
import { api, setAccessCode, extractKeyClient, validateKeyClient } from './api.js';
import { openModal, closeModal } from './overlay.js';
import { store } from './store.js';
import { applyStage, layoutMode } from './stage.js';
import { isStandalone, modeLabel } from './runtime.js';
import { refreshTree } from './study.js';

const CODE_KEY = 'study-room.access-code';

/** 内容加载模式：'next' 只预加载下一级（默认） / 'none' 不预加载 */
function loadMode() {
  return (store.state.prefs && store.state.prefs.loadMode) || 'next';
}

/** 公式强调开关：默认开。关掉时给 body 加 no-fx，CSS 层直接不涂抹。 */
function fxMode() {
  return store.state.prefs.formulaHighlight !== false;
}
export function applyFxMode() {
  document.body.classList.toggle('no-fx', !fxMode());
}
const CONFIG_KEY = 'study-room.config';

let dom = {};
let cfg = null;

function showNote(text, kind) {
  if (!text) { dom.note.hidden = true; dom.note.textContent = ''; return; }
  dom.note.hidden = false;
  dom.note.className = 'note-bar' + (kind ? ' note-bar--' + kind : '');
  dom.note.innerHTML = '';
  dom.note.append(el('span', { class: 'ic', text: kind === 'warn' ? '!' : '◆' }));
  dom.note.append(el('div', { text }));
}

function fmtSize(n) {
  if (!n) return '0';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function paint(config, notice) {
  cfg = config;
  dom.baseUrl.value = config.baseUrl || '';
  dom.model.value = config.model || '';
  dom.key.value = '';
  dom.key.placeholder = config.hasKey ? ('已保存：' + config.keyHint + '（留空表示不修改）') : 'sk-...';
  dom.temp.value = String(config.temperature != null ? config.temperature : 0.6);
  dom.keyState.dataset.ok = config.hasKey ? '1' : '0';
  dom.keyState.textContent = config.hasKey ? '● 已配置密钥' : '○ 尚未配置密钥';

  /* 按模式显示/隐藏 */
  const solo = isStandalone();
  dom.mode.dataset.mode = solo ? 'standalone' : 'server';
  dom.mode.innerHTML = '';
  dom.mode.append(el('span', { class: 'pill', text: solo ? '纯网页模式' : '本机服务端' }));
  dom.mode.append(el('span', {
    text: solo
      ? '数据存在这台设备的浏览器里，模型请求由浏览器直连服务商'
      : '数据存在这台电脑的 data/ 目录里，模型请求经本机服务端转发',
  }));

  dom.groupCode.hidden = solo;
  dom.groupLocal.hidden = !solo;

  dom.code.value = '';
  dom.code.placeholder = config.hasCode ? '已设置（留空表示不修改）' : '至少 4 位；留空表示不设防';
  dom.codeState.dataset.ok = config.hasCode ? '1' : '0';
  dom.codeState.textContent = config.hasCode ? '● 已设口令' : '○ 未设口令 —— 同 WiFi 任何人都能打开';

  const mode = layoutMode();
  dom.layoutFixed.classList.toggle('is-on', mode === 'fixed');
  dom.layoutFluid.classList.toggle('is-on', mode === 'fluid');

  const lm = loadMode();
  dom.loadNext.classList.toggle('is-on', lm === 'next');
  dom.loadNone.classList.toggle('is-on', lm === 'none');

  const fx = fxMode();
  dom.fxOn.classList.toggle('is-on', fx);
  dom.fxOff.classList.toggle('is-on', !fx);

  if (solo) refreshStorageInfo();

  if (notice) showNote(notice, 'ok');
  else if (config.keyWarning) showNote(config.keyWarning, 'warn');
  else if (config.keyExtracted) showNote('检测到之前保存的密钥里混进了多余字符，已自动修正为 ' + config.keyHint + '。', 'ok');
  else showNote('');
}

async function refreshStorageInfo() {
  try {
    const info = await api.storageInfo();
    if (info && info.quota) {
      dom.localUsage.textContent = '存储方式：' + info.backend + '　·　已用 '
        + fmtSize(info.usage) + ' / 约 ' + fmtSize(info.quota) + '。';
    } else if (info) {
      dom.localUsage.textContent = '存储方式：' + info.backend + '。';
    } else {
      dom.localUsage.textContent = '';
    }
  } catch {
    dom.localUsage.textContent = '';
  }
}

export async function openSettings() {
  try {
    paint(await api.loadConfig());
  } catch (e) {
    toast('读取配置失败：' + e.message, 'err');
  }
  openModal('modal-settings');
}

export function initSettings() {
  dom = {
    baseUrl: $('#cfg-baseurl'),
    model: $('#cfg-model'),
    key: $('#cfg-key'),
    temp: $('#cfg-temp'),
    keyState: $('#cfg-keystate'),
    note: $('#cfg-note'),
    mode: $('#cfg-mode'),
    out: $('#cfg-testout'),
    save: $('#cfg-save'),
    test: $('#cfg-test'),
    code: $('#cfg-code'),
    codeState: $('#cfg-codestate'),
    clearCode: $('#cfg-clearcode'),
    layoutFixed: $('#cfg-layout-fixed'),
    layoutFluid: $('#cfg-layout-fluid'),
    loadNext: $('#cfg-load-next'),
    loadNone: $('#cfg-load-none'),
    fxOn: $('#cfg-fx-on'),
    fxOff: $('#cfg-fx-off'),
    groupCode: $('#cfg-group-code'),
    groupLocal: $('#cfg-group-local'),
    localUsage: $('#cfg-local-usage'),
    exportBtn: $('#cfg-export'),
    importBtn: $('#cfg-import'),
    importFile: $('#cfg-import-file'),
    resetBtn: $('#cfg-reset'),
  };

  $('#btn-settings').addEventListener('click', openSettings);

  /* ---- 版面比例 ---- */
  const pickLayout = (mode) => {
    store.setPref('layout', mode);
    const r = applyStage();
    dom.layoutFixed.classList.toggle('is-on', mode === 'fixed');
    dom.layoutFluid.classList.toggle('is-on', mode === 'fluid');
    if (mode === 'fixed' && r && r.forced) {
      toast('窗口太小，暂时按自适应显示；把窗口放大就会恢复固定版面', '');
    } else {
      toast(mode === 'fixed' ? '已切换为固定版面比例' : '已切换为自适应窗口', 'ok');
    }
  };
  dom.layoutFixed.addEventListener('click', () => pickLayout('fixed'));
  dom.layoutFluid.addEventListener('click', () => pickLayout('fluid'));

  /* ---- 内容加载模式 ---- */
  const pickLoad = (m) => {
    store.setPref('loadMode', m);
    dom.loadNext.classList.toggle('is-on', m === 'next');
    dom.loadNone.classList.toggle('is-on', m === 'none');
    try { refreshTree(); } catch { /* 还没进学习界面时忽略 */ }
    toast(m === 'next' ? '已切换为「仅预加载下一级」' : '已切换为「不预加载」', 'ok');
  };
  dom.loadNext.addEventListener('click', () => pickLoad('next'));
  dom.loadNone.addEventListener('click', () => pickLoad('none'));

  /* ---- 公式强调开关 ---- */
  const pickFx = (on) => {
    store.setPref('formulaHighlight', on);
    dom.fxOn.classList.toggle('is-on', on);
    dom.fxOff.classList.toggle('is-on', !on);
    applyFxMode();
    toast(on ? '已开启公式强调' : '已关闭公式强调', 'ok');
  };
  dom.fxOn.addEventListener('click', () => pickFx(true));
  dom.fxOff.addEventListener('click', () => pickFx(false));

  /* ---- 取消访问口令（仅服务端模式）---- */
  dom.clearCode.addEventListener('click', async (e) => {
    if (!confirm('取消访问口令？取消之后，同一个局域网里任何人都能打开这个网站，并且会用掉你的 API 额度。')) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await api.saveConfigFull({ accessCode: '', clearCode: true });
      setAccessCode('');
      try { localStorage.removeItem(CODE_KEY); } catch { /* ignore */ }
      paint(res.config, (res.notices || []).join('　'));
      toast('已取消访问口令', 'ok');
    } catch (err) {
      toast('取消失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  /* ---- 保存 ---- */
  dom.save.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const patch = {
        baseUrl: dom.baseUrl.value.trim(),
        model: dom.model.value.trim(),
        temperature: Number(dom.temp.value) || 0.6,
      };
      if (dom.key.value.trim()) patch.apiKey = dom.key.value.trim();

      const newCode = dom.code.value.trim();
      if (newCode && !isStandalone()) patch.accessCode = newCode;

      const res = await api.saveConfigFull(patch);

      // 本机立刻记住口令，否则设完之后连自己都会被挡在门外
      if (newCode && !isStandalone()) {
        setAccessCode(newCode);
        try { localStorage.setItem(CODE_KEY, newCode); } catch { /* ignore */ }
      }

      paint(res.config, (res.notices || []).join('　'));
      toast('配置已保存', 'ok');
      setTimeout(() => closeModal('modal-settings'), 900);
    } catch (err) {
      showNote(err.message, 'warn');
      toast('保存失败：' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  /* ---- 测试连接 ---- */
  dom.test.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '测试中…';
    dom.out.hidden = false;
    dom.out.textContent = '正在调用 ' + (dom.baseUrl.value || '(默认)') + ' ...';
    try {
      const patch = {
        baseUrl: dom.baseUrl.value.trim(),
        model: dom.model.value.trim(),
        temperature: Number(dom.temp.value) || 0.6,
      };
      if (dom.key.value.trim()) {
        const pv = extractKeyClient(dom.key.value);
        const local = validateKeyClient(pv.key);
        if (local) throw new Error(local);
        patch.apiKey = pv.key;
      }
      const saved = await api.saveConfigFull(patch);
      const next = saved.config;
      paint(next, (saved.notices || []).join('　'));
      if (!next.hasKey) throw new Error('还没有配置 API Key');

      const t0 = Date.now();
      const data = await api.chatOnce([
        { role: 'system', content: '你是测试用的回声助手。' },
        { role: 'user', content: '只回复两个字：可用' },
      ], { maxTokens: 24 });
      const reply = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '(空)';
      const model = (data && data.model) || next.model;
      dom.out.textContent = '✓ 连接成功\n模式：' + modeLabel() + '\n模型：' + model
        + '\n耗时：' + (Date.now() - t0) + ' ms\n回复：' + reply.trim();
      toast('连接正常', 'ok');
    } catch (err) {
      dom.out.textContent = '✗ 失败\n' + (err.message || String(err));
      toast('连接失败', 'err');
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  });

  /* ---- 导出存档 ---- */
  dom.exportBtn.addEventListener('click', async () => {
    try {
      const c = await api.loadConfig();
      const dump = {
        app: 'study-room',
        version: 1,
        exportedAt: new Date().toISOString(),
        note: 'API Key 不在存档里，导入后需要重新填写。',
        state: store.state,
        config: { baseUrl: c.baseUrl, model: c.model, temperature: c.temperature, maxTokens: c.maxTokens },
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      a.href = URL.createObjectURL(blob);
      a.download = 'study-room-存档-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
        + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      toast('存档已导出', 'ok');
    } catch (e) {
      toast('导出失败：' + e.message, 'err');
    }
  });

  /* ---- 导入存档 ---- */
  dom.importBtn.addEventListener('click', () => dom.importFile.click());
  dom.importFile.addEventListener('change', async () => {
    const f = dom.importFile.files && dom.importFile.files[0];
    if (!f) return;
    try {
      const dump = JSON.parse(await f.text());
      const st = dump && dump.state ? dump.state : (dump && dump.progress ? dump : null);
      if (!st || typeof st !== 'object') throw new Error('这个文件里没有能识别的学习记录');
      if (!confirm('导入会用存档覆盖这台设备上的全部学习记录（错题本、备忘录、进度、对话）。确定继续？')) return;

      await api.saveState(st);
      if (dump.config) await api.saveConfigFull(dump.config).catch(() => {});
      toast('导入成功，正在重新载入…', 'ok');
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      toast('导入失败：' + e.message, 'err');
    } finally {
      dom.importFile.value = '';
    }
  });

  /* ---- 清空本机数据 ---- */
  dom.resetBtn.addEventListener('click', async (e) => {
    if (!confirm('清空这台设备上的全部学习记录？错题本、备忘录、进度都会没有。建议先导出存档。')) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.resetLocalData();
      try { localStorage.removeItem(CONFIG_KEY); } catch { /* ignore */ }
      toast('已清空，正在重新载入…', 'ok');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast('清空失败：' + err.message, 'err');
      btn.disabled = false;
    }
  });
}
