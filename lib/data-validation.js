const FHIR_EXT_BASE = 'https://github.com/yuan293/hospital-guide/blob/main/StructureDefinition';
// location/differential 用于科室分诊；redflag 为安全确认里的红旗征筛查（可升级处理），
// 不参与平局时的信息增益选择。
const PROBE_KINDS = ['location', 'differential', 'redflag'];
const ESCALATE_TARGETS = ['emergency', 'human'];
const text = v => typeof v === 'string' && v.trim().length > 0;
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const safeId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]+$/.test(v);

function getExt(item, url) { return item?.extension?.find(e => e.url === url); }
function getExtStr(item, url) { return getExt(item, url)?.valueString; }
function getExtCode(item, url) { return getExt(item, url)?.valueCode; }
function getExts(item, url) { return (item?.extension || []).filter(e => e.url === url); }

export function probesFromQuestionnaire(q) {
  if (!q?.item) return [];
  return q.item.map(item => {
    const kind = getExtCode(item, `${FHIR_EXT_BASE}/probe-kind`);
    const description = getExtStr(item, `${FHIR_EXT_BASE}/probe-description`);
    const pathway = getExtStr(item, `${FHIR_EXT_BASE}/probe-pathway`);
    const order = getExt(item, `${FHIR_EXT_BASE}/probe-order`)?.valueInteger;
    const sourceExts = getExts(item, `${FHIR_EXT_BASE}/probe-source`);
    const sourceIds = sourceExts.map(e => e.valueString).filter(Boolean);
    const options = (item.answerOption || []).map(opt => {
      return [opt.valueCoding?.code, opt.valueCoding?.display];
    });
    const weights = {};
    const escalate = {};
    const narrative = {};
    for (const opt of (item.answerOption || [])) {
      const code = opt.valueCoding?.code;
      if (!code) continue;
      const weightExt = getExt(opt, `${FHIR_EXT_BASE}/option-weights`);
      const w = {};
      for (const sub of weightExt?.extension || []) {
        const parts = sub.url.split('/');
        const deptId = parts[parts.length - 1];
        w[deptId] = sub.valueInteger;
      }
      weights[code] = w;
      // 红旗征选项的升级目标与路径选项的现病史叙述，都只在新问题类型上出现。
      const escalateTo = getExtCode(opt, `${FHIR_EXT_BASE}/option-escalate`);
      if (escalateTo) escalate[code] = escalateTo;
      const narrativeText = getExtStr(opt, `${FHIR_EXT_BASE}/option-narrative`);
      if (narrativeText) narrative[code] = narrativeText;
    }
    const requireAny = getExts(item, `${FHIR_EXT_BASE}/probe-require-any`).map(e => e.valueString).filter(Boolean);
    const pairs = [];
    for (const pairExt of getExts(item, `${FHIR_EXT_BASE}/probe-pair`)) {
      const a = pairExt.extension?.find(e => e.url === `${FHIR_EXT_BASE}/pair-dept-a`)?.valueCode;
      const b = pairExt.extension?.find(e => e.url === `${FHIR_EXT_BASE}/pair-dept-b`)?.valueCode;
      if (a && b) pairs.push([a, b]);
    }
    const result = {
      id: item.linkId,
      title: item.text,
      description,
      kind,
      options,
      weights,
      requireAny,
      pairs,
    };
    if (sourceIds.length > 0) result.sourceIds = sourceIds;
    if (pathway) result.pathway = pathway;
    if (order !== undefined) result.order = order;
    if (Object.keys(escalate).length > 0) result.escalate = escalate;
    if (Object.keys(narrative).length > 0) result.narrative = narrative;
    return result;
  });
}

// 安全确认路径定义：路径 id、标题与激活锚点。锚点是主诉中的口语/部位词，
// 不要求与科室关键词一致（例如“上腹”“剑突下”本身不指向任何配置科室）。
export function pathwaysFromQuestionnaire(q) {
  return getExts(q, `${FHIR_EXT_BASE}/probe-pathway-definition`).map(ext => ({
    id: ext.extension?.find(e => e.url === `${FHIR_EXT_BASE}/pathway-id`)?.valueCode,
    title: ext.extension?.find(e => e.url === `${FHIR_EXT_BASE}/pathway-title`)?.valueString,
    anchors: (ext.extension || [])
      .filter(e => e.url === `${FHIR_EXT_BASE}/pathway-anchor`)
      .map(e => e.valueString)
      .filter(Boolean),
  }));
}

export function validateHospitalData(data, sources) {
  const errors = [];
  const require = (ok, message) => { if (!ok) errors.push(message); };
  require(data?.schemaVersion === 1, 'schemaVersion 必须为 1');
  for (const key of ['name', 'version', 'notice']) require(text(data?.hospital?.[key]), 'hospital.' + key + ' 不能为空');
  require(date(data?.hospital?.updatedAt), 'hospital.updatedAt 必须为有效 YYYY-MM-DD 日期');
  require(['synthetic', 'authorized'].includes(data?.hospital?.dataType), 'hospital.dataType 必须为 synthetic 或 authorized');
  require(Array.isArray(sources) && sources.length > 0, '来源清单不能为空');
  const sourceIds = new Set();
  for (const [i, s] of (Array.isArray(sources) ? sources : []).entries()) {
    const prefix = 'sources[' + i + ']';
    require(safeId(s?.id) && !sourceIds.has(s?.id), prefix + '.id 无效或重复');
    sourceIds.add(s?.id);
    for (const key of ['title', 'kind', 'location', 'description', 'rights']) require(text(s?.[key]), prefix + '.' + key + ' 不能为空');
    require(date(s?.date), prefix + '.date 日期无效');
    require(['unreviewed', 'reviewed'].includes(s?.reviewStatus), prefix + '.reviewStatus 无效');
  }
  const refs = (ids, label) => {
    require(Array.isArray(ids) && ids.length > 0, label + ' 不能为空');
    for (const id of Array.isArray(ids) ? ids : []) require(sourceIds.has(id), label + ' 引用了不存在的来源: ' + id);
  };
  refs(data?.hospital?.sourceIds, 'hospital.sourceIds');
  refs(data?.ruleSourceIds, 'ruleSourceIds');
  const departments = Array.isArray(data?.departments) ? data.departments : [];
  require(departments.length > 0, 'departments 不能为空');
  const ids = new Set();
  for (const [i, d] of departments.entries()) {
    const prefix = 'departments[' + i + ']';
    require(safeId(d?.id) && !ids.has(d?.id), prefix + '.id 无效或重复');
    ids.add(d?.id);
    for (const key of ['name', 'floor', 'room', 'zone', 'group', 'summary']) require(text(d?.[key]), prefix + '.' + key + ' 不能为空');
    require(Array.isArray(d?.keywords) && d.keywords.length > 0 && d.keywords.every(text), prefix + '.keywords 必须是非空词语数组');
    if (Array.isArray(d?.keywords)) require(new Set(d.keywords).size === d.keywords.length, prefix + '.keywords 存在重复词');
    require(['adult', 'child', 'all'].includes(d?.age), prefix + '.age 无效');
    const range = d?.ageRangeMonths;
    require(Number.isInteger(range?.min) && range.min >= 0 && (range.max === null || Number.isInteger(range.max) && range.max >= range.min), prefix + '.ageRangeMonths 月龄范围无效');
    const expected = { adult: [216, null], child: [12, 215], all: [0, null] }[d?.age];
    require(expected && range?.min === expected[0] && range?.max === expected[1], prefix + '.ageRangeMonths 必须与现有年龄选项一致');
    refs(d?.sourceIds, prefix + '.sourceIds');
  }
  for (const [id, age] of [['emergency', 'all'], ['pediatrics', 'child'], ['general', 'adult']]) {
    require(departments.some(d => d?.id === id && d.age === age), '缺少系统保留科室或年龄错误: ' + id);
  }
  const departmentKeywords = new Set(departments.flatMap(d => Array.isArray(d?.keywords) ? d.keywords : []));

  // FHIR Questionnaire 结构校验
  const q = data?.questionnaire;
  require(q?.resourceType === 'Questionnaire', 'questionnaire.resourceType 必须是 Questionnaire');
  require(text(q?.url), 'questionnaire.url 不能为空');
  require(text(q?.version), 'questionnaire.version 不能为空');
  require(['draft', 'active', 'retired', 'unknown'].includes(q?.status), 'questionnaire.status 无效');
  require(Array.isArray(q?.item) && q.item.length > 0, 'questionnaire.item 不能为空数组');

  const qItemIds = new Set();
  for (const [i, item] of (Array.isArray(q?.item) ? q.item : []).entries()) {
    const prefix = 'questionnaire.item[' + i + ']';
    require(safeId(item?.linkId) && !qItemIds.has(item.linkId), prefix + '.linkId 无效或重复: ' + item?.linkId);
    qItemIds.add(item.linkId);
    require(text(item?.text), prefix + '.text 不能为空');
    require(item?.type === 'choice', prefix + '.type 必须是 choice');
    require(Array.isArray(item?.answerOption), prefix + '.answerOption 必须是数组');
    const optIds = new Set();
    for (const [j, opt] of (item.answerOption || []).entries()) {
      const op = prefix + '.answerOption[' + j + ']';
      require(text(opt?.valueCoding?.code), op + '.valueCoding.code 不能为空');
      require(!optIds.has(opt.valueCoding.code), op + ' valueCoding.code 重复: ' + opt.valueCoding.code);
      optIds.add(opt.valueCoding.code);
      require(text(opt?.valueCoding?.display), op + '.valueCoding.display 不能为空');
    }
    const kind = getExtCode(item, `${FHIR_EXT_BASE}/probe-kind`);
    require(PROBE_KINDS.includes(kind), prefix + ' 缺少有效的 probe-kind 扩展（' + PROBE_KINDS.join(' / ') + '）');
    const description = getExtStr(item, `${FHIR_EXT_BASE}/probe-description`);
    require(text(description), prefix + ' 缺少 probe-description 扩展');
  }

  const probes = probesFromQuestionnaire(q);
  require(probes.length > 0, '从 questionnaire 适配出的 probes 不能为空');

  // 安全确认路径定义：id 唯一、标题非空、激活锚点非空且不重复。
  const pathways = pathwaysFromQuestionnaire(q);
  const pathwayIds = new Set();
  for (const [i, pw] of pathways.entries()) {
    const prefix = 'pathways[' + i + ']';
    require(safeId(pw?.id) && !pathwayIds.has(pw?.id), prefix + '.id 无效或重复');
    pathwayIds.add(pw?.id);
    require(text(pw?.title), prefix + '.title 不能为空');
    const anchors = Array.isArray(pw?.anchors) ? pw.anchors : [];
    require(anchors.length > 0 && anchors.every(text), prefix + '.anchors 必须是非空锚点词数组');
    require(new Set(anchors).size === anchors.length, prefix + '.anchors 存在重复锚点');
  }
  const pathwayItemCount = new Map();
  const pathwayOrders = new Map();

  const probeIds = new Set();
  const locationProbes = [];
  for (const [i, p] of probes.entries()) {
    const prefix = 'probes[' + i + ']';
    require(safeId(p?.id) && !probeIds.has(p?.id), prefix + '.id 无效或重复');
    probeIds.add(p?.id);
    require(PROBE_KINDS.includes(p?.kind), prefix + '.kind 必须是 ' + PROBE_KINDS.join(' 或 '));
    if (p?.kind === 'location') locationProbes.push(p);
    for (const key of ['title', 'description']) require(text(p?.[key]), prefix + '.' + key + ' 不能为空');
    const options = Array.isArray(p?.options) ? p.options : [];
    require(options.length >= 2 && options.length <= 8, prefix + '.options 数量必须在 2 至 8 个之间');
    const optionIds = new Set();
    for (const opt of options) {
      require(Array.isArray(opt) && opt.length === 2 && safeId(opt[0]) && text(opt[1]), prefix + ' 存在无效选项');
      require(!optionIds.has(opt[0]), prefix + ' 选项 id 重复: ' + opt[0]);
      optionIds.add(opt[0]);
    }
    require(p?.weights && typeof p.weights === 'object' && !Array.isArray(p.weights), prefix + '.weights 必须是对象');
    for (const optId of optionIds) {
      const w = p.weights?.[optId];
      require(w && typeof w === 'object' && !Array.isArray(w), prefix + '.weights 缺少选项权重: ' + optId);
      for (const [deptId, value] of Object.entries(w)) {
        require(ids.has(deptId), prefix + '.weights 引用了不存在的科室: ' + deptId);
        require(Number.isInteger(value) && value >= 0 && value <= 5, prefix + '.weights 权重必须是 0 至 5 的整数');
      }
    }
    for (const key of Object.keys(p.weights || {})) require(optionIds.has(key), prefix + '.weights 存在未定义选项: ' + key);
    require(Array.isArray(p?.requireAny) && p.requireAny.every(k => text(k)), prefix + '.requireAny 必须是字符串数组');
    for (const keyword of p.requireAny || []) require(departmentKeywords.has(keyword), prefix + '.requireAny 引用了未配置的症状词: ' + keyword);
    require(Array.isArray(p?.pairs), prefix + '.pairs 必须是数组');
    for (const pair of p.pairs) {
      require(Array.isArray(pair) && pair.length === 2 && pair[0] !== pair[1], prefix + '.pairs 每项必须是两个不同科室');
      for (const deptId of pair) require(ids.has(deptId), prefix + '.pairs 引用了不存在的科室: ' + deptId);
    }
    refs(p?.sourceIds, prefix + '.sourceIds');
    if (p.kind === 'differential') {
      require((p.requireAny || []).length > 0, prefix + ' 鉴别问题必须配置 requireAny 锚点症状');
      require((p.pairs || []).length > 0, prefix + ' 鉴别问题必须配置至少一个 pairs 科室对');
      const spread = (pair, optId) => Math.abs((p.weights[optId]?.[pair[0]] || 0) - (p.weights[optId]?.[pair[1]] || 0));
      require(p.pairs.some(pair => [...optionIds].some(optId => spread(pair, optId) > 0)), prefix + ' 权重无法区分任何配置的科室对');
    } else if (p.kind === 'location') {
      require((p.requireAny || []).length === 0 && (p.pairs || []).length === 0, prefix + ' 定位问题不应配置 requireAny 或 pairs');
    } else {
      // redflag：必须归属某个已声明的安全确认路径，并按路径内顺序提问。
      require(pathwayIds.has(p?.pathway), prefix + ' 必须引用已声明的安全确认路径: ' + p?.pathway);
      require(Number.isInteger(p?.order) && p.order > 0, prefix + '.order 必须是正整数');
      require((p.requireAny || []).length === 0 && (p.pairs || []).length === 0, prefix + ' 安全确认问题不应配置 requireAny 或 pairs');
      if (pathwayIds.has(p?.pathway)) {
        pathwayItemCount.set(p.pathway, (pathwayItemCount.get(p.pathway) || 0) + 1);
        const orders = pathwayOrders.get(p.pathway) || new Set();
        require(!orders.has(p?.order), prefix + '.order 在同一路径内重复: ' + p?.order);
        orders.add(p?.order);
        pathwayOrders.set(p.pathway, orders);
      }
      // 升级提示与判断依据依赖每个选项的措辞；缺失会让提示语出现空洞。
      for (const optId of optionIds) require(text(p.narrative?.[optId]), prefix + '.narrative 缺少选项叙述: ' + optId);
      for (const [optId, target] of Object.entries(p.escalate || {})) {
        require(optionIds.has(optId), prefix + '.escalate 存在未定义选项: ' + optId);
        require(ESCALATE_TARGETS.includes(target), prefix + '.escalate 目标无效: ' + target);
      }
      if (p.kind === 'redflag') {
        require(Object.keys(p.escalate || {}).length > 0, prefix + ' 红旗征问题必须至少有一个升级选项');
        // 红旗征用于安全筛查，不参与科室评分，避免把危险征象当成科室证据。
        for (const optId of optionIds) require(Object.keys(p.weights?.[optId] || {}).length === 0, prefix + ' 红旗征选项不应配置科室权重: ' + optId);
      }
    }
  }
  for (const pw of pathways) {
    if (!pathwayIds.has(pw?.id)) continue;
    require((pathwayItemCount.get(pw.id) || 0) > 0, '安全确认路径没有任何问题项: ' + pw.id);
  }
  require(locationProbes.length === 1, '必须且只能配置一个 location 定位问题');
  const warnings = ['格式校验不代表医院授权、医学审核或临床有效性。'];
  if (data?.hospital?.dataType === 'synthetic') warnings.push('当前使用虚构示例医院。');
  if (Array.isArray(sources) && sources.some(s => s?.reviewStatus !== 'reviewed')) warnings.push('存在未经专业审核的来源。');
  return { valid: errors.length === 0, errors, warnings, departmentCount: departments.length, probeCount: probes.length, pathwayCount: pathways.length, sourceCount: Array.isArray(sources) ? sources.length : 0 };
}
