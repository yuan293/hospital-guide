@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install from https://nodejs.org/
  pause
  exit /b 1
)
echo Starting Hospital Guide...
echo Open the URL shown below in your browser.
echo Keep this window open. Press Ctrl+C to stop.
node server.js
pause
