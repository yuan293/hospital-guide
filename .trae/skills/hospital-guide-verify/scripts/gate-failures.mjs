#!/usr/bin/env node
// 院内智导 · failedIds 白名单门禁
// 用法：node gate-failures.mjs [data/evaluation/latest.json]
// 评测命令本身不因 challenge 失败返回非零，本脚本把"只允许刻意保留的可见挑战失败"
// 变成退出码门禁：出现白名单外失败或未知评测组即退出码 1。
import { readFileSync } from 'node:fs';

const reportPath = process.argv[2] || 'data/evaluation/latest.json';
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

// 白名单基线：2026-09-24，v0.3.2 真机实测。
// 数据集或机制变化后，必须先核实差异案例的真机轨迹确属"刻意保留的可见挑战"，
// 再显式更新此表；不允许静默放行任何新失败。
const allowlist = {
  rules: ['HG-039', 'HG-040', 'HG-041', 'HG-042', 'HG-043', 'HG-044', 'HG-045', 'HG-046'], // 纯规则对口语表达的基线局限
  dynamic: [],
  'model:qwen2.5:7b': [],
  'workflow:qwen2.5:7b': [],
  'model:qwen2.5:1.5b': ['HG-018', 'HG-020', 'HG-041', 'HG-051'], // 1.5B 一次性组刻意保留的对照挑战
  'workflow:qwen2.5:1.5b': [],
};

let bad = 0;
console.log('\n--- failedIds 门禁（白名单外即失败）---');
for (const m of report.modes ?? []) {
  // latest.json 不落盘 failedIds，从逐行结果推导：未跳过且未通过的案例。
  const ids = (m.rows ?? []).filter(r => !r.skipped && r.pass === false).map(r => r.id);
  // 组名以 id 字段为准（含模型后缀，如 model:qwen2.5:7b）；mode 只是执行模式（model/workflow），同名字段会撞组。
  const group = m.id ?? m.mode;
  const tag = ids.length === 0 ? 'OK 全绿' : `失败 ${ids.length} 条`;
  console.log(`  ${group.padEnd(24)} ${tag}  [${ids.join(', ')}]`);
  if (!Object.hasOwn(allowlist, group)) {
    console.error(`  ! 未知评测组「${group}」：需在 gate-failures.mjs 白名单中显式登记`);
    bad++;
    continue;
  }
  for (const id of ids) {
    if (!allowlist[group].includes(id)) {
      console.error(`  ! 白名单外失败：${group}: ${id}`);
      bad++;
    }
  }
}

if (bad > 0) {
  console.error('\n门禁失败：存在白名单外失败或未知评测组。若是刻意保留的新挑战，先核实真机轨迹再更新白名单；否则必须修复。');
  process.exit(1);
}
console.log('门禁通过：所有失败均在已知白名单内。');
