/* ===========================================================
   book.js —— 书桌上的牛皮书：封面 → 翻开 → 选科 → 翻页选章
   =========================================================== */
import { $, el, toast } from './util.js';
import { store } from './store.js';
import {
  subjects, getSubject, getSectionWrap,
  subjectStats, chapterStats, volumeStats, subjectColor,
} from './subject.js';

const PER_PAGE_CHAPTERS = 4;
const PER_PAGE_SECTIONS = 6;

const view = {
  open: false,
  subjectId: null,
  volumeId: null,
  mode: 'chapters',   // chapters | sections
  chapterId: null,
  page: 0,
};

let onPickSection = () => {};
let dom = {};

/* ---------------------------- 工具 ---------------------------- */
function pageCount(total, per) { return Math.max(1, Math.ceil(total / per)); }

function turnSheet(fn) {
  const sheet = dom.turnSheet;
  if (!sheet || !view.open) { fn(); return; }
  sheet.classList.remove('is-turning');
  void sheet.offsetWidth;
  sheet.classList.add('is-turning');
  setTimeout(fn, 190);
  setTimeout(() => sheet.classList.remove('is-turning'), 520);
}

/* ---------------------------- 左页 ---------------------------- */
function renderLeft() {
  const box = dom.pageLeft;
  box.innerHTML = '';

  const head = el('div', { class: 'page-head' }, [
    el('span', { class: 'page-kicker', text: '学科' }),
    el('span', { class: 'page-folio', text: '卷 一' }),
  ]);
  const body = el('div', { class: 'page-body' });

  const list = el('div', { class: 'subject-list' });
  for (const s of subjects()) {
    const st = subjectStats(s, store.state.progress);
    const item = el('button', {
      class: 'subject-item' + (s.id === view.subjectId ? ' is-on' : ''),
      dataset: { subject: s.id },
      onclick: () => pickSubject(s.id),
    }, [
      el('span', { class: 'subject-symbol', text: s.short || s.name[0] }),
      el('span', { class: 'subject-text' }, [
        el('span', { class: 'subject-name', text: s.name }),
        el('span', { class: 'subject-meta', text: s.volumes.length + ' 册 · ' + st.total + ' 节 · 已学 ' + st.done + ' 节' }),
      ]),
      el('span', { class: 'subject-arrow', text: '›' }),
    ]);
    list.append(item);
  }
  body.append(list);

  const subject = getSubject(view.subjectId);
  if (subject) {
    body.append(el('div', { class: 'sub-head', text: '教材' }));
    const vols = el('div', { class: 'volume-list' });
    for (const v of subject.volumes) {
      const vs = volumeStats(v, store.state.progress);
      vols.append(el('button', {
        class: 'volume-item' + (v.id === view.volumeId ? ' is-on' : ''),
        onclick: () => pickVolume(v.id),
      }, [
        el('span', { class: 'volume-stage', text: v.stage || '必修', dataset: { stage: v.stage || '必修' } }),
        el('span', { class: 'volume-name', text: v.name }),
        el('span', { class: 'volume-count', text: vs.chapters + ' 章 / ' + vs.total + ' 节' }),
      ]));
    }
    body.append(vols);
  }

  const foot = el('div', { class: 'page-foot' }, [
    el('span', { text: subject ? subject.name + ' · 人教版 2019' : '人教版 2019 新课标' }),
    el('span', { text: view.open ? '目录' : '' }),
  ]);

  box.append(head, body, foot);
}

/* ---------------------------- 右页 ---------------------------- */
function renderRight() {
  const box = dom.pageRight;
  box.innerHTML = '';
  const subject = getSubject(view.subjectId);
  const volume = subject && subject.volumes.find((v) => v.id === view.volumeId);

  if (!volume) {
    box.append(el('div', { class: 'page-head' }, [
      el('span', { class: 'page-kicker', text: '序' }),
    ]));
    const pre = el('div', { class: 'page-body' }, [
      el('div', { class: 'preface' }, [
        el('span', { class: 'lead', text: '夫' }),
        el('p', { text: '学不可以已。这本册子里放着高中数学、物理、生物三科，共十六本教材的完整目录，按人教版 2019 新课标编排。' }),
        el('p', { text: '左边点一个学科，再点一本教材，右边的目录就会翻到你面前。挑一节，先生就开讲。' }),
        el('p', { text: '左上角那个方框是错题本，右上角的菱形是备忘录——它们随时都在，上课时也能打开。' }),
        el('p', { class: 'quiet', text: '—— 先生 识' }),
      ]),
    ]);
    box.append(pre, el('div', { class: 'page-foot' }, [el('span', { text: '请先选择学科' })]));
    return;
  }

  const per = view.mode === 'chapters' ? PER_PAGE_CHAPTERS : PER_PAGE_SECTIONS;
  const items = view.mode === 'chapters'
    ? volume.chapters
    : (volume.chapters.find((c) => c.id === view.chapterId) || { sections: [] }).sections;
  const pages = pageCount(items.length, per);
  if (view.page >= pages) view.page = pages - 1;
  if (view.page < 0) view.page = 0;
  const slice = items.slice(view.page * per, view.page * per + per);

  // 天头
  const head = el('div', { class: 'page-head' }, [
    view.mode === 'sections'
      ? el('button', { class: 'back-link', text: '‹ 返回目录', onclick: () => gotoChapters() })
      : el('span', { class: 'page-kicker', text: '目录' }),
    el('span', { class: 'page-folio', text: subject.name + ' · ' + volume.name + '　第 ' + (view.page + 1) + ' / ' + pages + ' 页' }),
  ]);
  box.append(head);

  const body = el('div', { class: 'page-body' });

  if (view.mode === 'chapters') {
    const list = el('div', { class: 'chapter-list' });
    for (const c of slice) {
      const cs = chapterStats(c, store.state.progress);
      const mark = cs.done === 0 ? '0' : (cs.done >= cs.total ? '2' : '1');
      list.append(el('button', {
        class: 'chapter-item',
        dataset: { done: mark },
        onclick: () => gotoChapter(c.id),
      }, [
        el('span', { class: 'progress-dot' }),
        el('span', { class: 'chapter-no', text: c.no }),
        el('span', { class: 'chapter-name', text: c.name }),
        el('span', { class: 'chapter-count', text: cs.total + ' 节' + (cs.done ? ' · 已学 ' + cs.done : '') }),
      ]));
    }
    body.append(list);
  } else {
    const chapter = volume.chapters.find((c) => c.id === view.chapterId);
    if (chapter) {
      body.append(el('div', { class: 'chapter-banner' }, [
        el('span', { class: 't' }, [
          el('b', { text: chapter.no + '　' + chapter.name }),
          el('span', { text: '共 ' + chapter.sections.length + ' 节　·　点任意一节开始上课' }),
        ]),
      ]));
    }
    const list = el('div', { class: 'section-list' });
    for (const s of slice) {
      const p = store.progressOf(s.id);
      const stateText = p.status === 'done' ? '已学完' : (p.status === 'studying' ? '学到一半' : '未开始');
      list.append(el('button', {
        class: 'section-item',
        onclick: () => onPickSection(s.id),
      }, [
        el('span', { class: 'section-no', text: s.no }),
        el('span', { class: 'section-name', text: s.name }),
        el('span', { class: 'section-state', text: stateText, dataset: { state: p.status } }),
      ]));
    }
    body.append(list);
  }
  box.append(body);

  // 地脚 + 翻页
  const foot = el('div', { class: 'page-foot' });
  if (pages > 1) {
    const dots = el('div', { class: 'turn-dots' });
    for (let i = 0; i < pages; i++) dots.append(el('span', { class: 'turn-dot' + (i === view.page ? ' is-on' : '') }));
    const turn = el('div', { class: 'page-turn' }, [
      el('button', {
        class: 'turn-btn', text: '‹ 上一页',
        disabled: view.page === 0,
        onclick: () => flip(-1),
      }),
      dots,
      el('button', {
        class: 'turn-btn', text: '下一页 ›',
        disabled: view.page >= pages - 1,
        onclick: () => flip(1),
      }),
    ]);
    foot.append(turn);
  } else {
    foot.append(el('span', { text: items.length + (view.mode === 'chapters' ? ' 章' : ' 节') }));
    foot.append(el('span', { text: '' }));
  }
  box.append(foot);
}

/* ---------------------------- 交互 ---------------------------- */
function pickSubject(id) {
  if (view.subjectId === id) return;
  const s = getSubject(id);
  if (!s) return;
  view.subjectId = id;
  view.volumeId = (s.volumes[0] || {}).id || null;
  view.mode = 'chapters';
  view.chapterId = null;
  view.page = 0;
  store.setPref('lastSubject', id);
  store.setPref('lastVolume', view.volumeId);
  turnSheet(() => { renderLeft(); renderRight(); });
}

function pickVolume(id) {
  if (view.volumeId === id && view.mode === 'chapters') return;
  view.volumeId = id;
  view.mode = 'chapters';
  view.chapterId = null;
  view.page = 0;
  store.setPref('lastVolume', id);
  turnSheet(() => { renderLeft(); renderRight(); });
}

function gotoChapter(id) {
  view.mode = 'sections';
  view.chapterId = id;
  view.page = 0;
  turnSheet(renderRight);
}

function gotoChapters() {
  view.mode = 'chapters';
  view.chapterId = null;
  view.page = 0;
  turnSheet(renderRight);
}

function flip(dir) {
  view.page += dir;
  turnSheet(renderRight);
}

function openBook() {
  if (view.open) return;
  view.open = true;
  dom.book.classList.add('is-open');
  dom.cover.classList.add('is-flipped');
  setTimeout(() => { dom.cover.style.display = 'none'; }, 620);
  setTimeout(() => { renderLeft(); renderRight(); }, 240);
}

function closeBook() {
  view.open = false;
  dom.cover.style.display = '';
  void dom.cover.offsetWidth;
  dom.book.classList.remove('is-open');
  dom.cover.classList.remove('is-flipped');
}

/* ---------------------------- 对外 ---------------------------- */
export function initBook(opts = {}) {
  onPickSection = opts.onPickSection || (() => {});
  dom = {
    view: $('#view-desk'),
    book: $('#book'),
    cover: $('#book-cover'),
    pageLeft: $('#page-left'),
    pageRight: $('#page-right'),
    turnSheet: $('#turn-sheet'),
  };

  // 恢复上次的位置；第一次使用时什么都不选，让右页先显示序言
  const prefs = store.state.prefs || {};
  view.subjectId = prefs.lastSubject && getSubject(prefs.lastSubject) ? prefs.lastSubject : null;
  const subj = getSubject(view.subjectId);
  if (subj) {
    const want = prefs.lastVolume && subj.volumes.some((v) => v.id === prefs.lastVolume);
    view.volumeId = want ? prefs.lastVolume : (subj.volumes[0] || {}).id || null;
  } else {
    view.volumeId = null;
  }
  view.open = false;
  view.mode = 'chapters';
  view.page = 0;

  dom.cover.addEventListener('click', openBook);
  dom.cover.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openBook(); });
  dom.cover.tabIndex = 0;

  renderLeft();
  renderRight();
}

export function showDesk() {
  view.open = false;
  dom.cover.style.display = '';
  void dom.cover.offsetWidth;
  dom.book.classList.remove('is-open');
  dom.cover.classList.remove('is-flipped');
  setTimeout(() => { renderLeft(); renderRight(); }, 100);
}

export function openToSection(sectionId) {
  const w = getSectionWrap(sectionId);
  if (!w || !dom.book) return;
  view.subjectId = w.subject.id;
  view.volumeId = w.volume.id;
  view.mode = 'sections';
  view.chapterId = w.chapter.id;
  view.page = Math.floor(w.chapter.sections.findIndex((s) => s.id === sectionId) / PER_PAGE_SECTIONS);
  if (view.page < 0) view.page = 0;
  if (!view.open) openBook();
  renderLeft();
  renderRight();
}

export const bookState = view;
export function refreshBook() { if (dom.pageLeft) { renderLeft(); renderRight(); } }
