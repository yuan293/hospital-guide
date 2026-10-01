#!/usr/bin/env node
// 诊途 · failedIds 白名单门禁
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
  rules: ['HG-039', 'HG-040', 'HG-041', 'HG-042', 'HG-043', 'HG-044', 'HG-045', 'HG-046', 'HG-122'], // 纯规则对口语表达的基线局限
  // HG-122（鼻子老是出血）：出血类口语与词表新增的鼻出血类词无逐字连续命中，
  // 部位选项亦无鼻部；无模型按设计弃权转人工，有模型组由出血守卫+词表补全正确推荐耳鼻喉科。
  // 无模型时这 3 条口语主诉无法从“不适部位”选项里恢复语义（head_neck 同时指向神经/耳鼻喉；
  // 部位选项没有眼部），按设计弃权转人工；同一案例在 workflow 组由模型入口介入全部通过，
  // 这组差值是“AI 必要”的同案例集对照证据，不是待修 bug。
  dynamic: ['HG-040', 'HG-041', 'HG-043', 'HG-122'],
  'model:qwen2.5:7b': [], // 2026-10-01 晚些：HG-068 的“身上哪儿都别扭→腹痛”语义错配已被
  // model.js 的“笼统感受片段”纯规则守卫拦截（不含具体部位的不得劲/难受/别扭等证据不允许映射），
  // 7B 改走 evidence_invalid 弃权（anyOf 安全结局），该可见挑战在规则层关闭，白名单收紧。
  'workflow:qwen2.5:7b': [],
  'model:qwen2.5:1.5b': ['HG-018', 'HG-020', 'HG-041', 'HG-051'], // 1.5B 一次性组刻意保留的对照挑战
  // HG-041（嗓子疼）在 0.5.1/0.6.0 曾稳定通过；0.6.0 提示词加入部位一致性与笼统感受条款后
  // 1.5B 对该口语返回空证据、走弃权（安全非推荐结局），7B 同案例仍正确推荐耳鼻喉科，故保留为
  // 弱模型保守化的可见差异而非回退提示词（放松会重新诱发跨部位错配）。
  // HG-067 曾在此白名单（部位一致性条款后 1.5B 不再把“肚子疼”映射为腹痛）；2026-10-01.3
  // 提示词改为“严禁跨症状就近挑选”并明示“同一症状口语映射照常”后，1.5B 恢复正确映射，移出白名单。
  'workflow:qwen2.5:1.5b': ['HG-041'],
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
