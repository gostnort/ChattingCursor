@echo off
:: PilotTTS 独立测试启动脚本（非 ChattingCursor 生产路径）
::   默认：upstream\webui.py --port 8090 → http://127.0.0.1:8090（Gradio 测试/调试）
::   api：server\tts_server.py → http://127.0.0.1:4323（手动验证朗读 API）
:: ChattingCursor 生产朗读由 Bridge 拉起 tts_server.py:4323，不经过本脚本默认分支。
cd /d "%~dp0"

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

if "%1"=="api" (
    echo [INFO] Starting PilotTTS API Service on port 4323 ^(manual test; production uses Bridge^)...
    echo [INFO] URL: http://127.0.0.1:4323/health
    set "PILOT_TTS_PORT=4323"
    set "PILOT_TTS_AUTO_LOAD=0"
    .venv\Scripts\python.exe server\tts_server.py
) else (
    echo [INFO] Starting PilotTTS WebUI on port 8090 ^(test/debug only^)...
    echo [INFO] URL: http://127.0.0.1:8090
    echo [NOTE] ChattingCursor read-aloud uses Bridge -^> tts_server.py:4323, not this WebUI.
    cd upstream
    set "GRADIO_SERVER_NAME=127.0.0.1"
    set "GRADIO_SERVER_PORT=8090"
    set "SERVER_NAME=127.0.0.1"
    set "SERVER_PORT=8090"
    ..\.venv\Scripts\python.exe webui.py --port 8090
)
