import test from 'node:test';
import assert from 'node:assert/strict';
import { runTriage } from '../lib/flow.js';
const answers = { risk: 'no', age: 'adult', duration: 'days', severity: 'mild' };
test('shared flow maps oral descriptions and exposes evidence', async () => {
  // 交互流程：定位问题先指向肚子，模型再用标准化证据确认同一科室。
  const result = await runTriage({ chief: '肚子疼', answers: { ...answers, p_location: 'belly' }, model: 'fixture' }, {
    normalizer: async () => ({ matches: [{ keyword: '腹痛', evidence: '肚子疼' }], rawCount: 1 }),
  });
  assert.equal(result.department, 'digestive');
  assert.equal(result.model.used, true);
  assert.equal(result.model.attempted, true);
});
test('safety handoffs, missing fields and dynamic probe turns do not invoke models', async () => {
  let calls = 0;
  const normalizer = async () => { calls++; return { matches: [{ keyword: '咳嗽', evidence: '咳嗽' }], rawCount: 1 }; };
  for (const input of [
    { chief: '胸痛', answers },
    { chief: '8岁咳嗽', answers },
    { chief: '肚子疼', answers: { ...answers, severity: 'unknown' } },
    { chief: '肚子疼', answers: { ...answers, severity: 'severe' } },
    { chief: '宝宝咳嗽', answers: { ...answers, age: 'infant' } },
    { chief: '孕期咳嗽', answers },
    { chief: '咳嗽', answers: {} },
    { chief: '咳嗽', answers: { risk: 'no', age: 'adult' } },
    // 零候选定位追问轮不允许调模型。
    { chief: '浑身不得劲，哪儿都难受', answers },
    // 鉴别问题追问轮不允许调模型。
    { chief: '发热，头痛', answers },
    // 定位追问后仍弃权（部位未知），不允许模型翻案。
    { chief: '浑身不得劲，哪儿都难受', answers: { ...answers, p_location: 'unknown' } },
    // 鉴别追问后仍平局弃权，不允许模型翻案。
    { chief: '发热，头痛', answers: { ...answers, p_fever_resp: 'unknown' } },
  ]) await runTriage({ ...input, model: 'fixture' }, { normalizer });
  assert.equal(calls, 0);
});
test('unmatched descriptions still collect severity before handoff', async () => {
  const result = await runTriage({ chief: '肚子疼', answers: { risk: 'no', age: 'adult', duration: 'days' } });
  assert.equal(result.question.id, 'severity');
});
test('model failures remain visible and preserve rule recommendation', async () => {
  const result = await runTriage({ chief: '咳嗽', answers, model: 'fixture' }, { normalizer: async () => { throw new Error('offline'); } });
  assert.equal(result.department, 'respiratory');
  assert.equal(result.model.used, false);
  assert.equal(result.model.attempted, true);
});
test('non-interactive unmatched case can be rescued by model evidence', async () => {
  const result = await runTriage({ chief: '肚子疼', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [{ keyword: '腹痛', evidence: '肚子疼' }], rawCount: 1 }),
  });
  assert.equal(result.department, 'digestive');
});
test('rule/model department conflicts abstain instead of choosing either side', async () => {
  const result = await runTriage({ chief: '头痛，肚子疼还拉肚子', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [{ keyword: '腹痛', evidence: '肚子疼' }, { keyword: '腹泻', evidence: '拉肚子' }], rawCount: 2 }),
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reasonCode, 'model_conflict');
  assert.equal(result.department, null);
  assert.equal(result.model.used, true);
});
test('model output that fails source-text verification triggers evidence abstention', async () => {
  // 非交互零候选（human/unmatched）等待模型救援时，自报证据全部失验即弃权。
  const result = await runTriage({ chief: '浑身不得劲，哪儿都难受', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [], rawCount: 2 }),
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reasonCode, 'evidence_invalid');
});
