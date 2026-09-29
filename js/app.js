/* ===========================================================
   app.js —— 应用装配与视图切换
   =========================================================== */
import { $, $$, el, toast, fmtTime, fmtDateTime } from './util.js';
import { api, setAccessCode } from './api.js';
import { store } from './store.js';
import { CURRICULUM, getSectionWrap } from './subject.js';
import { initOverlay, closeTop } from './overlay.js';
import { initStage, applyStage } from './stage.js';
import { detectMode, isStandalone, modeLabel } from './runtime.js';
import { initBook, showDesk, refreshBook, openToSection } from './book.js';
import { initStudy, openSection, currentSection } from './study.js';
import { initWrongbook, collectFromMessage, refreshWrongbook, toggleWrongbook, closeWrongbook } from './wrongbook.js';
import { initMemo, toggleMemo, closeMemo, refreshMemo } from './memo.js';
import { initSettings } from './settings.js';

let currentView = 'desk';
const CODE_KEY = 'study-room.access-code';

/* ---------------------------- 访问口令 ---------------------------- */
function askForCode() {
  return new Promise((resolve) => {
    const lock = $('#lock');
    const input = $('#lock-input');
    const err = $('#lock-err');
    lock.hidden = false;
    setTimeout(() => input.focus(), 80);

    const submit = async () => {
      const v = input.value.trim();
      if (!v) { err.textContent = '请输入口令'; return; }
      setAccessCode(v);
      try {
        await api.loadConfig();
        try { localStorage.setItem(CODE_KEY, v); } catch { /* ignore */ }
        lock.hidden = true;
        resolve(true);
      } catch (e) {
        setAccessCode('');
        err.textContent = e.needCode ? '口令不对，再试一次' : ('连接失败：' + e.message);
        input.select();
      }
    };

    $('#lock-go').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  });
}

async function ensureUnlocked() {
  let saved = '';
  try { saved = localStorage.getItem(CODE_KEY) || ''; } catch { /* ignore */ }
  if (saved) setAccessCode(saved);
  try {
    const cfg = await api.loadConfig();
    return cfg;
  } catch (e) {
    if (!e.needCode) throw e;
  }
  setAccessCode('');
  try { localStorage.removeItem(CODE_KEY); } catch { /* ignore */ }
  await askForCode();
  return api.loadConfig();
}

function setGearAlert(on) {
  const g = $('#btn-settings');
  if (g) g.dataset.alert = on ? '1' : '0';
}

/* ---------------------------- 视图切换 ---------------------------- */
function showView(name) {
  if (currentView === name) return;
  const from = document.getElementById('view-' + currentView);
  const to = document.getElementById('view-' + name);
  if (from) {
    from.classList.add('is-leaving');
    setTimeout(() => { from.classList.remove('is-active', 'is-leaving'); }, 380);
  }
  if (to) to.classList.add('is-active');
  currentView = name;
  document.body.classList.toggle('in-study', name === 'study');
  if (typeof applyStage === 'function') applyStage();
}

function enterSection(sectionId) {
  if (!getSectionWrap(sectionId)) { toast('找不到这一节', 'err'); return; }
  closeWrongbook(); closeMemo();
  showView('study');
  openSection(sectionId).catch((e) => toast('打开失败：' + e.message, 'err'));
}

/* ---------------------------- 保存状态指示器 ---------------------------- */
function initSaveBar() {
  const pill = $('#save-pill');
  const text = $('#save-text');
  let hideTimer = 0;

  function paint() {
    const s = store.status;
    pill.dataset.s = s;
    clearTimeout(hideTimer);

    if (s === 'saving') {
      text.textContent = '保存中…';
      pill.classList.add('is-on');
      pill.title = isStandalone() ? '正在写入这台设备的浏览器存储' : '正在写入服务端 data/state.json';
    } else if (s === 'dirty') {
      text.textContent = '待保存…';
      pill.classList.add('is-on');
      pill.title = '有改动还没写进服务端，点这里立刻保存';
    } else if (s === 'error') {
      text.textContent = '保存失败 · 点此重试';
      pill.classList.add('is-on');
      pill.title = (store.lastError && store.lastError.message) || '保存失败';
    } else {
      text.textContent = '已保存';
      pill.classList.add('is-on');
      pill.title = store.lastSavedAt
        ? ((isStandalone() ? '已保存到这台设备 · ' : '已写入服务端 · ') + fmtDateTime(store.lastSavedAt))
        : (isStandalone() ? '数据已与本机存储一致' : '数据已与服务端一致');
      hideTimer = setTimeout(() => pill.classList.remove('is-on'), 2200);
    }
  }

  pill.addEventListener('click', async () => {
    if (store.status === 'idle') { toast(isStandalone() ? '数据已经在本机存储里了' : '数据已经在服务端了', ''); return; }
    pill.dataset.s = 'saving';
    text.textContent = '保存中…';
    const ok = await store.flushNow();
    paint();
    if (ok) toast(isStandalone() ? '已保存到这台设备' : '已保存到服务端', 'ok');
    else toast('保存失败：' + ((store.lastError && store.lastError.message) || '未知原因'), 'err');
  });

  store.on((evt) => {
    if (evt.type === 'status' || evt.type === 'saved' || evt.type === 'save-error') paint();
  });
  paint();
  return paint;
}

/* ---------------------------- 离开页面前落盘 ---------------------------- */
function initUnloadGuard() {
  const flush = () => { store.flushOnHide(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', (e) => {
    flush();
    // 只有在「确实还有没写进去的改动、而且已经卡了 1.5 秒以上」时才拦一下
    if (store.dirty && Date.now() - store.dirtySince > 1500) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
    return undefined;
  });
}

/* ---------------------------- 启动 ---------------------------- */
async function boot() {
  initOverlay();
  initStage();

  // 先判断跑在哪：本地服务端，还是纯静态托管
  await detectMode();
  document.body.dataset.mode = isStandalone() ? 'standalone' : 'server';

  // 教材数据自检
  const subjectCount = (CURRICULUM.subjects || []).length;
  if (!subjectCount) {
    document.body.innerHTML =
      '<div style="position:fixed;inset:0;display:grid;place-items:center;color:#e8cf8c;' +
      'font-family:KaTi,SimSun,serif;font-size:17px;text-align:center;line-height:2;padding:40px">' +
      '教材目录数据没有加载成功。<br>请确认 public/data/curriculum.js 存在，然后刷新页面。</div>';
    return;
  }

  // 访问口令只在服务端模式下存在；纯网页模式没有服务端，也就没有口令一说
  let cfg = null;
  if (isStandalone()) {
    try { cfg = await api.loadConfig(); } catch { /* ignore */ }
  } else {
    try {
      cfg = await ensureUnlocked();
    } catch (e) {
      toast('连不上服务端：' + e.message, 'err');
    }
  }
  setGearAlert(!(cfg && cfg.hasKey));

  initWrongbook();
  initMemo();
  initSettings();

  // 再读服务端数据，据此初始化界面（否则会用到默认值）
  await store.init();
  applyStage();

  initBook({
    onPickSection: (id) => enterSection(id),
  });

  initStudy({
    onEnterSection: (id) => enterSection(id),
    onCollect: (msg) => collectFromMessage(msg, currentSectionId()),
    onRefreshBook: () => { try { refreshBook(); } catch { /* ignore */ } },
  });

  // 顶栏
  $('#btn-back-desk').addEventListener('click', () => {
    showView('desk');
    showDesk();
    try { refreshBook(); } catch { /* ignore */ }
  });

  try { refreshBook(); } catch { /* ignore */ }
  refreshWrongbook();
  refreshMemo();

  initSaveBar();
  initUnloadGuard();

  store.on((evt) => {
    if (evt.type === 'save-error') toast('保存失败：' + (evt.error && evt.error.message || ''), 'err');
    if (evt.type === 'wrongbook') refreshWrongbook();
    if (evt.type === 'memo') refreshMemo();
  });

  // 顶栏显示当前模型
  try {
    if (!cfg) cfg = await api.loadConfig();
    const m = $('#composer-model');
    if (m) {
      const modeTag = isStandalone() ? '纯网页 · ' : '';
      m.textContent = cfg.hasKey ? (modeTag + '模型　' + cfg.model) : (modeTag + '尚未配置 API Key · 点右下角齿轮');
    }
  } catch { /* ignore */ }

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeTop();
      closeWrongbook();
      closeMemo();
    }
    // Ctrl/Cmd + K 切换错题本
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggleWrongbook();
    }
    // Ctrl/Cmd + J 切换备忘录
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      toggleMemo();
    }
  });

  // 窗口尺寸变化时重绘图像
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      applyStage();
      document.querySelectorAll('[data-figure="plot"]').forEach((f) => { f.dataset.drawn = ''; });
      import('./math.js').then((m) => m.hydratePlots(document)).catch(() => {});
    }, 320);
  });

  if (isStandalone()) {
    document.title = '高中学习书房 · ' + modeLabel();
    setTimeout(() => toast('纯网页模式：数据存在这台设备的浏览器里', ''), 1200);
  } else if (!('ontouchstart' in window)) {
    setTimeout(() => toast('点书封面翻开，左页选学科，右页翻页选章节', ''), 900);
  }
}

function currentSectionId() { return currentSection(); }

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML =
    '<div style="position:fixed;inset:0;display:grid;place-items:center;color:#e8cf8c;' +
    'font-family:KaTi,SimSun,serif;font-size:16px;text-align:center;line-height:2;padding:40px">' +
    '启动失败：' + String(e && e.message || e) + '<br>请确认已通过 start.bat 启动服务（不是直接双击 index.html）。</div>';
});
