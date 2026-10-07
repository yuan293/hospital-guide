/**
 * 措辞润色核验（Fail-closed Wording Gate）
 *
 * 当模型被允许改写"面向用户的问句措辞"时，如何保证它**改不出危险内容**？
 * 本模块给出一个最小、可复用的 fail-closed 把关：不合格一律返回 null，
 * 由调用方回退到配置原文。仅有禁词检查不能保证语义等价；错误问法可能
 * 影响用户回答。调用方可传入 originalTitle/originalDescription 启用逐字保守核验。
 *
 * 设计要点：
 * - 只允许"问题式"表述（必须含疑问特征），把陈述句/结论句挡在外面；
 * - 一票否决式黑名单：诊断、用药、淡化风险等词一律拒收；
 * - 长度受控；
 * - 零依赖、纯函数。
 */

/** 默认长度上限（字符数）。 */
export const DEFAULT_MAX_LEN = 60;

/**
 * 一票否决词表：出现即拒收。
 * 覆盖三类风险——诊断性结论、用药建议、淡化风险（劝人别就医）。
 */
export const DEFAULT_FORBIDDEN =
  /(诊断|确诊|开药|用药|处方|药量|一定是|肯定是|建议服用|不必就医|无需就医|不用担心|肯定不是)/;

/**
 * 疑问特征：改写结果必须仍是"问题"。
 * 若模型把问题改成了陈述句，即使不含危险词也应拒收。
 */
export const DEFAULT_QUESTIONISH =
  /[？?]|是否|有没有|哪个|哪一|如何|怎样|多久|什么|大概|主要|哪/;

/**
 * 核验模型改写的措辞。合格返回 `{ title, description }`，否则返回 `null`。
 *
 * @param {unknown} parsed 模型返回的对象（期望含 `title` / 可选 `description`）
 * @param {{maxLen?: number, minLen?: number, forbidden?: RegExp, questionish?: RegExp, maxDescriptionLen?: number}} [opts]
 * @returns {{title: string, description: string} | null}
 */
export function acceptPolish(parsed, opts = {}) {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  const minLen = opts.minLen ?? 4;
  const forbidden = opts.forbidden ?? DEFAULT_FORBIDDEN;
  const questionish = opts.questionish ?? DEFAULT_QUESTIONISH;
  const maxDescriptionLen = opts.maxDescriptionLen ?? 80;

  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.title !== 'string') return null;

  const title = parsed.title.trim();
  if (!title || title.length > maxLen || title.length < minLen) return null;
  if (forbidden.test(title)) return null;
  // 必须是问题式表述，不能被改写成陈述句/结论句。
  if (!questionish.test(title)) return null;

  const description =
    typeof parsed.description === 'string' ? parsed.description.trim().slice(0, maxDescriptionLen) : '';
  if (description && forbidden.test(description)) return null;

  // 业务调用传入原问题时采用保守的同文案门禁：未经审核的自由改写不能
  // 只凭禁词/疑问特征证明信息点等价。暂不放行语义改写，调用方回退原文。
  if (opts.originalTitle !== undefined) {
    if (title !== opts.originalTitle.trim()) return null;
    if (description && description !== (opts.originalDescription || '').trim()) return null;
  }
  return { title, description };
}
