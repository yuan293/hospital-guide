import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hospital, departments, sources, dataInfo, probes, questionnaire } from './data/hospital.js';
import { runTriage } from './lib/flow.js';
import { modelStatus } from './lib/model.js';
import { readEvaluation } from './lib/evaluation-store.js';
import { ensureOllama } from './lib/runtime.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/assets/campus.png', ['assets/campus.png', 'image/png']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
const security = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};
staticFiles.set('/evaluation.js', ['evaluation.js', 'text/javascript; charset=utf-8']);
staticFiles.set('/evaluation.css', ['evaluation.css', 'text/css; charset=utf-8']);
staticFiles.set('/flow.css', ['flow.css', 'text/css; charset=utf-8']);
function json(res, status, value) { res.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function body(req, limit = 8192) {
  let chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const e = new Error('输入内容过长。'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('请求格式不正确。'); }
}

export function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return json(res, 403, { error: '仅允许本机访问。' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: '不允许跨站请求。' });
      const route = new URL(req.url, `http://${host}`).pathname;
      if (req.method === 'GET' && route === '/api/config') return json(res, 200, { hospital, departments, probes, questionnaire, sources, dataInfo });
      if (req.method === 'GET' && route === '/api/evaluation') return json(res, 200, await readEvaluation());
      if (req.method === 'GET' && route === '/api/health') return json(res, 200, { version: '0.4.0', status: 'ok', pid: process.pid, privacy: '本应用不保存导诊会话，不发送到云端。', ollama: await modelStatus() });
      if (req.method === 'POST' && route === '/api/triage') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要JSON请求。' });
        const result = await runTriage(await body(req));
        return json(res, 200, result);
      }
      if (req.method === 'GET' && staticFiles.has(route)) {
        const [file, mime] = staticFiles.get(route);
        const content = await readFile(path.join(root, 'public', file));
        res.writeHead(200, { ...security, 'Content-Type': mime }); res.end(content); return;
      }
      return json(res, 404, { error: '页面或接口不存在。' });
    } catch (e) { json(res, e.status || 400, { error: e.code === 'ENOENT' ? '文件不存在。' : e.message || '请求未完成，请重试。' }); }
  });
}

export function start(port = Number(process.env.PORT || 3210)) {
  if (!Number.isInteger(port) || port < 1024 || port > 65530) throw new Error('PORT must be between 1024 and 65530.');
  const server = createApp();
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && port < 65530) { server.close(); start(port + 1); }
    else { console.error(error.message); process.exitCode = 1; }
  });
  server.listen(port, '127.0.0.1', () => console.log(`Hospital Guide v0.4.0\nOpen: http://127.0.0.1:${port}\nDemo only. Ctrl+C to stop.`));
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('Checking local model service...');
  console.log(await ensureOllama() ? 'Ollama is ready.' : 'Ollama unavailable; rule mode remains available.');
  start();
}
