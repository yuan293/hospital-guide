import { triage, validateInput } from './triage.js';
import { normalize } from './model.js';
import { departments } from '../data/hospital.js';

const deptName = id => departments.find(d => d.id === id)?.name || id;

function abstain(first, reasonCode, reason, evidence, model) {
  return { ...first, status: 'uncertain', title: '暂不自动推荐，建议人工复核', department: null, reasonCode, reason, evidence, next: '请向现场导诊台描述完整情况，由医护人员协助判断。不适持续、加重或出现新情况时请立即就医。', model };
}

// The HTTP API and evaluation runner use this exact flow; no session storage.
// 追问阶段不调用模型；追问后显式弃权也不调模型。只有规则流程一次性走到终态
// （具体推荐 / 零匹配等救援）时，模型才在最终决策前参与一次，且必须接受分歧
// 检测与原文证据核验。
export async function runTriage(value, { normalizer = normalize, policy = 'dynamic', interactive = true } = {}) {
  const input = validateInput(value);
  const first = triage(input, [], { interactive, policy });
  // 追问后已经显式弃权（ambiguous/unlocated）时不再调模型：用户已回答过鉴别/定位
  // 问题仍无法判定，模型不能替用户翻案；模型只在推荐分歧或一次性证据不足时介入。
  const eligible = input.model && input.answers.risk === 'no'
    && ['adult', 'child'].includes(input.answers.age)
    && (first.status === 'recommendation'
      || first.status === 'human' && ['unmatched', 'ambiguous'].includes(first.reasonCode));
  if (!eligible) return first;
  const started = performance.now();
  try {
    const { matches, rawCount } = await normalizer(input.chief, input.model);
    const elapsedMs = Math.round(performance.now() - started);
    const modelInfo = { used: true, attempted: true, name: input.model, matches, elapsedMs,
      note: input.model + ' 已参与症状标准化；风险分流仍由规则处理。' };
    const waitingRescue = first.status !== 'recommendation';
    // 模型有自报输出但证据全部未通过核验：规则又在等待救援，此时弃权而非硬凑结论。
    if (rawCount > 0 && matches.length === 0 && waitingRescue) {
      return abstain(first, 'evidence_invalid', '本地模型给出的症状线索未通过原文核验，系统不据此分诊。', [
        `本地模型自报 ${rawCount} 条症状，通过词表与原文连续片段核验的为 0 条`,
        '未核验线索可能来自推断或改写，不能作为分诊依据，转由人工导诊判断。',
      ], modelInfo);
    }
    const modelKeywords = [...new Set(matches.map(m => m.keyword))];
    const second = triage(input, modelKeywords, { interactive: false, policy });
    // 规则与模型各自收敛到不同的具体科室：不选择任一结论，显式弃权。
    if (first.status === 'recommendation' && second.status === 'recommendation' && first.department !== second.department) {
      return abstain(first, 'model_conflict', '规则流程与本地模型倾向不同科室，系统不替代人工选择。', [
        ...first.evidence,
        `规则流程倾向：${deptName(first.department)}`,
        `本地模型核验证据（${matches.map(m => m.keyword).join('、') || '无'}）倾向：${deptName(second.department)}`,
        '两条证据链给出不一致的具体科室，继续自动推荐可能误导就诊。',
      ], modelInfo);
    }
    if (second.status === 'recommendation') {
      second.model = modelInfo;
      return second;
    }
    // 模型证据未能形成兼容的具体科室：不翻转规则结论，仅留痕。
    first.model = { ...modelInfo, note: modelInfo.note + ' 模型证据未形成更可靠结论，保留规则分流结果。' };
    return first;
  } catch {
    first.model = { used: false, attempted: true, name: input.model,
      elapsedMs: Math.round(performance.now() - started),
      note: '本地模型不可用或响应超时，已使用规则模式继续。' };
    return first;
  }
}
