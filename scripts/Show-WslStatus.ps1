# 检查 WSL 状态并提示（Windows 可选；默认 native CLI）

function Show-WslStatusMessage {
  if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "WSL: 未安装（可选）。默认使用本机 CURSOR_CLI_MODE=native。"
    Write-Host "     若要在 WSL 内运行 cursor-agent，见 docs\WSL_SETUP_chn.md"
    return
  }
  Write-Host ""
  Write-Host "WSL: 已安装。"
  try {
    wsl --status 2>&1 | ForEach-Object { Write-Host "  $_" }
  } catch {
    Write-Host "  运行 wsl --status 失败；可在 WSL 内安装 cursor-agent 后设置 CURSOR_CLI_MODE=wsl"
  }
  Write-Host "  默认仍为 native；仅当本机无 cursor-agent 时 install/run 可能自动选 wsl。"
}

Show-WslStatusMessage
