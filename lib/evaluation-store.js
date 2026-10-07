import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const reportUrl = new URL('../data/evaluation/latest.json', import.meta.url);
const artifacts = ['data/hospital.json', 'data/sources.json', 'data/hospital.js', 'data/evaluation/cases.json', 'lib/triage.js', 'lib/model.js', 'lib/flow.js', 'lib/data-validation.js', 'lib/evaluation.js', 'lib/evaluation-store.js', 'scripts/evaluate.js', 'server.js'];
export async function fingerprint() {
  const hash = createHash('sha256');
  for (const file of artifacts) {
    // 统一按 LF 归一化后哈希，避免 CRLF 检出差异导致指纹跨平台漂移
    hash.update(file);
    hash.update((await readFile(new URL('../' + file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n'));
  }
  return { sha256: hash.digest('hex'), files: artifacts };
}
export async function readEvaluation() {
  try {
    const report = JSON.parse(await readFile(reportUrl, 'utf8'));
    const current = await fingerprint();
    return { available: true, stale: report.fingerprint?.sha256 !== current.sha256, report };
  } catch (e) {
    if (e.code === 'ENOENT') return { available: false, reason: '还没有评测结果，请在项目目录运行 npm run evaluate。' };
    throw e;
  }
}
