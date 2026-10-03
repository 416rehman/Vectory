// node --test tests/platform/update-hosts.test.mjs
// The host objects of agent-update.mjs without a service manager: what the phases
// may call exists on every host, what the hosts read from files they read the same
// way, and the paths a Mac's host names are the ones the product pins.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { root, run } from "./lib.mjs";
import { windowsHost } from "./update-host-windows.mjs";
import {
  linuxHost,
  macosHost,
  monotonicIntervals,
  quoted,
  rootReaders,
  runIntervalOf,
} from "./update-hosts.mjs";

const source = fs.readFileSync(
  path.join(import.meta.dirname, "agent-update.mjs"),
  "utf8",
);

/** The members the phases of agent-update.mjs call on a host. */
const MEMBERS = [
  "paths",
  "exists",
  "readText",
  "readJson",
  "tryJson",
  "sha256",
  "list",
  "stat",
  "versionOf",
  "agentInvocation",
  "stepService",
  "scheduleState",
  "status",
  "journal",
  "counters",
  "policy",
  "runStepOnce",
  "killStep",
  "stopTimer",
  "startTimer",
  "waitForStage",
  "unitText",
  "cleanHost",
  "consentTraces",
  "withSmallStepFilesystem",
  "stepFreeBytes",
  "collect",
];

const PATHS = [
  "agent",
  "installDir",
  "previous",
  "stateDir",
  "updatesDir",
  "managedConfig",
  "policyDir",
  "policy",
  "stepDir",
  "status",
  "probe",
  "private",
  "journal",
  "counters",
  "installed",
  "staging",
  "helper",
];

// What a Windows host has instead of what only the systemd and launchd hosts have: a
// file there has an access list and not a mode (assertRootOnly, layout), nothing can be
// mounted over the step's directory (withLittleRoom), the step has no timer and its
// service has no sandbox to read (checkUnits, whileTrying), and the step's own service
// restarts after a commit and its swap has a moment with no executable (afterCommit,
// bootGap).
const WINDOWS_INSTEAD = {
  stat: ["assertRootOnly", "layout", "expectedLayout"],
  runStepOnce: ["checkUnits"],
  stopTimer: ["scheduleState"],
  startTimer: ["scheduleState"],
  unitText: ["checkUnits"],
  withSmallStepFilesystem: ["withLittleRoom"],
};
const WINDOWS_ONLY = [
  "installVector",
  "besideExecutable",
  "whileTrying",
  "afterCommit",
  "bootGap",
  "describeLocations",
];

// A Windows runner has no Linux directories for the Linux host to look at and no
// /bin/sh: what needs them is checked on the other systems, and what is Windows's
// own is checked here by the Windows host alone.
const onWindows = process.platform === "win32";
const notOnWindows = onWindows
  ? "needs the Linux host's directories or /bin/sh"
  : false;

test("every host has every member a phase calls, and every path it reads", () => {
  const hosts = onWindows
    ? { windows: windowsHost() }
    : { linux: linuxHost(), macos: macosHost(), windows: windowsHost() };
  for (const [name, host] of Object.entries(hosts)) {
    for (const member of MEMBERS) {
      if (name === "windows" && WINDOWS_INSTEAD[member]) {
        for (const instead of WINDOWS_INSTEAD[member])
          assert.ok(
            host[instead] !== undefined,
            `windows has no ${instead}, which it has in place of ${member}`,
          );
        continue;
      }
      assert.ok(host[member] !== undefined, `${name} has no ${member}`);
    }
    for (const key of PATHS)
      assert.equal(
        typeof host.paths[key],
        "string",
        `${name} has no path ${key}`,
      );
  }
  for (const member of WINDOWS_ONLY)
    assert.ok(windowsHost()[member] !== undefined, `windows has no ${member}`);
});

// A phase may call a member only one host has (checkUnits, whileTrying,
// measureAgentRestart and checkRefusedLocations are a Mac's; the capabilities and
// the sandbox's readings are Linux's) when it asks first. A name that no host has,
// a misspelling, is what this finds.
test(
  "a phase calls host.<member> only for a member some host has",
  { skip: notOnWindows },
  () => {
    const known = new Set([
      ...Object.keys(linuxHost()),
      ...Object.keys(macosHost()),
      ...Object.keys(windowsHost()),
    ]);
    for (const [, member] of source.matchAll(/\bhost\.([A-Za-z0-9]+)/g))
      assert.ok(
        known.has(member),
        `agent-update.mjs calls host.${member}, which no host has`,
      );
    // What a Mac's host alone has, and a Windows host's, is behind a question to the
    // host (or, for what a host must have for the phase to make sense, a refusal).
    for (const member of [
      "checkUnits",
      "whileTrying",
      "measureAgentRestart",
      "checkRefusedLocations",
      "installVector",
      "assertRootOnly",
      "layout",
      "besideExecutable",
      "afterCommit",
      "withLittleRoom",
      "bootGap",
      "describeLocations",
    ]) {
      assert.ok(
        new RegExp(
          `if \\(!?host\\.${member}\\)|host\\.${member}\\s*\\?|!host\\.${member}`,
        ).test(source),
        `agent-update.mjs never asks whether the host has ${member}`,
      );
    }
  },
);

test("the paths of a Mac's host are the ones the product pins in its definition", () => {
  const { paths } = macosHost();
  const golden = fs.readFileSync(
    path.join(
      root,
      "agent",
      "internal",
      "agent",
      "testdata",
      "update",
      "io.vectory.update.plist",
    ),
    "utf8",
  );
  for (const file of [paths.helper, paths.stateDir, paths.stepLog])
    assert.ok(golden.includes(`<string>${file}</string>`), `${file}`);
  assert.equal(
    paths.stepPlist,
    "/Library/LaunchDaemons/io.vectory.update.plist",
  );
  assert.equal(
    paths.agentPlist,
    "/Library/LaunchDaemons/io.vectory.agent.plist",
  );
  // The step's directory holds what the design says, under the support folder.
  for (const key of ["status", "probe", "private", "helper", "stepLog"])
    assert.ok(paths[key].startsWith(`${paths.stepDir}/`), key);
  assert.ok(paths.policyDir.startsWith(`${paths.support}/`));
  assert.ok(paths.stateDir.startsWith(`${paths.support}/`));
});

test("a timer's intervals are read from every line systemd prints for them", () => {
  // As systemd 255 prints the timer of the update step: one TimersMonotonic line per
  // interval, the one written last in the file first, so the last line alone has
  // the boot interval and none of the other.
  const shown = [
    "TimersMonotonic={ OnUnitInactiveUSec=30s ; next_elapse=0 }",
    "TimersMonotonic={ OnBootUSec=15s ; next_elapse=15s }",
    "AccuracyUSec=5s",
    "ActiveState=active",
    "UnitFileState=enabled",
    "FragmentPath=/etc/systemd/system/vectory-update.timer",
    "",
  ].join("\n");
  const timer = monotonicIntervals(shown);
  assert.equal(timer.OnBootUSec, "15s");
  assert.equal(timer.OnUnitInactiveUSec, "30s");
  assert.equal(timer.AccuracyUSec, "5s");
  assert.equal(timer.ActiveState, "active");
  // On one line, as an older systemd prints them, and with no interval at all.
  const joined = monotonicIntervals(
    "TimersMonotonic={ OnBootUSec=15s ; next_elapse=15s }{ OnUnitInactiveUSec=30s ; next_elapse=0 }\n",
  );
  assert.deepEqual(
    [joined.OnBootUSec, joined.OnUnitInactiveUSec],
    ["15s", "30s"],
  );
  const none = monotonicIntervals("AccuracyUSec=5s\n");
  assert.deepEqual([none.OnBootUSec, none.OnUnitInactiveUSec], [null, null]);
});

// The Mac's check of the step's StartInterval reads the number from what launchd
// prints, and a print that has no such line is no proof of the interval.
test("the run interval is read from the line launchd prints for it, and a print with none says none", () => {
  const printed = (extra) =>
    [
      "system/io.vectory.update = {",
      "\tactive count = 0",
      "\tpath = /Library/LaunchDaemons/io.vectory.update.plist",
      "\ttype = LaunchDaemon",
      ...extra,
      "\tstate = not running",
      "}",
      "",
    ].join("\n");
  assert.equal(runIntervalOf(printed(["\trun interval = 30 seconds"])), "30");
  assert.equal(runIntervalOf(printed(["\trun interval = 1 second"])), "1");
  assert.equal(runIntervalOf(printed(["\trun interval = 300 seconds"])), "300");
  // Words after it don't hide it.
  assert.equal(
    runIntervalOf(printed(["\trun interval = 30 seconds (next in 12 s)"])),
    "30",
  );
  // Nothing about an interval, or something that only looks like one.
  assert.equal(runIntervalOf(printed([])), undefined);
  assert.equal(runIntervalOf(printed(["\tinterval = 30 seconds"])), undefined);
  assert.equal(runIntervalOf(printed(["\trun interval = soon"])), undefined);
  assert.equal(runIntervalOf(printed(["\trun interval = 30 minutes"])), undefined);
  assert.equal(runIntervalOf(""), undefined);
});

test(
  "a path with a space or a quote is one word for sh",
  { skip: notOnWindows },
  () => {
    assert.equal(quoted("/a b/c"), "'/a b/c'");
    assert.equal(quoted("it's"), `'it'\\''s'`);
    const out = run(
      "/bin/sh",
      ["-c", `printf %s ${quoted("/Library/Application Support/it's")}`],
      { quiet: true },
    );
    assert.equal(out.stdout, "/Library/Application Support/it's");
  },
);

test("the files only root may read are read the same way on every host", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vectory-hosts-"));
  try {
    const paths = {
      status: path.join(dir, "status.json"),
      journal: path.join(dir, "journal.json"),
      counters: path.join(dir, "counters.json"),
      policy: path.join(dir, "policy.json"),
    };
    // Without elevation: the files are the test's own.
    const readers = rootReaders({
      paths,
      sudo: (command, args, options = {}) => run(command, args, options),
    });
    assert.equal(readers.status(), null);
    assert.equal(readers.exists(paths.status), false);

    fs.writeFileSync(paths.status, JSON.stringify({ stage: "idle", n: 1 }));
    fs.writeFileSync(paths.journal, "not json");
    assert.deepEqual(readers.status(), { stage: "idle", n: 1 });
    assert.equal(readers.journal(), null);
    assert.deepEqual(readers.readJson(paths.status), { stage: "idle", n: 1 });
    assert.equal(readers.exists(paths.status), true);
    assert.deepEqual(readers.list(dir).sort(), ["journal.json", "status.json"]);
    assert.deepEqual(readers.list(path.join(dir, "missing")), []);

    // waitForStage returns the status when the stage shows, and says what it saw when it doesn't.
    setTimeout(
      () => fs.writeFileSync(paths.status, JSON.stringify({ stage: "trial" })),
      150,
    );
    assert.deepEqual(
      await readers.waitForStage("trial", { timeoutMs: 5000, intervalMs: 20 }),
      { stage: "trial" },
    );
    await assert.rejects(
      readers.waitForStage("swapping", { timeoutMs: 100, intervalMs: 20 }),
      /never showed the stage swapping.*it shows \{"stage":"trial"\}/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
