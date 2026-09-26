import { departments, hospital, ruleSourceIds, probes, pathways } from '../data/hospital.js';

// 信息补充阶段的安全槽：risk/age/severity 每轮必查，顺序固定。
// duration 仅保留给 legacy 消融策略与历史回答兼容，动态策略不再强制询问。
export const questions = {
  risk: { title: '目前是否有以下任一情况？', description: '呼吸困难、持续或明显胸痛、意识异常、突然肢体无力、严重出血，或不适迅速加重。', options: [['no', '均没有'], ['yes', '有上述情况'], ['unknown', '不确定']] },
  age: { title: '就诊者属于哪个年龄段？', description: '用于核对演示科室的接诊范围。', options: [['adult', '18岁及以上'], ['child', '1至17岁'], ['infant', '未满1岁']] },
  duration: { title: '这次不适大约持续了多久？', description: '只需选择最接近的时间。', options: [['short', '少于24小时'], ['days', '1至7天'], ['long', '超过7天'], ['unknown', '记不清']] },
  severity: { title: '不适对日常活动的影响如何？', description: '如果症状明显加重，请直接寻求现场医护帮助。', options: [['mild', '影响较小'], ['moderate', '影响日常活动'], ['severe', '严重或迅速加重'], ['unknown', '无法判断']] },
};

// 单个会话最多追问的鉴别问题数量；安全槽不计入此预算。
export const PROBE_BUDGET = 2;
// 单条安全确认路径最多追问的问题数量。安全确认是导诊流程里的安全检查
// （排除需要尽快处理的情况），与鉴别追问预算分开计算，否则会被信息增益问题挤掉。
export const SAFETY_BUDGET = 6;
const SYSTEM_DEPTS = new Set(['pediatrics', 'general', 'emergency']);
const probeById = new Map(probes.map(p => [p.id, p]));

const riskTerms = ['胸痛', '胸口痛', '呼吸困难', '喘不过气', '意识不清', '昏迷', '晕厥', '大出血', '吐血', '呕血', '便血', '黑便', '口角歪斜', '肢体无力', '说话不清', '突发剧烈头痛', '突然剧烈头痛', '视力突然下降', '突然看不见', '自杀', '自残', '吞药', '中毒', '窒息', '抽搐'];
const negation = /(?:没有|并无|否认|不伴|无|不是|未出现|已无|不再有|不)(?:明显|持续|任何|再)?\s*$/;
const history = /(?:以前|之前|曾经|去年|既往|过去|上次|小时候)/;
const current = /(?:现在|目前|今天|这次|正在|又出现|再次)/;
const family = /(?:家族史|父亲|母亲|爸爸|妈妈|我爸|我妈|我爷|我奶|爷爷|奶奶|外公|外婆|姥姥|姥爷|朋友|我哥|我姐|我弟|我妹)/;
// 前瞻/未然情态：出现在症状之前且无“现在/今天”等现症纠正时，按未发生处理。
const prospective = /(?:快要?|就要|即将|马上|以后|将来|未来|明天|后天|又该|估计|应该|预计|预估|恐怕|怕是|别是|莫非)/;
const leadingNegation = /^(?:没有|没|不|无|否认|并无|未|不是)/;
const leadingHistory = /^(?:以前|之前|曾经|去年|既往|过去|上次|小时候)/;
const leadingFamily = /^(?:我的?)?(?:爸|妈|父亲|母亲|爷爷|奶奶|外公|外婆|儿子|女儿|老公|老婆|丈夫|妻子|哥哥|弟弟|姐姐|妹妹|孩子|宝宝)/;
const clauseSplit = /[，。；！？\n,;!?]|但是|不过(?!气)|但/;
const resolvedAfter = /^(?:已经)?(?:消失|好了|已缓解|没有了)/;

// 症状词前后文是否支持“当前肯定存在”。规则关键词与模型证据共用这一个口径。
export function isAsserted(before, after) {
  if (negation.test(before) || resolvedAfter.test(after)) return false;
  // 否定清单：含“没有胸痛和呼吸困难”与连用的“也没有尿频尿急”，到分句/转折/肯定动词为止。
  if (/(?:没有|否认|并无|不伴|无)[^有是，。；！？\n]*$/.test(before)) return false;
  if (prospective.test(before) && !current.test(before)) return false;
  if (history.test(before) && !current.test(before)) return false;
  if (family.test(before)) return false;
  return true;
}

// Keep sentence context: negated, historical and prospective mentions cannot be treated as present symptoms.
export function mentions(text, term) {
  const clauses = text.split(clauseSplit).filter(Boolean);
  return clauses.some(clause => {
    let start = 0;
    while (true) {
      const i = clause.indexOf(term, start);
      if (i < 0) return false;
      const before = clause.slice(0, i);
      const after = clause.slice(i + term.length, i + term.length + 8);
      start = i + term.length;
      if (isAsserted(before, after)) return true;
    }
  });
}

// 模型证据核验：短原文片段除了必须连续出现在主诉中，其所处上下文还必须是
// “当前肯定存在”，防止“之前拉肚子”（病史）、“不喘”（否定）、“关节又该疼了”
// （未然）等片段被模型配给任意词表词后通过子串核验。
export function evidenceSupported(chief, evidence) {
  const clauses = chief.split(clauseSplit).filter(Boolean);
  return clauses.some(clause => {
    let start = 0;
    while (true) {
      const i = clause.indexOf(evidence, start);
      if (i < 0) return false;
      start = i + evidence.length;
      if (leadingNegation.test(evidence)) continue;
      // 证据直接以家属称谓开头（如“我爸心脏病住院”）描述的是他人症状。
      if (leadingFamily.test(evidence)) continue;
      // 短证据内部出现未然情态（如“关节又该疼了”“快咳嗽了”）按前瞻推断拒绝。
      if (/(?:快要?|就要?|即将|马上|以后|将来|未来|明天|后天|又该)/.test(evidence)) continue;
      const before = clause.slice(0, i) + (leadingHistory.test(evidence) ? '之前' : '');
      const after = clause.slice(i + evidence.length, i + evidence.length + 8);
      if (isAsserted(before, after)) return true;
    }
  });
}

// 纯关键词评分（不含鉴别问题权重），保留给外部对照与测试。
export function classify(text, extra = []) {
  return departments.filter(d => !SYSTEM_DEPTS.has(d.id)).map(d => {
    const matches = d.keywords.filter(k => mentions(text, k) || extra.includes(k));
    return { id: d.id, matches, score: matches.length };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score);
}

// 单一评分入口：关键词命中分（规则 + 模型标准化词）+ 已回答鉴别问题的配置权重。
// 安全槽、追问选择、模型前后对照都必须经过这里，禁止另立评分口径。
function scoreCandidates(chief, extra, answers) {
  const perDept = departments.filter(d => !SYSTEM_DEPTS.has(d.id)).map(d => {
    const matches = d.keywords.filter(k => mentions(chief, k) || extra.includes(k));
    return { id: d.id, matches, score: matches.length };
  });
  const matchedKeywords = new Set(perDept.flatMap(c => c.matches));
  for (const probe of probes) {
    const optionId = answers[probe.id];
    if (!optionId) continue;
    for (const [deptId, weight] of Object.entries(probe.weights[optionId] || {})) {
      const target = perDept.find(c => c.id === deptId);
      if (target) target.score += weight;
    }
  }
  const candidates = perDept.filter(c => c.score > 0).sort((a, b) => b.score - a.score);
  return { candidates, matchedKeywords };
}

// 在平局科室中选择信息增益最大的鉴别问题；不满足资格的问题一律不返回。
// 资格：未回答、未超预算、锚点症状已命中、领先集合被某个 pair 覆盖、存在非零权重差。
// 返回增益最大的鉴别问题及其分值：gain = 某个回答能在打平科室之间拉开的
// 最大权重差（信息增益的工程化代理值），leaders 为当前打平科室。
export function selectDifferential(leaders, matchedKeywords, answers) {
  const answeredCount = probes.filter(p => p.kind === 'differential' && answers[p.id] !== undefined).length;
  if (answeredCount >= PROBE_BUDGET) return null;
  let best = null;
  let bestGain = 0;
  for (const probe of probes) {
    if (probe.kind !== 'differential' || answers[probe.id] !== undefined) continue;
    if (!probe.requireAny.some(k => matchedKeywords.has(k))) continue;
    let gain = 0;
    for (const pair of probe.pairs) {
      if (!leaders.every(id => pair.includes(id))) continue;
      for (const [optionId] of probe.options) {
        const weights = pair.map(deptId => probe.weights[optionId]?.[deptId] || 0);
        gain = Math.max(gain, Math.abs(weights[0] - weights[1]));
      }
    }
    if (gain > bestGain) { bestGain = gain; best = probe; }
  }
  return best ? { probe: best, gain: bestGain, leaders: [...leaders] } : null;
}

// 安全确认选择：主诉命中路径锚点后，按配置顺序问完红旗征问题。
// 与鉴别追问不同，这些问题不由信息增益选择，也不参与平局消解——它们的目标是
// 在推荐科室之前排除需要尽快处理的情况，而不是提高某一次平局的区分度。
export function selectSafetyScreen(chief, answers) {
  for (const pathway of pathways) {
    if (!pathway.anchors.some(anchor => mentions(chief, anchor))) continue;
    const items = probes.filter(p => p.pathway === pathway.id).sort((a, b) => a.order - b.order);
    const answered = items.filter(p => answers[p.id] !== undefined).length;
    if (answered >= SAFETY_BUDGET) return null;
    const next = items.find(p => answers[p.id] === undefined);
    if (!next) return null;
    return { probe: next, pathway, index: answered + 1, total: Math.min(items.length, SAFETY_BUDGET) };
  }
  return null;
}

function base(input) {
  return { sources: [...new Set([...hospital.sourceIds, ...ruleSourceIds])], evidence: [], slots: { chief: input.chief, ...input.answers }, model: { used: false } };
}

function human(input, reason, reasonCode = 'safety') {
  return { ...base(input), status: 'human', title: '请让现场导诊人员协助判断', reason, reasonCode, department: null, evidence: [reason], next: '出示这段症状描述，请现场导诊台或医护人员协助。如果不适严重或快速加重，请立即就医。' };
}

// 存疑弃权：系统存在证据但置信不足或结论冲突，不替用户在不确定中做选择。
function uncertain(input, reasonCode, reason, evidence, candidates = []) {
  return { ...base(input), status: 'uncertain', title: '暂不自动推荐，建议人工复核', reason, reasonCode, department: null, evidence: evidence.length ? evidence : [reason], candidates: candidates.map(c => c.id), next: '请向现场导诊台描述完整情况，由医护人员协助判断。不适持续、加重或出现新情况时请立即就医。' };
}

function questionResult(input, spec, meta) {
  return { ...base(input), status: 'question', question: { id: spec.id, kind: spec.kind || 'slot', title: spec.title, description: spec.description, options: spec.options, ...(meta ? { meta } : {}) } };
}

function recommend(input, candidates, targetId, answers) {
  const dept = departments.find(d => d.id === targetId);
  if (!dept || ![answers.age, 'all'].includes(dept.age)) return human(input, '所选年龄不在匹配科室的演示接诊范围内。');
  const answeredProbes = probes.filter(p => answers[p.id] !== undefined);
  const probeEvidence = answeredProbes.flatMap(probe => {
    const optionId = answers[probe.id];
    const weight = probe.weights[optionId]?.[dept.id];
    if (!weight) return [];
    const label = probe.options.find(([id]) => id === optionId)?.[1] || optionId;
    const scope = probe.kind === 'pathway' ? '路径问诊' : '鉴别追问';
    return [`${scope}「${probe.title}」回答“${label}”，${dept.name}证据 +${weight}`];
  });
  // 已完成并且全部为阴性的红旗征筛查要显式写进依据：这是安全性说明，
  // 让用户知道系统确实问过这些危险征象，而不是没问就给了建议。
  const screenedFlags = probes.filter(p => p.kind === 'redflag' && answers[p.id] !== undefined);
  return { ...base(input), sources: [...new Set([...dept.sourceIds, ...answeredProbes.flatMap(p => p.sourceIds), ...ruleSourceIds])], status: 'recommendation', title: `可先向${dept.name}咨询`, department: dept.id, candidates: candidates.map(c => c.id), evidence: [
    `已记录：${[...new Set(candidates.flatMap(c => c.matches))].join('、')}`,
    ...probeEvidence,
    ...(screenedFlags.length ? [`已完成 ${screenedFlags.length} 项红旗征筛查，均未提示需要立即处理`] : []),
    answers.age === 'child' ? '所选年龄为1至17岁，匹配演示儿科接诊范围' : `匹配${dept.name}的演示症状条目`,
    '你回答目前没有列表中的紧急表现；该回答不能排除其他风险',
  ], reason: '这是基于示例规则的就诊分流参考，不是疾病诊断，也不代表已排除急症。', next: '请先向现场导诊台核实科室安排。症状持续、加重或出现新情况时，应及时寻求医护帮助。' };
}

export function validateInput(value) {
  if (!value || typeof value.chief !== 'string' || value.chief.trim().length < 2 || value.chief.length > 1200) throw new Error('请填写2至1200字的不适描述。');
  if (value.answers !== undefined && (!value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers))) throw new Error('回答格式不正确。');
  const answers = {};
  for (const [key, optionValue] of Object.entries(value.answers || {})) {
    const spec = questions[key] || probeById.get(key);
    if (!spec || !spec.options.some(([id]) => id === optionValue)) throw new Error('回答选项不正确，请重新开始。');
    answers[key] = optionValue;
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || value.model.length > 150 || !/^[a-zA-Z0-9_:./-]*$/.test(value.model))) throw new Error('模型名称无效。');
  return { chief: value.chief.trim(), answers, model: value.model || '' };
}

// options.policy: 'dynamic'（默认，安全槽后按信息增益追问）| 'legacy'（固定 duration/severity 追问，消融对照）
// options.interactive: true 时允许返回动态追问；false 时证据不足直接转人工（一次性评测/模型闸门判定）
export function triage(input, extra = [], options = {}) {
  const { interactive = false, policy = 'dynamic' } = options;
  const { chief, answers } = input;
  const risks = riskTerms.filter(term => mentions(chief, term));
  const severe = answers.severity === 'severe';
  // 阶段0：安全闸门，最高优先级，任何后续机制都不能覆盖。
  if (risks.length || answers.risk === 'yes' || severe) {
    return { ...base(input), status: 'emergency', title: '请优先寻求急诊帮助', department: 'emergency', evidence: risks.length ? risks.map(r => `描述中出现“${r}”`) : [severe ? '你选择了严重或迅速加重的不适' : '你报告了可能的紧急情况'], reason: '这类表现需要医护人员及时评估，系统停止普通科室推荐。', next: '在医院请立即联系现场医护；在中国大陆，如情况紧急请拨打120。不要继续等待在线导诊。' };
  }
  // 阶段0b：安全确认中的红旗征筛查。命中升级目标时与风险闸门同级，
  // 科室评分、平局追问与模型都不能覆盖它；模型也不会在这一轮被调用。
  const redFlags = probes.filter(p => p.kind === 'redflag' && answers[p.id] !== undefined);
  const escalated = redFlags.find(p => p.escalate?.[answers[p.id]] === 'emergency');
  if (escalated) {
    const label = escalated.options.find(([id]) => id === answers[escalated.id])?.[1] || answers[escalated.id];
    const narrative = escalated.narrative?.[answers[escalated.id]];
    return { ...base(input), sources: [...new Set([...(escalated.sourceIds || []), ...ruleSourceIds])], status: 'emergency', title: '请优先寻求急诊帮助', department: 'emergency', evidence: [`安全确认「${escalated.title}」回答“${label}”`, ...(narrative ? [`${narrative}（来自你的回答，不是系统推测）`] : [])], reason: '这类表现需要医护人员及时评估，系统停止普通科室推荐。', next: '在医院请立即联系现场医护；在中国大陆，如情况紧急请拨打120。不要继续等待在线导诊。' };
  }
  // 红旗征回答“不确定 / 说不清”时不能按阴性处理，转人工而不是继续推荐科室。
  const unresolvedFlag = redFlags.find(p => p.escalate?.[answers[p.id]] === 'human');
  if (unresolvedFlag) {
    const label = unresolvedFlag.options.find(([id]) => id === answers[unresolvedFlag.id])?.[1] || answers[unresolvedFlag.id];
    return human(input, `安全确认「${unresolvedFlag.title}」回答“${label}”，无法排除需要及时处理的征象，需由医护人员当面判断。`);
  }
  if (answers.risk === 'unknown') return human(input, '目前无法确认是否存在紧急情况，需要及时由医护人员判断。');
  if (/(?:怀孕|孕期|妊娠|产后|吃什么药|开药|停药|药量|药物剂量)/.test(chief)) return human(input, '涉及孕产期或用药问题，超出这一版导诊原型的处理范围。');
  if (answers.age === 'infant') return human(input, '未满1岁婴儿不在该演示流程的自动推荐范围内。');
  if (!answers.risk) return questionResult(input, { id: 'risk', ...questions.risk });
  if (!answers.age) return questionResult(input, { id: 'age', ...questions.age });
  if (/\d+\s*(?:岁|个月|月龄)/.test(chief)) {
    const years = chief.match(/(\d+)\s*岁/);
    const months = chief.match(/(\d+)\s*(?:个月|月龄)/);
    const inferred = months ? (+months[1] < 12 ? 'infant' : +months[1] < 216 ? 'child' : 'adult') : years ? (+years[1] < 1 ? 'infant' : +years[1] < 18 ? 'child' : 'adult') : null;
    if (inferred && inferred !== answers.age) return human(input, '症状描述中的年龄与所选年龄段不一致，请核实后重新导诊。');
  }
  if (policy === 'legacy' && !answers.duration) return questionResult(input, { id: 'duration', ...questions.duration });
  if (!answers.severity) return questionResult(input, { id: 'severity', ...questions.severity });
  if (answers.severity === 'unknown') return human(input, '目前无法判断不适的严重程度，需要现场导诊协助。');

  const { candidates, matchedKeywords } = scoreCandidates(chief, extra, answers);
  // 平局消解只看 location/differential；安全确认问的是危险征象，
  // 回答过它不代表已经尝试消解平局，因此不改变原有弃权判定。
  const answeredProbes = probes.filter(p => ['location', 'differential'].includes(p.kind) && answers[p.id] !== undefined);

  // 儿童统一进入儿科，与历史行为保持一致。
  if (answers.age === 'child') return recommend(input, candidates, 'pediatrics', answers);

  // 安全确认：命中路径锚点的主诉先问完红旗征，再进入科室决策。
  // 只在动态交互会话中追问；一次性评测（interactive=false）保持原有一次性判定。
  if (interactive && policy === 'dynamic') {
    const step = selectSafetyScreen(chief, answers);
    if (step) return questionResult(input, step.probe, { kind: step.probe.kind, pathway: step.pathway.id, pathwayTitle: step.pathway.title, order: step.probe.order, index: step.index, total: step.total });
  }

  if (!candidates.length) {
    const location = probes.find(p => p.kind === 'location');
    if (interactive && location && answers[location.id] === undefined) return questionResult(input, location, { kind: 'location', reason: 'no_candidate' });
    // 定位问题已经问过仍无法定位：不再猜科室，显式弃权。
    if (location && answers[location.id] !== undefined) {
      return uncertain(input, 'unlocated', '定位追问后仍无法匹配到具体科室，系统不做猜测。', [
        '已询问不适部位，但回答未能定位到可服务科室。',
        '继续自动推荐可能误导就诊，转由人工导诊判断。',
      ]);
    }
    return human(input, '当前描述没有匹配到已配置的症状，系统无法可靠推荐科室。', 'unmatched');
  }

  const topScore = candidates[0].score;
  const leaders = candidates.filter(c => c.score === topScore).map(c => c.id);
  if (leaders.length === 1) return recommend(input, candidates, leaders[0], answers);

  // 平局：交互模式先尝试信息增益鉴别问题；预算内无可用问题时，
  // 只要已触发过追问（含定位问题）仍平局就弃权，从未追问的平局保持转人工。
  if (interactive) {
    const choice = selectDifferential(leaders, matchedKeywords, answers);
    if (choice) return questionResult(input, choice.probe, { kind: 'differential', leaders: choice.leaders, gain: choice.gain });
    if (answeredProbes.length > 0) {
      return uncertain(input, 'ambiguous', '追问后仍有多个科室证据相同，系统不做猜测，转由人工导诊判断。', [
        `仍并列的科室：${leaders.map(id => departments.find(d => d.id === id)?.name || id).join('、')}`,
        '已完成当前可用的追问，继续自动推荐可能误导就诊。',
      ], candidates);
    }
  }
  return human(input, '症状同时涉及多个科室，当前证据不足以确定优先顺序。', 'ambiguous');
}
