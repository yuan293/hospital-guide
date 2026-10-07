#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const allowlist = {
  rules: [], dynamic: [], 'model:qwen2.5:7b': [], 'workflow:qwen2.5:7b': [],
  'model:qwen2.5:1.5b': ['HG-018', 'HG-020', 'HG-051'], 'workflow:qwen2.5:1.5b': [],
};
// 显式白名单仅豁免已审核的无科室安全回退，不豁免推荐、急症漏判、执行错误。
export function validateReportGate(report, { full = false } = {}) {
  const errors = [];
  const modes = Array.isArray(report?.modes) ? report.modes : [];
  const required = full ? Object.keys(allowlist) : ['rules', 'dynamic'];
  const groups = modes.map(m => m.id);
  if (report?.skipped?.length || required.some(id => !groups.includes(id)) || new Set(groups).size !== groups.length) errors.push('必需评测组缺失、重复或模型跳过');
  const canonicalIds = modes[0]?.rows?.map(r => r.id).sort();
  for (const m of modes) {
    if (!Object.hasOwn(allowlist, m.id)) { errors.push('未知评测组: ' + m.id); continue; }
    if (!Array.isArray(m.rows) || !m.rows.length || m.rows.length !== report.dataset?.cases || m.metrics?.errors || m.metrics?.modelFailures) { errors.push('样本不完整或执行出错: ' + m.id); continue; }
    const ids = m.rows.map(r => r.id);
    if (new Set(ids).size !== ids.length || JSON.stringify([...ids].sort()) !== JSON.stringify(canonicalIds)) errors.push('案例ID缺失、重复或跨组不一致: ' + m.id);
    if (m.rows.every(r => r.skipped)) errors.push('全部样本跳过: ' + m.id);
    for (const r of m.rows) {
      if (r.skipped) continue;
      if (r.error || r.modelFailures || typeof r.pass !== 'boolean') { errors.push('执行错误或未判定: ' + m.id + ':' + r.id); continue; }
      if (r.pass) continue;
      const safe = ['human', 'uncertain'].includes(r.actual?.status) && !r.actual?.department && r.expected?.status !== 'emergency';
      if (!allowlist[m.id].includes(r.id) || !safe) errors.push('白名单外失败或非安全回退: ' + m.id + ':' + r.id);
    }
  }
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(readFileSync(process.argv[2] || 'data/evaluation/quick-latest.json', 'utf8'));
  const errors = validateReportGate(report, { full: process.argv.includes('--full') });
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('发布门禁通过：必需组/样本完整，白名单仅含安全回退。');
}
