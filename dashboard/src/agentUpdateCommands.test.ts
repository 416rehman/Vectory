import { describe, expect, it } from "vitest";
import { AgentInstallSchema, type AgentInstall } from "./api";
import { upgradeCommand } from "./agentUpgradeModel";
import {
  consentChoices,
  consentFor,
  trackChoices,
  updateVerbCommand,
} from "./agentUpdateCommands";
import {
  installerCommand,
  setupArguments,
  setupCommand,
  updateArguments,
  windowsCommand,
  type SetupChoices,
  type UpdateConsent,
} from "./enrollmentCommands";
import { powerShellWords } from "./powershellText.test-support";
import { report, teamFingerprint } from "./agentUpdateFixtures.test-support";

const installerSha = "c0f4e1b7" + "1".repeat(50) + "9d19ab";
const caPem = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBszCCAVmgAwIBAgIUU3ludGhldGljIGFnZW50IENBIGZvciB0ZXN0cy4wCgYI",
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
    ca_sha256: "1f3c" + "0".repeat(56) + "9ab0",
    ca_pem: caPem,
    problem: null,
  },
  downloads_enabled: true,
  installer: {
    url: "https://vectory.example.test:8443/agent/v1/install.sh",
    sha256: installerSha,
    platforms: ["linux/amd64"],
  },
  default_install_dir: "/usr/local/bin",
  releases: [
    {
      name: "vectory-0.1.0-windows-amd64.exe",
      os: "windows",
      arch: "amd64",
      version: "0.1.0",
      sha256: "e".repeat(64),
      size: 7_000_000,
      url: "/api/v1/releases/vectory-0.1.0-windows-amd64.exe",
      signed: false,
    },
  ],
  catalog_problems: [],
});
const choices = (over: Partial<SetupChoices> = {}): SetupChoices => ({
  os: "linux",
  mode: "restricted",
  name: "edge-01",
  service: "auto",
  serviceUser: "",
  createUser: true,
  stateDir: "",
  managedConfig: "",
  capabilityPolicy: "",
  ...over,
});
const automatic: UpdateConsent = {
  level: "auto",
  track: "patch",
  windows: ["Mon-Fri 02:00-04:00"],
  key: teamFingerprint,
};
const host = {
  os: "linux",
  state_dir: "/var/lib/vectory-agent",
  service_manager: "systemd" as const,
};

describe("a command without a choice about updates is what it was", () => {
  it("adds nothing to setup", () => {
    expect(setupArguments(choices())).toEqual(
      setupArguments(choices({ updates: undefined })),
    );
    expect(setupArguments(choices()).join(" ")).not.toMatch(/update/);
    expect(installerCommand(install, choices())).not.toMatch(/update/);
    expect(upgradeCommand(install, host)).not.toMatch(/update/);
    expect(updateArguments(undefined, "linux")).toEqual([]);
  });
});

describe("a command that carries a host's consent", () => {
  it("writes the four flags of the design, in order", () => {
    expect(updateArguments(automatic, "linux")).toEqual([
      "--updates",
      "auto",
      "--update-key-sha256",
      teamFingerprint,
      "--update-track",
      "patch",
      "--update-window",
      "'Mon-Fri 02:00-04:00'",
    ]);
  });

  it("puts the install command's flags one to a line, the window in quotes", () => {
    const command = installerCommand(install, choices({ updates: automatic }))!;
    expect(command.split("\n").slice(-7)).toEqual([
      "    --name edge-01 \\",
      "    --create-user \\",
      "    --updates auto \\",
      `    --update-key-sha256 ${teamFingerprint} \\`,
      "    --update-track patch \\",
      "    --update-window 'Mon-Fri 02:00-04:00'",
      ")",
    ]);
  });

  it("asks nothing of a host that was told off, and says so", () => {
    expect(updateArguments({ level: "off" }, "linux")).toEqual([
      "--updates",
      "off",
    ]);
    const command = installerCommand(
      install,
      choices({ updates: { level: "off" } }),
    )!;
    expect(command).toContain("--updates off");
    expect(command).not.toContain("--update-key-sha256");
    expect(command).not.toContain("--update-track");
  });

  it("carries several windows, each its own flag", () => {
    expect(
      updateArguments(
        {
          ...automatic,
          level: "ask",
          track: "minor",
          windows: ["daily 01:00-02:00", "Sat,Sun 03:00-05:00 UTC"],
        },
        "linux",
      ),
    ).toEqual([
      "--updates",
      "ask",
      "--update-key-sha256",
      teamFingerprint,
      "--update-track",
      "minor",
      "--update-window",
      "'daily 01:00-02:00'",
      "--update-window",
      "'Sat,Sun 03:00-05:00 UTC'",
    ]);
  });

  it("refuses a key that is not a whole fingerprint", () => {
    for (const key of [
      teamFingerprint.slice(0, 16),
      teamFingerprint.toUpperCase(),
      `${teamFingerprint} --service none`,
      "",
    ])
      expect(() => updateArguments({ ...automatic, key }, "linux")).toThrow();
    // The page then offers no command at all.
    expect(
      installerCommand(
        install,
        choices({ updates: { ...automatic, key: "3f9a1c02" } }),
      ),
    ).toBeNull();
  });

  it("refuses a window holding a quote, in either shell, rather than quote it", () => {
    for (const windows of [
      ["Mon-Fri 02:00-04:00'; reboot #"],
      ['Mon-Fri 02:00-04:00" '],
      ["Mon-Fri 02:00-04:00\nUTC"],
      Array.from({ length: 8 }, (_, i) => `daily 0${i}:00-0${i}:30`),
    ]) {
      for (const os of ["linux", "windows"] as const)
        expect(() => updateArguments({ ...automatic, windows }, os)).toThrow();
      expect(
        installerCommand(
          install,
          choices({ updates: { ...automatic, windows } }),
        ),
      ).toBeNull();
    }
  });

  it("quotes the window for PowerShell as one argument", () => {
    const command = windowsCommand(
      install,
      choices({ os: "windows", updates: automatic }),
      install.releases[0],
    )!;
    const setup = command.split("\n").at(-1)!;
    expect(setup).toContain(
      `--updates auto --update-key-sha256 ${teamFingerprint} --update-track patch --update-window 'Mon-Fri 02:00-04:00'`,
    );
    const words = powerShellWords(setup);
    expect(words.slice(-8)).toEqual([
      "--updates",
      "auto",
      "--update-key-sha256",
      teamFingerprint,
      "--update-track",
      "patch",
      "--update-window",
      "Mon-Fri 02:00-04:00",
    ]);
  });

  it("goes into the manual setup command too", () => {
    expect(
      setupCommand(install, choices({ updates: automatic }))!
        .split("\n")
        .slice(-4),
    ).toEqual([
      "  --updates auto \\",
      `  --update-key-sha256 ${teamFingerprint} \\`,
      "  --update-track patch \\",
      "  --update-window 'Mon-Fri 02:00-04:00'",
    ]);
  });

  it("goes into an upgrade, after the host's own state directory", () => {
    const command = upgradeCommand(
      install,
      { ...host, state_dir: "/srv/vectory state", service_manager: "none" },
      automatic,
    )!;
    expect(command.split("\n").slice(-7)).toEqual([
      "    --state-dir '/srv/vectory state' \\",
      "    --service none \\",
      "    --updates auto \\",
      `    --update-key-sha256 ${teamFingerprint} \\`,
      "    --update-track patch \\",
      "    --update-window 'Mon-Fri 02:00-04:00'",
      ")",
    ]);
    expect(
      upgradeCommand(install, { ...host, os: "windows" }, automatic),
    ).toBeNull();
  });
});

describe("the choices a person makes", () => {
  it("offers three levels and two tracks, none chosen for them", () => {
    expect(consentChoices.map((choice) => choice.label)).toEqual([
      "Automatic (recommended)",
      "Ask on the host",
      "Off",
    ]);
    expect(consentChoices[0].description).toBe(
      "Installs new agent builds when an update rollout reaches this device, inside the window you set",
    );
    expect(consentChoices[1].description).toBe(
      "Downloads and checks the build, then waits for someone to run sudo vectory update apply",
    );
    expect(consentChoices[2].description).toBe(
      "This host updates only by hand",
    );
    expect(trackChoices.map((choice) => choice.label)).toEqual([
      "Patch releases",
      "Minor releases too",
    ]);
  });

  it("keeps what a host already allows, and needs a choice for one that doesn't", () => {
    expect(
      consentFor(report({ consent: "ask", track: "minor" }), teamFingerprint),
    ).toEqual({
      level: "ask",
      track: "minor",
      windows: ["Mon-Fri 02:00-04:00"],
      key: teamFingerprint,
    });
    expect(
      consentFor(report({ consent: "auto" }), teamFingerprint, {
        track: "minor",
      }),
    ).toMatchObject({ level: "auto", track: "minor" });
    expect(consentFor(report({ consent: "off" }), teamFingerprint)).toBeNull();
    expect(consentFor(null, teamFingerprint)).toBeNull();
    expect(
      consentFor(report({ consent: "off" }), teamFingerprint, {
        choice: { level: "ask" },
      }),
    ).toEqual({
      level: "ask",
      track: "patch",
      windows: [],
      key: teamFingerprint,
    });
  });
});

describe("what to run on a host about an update", () => {
  it("applies a staged build with sudo, and with the host's own state directory", () => {
    expect(updateVerbCommand("apply", host)).toBe("sudo vectory update apply");
    expect(
      updateVerbCommand("apply", { ...host, state_dir: "/srv/vectory state" }),
    ).toBe("sudo vectory update apply \\\n  --state-dir '/srv/vectory state'");
    expect(updateVerbCommand("resume", host)).toBe(
      "sudo vectory update resume",
    );
  });

  it("uses an elevated PowerShell on Windows", () => {
    expect(
      updateVerbCommand("status", {
        os: "windows",
        state_dir: "C:\\ProgramData\\Vectory\\agent",
        service_manager: "windows",
      }),
    ).toBe(
      "# In an elevated PowerShell:\n& 'C:\\Program Files\\Vectory\\vectory.exe' update status",
    );
  });

  it("offers no command for a state directory no shell can carry", () => {
    expect(
      updateVerbCommand("apply", { ...host, state_dir: "/srv/a\nb" }),
    ).toBeNull();
  });
});
