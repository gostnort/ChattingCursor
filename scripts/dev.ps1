# 本地开发：分别启动 Bridge 与 Web（Windows）
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Write-Host "启动 Bridge (3000) 与 Web (5173)..."
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location '$Root'; pnpm dev:bridge"
Start-Sleep -Seconds 2
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location '$Root'; pnpm dev:web"
Write-Host "请在浏览器打开: http://127.0.0.1:5173/ChattingCursor/"
