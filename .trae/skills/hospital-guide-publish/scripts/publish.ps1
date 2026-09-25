# 院内智导 · 标准发布脚本（fail-closed，兼容 Windows PowerShell 5.1+）
# 用法：
#   publish.ps1 -Message "fix: xxx" -Files lib/a.js,public/b.html   暂存指定文件（逗号分隔）
#   publish.ps1 -Message "fix: xxx" -Files lib/a.js public/b.html    空格分隔同样支持
#   publish.ps1 -Message "chore: xxx" -All                           暂存全部改动
#   加 -SkipVerify 跳过 npm test；加 -DryRun 只打印计划不执行
# 流程：status → npm test → 暂存 → 空暂存拦截 → commit → 空代理 push → 本地/远程哈希比对
param(
  [Parameter(Mandatory = $true)]
  [string]$Message,
  [string[]]$Files,
  [switch]$All,
  [switch]$SkipVerify,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

# powershell -File 模式不会把 -Files a,b 解析为数组，而是绑定成单字符串 "a,b"。
# 统一按逗号拆分再去空白/空项，兼容三种写法：-Files a,b｜-Files a b｜-Files @('a','b')
if ($Files) {
  $Files = @($Files | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

if (-not $All -and (-not $Files -or $Files.Count -eq 0)) {
  throw '必须用 -Files 指定一个或多个文件，或用 -All 暂存全部改动'
}

# --- 定位项目根：沿目录向上找 name=hospital-guide-prototype 的 package.json ---
function Find-ProjectRoot {
  $dir = $PSScriptRoot
  for ($i = 0; $i -lt 8; $i++) {
    $pkgPath = Join-Path $dir 'package.json'
    if (Test-Path $pkgPath) {
      try { $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json } catch { $pkg = $null }
      if ($pkg -and $pkg.name -eq 'hospital-guide-prototype') { return $dir }
    }
    $parent = Split-Path -Parent $dir
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
  }
  throw '未找到院内智导项目根（沿脚本向上找不到 name=hospital-guide-prototype 的 package.json）'
}

$root = Find-ProjectRoot
Set-Location $root
Write-Host "项目根：$root" -ForegroundColor DarkGray
Write-Host "模式：$(if ($DryRun) { 'DRY-RUN（不执行任何改动）' } else { '执行' })" -ForegroundColor DarkGray

# [1/6] 工作区状态
Write-Host ''
Write-Host '==> [1/6] 工作区状态（人工确认无 .runtime、密钥等）' -ForegroundColor Cyan
git status --short
if ($LASTEXITCODE -ne 0) { throw 'git status 失败' }

# [2/6] 测试（在暂存之前，失败不影响工作区）
if (-not $SkipVerify) {
  Write-Host ''
  Write-Host '==> [2/6] 单元测试 npm test' -ForegroundColor Cyan
  if ($DryRun) {
    Write-Host '    [dry-run] npm test'
  } else {
    & npm test
    if ($LASTEXITCODE -ne 0) { throw 'npm test 失败，已中止（尚未暂存或提交任何内容）' }
  }
} else {
  Write-Host ''
  Write-Host '==> [2/6] 单元测试（-SkipVerify 已跳过）' -ForegroundColor Yellow
}

# [3/6] 暂存 + 空暂存拦截
Write-Host ''
Write-Host '==> [3/6] 暂存改动' -ForegroundColor Cyan
if (-not $All) {
  # fail-closed 预检：每个路径必须在磁盘上存在（修改/新增），或在工作区中处于已删除状态。
  # 拼错文件名时 git add 会整体失败，提前给出明确错误且不产生任何暂存。
  $porcelain = @(git status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw 'git status --porcelain 失败' }
  $deletedPaths = @($porcelain | Where-Object { $_ -match '^.?D' } | ForEach-Object { $_.Substring(3).Trim(' ', '"') })
  foreach ($f in $Files) {
    if (-not (Test-Path -LiteralPath $f) -and $deletedPaths -notcontains $f.Replace('/', '\') -and $deletedPaths -notcontains $f) {
      throw "待提交路径在工作区中不存在（既无文件也不是已删除项）：$f —— 请检查拼写"
    }
  }
}
if ($DryRun) {
  if ($All) { Write-Host '    [dry-run] git add -A' }
  else { Write-Host "    [dry-run] git add $($Files -join ' ')" }
} else {
  if ($All) {
    git add -A
  } else {
    git add -- @Files
  }
  if ($LASTEXITCODE -ne 0) { throw 'git add 失败' }
  $staged = @(git diff --cached --name-only)
  if ($staged.Count -eq 0) { throw '暂存区为空，没有可提交内容，已中止' }
  foreach ($f in $staged) { Write-Host "  staged: $f" -ForegroundColor DarkGray }
}

# [4/6] 提交
Write-Host ''
Write-Host '==> [4/6] 提交' -ForegroundColor Cyan
if ($DryRun) {
  Write-Host "    [dry-run] git commit -m `"$Message`""
} else {
  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { throw 'git commit 失败' }
}

# [5/6] 推送（-c 仅本条命令绕开全局失效代理，不改配置文件）
Write-Host ''
Write-Host '==> [5/6] 推送（临时绕开全局 7892 失效代理）' -ForegroundColor Cyan
if ($DryRun) {
  Write-Host '    [dry-run] git -c http.proxy= -c https.proxy= push'
} else {
  git -c http.proxy= -c https.proxy= push
  if ($LASTEXITCODE -ne 0) { throw 'git push 失败（检查 Watt Toolkit 加速是否开启）' }
}

# [6/6] 哈希核验
Write-Host ''
Write-Host '==> [6/6] 本地 / 远程哈希核验' -ForegroundColor Cyan
if ($DryRun) {
  Write-Host '    [dry-run] 比对 git rev-parse HEAD 与 ls-remote origin refs/heads/main'
  Write-Host ''
  Write-Host 'DRY-RUN 完成：以上为将执行的全部动作，未做任何改动。' -ForegroundColor Green
} else {
  $local = (git rev-parse HEAD).Trim()
  $remoteLine = git -c http.proxy= -c https.proxy= ls-remote origin refs/heads/main
  if ($LASTEXITCODE -ne 0) { throw 'ls-remote 失败，无法核验远程（提交已产生，请手动检查）' }
  $remote = ($remoteLine -split "`t")[0].Trim()
  Write-Host "local =$local"
  Write-Host "remote=$remote"
  if ($local -ne $remote) {
    throw "HASH MISMATCH：本地与远程不一致，推送可能未完成"
  }
  Write-Host ''
  Write-Host 'MATCH：本地与远程提交完全一致，发布完成。' -ForegroundColor Green
  Write-Host "https://github.com/yuan293/hospital-guide/commit/$local"
}
