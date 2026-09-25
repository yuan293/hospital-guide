import { ensureOllama } from '../lib/runtime.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!await ensureOllama()) throw new Error('Cannot start Ollama. Run npm run models:setup first.');
// 可以只拉指定模型：node scripts/pull-models.js qwen2.5:7b
// 默认两个：导诊主模型 7B 与轻量对照 1.5B。
const requested = process.argv.slice(2).filter(name => !name.startsWith('-'));
const models = requested.length ? requested : ['qwen2.5:1.5b', 'qwen2.5:7b'];
for (const model of models) {
  console.log(`Pulling ${model} from Ollama registry...`);
  const response = await fetch('http://127.0.0.1:11434/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!response.ok) throw new Error(`Model pull failed: ${response.status}`);
  const decoder = new TextDecoder(); let buffer = ''; let last = 0; let success = false;
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.error) throw new Error(row.error);
      if (Date.now() - last > 5000 || !row.total) { console.log(model, row.status, row.total ? `${Math.round((row.completed || 0) / row.total * 100)}%` : ''); last = Date.now(); }
      if (row.status === 'success') success = true;
    }
  }
  if (!success) throw new Error(`Pull did not complete: ${model}`);
  const details = await (await fetch('http://127.0.0.1:11434/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) })).json();
  await mkdir(path.join(root, 'data', 'model-licenses'), { recursive: true });
  await writeFile(path.join(root, 'data', 'model-licenses', model.replace(':', '-') + '.txt'), details.license || 'License unavailable. Verify upstream before distribution.');
}
const tags = await (await fetch('http://127.0.0.1:11434/api/tags')).json();
await writeFile(path.join(root, 'data', 'installed-models.json'), JSON.stringify({ recordedAt: new Date().toISOString(), source: 'https://ollama.com/library（按模型名访问对应页面）', models: tags.models }, null, 2));
console.log(models.length + ' 个模型已就绪，摘要与许可已记录。');
