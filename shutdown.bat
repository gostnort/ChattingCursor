@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === ChattingCursor 停止服务 ===
echo 将停止 Bridge、cloudflared，以及本项目的 Web 开发服务器（若在运行）。
echo.

where powershell >nul 2>&1
if errorlevel 1 (
  echo 未找到 PowerShell，无法继续。
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\shutdown-all.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo 停止脚本异常，退出码 %EXITCODE%
  pause
  exit /b %EXITCODE%
)
exit /b 0
