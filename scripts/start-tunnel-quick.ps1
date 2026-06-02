# 快速隧道: 无需 Cloudflare 账号和域名, 适合第一次试通
param(
  [int]$BridgePort = 4321,
  [string]$BridgePublicUrl = "",
  [string]$TokenSyncDir = "",
  [switch]$SkipBridge
)

. (Join-Path $PSScriptRoot "Resolve-TokenSyncDir.ps1")
. (Join-Path $PSScriptRoot "Get-TokenFileName.ps1")
$TokenSyncDir = Resolve-TokenSyncDir -Override $TokenSyncDir
$TokenFilePath = Get-ChattingCursorTokenFilePath -TokenSyncDir $TokenSyncDir

$Root = Split-Path -Parent $PSScriptRoot
$escapedRoot = $Root.Replace("'", "''")
$escapedDir = $TokenSyncDir.Replace("'", "''")
$bridgeShell = "powershell"

function Test-CloudflaredInstalled {
  return [bool](Get-Command cloudflared -ErrorAction SilentlyContinue)
}


if (-not (Test-CloudflaredInstalled)) {
  Write-Host "cloudflared not found. Run: .\scripts\install-cloudflared.ps1"
  exit 1
}

Write-Host "=== ChattingCursor quick tunnel ==="
Write-Host ""
Write-Host "This exposes http://127.0.0.1:$BridgePort as a public HTTPS URL."
Write-Host "Look for https://....trycloudflare.com in this window."
Write-Host "The URL changes every time you restart cloudflared."
Write-Host ""

if (-not $SkipBridge) {
  Write-Host "Starting Bridge in a new window..."
  $bridgeCommand = "Set-Location '$escapedRoot'; "
  if ($BridgePublicUrl) {
    $escapedUrl = $BridgePublicUrl.Replace("'", "''")
    $bridgeCommand += "`$env:BRIDGE_PUBLIC_URL='$escapedUrl'; "
  }
  $bridgeCommand += "`$env:CHATTINGCURSOR_TOKEN_SYNC_DIR='$escapedDir'; pnpm dev:bridge"
  Start-Process $bridgeShell -ArgumentList @("-NoExit", "-Command", $bridgeCommand)
  Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "After you copy the trycloudflare URL:"
Write-Host "  1. Optional: .\scripts\start-remote.ps1 -BridgePublicUrl `"YOUR_URL`""
Write-Host "  2. Phone: https://gostnort.github.io/ChattingCursor/ -> local -> config"
Write-Host "  3. Bridge URL = your trycloudflare HTTPS URL"
Write-Host "  4. Token file: $TokenFilePath"
Write-Host ""
Write-Host "Verify: open https://YOUR_URL/auth/status in a browser"
Write-Host "Press Ctrl+C to stop the tunnel."
Write-Host ""

cloudflared tunnel --url "http://127.0.0.1:$BridgePort"
