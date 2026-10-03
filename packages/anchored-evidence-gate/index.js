/**
 * anchored-evidence-gate
 *
 * 把"模型说它匹配"变成"模型必须证明它匹配"的两个零依赖纯函数：
 *   1. evidenceMatchesKeyword —— 锚点表证据核验（四条接受规则）
 *   2. acceptPolish           —— 措辞润色的 fail-closed 把关
 *
 * 适用于任何"模型输出被约束在受控词表内、且证据需可核验"的场景：
 * 症状标准化、意图分类、工单路由、标签抽取等。
 */

export { evidenceMatchesKeyword, isShortEvidenceFragment } from './src/anchors.js';
export {
  acceptPolish,
  DEFAULT_FORBIDDEN,
  DEFAULT_QUESTIONISH,
  DEFAULT_MAX_LEN,
} from './src/polish.js';
export { REFERENCE_SYNONYMS } from './src/synonyms.js';
