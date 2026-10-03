import { describe, expect, it } from "vitest";
import {
  agentUpgradeRelease,
  hasUpgradeCommand,
  runningBuild,
  upgradeCommand,
  upgradeNotes,
} from "./agentUpgradeModel";
import { AgentInstallSchema, type Release } from "./api";

const release: Release = {
  name: "vectory-0.1.0-dev-windows-amd64.exe",
  os: "windows",
  arch: "amd64",
  version: "0.1.0-dev",
  sha256: "a".repeat(64),
  size: 7000000,
  url: "/api/v1/releases/vectory-0.1.0-dev-windows-amd64.exe",
  signed: false,
};
describe("agent upgrade downloads", () => {
  it("uses the exact device architecture without guessing from version", () => {
    expect(agentUpgradeRelease([release], "windows", "amd64").release).toBe(
      release,
    );
    expect(
      agentUpgradeRelease([release], "windows", "arm64").release,
    ).toBeUndefined();
    expect(
      agentUpgradeRelease([release], "linux", "amd64").release,
    ).toBeUndefined();
  });
  it("does not choose an arbitrary build when the platform is ambiguous", () => {
    expect(
      agentUpgradeRelease(
        [release, { ...release, sha256: "b".repeat(64) }],
        "windows",
        "amd64",
      ).reason,
    ).toMatch(/Several/);
  });
  it.each([
    "https://example.test/agent.exe",
    "//example.test/agent.exe",
    "/api/v1/releases/../session",
    release.url + "?redirect=1",
  ])("refuses a noncanonical download URL: %s", (url) => {
    expect(
      agentUpgradeRelease([{ ...release, url }], "windows", "amd64").release,
    ).toBeUndefined();
  });
  it.each([
    { size: -1 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { size: undefined },
    { version: undefined },
    { sha256: "invalid" },
    { name: "../agent.exe", url: "/api/v1/releases/../agent.exe" },
  ])("refuses incomplete or invalid release metadata %j", (patch) => {
    expect(
      agentUpgradeRelease(
        [{ ...release, ...patch } as Release],
        "windows",
        "amd64",
      ).release,
    ).toBeUndefined();
  });
  it("does not offer the unsupported Intel Mac build", () => {
    const mac = { ...release, os: "darwin", arch: "amd64" };
    expect(agentUpgradeRelease([mac], "darwin", "amd64").reason).toMatch(
      /Intel Mac/,
    );
  });
});

const linux: Release = {
  ...release,
  name: "vectory-0.2.0-linux-amd64",
  os: "linux",
  version: "0.2.0",
  sha256: "975c1a33" + "5".repeat(50) + "0e9d19",
  url: "/api/v1/releases/vectory-0.2.0-linux-amd64",
};
// A synthetic certificate: only its PEM shape matters here.
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBszCCAVmgAwIBAgIUU3ludGhldGljIGFnZW50IENBIGZvciB0ZXN0cy4wCgYI",
  "-----END CERTIFICATE-----",
  "",
].join("\n");
const install = AgentInstallSchema.parse({
  agent_url: "https://vectory.example.test:8443",
  agent_url_configured: false,
  listener_enabled: true,
  dashboard_url: "https://vectory.example.test",
  certificate: {
    available: true,
    publicly_trusted: false,
    ca_sha256: "1f3c" + "0".repeat(56) + "9ab0",
    ca_pem: caPem,
    problem: null,
  },
  downloads_enabled: true,
  installer: {
    url: "https://vectory.example.test:8443/agent/v1/install.sh",
    sha256: "c0f4e1b7" + "1".repeat(50) + "9d19ab",
    platforms: ["linux/amd64"],
  },
  default_install_dir: "/usr/local/bin",
  releases: [linux],
  catalog_problems: [],
});
const host = {
  name: "web-01",
  os: "linux",
  state_dir: "/var/lib/vectory-agent",
  service_manager: "systemd" as const,
};

describe("upgrading an enrolled agent", () => {
  it("says a device already runs this build by the SHA-256 it reports", () => {
    expect(
      runningBuild({ ...host, agent_sha256: linux.sha256 }, linux),
    ).toEqual({
      current: true,
      line: "web-01 already runs this build (SHA-256 975c1a33…0e9d19).",
    });
    expect(
      runningBuild({ ...host, agent_sha256: "a".repeat(64) }, linux).line,
    ).toBe(
      "web-01 runs another build (SHA-256 aaaaaaaa…aaaaaa); this server offers 0.2.0 (SHA-256 975c1a33…0e9d19).",
    );
    // An agent that doesn't report its build is never called current.
    expect(runningBuild(host, linux)).toEqual({
      current: false,
      line: "Development builds can share a version label, and web-01's agent doesn't report which build it runs, so this page can't tell whether it already runs this one.",
    });
  });

  it("runs the verified installer again with no token, mode or name", () => {
    expect(upgradeCommand(install, host)).toBe(
      [
        "(",
        "  set -e",
        "  dir=$(mktemp -d 2>/dev/null || mktemp -d -t vectory)",
        `  trap 'rm -rf "$dir"' EXIT`,
        `  printf '%s\\n' '${caPem.trimEnd()}' > "$dir/vectory-ca.pem"`,
        `  curl -fsSL --proto '=https' --proto-redir '=https' \\`,
        `    --cacert "$dir/vectory-ca.pem" \\`,
        `    -o "$dir/vectory-install.sh" \\`,
        "    https://vectory.example.test:8443/agent/v1/install.sh",
        `  echo '${install.installer!.sha256}  vectory-install.sh' \\`,
        `    | (cd "$dir" && sha256sum -c -)`,
        `  sudo sh "$dir/vectory-install.sh"`,
        ")",
      ].join("\n"),
    );
  });

  it("passes the device's own state directory and keeps a host without a service that way", () => {
    const command = upgradeCommand(install, {
      ...host,
      state_dir: "/srv/vectory state",
      service_manager: "none",
    })!;
    expect(command.split("\n").slice(-4)).toEqual([
      `  sudo sh "$dir/vectory-install.sh" \\`,
      "    --state-dir '/srv/vectory state' \\",
      "    --service none",
      ")",
    ]);
    const mac = upgradeCommand(install, {
      ...host,
      os: "darwin",
      state_dir: "/Library/Application Support/Vectory/agent",
      service_manager: "launchd",
    })!;
    expect(mac).toContain(`| (cd "$dir" && shasum -a 256 -c -)`);
    expect(mac.endsWith(`  sudo sh "$dir/vectory-install.sh"\n)`)).toBe(true);
  });

  it("offers no command for a state directory the device reports with a control character", () => {
    expect(
      upgradeCommand(install, { ...host, state_dir: "/srv/a\nb" }),
    ).toBeNull();
    expect(
      upgradeCommand(install, { ...host, state_dir: "/srv/a\u202eb" }),
    ).toBeNull();
  });

  it("checks the download with the host's certificate store for a public certificate", () => {
    const publicServer = AgentInstallSchema.parse({
      ...install,
      certificate: { ...install.certificate, publicly_trusted: true },
    });
    const command = upgradeCommand(publicServer, host)!;
    expect(command).toContain(
      "\n  curl -fsSL --proto '=https' --proto-redir '=https' \\\n",
    );
    expect(
      command.endsWith(
        `  sudo sh "$dir/vectory-install.sh" \\\n    --ca-file=\n)`,
      ),
    ).toBe(true);
  });

  it("says which systems have an upgrade command, the ones the command is for", () => {
    expect(
      ["linux", "darwin", "windows", null, undefined, "freebsd"].map(
        hasUpgradeCommand,
      ),
    ).toEqual([true, true, false, false, false, false]);
    // Whatever has a command is exactly what upgradeCommand writes one for.
    for (const os of ["linux", "darwin", "windows"] as const)
      expect(upgradeCommand(install, { ...host, os }) !== null).toBe(
        hasUpgradeCommand(os),
      );
  });

  it("offers no command where the installer can't do it, and never turns verification off", () => {
    expect(upgradeCommand(install, { ...host, os: "windows" })).toBeNull();
    expect(
      upgradeCommand(
        AgentInstallSchema.parse({ ...install, installer: null }),
        host,
      ),
    ).toBeNull();
    // A pinned download needs the CA certificate itself.
    expect(
      upgradeCommand(
        AgentInstallSchema.parse({
          ...install,
          certificate: { ...install.certificate, ca_pem: null },
        }),
        host,
      ),
    ).toBeNull();
    for (const device of [
      host,
      { ...host, service_manager: "none" as const },
      { ...host, os: "darwin" },
    ]) {
      const command = upgradeCommand(install, device)!;
      expect(command).not.toMatch(
        /(^|\s)-[A-Za-z]*k[A-Za-z]*(\s|$)|--insecure|--no-check-certificate/,
      );
    }
  });

  it("says where the agent goes, and what an older agent doesn't tell", () => {
    expect(upgradeNotes(install, host)).toEqual([
      "The agent goes to /usr/local/bin. If web-01's agent is installed somewhere else, add `--install-dir` with that directory.",
    ]);
    expect(
      upgradeNotes(install, {
        ...host,
        state_dir: undefined,
        service_manager: "none",
      }),
    ).toEqual([
      "The agent goes to /usr/local/bin. If web-01's agent is installed somewhere else, add `--install-dir` with that directory.",
      "web-01's agent doesn't report its state directory. If it isn't the default, add `--state-dir` with it; otherwise setup treats this as a new installation.",
      "Nothing restarts `vectory run` for you: setup says when to stop it and start it again on the new build.",
    ]);
  });
});
