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
    // 鉴别问题追问轮不允许调模型。
    { chief: '发热，头痛', answers },
    // 安全确认（红旗征）还没问完时，不允许模型抢在安全确认之前介入。
    { chief: '上腹部不舒服', answers },
    // 定位追问后仍弃权（部位未知），不允许模型翻案。
    { chief: '浑身不得劲，哪儿都难受', answers: { ...answers, p_location: 'unknown' } },
    // 鉴别追问后仍平局弃权，不允许模型翻案。
    { chief: '发热，头痛', answers: { ...answers, p_fever_resp: 'unknown' } },
  ]) await runTriage({ ...input, model: 'fixture' }, { normalizer });
  assert.equal(calls, 0);
});
// 入口介入：规则一条症状词都没命中、正要追问“不适部位”时，先让模型标准化口语主诉，
// 命中核验证据就不再问部位问题，直接进入同一套评分流程。
// 注：0.8.1 起规则路径也消费登记同义表，「肚子疼」已由规则直接命中消化内科，
// 不再经过入口介入。这里改用规则与同义表都接不住的组合（"腰疼"仅靠形态锚点核验
// 可支持"腰痛"，但未登记为规则同义），以继续覆盖入口介入分支。
test('entry intervention standardizes an oral chief before asking for a body part', async () => {
  let calls = 0;
  const normalizer = async () => { calls++; return { matches: [{ keyword: '腰痛', evidence: '腰疼' }], rawCount: 1 }; };
  const result = await runTriage({ chief: '浑身难受，腰疼', answers, model: 'fixture' }, { normalizer });
  assert.equal(calls, 1);
  assert.equal(result.status, 'recommendation');
  assert.equal(result.department, 'orthopedics');
  assert.equal(result.model.phase, 'entry');
  assert.equal(result.model.used, true);
});
// 入口介入拿不到核验证据时退回无模型行为：照旧追问部位，而不是直接弃权。
test('entry intervention without verified evidence falls back to the location question', async () => {
  for (const normalizer of [
    async () => ({ matches: [], rawCount: 0 }),
    async () => ({ matches: [], rawCount: 3 }),
  ]) {
    const result = await runTriage({ chief: '浑身难受，腰疼', answers, model: 'fixture' }, { normalizer });
    assert.equal(result.status, 'question');
    assert.equal(result.question.id, 'p_location');
    assert.equal(result.model.used, false);
    assert.equal(result.model.phase, 'entry');
  }
});
// 入口介入只在“还没问过部位”时发生；问过之后仍无结论的弃权不让模型翻案。
test('entry intervention does not run after the location question was answered', async () => {
  let calls = 0;
  const normalizer = async () => { calls++; return { matches: [{ keyword: '腹痛', evidence: '肚子疼' }], rawCount: 1 }; };
  const result = await runTriage({ chief: '浑身不得劲，哪儿都难受', answers: { ...answers, p_location: 'unknown' }, model: 'fixture' }, { normalizer });
  assert.equal(calls, 0);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reasonCode, 'unlocated');
});
// 安全确认优先于入口介入：红旗征没问完先问红旗征，问完（全阴性）之后模型才介入。
test('safety screen stays ahead of the entry intervention', async () => {
  let calls = 0;
  const normalizer = async () => { calls++; return { matches: [{ keyword: '腹痛', evidence: '腹部' }], rawCount: 1 }; };
  const pending = await runTriage({ chief: '上腹部不舒服', answers, model: 'fixture' }, { normalizer });
  assert.equal(calls, 0);
  assert.equal(pending.status, 'question');
  assert.equal(pending.question.id, 'rf_gi_bleed');
  const screened = await runTriage({
    chief: '上腹部不舒服',
    answers: { ...answers, rf_gi_bleed: 'no', rf_epigastric_cardiac: 'no', rf_epigastric_acute: 'no' },
    model: 'fixture',
  }, { normalizer });
  assert.equal(calls, 1);
  assert.equal(screened.status, 'recommendation');
  assert.equal(screened.department, 'digestive');
  assert.equal(screened.model.phase, 'entry');
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
  // 注：0.8.1 起规则路径消费同义表，原先的「头痛+肚子疼+拉肚子」已由规则与模型共同
  // 指向消化内科（不再冲突）。这里改用仅靠形态锚点核验、规则层接不住的口语
  // （腰疼→腰痛、膝盖也疼→膝盖痛，均属骨科），构造真正的"规则/模型科室不一致"。
  const result = await runTriage({ chief: '咳嗽，腰疼，膝盖也疼', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [{ keyword: '腰痛', evidence: '腰疼' }, { keyword: '膝盖痛', evidence: '膝盖也疼' }], rawCount: 2 }),
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
// 第二类模型职能：追问措辞润色（0.8.0）。模型只改展示措辞，选项与权重恒来自配置。
test('model polishes a differential question title while options and weights stay from config', async () => {
  const polish = async probe => ({ title: '你说发热头痛，还有别的情况吗？', description: '换个说法再确认一下。' });
  const result = await runTriage({ chief: '发热，头痛', answers, model: 'fixture' }, {
    normalizer: async () => ({ matches: [], rawCount: 0 }),
    polish,
  });
  assert.equal(result.status, 'question');
  const spec = (await import('../data/hospital.js')).probes.find(p => p.id === result.question.id);
  assert.notEqual(result.question.title, spec.title);
  assert.equal(result.question.wording.polished, true);
  // 选项取值与文案必须与配置逐字一致——模型无权改动选项。
  assert.deepEqual(result.question.options, spec.options);
});
// 措辞润色是 fail-closed 的：模型给出诊断性/非问句措辞时一律拒收，回退到配置原文。
test('polished wording that is diagnostic or not a question is rejected', async () => {
  const spec = (await import('../data/hospital.js')).probes.find(p => p.kind === 'differential');
  for (const bad of [
    { title: '你肯定是胃病，吃点药吧。' },          // 诊断+用药
    { title: '建议服用奥美拉唑缓解。' },              // 用药建议
    { title: '不用担心，这不严重。' },                // 淡化风险
    { title: '嗯。' },                                // 太短
    { title: '请描述你的症状。'.repeat(5) },           // 超长
    { title: '你的情况我已经了解了。' },              // 陈述句，非问句
  ]) {
    const { acceptPolish } = await import('../lib/model.js');
    assert.equal(acceptPolish(bad, spec), null, `应拒收：${bad.title}`);
  }
  // 合格措辞正常放行
  const { acceptPolish } = await import('../lib/model.js');
  assert.ok(acceptPolish({ title: '除了这个，还有别的不舒服吗？', description: '帮我们确认一下。' }, spec));
});
// 模型润色失败/不可用时不影响流程：追问照常返回，只是保留配置原文。
test('polish failure does not block the question or change its options', async () => {
  const result = await runTriage({ chief: '发热，头痛', answers, model: 'fixture' }, {
    normalizer: async () => ({ matches: [], rawCount: 0 }),
    polish: async () => { throw new Error('offline'); },
  });
  assert.equal(result.status, 'question');
  const spec = (await import('../data/hospital.js')).probes.find(p => p.id === result.question.id);
  assert.equal(result.question.title, spec.title);
  assert.equal(result.question.wording.polished, false);
  assert.equal(result.question.wording.reason, 'unavailable');
});
// 安全确认（红旗征）问句永远不允许模型润色：避免改写危险征象的问法。
test('safety-screen and location questions are never polished', async () => {
  let polishCalls = 0;
  const polish = async () => { polishCalls++; return { title: '随便改改？' }; };
  // 红旗征问句
  await runTriage({ chief: '上腹部不舒服', answers, model: 'fixture' }, {
    normalizer: async () => ({ matches: [], rawCount: 0 }), polish,
  });
  // 部位定位问句
  await runTriage({ chief: '浑身不得劲，哪儿都难受', answers, model: 'fixture' }, {
    normalizer: async () => ({ matches: [], rawCount: 0 }), polish,
  });
  assert.equal(polishCalls, 0);
});
