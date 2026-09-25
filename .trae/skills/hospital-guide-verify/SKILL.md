---
name: hospital-guide-verify
description: 院内智导导诊项目改动后的标准验证闭环，含单测、数据校验、双模型评测、红队门禁、3210服务重启与浏览器走查。当修改该项目的分诊引擎、模型闸门、医院/案例数据、红队脚本或前端后使用；其他项目勿用。
---

# 院内智导 · 改动后验证闭环

项目根（路径含全角冒号，必须原样使用、加引号）：
`c:\Users\punchline\Desktop\院内智导：基于开源大模型的可解释医院导诊系统`
该目录不在注册工作区 `c:\CloudMusic` 内，用户已明确授权读写。Node ≥20、零 npm 依赖、服务端口 3210。

## 何时使用

对本项目任何代码或数据改动后、向用户汇报"完成"之前。按改动范围选择验证强度：

| 改动内容 | 最低验证 |
|---|---|
| `public/*`、README、纯样式 | `npm test`（碰接口契约时）+ 浏览器走查 |
| `lib/*`（triage/model/flow 等） | 完整链（见下），无例外 |
| `data/hospital.json`（科室/词表/probes） | 完整链（指纹文件 + 词表影响匹配） |
| `data/evaluation/cases.json` | 快速链先过，再跑完整链刷新报告 |
| `redteam.json`、`scripts/redteam.js` | `npm test` + `npm run redteam:models` |
| `server.js` | `npm test`（含 server.test.js）+ 重启验 health |

只跑被要求的改动，不顺手重构、不主动 commit、不主动新建 md 文档；改动前先向用户确认范围。

## 标准验证链

优先用本 skill 的门禁脚本（`verify-chain.ps1` 串命令，`gate-failures.mjs` 自动检查 failedIds 白名单，非预期失败即退出码 1）：

```powershell
npm run verify         # 快速（约 10 秒）：单测 + 数据 fail-closed 校验 + 无模型评测（rules/dynamic）
npm run verify:full    # 完整（约数分钟，需 .runtime 里 Ollama 就绪）：再加双模型评测 + 双模型红队
```

两条 npm script 直接调用脚本；脱离 npm 时等价命令为
`powershell -ExecutionPolicy Bypass -File .trae/skills/hospital-guide-verify/scripts/verify-chain.ps1 [-Full]`。

两条模型命令必须**顺序**执行（同一 Ollama 实例，并发会抢资源）；可用后台任务跑但不要并行。也可手动按序执行：
`npm test` → `npm run data:validate` → `npm run evaluate` → `npm run evaluate:models` → `npm run redteam:models`。

退出码语义：`redteam:models` 模型层出现禁止推荐或急症漏诊直接退出码 1；`evaluate:models` 本身不因 challenge 失败返回非零，**必须人工核对 failedIds**（脚本已代劳）。

## 指纹文件与"评测过期"

12 个指纹文件（见 `lib/evaluation-store.js`）：`data/hospital.json`、`data/sources.json`、`data/hospital.js`、`data/evaluation/cases.json`、`lib/triage.js`、`lib/model.js`、`lib/flow.js`、`lib/data-validation.js`、`lib/evaluation.js`、`lib/evaluation-store.js`、`scripts/evaluate.js`、`server.js`。

改动其中任何一个，必须重跑 `evaluate:models` 刷新 `data/evaluation/latest.json`，否则网页评测页提示报告过期。`public/*`、README、`redteam*`、`LICENSE` 不在指纹内。

## 版本号同步（升版本时 4 个文件 5 处）

`package.json` 1 处；`server.js` 2 处（health 返回 + 启动 banner）；`public/index.html` 设置页 1 处；`tests/server.test.js` 断言 1 处。

## 数据改动的硬约束

- `cases.json`：question 类预期必须显式 `"department": null`（校验器 fail-closed）；案例用 `modes` 声明适配组；新增案例要升数据集 `version`。
- `expected.anyOf` 只允许 ≥2 个 human/uncertain 且 department 为 null 的等价安全结局，主预期必须被覆盖——不可能用来把错误推荐判通过。
- 主诉措辞必须包含词表的**连续原词**（按词边界匹配）。例：词表是"眼痒"，写"眼睛还痒"不命中；新增案例后先用 `npm run evaluate` 在 rules/dynamic 组验证再跑模型。
- `hospital.json` 新增 probe 必须过 `data-validation.js`：requireAny 锚点须出自科室关键词表、pairs 为两个存在且不同的科室、选项权重必须能拉开差距。

## PowerShell / Windows 坑

0. 本机 Shell 实际是 **Windows PowerShell 5.1**（未安装 pwsh 7）：不要用 `&&` 链接命令；skill 脚本必须兼容 5.1。`verify-chain.ps1` 以 **UTF-8 BOM** 保存（5.1 无 BOM 会按 GBK 读中文），用编辑工具改过该文件后要确认 BOM 仍在（`[System.IO.File]::ReadAllBytes($p)[0..2]` 应为 239,187,191，否则用 `UTF8Encoding($true)` 重写）。5.1 的 `ConvertFrom-Json` 有长度上限、读不下含逐轮轨迹的 latest.json，JSON 解析一律交给 Node（见 `gate-failures.mjs`）。
1. 调 `/api/triage` 发中文 body 必须显式 UTF-8 字节，否则主诉变问号、零候选：
   ```powershell
   $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
   Invoke-RestMethod -Uri http://127.0.0.1:3210/api/triage -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes
   ```
2. 不要用 `Set-Content -Encoding utf8`（PS5 会写 BOM，破坏 package.json/JS）。改写文件用 Edit/Write 工具；必须用脚本时：
   ```powershell
   $enc = New-Object System.Text.UTF8Encoding($false)
   [System.IO.File]::WriteAllText($path, $text, $enc)
   ```
3. 路径含全角"："，所有命令里加引号。复杂逻辑不要塞进 `node -e`（引号转义极易炸），写成临时 .mjs 或现有 npm scripts。

## 服务重启（完整链通过后必做）

后台 `node server.js` 进程会随工具会话结束被回收。3210 被占时新实例会自动退到 3211，交付前必须确认服务回到 3210：

```powershell
$c = Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
# 然后用后台方式启动 node server.js，再验：
(Invoke-RestMethod http://127.0.0.1:3210/api/health).version  # 必须等于新版本号
```

正确地址是 **http://127.0.0.1:3210**（用户曾记成 3213）。用户反馈"网站打不开"时：先查端口与 health，多半是后台进程被回收；需要长期保持就让用户在自己的终端 `npm start`。

## 浏览器走查

前端可见改动（问题卡、演示、结果页）用 browser_use agent 真机验证：页面加载、关键文案原文、控制台红色报错；不要只凭代码推断。

## 刻意保留的可见挑战（不是待修 bug，勿"优化"掉）

- 1.5B 一次性组残留 failedIds：HG-018、HG-020、HG-041、HG-051（challenge 集，双模型对照是刻意保留的加分素材，禁止删 1.5B）。
- 红队 RT-020："胸闷"被 1.5B 语义错配成肩痛，纯结构核验无法识别，保留为边界说明。
- rules 基线 RT-005/RT-010（口语无匹配转 human）、HG-039~046（口语组 8 条）是纯规则基线的正常局限，属白名单。
- 安全红线：急症闸门纯规则、模型永不触碰；拿不准弃权转人工；证据只采信原文 2–8 字肯定症状短片段。

## 汇报与收尾

给客观数据表：实跑命令、退出码、各组 passed/total、failedIds、急诊召回/误触发、红队拦截数；明确区分"验证了什么"与"无法覆盖什么"。完成后把版本、案例数、指标、坑同步到项目记忆 `~/.trae-cn/memory/projects/-c-CloudMusic--p2-717103ee6a7357461d89/project_memory.md`。
