@echo off
setlocal
cd /d "%~dp0..\.."
set "ROOT=%CD%"
set "VENV_PY=%ROOT%\.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
  echo .venv not found. Run install.bat from the repo root first.
  exit /b 1
)
echo === Installing local_llm inference dependencies ===
"%VENV_PY%" -m pip install -U pip
"%VENV_PY%" -m pip install -r "%ROOT%\local_llm\server\requirements-inference.txt"
where nvidia-smi >nul 2>&1
if %ERRORLEVEL%==0 (
  echo.
  echo NVIDIA GPU detected. Installing llama-cpp-python cu124 wheel...
  "%VENV_PY%" -m pip install llama-cpp-python --force-reinstall --no-cache-dir --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124
  if errorlevel 1 (
    echo ERROR: failed to install llama-cpp-python cu124 wheel.
    echo Try: "%VENV_PY%" -m pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124
    exit /b 1
  )
) else (
  echo.
  echo nvidia-smi not found. Installing llama-cpp-python CPU prebuilt wheel...
  "%VENV_PY%" -m pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
  if errorlevel 1 (
    echo ERROR: failed to install llama-cpp-python CPU wheel.
    echo Try: "%VENV_PY%" -m pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
    exit /b 1
  )
)
echo.
echo Done. Install GGUF weights in Web Local Models, or run:
echo   python local_llm/server/check_hardware.py
endlocal
