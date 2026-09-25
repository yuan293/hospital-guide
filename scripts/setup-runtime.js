import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime', 'ollama');
const archive = path.join(root, '.runtime', 'ollama-windows-amd64.zip');
const version = 'v0.34.4';
const sha256 = '535193f38f3344e5b08f5d1c171c31ce11aa17f0124ff69ae26d8ec7fe06fa62';
const url = `https://github.com/ollama/ollama/releases/download/${version}/ollama-windows-amd64.zip`;
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This setup script requires Windows x64.');
await mkdir(runtime, { recursive: true });
if (!await stat(path.join(runtime, 'download-source.json')).catch(() => null) || !await stat(path.join(runtime, 'ollama.exe')).catch(() => null)) {
  console.log(`Downloading official Ollama ${version} (1.46 GB).`);
  const response = await fetch('https://api.github.com/repos/ollama/ollama/releases/assets/585130119', { headers: { Accept: 'application/octet-stream', 'User-Agent': 'HospitalGuide-Setup' }, signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  let received = 0; let last = 0;
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, enc, callback) {
    hash.update(chunk); received += chunk.length;
    if (Date.now() - last > 5000) { console.log(`Downloaded ${(received / 1e6).toFixed(0)} MB`); last = Date.now(); }
    callback(null, chunk);
  } }), createWriteStream(archive));
  if (hash.digest('hex') !== sha256) throw new Error('SHA-256 verification failed. Archive has not been executed.');
  console.log('SHA-256 verified. Extracting portable runtime...');
  await new Promise((resolve, reject) => {
    const proc = spawn('tar.exe', ['-xf', archive, '-C', runtime], { windowsHide: true, stdio: 'inherit' });
    proc.on('error', reject); proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`Extraction failed: ${code}`)));
  });
  await stat(path.join(runtime, 'ollama.exe'));
  await unlink(archive);
}
await writeFile(path.join(runtime, 'download-source.json'), JSON.stringify({ version, url, sha256 }, null, 2));
console.log('Portable runtime ready:', runtime);
