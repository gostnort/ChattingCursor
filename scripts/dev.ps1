# Local development: start Bridge and Web separately (Windows)
param(
  [switch]$WithQualityWatch
)

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Write-Host "Starting Bridge (4321) and Web (43210)..."
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location '$Root'; pnpm dev:bridge"
Start-Sleep -Seconds 2
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location '$Root'; pnpm dev:web"
if ($WithQualityWatch) {
  Start-Sleep -Seconds 2
  Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location '$Root'; pnpm quality:watch"
  Write-Host "Quality watcher started in a separate terminal (pnpm quality:watch)."
}
Write-Host "Open in browser: http://127.0.0.1:43210/ChattingCursor/"
