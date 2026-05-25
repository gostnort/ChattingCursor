# 远程模式启动：设置公开 Bridge 地址与 token 同步目录，然后启动 Bridge
param(
  [string]$BridgePublicUrl = "https://bridge.example.com",
  [string]$TokenSyncDir = "$HOME\ChattingCursorTokenSync"
)

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$escapedRoot = $Root.Replace("'", "''")
$escapedUrl = $BridgePublicUrl.Replace("'", "''")
$escapedDir = $TokenSyncDir.Replace("'", "''")

Write-Host "远程 Bridge URL: $BridgePublicUrl"
Write-Host "Token 同步目录: $TokenSyncDir"
Write-Host "将打开一个新终端启动 Bridge..."

Start-Process pwsh -ArgumentList @(
  "-NoExit",
  "-Command",
  "Set-Location '$escapedRoot'; `$env:BRIDGE_PUBLIC_URL='$escapedUrl'; `$env:CHATTINGCURSOR_TOKEN_SYNC_DIR='$escapedDir'; pnpm dev:bridge"
)

Write-Host ""
Write-Host "接下来你还需要："
Write-Host "1. 让公网域名转发到本机 Bridge（例如 tunnel）"
Write-Host "2. 在手机网页里填写 Bridge URL"
Write-Host "3. 从同步目录里的 chattingcursor-token.txt 查看当天口令"
