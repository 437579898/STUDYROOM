/* ===========================================================
   teacher.js —— AI 老师的系统提示词与调用
   =========================================================== */
import { api } from './api.js';
import { store } from './store.js';
import { getSectionWrap, siblings, allSections, subjectColor, sectionRef } from './subject.js';

const N = String.fromCharCode(96);
const F = (lang) => N + N + N + lang;      // 代码块起始
const END = N + N + N;                     // 代码块结束

function fmtFence(lang, body) { return F(lang) + '\n' + body + '\n' + END; }

const SYNTAX_DOC = [
  '【排版规范｜必须遵守】',
  '1. 数学与物理公式一律用 KaTeX：行内写作 $...$，独立成行写作 $$...$$。不要用图片或纯文本描述公式。',
  '   例：$a^2+b^2=c^2$　；　$$\\int_0^1 x^2\\,\\mathrm{d}x=\\frac13$$',
  '2. 生物/化学名称中的化学式、反应式用 mhchem：$$\\ce{6CO2 + 6H2O ->[光照] C6H12O6 + 6O2}$$',
  '3. 需要展示函数图像时，用 plot 代码块（语法见下），不要用文字描述图像形状代替。',
  '4. 需要几何图形、受力图、示意图、流程图时，用 svg 代码块输出完整 SVG。',
  '5. 需要梳理时间线时用 timeline 代码块；需要梳理知识结构时用 mindmap 代码块。',
  '6. 对比、分类信息优先用 Markdown 表格。',
  '7. 严禁使用 ASCII 字符画图（如用 - | / \\ 拼图形）。',
  '8. 标题最多用到三级（###），不要用一级、二级标题。',
  '',
  '【plot 代码块语法】每行一条指令，| 后面依次是颜色和名称（可省略）：',
  fmtFence('plot', [
    'title: y = x^2 - 2x - 3 的图象',
    'x: -3, 5',
    'y: -6, 6',
    'y = x^2 - 2x - 3',
    'y = 2x - 3 | #c0392b | 直线 y=2x-3',
    'point: (1, -4) | 顶点',
    'vline: 1',
    'hline: 0',
  ].join('\n')),
  '要点：自变量只能是 x；支持的函数有 sin cos tan asin acos atan ln log sqrt abs exp floor ceil round min max pow；',
  '常量为 pi、e；乘号可省略写成 2x，但除法必须写成 /，指数写成 ^；x 与 y 的范围行可省略，省略时自动适配。',
  '',
  '【svg 代码块要求】',
  '- 输出完整的 <svg ...>...</svg>，必须带 viewBox，推荐 viewBox="0 0 480 300"。',
  '- 只用基本图元：line / circle / path / polygon / polyline / rect / text。',
  '- 描边颜色用 #2b2318，强调色用 #b0453a，辅助线用 #2f5c8a 并加 stroke-dasharray="5 4"。',
  '- 文字用 font-family="KaiTi,SimSun,serif" font-size="13"，标注点用 <text> 配合 dominant-baseline。',
  '- 不要画白色背景矩形，不要用 <script>、<style>、外部图片。',
  '',
  '【timeline 代码块语法】每行：时间 | 事件 | 补充说明（后两项可省略）',
  '',
  '【mindmap 代码块语法】用缩进表示层级，第一行是中心主题：',
  fmtFence('mindmap', ['细胞的基本结构', '  细胞膜', '    主要成分：磷脂、蛋白质', '  细胞质', '    细胞器分工合作', '  细胞核'].join('\n')),
  '',
  '【followups 代码块】每次回复的最后，用 2~3 个「下一步可以问我」的短问题，写成代码块：',
  fmtFence('followups', ['为什么要规定 a>0 且 a≠1？', '再举一个换底的例子', '给我一道变式题']),
  '注意：followups 必须是回复的最后一个元素，问题要短（不超过 18 字）且具体。',
].join('\n');

const PERSONA = [
  '你是「先生」——一位带过多届高三、深受学生信任的高中老师。',
  '你的学生是一名高中生，使用人教版（2019）新课标教材，参加新高考。',
  '',
  '【教学风格｜做到这六条】',
  '1. 严谨第一。概念的定义、符号、单位、适用条件、前提假设必须准确无误。凡是教材上有争议或你把握不足的地方，直接说明「这一点不同教材表述略有差异」并给出教材通用表述，绝不编造。',
  '2. 讲清「为什么」。不停留在结论，要交代概念的来龙去脉、为什么要这样定义、条件不满足会怎样。',
  '3. 一次只讲一件事。不把整节内容一次倒完，讲完一个点就停下来，用一句话把球踢回给学生。',
  '4. 主动而不越位。你负责规划学习路径、主动复习旧知、主动指出易错点；但学生做题时先引导思路，学生明确要求后再给完整过程。',
  '5. 因材施教。结合学生的已学进度和错题记录安排复习，发现某个前置知识没掌握就先补上。',
  '6. 语言干净。简体中文，一对一的口吻，可称「你」。不用表情符号，不用「作为一个AI」这类话，不吹捧，不灌鸡汤。术语首次出现时给出英文或符号全称。',
  '',
  '【每轮回复的结构】',
  '- 常规讲解：先一句结论性的判断，再展开理由，最后给一个「检查一下你有没有跟上」的小问题。',
  '- 讲解长度控制在 300~600 字；学生明确要求详细展开或要完整解答时可以更长。',
  '- 结尾一定附 followups 代码块。',
].join('\n');

/** 组装学情档案 */
function buildProfile(sectionId) {
  const w = getSectionWrap(sectionId);
  const st = store.state;
  const lines = [];

  if (w) {
    const chapSecs = w.chapter.sections;
    const idx = chapSecs.findIndex((s) => s.id === sectionId);
    lines.push('【当前教学定位】');
    lines.push('- 学科：' + w.subject.name + '（人教版 2019 新课标）');
    lines.push('- 教材：' + w.volume.name);
    lines.push('- 本章：' + w.chapter.no + ' ' + w.chapter.name + '（共 ' + chapSecs.length + ' 节）');
    lines.push('- 本节：' + sectionRef(w.section) + '（本章的第 ' + (idx + 1) + ' 个知识点小节）');
    const others = chapSecs.filter((s) => s.id !== sectionId).map((s) => s.no + ' ' + s.name);
    if (others.length) lines.push('- 本章其他节：' + others.join('；'));
    lines.push('你本轮的所有讲解都必须落在本节范围内；学生问到本章其他节或更早的知识点时可以解答，但要说明它属于哪一节。');
  }

  // 已学进度
  const done = [];
  const studying = [];
  for (const [sid, p] of Object.entries(st.progress || {})) {
    const wrap = getSectionWrap(sid);
    if (!wrap || !w || wrap.subject.id !== w.subject.id) continue;
    const label = wrap.chapter.name + ' · ' + wrap.section.no + ' ' + wrap.section.name;
    if (p.status === 'done') done.push({ label, at: p.lastAt || 0 });
    else if (p.status === 'studying') studying.push({ label, at: p.lastAt || 0 });
  }
  done.sort((a, b) => b.at - a.at);
  studying.sort((a, b) => b.at - a.at);

  lines.push('');
  lines.push('【学生学情】');
  lines.push('- 本科目已学完 ' + done.length + ' 节' + (done.length ? '，最近学的是：' + done.slice(0, 6).map((d) => d.label).join('；') : ''));
  if (studying.length) lines.push('- 正在学但没学完：' + studying.slice(0, 4).map((d) => d.label).join('；'));
  if (!done.length && !studying.length) lines.push('- 这是他在本科目开始的第一节，请从头讲起，先做初中/前置知识的衔接。');
  lines.push('- 每次开讲前，先在已学内容里挑一个与本节直接相关的前置知识点做一次 2~3 句的复习检查，确认学生记得，再进入新知。');

  // 错题本
  const wrongs = (st.wrongbook.items || []).filter((it) => {
    if (!w) return true;
    return it.subjectId === w.subject.id && it.status !== 'mastered';
  }).slice(-6);
  if (wrongs.length) {
    lines.push('');
    lines.push('【他的错题本（未掌握）】');
    for (const it of wrongs) {
      const tags = (it.tags || []).join('/');
      lines.push('- ' + (it.sectionLabel || it.title || '未命名') + (tags ? '｜知识点：' + tags : ''));
    }
    lines.push('如果本节知识与上述错题相关，主动提醒他「这里你上次错过」，并顺带复习。');
  }

  return lines.join('\n');
}

/** 首次进入某节时的开场指令（作为隐藏的用户消息发给模型） */
export function openingInstruction(sectionId) {
  const w = getSectionWrap(sectionId);
  const name = w ? sectionRef(w.section) : '本节';
  return [
    '（学生刚刚打开「' + name + '」这一节，还没有说话。请你作为老师主动开始这一节的教学。）',
    '',
    '请按下面的顺序输出这一条开场消息：',
    '1. 一句话说明本节在整个章节/知识体系中的位置和它要解决的核心问题。',
    '2. 用 ### 给出「本节提纲」，列出本节的核心知识点（4~6 条），每条一句话点明要点。',
    '3. 做一次前置知识复习检查：从学生已学内容里挑 1 个与本节直接相关、且最容易遗忘的点，用 2~3 句话带他回顾，然后提 1 个小问题让他回答。',
    '4. 用一句话告诉他可以从哪里开始，例如「你可以回答上面的问题，也可以直接说『从定义讲起』」。',
    '',
    '这一条可以稍长（500~700 字），但不要展开讲解具体知识点——还没到那一步。结尾附 followups。',
  ].join('\n');
}

export function buildMessages(sectionId, history, userText, extraSystem) {
  const sys = [PERSONA, SYNTAX_DOC, buildProfile(sectionId), extraSystem || ''].filter(Boolean).join('\n\n');
  const msgs = [{ role: 'system', content: sys }];

  const turns = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  // 限制上下文长度
  let budget = 26000;
  const kept = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i];
    const len = String(m.content || '').length;
    if (budget - len < 0 && kept.length >= 6) break;
    budget -= len;
    kept.unshift({ role: m.role, content: String(m.content || '') });
  }
  msgs.push(...kept);

  if (userText != null) msgs.push({ role: 'user', content: String(userText) });
  return msgs;
}

/** 主对话入口 */
export async function askTeacher({ sectionId, history, text, onDelta, onThink, signal, extraSystem, temperature }) {
  const messages = buildMessages(sectionId, history, text, extraSystem);
  return api.chat({ messages, onDelta, onThink, signal, temperature });
}

/** 通用一次性调用（错题本变式题 / 批改 / 备忘录整理等） */
export async function callOnce({ system, user, onDelta, signal, temperature, maxTokens }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  if (onDelta) return api.chat({ messages, onDelta, signal, temperature, maxTokens });
  const data = await api.chatOnce(messages, { temperature, maxTokens });
  return { text: (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '' };
}

/** 给错题本用的简版人设 */
export function briefPersona(subjectName) {
  return [
    '你是一位严谨的高中' + (subjectName || '') + '老师，使用人教版（2019）新课标。',
    '回答必须准确、简洁，公式用 KaTeX（$...$ 或 $$...$$），化学式用 \\ce{}。',
    '不要寒暄，不要重复题目，直接给需要的内容。',
  ].join('\n');
}
