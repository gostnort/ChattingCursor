@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
rem 未设置时由 Resolve-CursorCliMode.ps1 探测 native / wsl（不强制 native）

echo Starting Google Chrome with remote debugging port 9222...
start chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-fre "http://127.0.0.1:43210/ChattingCursor/"

where powershell >nul 2>&1
if errorlevel 1 (
  echo PowerShell not found.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-run-all.ps1" %*
set EXITCODE=%ERRORLEVEL%
if "%EXITCODE%"=="2" (
  echo.
  echo [FAIL] Port conflict or cleanup failed. Exit code 2.
  pause
  exit /b 2
)
if not "%EXITCODE%"=="0" (
  echo.
  echo [FAIL] run-all exited with code %EXITCODE%. See messages above.
  pause
  exit /b %EXITCODE%
)
exit /b 0
