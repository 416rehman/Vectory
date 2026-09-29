// Builds the install and setup commands shown on Add device. Every value that
// reaches a command is either validated server data (origins, SHA-256 digests)
// or an operator choice that is quoted for the target shell. The enrollment
// token is never part of a command.
import type { AgentInstall, Release } from "./api";

export type HostOS = "linux" | "darwin" | "windows";
export type Mode = "restricted" | "full";
export type ServiceChoice = "auto" | "none";
/**
 * How the host checks the server before it sends the token: pin the
 * server's CA by the fingerprint this page shows, trust a CA certificate file
 * already on the host, or trust the host's own certificate store.
 */
export type TrustChoice = "pinned" | "file" | "system";

export type SetupChoices = {
  os: HostOS;
  mode: Mode;
  /** Empty: setup uses the host's own name. */
  name: string;
  service: ServiceChoice;
  /** Empty: the platform's default account. */
  serviceUser: string;
  createUser: boolean;
  stateDir: string;
  managedConfig: string;
  capabilityPolicy: string;
  /** Empty: setup finds Vector on PATH or in the usual locations. */
  vectorBinary?: string;
  /** Absent: the first of trustChoices(), the server's default. */
  trust?: TrustChoice;
  /** The CA certificate (PEM) on the host, for trust "file". */
  caFile?: string;
  /** Empty: the installer's default directory (Linux and macOS). */
  installDir?: string;
};

/** The same defaults `vectory setup`, the service definitions and the docs use. */
export function platformDefaults(os: HostOS) {
  return os === "windows"
    ? {
        stateDir: "C:\\ProgramData\\Vectory\\agent",
        managedConfig: "C:\\ProgramData\\Vectory\\managed\\vector.json",
        binary: "C:\\Program Files\\Vectory\\vectory.exe",
        serviceUser: "NT SERVICE\\Vectory",
      }
    : os === "darwin"
      ? {
          stateDir: "/Library/Application Support/Vectory/agent",
          managedConfig:
            "/Library/Application Support/Vectory/managed/vector.json",
          binary: "/usr/local/bin/vectory",
          serviceUser: "_vectory",
        }
      : {
          stateDir: "/var/lib/vectory-agent",
          managedConfig: "/etc/vectory/managed/vector.json",
          binary: "/usr/local/bin/vectory",
          serviceUser: "vectory",
        };
}

/** The operating system the browser runs on, as the likely host. */
export function detectOS(): HostOS {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = (
    nav.userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    ""
  ).toLowerCase();
  return platform.includes("win")
    ? "windows"
    : platform.includes("mac")
      ? "darwin"
      : "linux";
}

export const deviceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
export const accountPatterns: Record<Exclude<HostOS, "windows">, RegExp> = {
  linux: /^[a-z_][a-z0-9_-]{0,31}$/,
  darwin: /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/,
};

/** Quote one argument for a POSIX shell or PowerShell, only when needed. */
export function quote(value: string, os: HostOS) {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) return value;
  return os === "windows"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Setup options for the operator's choices, defaults omitted. */
export function setupArguments(choices: SetupChoices): string[] {
  const defaults = platformDefaults(choices.os);
  const args = ["--mode", choices.mode];
  const add = (flag: string, value: string) =>
    args.push(flag, quote(value, choices.os));
  if (choices.name.trim()) add("--name", choices.name.trim());
  if (choices.service === "none") args.push("--service", "none");
  if (choices.os !== "windows" && choices.service !== "none") {
    const account = choices.serviceUser.trim();
    if (account && account !== defaults.serviceUser)
      add("--service-user", account);
    if (choices.createUser) args.push("--create-user");
  }
  if (choices.stateDir.trim() && choices.stateDir.trim() !== defaults.stateDir)
    add("--state-dir", choices.stateDir.trim());
  if (
    choices.managedConfig.trim() &&
    choices.managedConfig.trim() !== defaults.managedConfig
  )
    add("--managed-config", choices.managedConfig.trim());
  if (choices.mode === "restricted" && choices.capabilityPolicy.trim())
    add("--capability-policy", choices.capabilityPolicy.trim());
  if (choices.vectorBinary?.trim())
    add("--vector-binary", choices.vectorBinary.trim());
  return args;
}

/**
 * One option per line with a trailing " \\" so the whole command is visible
 * on a narrow screen and still pastes as one command in any POSIX shell.
 */
export function continued(head: string, args: string[], indent = "  ") {
  const lines: string[] = [];
  for (const arg of args)
    if (arg.startsWith("--") || !lines.length) lines.push(arg);
    else lines[lines.length - 1] += ` ${arg}`;
  return [head, ...lines.map((line) => `${indent}${line}`)].join(" \\\n");
}

/**
 * How hosts can check this server, the default first. Pinning needs a
 * private CA that this page can show; a publicly trusted certificate is
 * checked with the host's own certificate store.
 */
export function trustChoices(install: AgentInstall): TrustChoice[] {
  const certificate = install.certificate;
  return certificate?.ca_sha256 && !certificate.publicly_trusted
    ? ["pinned", "file", "system"]
    : ["system", "file"];
}
/** The choice in effect: the operator's when this server offers it. */
export function effectiveTrust(
  install: AgentInstall,
  choice?: TrustChoice,
): TrustChoice {
  const offered = trustChoices(install);
  return choice && offered.includes(choice) ? choice : offered[0];
}

/**
 * The setup options for the chosen trust, exactly: --ca-sha256 with the
 * fingerprint, --ca-file with the host's CA certificate, or --ca-file= for
 * the host's certificate store. Null when the choice is incomplete.
 */
export function trustArguments(
  install: AgentInstall,
  choices: Pick<SetupChoices, "os" | "trust" | "caFile">,
): string[] | null {
  switch (effectiveTrust(install, choices.trust)) {
    case "pinned":
      return ["--ca-sha256", install.certificate!.ca_sha256!];
    case "file": {
      const path = choices.caFile?.trim();
      return path ? ["--ca-file", quote(path, choices.os)] : null;
    }
    default:
      return ["--ca-file="];
  }
}

/** The installer file, and the CA certificate a pinned command writes next to it. */
export const installerFile = "vectory-install.sh";
export const pinnedCAFile = "vectory-ca.pem";

/**
 * The one-command install for Linux and macOS: fetch the installer with
 * certificate verification on, check its SHA-256 from this authenticated
 * page, then run it. Nothing turns verification off:
 * - pinned: the command writes this server's CA certificate (public, shown on
 *   this page like its fingerprint) to vectory-ca.pem, and curl verifies the
 *   server against it. curl's own --pinnedpubkey can't do this: curl still
 *   refuses a CA it doesn't know unless -k turns the check off.
 * - file: curl and setup trust the CA certificate at the host path.
 * - system: curl and setup trust the host's certificate store.
 * Each step ends in &&, which continues the command in every POSIX shell
 * (sh, dash, bash, zsh), so the installer runs only when the download and
 * the checksum both succeed.
 */
export function installerCommand(
  install: AgentInstall,
  choices: SetupChoices,
): string | null {
  const [mode, ...rest] = pairs(setupArguments(choices));
  const installDir = choices.installDir?.trim();
  return installerRun(
    install,
    choices,
    [
      ...mode,
      ...(installDir ? ["--install-dir", quote(installDir, choices.os)] : []),
    ],
    rest.flat(),
  );
}

/**
 * Download the installer with verification on, check its SHA-256, and run it
 * with `head`, the trust arguments, then `tail`. Upgrade agent runs it again
 * with only what the enrolled device needs.
 */
export function installerRun(
  install: AgentInstall,
  choices: Pick<SetupChoices, "os" | "trust" | "caFile">,
  head: string[],
  tail: string[],
): string | null {
  if (choices.os === "windows" || !install.installer || !install.agent_url)
    return null;
  const trust = effectiveTrust(install, choices.trust);
  const lines: string[] = [];
  let cacert = "";
  if (trust === "pinned") {
    const pem = install.certificate?.ca_pem?.trimEnd();
    if (!pem) return null;
    lines.push(`printf '%s\\n' '${pem}' > ${pinnedCAFile} &&`);
    cacert = ` --cacert ${pinnedCAFile}`;
  } else if (trust === "file") {
    const path = choices.caFile?.trim();
    if (!path) return null;
    cacert = ` --cacert ${quote(path, choices.os)}`;
  }
  const check =
    choices.os === "darwin" ? "shasum -a 256 -c -" : "sha256sum -c -";
  const installerTrust =
    trust === "pinned" ? [] : trustArguments(install, choices)!;
  lines.push(
    `curl -fsSL${cacert} \\`,
    `  -o ${installerFile} \\`,
    `  ${install.agent_url}/agent/v1/install.sh &&`,
    // Split at the pipe, so no line hides under the Copy button.
    `echo '${install.installer.sha256}  ${installerFile}' \\`,
    `  | ${check} &&`,
    continued(`sudo sh ${installerFile}`, [
      ...head,
      ...installerTrust,
      ...tail,
    ]),
  );
  return lines.join("\n");
}

/** ["--mode", "full", "--create-user"] as [["--mode", "full"], ["--create-user"]]. */
function pairs(args: string[]) {
  const out: string[][] = [];
  for (const arg of args)
    if (arg.startsWith("--") || !out.length) out.push([arg]);
    else out[out.length - 1].push(arg);
  return out;
}

/** Setup with an agent that is already on the host. */
export function setupCommand(
  install: AgentInstall,
  choices: SetupChoices,
): string | null {
  if (!install.agent_url) return null;
  const trust = trustArguments(install, choices);
  if (!trust) return null;
  const args = [
    "--server",
    install.agent_url,
    ...trust,
    ...setupArguments(choices),
  ];
  return choices.os === "windows"
    ? `.\\vectory.exe setup ${args.join(" ")}`
    : continued("sudo vectory setup", args);
}

/**
 * The command that keeps the agent running without a service, as setup
 * prints it: the agent where this page's command put it (the installer's
 * directory, or wherever an agent copied to the host is on PATH) and its
 * state directory.
 */
export function runCommand(
  install: Pick<AgentInstall, "default_install_dir">,
  choices: Pick<SetupChoices, "os" | "stateDir" | "installDir">,
  installed: boolean,
) {
  const stateDir =
    choices.stateDir.trim() || platformDefaults(choices.os).stateDir;
  if (choices.os === "windows")
    return `.\\vectory.exe run --state-dir ${quote(stateDir, "windows")}`;
  const directory =
    choices.installDir?.trim() ||
    install.default_install_dir ||
    "/usr/local/bin";
  const agent = installed
    ? quote(`${directory.replace(/\/+$/, "")}/vectory`, choices.os)
    : "vectory";
  return `sudo ${agent} run --state-dir ${quote(stateDir, choices.os)}`;
}

/** Windows: verify the downloaded agent, then run setup from an elevated shell. */
export function windowsCommand(
  install: AgentInstall,
  choices: SetupChoices,
  release: Release,
): string | null {
  const setup = setupCommand(install, { ...choices, os: "windows" });
  if (!setup) return null;
  return [
    `if ((Get-FileHash .\\vectory.exe -Algorithm SHA256).Hash -ne '${release.sha256}') { throw 'vectory.exe does not match its SHA-256. Download it again.' }`,
    setup,
  ].join("\n");
}

/** The build a platform's installer would choose: exactly one, or none. */
export function releaseFor(
  install: AgentInstall,
  os: HostOS,
  arch: string,
): Release | null {
  const matches = install.releases.filter(
    (r) => r.os === os && r.arch === arch,
  );
  return matches.length === 1 ? matches[0] : null;
}

/** "c0f4e1b7…9d19ab" for compact display of a digest. */
export function shortDigest(sha256: string) {
  return sha256.length > 16
    ? `${sha256.slice(0, 8)}…${sha256.slice(-6)}`
    : sha256;
}
/** The full fingerprint in rows of eight pairs, for comparing by eye. */
export function fingerprintRows(sha256: string) {
  const pairs = sha256.toUpperCase().match(/../g) || [];
  const rows: string[] = [];
  for (let index = 0; index < pairs.length; index += 8)
    rows.push(pairs.slice(index, index + 8).join(":"));
  return rows;
}
/** The full colon-separated fingerprint, as the agent prints it. */
export function fingerprint(sha256: string) {
  return (sha256.toUpperCase().match(/../g) || []).join(":");
}
