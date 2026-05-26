@echo off
cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
  echo PowerShell not found.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\shutdown-all.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" exit /b %EXITCODE%
exit /b 0
