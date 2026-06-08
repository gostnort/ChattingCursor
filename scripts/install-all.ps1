# 一键安装：Node 依赖、shared 构建、cloudflared
param(
  [switch]$SkipCloudflared
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$script:NeedsShellRestart = $false

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


function Ensure-PythonVenv {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) {
    Write-Host "未检测到 Python；跳过 local_llm 可选依赖（核心聊天不依赖 Python）。"
    return
  }
  $localLlmInstall = Join-Path $Root "local_llm\server\install.bat"
  if (Test-Path -LiteralPath $localLlmInstall) {
    Write-Step "Installing local_llm inference deps (llama-cpp-python, fastapi, etc.)..."
    & cmd /c $localLlmInstall
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
    Write-Host "  local_llm uses GGUF + llama.cpp; install weights in Web Local Models"
  }
}


Write-Host "=== ChattingCursor 安装 ==="
Write-Host "项目目录: $Root"

if (-not (Test-NodeReady)) {
  Write-Host ""
  Write-Host "未检测到 Node.js 20+。请先安装: https://nodejs.org/"
  Write-Host "安装后重新运行 install.bat"
  exit 1
}

Ensure-PythonVenv

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
  if ($LASTEXITCODE -eq 10) {
    $script:NeedsShellRestart = $true
  } elseif ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Write-Host ""
Write-Host "安装完成。"
Write-Host "local_llm optional: run local_llm\server\install.bat for inference deps (install GGUF weights in Web Local Models)"
Write-Host "下一步: 双击 run.bat 或运行 .\run.bat"
$homeHint = if ($env:USERPROFILE) { "$env:USERPROFILE\.chattingcursor" } else { "~/.chattingcursor" }
Write-Host "手机远程: 默认 token 为 ${homeHint}\chattingcursor-<主机名>-token.txt；可放进云盘或于配置页改路径。"
Write-Host ""

if ($script:NeedsShellRestart) {
  exit 10
}
