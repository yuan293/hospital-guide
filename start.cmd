@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem 诊途 · 启动脚本
rem Node 查找顺序（三层回退）：
rem   1) 项目自带便携版 .runtime\node\node.exe —— 评委无需安装 Node
rem   2) 系统已安装的 node（PATH 中）
rem   3) 都找不到才提示获取方式
rem ---------------------------------------------------------------------------

if exist ".runtime\node\node.exe" (
  set "PATH=%CD%\.runtime\node;%PATH%"
  echo [runtime] 使用项目自带 Node：.runtime\node\node.exe
  .runtime\node\node.exe --version
  echo Starting Hospital Guide...
  echo Open the URL shown below in your browser.
  echo Keep this window open. Press Ctrl+C to stop.
  .runtime\node\node.exe server.js
  pause
  exit /b 0
)

where node >nul 2>nul
if not errorlevel 1 (
  echo [runtime] 使用系统已安装的 Node
  node --version
  echo Starting Hospital Guide...
  echo Open the URL shown below in your browser.
  echo Keep this window open. Press Ctrl+C to stop.
  node server.js
  pause
  exit /b 0
)

echo.
echo  未找到 Node.js，且本目录下也没有自带的便携版。
echo  任选其一即可：
echo    (a) 解压提交材料中的 .runtime.zip，把 .runtime 目录放到本目录下（与 package.json 同级）；
echo    (b) 从 https://nodejs.org/ 下载 LTS 版本，安装后重新打开本窗口。
echo.
pause
exit /b 1
