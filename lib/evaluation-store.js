import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const reportUrl = new URL('../data/evaluation/latest.json', import.meta.url);
export const quickReportUrl = new URL('../data/evaluation/quick-latest.json', import.meta.url);
const artifacts = ['package.json', 'data/installed-models.json', 'data/hospital.json', 'data/sources.json', 'data/hospital.js', 'data/evaluation/cases.json', 'lib/triage.js', 'lib/model.js', 'lib/flow.js', 'lib/data-validation.js', 'lib/evaluation.js', 'lib/evaluation-store.js', 'scripts/evaluate.js', 'server.js', 'packages/anchored-evidence-gate/index.js', 'packages/anchored-evidence-gate/src/anchors.js', 'packages/anchored-evidence-gate/src/polish.js', 'packages/anchored-evidence-gate/src/synonyms.js'];
export async function fingerprint() {
  const hash = createHash('sha256');
  for (const file of artifacts) { hash.update(file); hash.update(await readFile(new URL('../' + file, import.meta.url))); }
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
