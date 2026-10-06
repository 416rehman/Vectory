#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Binary,
  [Parameter(Mandatory=$true)][string]$StateDirectory,
  [Parameter(Mandatory=$true)][System.Management.Automation.PSCredential]$Credential
)
$ErrorActionPreference = 'Stop'
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$statePath = (Resolve-Path -LiteralPath $StateDirectory).Path
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) { throw 'Agent binary must exist.' }
if (-not (Test-Path -LiteralPath $statePath -PathType Container)) { throw 'Agent state directory must exist.' }
if ($binaryPath.Contains('"') -or $statePath.Contains('"')) { throw 'Invalid path quote.' }
if ($Credential.UserName -match '^(LocalSystem|NT AUTHORITY\\SYSTEM|\.\\Administrator)$') { throw 'Use a dedicated least-privileged service account.' }
$command = '"' + $binaryPath + '" service --state-dir "' + $statePath + '"'
$existing = Get-CimInstance Win32_Service -Filter "Name='Vectory'"
if ($existing) {
  if ($existing.PathName -ne $command -or $existing.StartName -ne $Credential.UserName) { throw 'Existing service uses different paths/account. Review before changing it.' }
  Write-Output 'Matching service already registered. State and credentials preserved.'
  return
}
# The operator provisions Log on as a service and grants this account only the
# adopted executable/config/state rights. No ACL widening or Vector takeover here.
New-Service -Name 'Vectory' -DisplayName 'Vectory agent' -Description 'Outbound-only Vector configuration reconciliation' -BinaryPathName $command -Credential $Credential -StartupType Automatic | Out-Null
Write-Output 'Service registered, not started. Review doctor output and adopted Vector ownership before Start-Service Vectory (or vectory service-start).'
