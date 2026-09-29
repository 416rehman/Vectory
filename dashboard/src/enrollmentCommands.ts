// Builds the install and setup commands shown on Add device. Every value that
// reaches a command is either validated server data (origins, SHA-256 digests)
// or an operator choice that is quoted for the target shell. The enrollment
// token is never part of a command.
import type { AgentInstall, Release } from "./api";

export type HostOS = "linux" | "darwin" | "windows";
export type Mode = "restricted" | "full";
export type ServiceChoice = "auto" | "none";

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

/** How devices will trust the agent listener, from the server's own chain. */
export type Trust = {
  server: string;
  /** Hex SHA-256 of the CA to pin; null when public trust applies. */
  pin: string | null;
};
export function trustFor(install: AgentInstall): Trust | null {
  if (!install.agent_url) return null;
  const certificate = install.certificate;
  const pin =
    certificate && !certificate.publicly_trusted ? certificate.ca_sha256 : null;
  return { server: install.agent_url, pin };
}

function trustArguments(trust: Trust) {
  return [
    "--server",
    trust.server,
    ...(trust.pin ? ["--ca-sha256", trust.pin] : []),
  ];
}

/**
 * The one-command install for Linux and macOS: download the installer, check
 * its SHA-256 from this authenticated page, then run it. With a private CA the
 * download itself skips TLS verification (-k): the checksum is the proof, and
 * the installer then pins the CA for everything after it.
 */
export function installerCommand(
  install: AgentInstall,
  choices: SetupChoices,
): string | null {
  if (choices.os === "windows" || !install.installer || !install.agent_url)
    return null;
  const trusted = !!install.certificate?.publicly_trusted;
  const check =
    choices.os === "darwin" ? "shasum -a 256 -c -" : "sha256sum -c -";
  // A line ending in && continues the command in every POSIX shell, so the
  // pasted block runs the installer only when the checksum line succeeds.
  return [
    `curl -fsSL${trusted ? "" : "k"} ${install.agent_url}/agent/v1/install.sh -o vectory-install.sh`,
    `echo '${install.installer.sha256}  vectory-install.sh' | ${check} &&`,
    continued("  sudo sh vectory-install.sh", setupArguments(choices), "    "),
  ].join("\n");
}

/** Setup with an agent that is already on the host. */
export function setupCommand(
  install: AgentInstall,
  choices: SetupChoices,
): string | null {
  const trust = trustFor(install);
  if (!trust) return null;
  const args = [...trustArguments(trust), ...setupArguments(choices)];
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
  choices: Pick<SetupChoices, "os" | "stateDir">,
  installed: boolean,
) {
  const stateDir =
    choices.stateDir.trim() || platformDefaults(choices.os).stateDir;
  if (choices.os === "windows")
    return `.\\vectory.exe run --state-dir ${quote(stateDir, "windows")}`;
  const agent = installed
    ? `${(install.default_install_dir || "/usr/local/bin").replace(/\/+$/, "")}/vectory`
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
/** "1F:3C:...:9A:B0", exactly as `vectory setup` prints the pin. */
export function shortFingerprint(sha256: string) {
  const pairs = sha256.toUpperCase().match(/../g) || [];
  return pairs.length > 4
    ? `${pairs.slice(0, 2).join(":")}:...:${pairs.slice(-2).join(":")}`
    : pairs.join(":");
}
/** The full colon-separated fingerprint. */
export function fingerprint(sha256: string) {
  return (sha256.toUpperCase().match(/../g) || []).join(":");
}
