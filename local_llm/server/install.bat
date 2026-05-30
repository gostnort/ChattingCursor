@echo off
setlocal
cd /d "%~dp0..\.."
set "ROOT=%CD%"
set "VENV_PY=%ROOT%\.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
  echo 未找到 .venv，请先运行项目根目录 install.bat
  exit /b 1
)
echo === 安装 local_llm 推理依赖 ===
"%VENV_PY%" -m pip install -U pip
"%VENV_PY%" -m pip install -r "%ROOT%\local_llm\server\requirements-inference.txt"
echo.
echo 完成。请在 Web「本地 - 本地模型」页从 Hugging Face 安装 GGUF，或运行:
echo   python local_llm/server/check_hardware.py
endlocal
