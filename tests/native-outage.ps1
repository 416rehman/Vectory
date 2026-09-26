$ErrorActionPreference='Stop'
$repoRoot=Split-Path $PSScriptRoot -Parent
$native=Get-Content -LiteralPath (Join-Path $repoRoot '.local/preview/native-run.json') | ConvertFrom-Json
$serverPid=[int](Get-Content -LiteralPath (Join-Path $repoRoot '.local/preview/server.pid'))
$serverProcess=Get-Process -Id $serverPid
$previewBinary=Join-Path $repoRoot '.local/bin/vectory-server-preview.exe'
if($serverProcess.Path -ne $previewBinary){throw 'Preview PID does not match its expected executable'}
$agentProcess=Get-Process -Id $native.pid
$expectedAgent=if($native.binary){$native.binary}else{Join-Path $repoRoot 'agent/vectory.exe'}
if($agentProcess.Path -ne $expectedAgent){throw 'Synthetic agent PID does not match its expected executable'}
$helper=Get-CimInstance Win32_Process -Filter "ParentProcessId=$($native.pid)" | Where-Object {$_.ExecutablePath -eq $agentProcess.Path} | Select-Object -First 1
if(!$helper){throw 'Synthetic Vector supervisor not found'}
$child=Get-CimInstance Win32_Process -Filter "ParentProcessId=$($helper.ProcessId)" | Where-Object {$_.ExecutablePath -eq (Join-Path $repoRoot '.local/tools/vector-0.58.0/bin/vector.exe')} | Select-Object -First 1
if(!$child){throw 'Synthetic owned Vector process not found'}
$vectorProcess=Get-Process -Id $child.ProcessId
$restoreBinary=Join-Path $repoRoot '.local/bin/vectory-server-outage-test.exe'
Copy-Item -LiteralPath $previewBinary -Destination $restoreBinary -Force
$before=Get-Content -LiteralPath (Join-Path $native.state 'state.json') | ConvertFrom-Json
$digest=(Get-FileHash -LiteralPath $native.managed -Algorithm SHA256).Hash
$outageStarted=[DateTimeOffset]::UtcNow
try{
  $serverProcess.Kill();$serverProcess.WaitForExit()
  for($i=0;$i -lt 32;$i++){
    Start-Sleep -Seconds 1
    $vectorProcess.Refresh();if($vectorProcess.HasExited){throw 'Vector exited during control-plane outage'}
    if((Get-FileHash -LiteralPath $native.managed -Algorithm SHA256).Hash -ne $digest){throw 'Managed file changed during control-plane outage'}
  }
}finally{& (Join-Path $repoRoot 'packaging/Start-LocalPreview.ps1') -SourceBinary $restoreBinary}
$restoredAt=[DateTimeOffset]::UtcNow
$reconnected=$false
for($i=0;$i -lt 50;$i++){
 Start-Sleep -Seconds 1
 $reported=Get-Content -LiteralPath (Join-Path $native.state 'state.json') | ConvertFrom-Json
 if([DateTimeOffset]::Parse($reported.last_heartbeat) -gt $restoredAt){$reconnected=$true;break}
}
if(!$reconnected){throw 'No renewed successful heartbeat after restoring control plane'}
$vectorProcess.Refresh();if($vectorProcess.HasExited){throw 'Vector exited during reconnection'}
if($reported.reported_generation -ne $before.reported_generation -or $reported.apply_state -ne 'verified_applied'){throw 'Verified generation was not retained'}
$evidence=@{timestamp=[DateTimeOffset]::UtcNow.ToString('o');outage_seconds=32;heartbeat_interval_seconds=10;vector_process_preserved=$true;managed_digest_preserved=$true;generation_preserved=$true;reconnected_after_seconds=[Math]::Round(([DateTimeOffset]::UtcNow-$restoredAt).TotalSeconds,1);platform='Windows amd64';scope='One bounded real native control-plane outage. This does not establish sustained multi-hour outage or power-loss safety.'}
$evidence | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repoRoot 'docs/evidence/native-outage.json')
$evidence | ConvertTo-Json
