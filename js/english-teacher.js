/* ===========================================================
   english-teacher.js —— 英语板块的四个提示词与结果校验
   硬约束（每一处都带）：不产出范文、不给万能句；只从学生原文出发。
   =========================================================== */
import { callOnce } from './teacher.js';

const RULES = [
  '【共同规则｜必须遵守】',
  '1. 学生母语是中文，英语约 130 分（应用文 8 成、续写 7.5 成）。解释一律用中文，例句用英文。',
  '2. 禁止提供范文、万能句、模板套话、书信套语清单。',
  '3. 所有「升级表达」必须由学生原文里已经出现的词、或同族词构成；学生没写的内容，只给方向，不给句子。',
  '4. 例句必须真实、常用，不造生僻搭配；每条意见都要能落到具体一处，不要泛泛而谈。',
  '5. 不评判人品、不谈学习方法，只谈这一段文字。',
].join('\n');

const FENCE = String.fromCharCode(96, 96, 96);
const noop = () => {};

/** 统一入口：总是走流式（有进度可看），并从返回对象里取正文 */
async function askOnce(system, user, onDelta) {
  const r = await callOnce({ system: system, user: user, onDelta: onDelta || noop });
  if (typeof r === 'string') return r;
  return String((r && r.text) || '');
}

function stripFence(text) {
  return String(text || '').split(FENCE).join('').trim();
}

/** 从模型输出里抠出第一个 JSON 对象 */
export function parseJsonLoose(text) {
  const s = stripFence(text);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('没读到 JSON');
  const raw = s.slice(a, b + 1);
  try {
    return JSON.parse(raw);
  } catch (err) {
    const relaxed = raw.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(relaxed);
  }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s,，.。;；:：!！?？'"“”‘’()（）\-—…]/g, '');

/** 校验 upgrades：from 必须能在原文里找到；找不到的降级为方向提示 */
export function validateUpgrades(review, essayText) {
  const text = norm(essayText);
  const out = Array.isArray(review && review.upgrades) ? review.upgrades : [];
  return out.slice(0, 4).map((u) => {
    const from = String(u && u.from || '').trim();
    const to = String(u && u.to || '').trim();
    const hit = from && text.indexOf(norm(from)) >= 0;
    return { from: from, to: to, why: String(u && u.why || '').trim(), weak: !hit };
  });
}

function clampScore(score) {
  const s = Object.assign({ content: null, language: null, structure: null, total: null }, score || {});
  const fix = (v, max) => {
    const n = Number(v);
    if (!isFinite(n)) return null;
    return Math.max(0, Math.min(max, Math.round(n)));
  };
  return {
    content: fix(s.content, 15),
    language: fix(s.language, 15),
    structure: fix(s.structure, 15),
    total: fix(s.total, 30),
  };
}

/** 词卡讲解：点「讲一下」才调用；调用方负责缓存 */
export async function explainWord(word, onDelta) {
  const user = [
    '词：' + word.w + (word.pos ? '（' + word.pos + '）' : ''),
    '常见义：' + word.cn,
    '搭配：' + ((word.collocations || []).map((c) => c.ph + '=' + c.cn).join('；') || '无'),
    '易混：' + ((word.confusions || []).map((c) => c.diff).join('；') || '无'),
    '',
    '请按这个顺序讲，总长不超过 150 字：',
    '① 一句话人话释义（不要用「表示…」）；② 两个真实搭配各一句短例；③ 一处最容易用错的地方（和哪个词混）。',
  ].join('\n');
  const text = await askOnce(RULES + '\n\n【角色】英语词汇教练，只在学生问的时候讲一个词的用法。', user, onDelta);
  return String(text || '').trim();
}

/** 作文批改：kind = app | cont */
export async function reviewEssay(input, onDelta) {
  const kindName = input.kind === 'cont' ? '读后续写' : '应用文（小作文）';
  const user = [
    '【体裁】' + kindName,
    '【题目】' + (input.title || ''),
    '【情境】' + (input.scenario || ''),
    '【要点】' + ((input.points || []).join('；') || '未给出'),
    '【常见陷阱】' + ((input.traps || []).join('；') || '无'),
    '【建议字数】' + (input.target || ''),
    '【学生原文】',
    input.text,
    '',
    '请只输出一个 JSON（不要解释、不要代码块围栏），字段如下：',
    '{',
    '  "score": { "content": 0-15, "language": 0-15, "structure": 0-15, "total": 0-30 },',
    '  "issues": [ { "quote": "原文片段（必须逐字摘自原文）", "type": "冠词|时态|主谓一致|单复数|介词搭配|动词搭配|词性|中式表达|句子过长|句子过碎|连接词|要点缺失", "fix": "怎么改，一句话" } ],',
    '  "upgrades": [ { "from": "学生原句片段", "to": "改写后的句子（只用学生已有的词或同族词）", "why": "为什么更好，一句话" } ],',
    '  "stats": { "repeatWords": ["重复用的词"], "sentenceLength": "短|中|长" },',
    '  "nextTip": "下次只改的一件事，一句话",',
    '  "beats": { "stimulus": "有|无", "reaction": "有|无", "action": "有|无", "sense": "有|无", "inner": "有|无" },',
    '  "plot": "有推进|偏平|矛盾"',
    '}',
    '要求：issues 3~6 条，必须逐字引用原文；upgrades 恰好 3 条，且 from 必须是原文里真实存在的片段；不要改写整篇。',
    input.kind === 'cont' ? '续写额外要求：beats 与 plot 必须填，用来判断情节有没有推进。' : '应用文不填 beats/plot，给空字符串即可。',
  ].join('\n');
  const text = await askOnce(RULES + '\n\n【角色】英语写作批改者。你只诊断、只局部改写，不写范文。', user, onDelta);
  const review = parseJsonLoose(text);
  review.score = clampScore(review.score);
  review.upgrades = validateUpgrades(review, input.text);
  review.issues = (Array.isArray(review.issues) ? review.issues : []).slice(0, 8).map((it) => ({
    quote: String(it && it.quote || '').slice(0, 200),
    type: String(it && it.type || '问题').slice(0, 12),
    fix: String(it && it.fix || '').slice(0, 200),
  }));
  review.nextTip = String(review.nextTip || '').slice(0, 120);
  return review;
}

/** 从学生原文里挑可复用表达（不生成新句） */
export async function extractVault(input, onDelta) {
  const user = [
    '【学生原文】',
    input.text,
    '',
    '从这个学生的原文里挑 3~5 句他自己写的、以后可能重复用的表达（结构、衔接、描写、修辞都算）。',
    '只输出 JSON：{ "candidates": [ { "en": "原文原样摘出的句子", "cn": "这句好在哪（中文，20字内）", "func": "开头|建议|结尾|描写|情绪|转折", "structure": "倒装|非谓语|被动|从句|强调|名词化|普通句", "scene": "应用文|续写|通用" } ] }',
    '严禁改写、严禁新造句子；en 必须逐字来自原文。',
  ].join('\n');
  const text = await askOnce(RULES + '\n\n【角色】帮学生整理「他自己的表达卡」。', user, onDelta);
  const out = parseJsonLoose(text);
  return { candidates: (Array.isArray(out.candidates) ? out.candidates : []).slice(0, 5) };
}
