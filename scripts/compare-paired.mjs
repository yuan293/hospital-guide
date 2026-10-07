import { readFileSync } from 'node:fs';
import { comparePaired } from '../lib/evaluation.js';
const report = JSON.parse(readFileSync(process.argv[2] || new URL('../data/evaluation/latest.json', import.meta.url), 'utf8'));
const baseline = report.modes?.find(m => m.id === 'dynamic');
const workflows = report.modes?.filter(m => m.id.startsWith('workflow:')) || [];
if (!baseline || !workflows.length) throw new Error('缺少dynamic或真实模型workflow报告，不能计算AI增益。');
console.log(JSON.stringify({ dataset: report.dataset, note: '同样本配对；工程合成集，不是独立临床验证。负轮次差表示模型少问，0不代表潜在长尾无价值。', comparisons: workflows.map(m => ({ model: m.id, ...comparePaired(baseline.rows, m.rows) })) }, null, 2));
