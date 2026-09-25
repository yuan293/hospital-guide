import test from 'node:test';
import assert from 'node:assert/strict';
import { triage, validateInput, mentions, evidenceSupported } from '../lib/triage.js';

const complete = { risk: 'no', age: 'adult', duration: 'days', severity: 'mild' };
const run = (chief, answers = complete, options = {}) => triage(validateInput({ chief, answers }), [], options);
// 上腹痛安全确认的中性回答：红旗征全部阴性，用于验证安全确认走完后
// 科室评分与原有平局/弃权判定没有变化。
const SAFETY = {
  rf_gi_bleed: 'no',
  rf_epigastric_cardiac: 'no',
  rf_epigastric_acute: 'no',
};
const SAFETY_IDS = Object.keys(SAFETY);
const withSafety = answers => ({ ...complete, ...answers });

test('empty and overlong descriptions are rejected', () => {
  for (const chief of ['', 'a', 'a'.repeat(1201), null, 123]) assert.throws(() => validateInput({ chief }));
});
test('unknown answer keys and forged choices are rejected', () => {
  assert.throws(() => validateInput({ chief: '咳嗽', answers: { risk: 'safe' } }));
  assert.throws(() => validateInput({ chief: '咳嗽', answers: { ignoreSafety: true } }));
  assert.throws(() => validateInput({ chief: '咳嗽', answers: [] }));
  assert.throws(() => validateInput({ chief: '咳嗽', answers: { p_fever_resp: 'maybe' } }));
  assert.throws(() => validateInput({ chief: '咳嗽', answers: { p_not_configured: 'yes' } }));
});
test('configured probe answers are accepted', () => {
  assert.equal(validateInput({ chief: '咳嗽', answers: { p_fever_resp: 'yes' } }).answers.p_fever_resp, 'yes');
});
test('raw symptoms override a claimed negative risk answer', () => {
  assert.equal(run('现在胸痛，冒冷汗').status, 'emergency');
  assert.equal(run('咳嗽而且呼吸困难').status, 'emergency');
});
test('affirmed structured risks interrupt before age collection', () => {
  assert.equal(run('咳嗽', { risk: 'yes' }).status, 'emergency');
  assert.equal(run('头痛', { ...complete, severity: 'severe' }).status, 'emergency');
});
test('negative and historical mentions are not treated as current risks', () => {
  assert.equal(mentions('咳嗽，没有胸痛', '胸痛'), false);
  assert.equal(mentions('没有胸痛和呼吸困难', '呼吸困难'), false);
  assert.equal(mentions('去年有胸痛，现在咳嗽', '胸痛'), false);
  assert.equal(mentions('爸爸有胸痛，我咳嗽', '胸痛'), false);
  assert.equal(run('咳嗽，没有胸痛和呼吸困难').department, 'respiratory');
});
test('contrast and subsequent positive mentions still trigger risk', () => {
  assert.equal(run('没有胸痛，但是呼吸困难').status, 'emergency');
  assert.equal(run('以前没有胸痛，现在胸痛').status, 'emergency');
});
test('negative symptoms do not generate ordinary matches', () => {
  assert.equal(run('没有咳嗽，没有胃痛').status, 'human');
});
test('legacy policy asks risk, age, duration and severity in fixed order', () => {
  let answers = {};
  for (const id of ['risk', 'age', 'duration', 'severity']) {
    assert.equal(run('咳嗽三天', answers, { policy: 'legacy' }).question.id, id);
    answers[id] = complete[id];
  }
  assert.equal(run('咳嗽三天', answers, { policy: 'legacy' }).department, 'respiratory');
});
test('dynamic policy skips duration and asks risk, age and severity only', () => {
  let answers = {};
  for (const id of ['risk', 'age', 'severity']) {
    assert.equal(run('咳嗽三天', answers, { interactive: true }).question.id, id);
    answers[id] = complete[id];
  }
  assert.equal(run('咳嗽三天', answers, { interactive: true }).department, 'respiratory');
});
test('unmatched colloquial descriptions trigger one location probe, then resolve or abstain', () => {
  const vague = '浑身不得劲，哪儿都难受';
  assert.equal(run(vague, complete, { interactive: true }).question.id, 'p_location');
  assert.equal(run(vague, { ...complete, p_location: 'belly' }, { interactive: true }).department, 'digestive');
  const unresolved = run(vague, { ...complete, p_location: 'unknown' }, { interactive: true });
  assert.equal(unresolved.status, 'uncertain');
  assert.equal(unresolved.reasonCode, 'unlocated');
  // 非交互模式不允许追问，保持一次性转人工。
  assert.equal(run(vague, complete).status, 'human');
});
test('tied departments trigger information-gain probes and abstain after an unresolved probe', () => {
  const chief = '发热，头痛';
  assert.equal(run(chief, complete, { interactive: true }).question.id, 'p_fever_resp');
  assert.equal(run(chief, { ...complete, p_fever_resp: 'yes' }, { interactive: true }).department, 'respiratory');
  assert.equal(run(chief, { ...complete, p_fever_resp: 'no' }, { interactive: true }).department, 'neurology');
  const stillTied = run(chief, { ...complete, p_fever_resp: 'unknown' }, { interactive: true });
  assert.equal(stillTied.status, 'uncertain');
  assert.equal(stillTied.reasonCode, 'ambiguous');
  // 没有任何鉴别 probe 覆盖的平局（神经+消化）先走安全确认，
  // 安全确认走完后仍然平局，保持转人工。
  assert.equal(run('头痛，还有胃痛', complete, { interactive: true }).question.id, 'rf_gi_bleed');
  assert.equal(run('头痛，还有胃痛', withSafety(SAFETY), { interactive: true }).status, 'human');
  // 非交互模式不追问、不弃权，直接转人工。
  assert.equal(run(chief, complete).status, 'human');
});

test('epigastric chief completes the safety check before department advice', () => {
  const chief = '上腹痛两天';
  let answers = { ...complete };
  // 三项红旗征按配置顺序问完，然后才给科室建议。
  for (const id of SAFETY_IDS) {
    const step = run(chief, answers, { interactive: true });
    assert.equal(step.question.id, id);
    assert.equal(step.question.meta.pathway, 'pw_epigastric');
    assert.equal(step.question.meta.kind, 'redflag');
    answers = { ...answers, [id]: SAFETY[id] };
  }
  const final = run(chief, answers, { interactive: true });
  assert.equal(final.status, 'recommendation');
  assert.equal(final.department, 'digestive');
  // 安全确认完成情况写进判断依据。
  assert.match(final.evidence.join(' '), /已完成 3 项红旗征筛查/);
});

test('red flag answers escalate and cannot be overridden by later answers', () => {
  const chief = '上腹痛两天';
  // 主诉本身不含任何风险词：只有安全确认能发现这些征象。
  assert.equal(mentions(chief, '呕血'), false);
  const bleeding = run(chief, withSafety({ rf_gi_bleed: 'yes' }), { interactive: true });
  assert.equal(bleeding.status, 'emergency');
  assert.equal(bleeding.department, 'emergency');
  assert.match(bleeding.evidence.join(' '), /消化道出血征象/);
  assert.match(bleeding.sources.join(' '), /DEMO-PATHWAY/);
  const cardiac = run(chief, withSafety({ rf_epigastric_cardiac: 'yes' }), { interactive: true });
  assert.equal(cardiac.status, 'emergency');
  // 回答“不确定”不能当成阴性：风险闸门之后的普通推荐一律停止。
  const unsure = run(chief, withSafety({ rf_epigastric_acute: 'unknown' }), { interactive: true });
  assert.equal(unsure.status, 'human');
  assert.equal(unsure.reasonCode, 'safety');
  // 阴性回答不升级，安全确认继续问下一项。
  assert.equal(run(chief, withSafety({ rf_gi_bleed: 'no' }), { interactive: true }).question.id, 'rf_epigastric_cardiac');
});

test('safety check still runs when no department matches yet', () => {
  const chief = '上腹部不舒服';
  assert.equal(run(chief, complete, { interactive: true }).question.id, 'rf_gi_bleed');
  // 安全确认走完后没有任何科室证据，才回到定位追问。
  assert.equal(run(chief, withSafety(SAFETY), { interactive: true }).question.id, 'p_location');
});

test('safety check only activates on asserted epigastric anchors', () => {
  // 否定表述不激活安全确认，也不改变原有推荐。
  assert.equal(run('没有胃痛，就是咳嗽', complete, { interactive: true }).department, 'respiratory');
  // 其他主诉不进入上腹痛安全确认。
  assert.equal(mentions('咳嗽三天', '上腹'), false);
  // 答完第一项后，安全确认继续问第二项。
  assert.equal(run('上腹痛两天', withSafety({ rf_gi_bleed: 'no' }), { interactive: true }).question.id, 'rf_epigastric_cardiac');
  // 导诊结果里只有就诊方向，不再包含任何面向医生的记录字段。
  const result = run('上腹痛两天', withSafety(SAFETY), { interactive: true });
  assert.deepEqual(Object.keys(result).sort(), ['candidates', 'department', 'evidence', 'model', 'next', 'reason', 'slots', 'sources', 'status', 'title']);
});
test('new differential probes break ties and expose gain/leaders metadata', () => {
  // 腰痛 vs 泌尿：腰痛 + 尿频 平局
  const back = '腰痛，还尿频';
  const askBack = run(back, complete, { interactive: true });
  assert.equal(askBack.question.id, 'p_back_urine');
  assert.deepEqual(askBack.question.meta, { kind: 'differential', leaders: ['orthopedics', 'urology'], gain: 2 });
  assert.equal(run(back, { ...complete, p_back_urine: 'yes' }, { interactive: true }).department, 'urology');
  assert.equal(run(back, { ...complete, p_back_urine: 'no' }, { interactive: true }).department, 'orthopedics');
  // 头晕 vs 耳鼻喉：头晕 + 耳鸣 平局
  const dizzy = '头晕还耳鸣';
  assert.equal(run(dizzy, complete, { interactive: true }).question.id, 'p_dizzy_ent');
  assert.equal(run(dizzy, { ...complete, p_dizzy_ent: 'yes' }, { interactive: true }).department, 'ent');
  assert.equal(run(dizzy, { ...complete, p_dizzy_ent: 'no' }, { interactive: true }).department, 'neurology');
  // 皮肤 vs 眼科：皮疹 + 眼痒 平局
  const allergy = '皮疹还眼痒';
  assert.equal(run(allergy, complete, { interactive: true }).question.id, 'p_allergy');
  assert.equal(run(allergy, { ...complete, p_allergy: 'yes' }, { interactive: true }).department, 'eye');
  assert.equal(run(allergy, { ...complete, p_allergy: 'no' }, { interactive: true }).department, 'dermatology');
  // 定位问题携带 location meta；普通槽位问题不携带 meta。
  assert.equal(run('浑身不得劲', complete, { interactive: true }).question.meta.kind, 'location');
  assert.equal(run('咳嗽', {}, { interactive: true }).question.meta, undefined);
});
test('child gets pediatric department instead of adult internal medicine', () => {
  assert.equal(run('孩子咳嗽', { ...complete, age: 'child' }).department, 'pediatrics');
});
test('infant and contradictory ages refer to human assessment', () => {
  assert.equal(run('宝宝咳嗽', { ...complete, age: 'infant' }).status, 'human');
  assert.equal(run('8岁孩子咳嗽', complete).status, 'human');
  assert.equal(run('6个月宝宝咳嗽', { ...complete, age: 'child' }).status, 'human');
});
test('pregnancy and medication requests refer to humans', () => {
  assert.equal(run('怀孕后胃痛').status, 'human');
  assert.equal(run('咳嗽吃什么药').status, 'human');
});
test('unknown risk or severity refers to humans', () => {
  assert.equal(run('咳嗽', { ...complete, risk: 'unknown' }).status, 'human');
  assert.equal(run('咳嗽', { ...complete, severity: 'unknown' }).status, 'human');
});
test('no knowledge and tied adult departments do not force a recommendation', () => {
  assert.equal(run('说不清哪里不舒服').status, 'human');
  assert.equal(run('头痛，还有胃痛').status, 'human');
});
test('result cites only configured sources and avoids diagnosis', () => {
  const result = run('皮肤瘙痒');
  assert.equal(result.department, 'dermatology');
  assert.deepEqual(result.sources, ['DEMO-DEPTS', 'DEMO-TRIAGE']);
  assert.match(result.reason, /不是疾病诊断/);
});
test('normalization cannot override an emergency', () => {
  const result = triage(validateInput({ chief: '严重胸痛', answers: complete }), ['咳嗽']);
  assert.equal(result.status, 'emergency');
});

test('breathing phrase is not split as a contrast conjunction', () => {
  assert.equal(mentions('脑袋疼，喘不过气', '喘不过气'), true);
  assert.equal(run('脑袋疼，喘不过气').status, 'emergency');
  assert.equal(run('没有喘不过气，只有咳嗽').department, 'respiratory');
  assert.equal(run('没有胸痛，不过呼吸困难').status, 'emergency');
});

test('juxtaposed negated lists and prospective or historical mentions are not current symptoms', () => {
  assert.equal(mentions('也没有尿频尿急', '尿急'), false);
  assert.equal(mentions('没有发热、咳嗽、咳痰', '咳痰'), false);
  assert.equal(mentions('我这病估计以后会发展成耳聋耳鸣', '耳鸣'), false);
  assert.equal(mentions('去年得过肺炎咳嗽好久', '咳嗽'), false);
  assert.equal(mentions('今天咳嗽加重了', '咳嗽'), true);
  assert.equal(run('也没有尿频尿急，哪儿都没毛病').status, 'human');
  assert.equal(run('我这病估计以后会耳聋耳鸣').status, 'human');
  assert.equal(evidenceSupported('之前拉肚子，今天已经好了', '之前拉肚子'), false);
  assert.equal(evidenceSupported('胸口有点闷，不喘', '不喘'), false);
  assert.equal(evidenceSupported('我估计关节又该疼了', '关节又该疼了'), false);
  assert.equal(evidenceSupported('我爸心脏病住院了，我自己没啥事', '我爸心脏病住院'), false);
  assert.equal(evidenceSupported('拉肚子两天，恶心', '拉肚子'), true);
  assert.equal(evidenceSupported('我有点咳嗽', '咳嗽'), true);
});
