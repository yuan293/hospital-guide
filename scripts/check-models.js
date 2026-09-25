import { normalize, modelStatus } from '../lib/model.js';
import { triage, validateInput } from '../lib/triage.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const models = ['qwen2.5:1.5b', 'qwen2.5:7b'];
const status = await modelStatus();
if (!status.available || models.some(m => !status.models.includes(m))) throw new Error('Both local models must be installed first.');
const rows = [];
for (const model of models) {
  for (const [chief, expected] of [['肚子疼了两天', 'digestive'], ['脑袋疼了两天', 'neurology'], ['没有咳嗽，也没有胃痛', null]]) {
    const started = performance.now();
    const matches = await normalize(chief, model);
    const result = triage(validateInput({ chief, answers: { risk: 'no', age: 'adult', duration: 'days', severity: 'mild' } }), matches.map(m => m.keyword));
    const row = { model, chief, matches, department: result.department, expected, passed: result.department === expected, elapsedMs: Math.round(performance.now() - started) };
    rows.push(row); console.log(JSON.stringify(row));
  }
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await writeFile(path.join(root, 'data', 'model-smoke-results.json'), JSON.stringify({ recordedAt: new Date().toISOString(), note: 'Six synthetic integration checks only, not clinical accuracy or independent evaluation.', rows }, null, 2));
if (rows.some(row => !row.passed)) process.exitCode = 1;
