import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, '.runtime', 'ollama', 'ollama.exe');
async function ready() {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(1000) });
    return response.ok && typeof (await response.json()).version === 'string';
  } catch { return false; }
}
export async function ensureOllama() {
  if (process.env.OLLAMA_URL && process.env.OLLAMA_URL !== 'http://127.0.0.1:11434') return false;
  if (await ready()) return true;
  if (!existsSync(executable) || !existsSync(path.join(root, '.runtime', 'ollama', 'download-source.json'))) return false;
  const runtime = path.join(root, '.runtime');
  await mkdir(path.join(runtime, 'models'), { recursive: true });
  const log = openSync(path.join(runtime, 'ollama.log'), 'a');
  const child = spawn(executable, ['serve'], {
    detached: true, windowsHide: true, stdio: ['ignore', log, log],
    env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_MODELS: path.join(runtime, 'models'), OLLAMA_NO_CLOUD: '1', OLLAMA_NOHISTORY: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_CONTEXT_LENGTH: '2048', OLLAMA_KEEP_ALIVE: '5m' },
  });
  let failed = false;
  child.once('error', () => { failed = true; });
  child.unref(); closeSync(log);
  for (let i = 0; i < 30 && !failed; i++) {
    if (await ready()) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}
