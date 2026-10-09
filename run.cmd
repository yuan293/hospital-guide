@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem 诊途 · 命令入口（评委用）
rem 免安装：优先使用项目自带便携版 Node，其次使用系统 Node。
rem
rem 用法：
rem   run.cmd test            -> 跑单元测试（预期 87/87）
rem   run.cmd verify          -> 跑免模型验证链（预期「全部通过（快速链）」）
rem   run.cmd verify:full     -> 跑完整链（含双模型评测，需 .runtime 内有模型）
rem   run.cmd models:check    -> 冒烟验证两个模型可用
rem   run.cmd fhir:export     -> 导出 FHIR 资源
rem   run.cmd                -> 不带参数时跑 verify
rem ---------------------------------------------------------------------------

set "NODE_EXE="
set "NODE_DIR="

if exist ".runtime\node\node.exe" (
  set "NODE_EXE=.runtime\node\node.exe"
  set "NODE_DIR=%CD%\.runtime\node"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  未找到 Node.js，且本目录下也没有自带的便携版。
    echo  任选其一：
    echo    (a) 解压提交材料中的 .runtime.zip，把 .runtime 目录放到本目录下；
    echo    (b) 从 https://nodejs.org/ 下载 LTS 版本后重开本窗口。
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

set "TASK=%~1"
if "%TASK%"=="" set "TASK=verify"
if /i "%TASK%"=="--no-pause" (
  set "TASK=%~2"
  if "%TASK%"=="" set "TASK=verify"
  set "NOPAUSE=1"
)

echo [runtime] %NODE_EXE%
if not "%NODE_DIR%"=="" set "PATH=%NODE_DIR%;%PATH%"

if /i "%TASK%"=="test" (
  "%NODE_EXE%" --test
  goto :done
)
if /i "%TASK%"=="verify" (
  "%NODE_EXE%" scripts/verify-chain.mjs
  goto :done
)
if /i "%TASK%"=="verify:full" (
  "%NODE_EXE%" scripts/verify-chain.mjs --full
  goto :done
)
if /i "%TASK%"=="models:check" (
  "%NODE_EXE%" scripts/check-models.js
  goto :done
)
if /i "%TASK%"=="fhir:export" (
  "%NODE_EXE%" scripts/export-fhir-resources.js
  goto :done
)

rem 其余 npm 脚本（models:setup / models:pull / evaluate:models / redteam:models 等）走 npm
where npm >nul 2>nul
if errorlevel 1 (
  echo 该命令需要通过 npm 执行，但当前环境未找到 npm。
  echo 请安装完整版 Node.js（https://nodejs.org/），或改用上面列出的免安装命令。
  pause
  exit /b 1
)
call npm run %*

:done
echo.
if not "%NOPAUSE%"=="1" pause
exit /b %ERRORLEVEL%
