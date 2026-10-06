import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentInstallSchema } from "./api";
import { installerCommand, type SetupChoices } from "./enrollmentCommands";

const pem =
  "-----BEGIN CERTIFICATE-----\nU3ludGhldGljIGZvciBjb21tYW5kIHRlc3Rz\n-----END CERTIFICATE-----\n";
const script =
  "[IO.File]::WriteAllText((Join-Path $env:VECTORY_COMMAND_FIXTURE 'ran.txt'), ($args -join \"`n\")); exit 0\n";
const digest = createHash("sha256").update(script).digest("hex");
const metadata = AgentInstallSchema.parse({
  agent_url: "https://synthetic.example.test:8443",
  agent_url_configured: true,
  listener_enabled: true,
  dashboard_url: null,
  downloads_enabled: true,
  certificate: {
    available: true,
    publicly_trusted: false,
    ca_sha256: "a".repeat(64),
    ca_pem: pem,
    problem: null,
  },
  installer: {
    url: "https://synthetic.example.test:8443/agent/v1/install.sh",
    sha256: digest,
    platforms: ["linux/amd64", "darwin/arm64"],
  },
  windows_installer: {
    url: "https://synthetic.example.test:8443/agent/v1/install.ps1",
    sha256: digest,
    platforms: ["windows/amd64"],
  },
  default_install_dir: "/usr/local/bin",
  releases: [],
  catalog_problems: [],
});
const choices = (os: SetupChoices["os"]): SetupChoices => ({
  os,
  mode: "restricted",
  name: "",
  service: "auto",
  serviceUser: "",
  createUser: true,
  stateDir: "",
  managedConfig: "",
  capabilityPolicy: "",
});

describe("one-line installation recipes", () => {
  it.each(["linux", "darwin", "windows"] as const)(
    "offers %s without token values or multiline certificate literals",
    (os) => {
      const command = installerCommand(metadata, choices(os), "one-line")!;
      expect(command).not.toMatch(/[\r\n]/);
      expect(command).toContain(digest);
      expect(command).toContain("--mode restricted");
      expect(command).toContain(
        os === "windows" ? "/agent/v1/install.ps1" : "/agent/v1/install.sh",
      );
      expect(command).not.toMatch(
        /\?token=|--token\s|\|\s*(sudo\s+)?(?:sh|bash)/,
      );
    },
  );
});

const shells =
  process.platform === "win32"
    ? ["powershell.exe", "pwsh.exe"].filter(
        (shell) =>
          spawnSync(
            shell,
            ["-NoProfile", "-NonInteractive", "-Command", "exit 0"],
            { windowsHide: true },
          ).status === 0,
      )
    : [];

describe.each(shells)("Windows recipe in %s", (shell) => {
  it.each(["readable", "one-line"] as const)(
    "executes the %s recipe with exact CA bytes and quoted token-file path",
    (presentation) => {
      runWindows(shell, presentation, false);
    },
  );
  it.each(["readable", "one-line"] as const)(
    "refuses a tampered installer in the %s recipe",
    (presentation) => {
      runWindows(shell, presentation, true);
    },
  );
});

const coreModules = shells.includes("pwsh.exe")
  ? spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Join-Path $PSHOME 'Modules'",
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim()
  : "";

describe.skipIf(!coreModules)(
  "Windows PowerShell recipe with inherited PowerShell 7 modules",
  () => {
    it.each(["readable", "one-line"] as const)(
      "executes the %s recipe with real private ACL and hash checks",
      (presentation) => {
        runWindows("powershell.exe", presentation, false, coreModules);
      },
    );
    it.each(["readable", "one-line"] as const)(
      "refuses a tampered installer in the %s recipe",
      (presentation) => {
        runWindows("powershell.exe", presentation, true, coreModules);
      },
    );
  },
);

function runWindows(
  shell: string,
  presentation: "readable" | "one-line",
  tamper: boolean,
  inheritedModules?: string,
) {
  const folder = mkdtempSync(join(tmpdir(), "vectory-command-native-"));
  try {
    writeFileSync(join(folder, "installer.ps1"), script);
    const picked = {
      ...choices("windows"),
      tokenFile: "C:\\Provisioning\\owner's token.txt",
    };
    const command = installerCommand(metadata, picked, presentation)!;
    const fixture = `
$ErrorActionPreference = 'Stop'
function curl.exe {
  $arguments = @($args)
  $destination = $arguments[[Array]::IndexOf($arguments, '--output') + 1]
  $ca = $arguments[[Array]::IndexOf($arguments, '--cacert') + 1]
  [IO.File]::WriteAllText((Join-Path $env:VECTORY_COMMAND_FIXTURE 'ca-seen.pem'), [IO.File]::ReadAllText($ca))
  $acl = Get-Acl -LiteralPath ([IO.Path]::GetDirectoryName($destination))
  if (-not $acl.AreAccessRulesProtected) { throw 'Temporary directory inherited access.' }
  $allowed = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($rule in $acl.Access) { if ($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $allowed) { throw 'Temporary directory grants another identity access.' } }
  [IO.File]::WriteAllText((Join-Path $env:VECTORY_COMMAND_FIXTURE 'stage.txt'), [IO.Path]::GetDirectoryName($destination))
  ${tamper ? "[IO.File]::WriteAllText($destination, 'exit 0')" : "[IO.File]::WriteAllBytes($destination, [IO.File]::ReadAllBytes((Join-Path $env:VECTORY_COMMAND_FIXTURE 'installer.ps1')))"}
  $global:LASTEXITCODE = 0
}
${command}
`;
    const file = join(folder, "fixture.ps1");
    writeFileSync(file, fixture, "utf8");
    const environment: Record<string, string | undefined> = {
      ...process.env,
      VECTORY_COMMAND_FIXTURE: folder,
    };
    if (inheritedModules) {
      // Windows names are case-insensitive. Keep one spelling in this child
      // environment; the host's global module path remains untouched.
      for (const name of Object.keys(environment))
        if (name.toLowerCase() === "psmodulepath") delete environment[name];
      environment.PSModulePath = inheritedModules;
    }
    const result = spawnSync(
      shell,
      ["-NoProfile", "-NonInteractive", "-File", file],
      {
        env: environment,
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      },
    );
    const marker = join(folder, "ran.txt");
    if (tamper) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Installer checksum did not match");
      expect(existsSync(marker)).toBe(false);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(marker, "utf8")).toContain(
        "--token-file\nC:\\Provisioning\\owner's token.txt",
      );
    }
    expect(readFileSync(join(folder, "ca-seen.pem"), "utf8")).toBe(
      pem.trimEnd(),
    );
    const stage = readFileSync(join(folder, "stage.txt"), "utf8");
    expect(existsSync(stage)).toBe(false);
  } finally {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !/^vectory-command-native-/.test(basename(folder))
    )
      throw Error("Unsafe fixture cleanup path");
    rmSync(folder, { recursive: true, force: true });
  }
}
