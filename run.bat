@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
rem 默认本机 cursor-agent（非 WSL）；可在系统环境变量中设 CURSOR_CLI_MODE=wsl 覆盖
if not defined CURSOR_CLI_MODE set "CURSOR_CLI_MODE=native"

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
