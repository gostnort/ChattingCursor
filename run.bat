@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === ChattingCursor 启动 ===
echo 将启动 Bridge 与 cloudflared，并自动更新 token 文件中的公网地址。
echo Stop: press Ctrl+C
echo.

where powershell >nul 2>&1
if errorlevel 1 (
  echo 未找到 PowerShell，无法继续。
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-all.ps1" %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo 启动失败，退出码 %EXITCODE%
  pause
  exit /b %EXITCODE%
)
exit /b 0
