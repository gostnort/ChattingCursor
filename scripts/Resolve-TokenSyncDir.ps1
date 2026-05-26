# 解析 token 同步目录：参数/环境变量 > ~/.chattingcursor/config.json > 默认 ~/.chattingcursor

function Get-ChattingCursorHomeDir {
  return Join-Path $HOME ".chattingcursor"
}


function Get-LegacyTokenSyncDir {
  return Join-Path $HOME "ChattingCursorTokenSync"
}


function Read-ChattingCursorUserConfig {
  $configPath = Join-Path (Get-ChattingCursorHomeDir) "config.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    return $null
  }
  try {
    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}


function Resolve-TokenSyncDir {
  param(
    [string]$Override = ""
  )
  if ($Override -and $Override.Trim()) {
    return $Override.Trim()
  }
  $fromEnv = [Environment]::GetEnvironmentVariable("CHATTINGCURSOR_TOKEN_SYNC_DIR")
  if ($fromEnv -and $fromEnv.Trim()) {
    return $fromEnv.Trim()
  }
  $cfg = Read-ChattingCursorUserConfig
  if ($cfg -and $cfg.tokenSyncDir -and [string]$cfg.tokenSyncDir -match '\S') {
    return [string]$cfg.tokenSyncDir.Trim()
  }
  return Get-ChattingCursorHomeDir
}
