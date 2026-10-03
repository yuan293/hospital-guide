/**
 * 锚点表证据核验（Anchored Evidence Gate）
 *
 * 从一个受约束的候选词表中，判定"模型给出的证据片段"是否真的支持"该词表词"。
 * 这是把「模型说它匹配」变成「模型必须证明它匹配」的最小可复用单元。
 *
 * 背景：当模型输出被 schema `enum` 约束在一个受控词表内时，模型仍可能把 A 症状的
 * 证据配给 B 症状的词（语义错配）。逐词白名单核验让这类错配**结构性不可表达**：
 * 词素不相交、又不在登记同义表里，就通不过。
 *
 * 本模块零依赖、纯函数、无副作用，可直接在浏览器或 Node 中复用。
 */

/**
 * 判定证据片段是否支持某个词表词。四条接受规则（满足其一即通过）：
 *
 * ① **字面**：证据包含词表词本身。例：词「咳嗽」← 证据「咳嗽三天」。
 * ② **形态锚点**：`X疼` / `X痛` 词——词干出现在证据中，且证据含「疼」或「痛」。
 *    例：词「腰痛」← 证据「腰部疼痛」；词「胸痛」← 证据「胸口疼」。
 *    `X出血` 词——词干出现在证据中，且证据含「血」。
 *    例：词「鼻出血」← 证据「鼻子老是出血」。
 * ③ **双语素同现**：二字词的两个字都出现在证据中。
 *    例：词「血尿」← 证据「尿里带血」成立；词「耳鸣」← 证据「耳朵疼」不成立（缺「鸣」）。
 * ④ **登记同义形**：命中调用方登记的口语核心词（可附加"须同时出现某字/词"的约束）。
 *    例：词「腹痛」← 证据「肚子疼」（登记 `['肚子', /疼|痛/]`）。
 *
 * @param {string} keyword 候选词表中的一个词（通常是模型输出、被 enum 约束的词）。
 * @param {string} evidence 模型给出的证据片段（应为其自称能支持的原文片段）。
 * @param {Object<string, Array>} [synonyms={}] 登记同义表：`{ 词表词: [[核心词, 可选的正则约束], ...] }`。
 * @returns {boolean} 证据是否通过核验（true = 该证据可用于支持该词）。
 */
export function evidenceMatchesKeyword(keyword, evidence, synonyms = {}) {
  if (typeof keyword !== 'string' || !keyword) return false;
  if (typeof evidence !== 'string' || !evidence) return false;

  // ① 字面包含
  if (evidence.includes(keyword)) return true;

  // ② 形态锚点：X疼 / X痛
  if (/疼$|痛$/.test(keyword)) {
    const stem = keyword.slice(0, -1);
    if (stem && evidence.includes(stem) && /疼|痛/.test(evidence)) return true;
  }

  // ② 形态锚点：X出血
  if (keyword.endsWith('出血')) {
    const stem = keyword.slice(0, -2);
    if (stem && evidence.includes(stem) && evidence.includes('血')) return true;
  }

  // ③ 双语素同现（仅限二字词）
  if (keyword.length === 2 && [...keyword].every((ch) => evidence.includes(ch))) return true;

  // ④ 登记同义形
  const registered = synonyms[keyword] || [];
  return registered.some(([core, need]) => evidence.includes(core) && (!need || need.test(evidence)));
}

/**
 * 证据片段是否为"可接受的短片段"。
 *
 * 防止模型把整句原文配给任意词表词来"通过"核验
 * （例：把「说不清楚哪里不舒服」整句当作「咽痛」的证据）。
 *
 * @param {string} evidence 证据片段
 * @param {string} chief 完整主诉原文
 * @param {{min?: number, max?: number}} [opts]
 * @returns {boolean}
 */
export function isShortEvidenceFragment(evidence, chief, opts = {}) {
  const min = opts.min ?? 2;
  const max = opts.max ?? 8;
  if (typeof evidence !== 'string' || typeof chief !== 'string') return false;
  const ev = evidence.trim();
  if (ev.length < min || ev.length > max) return false;
  // 证据长度必须严格小于主诉（除非主诉本身就很短），否则视为"引用整句"。
  if (chief.length > max && ev.length >= chief.length) return false;
  // 证据必须是主诉的连续子串
  if (!chief.includes(ev)) return false;
  return true;
}
