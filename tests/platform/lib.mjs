// Helpers shared by the platform checks in tests/platform: run a command with
// a readable log, poll until a condition holds, record every check in an
// evidence file, and parse the text formats the operating systems print.
// Nothing here talks to a Vectory server; see instance.mjs for that.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "../..");
export const windows = process.platform === "win32";
export const macos = process.platform === "darwin";
export const linux = process.platform === "linux";
/** The service manager the agent registers with on this host. */
export const serviceKind = windows ? "windows" : macos ? "launchd" : "systemd";

/** Where evidence files go (one folder per workflow job). */
export const outputRoot = path.resolve(
  root,
  process.env.VECTORY_PLATFORM_OUTPUT || "artifacts/platforms",
);
/** What the phases tell each other: the device, the paths, the account. */
export const contextFile = path.resolve(
  root,
  process.env.VECTORY_PLATFORM_CONTEXT || ".local/platform/context.json",
);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const seconds = (since) => ((Date.now() - since) / 1000).toFixed(1);
export const sha256File = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const quote = (value) =>
  /^[\w@%+=:,./\\-]+$/.test(value) ? value : JSON.stringify(value);
const indent = (text) =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/**
 * Runs a program and returns { code, stdout, stderr, text }. A failure throws
 * with the command line and everything it printed, unless allowFailure is set.
 * `elevated` runs it as an administrator: with `sudo -n` on Linux and macOS
 * when this process is not root, and as is on Windows, where the runner is one.
 * The command line is logged, so keep secrets out of arguments: pass them in
 * `input`, which is never logged.
 */
export function run(command, args = [], options = {}) {
  const {
    input,
    timeoutMs = 120000,
    allowFailure = false,
    elevated = false,
    env,
    cwd,
    quiet = false,
  } = options;
  const useSudo = elevated && !windows && process.getuid?.() !== 0;
  const file = useSudo ? "sudo" : command;
  const argv = useSudo ? ["-n", command, ...args] : args;
  const display = [file, ...argv].map(quote).join(" ");
  if (!quiet) console.log(`$ ${display}`);
  const result = spawnSync(file, argv, {
    input,
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const text = [stdout, stderr]
    .filter(Boolean)
    .join(stdout && !stdout.endsWith("\n") ? "\n" : "");
  const code = result.status ?? -1;
  const problem = result.error
    ? result.error.code === "ETIMEDOUT"
      ? `timed out after ${timeoutMs / 1000} s`
      : result.error.message
    : code !== 0
      ? `exited ${code}`
      : "";
  if (!quiet && text.trim()) console.log(indent(text));
  if (problem && !allowFailure)
    throw new Error(
      `${display} ${problem}${text.trim() ? `:\n${indent(text)}` : ""}`,
    );
  return { code, stdout, stderr, text };
}

/** Polls until `probe` returns something truthy, and returns it. */
export async function until(
  label,
  probe,
  { timeoutMs = 60000, intervalMs = 1000, describe } = {},
) {
  const began = Date.now();
  for (;;) {
    let value;
    let problem;
    try {
      value = await probe();
    } catch (error) {
      problem = error;
    }
    if (value) {
      console.log(`  ok: ${label} (${seconds(began)} s)`);
      return value;
    }
    if (Date.now() - began >= timeoutMs) {
      let observed = "";
      if (describe)
        try {
          observed = await describe();
        } catch (error) {
          observed = `(could not describe: ${error.message})`;
        }
      throw new Error(
        `Timed out after ${seconds(began)} s waiting for: ${label}.` +
          (problem ? `\nLast error: ${problem.message}` : "") +
          (observed ? `\nLast observed:\n${indent(String(observed))}` : ""),
      );
    }
    await sleep(intervalMs);
  }
}

function describeHost() {
  const base = {
    type: os.type(),
    release: os.release(),
    version: os.version(),
    arch: os.arch(),
  };
  if (linux)
    try {
      const line = fs
        .readFileSync("/etc/os-release", "utf8")
        .split("\n")
        .find((l) => l.startsWith("PRETTY_NAME="));
      if (line) base.distribution = line.slice(12).replace(/^"|"$/g, "");
    } catch {
      // The kernel version above is enough.
    }
  return base;
}

/** One phase's checks, in order, and what it observed along the way. */
export class Evidence {
  constructor(name) {
    this.name = name;
    this.checks = [];
    this.failures = [];
    this.observations = {};
    this.startedAt = new Date().toISOString();
  }
  /** Keeps a fact the evidence should show: a property, a table, a level. */
  observe(key, value) {
    this.observations[key] = value;
  }
  /** Runs one named check; a failure is recorded, printed and rethrown. */
  async step(name, body) {
    const began = Date.now();
    console.log(`\n==> ${name}`);
    try {
      const value = await body();
      this.checks.push({
        name,
        status: "passed",
        seconds: Number(seconds(began)),
      });
      console.log(`PASS ${name} (${seconds(began)} s)`);
      return value;
    } catch (error) {
      this.checks.push({
        name,
        status: "failed",
        seconds: Number(seconds(began)),
        message: String(error.message ?? error),
      });
      console.error(`FAIL ${name}\n${error.stack ?? error}`);
      throw error;
    }
  }
  /**
   * A check that doesn't hold up the ones after it, such as one of several
   * independent readings: a failure is recorded and printed, the phase goes on
   * and fails at its end.
   */
  async softStep(name, body) {
    try {
      return await this.step(name, body);
    } catch {
      this.failures.push(name);
      return undefined;
    }
  }
  write(result, error) {
    fs.mkdirSync(outputRoot, { recursive: true });
    const file = path.join(outputRoot, `${this.name}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          phase: this.name,
          result,
          platform: process.platform,
          runner: process.env.RUNNER_OS ?? null,
          host: describeHost(),
          startedAt: this.startedAt,
          finishedAt: new Date().toISOString(),
          checks: this.checks,
          observations: this.observations,
          ...(error ? { error } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return file;
  }
}

/** Runs one phase, always writes its evidence, and sets the exit code. */
export async function main(name, body) {
  const evidence = new Evidence(name);
  let failure = null;
  try {
    await body(evidence);
  } catch (error) {
    failure = error;
  }
  if (!failure && evidence.failures.length)
    failure = new Error(
      `${evidence.failures.length} checks failed: ${evidence.failures.join("; ")}`,
    );
  if (failure) process.exitCode = 1;
  const file = evidence.write(
    failure ? "failed" : "passed",
    failure ? String(failure.stack ?? failure) : undefined,
  );
  console.log(
    `\n${failure ? "FAILED" : "PASSED"} ${name}: ${evidence.checks.length} checks. Evidence: ${path.relative(root, file)}`,
  );
}

export function readContext() {
  try {
    return JSON.parse(fs.readFileSync(contextFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${contextFile} (${error.message}). Run the install phase first.`,
    );
  }
}

export function writeContext(context) {
  fs.mkdirSync(path.dirname(contextFile), { recursive: true });
  fs.writeFileSync(contextFile, JSON.stringify(context, null, 2) + "\n");
}

/** `Key=Value` lines, as `systemctl show` prints them. */
export function parseKeyValues(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
}

const SPAN_UNITS = {
  us: 1e-6,
  µs: 1e-6,
  ms: 1e-3,
  s: 1,
  sec: 1,
  second: 1,
  seconds: 1,
  min: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
};

/** A systemd time span ("5min 30s", "330s", "infinity") in seconds. */
export function parseDuration(text) {
  const value = text.trim();
  if (value === "infinity") return Infinity;
  let total = 0;
  let found = false;
  for (const [, amount, unit] of value.matchAll(
    /(\d+(?:\.\d+)?)\s*([a-zµ]*)/g,
  )) {
    const scale = unit === "" ? 1 : SPAN_UNITS[unit];
    if (scale === undefined) return NaN;
    total += Number(amount) * scale;
    found = true;
  }
  return found ? total : NaN;
}

const unescapeMount = (value) =>
  value.replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(parseInt(octal, 8)),
  );

/** The lines of /proc/<pid>/mountinfo as objects. */
export function parseMountInfo(text) {
  const mounts = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const split = line.indexOf(" - ");
    if (split < 0) continue;
    const left = line.slice(0, split).split(" ");
    const right = line.slice(split + 3).split(" ");
    mounts.push({
      id: left[0],
      parent: left[1],
      root: unescapeMount(left[3] ?? ""),
      mountPoint: unescapeMount(left[4] ?? ""),
      options: (left[5] ?? "").split(","),
      fsType: right[0] ?? "",
      source: unescapeMount(right[1] ?? ""),
    });
  }
  return mounts;
}

/**
 * The mount a path lives on: the one with the longest mount point that is a
 * prefix of the path. Of two stacked mounts on one point the later one is on
 * top, so it wins.
 */
export function mountFor(file, mounts) {
  let best = null;
  for (const mount of mounts) {
    const point = mount.mountPoint.replace(/\/+$/, "");
    const covers =
      point === "" || file === point || file.startsWith(`${point}/`);
    if (covers && (!best || point.length >= best.point.length))
      best = { mount, point };
  }
  return best?.mount ?? null;
}

export const isReadOnly = (mount) =>
  Boolean(mount) && mount.options.includes("ro");

/** The exposure line of `systemd-analyze security`: { score, level }. */
export function parseExposure(text) {
  const match = /Overall exposure level for \S+: ([0-9.]+) (\w+)/.exec(text);
  return match ? { score: Number(match[1]), level: match[2] } : null;
}
