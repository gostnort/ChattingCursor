@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%PILOT_TTS_INSTALL_NONINTERACTIVE%"=="1" (
    if %EXITCODE% neq 0 (
        pause
    )
)
exit /b %EXITCODE%
