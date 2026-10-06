# Focused boundary checks for native PowerShell installer functions.
# No network, Docker daemon, certificates or host activation are involved.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'install.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Installer syntax failed.' }
if ($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ieq 'docker' },$false).Count) { throw 'Installer must not shadow the external Docker command.' }
foreach ($functionAst in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] },$false)) {
    # Only functions from this tracked installer, never external text.
    Invoke-Expression $functionAst.Extent.Text
}
$area = Join-Path ([IO.Path]::GetTempPath()) ('vectory-powershell-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $area | Out-Null
$passed = 0
function Need([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Refusal([scriptblock]$Operation) {
    $refused = $false
    try { & $Operation } catch { $refused = $_.Exception.Message.StartsWith('Vectory:') }
    Need $refused 'A malformed input was not refused by the installer boundary.'
}
try {
    $file = Join-Path $area 'kit.bin'; [IO.File]::WriteAllText($file,'synthetic fixture')
    $inventory = Join-Path $area 'SHA256SUMS'
    $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($inventory,"$digest  kit.bin`n")
    Checksum $inventory 'kit.bin' $file
    $passed++
    [IO.File]::WriteAllText($inventory,"$digest  kit.bin`n$digest  kit.bin`n")
    Refusal { Checksum $inventory 'kit.bin' $file }; $passed++
    [IO.File]::WriteAllText($inventory,('0' * 64 + "  kit.bin`n"))
    Refusal { Checksum $inventory 'kit.bin' $file }; $passed++
    Refusal { Checksum $inventory '../outside.bin' $file }; $passed++
    $release = 'http://127.0.0.1:1'
    $destination = Join-Path $area 'download'
    Refusal { Download 'kit.bin' $destination 100 }
    Need (-not (Test-Path -LiteralPath $destination)) 'HTTP download created a destination.'
    Need (-not (Test-Path -LiteralPath "$destination.part")) 'HTTP refusal retained a partial download.'
    $passed++
    $Directory = $area; $Project = 'fixture-vectory'
    $envFile = Join-Path $area '.env'; $platformFile = Join-Path $area '.desktop-platform.yaml'
    $composeFile = Join-Path $area 'compose.auto.yaml'
    $script:dockerArguments = $null
    function Invoke-Docker([string[]]$Arguments) {
        Need ($null -eq [Environment]::GetEnvironmentVariable('VECTORY_SERVER_IMAGE','Process')) 'Compose inherited an unverified image override.'
        Need ($null -eq [Environment]::GetEnvironmentVariable('VECTORY_HOSTNAME','Process')) 'Compose inherited a stale hostname.'
        $script:dockerArguments = $Arguments
    }
    $env:VECTORY_SERVER_IMAGE = 'attacker:latest'; $env:VECTORY_HOSTNAME = 'attacker.invalid'
    Compose @('config','--quiet')
    Need ($env:VECTORY_SERVER_IMAGE -eq 'attacker:latest' -and $env:VECTORY_HOSTNAME -eq 'attacker.invalid') 'Process settings were not restored.'
    Need ($script:dockerArguments -contains $platformFile -and $script:dockerArguments -contains $envFile -and $script:dockerArguments -contains $Project) 'Compose omitted retained state or explicit platform override.'
    Remove-Item Env:VECTORY_SERVER_IMAGE; Remove-Item Env:VECTORY_HOSTNAME
    $passed++
    $pemFile = Join-Path $area 'certificate.pem'
    [IO.File]::WriteAllText($pemFile,"-----BEGIN CERTIFICATE-----`nU1lOVEhFVElD`n-----END CERTIFICATE-----`n")
    Need ((Pem $pemFile 1024).StartsWith('-----BEGIN CERTIFICATE-----')) 'ASCII PEM was refused before cryptographic validation.'
    [IO.File]::WriteAllBytes($pemFile,@(255,0,42))
    Refusal { Pem $pemFile 1024 }; $passed++
    PrivateText $envFile "VECTORY_HOSTNAME=vectory.example.com`n"
    $beforeAcl = (Get-Acl -LiteralPath $envFile).Sddl
    PrivateText $envFile "VECTORY_HOSTNAME=vectory.example.com`nVECTORY_PUBLIC_AGENT_DOWNLOADS=false`n"
    Need ((Get-Acl -LiteralPath $envFile).Sddl -eq $beforeAcl) 'Retained settings ACLs changed on update.'
    Need ((Get-Acl -LiteralPath $envFile).AreAccessRulesProtected) 'Fresh settings ACLs inherited broader grants.'
    $passed++
    if ($PSVersionTable.PSEdition -eq 'Desktop') {
        $collector = Join-Path $area 'argument collector.exe'
        Add-Type -TypeDefinition 'using System; using System.Text; public class ArgCollector { public static void Main(string[] args) { foreach (string arg in args) Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(arg))); } }' -OutputAssembly $collector -OutputType ConsoleApplication
        $expectedArguments = @('one argument with spaces','test "$(wc -c < /run/secrets/bootstrap)" -eq 65','C:\a folder\','embedded"quote','backslash\"quote','','$literal & | > ;')
        $nativeStart = New-Object Diagnostics.ProcessStartInfo
        $nativeStart.FileName = $collector
        $nativeStart.Arguments = ($expectedArguments | ForEach-Object { NativeArgument $_ }) -join ' '
        $nativeStart.UseShellExecute = $false; $nativeStart.CreateNoWindow = $true; $nativeStart.RedirectStandardOutput = $true
        $nativeProcess = [Diagnostics.Process]::Start($nativeStart)
        try {
            $encoded = $nativeProcess.StandardOutput.ReadToEnd(); $nativeProcess.WaitForExit()
            Need ($nativeProcess.ExitCode -eq 0) 'Argument collector failed.'
            $argumentLines = @($encoded.TrimEnd("`r","`n") -split "`r?`n")
            Need ($argumentLines.Count -eq $expectedArguments.Count) 'Native process dropped an argument.'
            for ($index=0; $index -lt $expectedArguments.Count; $index++) {
                $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($argumentLines[$index]))
                Need ($decoded -ceq $expectedArguments[$index]) 'Win32 quoting changed a literal argument.'
            }
        } finally { $nativeProcess.Dispose() }
        $passed++
    }
    Write-Output ("PowerShell desktop installer boundary checks passed: $passed. No Docker/network activation was tested.")
} finally {
    # The resolved, freshly-created test area is the sole recursive removal target.
    $resolved = [IO.Path]::GetFullPath($area)
    Need ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('vectory-powershell-test-')) 'Test cleanup target escaped its intended directory.'
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
