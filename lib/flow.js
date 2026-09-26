import { triage, validateInput } from './triage.js';
import { normalize } from './model.js';
import { departments, probes } from '../data/hospital.js';

const deptName = id => departments.find(d => d.id === id)?.name || id;
// 规则一条症状词都没识别出来时，流程会追问的“不适部位”问题；模型入口介入
// 就发生在这一步之前。
const LOCATION_PROBE_ID = probes.find(p => p.kind === 'location')?.id;

function abstain(first, reasonCode, reason, evidence, model) {
  return { ...first, status: 'uncertain', title: '暂不自动推荐，建议人工复核', department: null, reasonCode, reason, evidence, next: '请向现场导诊台描述完整情况，由医护人员协助判断。不适持续、加重或出现新情况时请立即就医。', model };
}

// The HTTP API and evaluation runner use this exact flow; no session storage.
// 模型只在两个位置介入，且都必须接受原文证据核验：
//   1) 入口介入：规则完全没有识别出症状、正要追问“不适部位”时，先让模型把口语
//      主诉标准化。命中核验证据就继续走同一套评分/追问/弃权流程（通常直接得到
//      科室方向，少问一轮)；没有命中证据就照旧追问部位，行为与无模型时一致。
//   2) 终态介入：规则一次性走到终态（具体推荐 / 零匹配等救援）时参与一次。
// 追问后已经显式弃权（ambiguous/unlocated）时不再调模型：用户已回答过鉴别/定位
// 问题仍无法判定，模型不能替用户翻案。
export async function runTriage(value, { normalizer = normalize, policy = 'dynamic', interactive = true } = {}) {
  const input = validateInput(value);
  const first = triage(input, [], { interactive, policy });
  // 入口介入需要同样的安全前提：已确认没有紧急表现、年龄段在自动推荐范围内，
  // 也就是说它永远排在风险闸门与安全槽之后。
  const atEntry = interactive && first.status === 'question' && first.question?.id === LOCATION_PROBE_ID;
  const eligible = input.model && input.answers.risk === 'no'
    && ['adult', 'child'].includes(input.answers.age)
    && (atEntry
      || first.status === 'recommendation'
      || first.status === 'human' && ['unmatched', 'ambiguous'].includes(first.reasonCode));
  if (!eligible) return first;
  const started = performance.now();
  try {
    const { matches, rawCount } = await normalizer(input.chief, input.model);
    const elapsedMs = Math.round(performance.now() - started);
    const modelInfo = { used: true, attempted: true, name: input.model, matches, elapsedMs,
      phase: atEntry ? 'entry' : 'terminal',
      note: input.model + ' 已参与症状标准化；风险分流仍由规则处理。' };
    const modelKeywords = [...new Set(matches.map(m => m.keyword))];
    // 入口介入没有拿到可用证据时，退回无模型时的原有行为：照旧追问不适部位。
    // 这里不沿用“证据失效即弃权”的判定，因为规则流程本身还有一条可走的路。
    if (atEntry && modelKeywords.length === 0) {
      first.model = { ...modelInfo, used: false, outcome: 'no_evidence',
        note: '本地模型没有给出通过核验的症状线索，继续按规则询问不适部位。' };
      return first;
    }
    const waitingRescue = first.status !== 'recommendation';
    // 模型有自报输出但证据全部未通过核验：规则又在等待救援，此时弃权而非硬凑结论。
    if (rawCount > 0 && matches.length === 0 && waitingRescue) {
      return abstain(first, 'evidence_invalid', '本地模型给出的症状线索未通过原文核验，系统不据此分诊。', [
        `本地模型自报 ${rawCount} 条症状，通过词表与原文连续片段核验的为 0 条`,
        '未核验线索可能来自推断或改写，不能作为分诊依据，转由人工导诊判断。',
      ], modelInfo);
    }
    // 入口介入发生在会话中途，允许继续追问；终态介入保持一次性判定（旧行为）。
    const second = triage(input, modelKeywords, { interactive: atEntry ? interactive : false, policy });
    // 入口介入只有在模型证据能给出科室方向或更具体的追问时才采纳，否则回退到部位
    // 问题：一次没有结论的模型调用不应该变成对用户的弃权。
    if (atEntry && !['recommendation', 'question'].includes(second.status)) {
      first.model = { ...modelInfo, note: modelInfo.note + ' 模型证据未形成更可靠的结论，继续按规则询问不适部位。' };
      return first;
    }
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
    // 入口介入时 second 只可能是追问：模型证据已把范围收窄，改问区分度最高的问题。
    if (atEntry) {
      second.model = modelInfo;
      return second;
    }
    // 模型证据未能形成兼容的具体科室：不翻转规则结论，仅留痕。
    first.model = { ...modelInfo, note: modelInfo.note + ' 模型证据未形成更可靠结论，保留规则分流结果。' };
    return first;
  } catch {
    first.model = { used: false, attempted: true, failed: true, name: input.model,
      elapsedMs: Math.round(performance.now() - started),
      phase: atEntry ? 'entry' : 'terminal',
      note: '本地模型不可用或响应超时，已使用规则模式继续。' };
    return first;
  }
}
