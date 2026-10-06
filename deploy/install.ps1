# HTTPS bootstrap for the unchanged, signed Vectory server kit.
# Uses Linux x86-64 containers, including explicitly selected emulation.
[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status', 'setup-secret')][string]$Action = 'start',
    [string]$Directory = (Join-Path (Get-Location) 'vectory'),
    [string]$Hostname,
    [string]$Project = 'vectory',
    [string]$BindIp = '0.0.0.0',
    [switch]$AllowAmd64Emulation,
    [ValidateSet('automatic','custom')][string]$CertificateMode = 'automatic',
    [string]$CertificateFile,
    [string]$KeyFile
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$version = '0.2.1'
$kitName = "vectory-$version-server-linux-amd64"
$release = "https://github.com/416rehman/Vectory/releases/download/v$version"
$identity = "https://github.com/416rehman/Vectory/.github/workflows/release.yml@refs/tags/v$version"
$cosign = 'ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8'
$proxy = 'caddy:2.11.7-alpine@sha256:d76116d819d5162f464b0f2cd09bd28c568a86148c7bc539ce17c33eb22d8bbb'
$expected = @('.env.example','Caddyfile','Caddyfile.auto','LICENSE','NOTICE','README.md','SHA256SUMS','VERSION','compose.auto.yaml','compose.yaml','prepare-offline.sh','release-images.sh','start-auto.sh','start.sh','verify-release.sh')
$taskLock = $null
$oldTls = [Net.ServicePointManager]::SecurityProtocol

function Refuse([string]$Message) { throw "Vectory: $Message" }
function NativeArgument([string]$Value) {
    # Windows CRT/CommandLineToArgvW quoting, including quotes and trailing
    # backslashes. PowerShell 5.1's native-command serialization loses these.
    $result = New-Object Text.StringBuilder
    [void]$result.Append('"'); $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ([int]$character -eq 92) { $slashes++; continue }
        if ([int]$character -eq 34) { [void]$result.Append(('\' * (2 * $slashes + 1))); [void]$result.Append('"') }
        else { [void]$result.Append(('\' * $slashes)); [void]$result.Append($character) }
        $slashes = 0
    }
    [void]$result.Append(('\' * (2 * $slashes))); [void]$result.Append('"')
    return $result.ToString()
}
function Invoke-Docker([string[]]$Arguments, [AllowNull()][string]$InputText = $null) {
    $executable = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $executable) { Refuse 'Docker Desktop command is unavailable.' }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $executable.Source
    $start.Arguments = ($Arguments | ForEach-Object { NativeArgument $_ }) -join ' '
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $PSBoundParameters.ContainsKey('InputText')
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { Refuse 'Could not start the Docker command.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($start.RedirectStandardInput) { $process.StandardInput.Write($InputText); $process.StandardInput.Close() }
        if (-not $process.WaitForExit(300000)) { $process.Kill(); Refuse 'Docker command timed out. Inspect this project before retrying; retained state was not removed.' }
        $output = $stdout.GetAwaiter().GetResult(); $errorText = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            if ($errorText.Trim()) { Write-Host $errorText.Trim() }
            Refuse 'Docker command failed. Retained data and certificates were not removed.'
        }
        if ($output) { return @($output.TrimEnd("`r","`n") -split "`r?`n") }
    } finally { $process.Dispose() }
}
function Regular([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return $null -ne $item -and -not $item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
}
function SafeDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { Refuse 'Use an ordinary installation directory, not a link.' }
}
function Pem([string]$Path, [int]$Maximum) {
    if (-not [IO.Path]::IsPathRooted($Path) -or -not (Regular $Path) -or (Get-Item -LiteralPath $Path).Length -gt $Maximum) { Refuse 'Use a bounded regular PEM file at an absolute path, not a link.' }
    $bytes = [IO.File]::ReadAllBytes($Path)
    foreach ($value in $bytes) { if ($value -gt 127 -or ($value -lt 32 -and $value -notin @(9,10,13))) { Refuse 'The certificate and key must contain ASCII PEM text.' } }
    return [Text.Encoding]::ASCII.GetString($bytes)
}
function DockerPem([string[]]$Arguments, [string]$Text) {
    Invoke-Docker -Arguments $Arguments -InputText $Text | Out-Null
}
function PrivateText([string]$Path, [string]$Text) {
    $existing = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $existing -and -not (Regular $Path)) { Refuse 'The retained settings file must be regular, not a link.' }
    $part = "$Path.part"
    if (Test-Path -LiteralPath $part) { if (-not (Regular $part)) { Refuse 'A temporary settings file is a link or nonregular file.' }; Remove-Item -LiteralPath $part }
    $acl = New-Object Security.AccessControl.FileSecurity
    if (Regular $Path) { $acl = Get-Acl -LiteralPath $Path }
    else {
        $acl.SetAccessRuleProtection($true,$false)
        $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.SetOwner($currentUser)
        foreach ($sid in @($currentUser, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
        }
    }
    [IO.File]::WriteAllText($part,$Text,(New-Object Text.UTF8Encoding($false)))
    Set-Acl -LiteralPath $part -AclObject $acl
    Move-Item -LiteralPath $part -Destination $Path -Force
}
function Download([string]$Name, [string]$Destination, [int]$Maximum) {
    $uri = [Uri]"$release/$Name"
    $part = "$Destination.part"
    if (Test-Path -LiteralPath $part) { Refuse 'An unfinished download exists. Inspect and remove only that .part file, then retry.' }
    $stream = $null
    try {
        for ($redirect = 0; $redirect -le 6; $redirect++) {
            if ($uri.Scheme -ne 'https' -or $uri.UserInfo) { Refuse 'The release download must remain HTTPS.' }
            $request = [Net.HttpWebRequest]::Create($uri)
            $request.AllowAutoRedirect = $false
            $request.Timeout = 300000
            $request.ReadWriteTimeout = 300000
            $request.UserAgent = 'Vectory server installer'
            $response = $request.GetResponse()
            try {
                $status = [int]$response.StatusCode
                if ($status -ge 300 -and $status -lt 400) {
                    if (-not $response.Headers['Location'] -or $redirect -eq 6) { Refuse 'Too many release download redirects.' }
                    $uri = [Uri]::new($uri, $response.Headers['Location'])
                    continue
                }
                if ($status -ne 200 -or $response.ContentLength -gt $Maximum) { Refuse 'Release download size or status was unexpected.' }
                $stream = [IO.File]::Open($part, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $inputStream = $response.GetResponseStream()
                try {
                    $buffer = New-Object byte[] 65536
                    $total = 0
                    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $total += $count
                        if ($total -gt $Maximum) { Refuse 'Release download exceeded its size limit.' }
                        $stream.Write($buffer, 0, $count)
                    }
                } finally { $inputStream.Dispose() }
                $stream.Dispose(); $stream = $null
                if (Test-Path -LiteralPath $Destination) { Refuse 'Download destination already exists.' }
                Move-Item -LiteralPath $part -Destination $Destination
                return
            } finally { $response.Dispose() }
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if (Regular $part) { Remove-Item -LiteralPath $part }
    }
}
function Checksum([string]$Inventory, [string]$Name, [string]$Path) {
    if (-not (Regular $Inventory) -or -not (Regular $Path)) { Refuse 'A verified file is missing or is a link.' }
    $matches = @(Get-Content -LiteralPath $Inventory | Where-Object { $_ -match ('^[a-f0-9]{64}  ' + [regex]::Escape($Name) + '$') })
    if ($matches.Count -ne 1) { Refuse "The signed inventory must identify $Name exactly once." }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -ne $matches[0].Substring(0,64)) { Refuse "Checksum failed for $Name." }
}
function Cosign([string[]]$Arguments) {
    Invoke-Docker (@('run','--platform','linux/amd64','--rm','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--env','HOME=/tmp','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--mount',"type=bind,src=$cache,dst=/release,readonly",$cosign) + $Arguments) | Out-Null
}
function Compose([string[]]$Arguments) {
    # Compose must use the retained file, not stale VECTORY_* process values.
    $saved = @{}
    try {
        foreach ($item in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'VECTORY_*' })) {
            $saved[$item.Name] = $item.Value
            [Environment]::SetEnvironmentVariable($item.Name, $null, 'Process')
        }
        return Invoke-Docker (@('compose','--project-name',$Project,'--env-file',$envFile,'-f',$composeFile,'-f',$platformFile) + $Arguments)
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { Refuse 'Use the shell installer on Linux or macOS.' }
    if ($Project -notmatch '^[a-z0-9][a-z0-9-]{0,39}$') { Refuse 'Project must contain 1 to 40 lowercase letters, digits or hyphens.' }
    $Directory = [IO.Path]::GetFullPath($Directory)
    if ($Directory -match '[,\r\n]') { Refuse 'Use an installation path without commas or line breaks.' }
    SafeDirectory $Directory
    if (-not (Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue)) { Refuse 'Install and start Docker Desktop, then retry. https://docs.docker.com/desktop/setup/install/windows-install/' }
    Invoke-Docker @('compose','version') | Out-Null
    $platform = (Invoke-Docker @('info','--format','{{.OSType}}/{{.Architecture}}') | Out-String).Trim()
    if ($platform -notmatch '^linux/(amd64|x86_64|aarch64|arm64)$') { Refuse 'Select Linux containers in Docker Desktop. Windows containers and this engine architecture are not supported.' }
    if ($platform -match '/(aarch64|arm64)$' -and -not $AllowAmd64Emulation) { Refuse 'This release has Linux x86-64 images. Enable Docker Desktop amd64 emulation, then deliberately retry with -AllowAmd64Emulation. This is not a native Arm server build.' }
    if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Refuse 'Windows tar.exe is required to extract the verified kit.' }
    if (-not (Test-Path -LiteralPath $Directory)) { New-Item -ItemType Directory -Path $Directory | Out-Null }
    $cache = Join-Path $Directory '.cache'
    SafeDirectory $cache
    $envFile = Join-Path $Directory '.env'
    $platformFile = Join-Path $Directory '.desktop-platform.yaml'
    $journalFile = Join-Path $Directory '.setup.desktop.json'
    $progressFile = Join-Path $Directory '.desktop-installing'
    $lockPath = Join-Path $Directory '.desktop.lock'
    if ((Test-Path -LiteralPath $lockPath) -and -not (Regular $lockPath)) { Refuse 'The installation lock must be a regular file.' }
    $taskLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if (-not (Test-Path -LiteralPath (Join-Path $Directory 'VERSION'))) {
        $others = @(Get-ChildItem -LiteralPath $Directory -Force | Where-Object { $_.Name -ne '.desktop.lock' })
        $resume = Regular $progressFile
        if ($resume) { $resume = [IO.File]::ReadAllText($progressFile) -eq "$version`n" }
        if (-not $resume -and $others.Count -ne 0) { Refuse 'Choose an empty directory. Existing installations are resumed only from their original kit directory.' }
        if ($resume) {
            $allowed = $expected + @('.cache','.desktop-installing','VERSION.part')
            foreach ($item in $others) {
                if ($item.Name -notin $allowed) { Refuse 'Unexpected content in an interrupted installation; no files were deleted.' }
                if ($item.Name -eq '.cache') { SafeDirectory $item.FullName }
                elseif (-not (Regular $item.FullName)) { Refuse 'Interrupted kit entries must be regular files, not links.' }
            }
        } else { PrivateText $progressFile "$version`n" }
        if (-not (Test-Path -LiteralPath $cache)) { New-Item -ItemType Directory -Path $cache | Out-Null }
        $downloads = @('SHA256SUMS','SHA256SUMS.sigstore.json','IMAGE-DIGESTS.env','IMAGE-CONFIGS.env',"$kitName.tar.gz")
        $cacheNames = $downloads + @($downloads | ForEach-Object { "$_.part" }) + @('expected','members')
        foreach ($item in Get-ChildItem -LiteralPath $cache -Force) {
            if ($item.Name -notin $cacheNames -or -not (Regular $item.FullName) -or $item.Length -gt 2097152) { Refuse 'Unexpected or linked interrupted download; no unknown files were deleted.' }
        }
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Output "Downloading the official Vectory $version server kit..."
        foreach ($name in $downloads) {
            $destination = Join-Path $cache $name
            foreach ($owned in @($destination,"$destination.part")) { if (Regular $owned) { Remove-Item -LiteralPath $owned } }
            Download $name $destination 2097152
        }
        Write-Output 'Verifying the downloaded release before extraction...'
        Cosign @('verify-blob','--bundle','/release/SHA256SUMS.sigstore.json','--certificate-identity',$identity,'--certificate-oidc-issuer','https://token.actions.githubusercontent.com','/release/SHA256SUMS')
        $archive = Join-Path $cache "$kitName.tar.gz"
        Checksum (Join-Path $cache 'SHA256SUMS') "$kitName.tar.gz" $archive
        $members = @(& tar.exe -tzf $archive)
        if ($LASTEXITCODE -ne 0) { Refuse 'Could not read the verified kit.' }
        $wanted = @($expected | ForEach-Object { "$kitName/$_" })
        if (@(Compare-Object ($wanted | Sort-Object) ($members | Sort-Object)).Count -ne 0 -or $members.Count -ne $wanted.Count) { Refuse 'The kit file inventory is unexpected.' }
        $details = @(& tar.exe -tvzf $archive)
        if ($LASTEXITCODE -ne 0 -or @($details | Where-Object { -not $_.StartsWith('-') }).Count -ne 0) { Refuse 'The kit must contain only regular files.' }
        & tar.exe -xzf $archive --strip-components=1 --exclude "$kitName/VERSION" -C $Directory
        if ($LASTEXITCODE -ne 0) { Refuse 'The verified kit could not be extracted.' }
        $archiveVersion = @(& tar.exe -xOzf $archive "$kitName/VERSION")
        if ($LASTEXITCODE -ne 0 -or $archiveVersion.Count -ne 1 -or $archiveVersion[0] -ne $version) { Refuse 'The signed archive version does not match this installer.' }
        # VERSION is the final commit marker, so a power cut during extraction
        # can resume the known fixed payload rather than mistake it for a kit.
        PrivateText (Join-Path $Directory 'VERSION') "$version`n"
    }
    $kitInventory = Join-Path $Directory 'SHA256SUMS'
    foreach ($name in $expected | Where-Object { $_ -ne 'SHA256SUMS' }) { Checksum $kitInventory $name (Join-Path $Directory $name) }
    if ((Get-Content -LiteralPath (Join-Path $Directory 'VERSION') -Raw).Trim() -ne $version) { Refuse "This bootstrap manages only the verified $version kit." }
    if (Test-Path -LiteralPath $progressFile) {
        if (-not (Regular $progressFile) -or [IO.File]::ReadAllText($progressFile) -ne "$version`n") { Refuse 'The interrupted-install marker is unexpected or linked.' }
        Remove-Item -LiteralPath $progressFile
    }
    if (Regular $envFile) {
        if ((Get-Item -LiteralPath $envFile).Length -gt 65536) { Refuse 'The retained environment file is oversized.' }
        $storedProject = @(Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^VECTORY_SERVER_PROJECT=' })
        if ($storedProject.Count -gt 1) { Refuse 'The retained project setting is repeated.' }
        if ($storedProject.Count -eq 1) {
            $recordedProject = $storedProject[0].Substring(23)
            if ($recordedProject -notmatch '^[a-z0-9][a-z0-9-]{0,39}$' -or ($PSBoundParameters.ContainsKey('Project') -and $Project -ne $recordedProject)) { Refuse 'Resume with the original project name.' }
            $Project = $recordedProject
        }
        $storedMode = @(Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^VECTORY_CERTIFICATE_MODE=(automatic|custom)$' })
        if ($storedMode.Count -ne 1) { Refuse 'The retained certificate mode is missing or repeated.' }
        $recordedMode = $storedMode[0].Substring(25)
        if ($PSBoundParameters.ContainsKey('CertificateMode') -and $CertificateMode -ne $recordedMode) { Refuse 'Resume using the original certificate mode.' }
        $CertificateMode = $recordedMode
    } elseif ($CertificateFile -or $KeyFile -or (Test-Path -LiteralPath $journalFile)) {
        if ($PSBoundParameters.ContainsKey('CertificateMode') -and $CertificateMode -ne 'custom') { Refuse 'Supplied certificate files require custom certificate mode.' }
        $CertificateMode = 'custom'
    }
    $composeFile = Join-Path $Directory 'compose.yaml'
    $platformText = "services:`n  server:`n    platform: linux/amd64`n  validator:`n    platform: linux/amd64`n  proxy:`n    platform: linux/amd64`n"
    if ($CertificateMode -eq 'automatic') { $composeFile = Join-Path $Directory 'compose.auto.yaml'; $platformText += "  certificates:`n    platform: linux/amd64`n" }
    if (Test-Path -LiteralPath $platformFile) {
        if (-not (Regular $platformFile) -or [IO.File]::ReadAllText($platformFile) -ne $platformText) { Refuse 'The bootstrap platform override was changed or is a link.' }
    } else { [IO.File]::WriteAllText($platformFile,$platformText,(New-Object Text.UTF8Encoding($false))) }
    if ($Action -ne 'start') {
        if (-not (Regular $envFile)) { Refuse 'Start this kit once before using this action.' }
        switch ($Action) {
            'stop' { Compose @('stop'); Write-Output 'Server stopped. Database and certificate volumes are retained.' }
            'status' { Compose @('ps') }
            'setup-secret' { Compose @('exec','-T','server','cat','/run/secrets/bootstrap') }
        }
        return
    }
    foreach ($name in @('SHA256SUMS','SHA256SUMS.sigstore.json','IMAGE-DIGESTS.env','IMAGE-CONFIGS.env',"$kitName.tar.gz")) {
        $path = Join-Path $cache $name
        if (Test-Path -LiteralPath $path) { if (-not (Regular $path)) { Refuse 'Release cache entries must be regular files.' } }
        else { Download $name $path 2097152 }
    }
    Write-Output 'Verifying the retained release and prebuilt container images...'
    Cosign @('verify-blob','--bundle','/release/SHA256SUMS.sigstore.json','--certificate-identity',$identity,'--certificate-oidc-issuer','https://token.actions.githubusercontent.com','/release/SHA256SUMS')
    $archive = Join-Path $cache "$kitName.tar.gz"
    Checksum (Join-Path $cache 'SHA256SUMS') "$kitName.tar.gz" $archive
    $anchoredInventory = @(& tar.exe -xOzf $archive "$kitName/SHA256SUMS")
    if ($LASTEXITCODE -ne 0 -or @(Compare-Object -CaseSensitive $anchoredInventory @(Get-Content -LiteralPath $kitInventory)).Count -ne 0) { Refuse 'The kit inventory differs from the signed archive.' }
    $images = @{}; $configs = @{}
    foreach ($file in @('IMAGE-DIGESTS.env','IMAGE-CONFIGS.env')) {
        Checksum (Join-Path $cache 'SHA256SUMS') $file (Join-Path $cache $file)
        foreach ($line in Get-Content -LiteralPath (Join-Path $cache $file)) {
            if ($line -notmatch '^(VECTORY_(SERVER|VALIDATOR)_IMAGE)=(.+)$') { Refuse 'Unexpected signed image setting.' }
            $name = $Matches[1]; $component = $Matches[2].ToLowerInvariant(); $value = $Matches[3]
            if ($file -eq 'IMAGE-DIGESTS.env') {
                if ($images.ContainsKey($name) -or $value -notmatch ('^ghcr\.io/416rehman/vectory-' + $component + '@sha256:[a-f0-9]{64}$')) { Refuse 'Signed images must be unique immutable Vectory digests.' }
                $images[$name] = $value
            } else {
                if ($configs.ContainsKey($name) -or $value -notmatch '^sha256:[a-f0-9]{64}$') { Refuse 'Signed image configurations are malformed or repeated.' }
                $configs[$name] = $value
            }
        }
    }
    if ($images.Count -ne 2 -or $configs.Count -ne 2) { Refuse 'The signed image manifests are incomplete.' }
    Write-Output 'Getting the verified server, validator and HTTPS proxy images...'
    foreach ($name in $images.Keys) {
        Cosign @('verify','--certificate-identity',$identity,'--certificate-oidc-issuer','https://token.actions.githubusercontent.com',$images[$name])
        Invoke-Docker @('pull','--platform','linux/amd64',$images[$name]) | Out-Null
        $executionId = (Invoke-Docker @('image','inspect',$images[$name],'--format','{{.Id}}') | Out-String).Trim()
        $signedManifest = $images[$name].Substring($images[$name].IndexOf('@') + 1)
        $executionPlatform = (Invoke-Docker @('image','inspect',$images[$name],'--format','{{.Os}}/{{.Architecture}}') | Out-String).Trim()
        # Classic storage exposes the config ID; containerd storage can expose
        # the exact authenticated manifest ID. Neither permits another digest.
        if ($executionId -notin @($configs[$name],$signedManifest) -or $executionPlatform -ne 'linux/amd64') { Refuse 'Pulled image differs from its signed immutable identity or platform.' }
    }
    Invoke-Docker @('pull','--platform','linux/amd64',$proxy) | Out-Null
    $proxyId = (Invoke-Docker @('image','inspect',$proxy,'--format','{{.Id}}') | Out-String).Trim()
    $proxyPlatform = (Invoke-Docker @('image','inspect',$proxy,'--format','{{.Os}}/{{.Architecture}}') | Out-String).Trim()
    if ($proxyId -notin @('sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77','sha256:d76116d819d5162f464b0f2cd09bd28c568a86148c7bc539ce17c33eb22d8bbb','sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229') -or $proxyPlatform -ne 'linux/amd64') { Refuse 'The pinned HTTPS proxy identity or platform differs.' }
    $retained = @()
    if (Test-Path -LiteralPath $envFile) {
        if (-not (Regular $envFile) -or (Get-Item -LiteralPath $envFile).Length -gt 65536) { Refuse 'The retained environment file must be bounded and regular.' }
        $retained = @(Get-Content -LiteralPath $envFile)
        $storedHostname = @($retained | Where-Object { $_ -match '^VECTORY_HOSTNAME=' })
        $storedBind = @($retained | Where-Object { $_ -match '^VECTORY_BIND_IP=' })
        if ($storedHostname.Count -ne 1 -or $storedBind.Count -ne 1) { Refuse 'The retained setup is incomplete.' }
        if ($Hostname -and $Hostname -ne $storedHostname[0].Substring(17)) { Refuse 'The hostname cannot replace retained certificate trust.' }
        $Hostname = $storedHostname[0].Substring(17)
        $BindIp = $storedBind[0].Substring(16)
        if ($CertificateFile -or $KeyFile) { Refuse 'Existing certificate trust is retained. Do not supply a replacement pair during a normal restart.' }
    }
    $journal = $null
    if (Test-Path -LiteralPath $journalFile) {
        if (-not (Regular $journalFile) -or (Get-Item -LiteralPath $journalFile).Length -gt 8192 -or (Test-Path -LiteralPath $envFile)) { Refuse 'The setup journal must be bounded, regular and separate from completed setup.' }
        $journal = Get-Content -LiteralPath $journalFile -Raw | ConvertFrom-Json
        $names = @($journal.PSObject.Properties.Name | Sort-Object)
        if (@(Compare-Object $names @('BindIp','Hostname','Project','ServerImage','ValidatorImage')).Count -ne 0 -or $names.Count -ne 5 -or $journal.Project -ne $Project -or $journal.ServerImage -ne $images['VECTORY_SERVER_IMAGE'] -or $journal.ValidatorImage -ne $images['VECTORY_VALIDATOR_IMAGE']) { Refuse 'The interrupted setup needs its original project and verified image identities.' }
        if ($Hostname -and $Hostname -ne $journal.Hostname) { Refuse 'Resume with the original hostname.' }
        $Hostname = [string]$journal.Hostname; $BindIp = [string]$journal.BindIp
    }
    if (-not $Hostname) { $Hostname = Read-Host 'DNS name pointing to this computer, for example vectory.example.com' }
    if ($Hostname -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$' -or $Hostname -match '\.\.|^\d+\.\d+\.\d+\.\d+$' -or ($CertificateMode -eq 'automatic' -and $Hostname -notmatch '\.')) { Refuse 'Enter a DNS name without https://, a port or a path. Automatic HTTPS needs a public DNS name.' }
    $parsedIp = $null
    if (-not [Net.IPAddress]::TryParse($BindIp,[ref]$parsedIp) -or $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { Refuse 'BindIp must be an IPv4 address.' }
    Write-Output 'Preparing HTTPS and retained certificate storage...'
    Invoke-Docker @('volume','create','--label','io.vectory.server=true',"${Project}_secrets") | Out-Null
    $common = @('run','--platform','linux/amd64','--rm','--network','none','--user','10001:10001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',"type=volume,src=${Project}_secrets,dst=/var/lib/vectory")
    if ($CertificateMode -eq 'custom' -and -not (Test-Path -LiteralPath $envFile)) {
        if ($null -eq $journal) {
            if (-not $CertificateFile) { $CertificateFile = Read-Host 'TLS certificate full-chain PEM file (absolute path)' }
            if (-not $KeyFile) { $KeyFile = Read-Host 'TLS private-key PEM file (absolute path)' }
            $certificateText = Pem $CertificateFile 262144; $keyText = Pem $KeyFile 32768
            $present = Invoke-Docker ($common + @('--entrypoint','/bin/sh',$images['VECTORY_SERVER_IMAGE'],'-c','if test -e /var/lib/vectory/server_cert -o -e /var/lib/vectory/server_key -o -e /var/lib/vectory/bootstrap; then printf retained; fi'))
            if ($present) { Refuse 'This project already holds certificate or setup state. Restore its original .env; existing trust will not be replaced.' }
            DockerPem ($common + @('-i','--entrypoint','/bin/sh',$images['VECTORY_SERVER_IMAGE'],'-c','set -eu; umask 077; test ! -L /var/lib/vectory/server_cert.part; cat > /var/lib/vectory/server_cert.part')) $certificateText
            DockerPem ($common + @('-i','--entrypoint','/bin/sh',$images['VECTORY_SERVER_IMAGE'],'-c','set -eu; umask 077; test ! -L /var/lib/vectory/server_key.part; cat > /var/lib/vectory/server_key.part')) $keyText
            Invoke-Docker ($common + @('--entrypoint','/app/operations/vectory-local-pki',$images['VECTORY_SERVER_IMAGE'],'--server-cert','/var/lib/vectory/server_cert.part','--server-key','/var/lib/vectory/server_key.part','--hostname',$Hostname)) | Out-Null
            $journal = [ordered]@{Project=$Project;Hostname=$Hostname;BindIp=$BindIp;ServerImage=$images['VECTORY_SERVER_IMAGE'];ValidatorImage=$images['VECTORY_VALIDATOR_IMAGE']}
            PrivateText $journalFile (($journal | ConvertTo-Json -Compress) + "`n")
        }
        Invoke-Docker ($common + @('--entrypoint','/bin/sh',$images['VECTORY_SERVER_IMAGE'],'-c','set -eu; for name in server_cert server_key; do test ! -L "/var/lib/vectory/$name"; if test -e "/var/lib/vectory/$name"; then test -f "/var/lib/vectory/$name"; else test -f "/var/lib/vectory/$name.part"; test ! -L "/var/lib/vectory/$name.part"; mv "/var/lib/vectory/$name.part" "/var/lib/vectory/$name"; fi; done')) | Out-Null
    }
    if ($CertificateMode -eq 'custom') {
        Invoke-Docker ($common + @('--entrypoint','/app/operations/vectory-local-pki',$images['VECTORY_SERVER_IMAGE'],'--server-cert','/var/lib/vectory/server_cert','--server-key','/var/lib/vectory/server_key','--hostname',$Hostname)) | Out-Null
    }
    $bootstrap = 'set -eu; umask 077; test ! -L /var/lib/vectory/bootstrap; if test ! -e /var/lib/vectory/bootstrap; then test ! -L /var/lib/vectory/bootstrap.part; if test -e /var/lib/vectory/bootstrap.part; then test -f /var/lib/vectory/bootstrap.part; rm /var/lib/vectory/bootstrap.part; fi; /app/operations/vectory-local-pki --bootstrap-only --bootstrap /var/lib/vectory/bootstrap.part; mv /var/lib/vectory/bootstrap.part /var/lib/vectory/bootstrap; fi; test -f /var/lib/vectory/bootstrap; test "$(wc -c < /var/lib/vectory/bootstrap)" -eq 65; LC_ALL=C grep -Eq "^[A-Za-z0-9_-]{64}$" /var/lib/vectory/bootstrap'
    Invoke-Docker ($common + @('--entrypoint','/bin/sh',$images['VECTORY_SERVER_IMAGE'],'-c',$bootstrap)) | Out-Null
    if ($CertificateMode -eq 'automatic') { Invoke-Docker ($common + @('--entrypoint','/app/operations/vectory-server-pki',$images['VECTORY_SERVER_IMAGE'],'--out','/var/lib/vectory','--hostname',$Hostname)) | Out-Null }
    foreach ($volume in $(if ($CertificateMode -eq 'automatic') { @('caddy_data','caddy_config') } else { @() })) {
        Invoke-Docker @('volume','create','--label','io.vectory.server=true',"${Project}_$volume") | Out-Null
        $seed = 'set -eu; umask 077; test -w /var/lib/vectory; marker=/var/lib/vectory/.vectory-initialized; test ! -L "$marker"; if test ! -e "$marker"; then (set -C; printf "Vectory managed proxy storage\n" > "$marker"); fi; test -f "$marker"'
        Invoke-Docker (@('run','--platform','linux/amd64','--rm','--network','none','--user','10001:10001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',"type=volume,src=${Project}_$volume,dst=/var/lib/vectory",'--entrypoint','/bin/sh',$images['VECTORY_SERVER_IMAGE'],'-c',$seed)) | Out-Null
    }
    $lines = @($retained | Where-Object { $_ -notmatch '^\s*(export\s+)?VECTORY_(HOSTNAME|BIND_IP|SERVER_IMAGE|VALIDATOR_IMAGE|PROXY_IMAGE|CERTIFICATE_MODE|SERVER_PROJECT)\s*=' }) + @("VECTORY_CERTIFICATE_MODE=$CertificateMode","VECTORY_SERVER_PROJECT=$Project","VECTORY_HOSTNAME=$Hostname","VECTORY_BIND_IP=$BindIp","VECTORY_SERVER_IMAGE=$($images['VECTORY_SERVER_IMAGE'])","VECTORY_VALIDATOR_IMAGE=$($images['VECTORY_VALIDATOR_IMAGE'])","VECTORY_PROXY_IMAGE=$proxy")
    PrivateText $envFile (($lines -join "`n") + "`n")
    if (Regular $journalFile) { Remove-Item -LiteralPath $journalFile }
    $mirror = Join-Path $Directory 'releases'; SafeDirectory $mirror
    if (-not (Test-Path -LiteralPath $mirror)) { New-Item -ItemType Directory -Path $mirror | Out-Null }
    Compose @('config','--quiet') | Out-Null
    Write-Output "Starting https://$Hostname. Allow inbound TCP 443 and 8443 in the host firewall; automatic HTTPS also needs public DNS and TCP 80."
    Compose @('up','-d','--wait','--wait-timeout','300') | Out-Null
    Write-Output "Open https://$Hostname"
    $status = (Compose @('exec','-T','server','curl','--fail','--silent','http://127.0.0.1:8080/api/v1/status') | Out-String | ConvertFrom-Json)
    if (-not $status.initialized) { Write-Output 'Create your first administrator using this setup secret:'; Compose @('exec','-T','server','cat','/run/secrets/bootstrap') }
    Write-Output 'Then choose Add device. Its command includes certificate trust and the verified agent download.'
    Write-Output "Retain this kit directory and the ${Project}_data, ${Project}_secrets and ${Project}_caddy_data volumes. Stop: .\vectory-install.ps1 -Action stop -Directory `"$Directory`""
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $oldTls
    if ($null -ne $taskLock) { $taskLock.Dispose() }
}
