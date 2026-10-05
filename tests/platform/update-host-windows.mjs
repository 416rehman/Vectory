// The privileged update step on Windows, as the agent-update checks see it: its
// service (VectoryUpdate, run by the Service Control Manager as LocalSystem), the
// access lists of the files it makes, the executable it swaps in two renames, and
// how to give it no room, hold a file it needs and end it between its two renames.
// update-hosts.mjs hands agent-update.mjs this object where it hands it the Linux
// one; the members have the same names and the same meaning. What is only here (the
// service's registration and the moment the directory holds no executable) is
// reached through members the Linux host doesn't have.
//
// The text sc.exe prints and the access lists PowerShell reads are parsed by
// functions that take text and return values, so that update-hosts.test.mjs tests
// them on every platform.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentProcesses, describeProcesses } from "./adapters.mjs";
import { run, sha256File, sleep, windowsPowerShellEnv } from "./lib.mjs";

// ---------------------------------------------------------------- accounts and rights

export const ACCOUNT = {
  system: "NT AUTHORITY\\SYSTEM",
  administrators: "BUILTIN\\Administrators",
  trustedInstaller: "NT SERVICE\\TrustedInstaller",
  users: "BUILTIN\\Users",
  agentService: "NT SERVICE\\Vectory",
  creatorOwner: "CREATOR OWNER",
};

/** The access masks the product writes (winnt.h): full control, read, read and run. */
export const MASK = { full: 0x1f01ff, read: 0x120089, readAndRun: 0x1200a9 };

/**
 * What lets an account change a file or a directory, or take it over: write, append,
 * the extended attributes, the attributes, delete, delete a child, change the access
 * list, take the ownership, and the generic rights that stand for them.
 */
const MODIFY =
  0x2 |
  0x4 |
  0x10 |
  0x40 |
  0x100 |
  0x10000 |
  0x40000 |
  0x80000 |
  0x10000000 |
  0x40000000;

/**
 * The SID of the virtual account NT SERVICE\<name>: S-1-5-80 and the five 32-bit
 * words of the SHA-1 of the upper-cased name in UTF-16 little endian. TrustedInstaller
 * has its SID the same way.
 */
export function serviceSid(name) {
  const digest = crypto
    .createHash("sha1")
    .update(Buffer.from(name.toUpperCase(), "utf16le"))
    .digest();
  return `S-1-5-80-${[0, 1, 2, 3, 4].map((i) => digest.readUInt32LE(4 * i)).join("-")}`;
}

// ---------------------------------------------------------------- what sc.exe prints

/** `sc queryex <service>`: whether it exists, its state, its process and how it last ended. */
export function parseServiceQuery(text) {
  if (!/\bSTATE\s*:/.test(text))
    return {
      exists: false,
      state: /\b1072\b/.test(text) ? "MARKED_FOR_DELETE" : "NOT_INSTALLED",
      pid: 0,
      exitCode: 0,
      serviceExitCode: 0,
    };
  const number = (key) =>
    Number(new RegExp(`\\b${key}\\s*:\\s*(\\d+)`).exec(text)?.[1] ?? 0);
  return {
    exists: true,
    state: /\bSTATE\s*:\s*\d+\s+(\w+)/.exec(text)?.[1] ?? "UNKNOWN",
    pid: number("PID"),
    exitCode: number("WIN32_EXIT_CODE"),
    serviceExitCode: number("SERVICE_EXIT_CODE"),
  };
}

/** `sc qc <service>`: the registration. */
export function parseServiceConfig(text) {
  const field = (key) =>
    new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const start = field("START_TYPE");
  return {
    type: field("TYPE"),
    startType:
      /\b(AUTO_START|DEMAND_START|DISABLED|BOOT_START|SYSTEM_START)\b/.exec(
        start,
      )?.[1] ?? "",
    delayed: /\(DELAYED\)/.test(start),
    binaryPath: field("BINARY_PATH_NAME"),
    account: field("SERVICE_START_NAME"),
    displayName: field("DISPLAY_NAME"),
  };
}

/** `sc qfailure <service>`: what the manager does when the service's process fails. */
export function parseFailureActions(text) {
  const reset = /RESET_PERIOD[^:]*:\s*(\d+)/.exec(text)?.[1];
  return {
    resetPeriod: reset === undefined ? null : Number(reset),
    actions: [
      ...text.matchAll(
        /(RESTART|REBOOT|RUN PROCESS|RUN_COMMAND)\s*--\s*Delay\s*=\s*(\d+)\s*milliseconds/gi,
      ),
    ].map((match) => ({
      action: match[1].toUpperCase(),
      delayMs: Number(match[2]),
    })),
  };
}

/** `sc qfailureflag <service>`: whether an end with an error is a failure too. */
export function parseFailureFlag(text) {
  const flag = /NONCRASH_FAILURES\s*:\s*(TRUE|FALSE)/i.exec(text)?.[1];
  return flag === undefined ? null : flag.toUpperCase() === "TRUE";
}

/**
 * Why the security descriptor of a service (`sc sdshow`) gives more than it should:
 * any entry for the agent's own service account, and any entry for an account that
 * isn't root with a right beyond the ones that read the service (query its
 * configuration and its state, list its dependents, interrogate it, read the
 * descriptor): starting, stopping, pausing, changing its configuration, deleting it
 * or changing who may. SYSTEM, the Administrators and TrustedInstaller may do
 * anything. The audit entries are not rights.
 */
export function serviceRightsProblems(sddl, agentSid) {
  const readOnly = new Set(["CC", "LC", "SW", "LO", "CR", "RC"]);
  const root = new Set([
    "SY",
    "BA",
    "S-1-5-18",
    "S-1-5-32-544",
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
  ]);
  const problems = [];
  for (const [, entry] of sddl.replace(/S:.*$/, "").matchAll(/\(([^)]*)\)/g)) {
    const [type, , rights = "", , , sid = ""] = entry.split(";");
    if (type !== "A" || root.has(sid)) continue;
    if (sid === agentSid) {
      problems.push(`${sid}, the agent's service, has an entry (${rights})`);
      continue;
    }
    const codes = rights.match(/.{1,2}/g) ?? [];
    if (rights.startsWith("0x") || codes.some((code) => !readOnly.has(code)))
      problems.push(`${sid} has more than the right to read it (${rights})`);
  }
  return problems;
}

/** A command line as Windows splits it (CommandLineToArgvW). */
export function splitCommandLine(line) {
  const args = [];
  let current = "";
  let quoted = false;
  let started = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") {
      let slashes = 0;
      while (line[i] === "\\") {
        slashes += 1;
        i += 1;
      }
      if (line[i] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          current += '"';
          i += 1;
        }
      } else current += "\\".repeat(slashes);
      started = true;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      started = true;
      i += 1;
      continue;
    }
    if ((c === " " || c === "\t") && !quoted) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      i += 1;
      continue;
    }
    current += c;
    started = true;
    i += 1;
  }
  if (started) args.push(current);
  return args;
}

// ---------------------------------------------------------------- access lists

/**
 * An access list as the checks compare it: its owner, whether it is protected from
 * what the parent gives, and what each account is granted ("identity:mask" in
 * hexadecimal, sorted). An entry that only passes to what is made in the directory
 * doesn't apply to it and is left out; a refusal is marked.
 */
export function summarizeAcl(acl) {
  const masks = new Map();
  for (const rule of acl.rules) {
    if (rule.inheritOnly) continue;
    const key = `${rule.type === "Allow" ? "" : "deny "}${rule.identity}`;
    masks.set(key, (masks.get(key) ?? 0) | rule.mask);
  }
  return {
    owner: acl.owner,
    protected: acl.protected,
    access: [...masks]
      .map(([who, mask]) => `${who}:${mask.toString(16)}`)
      .sort(),
  };
}

/**
 * An access list as a person reads it in a failure: its owner, whether it is
 * protected, one line per entry (allow or deny, the account, the mask in hexadecimal,
 * and whether the entry is inherited or only passes on to what is made inside), and
 * the descriptor text when it was read, which is what a test of the product's path
 * check takes as a fixture.
 */
export function describeAcl(file, acl) {
  const hex = (mask) => `0x${(mask >>> 0).toString(16)}`;
  const flags = (rule) =>
    [rule.inheritOnly && "inherit only", rule.inherited && "inherited"]
      .filter(Boolean)
      .join(", ");
  return [
    file,
    `  owner ${acl.owner}${acl.protected ? ", protected" : ""}`,
    ...acl.rules.map(
      (rule) =>
        `  ${rule.type === "Allow" ? "allow" : "deny"} ${rule.identity} ${hex(rule.mask)}${flags(rule) ? ` (${flags(rule)})` : ""}`,
    ),
    ...(acl.sddl ? [`  ${acl.sddl}`] : []),
  ].join("\n");
}

/**
 * Why a file or a directory isn't SYSTEM's, the Administrators' and
 * TrustedInstaller's alone to change: an owner that is another account, or an entry
 * that gives another account a right to change it. The list is empty when it is.
 */
export function rootOnlyProblems(acl) {
  const root = new Set([
    ACCOUNT.system,
    ACCOUNT.administrators,
    ACCOUNT.trustedInstaller,
  ]);
  const problems = [];
  if (!root.has(acl.owner)) problems.push(`it belongs to ${acl.owner}`);
  for (const rule of acl.rules) {
    if (
      rule.type !== "Allow" ||
      rule.inheritOnly ||
      root.has(rule.identity) ||
      rule.identity === ACCOUNT.creatorOwner
    )
      continue;
    if (rule.mask & MODIFY)
      problems.push(
        `${rule.identity} has rights to change it (${rule.mask.toString(16)})`,
      );
  }
  return problems;
}

/**
 * The owner, protection and access of what the step makes, as summarizeAcl writes
 * it, for the paths of a host: the directory its directories are made in, the
 * policy's, the step's, the probe's and the private one, the two files the agent
 * reads, and the helper copy.
 */
export function expectedLayout(paths) {
  const closed = (...extra) => ({
    owner: ACCOUNT.administrators,
    protected: true,
    access: [
      [ACCOUNT.system, MASK.full],
      [ACCOUNT.administrators, MASK.full],
      ...extra,
    ]
      .map(([who, mask]) => `${who}:${mask.toString(16)}`)
      .sort(),
  });
  const service = ACCOUNT.agentService;
  return {
    [paths.updateRoot]: closed([service, MASK.readAndRun]),
    [paths.policyDir]: closed([service, MASK.read]),
    [paths.stepDir]: closed([service, MASK.read]),
    [paths.probe]: closed([service, MASK.read]),
    [paths.private]: closed(),
    [paths.status]: closed([service, MASK.read]),
    [paths.policy]: closed([service, MASK.read]),
    [paths.helper]: closed(
      [ACCOUNT.trustedInstaller, MASK.full],
      [ACCOUNT.users, MASK.readAndRun],
      [service, MASK.readAndRun],
    ),
  };
}

// ---------------------------------------------------------------- the host

const psq = (text) => `'${String(text).replaceAll("'", "''")}'`;
const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function windowsHost({ programData = process.env.ProgramData || "C:\\ProgramData" } = {}) {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const updateRoot = `${programData}\\Vectory`;
  const stepDir = `${updateRoot}\\update-state`;
  const installDir = `${programFiles}\\Vectory`;
  const paths = {
    agent: `${installDir}\\vectory.exe`,
    installDir,
    previous: `${installDir}\\vectory.exe.previous`,
    stateDir: `${updateRoot}\\agent`,
    updatesDir: `${updateRoot}\\agent\\updates`,
    managedConfig: `${updateRoot}\\managed\\vector.json`,
    updateRoot,
    policyDir: `${updateRoot}\\updates`,
    policy: `${updateRoot}\\updates\\policy.json`,
    stepDir,
    status: `${stepDir}\\status.json`,
    probe: `${stepDir}\\probe`,
    private: `${stepDir}\\private`,
    journal: `${stepDir}\\private\\journal.json`,
    counters: `${stepDir}\\private\\counters.json`,
    installed: `${stepDir}\\private\\installed.json`,
    staging: `${stepDir}\\private\\staging`,
    helper: `${stepDir}\\private\\helper\\vectory.exe`,
    helperDir: `${stepDir}\\private\\helper`,
    stepLog: `${stepDir}\\private\\update-step.log`,
    vector: `${programFiles}\\Vector\\bin\\vector.exe`,
  };
  const units = { agent: "Vectory", step: "VectoryUpdate" };
  const sudo = (command, args, options = {}) => run(command, args, options);

  const powershell = (script, options = {}) =>
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { quiet: true, ...options },
    );
  const sc = (args, options = {}) =>
    run("sc.exe", args, { allowFailure: true, quiet: true, ...options });
  const query = (unit) => parseServiceQuery(sc(["queryex", unit]).text);
  const config = (unit) => parseServiceConfig(sc(["qc", unit]).text);

  /** The access lists of some paths, read together. */
  const readAcls = (files) => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$out = @()",
      `foreach ($p in @(${files.map(psq).join(",")})) {`,
      "  $a = Get-Acl -LiteralPath $p",
      "  $out += [pscustomobject]@{ path = $p; owner = $a.Owner; sddl = $a.Sddl; protected = [bool]$a.AreAccessRulesProtected; rules = @($a.Access | ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; type = [string]$_.AccessControlType; mask = [int64]$_.FileSystemRights; inherited = [bool]$_.IsInherited; inheritOnly = [bool](([int]$_.PropagationFlags -band 2) -ne 0) } }) }",
      "}",
      "ConvertTo-Json -InputObject @($out) -Depth 5 -Compress",
    ].join("\n");
    return Object.fromEntries(
      JSON.parse(powershell(script).stdout).map((acl) => [acl.path, acl]),
    );
  };

  const processOf = (pid) => {
    if (!pid) return null;
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner; [pscustomobject]@{ pid = $p.ProcessId; path = $p.ExecutablePath; command = $p.CommandLine; user = "$($o.Domain)\\$($o.User)" } | ConvertTo-Json -Compress }`;
    const text = powershell(script).stdout.trim();
    return text ? JSON.parse(text) : null;
  };

  const waitForState = (unit, state, timeoutMs) => {
    const began = Date.now();
    for (;;) {
      const now = query(unit);
      if (now.state === state) return now;
      if (Date.now() - began > timeoutMs)
        throw new Error(
          `${unit} did not reach ${state} within ${timeoutMs / 1000} s; it is ${now.state}.`,
        );
      sleepSync(500);
    }
  };

  const stopUnit = (unit, timeoutMs = 400000) => {
    const now = query(unit);
    if (!now.exists || now.state === "STOPPED") return;
    sc(["stop", unit]);
    waitForState(unit, "STOPPED", timeoutMs);
  };

  const removeService = (unit) => {
    if (!query(unit).exists) return;
    try {
      stopUnit(unit, 120000);
    } catch (error) {
      // A service that won't stop is ended with its process below.
      const pid = query(unit).pid;
      if (pid)
        run("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
          allowFailure: true,
          quiet: true,
        });
    }
    sc(["delete", unit]);
    for (let i = 0; i < 60 && query(unit).exists; i += 1) sleepSync(500);
  };

  const removeTree = (dir) => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      powershell(
        `Remove-Item -LiteralPath ${psq(dir)} -Recurse -Force -ErrorAction SilentlyContinue`,
        { allowFailure: true },
      );
      if (!fs.existsSync(dir)) return;
      sleepSync(1000);
    }
    throw new Error(`${dir} could not be removed.`);
  };

  const freeBytes = (file) => {
    try {
      const info = fs.statfsSync(file);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      const drive = path.parse(file).root.slice(0, 1);
      return Number(
        powershell(`(Get-PSDrive -Name ${drive}).Free`).stdout.trim(),
      );
    }
  };

  const host = {
    kind: "windows",
    paths,
    units,
    account: ACCOUNT.agentService,
    sudo,
    /** The swap has one moment with no executable in the directory (two renames). */
    twoRenames: true,

    exists: (file) => fs.existsSync(file),
    readText: (file) => fs.readFileSync(file, "utf8"),
    readJson: (file) => JSON.parse(host.readText(file)),
    tryJson(file) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    sha256: (file) => sha256File(file),
    list(dir) {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    /** `vectory version --json` of an executable on disk. */
    versionOf: (file) =>
      JSON.parse(run(file, ["version", "--json"], { quiet: true }).stdout),
    /** What the step may leave beside the executable: a staged build, the previous one. */
    besideExecutable: () =>
      host
        .list(installDir)
        .filter(
          (name) =>
            name.startsWith(".vectory") || name.startsWith("vectory.exe."),
        ),

    // ---- what the step and the agent are doing
    agentService() {
      const now = query(units.agent);
      return { State: now.state, PID: now.pid };
    },
    /** What tells one run of the agent's service from another: its process, which changes when it restarts. */
    agentInvocation() {
      const now = query(units.agent);
      return `${now.state}:${now.pid}`;
    },
    stepService() {
      const now = query(units.step);
      return {
        State: now.state,
        PID: now.pid,
        ExitCode: now.exitCode,
        ServiceExitCode: now.serviceExitCode,
      };
    },
    /**
     * Whether the manager runs the step: "active" when its service is running and is
     * started at boot, as the agent's is (automatic, delayed). The step has no timer
     * on Windows: its service runs it every 30 seconds.
     */
    scheduleState() {
      const now = query(units.step);
      const registration = config(units.step);
      return now.state === "RUNNING" &&
        registration.startType === "AUTO_START" &&
        registration.delayed
        ? "active"
        : `${now.state}, ${registration.startType}${registration.delayed ? " (delayed)" : ""}`;
    },
    status: () => host.tryJson(paths.status),
    journal: () => host.tryJson(paths.journal),
    counters: () => host.tryJson(paths.counters),
    policy: () => host.tryJson(paths.policy),

    // ---- ending the step
    /** Ends the step's process outright: a crash, or a power cut for what the step does. */
    killStep() {
      const pid = query(units.step).pid;
      if (!pid)
        throw new Error(`The service ${units.step} has no process to end.`);
      run("taskkill.exe", ["/F", "/T", "/PID", String(pid)], { quiet: true });
      return `taskkill /F /T /PID ${pid} (the process of ${units.step})`;
    },
    /** Polls status.json until the step's stage is `stage`, and returns it. */
    async waitForStage(stage, { timeoutMs = 300000, intervalMs = 100 } = {}) {
      const began = Date.now();
      for (;;) {
        const status = host.status();
        if (status?.stage === stage) return status;
        if (Date.now() - began > timeoutMs)
          throw new Error(
            `The step never showed the stage ${stage} in ${paths.status} within ${timeoutMs / 1000} s; it shows ${JSON.stringify(status)}.`,
          );
        await sleep(intervalMs);
      }
    },

    // ---- installing, and what was installed
    /** Copies the pinned Vector to where the service account can run it; returns its path. */
    installVector(source) {
      fs.mkdirSync(path.dirname(paths.vector), { recursive: true });
      fs.copyFileSync(source, paths.vector);
      const version = run(paths.vector, ["--version"]).stdout.trim();
      if (!version.startsWith("vector 0.58.0 "))
        throw new Error(`Unexpected Vector at ${paths.vector}: ${version}`);
      return paths.vector;
    },
    /** Throws unless only SYSTEM, the Administrators and TrustedInstaller can change the file. */
    assertRootOnly(file) {
      const problems = rootOnlyProblems(readAcls([file])[file]);
      if (problems.length)
        throw new Error(
          `${file} is not root's alone to change:\n  ${problems.join("\n  ")}`,
        );
    },
    /** The owner, protection and access of what the step made, read now. */
    layout() {
      const wanted = Object.keys(host.expectedLayout);
      const acls = readAcls(wanted);
      return Object.fromEntries(
        wanted.map((file) => [file, summarizeAcl(acls[file])]),
      );
    },
    expectedLayout: expectedLayout(paths),
    /**
     * The owner and the access list of the directories the product's path check judges,
     * as they are now: the drive roots, ProgramData and Program Files, the directory the
     * agent keeps its own directories in, and the install directory (the ones that
     * exist). A failure prints it, and a run that passes keeps it in the evidence, so
     * that what this Windows has on them is known without another run.
     */
    describeLocations() {
      try {
        const files = [
          path.parse(programData).root,
          programData,
          updateRoot,
          path.parse(programFiles).root,
          programFiles,
          installDir,
        ].filter(
          (file, i, all) => all.indexOf(file) === i && fs.existsSync(file),
        );
        const acls = readAcls(files);
        return files.map((file) => describeAcl(file, acls[file])).join("\n");
      } catch (error) {
        return `(the access lists couldn't be read: ${error.message})`;
      }
    },

    // ---- the registration of the step's service
    /**
     * The "sandbox" phase on Windows: the Service Control Manager has no sandbox to
     * read, so it reads the registrations. What the manager has for VectoryUpdate
     * (LocalSystem, automatic and delayed, the helper copy told the agent's state
     * directory, the recovery actions, no right for the agent's account), that the
     * agent's service is as it was, and that the step runs again and again.
     */
    async checkUnits(evidence, { assert, assertEqual }) {
      const step = config(units.step);
      const agent = config(units.agent);
      evidence.observe("step_service", step);
      evidence.observe("agent_service", agent);
      await evidence.step(
        "The step's service is registered as the design says: LocalSystem, automatic and delayed, the helper copy told the agent's state directory",
        () => {
          assertEqual(
            [
              step.account,
              step.startType,
              step.delayed,
              step.type.includes("WIN32_OWN_PROCESS"),
            ],
            ["LocalSystem", "AUTO_START", true, true],
            "the step's service",
          );
          assertEqual(
            splitCommandLine(step.binaryPath).map((part, i) =>
              i === 0 ? part.toLowerCase() : part,
            ),
            [
              paths.helper.toLowerCase(),
              "update-helper",
              "--state-dir",
              paths.stateDir,
            ],
            "the command line of the step's service",
          );
        },
      );
      await evidence.step(
        "The manager restarts it at 5 s, 30 s and a minute when it fails, and when it ends with an error of its own",
        () => {
          const failure = parseFailureActions(
            sc(["qfailure", units.step]).text,
          );
          evidence.observe("step_failure_actions", failure);
          assertEqual(
            failure,
            {
              resetPeriod: 86400,
              actions: [
                { action: "RESTART", delayMs: 5000 },
                { action: "RESTART", delayMs: 30000 },
                { action: "RESTART", delayMs: 60000 },
              ],
            },
            "the recovery actions of the step's service",
          );
          assertEqual(
            parseFailureFlag(sc(["qfailureflag", units.step]).text),
            true,
            "whether an end with an error counts as a failure",
          );
        },
      );
      await evidence.step(
        "The agent's service is as setup registered it: NT SERVICE\\Vectory, its executable told its state directory",
        () => {
          assertEqual(
            [agent.account, agent.startType],
            [ACCOUNT.agentService, "AUTO_START"],
            "the agent's service",
          );
          assertEqual(
            splitCommandLine(agent.binaryPath).map((part, i) =>
              i === 0 ? part.toLowerCase() : part,
            ),
            [
              paths.agent.toLowerCase(),
              "service",
              "--state-dir",
              paths.stateDir,
            ],
            "the command line of the agent's service",
          );
        },
      );
      await evidence.step(
        "The agent's account has no right over the step's service: its security descriptor has no entry for it, and gives no account but root more than the right to read the service",
        () => {
          const descriptor = sc(["sdshow", units.step]).stdout.trim();
          evidence.observe("step_service_sddl", descriptor);
          const problems = serviceRightsProblems(
            descriptor,
            serviceSid(units.agent),
          );
          assert(
            problems.length === 0,
            `The step's service gives rights it shouldn't:\n  ${problems.join("\n  ")}\n${descriptor}`,
          );
        },
      );
      await evidence.step(
        "The service runs the step again and again: status.json is rewritten about every 30 seconds and says the host is eligible",
        async () => {
          assertEqual(query(units.step).state, "RUNNING", "the step's service");
          const first = host.status()?.run_at;
          assert(
            first,
            `status.json says nothing yet: ${JSON.stringify(host.status())}`,
          );
          const deadline = Date.now() + 120000;
          let next = first;
          while (next === first && Date.now() < deadline) {
            await sleep(2000);
            next = host.status()?.run_at ?? first;
          }
          assert(
            next !== first,
            `status.json was not rewritten within two minutes (run_at ${first}).`,
          );
          const status = host.status();
          assertEqual(
            [status.stage, status.eligibility],
            ["idle", "eligible"],
            "the step's status after its runs",
          );
          evidence.observe(
            "step_log",
            fs.existsSync(paths.stepLog)
              ? host.readText(paths.stepLog).slice(-4000)
              : "",
          );
        },
      );
    },
    /**
     * What to read from the step while it tries a build: that it is the helper copy,
     * run by the Service Control Manager as SYSTEM.
     */
    async whileTrying(evidence, { assert, assertEqual, minutes }) {
      await evidence.softStep(
        "While it tries the new build, the step is the helper copy running as SYSTEM under the Service Control Manager",
        async () => {
          await host.waitForStage("trial", { timeoutMs: minutes(6) });
          const now = query(units.step);
          assertEqual(now.state, "RUNNING", `${units.step} during the trial`);
          const process = processOf(now.pid);
          assert(process, `The step's process ${now.pid} can't be read.`);
          evidence.observe("step_process_during_trial", process);
          assertEqual(
            [process.path?.toLowerCase(), process.user.toUpperCase()],
            [paths.helper.toLowerCase(), "NT AUTHORITY\\SYSTEM"],
            "the program and the account of the running step",
          );
        },
      );
    },
    /**
     * After a build committed: the step's service ended itself and was started again
     * from the new helper copy (a new process), whose first run removed the copy that
     * was running when it was replaced. `before.stepPid` is the process it had before.
     */
    async afterCommit(evidence, { assert, until, before }) {
      await until(
        "the step's service runs again from the new helper copy (a new process)",
        () => {
          const now = query(units.step);
          return now.state === "RUNNING" && now.pid !== before.stepPid && now;
        },
        {
          timeoutMs: 180000,
          intervalMs: 2000,
          describe: () => JSON.stringify(host.stepService()),
        },
      );
      await until(
        "the copy that was running when it was replaced is removed",
        () =>
          !host.list(paths.helperDir).some((name) => name.includes(".old-")),
        {
          timeoutMs: 180000,
          intervalMs: 2000,
          describe: () => host.list(paths.helperDir).join(", "),
        },
      );
      evidence.observe(
        "helper_directory_after_commit",
        host.list(paths.helperDir),
      );
      assert(host.exists(paths.helper), "The helper copy is gone.");
    },

    // ---- the machine
    /** Returns the machine to the state before any update-capable install. */
    cleanHost() {
      for (const unit of [units.step, units.agent]) removeService(unit);
      const running = agentProcesses();
      for (const row of [...running.supervisors, ...running.vectors])
        run("taskkill.exe", ["/F", "/T", "/PID", String(row.pid)], {
          allowFailure: true,
          quiet: true,
        });
      removeTree(updateRoot);
      removeTree(installDir);
    },
    /** What an install without consent must never leave. */
    consentTraces() {
      const traces = [
        paths.updatesDir,
        paths.stepDir,
        paths.policyDir,
        paths.previous,
      ].filter(host.exists);
      if (query(units.step).exists) traces.push(`service ${units.step}`);
      return traces;
    },

    // ---- little room
    /**
     * Runs body with the volume that holds the step's directory and the install
     * directory almost full: a file of nothing but allocated space takes all but
     * 2.2 builds. The agent downloads one build before the step looks, so what is
     * left then is 1.2 builds, which is not room for two copies. (A volume can't be
     * mounted over the step's directory: the path check refuses a mount point, as it
     * refuses every other kind of link.) The file is removed when body ends.
     */
    async withLittleRoom(buildBytes, body) {
      const drive = path.parse(paths.stepDir).root;
      if (path.parse(paths.installDir).root !== drive)
        throw new Error(
          `The step's directory (${paths.stepDir}) and the install directory (${paths.installDir}) are not on one volume.`,
        );
      const filler = path.join(drive, "vectory-room-filler.bin");
      const target = Math.floor(2.2 * buildBytes);
      const free = host.stepFreeBytes();
      const size = free - target;
      if (size <= 0)
        throw new Error(
          `The volume ${drive} has ${free} bytes free, which is already less than the ${target} the check needs to leave.`,
        );
      try {
        run("fsutil.exe", ["file", "createnew", filler, String(size)]);
        return await body({
          description: `${drive} has ${host.stepFreeBytes()} bytes free after a ${size} byte file of allocated space was made on it`,
        });
      } finally {
        for (let attempt = 1; attempt <= 10; attempt += 1) {
          try {
            fs.rmSync(filler, { force: true });
          } catch {
            // Tried again below.
          }
          if (!fs.existsSync(filler)) break;
          sleepSync(1000);
        }
      }
    },
    /** The free space of the volume that holds the step's directory, in bytes. */
    stepFreeBytes: () => freeBytes(paths.stepDir),

    // ---- the swap's gap, which only a two-rename swap has
    bootGap: {
      query: (unit) => query(unit),
      config: (unit) => config(unit),
      /** Starts a unit and waits for it to run. */
      start(unit) {
        sc(["start", unit], { allowFailure: false, quiet: false });
        return waitForState(unit, "RUNNING", 120000);
      },
      /** Tries to start a unit and reports what the manager said, whatever it was. */
      tryStart(unit) {
        const result = sc(["start", unit], { quiet: false });
        sleepSync(1500);
        return {
          code: result.code,
          text: result.text.trim(),
          state: query(unit),
        };
      },
      stop: (unit) => stopUnit(unit),
      /**
       * Makes the manager wait five minutes before it restarts the step's service
       * when its process ends outright, so that a check can end it and look; returns
       * what puts the recovery actions back.
       */
      pauseRestarts() {
        const set = (delays) =>
          sc(
            [
              "failure",
              units.step,
              "reset=",
              "86400",
              "actions=",
              delays.map((d) => `restart/${d}`).join("/"),
            ],
            { quiet: false, allowFailure: false },
          );
        set([300000, 300000, 300000]);
        return () => set([5000, 30000, 60000]);
      },
      /**
       * Starts a program that holds the file the step stages beside the executable open,
       * shared for reading and writing but not for deletion, as soon as the file is
       * made: the second rename of the swap then meets a sharing violation and waits,
       * with the directory holding no executable. release() lets go.
       */
      async holdStagedFile() {
        const dir = fs.mkdtempSync(
          path.join(
            process.env.RUNNER_TEMP ?? process.env.TEMP ?? ".",
            "vectory-hold-",
          ),
        );
        const flag = path.join(dir, "release");
        const alive = path.join(dir, "alive");
        const held = path.join(dir, "held");
        const scriptFile = path.join(dir, "hold.ps1");
        const logFile = path.join(dir, "hold.log");
        fs.writeFileSync(
          scriptFile,
          [
            "$ErrorActionPreference = 'Continue'",
            `$dir = ${psq(installDir)}; $flag = ${psq(flag)}; $alive = ${psq(alive)}; $ready = ${psq(held)}`,
            "[IO.File]::WriteAllText($alive, 'yes')",
            "$file = $null",
            "$deadline = (Get-Date).AddMinutes(15)",
            "while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $flag)) {",
            "  if ($null -eq $file) {",
            "    foreach ($f in [IO.Directory]::GetFiles($dir, '.vectory-update-*')) {",
            "      try {",
            // Allow the update step to finish writing while denying deletion. Waiting
            // for its writer to close can miss the short window before the rename.
            "        $file = [IO.File]::Open($f, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)",
            "        [IO.File]::WriteAllText($ready, [IO.Path]::GetFileName($f))",
            "        break",
            "      } catch { }",
            "    }",
            "  }",
            "  Start-Sleep -Milliseconds 1",
            "}",
            "if ($null -ne $file) { $file.Dispose() }",
            "",
          ].join("\r\n"),
        );
        // A script file and a log of its own: what the program says is what a failure
        // shows. It has a hidden console of its own, as the other programs the checks
        // start have, and nothing of this process's.
        const log = fs.openSync(logFile, "a");
        let child;
        try {
          child = spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              scriptFile,
            ],
            {
              stdio: ["ignore", log, log],
              windowsHide: true,
              env: windowsPowerShellEnv(),
            },
          );
        } finally {
          fs.closeSync(log);
        }
        child.unref();
        let exited = null;
        child.on("exit", (code) => {
          exited = code ?? "a signal";
        });
        const began = Date.now();
        while (!fs.existsSync(alive)) {
          if (exited !== null || Date.now() - began > 60000)
            throw new Error(
              `The program that holds the staged file never started (${exited === null ? "it did not write its mark in 60 s" : `it ended with ${exited}`}):\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-2000) : "(it wrote no log)"}`,
            );
          await sleep(100);
        }
        return {
          holding: () =>
            fs.existsSync(held) ? fs.readFileSync(held, "utf8") : null,
          async release() {
            fs.writeFileSync(flag, "release");
            for (let i = 0; i < 100 && exited === null; i += 1)
              await sleep(100);
            fs.rmSync(dir, { recursive: true, force: true });
          },
        };
      },
      /** Waits until the directory holds no executable and holds the build that was installed beside it. */
      async waitForGap({ timeoutMs, intervalMs = 20 }) {
        const began = Date.now();
        for (;;) {
          if (!fs.existsSync(paths.agent) && fs.existsSync(paths.previous))
            return {
              seenAfterMs: Date.now() - began,
              beside: host.besideExecutable(),
            };
          if (Date.now() - began > timeoutMs) return null;
          await sleep(intervalMs);
        }
      },
    },

    // ---- what goes in the artifact
    collect(dir) {
      const save = (name, text) =>
        fs.writeFileSync(path.join(dir, name), text ?? "");
      const read = (file) => {
        try {
          return fs.readFileSync(file, "utf8");
        } catch (error) {
          return `(${error.message})\n`;
        }
      };
      for (const [name, file] of Object.entries({
        "step-status.json": paths.status,
        "step-journal.json": paths.journal,
        "step-counters.json": paths.counters,
        "step-installed.json": paths.installed,
        "policy.json": paths.policy,
        "step.log": paths.stepLog,
      }))
        save(name, read(file));
      for (const unit of Object.values(units))
        for (const verb of [
          "queryex",
          "qc",
          "qfailure",
          "qfailureflag",
          "sdshow",
        ])
          save(`sc-${verb}-${unit}.txt`, sc([verb, unit]).text);
      const listing = (dir) =>
        powershell(
          `Get-ChildItem -LiteralPath ${psq(dir)} -Force -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime,Attributes | Format-Table -AutoSize | Out-String -Width 400`,
          { allowFailure: true },
        ).text;
      save("install-dir.txt", listing(installDir));
      save("step-dir.txt", listing(stepDir));
      save("state-updates.txt", listing(paths.updatesDir));
      const icacls = (target, ...flags) =>
        run("icacls.exe", [target, ...flags], {
          allowFailure: true,
          quiet: true,
        }).text;
      save("acl-locations.txt", host.describeLocations());
      save("acl-update-root.txt", icacls(updateRoot));
      save("acl-step.txt", icacls(stepDir, "/T"));
      save("acl-install-dir.txt", icacls(installDir, "/T"));
      save(
        "scm-events.txt",
        powershell(
          "Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = (Get-Date).AddHours(-4) } -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'Vectory' } | Sort-Object TimeCreated | Format-List TimeCreated,Id,Message | Out-String -Width 400",
          { allowFailure: true },
        ).text,
      );
      save("processes.txt", describeProcesses());
    },
  };
  return host;
}
