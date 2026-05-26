# 命名隧道: 需要 Cloudflare 账号 + 已接入 Cloudflare 的域名
param(
  [Parameter(Mandatory = $true)]
  [string]$Hostname,
  [string]$TunnelName = "chattingcursor-bridge",
  [int]$BridgePort = 4321,
  [string]$TokenSyncDir = "",
  [switch]$SkipBridge
)

. (Join-Path $PSScriptRoot "Resolve-TokenSyncDir.ps1")
$TokenSyncDir = Resolve-TokenSyncDir -Override $TokenSyncDir

$Root = Split-Path -Parent $PSScriptRoot
$CloudflaredDir = Join-Path $HOME ".cloudflared"
$ConfigPath = Join-Path $CloudflaredDir "config.yml"
$PublicUrl = "https://$Hostname"
$escapedRoot = $Root.Replace("'", "''")
$escapedUrl = $PublicUrl.Replace("'", "''")
$escapedDir = $TokenSyncDir.Replace("'", "''")
$bridgeShell = "powershell"

function Test-CloudflaredInstalled {
  return [bool](Get-Command cloudflared -ErrorAction SilentlyContinue)
}


if (-not (Test-CloudflaredInstalled)) {
  Write-Host "cloudflared not found. Run: .\scripts\install-cloudflared.ps1"
  exit 1
}

if (-not (Test-Path $ConfigPath)) {
  Write-Host "Missing config: $ConfigPath"
  Write-Host "Follow docs\CLOUDFLARE_TUNNEL_SETUP.md or copy scripts\cloudflared-example.yml"
  exit 1
}

Write-Host "=== ChattingCursor named tunnel ==="
Write-Host "Public Bridge URL: $PublicUrl"
Write-Host "Config: $ConfigPath"
Write-Host ""

if (-not $SkipBridge) {
  Write-Host "Starting Bridge in a new window..."
  Start-Process $bridgeShell -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$escapedRoot'; `$env:BRIDGE_PUBLIC_URL='$escapedUrl'; `$env:CHATTINGCURSOR_TOKEN_SYNC_DIR='$escapedDir'; pnpm dev:bridge"
  )
  Start-Sleep -Seconds 2
}

Write-Host "Phone setup:"
Write-Host "  1. https://gostnort.github.io/ChattingCursor/"
Write-Host "  2. local -> config -> Bridge URL = $PublicUrl"
Write-Host "  3. Token: $TokenSyncDir\chattingcursor-token.txt"
Write-Host ""
Write-Host "Verify: $PublicUrl/auth/status"
Write-Host ""

cloudflared tunnel run $TunnelName
