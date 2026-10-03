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
import {
  linuxHost,
  macosHost,
  monotonicIntervals,
  quoted,
  rootReaders,
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

test("every host has every member a phase calls, and every path it reads", () => {
  for (const [name, host] of Object.entries({
    linux: linuxHost(),
    macos: macosHost(),
  })) {
    for (const member of MEMBERS)
      assert.ok(host[member] !== undefined, `${name} has no ${member}`);
    for (const key of PATHS)
      assert.equal(
        typeof host.paths[key],
        "string",
        `${name} has no path ${key}`,
      );
  }
});

// A phase may call a member only one host has (checkUnits, whileTrying,
// measureAgentRestart and checkRefusedLocations are a Mac's; the capabilities and
// the sandbox's readings are Linux's) when it asks first. A name that no host has,
// a misspelling, is what this finds.
test("a phase calls host.<member> only for a member some host has", () => {
  const known = new Set([
    ...Object.keys(linuxHost()),
    ...Object.keys(macosHost()),
  ]);
  for (const [, member] of source.matchAll(/\bhost\.([A-Za-z0-9]+)/g))
    assert.ok(
      known.has(member),
      `agent-update.mjs calls host.${member}, which no host has`,
    );
  // What a Mac's host alone has is behind a question to the host.
  for (const member of [
    "checkUnits",
    "whileTrying",
    "measureAgentRestart",
    "checkRefusedLocations",
  ]) {
    assert.ok(
      new RegExp(`if \\(host\\.${member}\\)|host\\.${member}\\s*\\?`).test(
        source,
      ),
      `agent-update.mjs never asks whether the host has ${member}`,
    );
  }
});

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

test("a path with a space or a quote is one word for sh", () => {
  assert.equal(quoted("/a b/c"), "'/a b/c'");
  assert.equal(quoted("it's"), `'it'\\''s'`);
  const out = run(
    "/bin/sh",
    ["-c", `printf %s ${quoted("/Library/Application Support/it's")}`],
    { quiet: true },
  );
  assert.equal(out.stdout, "/Library/Application Support/it's");
});

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
