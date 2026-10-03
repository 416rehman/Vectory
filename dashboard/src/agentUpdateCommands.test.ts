import { describe, expect, it } from "vitest";
import { hasConsentCommand, upgradeCommand } from "./agentUpgradeModel";
import {
  consentChoices,
  consentFor,
  trackChoices,
  updateVerbCommand,
  windowsConsentCommand,
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
import {
  install,
  report,
  teamFingerprint,
} from "./agentUpdateFixtures.test-support";

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

  it("carries only what a command changes on a host that already takes updates, and needs a choice for one that doesn't", () => {
    // Never the level, windows or track the device reported about itself:
    // its own service account writes that report.
    const consenting = report({
      consent: "ask",
      track: "minor",
      windows: ["Sat 01:00-03:00"],
    });
    expect(
      consentFor(consenting, teamFingerprint, { change: { pinKey: true } }),
    ).toEqual({ level: "keep", key: teamFingerprint });
    expect(
      consentFor(report({ consent: "auto" }), teamFingerprint, {
        change: { track: "minor" },
      }),
    ).toEqual({ level: "keep", track: "minor" });
    expect(consentFor(consenting, teamFingerprint)).toEqual({ level: "keep" });
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

  it("writes an amend as the flags it changes and nothing else", () => {
    expect(updateArguments({ level: "keep" }, "linux")).toEqual([]);
    expect(
      updateArguments({ level: "keep", key: teamFingerprint }, "linux"),
    ).toEqual(["--update-key-sha256", teamFingerprint]);
    expect(
      updateArguments({ level: "keep", track: "minor" }, "windows"),
    ).toEqual(["--update-track", "minor"]);
    expect(() =>
      updateArguments({ level: "keep", key: "3f9a1c02" }, "linux"),
    ).toThrow();
    // An upgrade for a host that agreed already carries no update flag at all.
    const plain = upgradeCommand(install, host, { level: "keep" })!;
    expect(plain).not.toContain("--update");
    expect(
      upgradeCommand(install, host, { level: "keep", key: teamFingerprint })!,
    ).toContain(`--update-key-sha256 ${teamFingerprint}`);
    expect(
      upgradeCommand(install, host, { level: "keep", key: teamFingerprint })!,
    ).not.toContain("--updates");
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

describe("the command that gives an enrolled Windows host its consent", () => {
  const windows = {
    os: "windows",
    state_dir: "C:\\ProgramData\\Vectory\\agent",
    service_manager: "windows" as const,
  };

  it("runs the agent that is installed, in an elevated PowerShell, with only the update flags", () => {
    const command = windowsConsentCommand(windows, automatic)!;
    const [comment, run] = command.split("\n");
    expect(comment).toBe("# In an elevated PowerShell:");
    expect(run).toBe(
      `& 'C:\\Program Files\\Vectory\\vectory.exe' setup --updates auto --update-key-sha256 ${teamFingerprint} --update-track patch --update-window 'Mon-Fri 02:00-04:00'`,
    );
    // The window reaches setup as one argument, with its space.
    expect(powerShellWords(run).slice(-2)).toEqual([
      "--update-window",
      "Mon-Fri 02:00-04:00",
    ]);
    // It replaces no file, and names no server: setup keeps the address the host enrolled with.
    for (const word of [
      "sudo",
      "--server",
      "curl",
      "Get-FileHash",
      "--state-dir",
    ])
      expect(command).not.toContain(word);
  });

  it("names the state directory only when the agent keeps it elsewhere, quoted", () => {
    const command = windowsConsentCommand(
      { ...windows, state_dir: "D:\\Vectory data\\agent" },
      automatic,
    )!;
    expect(command.split("\n")[1]).toContain(
      "setup --state-dir 'D:\\Vectory data\\agent' --updates auto",
    );
    expect(powerShellWords(command.split("\n")[1]).slice(3, 5)).toEqual([
      "--state-dir",
      "D:\\Vectory data\\agent",
    ]);
  });

  it("changes one part of what the host agreed to, and nothing else", () => {
    expect(
      windowsConsentCommand(windows, {
        level: "keep",
        key: teamFingerprint,
      })!.split("\n")[1],
    ).toBe(
      `& 'C:\\Program Files\\Vectory\\vectory.exe' setup --update-key-sha256 ${teamFingerprint}`,
    );
    expect(
      windowsConsentCommand(windows, { level: "keep", track: "minor" })!.split(
        "\n",
      )[1],
    ).toContain("setup --update-track minor");
    expect(
      windowsConsentCommand(windows, { level: "off" })!.split("\n")[1],
    ).toContain("setup --updates off");
  });

  it("is for Windows hosts only, and refuses what can't be quoted or isn't a whole fingerprint", () => {
    expect(windowsConsentCommand(host, automatic)).toBeNull();
    expect(
      windowsConsentCommand({ ...windows, os: "darwin" }, automatic),
    ).toBeNull();
    expect(
      windowsConsentCommand(
        { ...windows, state_dir: "C:\\data\\\u0007" },
        automatic,
      ),
    ).toBeNull();
    expect(
      windowsConsentCommand(windows, { ...automatic, key: "3f9a1c02" }),
    ).toBeNull();
    expect(
      windowsConsentCommand(windows, {
        ...automatic,
        windows: ["Mon-Fri 02:00-04:00'; reboot #"],
      }),
    ).toBeNull();
  });

  it("is offered where a command can be made: Linux and macOS by the upgrade command, and Windows by this one", () => {
    expect(["linux", "darwin", "windows"].map(hasConsentCommand)).toEqual([
      true,
      true,
      true,
    ]);
    for (const other of ["freebsd", "", null, undefined])
      expect(hasConsentCommand(other)).toBe(false);
  });
});
