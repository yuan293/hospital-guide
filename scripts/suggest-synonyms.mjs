#!/usr/bin/env node
/**
 * 同义表盲区发现（suggest-synonyms）
 * ================================
 * 「能力增长的系统性来源」——把"人肉想该登记什么口语"变成"机器挖出候选，人来决定"。
 *
 * 它做什么
 * --------
 *   1. 对一批主诉语料跑**纯规则口径**（同义/形态全关），收集 status=human 且
 *      reasonCode=unmatched 的**未命中**输入。
 *   2. 对未命中输入做「候选核心词」提取：找出既高频、又**未出现在任何现有词表/同义表**
 *      里的片段。
 *   3. 交叉比对现有部门关键词与 47 组同义表，给每个候选判定：
 *        · 建议登记（有明确科室指向 + 高频）
 *        · 存疑待议（泛化表达 / 指向不明）
 *        · 反建议：不要登记（本就是"说不清"，正确行为就是转人工）
 *   4. 对建议生成候选正则，并**预演误配**：会不会误伤现有用例。
 *
 * 它**不做什么**（设计边界，硬编码）
 * --------------------------------
 *   · 绝不修改任何文件。只输出报告到 stdout（可选 --json 写一份报告文件，但不写数据文件）。
 *   · 绝不自作主张登记同义组。是否登记、怎么加约束，由人决定。
 *   · 不消费 held-out。held-out 是验收集，用它驱动发现会导致过拟合。
 *
 * 用法
 * ----
 *   node scripts/suggest-synonyms.mjs                      # 默认：cases.json + redteam.json + 本地未命中日志
 *   node scripts/suggest-synonyms.mjs --cases a.json,b.json
 *   node scripts/suggest-synonyms.mjs --min-count 2        # 只看出现≥2次的候选
 *   node scripts/suggest-synonyms.mjs --json out.json      # 额外输出机器可读报告
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { triage } from '../lib/triage.js';
import { departments, pathways } from '../data/hospital.js';
import { REFERENCE_SYNONYMS } from '../packages/anchored-evidence-gate/src/synonyms.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 参数解析 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { cases: [], minCount: 1, json: null, includeLog: true, topN: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cases') opts.cases = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--min-count') opts.minCount = Number(argv[++i]) || 1;
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--no-log') opts.includeLog = false;
    else if (a === '--top') opts.topN = Number(argv[++i]) || 40;
  }
  if (!opts.cases.length) {
    opts.cases = ['data/evaluation/cases.json', 'data/evaluation/redteam.json'];
  }
  return opts;
}

// ── 语料装载 ────────────────────────────────────────────────────────────────
async function loadCorpus(files, includeLog) {
  const items = [];
  for (const rel of files) {
    try {
      const data = JSON.parse(await readFile(path.join(root, rel), 'utf8'));
      const list = Array.isArray(data) ? data : data.cases || [];
      for (const c of list) {
        // 兼容两种用例结构：
        //   cases.json      → { input: { chief, answers } }
        //   redteam.json    → { chief, answers }
        const chief = c?.input?.chief ?? c?.chief;
        const answers = c?.input?.answers ?? c?.answers ?? {};
        if (typeof chief === 'string' && chief.trim()) {
          items.push({ chief: chief.trim(), source: rel, id: c.id || null, answers });
        }
      }
    } catch (e) {
      console.error(`  ! 跳过 ${rel}: ${e.code === 'ENOENT' ? '文件不存在' : e.message}`);
    }
  }
  if (includeLog) {
    try {
      const raw = await readFile(path.join(root, '.runtime', 'unmatched.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (typeof e.chief === 'string' && e.chief.trim()) {
            items.push({ chief: e.chief.trim(), source: 'unmatched.jsonl', id: null, answers: { age: e.age } });
          }
        } catch { /* 忽略坏行 */ }
      }
    } catch { /* 无日志文件，正常 */ }
  }
  return items;
}

// ── 词表与同义表的"已覆盖"集合 ──────────────────────────────────────────────
function coveredFragments() {
  const covered = new Set();
  for (const d of departments) for (const k of d.keywords || []) covered.add(k);
  for (const [canonical, entries] of Object.entries(REFERENCE_SYNONYMS)) {
    covered.add(canonical);
    for (const entry of entries) {
      const core = Array.isArray(entry) ? entry[0] : entry;
      if (typeof core === 'string' && core) covered.add(core);
    }
  }
  return covered;
}

// 安全路径锚点：这些词让规则层**故意**不直接推荐（spanAllowed 第④条），
// 它们出现在 unmatched 里是**正确行为**，不是词表缺口。必须单独识别、不要建议登记。
function pathwayAnchors() {
  const anchors = new Set();
  for (const p of pathways) for (const a of p.anchors || []) anchors.add(a);
  return anchors;
}

// ── 泛化表达判定：这些本就该转人工，不该被登记 ───────────────────────────
// 判定依据不是"出现即拒绝"，而是"整体语义就是不确定"。
const VAGUE_PATTERNS = [
  /说不上来|说不清|说不清楚|说不出/,
  /不太对劲|不对劲|怪怪|别扭/,
  /哪儿都|哪里都|浑身都|全身都|到处都/,
  /整个人|整个人都/,
  /具体.*不(清楚|知道|明白)/,
  /反正就是|总之就是/,
];

function isVague(text) {
  return VAGUE_PATTERNS.some(re => re.test(text));
}

// ── 候选核心词提取 ─────────────────────────────────────────────────────────
// 关键设计（决定了报告有没有用）：**不做无差别 n-gram**。
// 无差别 n-gram 会产出大量垃圾片段（"肚子疼了"、"岁孩子咳"、"有咳嗽没"），
// 因为中文里任意相邻两字都可能是 n-gram，但绝大多数没有语义。
//
// 改用「症状锚点 + 部位前缀」的两段式提取：
//   ① 在句子里找**症状性状字**（疼/痛/痒/晕/吐/咳/烧/肿/血/泻/堵/酸/闷/胀/麻/抖…）
//   ② 从锚点向前取 0-3 个汉字作为部位前缀，向后取 0-1 个汉字作为性状后缀
//   ③ 组装成候选核心词，如「心口疼」「腹部疼」「腰酸痛」
//
// 这样产出的候选天然是"患者会说的症状词形"，可直接拿去登记。
//
// 以下是各个"症状性状字"，涵盖疼痛、消化、呼吸、泌尿、皮肤、神经等常见主诉。
const SYMPTOM_CHARS = '疼痛痒晕吐咳烧肿胀血泻堵酸闷胀麻抖晕虚乏昏抽绞灼痰鸣哽硬疼';
const SYMPTOM_RE = new RegExp(`[${SYMPTOM_CHARS}]`);
// 部位前缀允许的字符：身体部位字 + 方位/尺寸限定词。
const BODY_PREFIX_RE = /^[\u4e00-\u9fa5]{1,3}$/;
// 绝不可以作为部位前缀开头/结尾的连接、功能、时间、程度字。
// 目的：滤掉 "且脑袋疼""有咳嗽没""点闷闷""过肺炎咳""岁孩子咳" 这类噪声。
//   开头禁用：连词/副词/助词/时间/程度/动词
const BAD_PREFIX_START = /^[且而但也还就又都和与及或对从把被让使很太更最不没别应估将快要该可能否并则因故若如虽即使唯仅只了的吗呢吧啊呀哦嗯在是想感觉觉得自己我你他她它们这那哪些么什怎]/;
//   结尾禁用：体貌助词、时间后缀（"疼了两天"的"了"、"腰酸痛两"的"两"）
const BAD_PREFIX_END = /[了着过的吗呢吧啊呀哦嗯是在有和与及或就都也还两三四五六七八九十上下昨今明白天了]$/;
// 前缀必须至少含 1 个"身体部位字"或"方位/尺寸字"，否则不是部位（挡掉"过肺炎咳"）
const BODY_HINT = /[头脸眼目耳鼻口舌喉咽牙齿脖颈肩背胸腹肚肠胃肝脾肾肺心脑腰腿膝踝脚足趾指手胳膊臀髋骨节皮肌血神]|[上下中左右前后内里]|[大小]?[腹腰胸背肩膝]|[肚子脑袋嗓子鼻子脖子脖子耳朵眼珠子]/;

// 否定/未然/病史语境：这类上下文里的症状**恰恰说明"没有该症状"**，
// 绝不能作为"未命中缺口"提出来登记——否则会把"我没有胸痛"登记成胸痛。
// 例：「没有咳嗽没有胃痛」「腰没疼，就是弯腰有点费劲」「去年得过肺炎咳嗽好久，现在全好了」
const NEGATION_CONTEXT = /(?:没有|没|并无|否认|不伴|无|不是|未|别|不|快|就快|即将|马上|应该|估计|可能|以前|之前|曾经|去年|既往|过去|上次|小时候|好了|不喘|不闷|发展成|变成|会不会|要是|如果|万一)/;

// 中文数字/量词/年龄残留：前缀里含这些说明是从"8岁孩子咳嗽""疼了两天"这类
// 句子里错切出来的（"岁孩子"不是部位），必须拒绝。
const NON_BODY_CHARS = /[0-9０-９岁个位只条天年月周分次遍趟两三四五六七八九十]/;

function isPlausibleBodyPrefix(prefix) {
  if (!BODY_PREFIX_RE.test(prefix)) return false;
  if (BAD_PREFIX_START.test(prefix)) return false;
  if (BAD_PREFIX_END.test(prefix)) return false;
  if (NON_BODY_CHARS.test(prefix)) return false;
  if (!BODY_HINT.test(prefix)) return false;
  return true;
}

// 从锚点句里提取「部位 + 性状」候选
function extractCandidates(seg) {
  const out = [];
  const chars = [...seg];
  for (let i = 0; i < chars.length; i++) {
    if (!SYMPTOM_RE.test(chars[i])) continue;
    // 向后：允许 0-1 个补充性状字（如 酸痛、绞痛、闷痛）
    let end = i + 1;
    if (end < chars.length && SYMPTOM_RE.test(chars[end]) && chars[end] !== chars[i]) end++;
    // 否定/病史守卫：锚点**前 6 字**出现否定词 → 整条不收录。
    // 这挡掉"有胃痛"（来自"没有胃痛"）、"有胸痛"（来自"我没有胸痛"）。
    const guardStart = Math.max(0, i - 6);
    const beforeAny = chars.slice(guardStart, i).join('');
    if (NEGATION_CONTEXT.test(beforeAny)) continue;
    // 向前：1-3 个部位字
    for (let k = 1; k <= 3; k++) {
      const start = i - k;
      if (start < 0) break;
      const prefix = chars.slice(start, i).join('');
      if (!isPlausibleBodyPrefix(prefix)) break;
      out.push({ frag: chars.slice(start, end).join(''), hasBody: true });
    }
    // 无部位的纯症状词（如 出血、酸痛）——已过否定守卫，归入存疑
    out.push({ frag: chars.slice(i, end).join(''), hasBody: false });
  }
  return out;
}

function ngrams(text) {
  // 先按标点/空白切段，避免跨句拼出假词。保留标点作为边界。
  return text
    .split(/[，。！？、；：,.!?;:\s（）()【】\[\]"'“”‘’]+/)
    .filter(s => s.length >= 2);
}

// ── 已知的"导致 unmatched 是正确行为"的输入（安全行为，不是缺口）─────────
// 例如 6个月/0岁宝宝、怀孕、极端年龄——这些转人工是对的。
function isCorrectlyUnmatched(chief, answers) {
  if (['infant', 'neonate'].includes(answers?.age)) return true;
  if (/怀孕|孕妇|哺乳|产后|喂奶/.test(chief)) return true;
  return false;
}

// ── 误配预演：这个候选登记后会不会误伤现有用例？─────────────────────────
// 对候选核心词，检查它是否为**任何现有词表词/同义核心词的子串或超串**。
// 若是子串（如候选"肚子疼" ⊃ 已登记"肚子"），说明该片段其实是"已覆盖词 + 性状词"，
// 登记它多半是冗余的；若是超串则需人工判断是否更具体。
function overlapReport(frag, covered) {
  const related = [];
  for (const c of covered) {
    if (c === frag) continue;
    if (frag.includes(c)) related.push({ type: 'superstring', other: c });   // 候选包含已登记词
    else if (c.includes(frag)) related.push({ type: 'substring', other: c }); // 候选被已登记词包含
  }
  return related;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
const corpus = await loadCorpus(opts.cases, opts.includeLog);
if (!corpus.length) {
  console.error('没有可分析的语料。请检查 --cases 路径，或先开启未命中采集。');
  process.exit(1);
}

const covered = coveredFragments();
const anchors = pathwayAnchors();

// 1) 纯规则口径跑一遍，收集 unmatched
const unmatched = [];
const skipped = { vague: 0, correctly: 0 };
for (const item of corpus) {
  const input = { chief: item.chief, answers: item.answers || {} };
  let r;
  try {
    // 关键：synonyms=false + morphology=false = 纯字面口径，暴露"词表没登记什么"
    r = triage(input, [], { interactive: false, policy: 'dynamic', synonyms: false, morphology: false });
  } catch { continue; }
  if (r.status !== 'human' || r.reasonCode !== 'unmatched') continue;
  if (isCorrectlyUnmatched(item.chief, item.answers)) { skipped.correctly++; continue; }
  if (isVague(item.chief)) { skipped.vague++; continue; }
  // 命中安全路径锚点的输入：unmatched 是 spanAllowed 第④条**刻意**造成的，属正确行为。
  if ([...anchors].some(a => item.chief.includes(a))) { skipped.correctly++; continue; }
  unmatched.push(item);
}

// 2) 提取候选片段并计数
const counts = new Map();     // frag -> { count, examples: Set, sources: Set, hasBody }
for (const item of unmatched) {
  const seen = new Set();
  for (const seg of ngrams(item.chief)) {
    for (const { frag, hasBody } of extractCandidates(seg)) {
      if (frag.length < 2 || frag.length > 5) continue;
      if (covered.has(frag)) continue;          // 已登记，不算缺口
      if (seen.has(frag)) continue;             // 同一句内去重
      seen.add(frag);
      const rec = counts.get(frag) || { count: 0, examples: new Set(), sources: new Set(), hasBody };
      rec.count++;
      if (hasBody) rec.hasBody = true;
      if (rec.examples.size < 3) rec.examples.add(item.chief);
      rec.sources.add(item.source);
      counts.set(frag, rec);
    }
  }
}

// 3) 子串合并：若 A 是 B 的子串且 A、B 计数相同，只保留更长的 B（信息量更大）
//    例：「腹部疼」与「部疼」计数相同 → 丢弃「部疼」（前缀不完整，无意义）
const frags = [...counts.keys()].sort((a, b) => b.length - a.length || counts.get(b).count - counts.get(a).count);
const dropped = new Set();
for (const long of frags) {
  for (const short of frags) {
    if (long === short || dropped.has(short)) continue;
    if (long.includes(short) && counts.get(long).count === counts.get(short).count) dropped.add(short);
  }
}

// 4) 分类：「建议登记」= 有部位前缀 + 有症状性状字（语义完整，可登记）
//              「存疑」= 只有症状字无部位（如"酸痛"），需人工判断归属
//              「冗余」= 候选 = 已登记词 + 症状字（如"肚子疼"包含已登记"肚子"），
//                        说明症状锚点已被覆盖，登记它基本无用 —— 单独列出，避免刷屏。
const suggested = [];
const ambiguous = [];
const redundant = [];
for (const [frag, rec] of counts) {
  if (dropped.has(frag)) continue;
  if (rec.count < opts.minCount) continue;
  const item = { frag, count: rec.count, examples: [...rec.examples], sources: [...rec.sources] };
  const overlap = overlapReport(frag, covered);
  // 「这条未命中是不是真缺口」——关键判据：
  // 看**候选出现的那些原句**里，是否已经有别的**已登记词**被包含。
  //   例："8岁孩子咳嗽" → 句子含已登记的"咳嗽" → 词表认得这句话里的词，
  //        未命中来自年龄闸门，不是词表缺口（候选"孩子咳"不该登记）。
  //   反例："腰疼" → 句子只有"腰疼"，"腰"是单字不作数、"腰疼"未登记 → 真缺口。
  const sentenceCovered = item.examples.some(ex =>
    [...covered].some(c => c.length >= 2 && c !== frag && ex.includes(c))
  );
  if (rec.hasBody && overlap.length === 0 && !sentenceCovered) suggested.push({ ...item, symptomCovered: false });
  else if (rec.hasBody) redundant.push({ ...item, overlap, sentenceCovered });
  else ambiguous.push(item);
}
suggested.sort((a, b) => b.count - a.count || a.frag.localeCompare(b.frag));
ambiguous.sort((a, b) => b.count - a.count || a.frag.localeCompare(b.frag));

// ── 报告 ───────────────────────────────────────────────────────────────────
const line = '─'.repeat(72);
console.log(line);
console.log('同义表盲区发现报告');
console.log(line);
console.log(`语料来源     : ${opts.cases.join(', ')}${opts.includeLog ? ' + .runtime/unmatched.jsonl' : ''}`);
console.log(`语料条数     : ${corpus.length}`);
console.log(`未命中条数   : ${unmatched.length}  （已排除泛化表达 ${skipped.vague} 条、正确转人工 ${skipped.correctly} 条）`);
console.log(`现有覆盖     : ${departments.length} 科室关键词 + ${Object.keys(REFERENCE_SYNONYMS).length} 组同义表`);
console.log(`纯字面口径   : synonyms=false, morphology=false（暴露词表缺口）`);
console.log('');

console.log(`【一】建议登记（${suggested.length} 个，按出现次数排序）`);
console.log(line);
if (!suggested.length) console.log('  （无。说明当前语料下词表覆盖良好。）');
for (const s of suggested.slice(0, opts.topN)) {
  console.log(`  ${s.frag}  ×${s.count}`);
  console.log(`    来源: ${s.sources.join(', ')}`);
  if (s.symptomCovered) {
    console.log(`    ⚠ 注意: 症状字"${s.frag.slice(-2)}"疑似已登记，本条未命中可能来自`);
    console.log(`      年龄/风险闸门而非词表缺口 —— 登记前请先确认。`);
  }
  for (const ex of s.examples) console.log(`    例: ${ex}`);
}
console.log('');

console.log(`【二】存疑待议（${ambiguous.length} 个，指向不明确，需人工判断）`);
console.log(line);
if (!ambiguous.length) console.log('  （无）');
for (const s of ambiguous.slice(0, opts.topN)) {
  console.log(`  ${s.frag}  ×${s.count}   例: ${s.examples[0]}`);
}
console.log('');

console.log(`【三】判定为冗余 / 非缺口（${redundant.length} 个，不建议登记）`);
console.log(line);
console.log('  这些候选落在"词表已经认得该症状"的句子里，登记它们不会带来新的匹配能力。');
console.log('  两种情形：');
console.log('    · 候选 = 已登记词 + 症状字（如「肚子疼」含已登记「肚子」）→ 冗余');
console.log('    · 句子里已有别的已登记词（如「8岁孩子咳嗽」含已登记「咳嗽」）');
console.log('      → 未命中其实来自年龄/风险闸门，不是词表缺口');
for (const s of redundant.slice(0, 12)) {
  const why = s.overlap.length
    ? `含已登记词: ${s.overlap.map(o => o.other).join('、')}`
    : '句中已有已登记词（未命中来自其他闸门）';
  console.log(`  ${s.frag}  ×${s.count}  → ${why}`);
  if (s.examples[0]) console.log(`     例: ${s.examples[0]}`);
}
console.log('');

console.log(`【四】反建议：不要登记（${skipped.vague} 条泛化表达）`);
console.log(line);
console.log('  这些输入的"未命中"是**正确的安全行为**——它们本就没有明确症状指向，');
console.log('  登记反而会把"说不清"硬推到一个科室，属于误导。示例：');
console.log('    · 整个人都不太对劲，说不上来哪里的问题');
console.log('    · 感觉怪怪的，具体说不清');
console.log('');

console.log(line);
console.log('提醒');
console.log(line);
console.log('  1. 本脚本**只提出候选**，不修改任何文件。是否登记、怎么加约束由人决定。');
console.log('  2. 登记前务必给核心词加**同现约束**（如 脚气 → [脚, /痒|泡|脱皮/]），');
console.log('     否则会把"脚疼"误判为脚气。参考 packages/anchored-evidence-gate/src/synonyms.js 的登记原则。');
console.log('  3. 任何登记都属于**行为改动**（minor），必须重跑全链并同步指纹。');
console.log('  4. 复现链不用本脚本 —— 它不进 verify-chain，避免把"发现"混进"验证"。');
console.log(line);

// 可选：机器可读输出
if (opts.json) {
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'literal-only',
    corpus: { files: opts.cases, total: corpus.length, unmatched: unmatched.length },
    excluded: skipped,
    suggested: suggested.slice(0, opts.topN),
    ambiguous: ambiguous.slice(0, opts.topN),
  };
  await writeFile(path.join(root, opts.json), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n机器可读报告已写入: ${opts.json}`);
}
