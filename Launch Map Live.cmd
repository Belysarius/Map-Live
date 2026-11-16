@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\package.json" (
  echo Run npm ci in this folder before launching Map Live.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  call npm run setup
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist "dist\renderer.js" (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
