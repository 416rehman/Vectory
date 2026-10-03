// The privileged update step on each operating system, as the agent-update checks
// see it: where its files are, how to read the ones only root may read, how to
// stop and start it, what its units are, and how to give it a small file system.
// agent-update.mjs asks a host object for all of it and never branches on the
// operating system, so a new system gets its own object here and the phases don't
// change. Linux and macOS are here, and Windows is in update-host-windows.mjs.
//
// A host also may have the members that only its own service manager needs:
// checkUnits (the "sandbox" phase), whileTrying (what to read from the step while it
// tries a build), measureAgentRestart, and on Windows the access lists it reads
// instead of file modes (assertRootOnly, layout and expectedLayout), the room it
// takes away with a file of allocated space (withLittleRoom), what happens to the
// step's own service after a commit (afterCommit) and the moment its swap holds no
// executable (bootGap). A phase calls the ones a host has.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentProcesses } from "./adapters.mjs";
import {
  isReadOnly,
  linux,
  macos,
  mountFor,
  parseDfAvailable,
  parseKeyValues,
  parseLaunchdPrint,
  parseMountInfo,
  run,
  sleep,
  summarize,
  until,
  windows,
} from "./lib.mjs";
import { windowsHost } from "./update-host-windows.mjs";

export function updateHostFor() {
  if (linux) return linuxHost();
  if (macos) return macosHost();
  if (windows) return windowsHost();
  throw new Error(
    `The privileged step's native proof is built for Linux, macOS and Windows; add a host for ${process.platform} in tests/platform/update-hosts.mjs, with the members linuxHost has.`,
  );
}

/**
 * What every host does the same way: read the files only root may read (the
 * journal, the floors, the policy, the step's status) and wait for the step to
 * reach a stage. `sudo(command, args, options)` runs a command with the rights
 * that takes.
 */
export function rootReaders({ paths, sudo }) {
  const readers = {
    exists: (file) =>
      sudo("test", ["-e", file], { allowFailure: true, quiet: true }).code ===
      0,
    readText: (file) => sudo("cat", [file], { quiet: true }).stdout,
    readJson: (file) => JSON.parse(readers.readText(file)),
    tryJson(file) {
      const result = sudo("cat", [file], { allowFailure: true, quiet: true });
      if (result.code !== 0) return null;
      try {
        return JSON.parse(result.stdout);
      } catch {
        return null;
      }
    },
    list: (dir) =>
      sudo("ls", ["-A", dir], { allowFailure: true, quiet: true })
        .stdout.split("\n")
        .filter(Boolean),
    /** `vectory version --json` of an executable on disk. */
    versionOf(file) {
      return JSON.parse(
        sudo(file, ["version", "--json"], { quiet: true }).stdout,
      );
    },

    status: () => readers.tryJson(paths.status),
    journal: () => readers.tryJson(paths.journal),
    counters: () => readers.tryJson(paths.counters),
    policy: () => readers.tryJson(paths.policy),

    /** Polls status.json until the step's stage is `stage`, and returns it. */
    async waitForStage(stage, { timeoutMs = 300000, intervalMs = 100 } = {}) {
      const began = Date.now();
      for (;;) {
        const status = readers.status();
        if (status?.stage === stage) return status;
        if (Date.now() - began > timeoutMs)
          throw new Error(
            `The step never showed the stage ${stage} in ${paths.status} within ${timeoutMs / 1000} s; it shows ${JSON.stringify(status)}.`,
          );
        await sleep(intervalMs);
      }
    },
  };
  return readers;
}

/** The capabilities of the step's unit, as the bits /proc reports. */
const CAPABILITIES = {
  CAP_CHOWN: 0,
  CAP_DAC_OVERRIDE: 1,
  CAP_FOWNER: 3,
  CAP_KILL: 5,
  CAP_SETGID: 6,
  CAP_SETUID: 7,
};
const expectedCapabilityMask = Object.values(CAPABILITIES).reduce(
  (mask, bit) => mask | (1n << BigInt(bit)),
  0n,
);

// The agent is installed where only root can write, all the way up the path, and
// that no package manager owns. A hosted runner's /usr/local/bin and /opt are
// writable by everyone, and a host installed under either rightly can't take
// updates (UNTRUSTED_LOCATION); /usr/lib is a package directory (PACKAGE_MANAGED).
// So the phases use a directory of their own under a place that is root's.
const INSTALL_DIR_CANDIDATES = [
  "/srv/vectory-native/bin",
  "/usr/share/vectory-native/bin",
  "/usr/local/share/vectory-native/bin",
];

/** What keeps a directory from being root's alone: another owner, or write for group or others. */
function notRootsAlone(dir) {
  const info = fs.statSync(dir);
  if (info.uid !== 0) return `${dir} is owned by uid ${info.uid}`;
  if (info.mode & 0o022)
    return `${dir} is writable by its group or by everyone (mode ${(info.mode & 0o7777).toString(8).padStart(4, "0")})`;
  return null;
}

/**
 * The first candidate directory whose existing ancestors are all root's alone; the
 * rest of the path is made by cleanHost as root. The check is the product's own
 * rule, so a refusal in a phase is the product's and not a runner image's.
 */
function rootOnlyInstallDir() {
  const problems = [];
  for (const candidate of INSTALL_DIR_CANDIDATES) {
    let existing = path.dirname(candidate);
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const chain = [];
    for (let dir = existing; ; dir = path.dirname(dir)) {
      chain.push(dir);
      if (dir === path.dirname(dir)) break;
    }
    const reason = chain.map(notRootsAlone).find(Boolean);
    if (!reason) return candidate;
    problems.push(`${candidate}: ${reason}`);
  }
  throw new Error(
    `No directory of the machine's is root's alone for the agent to be installed in:\n  ${problems.join("\n  ")}`,
  );
}

/**
 * systemd shows a timer's monotonic intervals in one property, `TimersMonotonic={
 * OnBootUSec=15s ; next_elapse=... } { OnUnitInactiveUSec=30s ; ... }`; the
 * intervals are returned as members of their own.
 */
function monotonicIntervals(properties) {
  const text = properties.TimersMonotonic ?? "";
  const interval = (name) =>
    new RegExp(`${name}=([^\\s;}]+)`).exec(text)?.[1] ?? null;
  return {
    ...properties,
    OnBootUSec: interval("OnBootUSec"),
    OnUnitInactiveUSec: interval("OnUnitInactiveUSec"),
  };
}

export function linuxHost() {
  const INSTALL_DIR = rootOnlyInstallDir();
  const stepDir = "/var/lib/vectory-update";
  const paths = {
    agent: `${INSTALL_DIR}/vectory`,
    installDir: INSTALL_DIR,
    previous: `${INSTALL_DIR}/.vectory-previous`,
    stateDir: "/var/lib/vectory-agent",
    updatesDir: "/var/lib/vectory-agent/updates",
    managedConfig: "/etc/vectory/managed/vector.json",
    policyDir: "/etc/vectory/updates",
    policy: "/etc/vectory/updates/policy.json",
    stepDir,
    status: `${stepDir}/status.json`,
    probe: `${stepDir}/probe`,
    private: `${stepDir}/private`,
    journal: `${stepDir}/private/journal.json`,
    counters: `${stepDir}/private/counters.json`,
    installed: `${stepDir}/private/installed.json`,
    staging: `${stepDir}/private/staging`,
    helper: `${stepDir}/private/helper/vectory`,
    agentUnit: "/etc/systemd/system/vectory.service",
    stepUnit: "/etc/systemd/system/vectory-update.service",
    timerUnit: "/etc/systemd/system/vectory-update.timer",
    packagedUnit: "/usr/lib/systemd/system/vectory.service",
  };
  const units = {
    agent: "vectory.service",
    step: "vectory-update.service",
    timer: "vectory-update.timer",
  };
  const sudo = (command, args, options = {}) =>
    run(command, args, { elevated: true, ...options });
  const shell = (script, options = {}) => sudo("sh", ["-c", script], options);
  const show = (unit, properties) =>
    parseKeyValues(
      run(
        "systemctl",
        [
          "show",
          unit,
          "--no-pager",
          ...properties.map((p) => `--property=${p}`),
        ],
        { quiet: true },
      ).stdout,
    );

  const host = {
    kind: "linux",
    paths,
    units,
    account: "vectory",
    sudo,
    ...rootReaders({ paths, sudo }),

    sha256: (file) =>
      sudo("sha256sum", [file], { quiet: true }).stdout.split(" ")[0],
    stat(file) {
      const [mode, owner, group, size] = sudo(
        "stat",
        ["-c", "%a %U %G %s", file],
        { quiet: true },
      )
        .stdout.trim()
        .split(" ");
      return { mode, owner, group, size: Number(size) };
    },

    // ---- what the step and the agent are doing
    agentService: () =>
      show(units.agent, [
        "ActiveState",
        "SubState",
        "NRestarts",
        "MainPID",
        "InvocationID",
        "ActiveEnterTimestampMonotonic",
      ]),
    /** What tells one run of the agent's service from another: it changes when the service restarts. */
    agentInvocation: () => host.agentService().InvocationID,
    stepService: () =>
      show(units.step, [
        "ActiveState",
        "SubState",
        "Result",
        "MainPID",
        "ExecMainStatus",
        "ExecMainCode",
      ]),
    /** Whether the manager runs the step on its schedule: "active" when it does. */
    scheduleState: () => show(units.timer, ["ActiveState"]).ActiveState,

    // ---- running and ending the step
    runStepOnce() {
      sudo("systemctl", ["start", units.step], { timeoutMs: 20 * 60 * 1000 });
    },
    /** SIGKILL to every process of the step's unit: a crash, or a power cut for what the step does. */
    killStep() {
      sudo("systemctl", [
        "kill",
        "--signal=SIGKILL",
        "--kill-whom=all",
        units.step,
      ]);
      return `systemctl kill --signal=SIGKILL ${units.step}`;
    },
    stopTimer: () => sudo("systemctl", ["stop", units.timer, units.step]),
    startTimer: () =>
      sudo("systemctl", ["start", units.timer], { timeoutMs: 60000 }),

    // ---- the units
    unitText: (file) => fs.readFileSync(file, "utf8"),
    /** What `systemd-analyze verify` prints about the two units, which must be nothing. */
    analyze() {
      // As root: the step's helper is in a directory only root can enter, and verify
      // checks that the command is there and can be run.
      const result = run(
        "systemd-analyze",
        ["verify", "--man=no", paths.stepUnit, paths.timerUnit],
        { allowFailure: true, quiet: true, elevated: true },
      );
      return { code: result.code, output: result.text.trim() };
    },
    exposure() {
      return run("systemd-analyze", ["security", "--no-pager", units.step], {
        allowFailure: true,
        quiet: true,
        elevated: true,
      }).text;
    },
    /** The properties the manager reports for the units. */
    unitProperties() {
      return {
        step: show(units.step, [
          "Type",
          "User",
          "Environment",
          "ProtectSystem",
          "ProtectHome",
          "PrivateTmp",
          "NoNewPrivileges",
          "ProtectControlGroups",
          "RestrictAddressFamilies",
          "ReadWritePaths",
          "CapabilityBoundingSet",
          "TimeoutStartUSec",
          "FragmentPath",
        ]),
        timer: monotonicIntervals(
          show(units.timer, [
            "TimersMonotonic",
            "AccuracyUSec",
            "ActiveState",
            "UnitFileState",
            "FragmentPath",
          ]),
        ),
      };
    },
    /**
     * What confines a running step process: the capabilities it can have, that it
     * can't gain more, that a system call filter applies, and which of the file
     * systems it sees are read-only. `pid` is the step's own process.
     */
    confinement(pid) {
      const status = Object.fromEntries(
        sudo("cat", [`/proc/${pid}/status`], { quiet: true })
          .stdout.split("\n")
          .filter((line) => line.includes(":"))
          .map((line) => {
            const at = line.indexOf(":");
            return [line.slice(0, at), line.slice(at + 1).trim()];
          }),
      );
      const mounts = parseMountInfo(
        sudo("cat", [`/proc/${pid}/mountinfo`], { quiet: true }).stdout,
      );
      const readOnly = (file) => isReadOnly(mountFor(file, mounts));
      return {
        capBnd: BigInt(`0x${status.CapBnd}`),
        capEff: BigInt(`0x${status.CapEff}`),
        noNewPrivs: status.NoNewPrivs,
        seccomp: status.Seccomp,
        uid: status.Uid?.split(/\s+/)[0],
        readOnly: {
          etc: readOnly("/etc/passwd"),
          usr: readOnly("/usr/bin/env"),
          installDir: readOnly(`${paths.installDir}/vectory`),
          stepDir: readOnly(paths.status),
          policyDir: readOnly(paths.policy),
          home: mountFor("/home", mounts) === null ? null : readOnly("/home"),
        },
      };
    },
    expectedCapabilityMask,
    capabilityNames: Object.keys(CAPABILITIES),

    // ---- the machine
    /** Returns the machine to the state before any update-capable install. */
    cleanHost() {
      shell(
        `systemctl disable --now ${units.timer} ${units.step} ${units.agent} >/dev/null 2>&1; systemctl stop ${units.agent} >/dev/null 2>&1; true`,
      );
      shell(
        `rm -f ${paths.agentUnit} ${paths.stepUnit} ${paths.timerUnit} ${paths.packagedUnit}; systemctl daemon-reload; systemctl reset-failed; true`,
      );
      shell(
        `rm -rf ${paths.stateDir} ${paths.stepDir} ${paths.policyDir} /etc/vectory/managed ${paths.installDir}/.vectory-previous ${paths.installDir}/.vectory-previous.new ${paths.installDir}/.vectory-update-*`,
      );
      shell(
        `install -d -m 0755 -o root -g root ${path.dirname(paths.installDir)} ${paths.installDir}`,
      );
    },
    /** What an install without consent must never leave. */
    consentTraces() {
      return [
        paths.updatesDir,
        paths.stepDir,
        paths.policyDir,
        paths.stepUnit,
        paths.timerUnit,
        paths.previous,
      ].filter(host.exists);
    },

    /**
     * Runs body with the step's directory on a file system of sizeMiB mebibytes,
     * loop-mounted over it with what was there copied in, and puts everything back
     * when it ends. The step's units are stopped while it changes.
     */
    async withSmallStepFilesystem(sizeMiB, body) {
      const image = "/var/tmp/vectory-update-small.img";
      const saved = "/var/tmp/vectory-update-saved";
      host.stopTimer();
      shell(
        [
          "set -eu",
          `rm -rf ${saved}; mkdir -p ${saved}`,
          `cp -a ${paths.stepDir}/. ${saved}/`,
          `truncate -s ${sizeMiB}M ${image}`,
          `mkfs.ext4 -q -F -O ^has_journal -m 0 ${image}`,
          `mount -o loop ${image} ${paths.stepDir}`,
          `cp -a ${saved}/. ${paths.stepDir}/`,
          `chmod 0755 ${paths.stepDir}`,
        ].join("\n"),
      );
      host.startTimer();
      try {
        return await body();
      } finally {
        host.stopTimer();
        shell(
          [
            "set -eu",
            `cp -a ${paths.stepDir}/. ${saved}/`,
            `umount ${paths.stepDir}`,
            `cp -a ${saved}/. ${paths.stepDir}/`,
            `rmdir ${paths.stepDir}/lost+found || true`,
            `rm -rf ${saved} ${image}`,
          ].join("\n"),
        );
        host.startTimer();
      }
    },
    /** The free space of the file system that holds the step's directory, in bytes. */
    stepFreeBytes() {
      const line = run("df", ["--output=avail", "-B1", paths.stepDir], {
        quiet: true,
      })
        .stdout.trim()
        .split("\n")
        .pop();
      return Number(line);
    },

    // ---- what goes in the artifact
    collect(dir) {
      const save = (name, result) =>
        fs.writeFileSync(path.join(dir, name), result.text ?? result);
      save(
        "journal-agent.txt",
        sudo(
          "journalctl",
          ["-u", units.agent, "--no-pager", "-o", "short-iso"],
          {
            allowFailure: true,
            quiet: true,
          },
        ),
      );
      save(
        "journal-step.txt",
        sudo(
          "journalctl",
          [
            "-u",
            units.step,
            "-u",
            units.timer,
            "--no-pager",
            "-o",
            "short-iso",
          ],
          { allowFailure: true, quiet: true },
        ),
      );
      for (const [name, file] of Object.entries({
        "step-status.json": paths.status,
        "step-journal.json": paths.journal,
        "step-counters.json": paths.counters,
        "step-installed.json": paths.installed,
        "policy.json": paths.policy,
        "step-unit.txt": paths.stepUnit,
        "step-timer.txt": paths.timerUnit,
      }))
        save(name, sudo("cat", [file], { allowFailure: true, quiet: true }));
      save(
        "install-dir.txt",
        sudo("ls", ["-la", paths.installDir], {
          allowFailure: true,
          quiet: true,
        }),
      );
      save(
        "step-dir.txt",
        sudo("ls", ["-laR", paths.stepDir], {
          allowFailure: true,
          quiet: true,
        }),
      );
      save(
        "state-updates.txt",
        sudo("ls", ["-laR", paths.updatesDir], {
          allowFailure: true,
          quiet: true,
        }),
      );
      save(
        "systemctl-step.txt",
        run(
          "systemctl",
          ["status", units.step, units.timer, "--no-pager", "-l"],
          {
            allowFailure: true,
            quiet: true,
          },
        ),
      );
      save(
        "analyze-security.txt",
        run("systemd-analyze", ["security", "--no-pager", units.step], {
          allowFailure: true,
          quiet: true,
        }),
      );
    },
  };
  return host;
}

// ----------------------------------------------------------------- macOS

/** A value as one word for `sh -c`. */
export const quoted = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/**
 * The step on macOS: a launch daemon of its own beside the agent's, under the
 * same launchd. Its files are under /Library/Application Support/Vectory, which
 * has a space in its name, so nothing here builds a command line by joining.
 */
export function macosHost() {
  const support = "/Library/Application Support/Vectory";
  const stepDir = `${support}/update-state`;
  const paths = {
    agent: "/usr/local/bin/vectory",
    installDir: "/usr/local/bin",
    previous: "/usr/local/bin/.vectory-previous",
    stateDir: `${support}/agent`,
    updatesDir: `${support}/agent/updates`,
    managedConfig: `${support}/managed/vector.json`,
    policyDir: `${support}/updates`,
    policy: `${support}/updates/policy.json`,
    support,
    stepDir,
    status: `${stepDir}/status.json`,
    probe: `${stepDir}/probe`,
    private: `${stepDir}/private`,
    journal: `${stepDir}/private/journal.json`,
    counters: `${stepDir}/private/counters.json`,
    installed: `${stepDir}/private/installed.json`,
    staging: `${stepDir}/private/staging`,
    helper: `${stepDir}/private/helper/vectory`,
    stepLog: `${stepDir}/private/step.log`,
    agentPlist: "/Library/LaunchDaemons/io.vectory.agent.plist",
    stepPlist: "/Library/LaunchDaemons/io.vectory.update.plist",
  };
  const labels = { agent: "io.vectory.agent", step: "io.vectory.update" };
  const target = (label) => `system/${label}`;
  const sudo = (command, args, options = {}) =>
    run(command, args, { elevated: true, ...options });
  const shell = (script, options = {}) =>
    sudo("/bin/sh", ["-c", script], options);

  /** `launchctl print` of one of the two jobs: whether launchd knows it, its text and its top-level lines. */
  const print = (label) => {
    const result = sudo("launchctl", ["print", target(label)], {
      allowFailure: true,
      quiet: true,
    });
    return {
      loaded: result.code === 0,
      text: result.text,
      values: result.code === 0 ? parseLaunchdPrint(result.stdout) : {},
    };
  };
  const job = (label) => {
    const printed = print(label);
    return {
      loaded: printed.loaded,
      state: printed.values.state,
      pid: Number(printed.values.pid ?? 0),
      runs: Number(printed.values.runs ?? 0),
      lastExitCode: printed.values["last exit code"],
    };
  };

  const vectorCount = () => agentProcesses().vectors.length;

  /**
   * `launchctl bootstrap system <plist>`, asked again for a few seconds when launchd
   * answers with an error right after it was told to boot the job out (it may still
   * be tearing it down), as the product's own start does. What each try said is
   * returned, so a run that needed more than one shows it.
   */
  const bootstrap = (plist, label) => {
    const tries = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      const result = sudo("launchctl", ["bootstrap", "system", plist], {
        allowFailure: true,
        quiet: true,
        timeoutMs: 120000,
      });
      tries.push({ attempt, exit: result.code, said: result.text.trim() });
      if (result.code === 0 || print(label).loaded) return tries;
      run("sleep", ["2"], { quiet: true });
    }
    throw new Error(
      `launchctl bootstrap system ${plist} failed ${tries.length} times:\n${JSON.stringify(tries, null, 2)}`,
    );
  };

  const host = {
    kind: "macos",
    paths,
    labels,
    account: "_vectory",
    sudo,
    ...rootReaders({ paths, sudo }),

    sha256: (file) =>
      sudo("shasum", ["-a", "256", file], { quiet: true }).stdout.split(" ")[0],
    stat(file) {
      const [mode, owner, group, size] = sudo(
        "stat",
        ["-f", "%Lp %Su %Sg %z", file],
        { quiet: true },
      )
        .stdout.trim()
        .split(" ");
      return { mode, owner, group, size: Number(size) };
    },

    // ---- what the step and the agent are doing
    print,
    agentService: () => job(labels.agent),
    /** What tells one run of the agent's job from another: the count of runs and the process. */
    agentInvocation() {
      const service = job(labels.agent);
      return `${service.runs}:${service.pid}`;
    },
    stepService: () => job(labels.step),
    /** Whether launchd runs the step on its schedule: "active" when it knows the job. */
    scheduleState: () => (print(labels.step).loaded ? "active" : "not loaded"),

    // ---- running and ending the step
    /** Starts the step's job now and waits until that run has ended. */
    async runStepOnce() {
      const before = job(labels.step);
      sudo("launchctl", ["kickstart", target(labels.step)], {
        allowFailure: true,
        quiet: true,
      });
      return until(
        "the step's job has run once more and ended",
        () => {
          const now = job(labels.step);
          return now.runs > before.runs && now.state !== "running" && now;
        },
        {
          timeoutMs: 180000,
          intervalMs: 500,
          describe: () => print(labels.step).text,
        },
      );
    },
    /** SIGKILL to the step's process: a crash, or a power cut for what the step does. */
    killStep() {
      sudo("launchctl", ["kill", "9", target(labels.step)]);
      return `launchctl kill 9 ${target(labels.step)}`;
    },
    stopTimer: () =>
      sudo("launchctl", ["bootout", target(labels.step)], {
        allowFailure: true,
        quiet: true,
        timeoutMs: 120000,
      }),
    startTimer() {
      if (print(labels.step).loaded) return;
      bootstrap(paths.stepPlist, labels.step);
    },

    // ---- the definitions
    unitText: (file) => fs.readFileSync(file, "utf8"),
    unitProperties: () => ({
      step: print(labels.step).values,
      agent: print(labels.agent).values,
    }),

    /**
     * The "sandbox" phase on a Mac: launchd has no sandbox to read, so it reads the
     * step's definition (the text the product pins, valid, loaded as it says) and runs
     * the step once under it, and measures how often launchd starts an idle step.
     */
    async checkUnits(evidence, { assert, assertEqual, golden }) {
      await evidence.step(
        "The step's launch daemon is the text the product pins, word for word",
        () => {
          assertEqual(
            host.unitText(paths.stepPlist),
            golden("io.vectory.update.plist"),
            "io.vectory.update.plist",
          );
        },
      );
      await evidence.step(
        "plutil has nothing to say about the step's definition or the agent's, and both are root's and closed to everyone else",
        () => {
          for (const plist of [paths.stepPlist, paths.agentPlist]) {
            const result = run("plutil", ["-lint", plist], {
              allowFailure: true,
              quiet: true,
            });
            assert(
              result.code === 0 && result.stdout.trim() === `${plist}: OK`,
              `plutil -lint ${plist} (exit ${result.code}) says:\n${result.text}`,
            );
            const stat = host.stat(plist);
            assertEqual(
              [stat.mode, stat.owner],
              ["644", "root"],
              `the mode and owner of ${plist}`,
            );
          }
        },
      );
      // The step runs the new build as the service account from the probe directory
      // before it stops anything. A temporary folder on a Mac is private to its owner,
      // and a script there can't be started as another account (EACCES); the probe
      // directory is root's and open to everyone, and its parents are made so, which
      // this shows for the real account on the real directories.
      await evidence.softStep(
        `The service account (${host.account}) can enter every directory down to the probe directory, where the step runs a new build as it`,
        () => {
          const entered = run(
            "sudo",
            [
              "-n",
              "-u",
              host.account,
              "/bin/sh",
              "-c",
              `cd ${quoted(paths.probe)} && /bin/pwd -P && /bin/ls -ld .`,
            ],
            { allowFailure: true, quiet: true },
          );
          evidence.observe(
            "probe_directory_as_the_service_account",
            entered.text,
          );
          assert(
            entered.code === 0,
            `${host.account} can't enter ${paths.probe}:\n${entered.text}`,
          );
        },
      );
      await evidence.softStep(
        "launchd loaded what the file says: a daemon that runs as root from the helper copy, every 30 seconds, started at load",
        () => {
          const printed = print(labels.step);
          evidence.observe("launchctl_print_step", printed.text);
          assert(
            printed.loaded,
            `launchd doesn't know the step's job:\n${printed.text}`,
          );
          const values = printed.values;
          assertEqual(values.type, "LaunchDaemon", "the job's type");
          assertEqual(
            values.path,
            paths.stepPlist,
            "the definition launchd loaded",
          );
          assert(
            !values.username || values.username === "root",
            `The step's job runs as ${values.username}, not root:\n${printed.text}`,
          );
          assert(
            printed.text.includes(paths.helper) &&
              printed.text.includes("update-helper") &&
              printed.text.includes("--state-dir") &&
              printed.text.includes(paths.stateDir),
            `The step's job doesn't run the helper copy for this state directory:\n${printed.text}`,
          );
          // launchd says how often it starts a job; when it does, it says 30.
          const interval = /run interval = (\d+) seconds/.exec(
            printed.text,
          )?.[1];
          evidence.observe("launchd_says_run_interval", interval ?? null);
          if (interval !== undefined)
            assertEqual(interval, "30", "the run interval launchd printed");
        },
      );
      await evidence.step(
        "One run of the step under its definition ends with status 0 and writes status.json",
        async () => {
          const before = host.status();
          const after = await host.runStepOnce();
          evidence.observe("step_job_after_one_run", after);
          assertEqual(after.lastExitCode, "0", "the step's exit status");
          const status = await until(
            "status.json is written by a later run",
            () => {
              const value = host.status();
              return (
                value &&
                (!before || value.run_at !== before.run_at) &&
                Date.now() - Date.parse(value.run_at) < 120000 &&
                value
              );
            },
            { timeoutMs: 120000, intervalMs: 1000 },
          );
          assertEqual(
            status.eligibility,
            "eligible",
            "eligibility after a run",
          );
          // What launchd kept of the step's standard error: empty while all is well.
          const log = sudo("cat", [paths.stepLog], {
            allowFailure: true,
            quiet: true,
          });
          evidence.observe("step_log_after_idle_runs", {
            read: log.code === 0,
            tail: log.stdout.slice(-2000),
          });
        },
      );
      await evidence.step(
        "launchd's StartInterval, measured: how long an idle step waits between runs",
        async () => {
          const seen = [];
          const began = Date.now();
          // About six intervals of 30 seconds, read from the second status.json says each run.
          while (Date.now() - began < 200000) {
            const at = host.status()?.run_at;
            if (at && !seen.some((entry) => entry.at === at))
              seen.push({ at, ms: Date.parse(at) });
            await sleep(1000);
          }
          const gaps = seen
            .slice(1)
            .map((entry, i) => (entry.ms - seen[i].ms) / 1000);
          const measured = summarize(gaps);
          evidence.observe("launchd_start_interval_seconds", {
            configured: 30,
            runs_seen: seen.length,
            gaps,
            ...measured,
          });
          assert(
            measured,
            `Fewer than two runs of the step showed in 200 s: ${JSON.stringify(seen)}.`,
          );
          assert(
            measured.max < 120,
            `The longest wait between two runs of the step was ${measured.max} s, and the agent calls a step that hasn't run for 120 s not running.`,
          );
        },
      );
    },

    /**
     * What to read from the step while it tries a build: that it runs as root
     * from launchd, from the helper copy, and has no network socket.
     */
    async whileTrying(evidence, { assert, assertEqual, minutes }) {
      await evidence.softStep(
        "While it tries the new build, the step runs as root under launchd from the helper copy, and has no network socket",
        async () => {
          await host.waitForStage("trial", { timeoutMs: minutes(6) });
          const printed = print(labels.step);
          const pid = Number(printed.values.pid ?? 0);
          assert(
            pid > 0,
            `The step's job has no process during the trial:\n${printed.text}`,
          );
          const ps = sudo(
            "ps",
            ["-o", "uid=,ppid=,command=", "-p", String(pid)],
            {
              quiet: true,
            },
          ).stdout.trim();
          const [, uid, ppid, command] =
            /^(\d+)\s+(\d+)\s+(.*)$/s.exec(ps) ?? [];
          const sockets = sudo("lsof", ["-nP", "-a", "-p", String(pid), "-i"], {
            allowFailure: true,
            quiet: true,
          }).stdout.trim();
          evidence.observe("step_during_trial", {
            pid,
            uid,
            ppid,
            command,
            sockets,
          });
          assertEqual(
            [uid, ppid],
            ["0", "1"],
            "the user and the parent of the running step",
          );
          assert(
            command.startsWith(paths.helper) &&
              command.includes("update-helper"),
            `The step runs ${command}, not the helper copy.`,
          );
          assertEqual(
            sockets,
            "",
            "the network sockets the running step holds",
          );
        },
      );
    },

    /**
     * How long launchd takes to unload the agent's job while Vector drains, and to
     * load it again: the two numbers the design lists as not measured. It restarts
     * the agent, so the caller waits for it to check in again.
     */
    async measureAgentRestart(evidence) {
      // Filled in as the numbers come in, so that a run that fails halfway still
      // shows the ones it has.
      const timings = { vector_processes_before: vectorCount() };
      evidence.observe("launchd_agent_restart_seconds", timings);
      const began = Date.now();
      const out = sudo("launchctl", ["bootout", target(labels.agent)], {
        allowFailure: true,
        timeoutMs: 400000,
      });
      timings.bootout_command_exit = out.code;
      timings.bootout_command = (Date.now() - began) / 1000;
      await until(
        "launchd no longer knows the agent's job",
        () => !print(labels.agent).loaded,
        { timeoutMs: 400000, intervalMs: 250 },
      );
      timings.bootout_until_unloaded = (Date.now() - began) / 1000;
      timings.vector_processes_after_stop = vectorCount();
      const started = Date.now();
      timings.bootstrap_tries = bootstrap(paths.agentPlist, labels.agent);
      await until(
        "launchd runs the agent's job again",
        () => print(labels.agent).values.state === "running",
        { timeoutMs: 120000, intervalMs: 250 },
      );
      timings.bootstrap_until_running = (Date.now() - started) / 1000;
    },

    /**
     * What a Mac does with an install path another account could change, on the real
     * directories and through the command a person runs: setup refuses --updates
     * (it is a dry run, so nothing is made) and says which directory and why. The
     * three ways a Mac has: an administrator account that owns /usr/local/bin (what
     * Homebrew on an Intel Mac does), an access list entry on that directory, and
     * one on a directory above it. Each is undone, and /usr/local and /usr/local/bin
     * are left as the step needs them: root's alone.
     */
    async checkRefusedLocations(evidence, { assert, dryRun, consentFlags }) {
      const me = os.userInfo();
      const bin = paths.installDir;
      const listing = () =>
        sudo("ls", ["-ledO", "/usr", "/usr/local", bin], {
          allowFailure: true,
          quiet: true,
        }).text;
      const assertNothingMade = () => {
        const traces = host.consentTraces();
        assert(
          traces.length === 0 && !host.exists(paths.support),
          `A refused setup made ${JSON.stringify([...traces, ...(host.exists(paths.support) ? [paths.support] : [])])}.`,
        );
      };
      const refused = (flagsOutcome, ...fragments) => {
        assert(
          flagsOutcome.code !== 0,
          `Setup accepted --updates here:\n${flagsOutcome.text}`,
        );
        for (const fragment of fragments)
          assert(
            flagsOutcome.text.includes(fragment),
            `Setup's refusal doesn't say ${JSON.stringify(fragment)}:\n${flagsOutcome.text}`,
          );
        assertNothingMade();
      };
      /**
       * Makes /usr/local and /usr/local/bin root's alone, with no access list: what
       * the step needs, and what a Mac has unless something (Homebrew, a runner
       * image) changed it. The listing before is what the Mac had.
       */
      const normalize = () => {
        sudo("mkdir", ["-p", bin]);
        for (const directory of ["/usr/local", bin]) {
          sudo("chown", ["root:wheel", directory]);
          sudo("chmod", ["755", directory]);
          sudo("chmod", ["-N", directory], { allowFailure: true, quiet: true });
        }
      };

      await evidence.step(
        "What the Mac has at /usr/local/bin and above it: owners, modes, flags and access lists",
        () => {
          evidence.observe("install_path_before", listing());
        },
      );
      await evidence.step(
        `An administrator account that owns /usr/local/bin (uid ${me.uid}, as Homebrew on an Intel Mac leaves it) makes setup refuse --updates, with the directory, the reason and the fix, and nothing is made`,
        () => {
          normalize();
          sudo("chown", [String(me.uid), bin]);
          try {
            refused(
              dryRun(consentFlags),
              `${bin} belongs to uid ${me.uid}, not to root`,
              "--install-dir",
              "only root can",
            );
          } finally {
            normalize();
          }
        },
      );
      for (const [what, directory, entry, rights] of [
        [
          "An access list entry on /usr/local/bin that lets everyone add files and delete what it holds",
          bin,
          "group:everyone allow add_file,delete_child",
          "add_file and delete_child",
        ],
        [
          "An access list entry on /usr/local, above it, that lets the admin group add files",
          "/usr/local",
          "group:admin allow add_file",
          "add_file",
        ],
      ])
        await evidence.step(
          `${what} makes setup refuse --updates and name the entry, and nothing is made`,
          () => {
            normalize();
            sudo("chmod", ["+a", entry, directory]);
            try {
              refused(
                dryRun(consentFlags),
                `${directory} has an access list entry that allows ${rights} to`,
              );
              evidence.observe(`refused_${directory.replaceAll("/", "_")}`, {
                listing: listing(),
              });
            } finally {
              sudo("chmod", ["-a", entry, directory], {
                allowFailure: true,
                quiet: true,
              });
              normalize();
            }
          },
        );
      await evidence.step(
        "/usr/local/bin is root's alone again, with no access list, and the refused runs made nothing",
        () => {
          normalize();
          assertNothingMade();
          evidence.observe("install_path_after", listing());
        },
      );
    },

    // ---- the machine
    /** Returns the machine to the state before any update-capable install. */
    cleanHost() {
      const gone = ">/dev/null 2>&1";
      shell(
        `launchctl bootout ${target(labels.step)} ${gone}; launchctl bootout ${target(labels.agent)} ${gone}; hdiutil detach -force ${quoted(paths.stepDir)} ${gone}; true`,
      );
      shell(
        `rm -f ${quoted(paths.stepPlist)} ${quoted(paths.agentPlist)}; true`,
      );
      shell(
        `rm -rf ${quoted(paths.support)} ${quoted(paths.previous)} ${quoted(paths.previous + ".new")} ${quoted(paths.installDir)}/.vectory-update-*`,
      );
    },
    /** What an install without consent must never leave. */
    consentTraces() {
      return [
        paths.updatesDir,
        paths.stepDir,
        paths.policyDir,
        paths.stepPlist,
        paths.previous,
      ].filter(host.exists);
    },

    /**
     * Runs body with the step's directory on a disk image of sizeMiB mebibytes,
     * mounted over it with what was there copied in, and puts everything back when
     * it ends. The step's job is unloaded while the directory changes. The image
     * honors ownership (-owners on): without it every file would look like it
     * belongs to the account that mounted it, and the path check would refuse the
     * directory.
     */
    async withSmallStepFilesystem(sizeMiB, body) {
      const image = "/private/var/tmp/vectory-update-small.dmg";
      const saved = "/private/var/tmp/vectory-update-saved";
      const extras = [
        ".fseventsd",
        ".metadata_never_index",
        ".Trashes",
        ".Spotlight-V100",
        ".TemporaryItems",
        ".DS_Store",
      ];
      host.stopTimer();
      shell(
        [
          "set -eu",
          `rm -rf ${quoted(saved)} ${quoted(image)}; mkdir -p ${quoted(saved)}`,
          `cp -Rp ${quoted(paths.stepDir)}/. ${quoted(saved)}/`,
          `hdiutil create -size ${sizeMiB}m -fs HFS+ -layout NONE -volname VectoryStep ${quoted(image)}`,
          `hdiutil attach -nobrowse -owners on -mountpoint ${quoted(paths.stepDir)} ${quoted(image)}`,
          `touch ${quoted(paths.stepDir)}/.metadata_never_index`,
          `chown root:wheel ${quoted(paths.stepDir)}`,
          `chmod 0755 ${quoted(paths.stepDir)}`,
          `cp -Rp ${quoted(saved)}/. ${quoted(paths.stepDir)}/`,
        ].join("\n"),
        { timeoutMs: 300000 },
      );
      host.startTimer();
      try {
        return await body();
      } finally {
        host.stopTimer();
        const clear = (dir) =>
          extras.map((name) => quoted(`${dir}/${name}`)).join(" ");
        shell(
          [
            "set -eu",
            `rm -rf ${clear(paths.stepDir)}`,
            `cp -Rp ${quoted(paths.stepDir)}/. ${quoted(saved)}/`,
            `hdiutil detach ${quoted(paths.stepDir)} || { sleep 5; hdiutil detach -force ${quoted(paths.stepDir)}; }`,
            `cp -Rp ${quoted(saved)}/. ${quoted(paths.stepDir)}/`,
            `rm -rf ${clear(paths.stepDir)}`,
            `rm -rf ${quoted(saved)} ${quoted(image)}`,
          ].join("\n"),
          { timeoutMs: 300000 },
        );
        host.startTimer();
      }
    },
    /** The free space of the file system that holds the step's directory, in bytes. */
    stepFreeBytes: () =>
      parseDfAvailable(
        run("df", ["-k", paths.stepDir], { quiet: true }).stdout,
      ),

    // ---- what goes in the artifact
    collect(dir) {
      const save = (name, result) =>
        fs.writeFileSync(path.join(dir, name), result.text ?? result);
      const read = (name, file) =>
        save(name, sudo("cat", [file], { allowFailure: true, quiet: true }));
      read("step-status.json", paths.status);
      read("step-journal.json", paths.journal);
      read("step-counters.json", paths.counters);
      read("step-installed.json", paths.installed);
      read("policy.json", paths.policy);
      read("step-plist.txt", paths.stepPlist);
      read("agent-plist.txt", paths.agentPlist);
      // What the step wrote to standard error, which launchd keeps in this file.
      read("step.log", paths.stepLog);
      save("launchctl-print-step.txt", { text: print(labels.step).text });
      save("launchctl-print-agent.txt", { text: print(labels.agent).text });
      for (const [name, args] of Object.entries({
        "install-dir.txt": ["-laO", paths.installDir],
        "step-dir.txt": ["-laOeR", paths.stepDir],
        "state-updates.txt": ["-laOeR", paths.updatesDir],
        // Who owns each directory the step's path check reads, its mode and any
        // access list: what the check refuses is one of these.
        "path-components.txt": [
          "-ledO",
          "/",
          "/Library",
          "/Library/LaunchDaemons",
          support.replace(/\/Vectory$/, ""),
          support,
          paths.stepDir,
          paths.policyDir,
          "/usr",
          "/usr/local",
          paths.installDir,
          paths.agent,
        ],
      }))
        save(name, sudo("ls", args, { allowFailure: true, quiet: true }));
      save("mounts.txt", run("mount", [], { allowFailure: true, quiet: true }));
    },
  };
  return host;
}
