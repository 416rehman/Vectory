param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$fixtureRoot=[IO.Path]::GetFullPath((Join-Path (Split-Path $PSScriptRoot -Parent) '.local'))+[IO.Path]::DirectorySeparatorChar
$fixtureFile=(Resolve-Path -LiteralPath $Path).Path
if(!$fixtureFile.StartsWith($fixtureRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture path must remain inside .local'}
if((Get-Item -LiteralPath $fixtureFile).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Fixture cannot be a reparse point'}
$acl=New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true,$false)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($identity)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','Allow')))
Set-Acl -LiteralPath $fixtureFile -AclObject $acl
