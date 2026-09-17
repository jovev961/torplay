#Requires -RunAsAdministrator

param(
  [ValidateRange(1, 65535)]
  [int]$PublicPort = 80,

  [string]$NodePath,

  [switch]$Remove
)

$ErrorActionPreference = "Stop"

if (-not $NodePath) {
  $nodeCommand = Get-Command node.exe -ErrorAction Stop
  $NodePath = $nodeCommand.Source
}

$rules = @(
  @{
    Name = "TorPlay-HTTP-Private"
    DisplayName = "TorPlay HTTP (Private LAN)"
    Protocol = "TCP"
    LocalPort = $PublicPort
  },
  @{
    Name = "TorPlay-mDNS-Private"
    DisplayName = "TorPlay mDNS (Private LAN)"
    Protocol = "UDP"
    LocalPort = 5353
  }
)

if ($Remove) {
  foreach ($rule in $rules) {
    Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule
  }
  Write-Host "TorPlay firewall rules were removed."
  exit 0
}

if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "TorPlay Node runtime was not found at $NodePath."
}

foreach ($rule in $rules) {
  Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule

  New-NetFirewallRule `
    -Name $rule.Name `
    -DisplayName $rule.DisplayName `
    -Description "Allows TorPlay only on the local Private network." `
    -Enabled True `
    -Direction Inbound `
    -Action Allow `
    -Profile Private `
    -Program $NodePath `
    -Protocol $rule.Protocol `
    -LocalPort $rule.LocalPort `
    -RemoteAddress LocalSubnet `
    -EdgeTraversalPolicy Block | Out-Null
}

Write-Host "TorPlay firewall rules are ready for TCP $PublicPort and UDP 5353 on Private networks."
