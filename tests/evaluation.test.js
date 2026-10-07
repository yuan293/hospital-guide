import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCase, summarize, validateDataset, comparePaired } from '../lib/evaluation.js';
import { departments } from '../data/hospital.js';
import { fingerprint } from '../lib/evaluation-store.js';
import { validateReportGate } from '../.trae/skills/hospital-guide-verify/scripts/gate-failures.mjs';
test('fingerprints cover version, model lock and actual independent package sources', async () => {
  const f = await fingerprint();
  for (const name of ['package.json', 'data/installed-models.json', 'packages/anchored-evidence-gate/src/anchors.js', 'packages/anchored-evidence-gate/src/polish.js', 'packages/anchored-evidence-gate/src/synonyms.js']) assert.ok(f.files.includes(name));
  assert.match(f.sha256, /^[a-f0-9]{64}$/);
});
test('release gate rejects missing groups and unsafe outcomes on allowlisted ids', () => {
  const check = report => validateReportGate(report).length ? 1 : 0;
  assert.equal(check({ dataset: { cases: 1 }, modes: [] }), 1);
  const mode = id => ({ id, metrics: {}, rows: [{ id: 'HG-018', pass: true, actual: { status: 'human', department: null } }] });
  const report = { dataset: { cases: 1 }, modes: [mode('rules'), mode('dynamic'), mode('model:qwen2.5:1.5b')] };
  report.modes[2].rows[0].pass = false;
  assert.equal(check(report), 0);
  report.modes[2].rows[0].actual = { status: 'recommendation', department: 'cardiology' };
  assert.equal(check(report), 1);
});
const answers = { risk: 'no', age: 'adult', duration: 'days', severity: 'mild' };
test('paired comparisons reject mismatches and exclude different applicable populations', () => {
  const row = (id, turns = 4) => ({ id, chief: '咳嗽', expected: { status: 'recommendation', department: 'respiratory' }, actual: { status: 'recommendation', department: 'respiratory' }, turns });
  const result = comparePaired([row('a'), row('b', 9)], [row('a'), row('c', 1)]);
  assert.equal(result.commonCount, 1);
  assert.equal(result.turns.avgDelta, 0);
  assert.deepEqual(result.baselineOnlyIds, ['b']);
  assert.deepEqual(result.modelOnlyIds, ['c']);
  assert.throws(() => comparePaired([row('a'), row('a')], []));
  assert.throws(() => comparePaired([row('a')], [{ ...row('a'), chief: '头痛' }]));
  assert.equal(comparePaired([], []).turns.avgDelta, null);
  const wrong = { ...row('a'), actual: { status: 'recommendation', department: 'eye' } };
  const handoff = { ...row('a'), actual: { status: 'human', department: null } };
  assert.equal(comparePaired([handoff], [wrong]).recommendationRescues.count, 0);
});
test('workflow evaluation follows dynamic production question order', async () => {
  const row = { id: 'x', suite: 'regression', category: 'test', input: { chief: '咳嗽', answers }, expected: { status: 'recommendation', department: 'respiratory' } };
  const result = await evaluateCase(row, 'workflow', '');
  assert.equal(result.pass, true);
  assert.deepEqual(result.trace.map(t => t.question), ['risk', 'age', 'severity', null]);
});
test('rules mode keeps the legacy fixed duration question', async () => {
  const row = { id: 'x', suite: 'regression', category: 'test', input: { chief: '咳嗽', answers: { risk: 'no', age: 'adult' } }, expected: { status: 'question', question: 'duration', department: null } };
  const result = await evaluateCase(row, 'rules', '');
  assert.equal(result.pass, true);
  assert.equal(result.trace[0].question, 'duration');
});
test('dynamic mode follows probe answers and records abstentions', async () => {
  const asked = await evaluateCase({ id: 'x', suite: 'regression', category: 'test', input: { chief: '浑身不得劲，哪儿都难受', answers }, expected: { status: 'question', question: 'p_location', department: null } }, 'dynamic', '');
  assert.equal(asked.pass, true);
  assert.equal(asked.trace.at(-1).question, 'p_location');
  const resolved = await evaluateCase({ id: 'y', suite: 'regression', category: 'test', input: { chief: '腹痛，还有尿频', answers: { ...answers, p_abdomen_urine: 'yes' } }, expected: { status: 'recommendation', department: 'urology' } }, 'dynamic', '');
  assert.equal(resolved.pass, true);
  assert.equal(resolved.trace[0].question, 'risk');
  const abstained = await evaluateCase({ id: 'z', suite: 'regression', category: 'test', input: { chief: '浑身不得劲，哪儿都难受', answers: { ...answers, p_location: 'unknown' } }, expected: { status: 'uncertain', department: null, reasonCode: 'unlocated' } }, 'dynamic', '');
  assert.equal(abstained.pass, true);
});
test('mode-specific rows are skipped outside their declared modes', async () => {
  const row = { id: 'x', suite: 'regression', category: 'test', modes: ['rules'], input: { chief: '咳嗽', answers }, expected: { status: 'recommendation', department: 'respiratory' } };
  const result = await evaluateCase(row, 'dynamic', '');
  assert.equal(result.skipped, true);
});
test('incomplete answers produce a question, not fabricated defaults', async () => {
  const result = await evaluateCase({ id: 'x', suite: 'regression', category: 'test', input: { chief: '咳嗽', answers: { risk: 'no' } }, expected: { status: 'question', question: 'age', department: null } }, 'workflow', '');
  assert.equal(result.pass, true);
  assert.equal(result.trace.length, 2);
});
test('metrics use labeled subsets and do not reward handoff as a department hit', () => {
  const make = (expected, actual, pass = false, turns = 1) => ({ expected, actual, pass, skipped: false, turns, elapsedMs: 1, category: 'test', modelAttempts: 0, modelSuccesses: 0, modelFailures: 0 });
  const rows = [
    make({ status: 'recommendation', department: 'digestive' }, { status: 'human', department: null, reasonCode: null }),
    make({ status: 'recommendation', department: 'respiratory' }, { status: 'recommendation', department: 'respiratory', reasonCode: null }, true, 3),
    make({ status: 'emergency' }, { status: 'human', reasonCode: null }),
    make({ status: 'emergency' }, { status: 'emergency', reasonCode: null }, true),
    make({ status: 'human' }, { status: 'emergency', reasonCode: null }),
    make({ status: 'uncertain' }, { status: 'uncertain', reasonCode: 'model_conflict' }, true, 2),
  ];
  const result = summarize(rows);
  assert.deepEqual(result.departmentAccuracy, { numerator: 1, denominator: 2, value: .5 });
  assert.equal(result.emergencyRecall.value, .5);
  assert.equal(result.emergencyMisses, 1);
  assert.equal(result.humanTransferRate.value, 2 / 6);
  assert.equal(result.abstentionRate.value, 1 / 6);
  assert.equal(result.conflictRate.value, 1 / 6);
  assert.equal(result.avgTurns, (1 + 3 + 1 + 1 + 1 + 2) / 6);
  assert.equal(result.falseEmergencyRate.denominator, 4);
  assert.equal(summarize([]).emergencyRecall.value, null);
});
test('anyOf accepts multiple equivalent safe outcomes but never a recommendation', async () => {
  const vague = '整个人都不太对劲，说不上来哪里的问题，就觉得身上哪儿都别扭';
  const safePair = [
    { status: 'human', department: null, reasonCode: 'unmatched' },
    { status: 'uncertain', department: null, reasonCode: 'evidence_invalid' },
  ];
  // rules 非交互模式下零候选 -> human/unmatched：主结局为 human 时通过。
  const humanPrimary = { id: 'x', suite: 'challenge', category: 'test', input: { chief: vague, answers },
    expected: { status: 'human', department: null, reasonCode: 'unmatched', anyOf: safePair } };
  assert.equal((await evaluateCase(humanPrimary, 'rules', '')).pass, true);
  // 主结局写成弃权、但把 human/unmatched 列入 anyOf：真实结果 human 仍判通过。
  const uncertainPrimary = { ...humanPrimary, id: 'y', expected: { status: 'uncertain', department: null, reasonCode: 'evidence_invalid', anyOf: safePair } };
  assert.equal((await evaluateCase(uncertainPrimary, 'rules', '')).pass, true);
  // 不在 anyOf 内的其他终态（平局转人工 human/ambiguous）仍判失败。
  const tie = { id: 'z', suite: 'challenge', category: 'test', input: { chief: '发热，头痛', answers },
    expected: { status: 'uncertain', department: null, reasonCode: 'evidence_invalid', anyOf: safePair } };
  assert.equal((await evaluateCase(tie, 'rules', '')).pass, false);
  // fail-closed：anyOf 不得包含推荐类结局、长度不足或不覆盖主预期。
  const data = { schemaVersion: 1, id: 'test', version: '1', cases: [humanPrimary] };
  assert.equal(validateDataset(data, departments), data);
  assert.throws(() => validateDataset({ ...data, cases: [{ ...humanPrimary, expected: { status: 'human', department: null, reasonCode: 'unmatched', anyOf: [{ status: 'human', department: null }, { status: 'recommendation', department: 'respiratory' }] } }] }, departments));
  assert.throws(() => validateDataset({ ...data, cases: [{ ...humanPrimary, expected: { status: 'human', department: null, reasonCode: 'unmatched', anyOf: [{ status: 'human', department: null }] } }] }, departments));
  assert.throws(() => validateDataset({ ...data, cases: [{ ...humanPrimary, expected: { status: 'human', department: null, reasonCode: 'safety', anyOf: safePair } }] }, departments));
});
test('dataset validation rejects duplicate ids and impossible labels', () => {
  const row = { id: 'x', suite: 'regression', category: 'test', input: { chief: '咳嗽', answers }, expected: { status: 'recommendation', department: 'respiratory' } };
  const data = { schemaVersion: 1, id: 'test', version: '1', cases: [row] };
  assert.equal(validateDataset(data, departments), data);
  assert.throws(() => validateDataset({ ...data, cases: [row, row] }, departments));
  assert.throws(() => validateDataset({ ...data, cases: [{ ...row, expected: { status: 'recommendation', department: 'missing' } }] }, departments));
  assert.throws(() => validateDataset({ ...data, cases: [{ ...row, expected: { status: 'question', department: null, question: 'p_not_configured' } }] }, departments));
  assert.throws(() => validateDataset({ ...data, cases: [{ ...row, expected: { status: 'uncertain', department: 'general' } }] }, departments));
  assert.throws(() => validateDataset({ ...data, cases: [{ ...row, modes: ['unknown'] }] }, departments));
  const probeData = { ...data, cases: [{ ...row, input: { chief: '咳嗽', answers: { ...answers, p_location: 'belly' } } }] };
  assert.equal(validateDataset(probeData, departments), probeData);
});
