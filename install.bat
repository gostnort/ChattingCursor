@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === ChattingCursor 安装 ===
echo.

where powershell >nul 2>&1
if errorlevel 1 (
  echo 未找到 PowerShell，无法继续。
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-all.ps1"
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo 安装失败，退出码 %EXITCODE%
  pause
  exit /b %EXITCODE%
)

echo.
echo 安装成功。日常请运行 run.bat
pause
exit /b 0
