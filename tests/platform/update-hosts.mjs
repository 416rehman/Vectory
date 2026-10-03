// The privileged update step on each operating system, as the agent-update checks
// see it: where its files are, how to read the ones only root may read, how to
// stop and start it, what its units are, and how to give it a small file system.
// agent-update.mjs asks a host object for all of it and never branches on the
// operating system, so a new system gets its own object here and the phases don't
// change. Linux is built; macOS and Windows add theirs when their native proofs
// are.
import fs from "node:fs";
import path from "node:path";
import {
  isReadOnly,
  linux,
  mountFor,
  parseKeyValues,
  parseMountInfo,
  run,
  sleep,
} from "./lib.mjs";

export function updateHostFor() {
  if (linux) return linuxHost();
  throw new Error(
    `The privileged step's native proof is built for Linux only; add a host for ${process.platform} in tests/platform/update-hosts.mjs, with the members linuxHost has.`,
  );
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

function linuxHost() {
  const stepDir = "/var/lib/vectory-update";
  const paths = {
    agent: "/usr/local/bin/vectory",
    installDir: "/usr/local/bin",
    previous: "/usr/local/bin/.vectory-previous",
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

    exists: (file) =>
      sudo("test", ["-e", file], { allowFailure: true, quiet: true }).code ===
      0,
    readText: (file) => sudo("cat", [file], { quiet: true }).stdout,
    readJson: (file) => JSON.parse(host.readText(file)),
    tryJson(file) {
      const result = sudo("cat", [file], { allowFailure: true, quiet: true });
      if (result.code !== 0) return null;
      try {
        return JSON.parse(result.stdout);
      } catch {
        return null;
      }
    },
    sha256: (file) =>
      sudo("sha256sum", [file], { quiet: true }).stdout.split(" ")[0],
    list: (dir) =>
      sudo("ls", ["-A", dir], { allowFailure: true, quiet: true })
        .stdout.split("\n")
        .filter(Boolean),
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
    /** `vectory version --json` of an executable on disk. */
    versionOf(file) {
      return JSON.parse(
        sudo(file, ["version", "--json"], { quiet: true }).stdout,
      );
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
    stepService: () =>
      show(units.step, [
        "ActiveState",
        "SubState",
        "Result",
        "MainPID",
        "ExecMainStatus",
        "ExecMainCode",
      ]),
    status: () => host.tryJson(paths.status),
    journal: () => host.tryJson(paths.journal),
    counters: () => host.tryJson(paths.counters),
    policy: () => host.tryJson(paths.policy),

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

    // ---- the units
    unitText: (file) => fs.readFileSync(file, "utf8"),
    /** What `systemd-analyze verify` prints about the two units, which must be nothing. */
    analyze() {
      const result = run(
        "systemd-analyze",
        ["verify", "--man=no", paths.stepUnit, paths.timerUnit],
        { allowFailure: true, quiet: true },
      );
      return { code: result.code, output: result.text.trim() };
    },
    exposure() {
      return run("systemd-analyze", ["security", "--no-pager", units.step], {
        allowFailure: true,
        quiet: true,
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
        timer: show(units.timer, [
          "OnBootUSec",
          "OnUnitInactiveUSec",
          "AccuracyUSec",
          "ActiveState",
          "UnitFileState",
          "FragmentPath",
        ]),
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
