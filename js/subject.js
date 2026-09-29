/* ===========================================================
   subject.js —— 教材目录（window.CURRICULUM）的查询辅助
   =========================================================== */
import { $ } from './util.js';

export const CURRICULUM = window.CURRICULUM || { version: '未载入', subjects: [] };

const INDEX = new Map();   // sectionId -> { subject, volume, chapter, section }
const VINDEX = new Map();  // volumeId  -> { subject, volume }
const CINDEX = new Map();  // chapterId -> { subject, volume, chapter }

(function buildIndex() {
  for (const subject of CURRICULUM.subjects || []) {
    for (const volume of subject.volumes || []) {
      VINDEX.set(volume.id, { subject, volume });
      for (const chapter of volume.chapters || []) {
        CINDEX.set(chapter.id, { subject, volume, chapter });
        for (const section of chapter.sections || []) {
          INDEX.set(section.id, { subject, volume, chapter, section });
        }
      }
    }
  }
})();

export const subjects = () => CURRICULUM.subjects || [];
export const getSubject = (id) => subjects().find((s) => s.id === id) || null;
export const getVolumeWrap = (id) => VINDEX.get(id) || null;
export const getChapterWrap = (id) => CINDEX.get(id) || null;
export const getSectionWrap = (id) => INDEX.get(id) || null;

export function allSections(subjectId) {
  const s = getSubject(subjectId);
  if (!s) return [];
  const out = [];
  for (const v of s.volumes) for (const c of v.chapters) for (const sec of c.sections) out.push(sec);
  return out;
}

export function subjectStats(subject, progress = {}) {
  let total = 0, done = 0, studying = 0;
  for (const v of subject.volumes || []) {
    for (const c of v.chapters || []) {
      for (const s of c.sections || []) {
        total++;
        const st = progress[s.id] && progress[s.id].status;
        if (st === 'done') done++;
        else if (st === 'studying') studying++;
      }
    }
  }
  return { total, done, studying, rate: total ? done / total : 0 };
}

export function chapterStats(chapter, progress = {}) {
  const total = (chapter.sections || []).length;
  let done = 0;
  for (const s of chapter.sections || []) if (progress[s.id] && progress[s.id].status === 'done') done++;
  return { total, done, rate: total ? done / total : 0 };
}

export function volumeStats(volume, progress = {}) {
  let total = 0, done = 0;
  for (const c of volume.chapters || []) {
    const st = chapterStats(c, progress);
    total += st.total; done += st.done;
  }
  return { total, done, chapters: (volume.chapters || []).length, rate: total ? done / total : 0 };
}

/** 某节在整册中的先后顺序，用于「上一节 / 下一节」 */
export function neighbors(sectionId) {
  const w = getSectionWrap(sectionId);
  if (!w) return { prev: null, next: null };
  const list = [];
  for (const c of w.volume.chapters) for (const s of c.sections) list.push(s);
  const i = list.findIndex((s) => s.id === sectionId);
  return { prev: list[i - 1] || null, next: list[i + 1] || null };
}

/** 该节所属章的全部小节 */
export function siblings(sectionId) {
  const w = getSectionWrap(sectionId);
  return w ? w.chapter.sections : [];
}

export const SUBJECT_COLORS = { math: '#96602c', physics: '#3f5f92', biology: '#40714f' };
export const subjectColor = (id) => {
  const s = getSubject(id);
  return (s && s.color) || SUBJECT_COLORS[id] || '#8a5a2b';
};

/** 节的规范称呼：物理用「第3节 摩擦力」，数学/生物用「3.1 集合的概念」 */
export function sectionRef(section) {
  const no = String(section.no || '').trim();
  return /^\d+$/.test(no)
    ? ('第 ' + no + ' 节　' + section.name)
    : (no + '　' + section.name);
}

/** 给 AI 的教材定位描述 */
export function locateText(sectionId) {
  const w = getSectionWrap(sectionId);
  if (!w) return '';
  return w.subject.name + ' · ' + w.volume.name + ' · ' + w.chapter.no + ' ' + w.chapter.name + ' · ' + sectionRef(w.section);
}
