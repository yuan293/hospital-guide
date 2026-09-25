---
name: hospital-guide-publish
description: 院内智导 GitHub 仓库的标准发布流程（测试、暂存、提交、绕开失效代理推送、本地远程哈希核验），含历史清洗与删库重建的高危操作规范。当用户要求更新、推送、同步或发布 GitHub 仓库，或要求提交改动时使用。只跑测试或评测时用 hospital-guide-verify。
---

# 院内智导 · 仓库发布流程

## 环境事实（先读，勿重复踩坑）

- 项目根：`C:\Users\punchline\Documents\Codex\hospital-guide`（不在注册工作区 c:\CloudMusic 内，用户已授权读写）
- 远程：https://github.com/yuan293/hospital-guide ，PUBLIC，分支 main，origin 已配置
- 凭据：gh CLI 已 OAuth 登录账号 yuan293（令牌在系统密钥环）。**禁止**把 token 写进 remote URL 或任何文件
- **代理坑**：全局 `~/.gitconfig` 里有失效代理 `http(s).proxy=http://127.0.0.1:7892`，裸 `git push` 必失败。推送一律用
  `git -c http.proxy= -c https.proxy= push`（仅本命令生效；repo-local 设空字符串无效，勿再试）
- 网络前提：Watt Toolkit hosts 加速开启；curl/gh 如遇 schannel 吊销错误加 `--ssl-no-revoke`
- 提交信息风格：`feat:` 新功能、`fix:` 修 bug、`chore:` 杂项、`docs:` 文档
- 未经用户明确要求，**不要主动 commit**；`--force` / 删库 / 重置历史类操作必须先取得明确授权

## 日常更新（优先用脚本）

一条命令完成 状态检查 → npm test → 暂存 → 空暂存拦截 → commit → 绕代理推送 → 哈希核验：

```powershell
# 暂存指定文件（逗号分隔；-File 模式下的数组绑定坑已在脚本内归一化，空格分隔也可）
powershell -ExecutionPolicy Bypass -File .trae/skills/hospital-guide-publish/scripts/publish.ps1 -Message "fix: 一句话说明" -Files lib/triage.js,public/app.js

# 暂存全部改动（先人工确认 git status 无 .runtime、密钥等）
powershell -ExecutionPolicy Bypass -File .trae/skills/hospital-guide-publish/scripts/publish.ps1 -Message "chore: 一句话说明" -All

# 只想先看会执行什么
powershell -ExecutionPolicy Bypass -File .trae/skills/hospital-guide-publish/scripts/publish.ps1 -Message "x" -All -DryRun
```

- 测试失败会在暂存之前中止，工作区不受影响；确有理由跳过加 `-SkipVerify`
- 脚本最后一步必须打印 `MATCH`，否则视为发布失败并继续排查

## 手工流程（脚本不可用时）

```powershell
git status --short
npm test
git add <文件>            # 或 git add -A（先确认内容）
git commit -m "fix: 说明"
git -c http.proxy= -c https.proxy= push
$local = (git rev-parse HEAD).Trim()
$remote = ((git -c http.proxy= -c https.proxy= ls-remote origin refs/heads/main) -split "`t")[0].Trim()
if ($local -ne $remote) { throw 'HASH MISMATCH' } else { 'MATCH' }
```

PowerShell 5.1 无 heredoc；多行提交信息用多个 `-m`。git 把进度写到 stderr，NativeCommandError 红字但退出码为 0 时不是失败，以 `$LASTEXITCODE` 为准。

## 常见失败处理

| 现象 | 处理 |
|---|---|
| Failed to connect over proxy 127.0.0.1:7892 | 忘了加空代理参数，重推即可 |
| 443 / Could not resolve | 确认 Watt Toolkit 加速开启；不要开启旧 7892 代理软件 |
| pre-commit / npm test 失败 | 修复后重新 add+commit，**不要** `--no-verify`，不要 amend（新建提交） |
| rejected (non-fast-forward) | 先 `git -c http.proxy= -c https.proxy= pull` 再推；禁止直接 force |
| gh/新终端认不到 | 重开 PowerShell 刷新 PATH |

## 高危操作：清洗提交历史（须用户明确授权）

适用：已删除的敏感/废弃内容仍能在旧提交中翻到（删文件不删历史）。

1. **orphan 单提交压平**：`git checkout --orphan clean-main` → `git commit`（干净信息）→ `git branch -D main` → `git branch -m main`
2. 强推只用 `--force-with-lease`（带空代理参数），不用 `--force`
3. **关键坑**：强推后 GitHub 对不可达旧提交仍短期保留"精确 SHA 直链"（API/Web 都可达，搜索与浏览已不可见）。要立即 100% 抹除只能**删库同名重建**：
   - `gh auth refresh -h github.com -s delete_repo`（设备流，让用户去 github.com/login/device 输码授权）
   - 先记录仓库 description/visibility；`gh repo delete yuan293/hospital-guide --yes`
   - 立即 `gh repo create yuan293/hospital-guide --public --description "..."`，再 `git push -u origin main`
   - 重建后核验：提交数=预期、旧 SHA API 返回 422、旧文件路径 404、`search/commits` 命中 0
4. 本地清理：`git reflog expire --expire=now --all; git gc --prune=now`
5. raw CDN 有分钟级缓存，取证以 `gh api` 的 blob SHA 对比 `git hash-object` 为准

仅在本人是唯一协作者、无 PR/fork/issue 时才可删库重建；操作前向用户说明 URL 不变但时间线永久消失。

## 完成标准

- 本地 HEAD 与 `ls-remote origin refs/heads/main` 哈希一致（脚本打印 MATCH）
- `git status --short` 干净或只剩用户知情的未跟踪文件
- 向用户报告：提交短 SHA、提交信息、仓库链接；删除类操作另附失效证据（422/404）
