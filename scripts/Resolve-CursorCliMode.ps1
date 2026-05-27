# 仅在未设置 CURSOR_CLI_MODE 时自动选择：本机 cursor-agent 优先，否则 WSL，否则保持未设置由 Bridge 探测
function Test-NativeCursorAgentAvailable {
  if (Get-Command cursor-agent -ErrorAction SilentlyContinue) {
    return $true
  }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\bin\cursor-agent.exe"),
    (Join-Path $env:USERPROFILE ".cursor\bin\cursor-agent.exe"),
    (Join-Path $env:LOCALAPPDATA "cursor-agent\cursor-agent.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $true
    }
  }
  return $false
}


function Test-WslCursorAgentAvailable {
  if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    return $false
  }
  $script = 'export PATH="$HOME/.local/bin:$PATH"; command -v cursor-agent'
  $output = & wsl bash -lc $script 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $false
  }
  $line = ($output | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Last 1)
  return [bool]($line -and $line.StartsWith("/"))
}


function Initialize-CursorCliMode {
  if ($env:CURSOR_CLI_MODE) {
    return
  }
  if (Test-NativeCursorAgentAvailable) {
    $env:CURSOR_CLI_MODE = "native"
    return
  }
  if (Test-WslCursorAgentAvailable) {
    $env:CURSOR_CLI_MODE = "wsl"
  }
}
