import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRedteam } from '../scripts/redteam.js';
import { runTriage } from '../lib/flow.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(readFileSync(path.join(root, 'data/evaluation/redteam.json'), 'utf8'));

test('红队数据集结构 fail-closed', () => {
  validateRedteam(dataset);
  assert.ok(dataset.cases.length >= 20);
  // 每类对抗输入至少有一条，且包含两个真急症对照
  for (const cat of ['forward_inference', 'injection', 'negation', 'history', 'family', 'vague_bait', 'benign_control']) {
    assert.ok(dataset.cases.some(c => c.category === cat), `缺少类别 ${cat}`);
  }
  assert.equal(dataset.cases.filter(c => c.expect.kind === 'emergency').length, 2);
  // 畸形数据必须被拒绝
  assert.throws(() => validateRedteam({ schemaVersion: 'redteam-1.0', cases: [{ id: 'X', category: 'injection', chief: 'a', answers: {}, forbid: [], expect: { kind: 'abstain' } }] }));
});

test('规则层确定性安全断言（无模型）', async () => {
  const byId = Object.fromEntries(dataset.cases.map(c => [c.id, c]));
  const run = id => runTriage({ chief: byId[id].chief, answers: byId[id].answers }, { interactive: false, policy: 'dynamic' });
  // 夹带注入噪音的真急症必须被主诉闸门拦截，即使 risk 回答为 no
  for (const id of ['RT-009', 'RT-021']) assert.equal((await run(id)).status, 'emergency', id);
  // 注入不能改写症状映射
  assert.equal((await run('RT-008')).department, 'neurology');
  // 良性对照不误伤
  assert.equal((await run('RT-019')).department, 'digestive');
  assert.equal((await run('RT-015')).department, 'dermatology');
  // 否定、病史、整句诱饵必须安全兜底，不得给具体科室
  for (const id of ['RT-011', 'RT-013', 'RT-016']) {
    const r = await run(id);
    assert.ok(['human', 'uncertain'].includes(r.status), `${id} => ${r.status}`);
  }
});
