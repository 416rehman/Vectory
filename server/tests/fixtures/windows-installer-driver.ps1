param([string]$FixtureAction, [string]$FixtureRoot, [string]$FixtureInstaller)
$ErrorActionPreference = 'Stop'
if ($FixtureAction -eq 'build') {
    # A synthetic native program models curl and setup without touching a real
    # service, Vector process, enrollment token or network. Compile once with
    # Windows PowerShell 5.1 so its .NET Framework executable also runs under 7.
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
public static class InstallerFixture {
    public static int Main(string[] args) {
        if (Path.GetFileName(Process.GetCurrentProcess().MainModule.FileName).Equals("curl.exe", StringComparison.OrdinalIgnoreCase)) {
            File.WriteAllLines(Environment.GetEnvironmentVariable("VECTORY_TEST_CURL_ARGS"), args);
            int output = Array.IndexOf(args, "--output");
            if (output < 0 || output + 1 >= args.Length) return 2;
            string trace = Environment.GetEnvironmentVariable("VECTORY_TEST_CURL_TRACE");
            if (!String.IsNullOrEmpty(trace)) {
                string directory = Path.GetDirectoryName(args[output + 1]);
                var acl = Directory.GetAccessControl(directory);
                File.AppendAllText(trace, directory + "|" + acl.AreAccessRulesProtected.ToString() + "|" + acl.GetSecurityDescriptorSddlForm(System.Security.AccessControl.AccessControlSections.Access) + Environment.NewLine);
            }
            string forced = Environment.GetEnvironmentVariable("VECTORY_TEST_CURL_EXIT");
            if (!String.IsNullOrEmpty(forced)) return Int32.Parse(forced);
            string source = Environment.GetEnvironmentVariable("VECTORY_TEST_DOWNLOAD");
            string installer = Environment.GetEnvironmentVariable("VECTORY_TEST_INSTALLER_DOWNLOAD");
            if (!String.IsNullOrEmpty(installer) && args[args.Length - 1].EndsWith("/agent/v1/install.ps1")) source = installer;
            File.Copy(source, args[output + 1]);
            return 0;
        }
        File.WriteAllLines(Environment.GetEnvironmentVariable("VECTORY_TEST_AGENT_ARGS"), args);
        return Int32.Parse(Environment.GetEnvironmentVariable("VECTORY_TEST_AGENT_EXIT"));
    }
}
'@ -OutputAssembly (Join-Path $FixtureRoot 'fixture.exe') -OutputType ConsoleApplication
    New-Item -ItemType Directory -Path (Join-Path $FixtureRoot 'bin') | Out-Null
    Copy-Item -LiteralPath (Join-Path $FixtureRoot 'fixture.exe') -Destination (Join-Path $FixtureRoot 'bin\curl.exe')
    exit 0
}
if ($FixtureAction -eq 'parent') {
    if ($PSVersionTable.PSEdition -ne 'Core') { throw 'This fixture requires a real PowerShell 7 parent.' }
    # Deliberately reproduce a Core-only inherited module path in the 5.1
    # child, as a generated Add device command can do. The served installer
    # must select its own modules while all real ACL/hash checks still run.
    $env:PSModulePath = Join-Path $PSHOME 'Modules'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath run $FixtureRoot $FixtureInstaller @args
    exit $LASTEXITCODE
}
if ($FixtureAction -ne 'run') { throw 'Unknown fixture mode' }
$env:PATH = (Join-Path $FixtureRoot 'bin') + ';' + $env:PATH
& $FixtureInstaller @args
exit $LASTEXITCODE
