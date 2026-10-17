@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS from https://nodejs.org first.
  pause
  exit /b 1
)
if not exist node_modules\express\package.json (
  echo Installing dependencies for the first run...
  call npm.cmd ci --no-fund --no-audit
  if errorlevel 1 (
    echo Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
echo Pocket Crawler now runs as an MCP server inside Codex and Claude.
echo Generating connection settings for this computer...
node scripts/connection-config.mjs
echo.
echo Use the generated registration commands above, then restart your AI app.
echo You do not need to open a web browser or keep this window running.
pause
