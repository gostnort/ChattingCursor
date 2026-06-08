@echo off

setlocal

cd /d "%~dp0"

echo.
echo PilotTTS 安装：上游代码、Python 依赖，以及可选 Hugging Face 语音权重（约 3-5 GB）。
echo 权重下载完成后，请在应用「本地 - 语音」页勾选「启用朗读 API」。
echo.

where py >nul 2>&1

if %ERRORLEVEL%==0 (

  py -3.10 "%~dp0install.py" %*

  if not errorlevel 1 goto :finish

  py -3.11 "%~dp0install.py" %*

  if not errorlevel 1 goto :finish

)

python "%~dp0install.py" %*

if errorlevel 1 exit /b 1

:finish

echo.

echo 安装完成。请重启 Bridge，并在「本地 - 语音」页勾选「启用朗读 API」。

endlocal
