import { describe, expect, it } from "vitest";
import { AgentInstallSchema, type AgentInstall } from "./api";
import {
  installerCommand,
  platformDefaults,
  quote,
  setupArguments,
  setupCommand,
  fingerprintRows,
  shortFingerprint,
  windowsCommand,
  type SetupChoices,
} from "./enrollmentCommands";
import { eventsFor, progress, refusal } from "./enrollmentActivity";

const pin = "1f3c" + "0".repeat(56) + "9ab0";
const installerSha = "c0f4e1b7" + "1".repeat(50) + "9d19ab";
const windowsSha = "e".repeat(64);
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

describe("install commands", () => {
  it("download the installer, check it against the page's SHA-256 and pass only choices", () => {
    expect(installerCommand(install, choices())).toBe(
      [
        "curl -fsSLk https://vectory.example.test:8443/agent/v1/install.sh -o vectory-install.sh",
        `echo '${installerSha}  vectory-install.sh' | sha256sum -c - &&`,
        "  sudo sh vectory-install.sh \\",
        "    --mode restricted \\",
        "    --create-user",
      ].join("\n"),
    );
    const mac = installerCommand(
      install,
      choices({ os: "darwin", mode: "full" }),
    );
    expect(mac).toContain(
      "| shasum -a 256 -c - &&\n  sudo sh vectory-install.sh \\\n    --mode full",
    );
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
    expect(installerCommand(publicInstall, choices())).toMatch(
      /^curl -fsSL https/,
    );
    expect(setupCommand(publicInstall, choices())).not.toContain("--ca-sha256");
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

  it("shows fingerprints the way the agent prints them", () => {
    expect(shortFingerprint(pin)).toBe("1F:3C:...:9A:B0");
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
});
