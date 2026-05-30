# 安装 Cloudflare Tunnel 客户端 cloudflared (Windows)
param(
  [switch]$Force
)

function Test-CloudflaredInstalled {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  return [bool]$cmd
}


function Install-CloudflaredWithWinget {
  Write-Host "Installing cloudflared via winget..."
  winget install Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget install failed with exit code $LASTEXITCODE"
  }
}


if (Test-CloudflaredInstalled) {
  if (-not $Force) {
    Write-Host "cloudflared is already installed:"
    cloudflared --version
    Write-Host ""
    Write-Host "Reinstall: .\scripts\install-cloudflared.ps1 -Force"
    exit 0
  }
  Write-Host "cloudflared found; continuing because -Force was set..."
}

try {
  Install-CloudflaredWithWinget
}
catch {
  Write-Host ""
  Write-Host "Automatic install failed. Download manually:"
  Write-Host "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  Write-Host ""
  Write-Host "After install, reopen PowerShell and run: cloudflared --version"
  exit 1
}

# winget 安装后刷新 PATH
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = "$machinePath;$userPath"

if (-not (Test-CloudflaredInstalled)) {
  Write-Host ""
  Write-Host "Install finished, but cloudflared is not on PATH in this shell."
  Write-Host "Open a new PowerShell window, then run: cloudflared --version"
  exit 10
}

Write-Host ""
Write-Host "Install succeeded:"
cloudflared --version
Write-Host ""
Write-Host "Next:"
Write-Host "  Daily start: .\run.bat"
Write-Host "  Full guide (Chinese): docs\CLOUDFLARE_TUNNEL_SETUP.md"
