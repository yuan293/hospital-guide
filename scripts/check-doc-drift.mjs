#!/usr/bin/env node
// 诊途 · README 基线数字一致性门禁（fail-closed）
//
// 背景：本项目「可复现、可核对」的承诺靠的是门禁链，而不是文档自觉。
// 但历史上多次出现「代码先跑、README 数字掉队」：扩语料后 rules/dynamic 分母
// 已变，正文却仍写旧值（如 112/112、117/117、137 条）。文档说 X、实测是 Y，
// 恰好会伤到本项目最值钱的那部分可信度，因此这里把它做成机器拦得住的项。
//
// 做法：从 data/evaluation/latest.json（上一次 verify 的实测快照）读出权威数字，
// 断言 README 的「当前仓库基线」表格里三个关键口径与之逐字一致：
//   1) rules 组通过数（如 125/125）
//   2) dynamic 组通过数（如 129/129）
//   3) 主集条数（如 150 条）
// 若 README 与实测不符，退出码 1。
//
// 只为「当前基线」区域校验；README 中明确标注为「历史快照 / 137 条时代」的
// 段落不参与断言（那些是有意保留的沿革记录，改动它们反而会丢失版本证据）。
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[doc-drift] 失败：${msg}`);
  process.exit(1);
}

const latestPath = join(root, 'data', 'evaluation', 'latest.json');
const readmePath = join(root, 'README.md');
for (const p of [latestPath, readmePath]) {
  if (!existsSync(p)) fail(`缺少文件：${p}`);
}

let latest;
try {
  latest = JSON.parse(readFileSync(latestPath, 'utf8'));
} catch (e) {
  fail(`无法解析 ${latestPath}：${e.message}`);
}
const readme = readFileSync(readmePath, 'utf8');

// --- 权威值：来自 latest.json ---
const caseCount = latest?.dataset?.cases;

function metric(mode) {
  const m = (latest?.modes ?? []).find(x => x.mode === mode);
  if (!m?.metrics) return null;
  return { passed: m.metrics.passed, total: m.metrics.total };
}

const rules = metric('rules');
const dynamic = metric('dynamic');
if (!rules || !dynamic || caseCount == null) {
  fail('latest.json 缺少 rules/dynamic 指标或 dataset.cases（请先跑 npm run verify 生成快照）');
}

const expectations = [
  { label: `rules 通过数（${rules.passed}/${rules.total}）`, needle: `${rules.passed}/${rules.total}` },
  { label: `dynamic 通过数（${dynamic.passed}/${dynamic.total}）`, needle: `${dynamic.passed}/${dynamic.total}` },
  { label: `主集条数（${caseCount} 条）`, needle: `${caseCount} 条` },
];

// --- 只在「当前仓库基线」之后的表格区间内做断言 ---
// 该标题是 README 中约定俗成的锚点；找不到说明结构被改动，需人工确认。
const anchor = '当前仓库基线';
const start = readme.indexOf(anchor);
if (start < 0) fail(`README 中找不到锚点「${anchor}」，无法定位基线区（请检查文档结构）`);
// 取基线区到「路径 B」之前的片段，避免误伤历史沿革段。
const end = readme.indexOf('### 路径 B', start);
const scope = readme.slice(start, end < 0 ? start + 4000 : end);

const problems = [];
for (const { label, needle } of expectations) {
  if (!scope.includes(needle)) problems.push(`README「${anchor}」区缺少实测值 ${needle}（${label}）`);
}

if (problems.length) {
  console.error('\n[doc-drift] README 基线数字与 data/evaluation/latest.json 不一致：');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n请把 README 的「当前仓库基线」表格更新为上面的实测值后重跑。');
  process.exit(1);
}

console.log('[doc-drift] README 基线数字与 latest.json 一致：');
for (const { label } of expectations) console.log('  - ' + label);
console.log('[doc-drift] 通过。');
