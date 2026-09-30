import { describe, expect, it } from "vitest";
import { AgentInstallSchema, type AgentInstall } from "./api";
import {
  effectiveTrust,
  fingerprint,
  installerCommand,
  platformDefaults,
  quote,
  runCommand,
  setupArguments,
  setupCommand,
  fingerprintRows,
  trustChoices,
  windowsCommand,
  type SetupChoices,
} from "./enrollmentCommands";
import {
  eventsFor,
  mergeAttempts,
  progress,
  refusal,
  supervision,
  unsupervisedLine,
} from "./enrollmentActivity";

const pin = "1f3c" + "0".repeat(56) + "9ab0";
const installerSha = "c0f4e1b7" + "1".repeat(50) + "9d19ab";
const windowsSha = "e".repeat(64);
// A synthetic certificate: only its PEM shape matters here.
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBszCCAVmgAwIBAgIUU3ludGhldGljIGFnZW50IENBIGZvciB0ZXN0cy4wCgYI",
  "U3ludGhldGljU3ludGhldGljU3ludGhldGlj==",
  "-----END CERTIFICATE-----",
  "",
].join("\n");
const install: AgentInstall = AgentInstallSchema.parse({
  agent_url: "https://vectory.example.test:8443",
  agent_url_configured: false,
  listener_enabled: true,
  dashboard_url: "https://vectory.example.test",
  certificate: {
    available: true,
    publicly_trusted: false,
    ca_sha256: pin,
    ca_fingerprint: null,
    ca_pem: caPem,
    ca_name: "Example agent CA",
    ca_issuer: "Example agent CA",
    ca_not_after: null,
    problem: null,
  },
  downloads_enabled: true,
  installer: {
    url: "https://vectory.example.test:8443/agent/v1/install.sh",
    sha256: installerSha,
    platforms: ["linux/amd64", "darwin/arm64"],
  },
  default_install_dir: "/usr/local/bin",
  releases: [
    {
      name: "vectory-0.1.0-windows-amd64.exe",
      os: "windows",
      arch: "amd64",
      version: "0.1.0",
      sha256: windowsSha,
      size: 7_000_000,
      url: "/api/v1/releases/vectory-0.1.0-windows-amd64.exe",
      signed: false,
      source: "bundled",
    },
  ],
  catalog_problems: [],
});
const choices = (overrides: Partial<SetupChoices> = {}): SetupChoices => ({
  os: "linux",
  mode: "restricted",
  name: "",
  service: "auto",
  serviceUser: "",
  createUser: true,
  stateDir: "",
  managedConfig: "",
  capabilityPolicy: "",
  ...overrides,
});

/** Every option that turns certificate verification off, in any shell. */
function insecureOptions(command: string) {
  return command
    .split(/\s+/)
    .filter(
      (word) =>
        /^-[A-Za-z]*k[A-Za-z]*$/.test(word) ||
        /^--(insecure|proxy-insecure|no-check-certificate)$/.test(word) ||
        /^-SkipCertificateCheck/i.test(word) ||
        /ServerCertificateValidationCallback/i.test(word),
    );
}

describe("install commands", () => {
  it("pin the server's CA for the download, check the installer's SHA-256 and pass only choices", () => {
    expect(installerCommand(install, choices())).toBe(
      [
        `printf '%s\\n' '${caPem.trimEnd()}' > vectory-ca.pem &&`,
        "curl -fsSL --cacert vectory-ca.pem \\",
        "  -o vectory-install.sh \\",
        "  https://vectory.example.test:8443/agent/v1/install.sh &&",
        `echo '${installerSha}  vectory-install.sh' \\`,
        "  | sha256sum -c - &&",
        "sudo sh vectory-install.sh \\",
        "  --mode restricted \\",
        "  --create-user",
      ].join("\n"),
    );
    const mac = installerCommand(
      install,
      choices({ os: "darwin", mode: "full" }),
    );
    expect(mac).toContain(
      "  | shasum -a 256 -c - &&\nsudo sh vectory-install.sh \\\n  --mode full",
    );
  });

  it("gives each certificate choice its exact option, for the download and for setup", () => {
    // A CA certificate file on the host: curl and setup both read it.
    expect(
      installerCommand(
        install,
        choices({ trust: "file", caFile: "/etc/vectory/server-ca.pem" }),
      ),
    ).toBe(
      [
        "curl -fsSL --cacert /etc/vectory/server-ca.pem \\",
        "  -o vectory-install.sh \\",
        "  https://vectory.example.test:8443/agent/v1/install.sh &&",
        `echo '${installerSha}  vectory-install.sh' \\`,
        "  | sha256sum -c - &&",
        "sudo sh vectory-install.sh \\",
        "  --mode restricted \\",
        "  --ca-file /etc/vectory/server-ca.pem \\",
        "  --create-user",
      ].join("\n"),
    );
    expect(
      setupCommand(
        install,
        choices({ trust: "file", caFile: "/etc/vectory/server-ca.pem" }),
      ),
    ).toContain("  --ca-file /etc/vectory/server-ca.pem \\");
    // The host's own trusted certificates: an explicit, empty --ca-file=.
    const system = installerCommand(install, choices({ trust: "system" }))!;
    expect(system.split("\n").slice(0, 3)).toEqual([
      "curl -fsSL \\",
      "  -o vectory-install.sh \\",
      "  https://vectory.example.test:8443/agent/v1/install.sh &&",
    ]);
    expect(system).toContain("  --ca-file= \\");
    expect(setupCommand(install, choices({ trust: "system" }))).toContain(
      "  --ca-file= \\",
    );
    // Pinned: setup gets the fingerprint; the installer adds it by itself.
    expect(setupCommand(install, choices())).toContain(`  --ca-sha256 ${pin}`);
    expect(installerCommand(install, choices())).not.toMatch(
      /--ca-sha256|--ca-file/,
    );
    // An unfinished choice produces no command rather than a weaker one.
    expect(installerCommand(install, choices({ trust: "file" }))).toBeNull();
    expect(setupCommand(install, choices({ trust: "file" }))).toBeNull();
    // A pin needs the certificate: without it there is no installer command.
    const noPem = {
      ...install,
      certificate: { ...install.certificate!, ca_pem: undefined },
    };
    expect(installerCommand(noPem, choices())).toBeNull();
  });

  it("puts the agent where Advanced says and starts it from there", () => {
    const command = installerCommand(
      install,
      choices({ installDir: "/opt/vectory agent/bin" }),
    )!;
    expect(command).toContain(
      "sudo sh vectory-install.sh \\\n  --mode restricted \\\n  --install-dir '/opt/vectory agent/bin' \\\n",
    );
    expect(
      runCommand(
        install,
        choices({ installDir: "/opt/vectory agent/bin" }),
        true,
      ),
    ).toBe(
      "sudo '/opt/vectory agent/bin/vectory' run --state-dir /var/lib/vectory-agent",
    );
  });

  it("never turns certificate verification off, for any platform, mode or server", () => {
    const servers = [
      install,
      {
        ...install,
        certificate: { ...install.certificate!, publicly_trusted: true },
      },
      { ...install, installer: null },
      { ...install, certificate: null },
    ];
    let checked = 0;
    for (const server of servers)
      for (const os of ["linux", "darwin", "windows"] as const)
        for (const mode of ["restricted", "full"] as const)
          for (const trust of [undefined, "pinned", "file", "system"] as const)
            for (const service of ["auto", "none"] as const)
              for (const installDir of ["", "/opt/vectory/bin"]) {
                const picked = choices({
                  os,
                  mode,
                  trust,
                  service,
                  installDir,
                  caFile: os === "windows" ? "C:\\ca.pem" : "/etc/ca.pem",
                });
                for (const command of [
                  installerCommand(server, picked),
                  setupCommand(server, picked),
                  windowsCommand(server, picked, server.releases[0]),
                  runCommand(server, picked, true),
                ]) {
                  if (!command) continue;
                  checked++;
                  expect(insecureOptions(command), command).toEqual([]);
                }
              }
    expect(checked).toBeGreaterThan(500);
    expect(insecureOptions("curl -fsSLk https://x")).toEqual(["-fsSLk"]);
    expect(insecureOptions("iwr -SkipCertificateCheck")).toHaveLength(1);
  });

  it("passes a Vector binary that isn't on PATH, one option per line", () => {
    expect(
      setupCommand(
        install,
        choices({ vectorBinary: "/opt/vector/bin/vector", createUser: false }),
      ),
    ).toBe(
      [
        "sudo vectory setup \\",
        "  --server https://vectory.example.test:8443 \\",
        `  --ca-sha256 ${pin} \\`,
        "  --mode restricted \\",
        "  --vector-binary /opt/vector/bin/vector",
      ].join("\n"),
    );
  });

  it("shows the whole CA fingerprint in rows of eight pairs", () => {
    const rows = fingerprintRows(pin);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe("1F:3C:00:00:00:00:00:00");
    expect(rows[3]).toBe("00:00:00:00:00:00:9A:B0");
  });

  it("verifies TLS normally when the listener is publicly trusted and never pins then", () => {
    const publicInstall = {
      ...install,
      certificate: { ...install.certificate!, publicly_trusted: true },
    };
    expect(trustChoices(publicInstall)).toEqual(["system", "file"]);
    expect(trustChoices(install)).toEqual(["pinned", "file", "system"]);
    // A pin chosen before is not offered for a public certificate.
    expect(effectiveTrust(publicInstall, "pinned")).toBe("system");
    expect(installerCommand(publicInstall, choices())).toMatch(
      /^curl -fsSL \\\n {2}-o vectory-install\.sh \\\n {2}https:/,
    );
    expect(setupCommand(publicInstall, choices())).not.toContain("--ca-sha256");
    expect(setupCommand(publicInstall, choices())).toContain("--ca-file=");
    expect(setupCommand(install, choices())).toBe(
      [
        "sudo vectory setup \\",
        "  --server https://vectory.example.test:8443 \\",
        `  --ca-sha256 ${pin} \\`,
        "  --mode restricted \\",
        "  --create-user",
      ].join("\n"),
    );
  });

  it("omits defaults and quotes operator values for each shell", () => {
    const defaults = platformDefaults("linux");
    expect(
      setupArguments(
        choices({
          name: "edge-01",
          serviceUser: "vectory",
          stateDir: defaults.stateDir,
          managedConfig: "/srv/owner's vector/vector.json",
          capabilityPolicy: "/etc/vectory/capabilities.json",
        }),
      ),
    ).toEqual([
      "--mode",
      "restricted",
      "--name",
      "edge-01",
      "--create-user",
      "--managed-config",
      `'/srv/owner'"'"'s vector/vector.json'`,
      "--capability-policy",
      "/etc/vectory/capabilities.json",
    ]);
    expect(
      setupArguments(choices({ mode: "full", capabilityPolicy: "/x.json" })),
    ).not.toContain("--capability-policy");
    expect(
      setupArguments(choices({ service: "none", createUser: true })),
    ).toEqual(["--mode", "restricted", "--service", "none"]);
    expect(quote("C:\\Owner's Vector\\vector.json", "windows")).toBe(
      "'C:\\Owner''s Vector\\vector.json'",
    );
  });

  it("checks the Windows agent's SHA-256 before running setup and has no installer", () => {
    const command = windowsCommand(
      install,
      choices({ os: "windows" }),
      install.releases[0],
    )!;
    expect(command.split("\n")[0]).toBe(
      `if ((Get-FileHash .\\vectory.exe -Algorithm SHA256).Hash -ne '${windowsSha}') { throw 'vectory.exe does not match its SHA-256. Download it again.' }`,
    );
    expect(command.split("\n")[1]).toBe(
      `.\\vectory.exe setup --server https://vectory.example.test:8443 --ca-sha256 ${pin} --mode restricted`,
    );
    expect(installerCommand(install, choices({ os: "windows" }))).toBeNull();
  });

  it("never renders a command from values that could inject shell syntax", () => {
    const hostile = {
      ...install,
      agent_url: "https://example.test;rm -rf /",
    };
    expect(AgentInstallSchema.safeParse(hostile).success).toBe(false);
    const badDigest = {
      ...install,
      installer: { ...install.installer!, sha256: "' && curl evil" },
    };
    expect(AgentInstallSchema.safeParse(badDigest).success).toBe(false);
  });

  it("shows fingerprints in full, the way the agent prints them", () => {
    expect(fingerprint(pin)).toBe("1F:3C:" + "00:".repeat(28) + "9A:B0");
  });

  it("starts an agent without a service where this page's command put it", () => {
    expect(runCommand(install, choices(), true)).toBe(
      "sudo /usr/local/bin/vectory run --state-dir /var/lib/vectory-agent",
    );
    expect(
      runCommand(
        { default_install_dir: "/opt/vectory/bin/" },
        choices({ stateDir: "/srv/agent state" }),
        true,
      ),
    ).toBe("sudo /opt/vectory/bin/vectory run --state-dir '/srv/agent state'");
    // An agent copied to the host is run from PATH, like its setup command.
    expect(runCommand(install, choices({ os: "darwin" }), false)).toBe(
      "sudo vectory run --state-dir '/Library/Application Support/Vectory/agent'",
    );
    expect(runCommand(install, choices({ os: "windows" }), true)).toBe(
      ".\\vectory.exe run --state-dir 'C:\\ProgramData\\Vectory\\agent'",
    );
  });
});

describe("enrollment activity", () => {
  const event = (overrides: Record<string, unknown>) => ({
    id: String(Math.random()),
    created_at: "2026-09-29T10:00:00Z",
    outcome: "failure" as const,
    reason_code: null,
    device_id: null,
    device_name: "edge-01",
    token_id: null,
    agent_os: "linux",
    agent_arch: "amd64",
    agent_version: "0.1.0",
    configuration_mode: "restricted",
    client_address: "10.0.4.17",
    ...overrides,
  });
  const device = {
    id: "d1",
    name: "edge-01",
    os: "linux",
    arch: "amd64",
    status: "online",
    last_seen: null,
  } as never;

  it("keeps this token's attempts and unknown-token refusals, oldest first", () => {
    const events = [
      event({
        outcome: "success",
        token_id: "t1",
        device_id: "d1",
        created_at: "2026-09-29T10:00:03Z",
      }),
      event({ reason_code: "TOKEN_EXPIRED", token_id: "t2" }),
      event({
        reason_code: "TOKEN_UNKNOWN",
        created_at: "2026-09-29T10:00:01Z",
      }),
    ];
    expect(
      eventsFor(events, "t1").map((e) => e.reason_code || e.outcome),
    ).toEqual(["TOKEN_UNKNOWN", "success"]);
    expect(refusal(events[1]).title).toBe("the token expired");
  });

  it("adds what the page saw live to the day's attempts, once each and newest first", () => {
    const old = event({ id: "a1", created_at: "2026-09-29T09:00:00Z" });
    const live = event({
      id: "a2",
      outcome: "success",
      created_at: "2026-09-29T10:00:05Z",
    });
    expect(
      mergeAttempts([old], [live, { ...old }]).map((item) => item.id),
    ).toEqual(["a2", "a1"]);
  });

  it("follows the enrolled device to its first check-in", () => {
    const enrolled = [
      event({ outcome: "success", token_id: "t1", device_id: "d1" }),
    ];
    const waiting = progress(enrolled, [device], "t1", new Set(), "");
    expect(waiting.device?.id).toBe("d1");
    expect(waiting.checkedIn).toBe(false);
    const connected = progress(
      enrolled,
      [{ ...(device as object), last_seen: "2026-09-29T10:00:05Z" } as never],
      "t1",
      new Set(),
      "",
    );
    expect(connected.checkedIn).toBe(true);
    const refused = progress(
      [event({ reason_code: "NAME_TAKEN", token_id: "t1" })],
      [],
      "t1",
      new Set(),
      "",
    );
    expect(refused.refused?.reason_code).toBe("NAME_TAKEN");
  });

  it("without activity, only a new device with the chosen name counts, and revoked is never connected", () => {
    const baseline = new Set(["d0"]);
    const old = {
      ...(device as object),
      id: "d0",
      last_seen: "2026-09-29T10:00:00Z",
    } as never;
    expect(progress([], [old], "t1", baseline, "edge-01").device).toBeNull();
    const revoked = {
      ...(device as object),
      status: "revoked",
      last_seen: "2026-09-29T10:00:00Z",
    } as never;
    const state = progress([], [old, revoked], "t1", baseline, "edge-01");
    expect(state.revoked).toBe(true);
    expect(state.checkedIn).toBe(false);
  });

  it("says when nothing keeps a connected agent running, until it checks in again", () => {
    const first = "2026-09-29T10:00:05Z";
    expect(
      supervision({ service_manager: "systemd", last_seen: first }, first),
    ).toBe("supervised");
    // An older agent doesn't say: nothing is claimed about it.
    expect(supervision({ last_seen: first }, first)).toBe("supervised");
    expect(
      supervision({ service_manager: "none", last_seen: first }, first),
    ).toBe("unsupervised");
    // Setup's own follow-up check-in lands within seconds.
    expect(
      supervision(
        { service_manager: "none", last_seen: "2026-09-29T10:00:07Z" },
        first,
      ),
    ).toBe("unsupervised");
    expect(
      supervision(
        { service_manager: "none", last_seen: "2026-09-29T10:01:05Z" },
        first,
      ),
    ).toBe("running");
    const line = unsupervisedLine(
      "r16-auto",
      "sudo /opt/x/vectory run --state-dir /var/lib/vectory-agent",
      "linux",
      false,
    );
    expect(`${line.title} ${line.before}${line.command}${line.after}`).toBe(
      "r16-auto checked in once, but nothing keeps its agent running. Start it with sudo /opt/x/vectory run --state-dir /var/lib/vectory-agent, or use a host with systemd.",
    );
    const chosen = unsupervisedLine("lab-1", "sudo vectory run", "linux", true);
    expect(chosen.after).toBe(
      " and keep it running under your own supervisor.",
    );
    expect(unsupervisedLine("mac-1", "x", "darwin", false).after).toBe(
      ", or use a host with launchd.",
    );
  });
});
