# 诊途 · 改动后标准验证链（fail-closed，兼容 Windows PowerShell 5.1+）
# 用法：
#   powershell -ExecutionPolicy Bypass -File verify-chain.ps1         快速链
#   powershell -ExecutionPolicy Bypass -File verify-chain.ps1 -Full   完整链（约数分钟，需 Ollama 就绪）
# 任一步失败立即停止并返回退出码 1。
param(
  [switch]$Full
)
$ErrorActionPreference = 'Stop'

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
  throw '未找到诊途项目根（沿脚本向上找不到 name=hospital-guide-prototype 的 package.json）'
}

# failedIds 白名单门禁由 Node 实现（PowerShell 5.1 的 ConvertFrom-Json 有长度上限，
# 读不下含逐轮轨迹的 latest.json）。白名单维护在 gate-failures.mjs 中。
function Assert-FailureGate {
  param([string]$ReportPath)
  if (-not (Test-Path $ReportPath)) { throw "评测报告不存在：$ReportPath" }
  $gate = Join-Path $PSScriptRoot 'gate-failures.mjs'
  & node $gate $ReportPath
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

$root = Find-ProjectRoot
Set-Location $root
Write-Host "项目根：$root" -ForegroundColor DarkGray

$steps = @(
  @{ Name = '单元测试（node --test）'; Script = 'test' },
  @{ Name = '数据 fail-closed 校验';   Script = 'run'; Args = @('data:validate') },
  @{ Name = '无模型评测（rules + dynamic）'; Script = 'run'; Args = @('evaluate'); Gate = $true }
)
if ($Full) {
  $steps += @{ Name = '双模型全量评测（7B + 1.5B，约数分钟）'; Script = 'run'; Args = @('evaluate:models'); Gate = $true }
  $steps += @{ Name = '双模型诱导红队（模型层不安全/漏诊即退出码1）'; Script = 'run'; Args = @('redteam:models') }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$n = 0
foreach ($step in $steps) {
  $n++
  Write-Host ''
  Write-Host "==> [$n/$($steps.Count)] $($step.Name)" -ForegroundColor Cyan
  if ($step.Script -eq 'test') {
    & npm test
  } else {
    $npmArgs = $step.Args
    & npm run @npmArgs
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "验证链在「$($step.Name)」失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
    exit 1
  }
  if ($step.Gate) { Assert-FailureGate -ReportPath (Join-Path $root 'data/evaluation/latest.json') }
}
$sw.Stop()

Write-Host ''
Write-Host ("全部通过（{0}），耗时 {1:N1} 分钟。" -f ($(if ($Full) { '完整链' } else { '快速链' })), $sw.Elapsed.TotalMinutes) -ForegroundColor Green
Write-Host '提醒：改了指纹文件后还需重启 3210 服务并核对 /api/health 版本；前端改动需浏览器走查。' -ForegroundColor Yellow
