import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// 防漂移门禁：questionnaire 中出现的每个自定义扩展 canonical URL，
// 仓库内都必须有路径一一对应、url 字段一致的 StructureDefinition 文件；
// Questionnaire 规范 URL 同样必须能解析到资源本体。
// 文件由 scripts/export-fhir-resources.js 生成（npm run fhir:export）。
const SD_BASE = 'https://github.com/yuan293/hospital-guide/blob/main/StructureDefinition';
const Q_URL = 'https://github.com/yuan293/hospital-guide/blob/main/Questionnaire/hospital-guide-probes';

const data = JSON.parse(readFileSync(new URL('../data/hospital.json', import.meta.url)));
const q = data.questionnaire;
const tails = new Set();
function walk(exts) {
  if (!Array.isArray(exts)) return;
  for (const e of exts) {
    assert.ok(e.url.startsWith(`${SD_BASE}/`), `非本项目前缀的扩展 URL：${e.url}`);
    tails.add(e.url.slice(SD_BASE.length + 1));
    walk(e.extension);
  }
}
walk(q.extension);
for (const item of q.item ?? []) {
  walk(item.extension);
  for (const opt of item.answerOption ?? []) walk(opt.extension);
}

test('每个扩展 canonical URL 都有一一对应的 StructureDefinition 文件', () => {
  assert.ok(tails.size >= 20, `扩展数量异常：${tails.size}`);
  for (const tail of tails) {
    const file = new URL(`../StructureDefinition/${tail}`, import.meta.url);
    assert.ok(existsSync(file), `缺少定义文件：StructureDefinition/${tail}（运行 npm run fhir:export）`);
    const sd = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(sd.resourceType, 'StructureDefinition', `${tail} 不是 StructureDefinition`);
    assert.equal(sd.url, `${SD_BASE}/${tail}`, `${tail} 文件内 url 与路径不一致`);
    assert.equal(sd.type, 'Extension');
    assert.equal(sd.derivation, 'constraint');
  }
});

test('Questionnaire 规范 URL 解析到与 data/hospital.json 一致的资源本体', () => {
  const file = new URL('../Questionnaire/hospital-guide-probes', import.meta.url);
  assert.ok(existsSync(file), '缺少 Questionnaire/hospital-guide-probes（运行 npm run fhir:export）');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), q);
  assert.equal(q.url, Q_URL);
});

test('StructureDefinition 索引页存在', () => {
  assert.ok(existsSync(new URL('../StructureDefinition/README.md', import.meta.url)));
});
