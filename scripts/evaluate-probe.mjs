#!/usr/bin/env node
// 诊途 · AI 必要性对照探针（非门禁诊断集）
//
// 用法：
//   node scripts/evaluate-probe.mjs                        仅规则层基线（无模型）
//   node scripts/evaluate-probe.mjs --models=qwen2.5:7b    额外跑「规则+模型」完整流程
//
// 目的：在同一批「词表与同义表未登记」的口语主诉上，量化「规则层 vs 规则+模型层」的
// 表达泛化差距，为「AI 到底还需不需要」提供可复算证据（报告第三节引用的 5/16 → 7/16）。
//
// 定位：非门禁诊断集——不进主集 latest.json、不进 failedIds 白名单、不进 verify 链、
// 不进 12 文件指纹；报告写入 data/evaluation/probe-latest.json（含逐条实际结局与
// dataset.sha256，可核验案例文件未被事后修改）。
//
// 退出码：任一组的「错误科室推荐」> 0 时返回 1（安全不变量）；未收敛（安全弃权/追问）
// 不置退出码——探针的意义正是「接不住时只会变保守，不会变成错误推荐」。
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { departments } from '../data/hospital.js';
import { modelStatus } from '../lib/model.js';
import { evaluateCase, summarize, validateDataset } from '../lib/evaluation.js';

const args = process.argv.slice(2);
if (args.some(a => a.split('=')[0] !== '--models' || (a.startsWith('--models') && !a.startsWith('--models=')))) {
  throw new Error('用法: node scripts/evaluate-probe.mjs [--models=qwen2.5:7b,qwen2.5:1.5b]');
}
const requestedModels = [...new Set((args.find(a => a.startsWith('--models='))?.slice(9) || '').split(',').filter(Boolean))];

const raw = await readFile(new URL('../data/evaluation/cases-probe.json', import.meta.url), 'utf8');
const dataset = validateDataset(JSON.parse(raw), departments);
const status = requestedModels.length ? await modelStatus() : { available: false, models: [] };

// 规则层用 dynamic（无模型动态追问）；接入模型用 workflow（完整多轮），两组共用同一批
// 主诉、同一套评分与安全规则，唯一区别是流程里有没有本地模型。
const plans = [{ id: 'rules-only', label: '规则层（无模型 · 动态追问）', mode: 'dynamic', model: '' }];
for (const model of requestedModels) {
  if (!status.available || !status.models.includes(model)) {
    console.log('跳过（Ollama 不可用或模型未安装）: ' + model);
    continue;
  }
  plans.push({ id: 'with:' + model, label: '规则+模型（完整流程 · ' + model + '）', mode: 'workflow', model });
}

const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), completedAt: null,
  note: dataset.provenance,
  limitations: [...dataset.limitations, '同一批主诉只切换「有没有模型」，未做多轮重复运行，模型侧结果受本机推理影响。'],
  dataset: {
    id: dataset.id, version: dataset.version,
    sha256: createHash('sha256').update(raw.replace(/\r\n/g, '\n')).digest('hex'),
    cases: dataset.cases.length,
  },
  plans: [],
};
let wrongRecommendationTotal = 0;
for (const plan of plans) {
  const rows = [];
  for (const row of dataset.cases) rows.push(await evaluateCase(row, plan.mode, plan.model));
  const metrics = summarize(rows);
  const wrong = rows.filter(r => !r.pass && r.actual.status === 'recommendation');
  const unconverged = rows.filter(r => r.actual.status !== 'recommendation');
  wrongRecommendationTotal += wrong.length;
  report.plans.push({
    ...plan, metrics,
    wrongRecommendations: wrong.map(r => ({ id: r.id, chief: r.chief, department: r.actual.department })),
    unconvergedIds: unconverged.map(r => r.id),
    rows,
  });
  console.log('\n=== ' + plan.label + ' ===');
  console.log(`  正确给出目标科室: ${metrics.passed}/${metrics.total}`);
  console.log(`  错误科室推荐: ${wrong.length}${wrong.length ? ' → ' + wrong.map(r => r.id + '/' + r.actual.department).join(', ') : ''}`);
  console.log(`  未收敛（安全弃权/追问）: ${unconverged.length}${unconverged.length ? ' → ' + unconverged.map(r => r.id).join(', ') : ''}`);
  console.log(`  模型调用: attempts=${metrics.modelAttempts} used=${metrics.modelSuccesses} failed=${metrics.modelFailures}`);
}
report.completedAt = new Date().toISOString();
await writeFile(new URL('../data/evaluation/probe-latest.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log('\n结果已保存: data/evaluation/probe-latest.json');
console.log('对照探针为合成工程测试，不是临床准确率；错误推荐为 0 时退出码 0。');
if (wrongRecommendationTotal) process.exitCode = 1;