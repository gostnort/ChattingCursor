# 读取 ~/.chattingcursor/cloudflare-tunnel.json；配置齐全时启用命名隧道

function Get-ChattingCursorHomeDir {
  return Join-Path $HOME ".chattingcursor"
}


function Get-CloudflareTunnelConfigPath {
  return Join-Path (Get-ChattingCursorHomeDir) "cloudflare-tunnel.json"
}


function Read-NamedCloudflareTunnelConfig {
  $fromEnvName = [Environment]::GetEnvironmentVariable("CHATTINGCURSOR_TUNNEL_NAME")
  $fromEnvHost = [Environment]::GetEnvironmentVariable("CHATTINGCURSOR_TUNNEL_HOSTNAME")
  if ($fromEnvName -and $fromEnvName.Trim() -and $fromEnvHost -and $fromEnvHost.Trim()) {
    $hostName = $fromEnvHost.Trim().TrimStart("https://", "http://").TrimEnd("/")
    return [PSCustomObject]@{
      TunnelName     = $fromEnvName.Trim()
      PublicHostname = $hostName
      PublicBridgeUrl = "https://$hostName"
      AccountId      = ""
      CredentialsFilePath = ""
      TunnelToken    = ""
      Source         = "env"
    }
  }
  $configPath = Get-CloudflareTunnelConfigPath
  if (-not (Test-Path -LiteralPath $configPath)) {
    return $null
  }
  try {
    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    $cfg = $raw | ConvertFrom-Json
  } catch {
    return $null
  }
  if (-not $cfg) {
    return $null
  }
  $tunnelName = [string]$cfg.tunnelName
  $publicHostname = [string]$cfg.publicHostname
  if (-not ($tunnelName -match '\S') -or -not ($publicHostname -match '\S')) {
    return $null
  }
  $hostName = $publicHostname.Trim().TrimStart("https://", "http://").TrimEnd("/")
  return [PSCustomObject]@{
    TunnelName          = $tunnelName.Trim()
    PublicHostname      = $hostName
    PublicBridgeUrl     = "https://$hostName"
    AccountId           = [string]$cfg.accountId
    CredentialsFilePath = [string]$cfg.credentialsFilePath
    TunnelToken         = [string]$cfg.tunnelToken
    Source              = "file"
  }
}
