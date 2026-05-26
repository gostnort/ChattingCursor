# 一键安装：Node 依赖、shared 构建、cloudflared
param(
  [switch]$SkipCloudflared
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message"
}


function Test-NodeReady {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    return $false
  }
  $versionText = (node -v).TrimStart("v")
  $major = [int]($versionText.Split(".")[0])
  return $major -ge 20
}


function Ensure-Pnpm {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpm) {
    return
  }
  Write-Step "启用 corepack 并安装 pnpm..."
  corepack enable
  corepack prepare pnpm@9.15.9 --activate
}


Write-Host "=== ChattingCursor 安装 ==="
Write-Host "项目目录: $Root"

if (-not (Test-NodeReady)) {
  Write-Host ""
  Write-Host "未检测到 Node.js 20+。请先安装: https://nodejs.org/"
  Write-Host "安装后重新运行 install.bat"
  exit 1
}

Write-Step "安装 pnpm 依赖..."
Ensure-Pnpm
pnpm install
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Step "构建 shared 包..."
pnpm --filter @chatting-cursor/shared build
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (-not $SkipCloudflared) {
  Write-Step "安装 cloudflared（隧道客户端）..."
  & "$PSScriptRoot\install-cloudflared.ps1"
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Write-Host ""
Write-Host "安装完成。"
Write-Host "下一步: 双击 run.bat 或运行 .\run.bat"
Write-Host "手机远程: 把 token 同步目录放进云盘，从 chattingcursor-token.txt 复制 URL 与口令。"
Write-Host ""
