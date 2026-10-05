import { describe, expect, it } from "vitest";
import { AgentInstallSchema, type AgentInstall } from "./api";
import { powerShellWords } from "./powershellText.test-support";
import {
  CommandValueError,
  commandValueProblem,
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
        "(",
        "  set -e",
        "  dir=$(mktemp -d 2>/dev/null || mktemp -d -t vectory)",
        `  trap 'rm -rf "$dir"' EXIT`,
        `  printf '%s\\n' '${caPem.trimEnd()}' > "$dir/vectory-ca.pem"`,
        `  curl -fsSL --proto '=https' --proto-redir '=https' \\`,
        `    --cacert "$dir/vectory-ca.pem" \\`,
        `    -o "$dir/vectory-install.sh" \\`,
        "    https://vectory.example.test:8443/agent/v1/install.sh",
        `  echo '${installerSha}  vectory-install.sh' \\`,
        `    | (cd "$dir" && sha256sum -c -)`,
        `  sudo sh "$dir/vectory-install.sh" \\`,
        "    --mode restricted \\",
        "    --create-user",
        ")",
      ].join("\n"),
    );
    const mac = installerCommand(
      install,
      choices({ os: "darwin", mode: "full" }),
    );
    expect(mac).toContain(
      `    | (cd "$dir" && shasum -a 256 -c -)\n  sudo sh "$dir/vectory-install.sh" \\\n    --mode full \\\n    --create-user\n)`,
    );
  });

  // The files are in a directory of their own that nobody else can enter, never
  // beside the person's other files, so no one can swap one between the check
  // and the run; the check and the run are one command that stops on the first
  // failure, and the download never leaves https.
  it("keeps the installer in a private directory, checks it and runs it as one unit", () => {
    for (const os of ["linux", "darwin"] as const)
      for (const trust of [undefined, "pinned", "file", "system"] as const) {
        const command = installerCommand(
          install,
          choices({ os, trust, caFile: "/etc/vectory/server-ca.pem" }),
        )!;
        const lines = command.split("\n");
        expect(lines[0], command).toBe("(");
        expect(lines.at(-1)).toBe(")");
        expect(lines[1]).toBe("  set -e");
        expect(command).toContain("dir=$(mktemp -d");
        expect(command).toContain(`trap 'rm -rf "$dir"' EXIT`);
        // No file is named in the working directory: every path is under $dir
        // (the checksum line names its file relative to the directory it enters).
        expect(
          lines.filter((line) => !line.includes("echo '")).join("\n"),
        ).not.toMatch(/(^|[\s>])vectory-(install\.sh|ca\.pem)/);
        expect(command).toContain(`-o "$dir/vectory-install.sh"`);
        expect(command).toContain(`(cd "$dir" && `);
        expect(command).toContain(`sudo sh "$dir/vectory-install.sh"`);
        // Every hop of the download stays on https, a redirect included. The
        // values are quoted: zsh looks up an unquoted =https as a command.
        expect(command).toContain("--proto '=https' --proto-redir '=https'");
        // The check precedes the run, and nothing runs after a failed step: set -e
        // ends the subshell, so no step needs a trailing &&.
        const check = Math.max(
          command.indexOf("sha256sum -c -"),
          command.indexOf("shasum -a 256 -c -"),
        );
        expect(check).toBeGreaterThan(-1);
        expect(check).toBeLessThan(command.indexOf("sudo sh"));
        expect(command).not.toContain("&&\n");
        expect(command.split("sudo sh")).toHaveLength(2);
      }
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
        "(",
        "  set -e",
        "  dir=$(mktemp -d 2>/dev/null || mktemp -d -t vectory)",
        `  trap 'rm -rf "$dir"' EXIT`,
        "  curl -fsSL --proto '=https' --proto-redir '=https' \\",
        "    --cacert /etc/vectory/server-ca.pem \\",
        `    -o "$dir/vectory-install.sh" \\`,
        "    https://vectory.example.test:8443/agent/v1/install.sh",
        `  echo '${installerSha}  vectory-install.sh' \\`,
        `    | (cd "$dir" && sha256sum -c -)`,
        `  sudo sh "$dir/vectory-install.sh" \\`,
        "    --mode restricted \\",
        "    --ca-file /etc/vectory/server-ca.pem \\",
        "    --create-user",
        ")",
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
    expect(system.split("\n").slice(4, 7)).toEqual([
      "  curl -fsSL --proto '=https' --proto-redir '=https' \\",
      `    -o "$dir/vectory-install.sh" \\`,
      "    https://vectory.example.test:8443/agent/v1/install.sh",
    ]);
    expect(system).toContain("    --ca-file= \\");
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

  it("carries what the server sends only when it cannot end a quoted string", () => {
    // A quote, a control character or a space in the server's own values must
    // never end the string they sit in: the command is refused instead.
    for (const ca_pem of [
      caPem.replace("MIIB", "MI'IB"),
      caPem.replace("MIIB", "MI\rIB"),
      caPem.replace("MIIB", "MI;IB"),
      `${caPem}$(touch x)`,
    ])
      expect(
        installerCommand(
          { ...install, certificate: { ...install.certificate!, ca_pem } },
          choices(),
        ),
      ).toBeNull();
    for (const sha256 of ["short", `${installerSha}' ; touch x ; '`])
      expect(
        installerCommand(
          { ...install, installer: { ...install.installer!, sha256 } },
          choices(),
        ),
      ).toBeNull();
    // An address with a space or a quote is quoted as one word, not split.
    const odd = installerCommand(
      { ...install, agent_url: "https://vectory.example.test:8443/a b'c" },
      choices(),
    )!;
    expect(odd).toContain(
      "  'https://vectory.example.test:8443/a b'\"'\"'c/agent/v1/install.sh'\n",
    );
    // The usual address stays bare.
    expect(installerCommand(install, choices())).toContain(
      "  https://vectory.example.test:8443/agent/v1/install.sh\n",
    );
  });

  it("puts the agent where Advanced says and starts it from there", () => {
    const command = installerCommand(
      install,
      choices({ installDir: "/opt/vectory agent/bin" }),
    )!;
    expect(command).toContain(
      `  sudo sh "$dir/vectory-install.sh" \\\n    --mode restricted \\\n    --install-dir '/opt/vectory agent/bin' \\\n`,
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
      /\n {2}curl -fsSL --proto '=https' --proto-redir '=https' \\\n {4}-o "\$dir\/vectory-install\.sh" \\\n {4}https:/,
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

  // PowerShell reads U+2018 to U+201B as single quotes, like the apostrophe, so
  // one of them in a pasted value would end its string and run the rest in the
  // elevated shell. Each is doubled, the way the apostrophe is.
  describe("PowerShell quoting", () => {
    const curlyQuotes = ["\u2018", "\u2019", "\u201A", "\u201B"];
    const valueOf = (quoted: string) => powerShellWords(`cmd ${quoted}`);

    it.each(curlyQuotes)(
      "keeps %s inside its string, so nothing after it runs",
      (character) => {
        const hostile = `a${character}; calc; ${character}`;
        const quoted = quote(hostile, "windows");
        expect(quoted).toBe(
          `'a${character}${character}; calc; ${character}${character}'`,
        );
        expect(valueOf(quoted)).toEqual(["cmd", hostile]);
      },
    );

    it("returns every value exactly as one argument", () => {
      const values = [
        "plain",
        "two words",
        "C:\\Owner's Vector\\vector.json",
        "C:\\Program Files\\Vectory\\agent",
        "a'b",
        "'",
        "''",
        "'a'",
        "\u2019",
        "\u2018\u2019",
        "\u2019'\u2018",
        "\u201A\u201B\u2019\u2018'",
        "x\u2019\u2019y",
        "a;b | c & d",
        "$(calc)",
        "`calc`",
        "$env:USERNAME",
        "a,b",
        "@foo",
        "@(calc)",
        "100%",
        "C:\\data #1",
        "~",
        "*.log",
        "{a}",
        "--%",
        "-NoProfile",
      ];
      for (const value of values)
        expect(valueOf(quote(value, "windows")), value).toEqual(["cmd", value]);
    });

    it("quotes a value PowerShell would read as syntax, and leaves plain ones bare", () => {
      expect(quote(pin, "windows")).toBe(pin);
      expect(quote("https://vectory.example.test:8443", "windows")).toBe(
        "https://vectory.example.test:8443",
      );
      expect(quote("edge-01.example_net", "windows")).toBe(
        "edge-01.example_net",
      );
      for (const value of ["a,b", "@foo", "--%", "100%", "a b", "a;b", "-b"])
        expect(quote(value, "windows"), value).toMatch(/^'.*'$/);
    });

    it("refuses what no command can carry, for either shell", () => {
      for (const os of ["linux", "darwin", "windows"] as const) {
        for (const value of [
          "a\nb",
          "a\rb",
          "a\tb",
          "a\u0000b",
          "a\u001bb",
          "a\u007fb",
          "a\u0085b",
          "a\u2028b",
          "a\u2029b",
          "a\u202eb",
          "a\u2066b",
        ])
          expect(() => quote(value, os), JSON.stringify(value)).toThrow(
            CommandValueError,
          );
      }
      // A double quote is a character of a native command line, which Windows
      // PowerShell passes on unescaped; no Windows path or name holds one.
      expect(() => quote('a" --mode "full', "windows")).toThrow(
        CommandValueError,
      );
      expect(quote('a" --mode "full', "linux")).toBe(`'a" --mode "full'`);
    });

    // The advanced fields that reach a Windows command, each with a value that
    // would close its string, run `calc` and open another.
    const hostile = "C:\\x\u2019; calc; \u2019";
    const fields: [string, Partial<SetupChoices>, string][] = [
      ["name", { name: hostile }, "--name"],
      ["state directory", { stateDir: hostile }, "--state-dir"],
      ["managed configuration", { managedConfig: hostile }, "--managed-config"],
      ["allowances file", { capabilityPolicy: hostile }, "--capability-policy"],
      ["Vector binary", { vectorBinary: hostile }, "--vector-binary"],
      ["CA file", { trust: "file", caFile: hostile }, "--ca-file"],
    ];

    it.each(fields)(
      "never lets a hostile %s end its string in the Windows command",
      (_name, overrides, flag) => {
        const picked = choices({ os: "windows", ...overrides });
        const command = windowsCommand(install, picked, install.releases[0])!;
        const words = powerShellWords(command.split("\n")[1]);
        expect(words[0]).toBe(".\\vectory.exe");
        expect(words[words.indexOf(flag) + 1]).toBe(hostile);
        expect(words.filter((word) => word === "calc")).toEqual([]);
        // The manual setup command is the same text without the hash check.
        expect(powerShellWords(setupCommand(install, picked)!)).toEqual(words);
      },
    );

    it("builds no command from a value no command can carry, rather than a wrong one", () => {
      for (const os of ["linux", "darwin", "windows"] as const) {
        const picked = choices({ os, stateDir: "/var/lib/a\nb" });
        expect(setupCommand(install, picked), os).toBeNull();
        expect(installerCommand(install, picked), os).toBeNull();
        expect(
          windowsCommand(install, picked, install.releases[0]),
          os,
        ).toBeNull();
        expect(runCommand(install, picked, true), os).toBe("");
      }
      // The values only the installer command quotes: where the agent goes and
      // the CA file it downloads with.
      expect(
        installerCommand(install, choices({ installDir: "/opt/a\tb" })),
      ).toBeNull();
      expect(
        installerCommand(
          install,
          choices({ trust: "file", caFile: "/etc/a\u202eb.pem" }),
        ),
      ).toBeNull();
      expect(
        installerCommand(install, choices({ installDir: "/opt/vectory" })),
      ).not.toBeNull();
      // The same value a POSIX shell keeps: only Windows refuses a double quote.
      expect(
        setupCommand(install, choices({ stateDir: '/srv/a"b' })),
      ).toContain(`--state-dir '/srv/a"b'`);
      expect(
        setupCommand(install, choices({ os: "windows", stateDir: 'C:\\a"b' })),
      ).toBeNull();
    });

    it("quotes a value that starts with = for a POSIX shell, because zsh looks it up as a command", () => {
      expect(quote("=ls", "linux")).toBe("'=ls'");
      expect(quote("=ls", "darwin")).toBe("'=ls'");
      expect(quote("a=b", "linux")).toBe("a=b");
    });

    it("leaves a curly quote alone for a POSIX shell, where it is not a quote", () => {
      expect(quote("/srv/o\u2019s", "linux")).toBe("'/srv/o\u2019s'");
      expect(quote("o\u2019s", "darwin")).toBe("'o\u2019s'");
    });

    it("names the field when it refuses a typed value", () => {
      const field = "Agent state directory";
      expect(commandValueProblem(field, "C:\\o\u2019s", "windows")).toBe(
        "Agent state directory can't contain curly quotes (‘ ’ ‚ ‛), which PowerShell reads as quotes. Use a plain apostrophe or remove them.",
      );
      for (const character of curlyQuotes)
        expect(
          commandValueProblem(field, `C:\\o${character}s`, "windows"),
        ).toContain("curly quotes");
      expect(commandValueProblem(field, "C:\\o's", "windows")).toBe("");
      expect(commandValueProblem(field, "/srv/o\u2019s", "linux")).toBe("");
      for (const os of ["linux", "darwin", "windows"] as const)
        expect(commandValueProblem(field, "/srv/a\u007fb", os)).toBe(
          "Agent state directory can't contain control characters. Retype it.",
        );
      expect(commandValueProblem(field, 'C:\\a"b', "windows")).toBe(
        "Agent state directory can't contain a double quote. Remove it.",
      );
      expect(commandValueProblem(field, "", "windows")).toBe("");
    });

    it("quotes the state directory of the run command too", () => {
      const command = runCommand(
        install,
        choices({ os: "windows", stateDir: hostile }),
        false,
      );
      expect(powerShellWords(command)).toEqual([
        ".\\vectory.exe",
        "run",
        "--state-dir",
        hostile,
      ]);
    });
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
    const waiting = progress(enrolled, [device], "t1");
    expect(waiting.device?.id).toBe("d1");
    expect(waiting.checkedIn).toBe(false);
    const connected = progress(
      enrolled,
      [{ ...(device as object), last_seen: "2026-09-29T10:00:05Z" } as never],
      "t1",
    );
    expect(connected.checkedIn).toBe(true);
    const refused = progress(
      [event({ reason_code: "NAME_TAKEN", token_id: "t1" })],
      [],
      "t1",
    );
    expect(refused.refused?.reason_code).toBe("NAME_TAKEN");
  });

  it("never attributes an unrelated new device to this token", () => {
    const unrelated = {
      ...(device as object),
      id: "d0",
      last_seen: "2026-09-29T10:00:00Z",
    } as never;
    expect(progress([], [unrelated], "t1").device).toBeNull();
    expect(progress([], [unrelated], "t1").checkedIn).toBe(false);
  });

  it("accepts the exact device ID from this token's usage record, but never reports a revoked device connected", () => {
    const revoked = {
      ...(device as object),
      status: "revoked",
      last_seen: "2026-09-29T10:00:00Z",
    } as never;
    const state = progress([], [revoked], "t1", "d1");
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
      "lab-auto",
      "sudo /opt/x/vectory run --state-dir /var/lib/vectory-agent",
      "linux",
      false,
    );
    expect(`${line.title} ${line.before}${line.command}${line.after}`).toBe(
      "lab-auto checked in once, but nothing keeps its agent running. Start it with sudo /opt/x/vectory run --state-dir /var/lib/vectory-agent, or use a host with systemd.",
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
