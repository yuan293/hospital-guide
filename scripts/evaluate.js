import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { platform, arch, cpus } from 'node:os';
import { departments, dataInfo } from '../data/hospital.js';
import { modelStatus } from '../lib/model.js';
import { evaluateCase, summarize, validateDataset } from '../lib/evaluation.js';
import { fingerprint, reportUrl } from '../lib/evaluation-store.js';

const args = process.argv.slice(2);
if (args.some(a => !['--models', '--strict'].includes(a.split('=')[0]) || (a.startsWith('--models') && !a.startsWith('--models=')))) throw new Error('用法: node scripts/evaluate.js [--models=qwen2.5:7b,qwen2.5:1.5b] [--strict]');
const requestedModels = [...new Set((args.find(a => a.startsWith('--models='))?.slice(9) || '').split(',').filter(Boolean))];
const raw = await readFile(new URL('../data/evaluation/cases.json', import.meta.url), 'utf8');
const dataset = validateDataset(JSON.parse(raw), departments);
const before = await fingerprint();
const status = requestedModels.length ? await modelStatus() : { available: false, models: [], details: [] };
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), completedAt: null,
  note: dataset.provenance,
  limitations: [...dataset.limitations, '单机顺序运行一次；耗时含模型冷启动影响，不是并发或生产性能测试。', '所有模式共用风险规则；模型辅助只改变症状标准化，完整流程检验逐轮状态转换。', 'rules 为 legacy 固定追问消融基线；dynamic/workflow 启用信息增益追问与存疑弃权，弃权率不以越低越好。'],
  dataset: { id: dataset.id, version: dataset.version, sha256: createHash('sha256').update(raw).digest('hex'), cases: dataset.cases.length },
  fingerprint: before, dataSha256: dataInfo.sha256,
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  modes: [], skipped: [],
};
const plans = [
  { id: 'rules', mode: 'rules', model: '', label: '规则基线 · legacy 固定追问（消融对照）' },
  { id: 'dynamic', mode: 'dynamic', model: '', label: '信息增益动态追问（无模型）' },
];
for (const model of requestedModels) {
  if (!status.available || !status.models.includes(model)) { report.skipped.push({ model, reason: '本机模型未安装或 Ollama 不可用；未计入已运行结果。' }); continue; }
  plans.push({ id: 'model:' + model, mode: 'model', model, label: '模型辅助 · ' + model }, { id: 'workflow:' + model, mode: 'workflow', model, label: '完整多轮 · 动态追问 + ' + model });
}
for (const plan of plans) {
  console.log('开始: ' + plan.label);
  const rows = [];
  for (const row of dataset.cases) {
    rows.push(await evaluateCase(row, plan.mode, plan.model));
    if (rows.length % 10 === 0) console.log('  ' + rows.length + '/' + dataset.cases.length);
  }
  const entry = { ...plan, modelDetails: status.details?.find(m => m.name === plan.model) || null, metrics: summarize(rows), regression: summarize(rows.filter(r => r.suite === 'regression')), challenge: summarize(rows.filter(r => r.suite === 'challenge')), rows };
  report.modes.push(entry);
  console.log(JSON.stringify({ mode: plan.id, ...entry.metrics }));
}
report.completedAt = new Date().toISOString();
if ((await fingerprint()).sha256 !== before.sha256) throw new Error('评测期间代码或数据发生变化，本次结果不发布，请重跑。');
await mkdir(new URL('../data/evaluation/runs/', import.meta.url), { recursive: true });
const content = JSON.stringify(report, null, 2) + '\n';
const runName = report.completedAt.replace(/[:.]/g, '-') + '.json';
await writeFile(new URL('../data/evaluation/runs/' + runName, import.meta.url), content);
const temporary = fileURLToPath(reportUrl) + '.tmp';
await writeFile(temporary, content);
await rename(temporary, reportUrl);
console.log('结果已保存: data/evaluation/latest.json（含全部案例、失败和逐轮轨迹）');
console.log('合成工程测试，不是临床准确率。人工转接率不以越低越好。');
if (report.skipped.length || report.modes.some(m => m.metrics.modelFailures || m.metrics.errors || m.regression.passed !== m.regression.total || args.includes('--strict') && m.metrics.passed !== m.metrics.total)) process.exitCode = 1;
