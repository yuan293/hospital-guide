#!/usr/bin/env node
// 诊途 · 改动后标准验证链（fail-closed，跨平台：Windows / macOS / Linux）
//
// 用法：
//   node scripts/verify-chain.mjs          快速链
//   node scripts/verify-chain.mjs --full   完整链（约数分钟，需 Ollama 就绪）
//
// 本脚本是 .trae/skills/hospital-guide-verify/scripts/verify-chain.ps1 的跨平台等价实现。
// 原 PowerShell 版只能在 Windows 运行，导致 macOS/Linux 用户无法复现验证链，
// 而 CI（ubuntu-latest）也从未真正跑过它——「一键复现」的承诺因此在非 Windows
// 平台上不成立。这里用 Node 重写，四条链路（Windows / macOS / Linux / CI）一致。
// 任一步失败立即停止并以退出码 1 结束。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FULL = process.argv.includes('--full');

// --- 定位项目根：沿目录向上找 name=hospital-guide-prototype 的 package.json ---
function findProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        if (JSON.parse(readFileSync(pkgPath, 'utf8')).name === 'hospital-guide-prototype') return dir;
      } catch { /* 忽略损坏的 package.json，继续向上 */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到诊途项目根（沿脚本向上找不到 name=hospital-guide-prototype 的 package.json）');
}

const root = findProjectRoot(__dirname);
process.chdir(root);
console.log(`项目根：${root}`);

// npm 在 Windows 上是 npm.cmd，需要 shell 才能解析；用 shell:true 统一处理。
function npmRun(scriptArgs) {
  return spawnSync('npm', scriptArgs, { stdio: 'inherit', shell: true, cwd: root });
}
function nodeRun(args) {
  return spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root });
}

// failedIds 白名单门禁由 Node 实现（见 gate-failures.mjs）。
// latest.json 含逐轮轨迹、体量大，PowerShell 5.1 的 ConvertFrom-Json 有长度上限，
// 必须由 Node 读取，这里保持一致。
function gateFailures() {
  const gate = join(__dirname, '..', '.trae', 'skills', 'hospital-guide-verify', 'scripts', 'gate-failures.mjs');
  const r = nodeRun([gate]);
  return r.status === 0;
}

const steps = [
  { name: '单元测试（node --test）', run: () => npmRun(['test']) },
  { name: '数据 fail-closed 校验', run: () => npmRun(['run', 'data:validate']) },
  { name: '科室评估覆盖率门禁', run: () => npmRun(['run', 'coverage']) },
  { name: '无模型评测（rules + dynamic）', run: () => npmRun(['run', 'evaluate']), gate: true },
  // 放在 evaluate 之后：本步读的是 evaluate 刚写出的 latest.json，
  // 用来拦住「代码先跑、README 基线数字掉队」的文档漂移。
  { name: 'README 基线数字一致性门禁', run: () => npmRun(['run', 'doc:drift']) },
];
if (FULL) {
  steps.push({ name: '双模型全量评测（7B + 1.5B，约数分钟）', run: () => npmRun(['run', 'evaluate:models']), gate: true });
  steps.push({ name: '双模型诱导红队（模型层不安全/漏诊即退出码1）', run: () => npmRun(['run', 'redteam:models']) });
}

const startedAt = Date.now();
for (const [index, step] of steps.entries()) {
  console.log(`\n==> [${index + 1}/${steps.length}] ${step.name}`);
  const result = step.run();
  if (result.status !== 0) {
    console.error(`\n验证链在「${step.name}」失败（退出码 ${result.status}）`);
    process.exit(1);
  }
  if (step.gate && !gateFailures()) process.exit(1);
}
const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);

console.log(`\n全部通过（${FULL ? '完整链' : '快速链'}），耗时 ${minutes} 分钟。`);
console.log('提醒：改了指纹文件后还需重启服务并核对 /api/health 版本；前端改动需浏览器走查。');
