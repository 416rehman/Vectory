param([int]$WebPort=8080,[int]$AgentPort=8443,[switch]$Restart,[string]$SourceBinary)
$ErrorActionPreference='Stop'
$repoRoot=Split-Path $PSScriptRoot -Parent
$previewRoot=Join-Path $repoRoot '.local/preview'
$runtimeRoot=Join-Path $repoRoot '.local/bin'
New-Item -ItemType Directory -Force $previewRoot,$runtimeRoot | Out-Null
$previewSourceBinary=if($SourceBinary){(Resolve-Path -LiteralPath $SourceBinary).Path}else{Join-Path $repoRoot 'server/target/debug/vectory-server.exe'}
$runningBinary=Join-Path $runtimeRoot 'vectory-server-preview.exe'
$pidFile=Join-Path $previewRoot 'server.pid'
if(Test-Path -LiteralPath $pidFile){
  $existing=Get-Process -Id ([int](Get-Content -LiteralPath $pidFile)) -ErrorAction SilentlyContinue
  if($existing){
    if($existing.Path -ne $runningBinary){throw 'Recorded PID belongs to an unexpected executable. Inspect it before restarting.'}
    if(!$Restart){Write-Output "Existing local development preview is running (PID $($existing.Id)). Use -Restart after rebuilding.";return}
    Stop-Process -Id $existing.Id
    $existing.WaitForExit()
  }
}
Copy-Item -LiteralPath $previewSourceBinary -Destination $runningBinary -Force
$secretPath=Join-Path $previewRoot 'bootstrap.secret'
if(!(Test-Path -LiteralPath $secretPath)){
  $randomBytes=New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($randomBytes)
  [IO.File]::WriteAllText($secretPath,[Convert]::ToBase64String($randomBytes))
}
$env:VECTORY_DATA_DIR=Join-Path $previewRoot 'state'
$env:VECTORY_DEVELOPMENT='true'
$env:VECTORY_COOKIE_SECURE='false'
$env:VECTORY_BOOTSTRAP_SECRET_FILE=$secretPath
$env:VECTORY_TLS_CERT=Join-Path $repoRoot '.local/pki/server.pem'
$env:VECTORY_TLS_KEY=Join-Path $repoRoot '.local/pki/server-key.pem'
$env:VECTORY_HTTP_ADDR="127.0.0.1:$WebPort"
$env:VECTORY_AGENT_ADDR="127.0.0.1:$AgentPort"
$env:VECTORY_DASHBOARD_DIR=Join-Path $repoRoot 'dashboard/dist'
$env:VECTORY_RELEASES_DIR=Join-Path $repoRoot 'artifacts/releases'
$env:VECTORY_INSTANCE_NAME='Local verification workspace'
$process=Start-Process -FilePath $runningBinary -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $previewRoot 'server.log') -RedirectStandardError (Join-Path $previewRoot 'server-error.log')
[IO.File]::WriteAllText((Join-Path $previewRoot 'server.pid'),[string]$process.Id)
Write-Output "Local development preview started: http://127.0.0.1:$WebPort (PID $($process.Id))."
Write-Output 'Development cookies are intentionally loopback-only. Agent TLS remains verified.'
