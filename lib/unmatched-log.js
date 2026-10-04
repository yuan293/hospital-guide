/**
 * 未命中记录（unmatched log）——「能力增长的系统性来源」的采集端。
 *
 * 背景
 * ----
 * 规则层遇到"词表接不住的口语主诉"时会返回 human + reasonCode='unmatched'，
 * 但**这条信息过去被丢掉了**：系统转人工，没人知道这句话出现过、出现过几次。
 * 于是词表的增长只能靠"人肉想"——想到什么登记什么，没有系统性来源。
 *
 * 这个模块把 unmatched 的输入落盘成一个 JSONL 文件，供
 * `scripts/suggest-synonyms.mjs` 做盲区发现。它**只采集，不分析、不决策**。
 *
 * 隐私与默认行为（重要）
 * --------------------
 * - **默认关闭**。必须显式设置 `HOSPITAL_GUIDE_COLLECT_UNMATCHED=1` 才写盘。
 *   理由：主诉文本属于用户隐私；评测、CI、日常使用都不该悄悄落盘。
 * - 写入内容只保留**主诉原文**与最小上下文（时间、年龄段、是否带模型），
 *   **不写** answers 全量、不写 IP、不写 UA。
 * - 文件位于 `.runtime/`（已被 .gitignore 排除），不会被提交。
 * - 写入失败永不抛出：采集是旁路，绝不能让导诊主流程因日志问题失败。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const logPath = path.join(root, '.runtime', 'unmatched.jsonl');

/** 是否启用采集。默认关闭，需显式开启。 */
export function collectionEnabled() {
  return process.env.HOSPITAL_GUIDE_COLLECT_UNMATCHED === '1';
}

/**
 * 记录一条未命中。仅在启用了采集、且结论确实是 unmatched 时写盘。
 * @param {string} chief 主诉原文
 * @param {object} answers 结构化回答（只取 age，最小化）
 * @param {object} meta 附加信息（如是否带模型）
 * @returns {Promise<boolean>} 是否成功写入
 */
export async function recordUnmatched(chief, answers = {}, meta = {}) {
  if (!collectionEnabled()) return false;
  // 二次防御：即使调用方误传，也不记录过短/过长/空内容。
  if (typeof chief !== 'string') return false;
  const text = chief.trim();
  if (text.length < 2 || text.length > 1200) return false;
  const entry = {
    at: new Date().toISOString(),
    chief: text,
    age: answers?.age ?? null,
    withModel: Boolean(meta.withModel),
  };
  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch {
    // 采集是旁路：任何 IO 失败都静默忽略，不影响导诊。
    return false;
  }
}
