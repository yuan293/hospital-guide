import { performance } from 'node:perf_hooks';
import { runTriage } from './flow.js';
import { validateInput, questions } from './triage.js';
import { probes } from '../data/hospital.js';

const MODES = ['rules', 'model', 'workflow', 'dynamic'];
// 单条案例的交互轮次上限：安全槽 3 + 安全确认 3 + 定位/鉴别追问 3，留出余量。
const MAX_TURNS = 14;
// 各评测模式对应的策略：rules 固定 legacy 作为消融基线；其余使用动态追问策略。
const MODE_OPTIONS = {
  rules: { policy: 'legacy', interactive: false, loop: false, useModel: false },
  model: { policy: 'dynamic', interactive: false, loop: false, useModel: true },
  workflow: { policy: 'dynamic', interactive: true, loop: true, useModel: true },
  dynamic: { policy: 'dynamic', interactive: true, loop: true, useModel: false },
};
// 单个预期结局的 fail-closed 校验，返回 null 或错误信息。
function validateOutcome(e, rowId, departments, questionIds) {
  if (!e || !['recommendation', 'emergency', 'human', 'question', 'uncertain'].includes(e.status)) return rowId + ': 预期状态无效';
  if (['recommendation', 'emergency'].includes(e.status) && !departments.some(d => d.id === e.department)) return rowId + ': 预期科室不存在';
  if (e.status === 'emergency' && e.department !== 'emergency') return rowId + ': 急诊科室错误';
  if (['human', 'question', 'uncertain'].includes(e.status) && e.department !== null) return rowId + ': 预期科室应为 null';
  if (e.status === 'question' && !questionIds.has(e.question)) return rowId + ': 预期追问无效';
  if (e.reasonCode !== undefined && typeof e.reasonCode !== 'string') return rowId + ': 预期原因码无效';
  return null;
}
export function validateDataset(dataset, departments) {
  if (dataset?.schemaVersion !== 1 || !dataset.id || !dataset.version || !Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error('评测集结构无效');
  const questionIds = new Set([...Object.keys(questions), ...probes.map(p => p.id)]);
  const ids = new Set();
  for (const row of dataset.cases) {
    if (!row.id || ids.has(row.id)) throw new Error('案例 ID 缺失或重复');
    ids.add(row.id);
    if (!['regression', 'challenge'].includes(row.suite) || !row.category) throw new Error(row.id + ': 分类无效');
    if (row.modes !== undefined && (!Array.isArray(row.modes) || row.modes.some(m => !MODES.includes(m)))) throw new Error(row.id + ': modes 取值无效');
    validateInput(row.input);
    if (row.input.model) throw new Error(row.id + ': 案例不能预设模型');
    const e = row.expected;
    const err = validateOutcome(e, row.id, departments, questionIds);
    if (err) throw new Error(err);
    // anyOf：同一条案例存在多个等价的“安全结局”（典型：模型老实返回空→转人工，
    // 或模型脑补但证据全部失验→弃权）。fail-closed：只允许 human/uncertain 两类
    // 非推荐升级结局，且科室必须为 null；不得用它把错误推荐判为通过。
    if (e.anyOf !== undefined) {
      if (!Array.isArray(e.anyOf) || e.anyOf.length < 2) throw new Error(row.id + ': anyOf 至少需要两个等价结局');
      for (const alt of e.anyOf) {
        const altErr = validateOutcome(alt, row.id, departments, questionIds);
        if (altErr) throw new Error(altErr);
        if (!['human', 'uncertain'].includes(alt.status) || alt.department !== null) throw new Error(row.id + ': anyOf 只允许 human/uncertain 且科室为 null 的安全结局');
      }
      const covered = e.anyOf.some(alt => outcomeMatches(e, alt));
      if (!covered) throw new Error(row.id + ': 主预期必须被 anyOf 覆盖');
    }
  }
  return dataset;
}

// 实际结果是否匹配某个预期结局：状态、科室一致；question 还要追问 id 一致；
// 显式给出的 reasonCode 必须一致（未给原因码的结局不校验原因码）。
function outcomeMatches(actual, exp) {
  return actual.status === exp.status
    && actual.department === exp.department
    && (exp.status !== 'question' || actual.question === exp.question)
    && (exp.reasonCode === undefined || actual.reasonCode === exp.reasonCode);
}

function applicable(row, mode) {
  return !row.modes || row.modes.includes(mode);
}

export async function evaluateCase(row, mode, model, runner = runTriage) {
  const config = MODE_OPTIONS[mode];
  if (!config) throw new Error('未知评测模式: ' + mode);
  if (!applicable(row, mode)) {
    return { id: row.id, suite: row.suite, category: row.category, chief: row.input.chief, skipped: true,
      expected: row.expected, actual: { status: 'skipped', department: null, question: null, reasonCode: null },
      pass: true, error: null, elapsedMs: 0, modelAttempts: 0, modelSuccesses: 0, modelFailures: 0, trace: [] };
  }
  const started = performance.now();
  const trace = [];
  const answers = config.loop ? {} : { ...row.input.answers };
  const modelName = config.useModel ? model : '';
  let result;
  let error = null;
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      result = await runner({ chief: row.input.chief, answers: { ...answers }, model: modelName }, { policy: config.policy, interactive: config.interactive });
      trace.push({ status: result.status, department: result.department ?? null, question: result.question?.id ?? null,
        gain: result.question?.meta?.gain ?? null, leaders: result.question?.meta?.leaders ?? null,
        reasonCode: result.reasonCode ?? null, model: result.model });
      if (!config.loop || result.status !== 'question') break;
      const key = result.question.id;
      if (answers[key] !== undefined) throw new Error('流程重复追问已回答问题');
      if (row.input.answers[key] === undefined) break;
      answers[key] = row.input.answers[key];
      if (turn === MAX_TURNS - 1) throw new Error('流程未在限定轮次内结束');
    }
  } catch (e) { error = e.message; }
  const actual = { status: error ? 'error' : result?.status ?? 'error', department: result?.department ?? null, question: result?.question?.id ?? null, reasonCode: result?.reasonCode ?? null };
  const expected = row.expected;
  const acceptedOutcomes = expected.anyOf ? [expected, ...expected.anyOf] : [expected];
  const pass = !error && acceptedOutcomes.some(exp => outcomeMatches(actual, exp));
  return { id: row.id, suite: row.suite, category: row.category, chief: row.input.chief, skipped: false,
    expected, actual, pass, error, labelNote: row.labelNote ?? null, elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    modelAttempts: trace.filter(t => t.model?.attempted).length,
    modelSuccesses: trace.filter(t => t.model?.used).length,
    modelFailures: trace.filter(t => t.model?.attempted && !t.model.used).length,
    turns: trace.length,
    trace };
}
const ratio = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
export function summarize(rows) {
  const evaluated = rows.filter(r => !r.skipped);
  const count = fn => evaluated.filter(fn).length;
  const latency = evaluated.map(r => r.elapsedMs).sort((a, b) => a - b);
  const n = evaluated.length;
  return {
    total: n, passed: count(r => r.pass), skipped: rows.length - n,
    exactMatch: ratio(count(r => r.pass), n),
    departmentAccuracy: ratio(count(r => r.expected.status === 'recommendation' && r.actual.status === 'recommendation' && r.actual.department === r.expected.department), count(r => r.expected.status === 'recommendation')),
    emergencyRecall: ratio(count(r => r.expected.status === 'emergency' && r.actual.status === 'emergency'), count(r => r.expected.status === 'emergency')),
    emergencyMisses: count(r => r.expected.status === 'emergency' && r.actual.status !== 'emergency'),
    falseEmergencyRate: ratio(count(r => r.expected.status !== 'emergency' && r.actual.status === 'emergency'), count(r => r.expected.status !== 'emergency')),
    humanTransferRate: ratio(count(r => r.actual.status === 'human'), n),
    humanRecall: ratio(count(r => r.expected.status === 'human' && r.actual.status === 'human'), count(r => r.expected.status === 'human')),
    abstentionRate: ratio(count(r => r.actual.status === 'uncertain'), n),
    conflictRate: ratio(count(r => r.actual.status === 'uncertain' && r.actual.reasonCode === 'model_conflict'), n),
    evidenceInvalidRate: ratio(count(r => r.actual.status === 'uncertain' && r.actual.reasonCode === 'evidence_invalid'), n),
    avgTurns: n ? Math.round(evaluated.reduce((s, r) => s + r.turns, 0) / n * 100) / 100 : null,
    modelAttempts: evaluated.reduce((s, r) => s + r.modelAttempts, 0),
    modelSuccesses: evaluated.reduce((s, r) => s + r.modelSuccesses, 0),
    modelFailures: evaluated.reduce((s, r) => s + r.modelFailures, 0),
    errors: count(r => r.error),
    meanMs: n ? Math.round(evaluated.reduce((s, r) => s + r.elapsedMs, 0) / n) : null,
    p95Ms: n ? Math.round(latency[Math.ceil(n * .95) - 1]) : null,
    categories: [...new Set(evaluated.map(r => r.category))].map(category => ({ category, passed: count(r => r.category === category && r.pass), total: count(r => r.category === category) })),
    failedIds: evaluated.filter(r => !r.pass).map(r => r.id),
  };
}
