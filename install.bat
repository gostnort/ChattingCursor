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
  if "%EXITCODE%"=="10" (
    echo.
    echo 需要重新打开终端或重启电脑后，cloudflared 才会进入 PATH。
    echo 请重启终端后再运行 run.bat
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Show-WslStatus.ps1"
    pause
    exit /b 10
  )
  echo.
  echo 安装失败，退出码 %EXITCODE%
  pause
  exit /b %EXITCODE%
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Show-WslStatus.ps1"

echo.
echo 正在启动 run.bat ...
call "%~dp0run.bat"
set RUNEXIT=%ERRORLEVEL%
if not "%RUNEXIT%"=="0" (
  echo.
  echo run.bat 退出码 %RUNEXIT%
  pause
  exit /b %RUNEXIT%
)
exit /b 0
