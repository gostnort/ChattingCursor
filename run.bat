@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
  echo PowerShell not found.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-all.ps1" %*
set EXITCODE=%ERRORLEVEL%
if "%EXITCODE%"=="2" exit /b 2
if not "%EXITCODE%"=="0" exit /b %EXITCODE%
exit /b 0
