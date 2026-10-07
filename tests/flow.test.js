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
// 注：随规则层覆盖增强，能触发入口介入的主诉要同步换。0.9.0 起规则消费同义表，
// 「肚子疼」直接命中消化内科；0.9.1 起规则再消费 X疼/X痛 形态，「腰疼」也直接命中骨科。
// 这里用「腰那一块疼」——词干与疼痛词被“那一块”隔开且中间夹着指代词，形态匹配
// 的紧邻窗口（≤2 字）刻意不覆盖这种散文化说法，规则接不住、必须靠模型标准化，
// 入口介入分支仍被真实覆盖。
test('entry intervention standardizes an oral chief before asking for a body part', async () => {
  let calls = 0;
  const normalizer = async () => { calls++; return { matches: [{ keyword: '腰痛', evidence: '腰那一块疼' }], rawCount: 1 }; };
  const result = await runTriage({ chief: '浑身难受，腰那一块疼', answers, model: 'fixture' }, { normalizer });
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
    const result = await runTriage({ chief: '浑身难受，腰那一块疼', answers, model: 'fixture' }, { normalizer });
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
  // HG-067 的机制：纯字面规则基线读字面 → 头痛（神经内科）；模型把口语标准化 →
  // 腹痛/腹泻（消化内科）；两者不同 → 弃权。
  // 这条用例同时锁死一个关键不变量：**带模型时的冲突对照基线必须是字面口径**。
  // 若对照双方都消费同义表，first 也会把「肚子疼/拉肚子」同义成腹痛/腹泻，
  // 直接落到消化内科、与 second 同科室，冲突判定永不触发
  // （这是 0.9.0 接入同义表时踩到的真实回归，对应 flow.js 的 rulesLiteral）。
  const result = await runTriage({ chief: '头痛，肚子疼还拉肚子', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [
      { keyword: '头痛', evidence: '头痛' },
      { keyword: '腹痛', evidence: '肚子疼' },
      { keyword: '腹泻', evidence: '拉肚子' },
    ], rawCount: 3 }),
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reasonCode, 'model_conflict');
  assert.equal(result.department, null);
  assert.equal(result.model.used, true);
});
test('model-only chest rescue requires human safety assessment', async () => {
  const result = await runTriage({ chief: '我没有胸痛，就是胸口有点闷闷的，不喘', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [{ keyword: '胸闷', evidence: '胸口有点闷闷的' }], rawCount: 1 }),
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reasonCode, 'model_chest_safety');
  assert.equal(result.department, null);
  const normalizer = async () => ({ matches: [{ keyword: '胸痛', evidence: '心口疼' }], rawCount: 1 });
  const screened = await runTriage({ chief: '心口疼', answers: { ...answers, rf_gi_bleed: 'no', rf_epigastric_cardiac: 'no', rf_epigastric_acute: 'no' }, model: 'fixture' }, { normalizer });
  assert.equal(screened.department, 'cardiology');
  const pending = await runTriage({ chief: '心口疼', answers, model: 'fixture' }, { normalizer });
  assert.equal(pending.status, 'question');
  assert.equal(pending.question.id, 'rf_gi_bleed');
});
test('model cannot convert ambiguous rule evidence into a recommendation', async () => {
  const result = await runTriage({ chief: '头痛，胸闷', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [{ keyword: '胸闷', evidence: '胸闷' }], rawCount: 1 }),
  });
  assert.notEqual(result.status, 'recommendation');
  assert.equal(result.department, null);
});
test('unrelated fluent questions fail semantic preservation at the application boundary', async () => {
  const result = await runTriage({ chief: '发热，头痛', answers, model: 'fixture' }, {
    polish: async () => ({ title: '您今天早餐吃了什么？' }),
  });
  assert.equal(result.question.wording.reason, 'rejected');
  const spec = (await import('../data/hospital.js')).probes.find(p => p.id === result.question.id);
  assert.equal(result.question.title, spec.title);
});
test('model-free rules still fall back through synonyms when the model yields no evidence', async () => {
  // 不变量二：带模型时 first（含同义）仍是兜底 —— 口语主诉不因模型的弱表现而退化。
  // 1.5B 对「眼睛发干」可能自报若干条却全部失验（matches 为空），此时规则兜底应给眼科，
  // 而不是因为"等着模型救"就弃权（HG-043 在 1.5B 组曾因此误伤）。
  const result = await runTriage({ chief: '眼睛发干', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [], rawCount: 2 }),
  });
  assert.equal(result.department, 'eye');
});
test('the model-free rule baseline consumes synonyms when no model is present', async () => {
  // 反面不变量：无模型时 first 即最终结论，必须整份消费同义表，否则口语主诉覆盖退化。
  const withModel = await runTriage({ chief: '拉肚子', answers, model: '' }, {
    interactive: false,
    normalizer: async () => ({ matches: [], rawCount: 0 }),
  });
  assert.equal(withModel.department, 'digestive');
  // 同一主诉带模型时，规则字面口径命中不了"拉肚子"，改由模型证据补全为腹泻。
  const rescued = await runTriage({ chief: '拉肚子', answers, model: 'fixture' }, {
    interactive: false,
    normalizer: async () => ({ matches: [{ keyword: '腹泻', evidence: '拉肚子' }], rawCount: 1 }),
  });
  assert.equal(rescued.department, 'digestive');
  assert.equal(rescued.model.used, true);
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
  assert.equal(result.question.title, spec.title);
  assert.equal(result.question.wording.polished, false);
  assert.equal(result.question.wording.reason, 'rejected');
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
