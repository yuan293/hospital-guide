#!/usr/bin/env node
// 诊途 · 科室评估覆盖率门禁（fail-closed）
//
// 用法：
//   node scripts/check-coverage.mjs               快速检查（仅规则层覆盖）
//   node scripts/check-coverage.mjs --json        机器可读输出（供 CI / 上游脚本消费）
//
// 背景：项目对外宣称「45 个科室」，但评估用例只覆盖其中一部分。这个缺口如果
// 不主动量化并声明边界，会从「合成数据的坦诚」变成「覆盖不全的软肋」。
// 本脚本把覆盖情况变成可计算的证据：
//   ① 统计每一个科室被多少条评估用例覆盖；
//   ② 未覆盖的科室必须出现在 coverage-baseline.json 的显式声明里
//      （要么登记为「非导诊目标，本就不该被推荐」→ 声明式豁免，
//       要么登记为「待补用例」→ 会被计入 failures 并让门禁失败）；
//   ③ 任何在声明表之外的新增科室、或声明表里已不存在的陈旧条目，都直接失败。
//
// 门禁阈值（可通过 baseline 覆盖）：
//   minCasesPerGuidanceDepartment —— 参与导诊的科室，每个至少要有的用例数。
//     默认 1：只要求「至少被验证过一次」。设为 0 可只做覆盖率报告。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const asJson = process.argv.includes('--json');

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

const hospital = readJson(join(ROOT, 'data/hospital.json'));
const casesDoc = readJson(join(ROOT, 'data/evaluation/cases.json'));
const baseline = readJson(join(ROOT, 'data/evaluation/coverage-baseline.json'));

const departments = hospital.departments ?? [];
const cases = casesDoc.cases ?? [];

// --- 统计每个科室期望被覆盖的用例数 -------------------------------------------
// 计数口径：用例的 expected.department 命中该科室即计 1 条。
// emergency（急症）与 human/uncertain/question 等非科室结局不计入任何科室。
const counts = new Map(departments.map(d => [d.id, 0]));
const unknownDepartments = new Set();
for (const c of cases) {
  const id = c.expected?.department;
  if (!id) continue;
  if (!counts.has(id)) unknownDepartments.add(id);
  else counts.set(id, counts.get(id) + 1);
}

// --- 声明表：未覆盖科室的处置必须显式登记 -------------------------------------
// 三类未覆盖科室，全部要求显式声明，且声明必须与项目机制一致：
//   nonGuidanceTargets —— 非导诊流程节点（hospital.json 中 bookable:false）。
//   systemDepartments  —— 数据规范保留的系统兜底科室（emergency/pediatrics/general，
//                         见 data/README「保留 emergency、pediatrics、general 系统科室 ID」）。
//                         这类科室不参与自动推荐，但通常有"锁定其不推荐行为"的用例
//                         （如 HG-151 期望 general 不被推荐），因此不计入"被推荐覆盖"。
//   pendingCases       —— 可自助挂号但暂无用例的真实科室：计入 failures，形成待办。
const isNonGuidance = d => d.bookable === false;
const declaredNonGuidance = new Set(baseline.nonGuidanceTargets ?? []);
const declaredSystemDepts = new Set(baseline.systemDepartments ?? []);
const declaredPending = new Set(baseline.pendingCases ?? []);
const minPerDept = baseline.minCasesPerGuidanceDepartment ?? 1;

const covered = [];
const uncovered = [];
for (const d of departments) {
  const n = counts.get(d.id) ?? 0;
  if (n >= minPerDept) covered.push({ id: d.id, name: d.name, cases: n });
  else uncovered.push({ id: d.id, name: d.name, cases: n });
}

// --- 门禁判定 -----------------------------------------------------------------
const failures = [];
const notes = [];

// ① 未覆盖且未声明 → 失败（新科室必须显式处置）
for (const d of uncovered) {
  if (declaredNonGuidance.has(d.id) || declaredSystemDepts.has(d.id) || declaredPending.has(d.id)) continue;
  failures.push(`科室「${d.id}」(${d.name}) 无评估用例，且未在 coverage-baseline.json 中声明（非 nonGuidanceTargets / systemDepartments / pendingCases）`);
}

// ② 声明为 pendingCases 的仍是无覆盖状态 → 失败（这是「待办」，门禁应持续提醒）
for (const d of uncovered) {
  if (declaredPending.has(d.id)) failures.push(`待补用例：科室「${d.id}」(${d.name}) 已在 pendingCases 登记，仍需补评估用例`);
}

// ③ 声明表里已不存在 / 已不再适用 → 失败（防止陈旧声明漂移）
const byId = new Map(departments.map(d => [d.id, d]));
for (const id of declaredNonGuidance) {
  if (!byId.has(id)) { failures.push(`coverage-baseline.json 的 nonGuidanceTargets 含不存在的科室「${id}」`); continue; }
  if ((counts.get(id) ?? 0) >= minPerDept) failures.push(`科室「${id}」已在 nonGuidanceTargets 声明豁免，却已存在评估用例——请从豁免表中移除`);
  // 豁免必须与数据机制一致：声明为非导诊目标，就必须真的是 bookable:false。
  if (!isNonGuidance(byId.get(id))) {
    failures.push(`科室「${id}」被声明为非导诊目标，但 hospital.json 中其 bookable 不是 false——豁免与数据机制不符`);
  }
}
for (const id of declaredPending) {
  if (!byId.has(id)) failures.push(`coverage-baseline.json 的 pendingCases 含不存在的科室「${id}」`);
}

// ③b 系统兜底科室：目前仅数据规范保留的 emergency / pediatrics / general。
//     声明为系统科室但不在该集合内的，不允许——防止用它掩盖真实缺口。
const SYSTEM_DEPT_IDS = new Set(['emergency', 'pediatrics', 'general']);
for (const id of declaredSystemDepts) {
  if (!byId.has(id)) { failures.push(`coverage-baseline.json 的 systemDepartments 含不存在的科室「${id}」`); continue; }
  if (!SYSTEM_DEPT_IDS.has(id)) {
    failures.push(`科室「${id}」被声明为系统兜底科室，但不在数据规范保留的 emergency/pediatrics/general 之内——不允许借此豁免真实缺口`);
  }
}

// ④ 用例里出现 hospital.json 不认识的科室 → 失败
for (const id of unknownDepartments) failures.push(`评估用例的 expected.department「${id}」在 hospital.json 中不存在`);

// ⑤ 覆盖率信息（不阻断，仅提示）
const guidance = departments.filter(d => !declaredNonGuidance.has(d.id) && !declaredSystemDepts.has(d.id));
const guidanceCovered = guidance.filter(d => (counts.get(d.id) ?? 0) >= minPerDept).length;
notes.push(`导诊科室覆盖率（已排除流程节点与系统兜底科室）${guidanceCovered}/${guidance.length}`);
notes.push(`系统兜底科室（不参与自动推荐）${[...declaredSystemDepts].join('、') || '无'}`);

// --- 输出 ---------------------------------------------------------------------
const report = {
  schemaVersion: 1,
  datasetVersion: casesDoc.version ?? null,
  totals: {
    departments: departments.length,
    nonGuidanceTargets: declaredNonGuidance.size,
    systemDepartments: declaredSystemDepts.size,
    guidanceDepartments: departments.length - declaredNonGuidance.size - declaredSystemDepts.size,
    evaluatedCases: cases.length,
    coveredDepartments: covered.length,
    uncoveredDepartments: uncovered.length,
  },
  minCasesPerGuidanceDepartment: minPerDept,
  covered: covered.sort((a, b) => b.cases - a.cases || a.id.localeCompare(b.id)),
  uncovered,
  nonGuidanceTargets: [...declaredNonGuidance],
  systemDepartments: [...declaredSystemDepts],
  pendingCases: [...declaredPending],
  failures,
  notes,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const t = report.totals;
  console.log('\n--- 科室评估覆盖率 ---');
  console.log(`科室总数            ${t.departments}`);
  console.log(`  流程节点(bookable:false) ${t.nonGuidanceTargets}`);
  console.log(`  系统兜底(不自动推荐)      ${t.systemDepartments}`);
  console.log(`  参与导诊            ${t.guidanceDepartments}`);
  console.log(`评估用例总数         ${t.evaluatedCases}`);
  console.log(`被推荐覆盖的科室      ${t.coveredDepartments} / ${t.departments}`);
  console.log('');
  if (uncovered.length) {
    console.log('未达用例下限的科室：');
    for (const d of uncovered) {
      const tag = declaredNonGuidance.has(d.id) ? '豁免·流程节点'
        : declaredSystemDepts.has(d.id) ? '豁免·系统兜底'
        : declaredPending.has(d.id) ? '待补用例' : '!! 未声明';
      console.log(`  ${d.id.padEnd(18)} ${d.name.padEnd(12)} ${tag}`);
    }
  } else {
    console.log('所有科室均已达到用例下限。');
  }
  for (const n of notes) console.log(`注：${n}`);
}

if (failures.length > 0) {
  console.error('\n覆盖率门禁失败：');
  for (const f of failures) console.error(`  ! ${f}`);
  console.error('\n处置方式：在 data/evaluation/coverage-baseline.json 中显式声明（非导诊目标 / 待补用例），或补齐评估用例。');
  process.exit(1);
}
console.log('\n覆盖率门禁通过。');
