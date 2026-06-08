@echo off
:: 切换到当前脚本所在的目录
cd /d "%~dp0"

:: 检查虚拟环境和 upstream 目录是否存在
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found. Please run install.bat first.
    if not "%PILOT_TTS_INSTALL_NONINTERACTIVE%"=="1" pause
    exit /b 1
)
if not exist "upstream\webui.py" (
    echo [ERROR] Upstream source files not found. Please run install.bat first.
    if not "%PILOT_TTS_INSTALL_NONINTERACTIVE%"=="1" pause
    exit /b 1
)

:: 根据参数决定启动 API 还是 WebUI，默认启动 WebUI
if "%1"=="api" (
    echo [INFO] Starting PilotTTS API Service on port 4323...
    cd upstream
    ..\.venv\Scripts\python.exe api.py --port 4323
) else (
    echo [INFO] Starting PilotTTS WebUI on port 4324...
    cd upstream
    ..\.venv\Scripts\python.exe webui.py --server_port 4324
)
