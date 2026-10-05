// 词表与路由全景（0.9.9 新增）：把「一份锚点知识」在各层的登记状态摊开成可核对的视图。
//
// 动机：词表分散在三个地方——科室 keywords（字面）、packages/anchored-evidence-gate
// 的 REFERENCE_SYNONYMS（口语同义）、location 探针的 weights（部位路由）。三者
// 此前只在评测失败时才会被发现缺口（如 0.9.0/0.9.1 两次「换个说法就识别不出」）。
// 这里不改任何导诊逻辑，只做**只读盘点**，把下面三类结构性缺口暴露出来：
//
//   ① 单方向疼痛词：词表只登记了 X痛（或 X疼），另一方向靠形态锚点兜底。
//      形态锚点覆盖得了「腰疼↔腰痛」，但覆盖不了 X出血 的换说法（如「鼻衄」）。
//   ② 同义表登记项：47 组口语说法里，哪些挂在规则层可命中的科室关键词上。
//   ③ 部位路由：12 个 location 选项各自落到哪个科室，是否存在一选项多科室/零科室。
//
// 所有判定都**复用 lib/triage.js 的真实匹配函数**（mentions/mentionsMorphology/
// mentionsSynonym），不在这里重写一套口径——否则盘点结果会与线上行为漂移，
// 那就成了「文档说能识别、实际识别不出」的同一类 bug。
import { departments, probes, pathways } from '../data/hospital.js';
import { mentions, mentionsMorphology, mentionsSynonym } from './triage.js';
import { REFERENCE_SYNONYMS as SYNONYMS } from '../packages/anchored-evidence-gate/src/synonyms.js';

const PAIN_SUFFIX = /[疼痛]$/;
const BLEED_SUFFIX = /出血$/;

// 词形变体：X疼 ↔ X痛（词干相同的两方向）。
function painVariant(term) {
  if (!PAIN_SUFFIX.test(term)) return null;
  const stem = term.slice(0, -1);
  return term.endsWith('痛') ? `${stem}疼` : `${stem}痛`;
}

// 每个科室的关键词 → 该词的「识别层」标注：字面 / 形态 / 同义。
// 只需要一个探针句即可判定某一层能否命中，因为这三层的差异在**词形**而非**上下文**；
// 探针句刻意用最朴素的现症陈述，避免否定/病史/未然干扰（那些由专门的测试覆盖）。
function detectLayer(term) {
  const probe = `现在${term}，持续两天。`;
  const layers = [];
  if (mentions(probe, term)) layers.push('literal');
  if (mentionsMorphology(probe, term)) layers.push('morphology');
  if (mentionsSynonym(probe, term)) layers.push('synonym');
  return layers;
}

// 路由不依赖词表密度的科室：急诊靠红旗征闸门分流，医技科室不参与导诊评分。
// 对这些科室标「词表偏薄」会误导——它们的入口本来就不走词表命中。
const VOCAB_INDEPENDENT = new Set(['emergency']);

export function buildPanorama() {
  // 科室 → 关键词清单（含识别层标注）
  const deptRows = departments.map(d => {
    const keywords = d.keywords.map(k => ({ term: k, layers: detectLayer(k) }));
    // 词表密度偏低的科室：关键词少于 6 条，路由主要靠追问而非词表命中。
    // 但医技科室（bookable:false）与急诊不走词表入口，不参与该标记。
    const vocabIndependent = VOCAB_INDEPENDENT.has(d.id) || d.bookable === false;
    return {
      id: d.id,
      name: d.name,
      group: d.group,
      bookable: d.bookable !== false,
      floor: d.floor,
      zone: d.zone,
      keywordCount: keywords.length,
      keywords,
      vocabIndependent,
      thin: !vocabIndependent && keywords.length < 6,
    };
  });

  // ① 单方向疼痛词：词干只登记了一个方向，另一方向只能靠形态锚点。
  const painTerms = [];
  for (const d of departments) {
    for (const k of d.keywords) {
      if (!PAIN_SUFFIX.test(k)) continue;
      const variant = painVariant(k);
      const ownVariant = departments.some(x => x.keywords.includes(variant));
      painTerms.push({
        term: k,
        dept: d.id,
        deptName: d.name,
        variant,
        variantRegistered: ownVariant,
        // 形态锚点能否覆盖「另一方向」的说法——这才是实际用户体验到的能力。
        variantCovered: mentionsMorphology(`现在${variant}，持续两天。`, k),
      });
    }
  }
  const singleDirection = painTerms.filter(p => !p.variantRegistered);

  // ② X出血：形态锚点对出血类也要求词干相同，但口语换说法（鼻衄/咯血）无法覆盖，
  //    所以这里单列出来，只标「是否存在同词干的双方向登记」。
  const bleedTerms = [];
  for (const d of departments) {
    for (const k of d.keywords) {
      if (!BLEED_SUFFIX.test(k)) continue;
      bleedTerms.push({ term: k, dept: d.id, deptName: d.name });
    }
  }

  // ③ 同义表登记项：每一组口语说法，标注它挂到哪个科室关键词上（若能找到）。
  const keywordIndex = new Map();
  for (const d of departments) for (const k of d.keywords) keywordIndex.set(k, d.id);
  const synonymGroups = Object.entries(SYNONYMS).map(([canonical, entries]) => {
    const cores = entries.map(e => e[0]).filter(c => typeof c === 'string' && c);
    const constrained = entries.filter(e => e[1] instanceof RegExp).map(e => e[0]);
    return {
      canonical,
      dept: keywordIndex.get(canonical) ?? null,
      cores,
      // 有附加约束的登记项（如 脑袋+疼|痛）：核心词后必须紧跟约束窗口，覆盖面比无约束窄。
      constrained,
      // 该组是否直接对应某个科室关键词（否则它只服务于模型证据核验，不参与规则命中）。
      onKeyword: keywordIndex.has(canonical),
    };
  });
  const orphanSynonyms = synonymGroups.filter(g => !g.onKeyword).map(g => g.canonical);

  // ④ location 探针：12 个选项 → 目标科室；校验「每项恰好一个科室」。
  const location = probes.find(p => p.kind === 'location');
  const locationOptions = (location?.options ?? []).map(([value, label]) => {
    const weights = location?.weights?.[value] ?? {};
    const targets = Object.entries(weights).map(([id, w]) => ({ id, weight: w }));
    return { value, label, targets, targetCount: targets.length };
  });
  const locationAnomalies = locationOptions.filter(o => o.value !== 'unknown' && o.targetCount !== 1);

  // ⑤ 安全路径锚点：这些说法必须先走安全确认，不得被词表「抄近路」直接推荐科室。
  const anchorRows = pathways.map(p => ({
    id: p.id,
    title: p.title,
    anchors: p.anchors,
    // 锚点是否同时出现在某个科室关键词里（有交集说明存在「词表抢跑」风险，
    // 由 spanAllowed 的护栏兜底，这里只做可视化提示）。
    overlappingKeywords: p.anchors.filter(a => keywordIndex.has(a)).map(a => ({ term: a, dept: keywordIndex.get(a) })),
  }));

  const stats = {
    departments: departments.length,
    bookableDepartments: departments.filter(d => d.bookable !== false).length,
    keywordEntries: departments.reduce((n, d) => n + d.keywords.length, 0),
    uniqueKeywords: new Set(departments.flatMap(d => d.keywords)).size,
    synonymGroups: synonymGroups.length,
    painTerms: painTerms.length,
    singleDirectionPain: singleDirection.length,
    bleedTerms: bleedTerms.length,
    locationOptions: locationOptions.length,
    locationAnomalies: locationAnomalies.length,
    thinDepartments: deptRows.filter(d => d.thin).length,
    vocabIndependentDepartments: deptRows.filter(d => d.vocabIndependent).length,
  };

  return {
    stats,
    departments: deptRows,
    pain: { terms: painTerms, singleDirection },
    bleed: bleedTerms,
    synonyms: { groups: synonymGroups, orphan: orphanSynonyms },
    location: { id: location?.id ?? null, title: location?.title ?? '', options: locationOptions, anomalies: locationAnomalies },
    pathways: anchorRows,
  };
}
