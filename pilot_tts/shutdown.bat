@echo off
:: 切换到当前脚本所在的目录
cd /d "%~dp0"

:: 查找并杀死占用 4323 端口（API 服务）的进程
echo Stopping API service on port 4323...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4323 ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>&1
)

:: 查找并杀死占用 8090 端口（WebUI 测试/调试界面）的进程
echo Stopping WebUI service on port 8090...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8090 ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>&1
)

echo [OK] Shutdown complete.
