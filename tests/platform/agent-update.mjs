#!/usr/bin/env node
// Agent updates on a real service: a team turns updates on with a key it keeps
// offline, a host consents when it is installed, a signed build is rolled out
// through the dashboard's API, and the privileged update step applies it, tries it,
// commits it or takes it back. Each phase is one workflow step and writes an
// evidence file (VECTORY_PLATFORM_OUTPUT, default artifacts/platforms).
//
//   node tests/platform/agent-update.mjs build         agents 0.1.0 to 0.1.7 (0.1.8 on Windows)
//                                                      from copies of the source, with only
//                                                      the version constant or one line changed
//                                                      (and, on Windows, the release gate open)
//   node tests/platform/agent-update.mjs enable        a release key made here, updates turned
//                                                      on with offline custody
//   node tests/platform/agent-update.mjs install       0.1.0 installed with the consent flags of
//                                                      the Add device command, and a pipeline
//                                                      applied so that Vector runs
//   node tests/platform/agent-update.mjs sandbox       the step's units, the service manager's
//                                                      reading of them, and one run under them
//                                                      (on a Mac: its launch daemon, and how
//                                                      often launchd starts it)
//   node tests/platform/agent-update.mjs update        0.1.0 to 0.1.1, seen by the server and by
//                                                      the host, while the step runs sandboxed
//   node tests/platform/agent-update.mjs start-failure 0.1.2 never starts: rolled back, tried once
//   node tests/platform/agent-update.mjs no-check-in   0.1.3 runs and never checks in: rolled back
//   node tests/platform/agent-update.mjs truncated     a store file cut short never installs
//   node tests/platform/agent-update.mjs interrupt     the step killed while it swaps and while it
//                                                      tries a build, then run again
//   node tests/platform/agent-update.mjs boot-gap      (Windows) the step killed between the two
//                                                      renames of its swap, when the directory
//                                                      holds no executable, and the services
//                                                      started in the order a boot may start them
//   node tests/platform/agent-update.mjs disk-full     a step directory with no room refuses
//   node tests/platform/agent-update.mjs hostile       the listener taken over by a program that
//                                                      offers what a host must refuse
//   node tests/platform/agent-update.mjs no-consent    a host installed without the flags never
//                                                      makes a file for updates
//   node tests/platform/agent-update.mjs collect       logs and the step's files, for the artifact
//
// Needs the instance of scripts/preview.sh (packaging/Start-LocalPreview.ps1 on
// Windows), the pinned Vector in VECTORY_VECTOR_BIN, passwordless sudo (an elevated
// shell on Windows), and what service.mjs leaves behind (the enrolled instance and
// its first administrator). Phases share what they learn through
// .local/platform/update-context.json. Everything that depends on the operating
// system is in update-hosts.mjs and update-host-windows.mjs: Linux (systemd), macOS
// (launchd) and Windows (the Service Control Manager).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { adapterFor, agentProcesses, describeProcesses } from "./adapters.mjs";
import { agentPort, checkedIn, connect, previewDir } from "./instance.mjs";
import {
  contextFile,
  main,
  outputRoot,
  root,
  run,
  sleep,
  until,
} from "./lib.mjs";
import {
  buildHostileServer,
  instance,
  instanceFiles,
  startHostile,
  verdictOn,
} from "./update-hostile.mjs";
import { updateHostFor } from "./update-hosts.mjs";
import {
  buildAgent,
  buildsFor,
  checksumFile,
  fingerprintOf,
  parseKeygen,
  platform,
  rawClient,
  shortId,
  writeMirror,
} from "./update-lib.mjs";

const phase = process.argv[2];
const work = path.join(root, ".local", "platform", "update");
const updateContextFile = path.join(
  path.dirname(contextFile),
  "update-context.json",
);
const mirrorDir =
  process.env.VECTORY_RELEASES_DIR || path.join(previewDir, "release-mirror");
const minutes = (count) => count * 60 * 1000;

const loadContext = () => {
  try {
    return JSON.parse(fs.readFileSync(updateContextFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${updateContextFile} (${error.message}). Run the earlier phases first.`,
    );
  }
};
const saveContext = (patch) => {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(updateContextFile, "utf8"));
  } catch {
    // The first phase starts it.
  }
  fs.mkdirSync(path.dirname(updateContextFile), { recursive: true });
  fs.writeFileSync(
    updateContextFile,
    JSON.stringify({ ...current, ...patch }, null, 2) + "\n",
  );
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
// A bit mask is a BigInt, which JSON can't write: it is written as hexadecimal.
const written = (value) =>
  JSON.stringify(value, (_, member) =>
    typeof member === "bigint" ? `0x${member.toString(16)}` : member,
  );
function assertEqual(actual, expected, what) {
  if (written(actual) !== written(expected))
    throw new Error(
      `${what}: expected ${written(expected)}, found ${written(actual)}.`,
    );
}

/**
 * What a failed phase prints about the host: the step's status, journal and counters,
 * its log, and the service manager's view, each cut to its last 6 KB. The evidence
 * artifact holds the same files, but the run's page is where a failure is read.
 */
function hostDiagnostics(host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vectory-diagnostics-"));
  try {
    host.collect(dir);
    return fs
      .readdirSync(dir)
      .sort()
      .filter((name) =>
        /^(journal-|step-(status|journal|counters)|step\.log|launchctl-print|launchd-log|sc-(queryex|qfailure)-)/.test(
          name,
        ),
      )
      .map(
        (name) =>
          `--- ${name}\n${fs.readFileSync(path.join(dir, name), "utf8").slice(-6000)}`,
      )
      .join("\n");
  } catch (error) {
    return `(the host's diagnostics couldn't be read: ${error.message})`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A file the product pins, from the agent's test data. */
const golden = (name) =>
  fs.readFileSync(
    path.join(root, "agent", "internal", "agent", "testdata", "update", name),
    "utf8",
  );

/** What a host's own checks (checkUnits, whileTrying, ...) are given to check with. */
const kit = { assert, assertEqual, golden, minutes };

async function signedIn() {
  const connection = await connect();
  return { ...connection, raw: rawClient(connection) };
}

// ---------------------------------------------------------------- build

async function build(evidence) {
  fs.mkdirSync(work, { recursive: true });
  const built = {};
  for (const spec of buildsFor())
    built[spec.version] = await evidence.step(
      `Build agent ${spec.version} from a copy of the source: ${spec.what}`,
      () => buildAgent(spec, work),
    );
  const list = Object.values(built);
  fs.writeFileSync(path.join(work, "SHA256SUMS"), checksumFile(list));
  await evidence.step(
    "Every build says the version it is, and the two changed lines do what they should",
    () => {
      for (const b of list) {
        const said = JSON.parse(
          run(b.file, ["version", "--json"], { quiet: true }).stdout,
        );
        assertEqual(
          [said.version, said.os, said.arch],
          [b.version, platform.goos, platform.goarch],
          `vectory version --json of ${b.version}`,
        );
      }
      // The panic is in the one build that has it: `version --json` answers (above),
      // so the step's probe passes it, and the service dies at every start.
      for (const b of list) {
        const broken = fs
          .readFileSync(b.file)
          .includes("this build is broken on purpose");
        assertEqual(
          broken,
          b.version === "0.1.2",
          `${b.version} has the panic`,
        );
      }
      // The moved heartbeat path is in 0.1.3 and in none of the others.
      for (const b of list) {
        const moved = fs
          .readFileSync(b.file)
          .includes("/agent/v1/heartbeat-moved");
        assertEqual(
          moved,
          b.version === "0.1.3",
          `${b.version} has the moved path`,
        );
      }
    },
  );
  evidence.observe(
    "builds",
    list.map(({ version, what, sha256, size }) => ({
      version,
      what,
      sha256,
      size,
    })),
  );
  saveContext({ builds: built, work });
}

// ---------------------------------------------------------------- enable

function keygen(agent, file, name) {
  const printed = run(
    agent,
    ["release", "keygen", "--out", file, "--name", name],
    {
      quiet: true,
    },
  ).stdout;
  const key = parseKeygen(printed);
  assertEqual(
    fingerprintOf(key.line),
    key.fingerprint,
    `the fingerprint of ${name}`,
  );
  fs.writeFileSync(`${file}.pub`, key.line + "\n");
  return { keyFile: file, pubFile: `${file}.pub`, ...key };
}

async function enable(evidence) {
  const { builds } = loadContext();
  const agent = builds["0.1.0"].file;
  const keysDir = path.join(work, "keys");
  fs.rmSync(keysDir, { recursive: true, force: true });
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const keys = await evidence.step(
    "Make the team's release key, a stranger's and an old one with `vectory release keygen`",
    () => ({
      team: keygen(agent, path.join(keysDir, "team.key"), "team"),
      other: keygen(agent, path.join(keysDir, "stranger.key"), "stranger"),
      old: keygen(agent, path.join(keysDir, "team-old.key"), "team-old"),
    }),
  );
  evidence.observe("team_key", {
    fingerprint: keys.team.fingerprint,
    short: shortId(keys.team.fingerprint),
  });

  const s = await signedIn();
  await evidence.step(
    "Turn agent updates on with offline custody: the server holds the public key only",
    async () => {
      const before = await s.api("/agent-updates");
      assertEqual(
        before.enabled,
        false,
        "agent updates before they are turned on",
      );
      const after = await s.api(
        "/agent-updates/settings",
        {
          enabled: true,
          custody: { kind: "offline", public_key: keys.team.line },
          current_password: s.credentials.password,
          revision: before.revision,
        },
        "PUT",
      );
      assertEqual(
        [after.enabled, after.custody, after.current_key?.fingerprint],
        [true, "offline", keys.team.fingerprint],
        "the settings after turning updates on",
      );
    },
  );
  await evidence.step(
    "The key list and the key bundle on the agent listener hold the public key and nothing of custody",
    async () => {
      const list = await s.api("/agent-release-keys");
      assertEqual(
        list.map((k) => [k.fingerprint, k.state, k.custody]),
        [[keys.team.fingerprint, "current", "offline"]],
        "the release keys",
      );
      const ca = instanceFiles().ca;
      const bundle = JSON.parse(
        run(
          "curl",
          [
            "-fsS",
            "--cacert",
            ca,
            `https://localhost:${agentPort}/agent/v1/release-keys`,
          ],
          { quiet: true },
        ).stdout,
      );
      assertEqual(
        bundle.schema,
        "vectory.release-keys.v1",
        "the bundle's schema",
      );
      const entry = bundle.keys.find(
        (k) => k.fingerprint === keys.team.fingerprint,
      );
      assert(
        entry,
        `the bundle lists ${JSON.stringify(bundle.keys.map((k) => k.fingerprint))}`,
      );
      assertEqual(
        fingerprintOf(entry.public_key),
        entry.fingerprint,
        "the bundle's fingerprint is its key's",
      );
      assert(
        !JSON.stringify(bundle).includes("custody"),
        "the unauthenticated bundle says something about custody",
      );
    },
  );
  saveContext({ keys });
}

// ---------------------------------------------------------------- install

// Where the pinned Vector goes on a host that doesn't say otherwise (Linux and
// macOS): a place the service account can run it from.
const VECTOR = "/usr/local/bin/vector";

/** Where this host's Vector is. */
const vectorOf = (host) => host.paths.vector ?? VECTOR;

/**
 * What tells setup to make the service account: the accounts of systemd and launchd
 * are made, and a Windows service has a virtual account of its own.
 */
const createUserFlags = () =>
  adapterFor({}).createUser ? ["--create-user"] : [];

function installVector(host) {
  const source = process.env.VECTORY_VECTOR_BIN;
  assert(source, "Set VECTORY_VECTOR_BIN to the pinned Vector 0.58.0.");
  if (host.installVector) return host.installVector(source);
  run("mkdir", ["-p", path.dirname(VECTOR)], { elevated: true });
  run("install", ["-m", "0755", source, VECTOR], { elevated: true });
  const version = run(VECTOR, ["--version"]).stdout.trim();
  assert(
    version.startsWith("vector 0.58.0 "),
    `Unexpected Vector at ${VECTOR}: ${version}`,
  );
  return VECTOR;
}

/**
 * The installed executable is root's alone to change: mode 755 and owned by root where
 * a file has a mode, SYSTEM's, the Administrators' and TrustedInstaller's where a file
 * has an access list.
 */
function assertExecutableIsRoots(host) {
  if (host.assertRootOnly) return host.assertRootOnly(host.paths.agent);
  const stat = host.stat(host.paths.agent);
  assertEqual(
    [stat.mode, stat.owner],
    ["755", "root"],
    "the executable's mode and owner",
  );
}

/**
 * What the step made is as the product says: the directories and files that are
 * root's alone, and the ones the agent's account may read. Modes where a file has
 * them (a Windows file has an owner and an access list: layout).
 */
function assertStepFilesArePrivate(host) {
  if (host.layout)
    return assertEqual(
      host.layout(),
      host.expectedLayout,
      "the owner and the access lists of what the step made",
    );
  const modes = {
    [host.paths.stepDir]: "755",
    [host.paths.probe]: "755",
    [host.paths.private]: "700",
    [host.paths.policyDir]: "755",
  };
  for (const [file, want] of Object.entries(modes))
    assertEqual(host.stat(file).mode, want, `the mode of ${file}`);
  assertEqual(
    host.stat(host.paths.status).mode,
    "644",
    "the mode of status.json",
  );
}

/** Runs `vectory setup` for a new device, as Add device's command does, with the flags given. */
async function setupDevice(
  s,
  agent,
  name,
  flags,
  { allowFailure = false, agentPath = null } = {},
) {
  const ca = instanceFiles().ca;
  const fingerprint = new crypto.X509Certificate(fs.readFileSync(ca))
    .fingerprint256;
  const token = await s.api("/tokens", {
    name: `Updates ${name}`,
    expires_hours: 1,
    max_uses: 1,
  });
  const outcome = run(
    agent,
    [
      "setup",
      "--server",
      `https://localhost:${agentPort}`,
      "--ca-sha256",
      fingerprint,
      "--name",
      name,
      "--vector-binary",
      vectorOf(updateHostFor()),
      "--token-stdin",
      "--json",
      ...createUserFlags(),
      ...(agentPath ? ["--agent-path", agentPath] : []),
      ...flags,
    ],
    {
      elevated: true,
      input: `${token.token}\n`,
      timeoutMs: 300000,
      allowFailure: true,
    },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    // A refusal before setup starts prints text, not a result.
  }
  for (const step of parsed?.steps ?? [])
    console.log(
      `  [${step.status}] ${step.label}: ${step.detail}${step.fix ? `\n        ${step.fix}` : ""}`,
    );
  if (!allowFailure && (outcome.code !== 0 || !parsed?.ok))
    throw new Error(`vectory setup exited ${outcome.code}:\n${outcome.text}`);
  return { outcome, parsed };
}

/**
 * `vectory setup --dry-run` with the flags given, for a host that isn't enrolled: it
 * makes nothing and asks for no token. It is how a refusal that setup makes before it
 * changes anything is seen without changing anything.
 */
function dryRunSetup(agent, name, flags) {
  const ca = instanceFiles().ca;
  const fingerprint = new crypto.X509Certificate(fs.readFileSync(ca))
    .fingerprint256;
  return run(
    agent,
    [
      "setup",
      "--server",
      `https://localhost:${agentPort}`,
      "--ca-sha256",
      fingerprint,
      "--name",
      name,
      "--vector-binary",
      vectorOf(updateHostFor()),
      "--json",
      ...createUserFlags(),
      "--dry-run",
      ...flags,
    ],
    { elevated: true, allowFailure: true, timeoutMs: 120000 },
  );
}

async function applyPipeline(evidence, context, label) {
  const output = path.join(outputRoot, `native-workflow-${label}`);
  await evidence.step(
    `A pipeline is applied to ${context.deviceName}, so that Vector runs under the service`,
    () => {
      const result = spawnSync(
        process.execPath,
        [path.join(root, "tests", "native-workflow.mjs")],
        {
          stdio: "inherit",
          timeout: 25 * 60 * 1000,
          env: {
            ...process.env,
            VECTORY_NATIVE_AGENT_MODE: "service",
            VECTORY_NATIVE_DEVICE_NAME: context.deviceName,
            VECTORY_NATIVE_STATE_DIR: context.stateDir,
            VECTORY_NATIVE_MANAGED_CONFIG: context.managedConfig,
            VECTORY_AGENT_BIN: context.agent,
            VECTORY_NATIVE_WORKFLOW_OUTPUT: output,
          },
        },
      );
      assert(
        result.status === 0,
        `tests/native-workflow.mjs exited ${result.status ?? result.signal}.`,
      );
    },
  );
  await evidence.step("One Vector runs under the service", async () => {
    const found = await until(
      "one supervisor and one Vector run",
      () => {
        const processes = agentProcesses();
        return (
          processes.vectors.length === 1 &&
          processes.supervisors.length === 1 &&
          processes
        );
      },
      { timeoutMs: 90000, describe: describeProcesses },
    );
    evidence.observe("vector_processes", found.vectors);
  });
}

async function install(evidence) {
  const context0 = loadContext();
  const { builds, keys } = context0;
  const host = updateHostFor();
  const adapter = adapterFor({});
  const s = await signedIn();

  await evidence.step(
    "Return the machine to the state before any agent: no service, no units, no state, no agent process",
    () => {
      host.cleanHost();
      assert(
        !adapter.state().installed,
        `A service is still registered: ${adapter.state().summary}`,
      );
      const running = agentProcesses();
      assert(
        running.vectors.length === 0 && running.supervisors.length === 0,
        `An agent's processes still run:\n${describeProcesses()}`,
      );
      assertEqual(host.consentTraces(), [], "what updates left on the machine");
    },
  );
  await evidence.step(
    "Install the pinned Vector 0.58.0 where the service account can run it",
    () => installVector(host),
  );

  const deviceName = `ci-update-${Date.now().toString(36)}`;
  const flags = [
    "--updates",
    "auto",
    "--update-key-sha256",
    keys.team.fingerprint,
    "--update-track",
    "patch",
  ];
  // A host with its own ways of making an install path untrustworthy shows them on the
  // real directories, as a dry run of the command a person would run.
  if (host.checkRefusedLocations)
    await host.checkRefusedLocations(evidence, {
      ...kit,
      dryRun: (extra) =>
        dryRunSetup(builds["0.1.0"].file, `${deviceName}-dry`, extra),
      consentFlags: flags,
    });
  const setup = await evidence.step(
    `vectory setup 0.1.0 with the consent flags of Add device (${flags.join(" ")}) registers the service and enrolls ${deviceName}`,
    async () => {
      const { parsed } = await setupDevice(
        s,
        builds["0.1.0"].file,
        deviceName,
        flags,
        { agentPath: host.paths.agent },
      );
      assertEqual(parsed.service, adapter.kind, "the service setup registered");
      assert(
        (parsed.steps ?? []).some((step) => /update/i.test(step.label)),
        `Setup printed no step about updates: ${JSON.stringify(parsed.steps)}`,
      );
      return parsed;
    },
  );
  const context = {
    deviceName,
    deviceId: setup.device.id,
    stateDir: host.paths.stateDir,
    managedConfig: host.paths.managedConfig,
    agent: host.paths.agent,
  };
  saveContext({ device: context });

  await evidence.step(
    "The service runs, and it is the build that was installed",
    async () => {
      await until("the service is running", () => adapter.state().running, {
        timeoutMs: 90000,
        describe: () => adapter.describe(),
      });
      assertEqual(
        host.sha256(host.paths.agent),
        builds["0.1.0"].sha256,
        "the installed executable",
      );
      assertExecutableIsRoots(host);
    },
  );
  await evidence.step(
    "The step is installed: its directory, its modes, its helper copy and its record",
    () => {
      assertStepFilesArePrivate(host);
      assertEqual(
        host.sha256(host.paths.helper),
        builds["0.1.0"].sha256,
        "the helper copy",
      );
      const installed = host.readJson(host.paths.installed);
      assertEqual(
        [installed.version, installed.sha256],
        ["0.1.0", builds["0.1.0"].sha256],
        "installed.json",
      );
      const policy = host.policy();
      assertEqual(
        [policy.consent, policy.track],
        ["auto", "patch"],
        "the policy's consent and track",
      );
      assertEqual(
        policy.keys.map((pinned) => fingerprintOf(pinned.public_key)),
        [keys.team.fingerprint],
        "the keys the host pins",
      );
    },
  );
  await evidence.step(
    "The step is on its schedule, and its status says the host is eligible",
    async () => {
      assertEqual(host.scheduleState(), "active", "the step's schedule");
      const status = await until(
        "status.json is fresh",
        () => {
          const value = host.status();
          return (
            value && Date.now() - Date.parse(value.run_at) < 120000 && value
          );
        },
        { timeoutMs: 120000, intervalMs: 2000 },
      );
      assertEqual(
        [status.stage, status.eligibility, status.service_definition],
        ["idle", "eligible", 1],
        "status.json",
      );
      evidence.observe("status_after_setup", status);
    },
  );
  await evidence.step(
    "The server hears the host's consent and key from its check-in",
    async () => {
      const device = await until(
        "the device reports its update state",
        async () => {
          const row = await s.api(`/devices/${context.deviceId}`);
          return checkedIn(row, Date.now() - 180000) && row.agent_update && row;
        },
        {
          timeoutMs: 180000,
          describe: async () =>
            JSON.stringify(
              await s.api(`/devices/${context.deviceId}`),
              null,
              2,
            ),
        },
      );
      const report = device.agent_update;
      assertEqual(
        [report.consent, report.eligibility, report.track, report.keys],
        ["auto", "eligible", "patch", [keys.team.fingerprint]],
        "what the device reports about updates",
      );
      evidence.observe("device_report", report);
    },
  );
  await applyPipeline(evidence, context, "update");
  saveContext({ vectorPids: agentProcesses().vectors.map((v) => v.pid) });
}

// ---------------------------------------------------------------- the step's units

async function sandbox(evidence) {
  const host = updateHostFor();
  // A service manager with no sandbox to read has its own checks of its definitions.
  if (host.checkUnits) return host.checkUnits(evidence, kit);
  // The pinned text is for an agent in /usr/local/bin; this host's is elsewhere.
  const golden = (name) =>
    kit
      .golden(name)
      .replaceAll('"/usr/local/bin"', `"${host.paths.installDir}"`);
  await evidence.step(
    "The step's service and timer are the text the product pins, word for word",
    () => {
      assertEqual(
        host.unitText(host.paths.stepUnit),
        golden("vectory-update.service"),
        "vectory-update.service",
      );
      assertEqual(
        host.unitText(host.paths.timerUnit),
        golden("vectory-update.timer"),
        "vectory-update.timer",
      );
    },
  );
  await evidence.step(
    "systemd-analyze verify has nothing to say about either unit",
    () => {
      const result = host.analyze();
      evidence.observe("analyze_verify", result);
      assert(
        result.code === 0 && result.output === "",
        `systemd-analyze verify (exit ${result.code}) says:\n${result.output}`,
      );
    },
  );
  await evidence.step("The manager loaded what the files say", () => {
    const { step, timer } = host.unitProperties();
    evidence.observe("properties", { step, timer });
    assertEqual(
      [
        step.Type,
        step.User,
        step.Environment,
        step.ProtectSystem,
        step.ProtectHome,
        step.PrivateTmp,
        step.NoNewPrivileges,
        step.ProtectControlGroups,
        step.RestrictAddressFamilies,
      ],
      ["oneshot", "", "", "strict", "yes", "yes", "yes", "yes", "AF_UNIX"],
      "the step's sandbox as the manager reports it",
    );
    const writable = step.ReadWritePaths.split(/\s+/);
    assertEqual(
      [host.paths.installDir, host.paths.stepDir, host.paths.policyDir].every(
        (dir) => writable.includes(dir),
      ),
      true,
      `the paths the step may write (${step.ReadWritePaths})`,
    );
    const capabilities = step.CapabilityBoundingSet.split(/\s+/)
      .filter(Boolean)
      .map((c) => c.toUpperCase())
      .sort();
    assertEqual(
      capabilities,
      [...host.capabilityNames].sort(),
      "the capability bounding set",
    );
    assertEqual(
      [timer.OnBootUSec, timer.OnUnitInactiveUSec, timer.AccuracyUSec],
      ["15s", "30s", "5s"],
      "the timer",
    );
    assertEqual(
      [timer.ActiveState, timer.UnitFileState],
      ["active", "enabled"],
      "the timer's state",
    );
  });
  await evidence.step(
    "One run of the step under its unit succeeds, and the sandbox never kills it",
    () => {
      host.runStepOnce();
      const service = host.stepService();
      assertEqual(
        [service.Result, service.ExecMainStatus],
        ["success", "0"],
        "the unit's result",
      );
      const journal = host.sudo(
        "journalctl",
        ["-u", host.units.step, "--no-pager", "-o", "cat", "--since", "-3min"],
        { quiet: true, allowFailure: true },
      ).stdout;
      assert(
        !/SIGSYS|status=31|Failed at step|code=killed|Permission denied|Operation not permitted/.test(
          journal,
        ),
        `The step's journal:\n${journal}`,
      );
      const status = host.status();
      assert(
        Date.now() - Date.parse(status.run_at) < 120000,
        `status.json wasn't written by that run: ${JSON.stringify(status)}`,
      );
      assertEqual(status.eligibility, "eligible", "eligibility after a run");
    },
  );
  evidence.observe("exposure", host.exposure());
}

// ---------------------------------------------------------------- releases and rollouts

/** What of the host must not change when an offer is refused, and when nothing is offered. */
function snapshot(host) {
  const status = host.status();
  return {
    executable: host.sha256(host.paths.agent),
    policy: host.exists(host.paths.policy)
      ? host.sha256(host.paths.policy)
      : null,
    floors:
      host.counters()?.highest_counters ?? status?.highest_counters ?? null,
    previous: host.exists(host.paths.previous)
      ? host.sha256(host.paths.previous)
      : null,
    beside: host.besideExecutable
      ? host.besideExecutable()
      : host
          .list(host.paths.installDir)
          .filter((name) => name.startsWith(".vectory")),
    incoming: host.list(path.join(host.paths.updatesDir, "incoming")),
    staging: host.list(host.paths.staging),
    probe: host.list(host.paths.probe),
    vectors: agentProcesses().vectors.map((v) => v.pid),
    invocation: host.agentInvocation(),
    stage: status?.stage ?? null,
  };
}

function requireUnchanged(before, after, what, ignore = []) {
  const changed = Object.keys(before).filter(
    (key) =>
      !ignore.includes(key) &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  assert(
    changed.length === 0,
    `${what} changed ${changed.join(", ")}:\n${JSON.stringify(Object.fromEntries(changed.map((key) => [key, { before: before[key], after: after[key] }])), null, 2)}`,
  );
}

/** Prepares a release of a version from the operator mirror and signs it with the team's key. */
async function prepareRelease(evidence, s, version) {
  const { builds, keys } = loadContext();
  const built = builds[version];
  const dir = path.join(work, `release-${version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await evidence.step(
    `${version}: the operator mirror holds this build and no other`,
    () => {
      writeMirror(mirrorDir, built);
    },
  );
  const release = await evidence.step(
    `${version}: the server prepares a release from its catalog`,
    async () => {
      const value = await s.api("/agent-releases", { version });
      assertEqual(
        value.state,
        "awaiting_signature",
        "the release's state with offline custody",
      );
      const artifact = value.artifacts.find(
        (a) => a.os === platform.goos && a.arch === platform.goarch,
      );
      assert(
        artifact,
        `The release has no build for this platform: ${JSON.stringify(value.artifacts)}`,
      );
      assertEqual(
        [artifact.file, artifact.sha256, artifact.size],
        [built.name, built.sha256, built.size],
        "the build in the release",
      );
      return value;
    },
  );
  const manifest = await evidence.step(
    `${version}: the manifest the server stored is what it says it is`,
    async () => {
      const answer = await s.raw(
        "GET",
        `/agent-releases/${release.id}/manifest`,
      );
      assertEqual(answer.status, 200, "the manifest's status");
      const digest = crypto
        .createHash("sha256")
        .update(answer.bytes)
        .digest("hex");
      assertEqual(digest, release.manifest_sha256, "the manifest's digest");
      const file = path.join(dir, "release.json");
      fs.writeFileSync(file, answer.bytes);
      return { file, digest };
    },
  );
  await evidence.step(
    `${version}: signed offline with the team's key, against a checksum file the server never saw`,
    () => {
      run(
        builds["0.1.0"].file,
        [
          "release",
          "sign",
          "--key",
          keys.team.keyFile,
          "--checksums",
          path.join(work, "SHA256SUMS"),
          "--yes",
          "--out",
          path.join(dir, "release.json.sig"),
          manifest.file,
        ],
        { quiet: false },
      );
    },
  );
  const ready = await evidence.step(
    `${version}: the signature is uploaded and the release is ready`,
    async () => {
      const answer = await s.raw(
        "PUT",
        `/agent-releases/${release.id}/signature`,
        {
          body: fs.readFileSync(path.join(dir, "release.json.sig")),
          type: "application/octet-stream",
        },
      );
      const value = JSON.parse(answer.bytes.toString("utf8"));
      assert(
        answer.status === 200,
        `The signature was refused: ${answer.status} ${JSON.stringify(value)}`,
      );
      assertEqual(
        [value.state, value.signer?.fingerprint],
        ["ready", keys.team.fingerprint],
        "the release after its signature",
      );
      return value;
    },
  );
  return {
    id: release.id,
    version,
    counter: ready.counter,
    manifestSha: manifest.digest,
    dir,
    build: built,
  };
}

/** A target that has ended. */
const ended = (target) =>
  [
    "verified",
    "rolled_back",
    "failed",
    "refused",
    "cancelled",
    "skipped",
  ].includes(target.state);

const selectorFor = (deviceId) => ({
  device_ids: [deviceId],
  group_ids: [],
  exclude_ids: [],
});
const gentle = {
  canary_size: 1,
  batch_size: 1,
  observation_seconds: 60,
  failure_threshold: 0,
};

/** The review for one device, and, when it will update, the rollout. */
async function review(s, release, deviceId) {
  return s.api("/agent-update-rollouts/preview", {
    release_id: release.id,
    selector: selectorFor(deviceId),
    rollout: gentle,
  });
}

async function startRollout(evidence, s, release, deviceId) {
  return evidence.step(
    `${release.version}: a rollout to the device, after its review`,
    async () => {
      const preview = await review(s, release, deviceId);
      assert(
        preview.will_update.length === 1 &&
          preview.will_update[0].device_id === deviceId,
        `The review says the device won't update: ${JSON.stringify(preview.wont_update)}`,
      );
      assertEqual(preview.wont_update, [], "the devices that won't");
      const rollout = await s.api("/agent-update-rollouts", {
        release_id: release.id,
        selector: selectorFor(deviceId),
        rollout: gentle,
        name: `CI ${release.version}`,
        review_token: preview.review_token,
        request_id: crypto.randomUUID(),
      });
      assertEqual(rollout.status, "active", "the rollout's status");
      return rollout;
    },
  );
}

async function target(s, rolloutId) {
  const page = await s.api(
    `/agent-update-rollouts/${rolloutId}/targets?page=1&page_size=12`,
  );
  return page.items[0] ?? null;
}

async function waitForTarget(
  s,
  rollout,
  label,
  accept,
  timeoutMs = minutes(12),
) {
  return until(
    label,
    async () => {
      const value = await target(s, rollout.id);
      return value && accept(value) && value;
    },
    {
      timeoutMs,
      intervalMs: 5000,
      describe: async () =>
        JSON.stringify(
          {
            target: await target(s, rollout.id),
            rollout: await s.api(`/agent-update-rollouts/${rollout.id}`),
          },
          null,
          2,
        ),
    },
  );
}

/** The agent's own report of its last result, from the device row. */
async function lastResult(s, deviceId) {
  return (await s.api(`/devices/${deviceId}`)).agent_update?.last ?? null;
}

// ---------------------------------------------------------------- update

/**
 * What to read from the step while it tries a build, on a host whose service manager
 * sandboxes it (systemd): the capabilities it has, that it can't gain more, the
 * system call filter and what it can write. A host with a way of its own to read the
 * running step has whileTrying instead.
 */
function sandboxWhileTrying(evidence, host) {
  return evidence.softStep(
    "While it tries the new build, the step runs under its sandbox: four capabilities, no new ones, a system call filter, a read-only system",
    async () => {
      await host.waitForStage("trial", { timeoutMs: minutes(6) });
      const pid = Number(host.stepService().MainPID);
      assert(pid > 0, "The step's unit has no main process during the trial.");
      const view = host.confinement(pid);
      evidence.observe("step_confinement", {
        ...view,
        capBnd: view.capBnd.toString(16),
        capEff: view.capEff.toString(16),
      });
      assertEqual(
        view.capBnd,
        host.expectedCapabilityMask,
        "the capability bounding set of the running step",
      );
      assertEqual(
        view.capEff,
        host.expectedCapabilityMask,
        "the effective capabilities of the running step",
      );
      assertEqual(
        [view.noNewPrivs, view.seccomp, view.uid],
        ["1", "2", "0"],
        "NoNewPrivs, the seccomp mode and the user of the running step",
      );
      assertEqual(
        [
          view.readOnly.etc,
          view.readOnly.usr,
          view.readOnly.installDir,
          view.readOnly.stepDir,
          view.readOnly.policyDir,
        ],
        [true, true, false, false, false],
        "what the step's mount namespace lets it write",
      );
    },
  );
}

async function update(evidence) {
  const { builds, keys, device } = loadContext();
  const host = updateHostFor();
  const s = await signedIn();
  const release = await prepareRelease(evidence, s, "0.1.1");
  const before = snapshot(host);
  assertEqual(
    before.executable,
    builds["0.1.0"].sha256,
    "the executable before the update",
  );
  // A step that is one process for as long as its service runs (Windows) is started
  // again from the new helper copy once a build commits: the process it has now is
  // the one that goes.
  const stepPidBefore = host.afterCommit ? host.stepService().PID : null;
  // How long launchd takes to unload the agent while Vector drains, and to load it
  // again, if the host has a way to measure it: before the rollout, so the update
  // starts from an agent that has checked in since.
  if (host.measureAgentRestart) {
    await evidence.softStep(
      "The agent is stopped and started through the service manager with Vector draining, and the times are recorded",
      async () => {
        await host.measureAgentRestart(evidence);
        await until(
          "one Vector runs again",
          () => agentProcesses().vectors.length === 1,
          {
            timeoutMs: minutes(3),
            describe: describeProcesses,
          },
        );
        await until(
          "the device checks in again",
          async () =>
            checkedIn(
              await s.api(`/devices/${device.deviceId}`),
              Date.now() - 60000,
            ),
          { timeoutMs: minutes(3), intervalMs: 3000 },
        );
      },
    );
  }
  const rollout = await startRollout(evidence, s, release, device.deviceId);

  await (host.whileTrying
    ? host.whileTrying(evidence, kit)
    : sandboxWhileTrying(evidence, host));

  const done = await waitForTarget(
    s,
    rollout,
    "the device is updated, as the server counts it: a check-in of the new build that reports the commit",
    ended,
  );
  if (done.state !== "verified")
    throw new Error(
      `The target ended as ${done.state} (${done.code ?? "no code"}), not verified.\n${hostDiagnostics(host)}`,
    );
  assertEqual(
    [done.state, done.from_version, done.to_version],
    ["verified", "0.1.0", "0.1.1"],
    "the target",
  );

  await evidence.step(
    "The host runs the new build: its file, its version, the build kept beside it",
    () => {
      assertEqual(
        host.sha256(host.paths.agent),
        release.build.sha256,
        "the installed executable",
      );
      assertEqual(
        host.versionOf(host.paths.agent).version,
        "0.1.1",
        "vectory version of the installed executable",
      );
      assertEqual(
        host.sha256(host.paths.previous),
        builds["0.1.0"].sha256,
        `the build kept as ${path.basename(host.paths.previous)}`,
      );
      assertExecutableIsRoots(host);
    },
  );
  await evidence.step(
    "The step's record says committed, and the floor and the pins are where the release put them",
    () => {
      const status = host.status();
      assertEqual(
        [
          status.last?.outcome,
          status.last?.from_version,
          status.last?.to_version,
          status.last?.release,
        ],
        ["committed", "0.1.0", "0.1.1", release.manifestSha],
        "status.json's last result",
      );
      assertEqual(status.stage, "idle", "the step's stage");
      assertEqual(host.journal()?.stage, "committed", "the journal's stage");
      const after = snapshot(host);
      assertEqual(
        after.floors[keys.team.fingerprint],
        release.counter,
        "the floor of the team's key",
      );
      assertEqual(
        after.policy,
        before.policy,
        "the policy's digest: the pins are unchanged",
      );
    },
  );
  await evidence.step(
    "The helper copy becomes the build that committed",
    async () => {
      await until(
        "the helper is the new build",
        () => host.sha256(host.paths.helper) === release.build.sha256,
        { timeoutMs: 120000, intervalMs: 3000 },
      );
    },
  );
  if (host.afterCommit)
    await evidence.step(
      "The step's service goes on from the new helper copy: a new process, and the copy that was running is gone",
      () =>
        host.afterCommit(evidence, {
          assert,
          until,
          before: { stepPid: stepPidBefore },
        }),
    );
  await evidence.step(
    "The server shows the same: the build the device runs and the result it reported",
    async () => {
      const row = await s.api(`/devices/${device.deviceId}`);
      assertEqual(
        [row.agent_version, row.agent_sha256],
        ["0.1.1", release.build.sha256],
        "the device's build",
      );
      assertEqual(
        [
          row.agent_update.last.outcome,
          row.agent_update.last.to_version,
          row.agent_update.last.release,
        ],
        ["committed", "0.1.1", release.manifestSha],
        "the device's last update result",
      );
      evidence.observe("last", row.agent_update.last);
    },
  );
  await evidence.softStep(
    "The rollout completes after its observation",
    async () => {
      const finished = await until(
        "the rollout is completed",
        async () => {
          const value = await s.api(`/agent-update-rollouts/${rollout.id}`);
          return value.status === "completed" && value;
        },
        { timeoutMs: minutes(5), intervalMs: 5000 },
      );
      evidence.observe("rollout", {
        status: finished.status,
        state_counts: finished.state_counts,
      });
    },
  );
  await evidence.step("Vector runs again under the new build", async () => {
    await until(
      "one Vector runs",
      () => agentProcesses().vectors.length === 1,
      { timeoutMs: 120000, describe: describeProcesses },
    );
  });
  saveContext({ running: "0.1.1", released: { "0.1.1": release } });
}

// ---------------------------------------------------------------- a build that doesn't start

async function startFailure(evidence) {
  const { builds, keys, device } = loadContext();
  const host = updateHostFor();
  const s = await signedIn();
  const release = await prepareRelease(evidence, s, "0.1.2");
  const running = host.sha256(host.paths.agent);
  assertEqual(
    running,
    builds["0.1.1"].sha256,
    "the executable before the update",
  );
  const rollout = await startRollout(evidence, s, release, device.deviceId);

  const done = await waitForTarget(
    s,
    rollout,
    "the server counts the device as rolled back",
    ended,
    minutes(10),
  );
  assertEqual(
    [done.state, done.code],
    ["rolled_back", "START_FAILED"],
    "the target",
  );
  await evidence.step(
    "The host is on the build it had, with the new build's counter as its floor",
    () => {
      assertEqual(
        host.sha256(host.paths.agent),
        running,
        "the installed executable",
      );
      const status = host.status();
      assertEqual(
        [
          status.last.outcome,
          status.last.code,
          status.last.release,
          status.last.to_version,
        ],
        ["rolled_back", "START_FAILED", release.manifestSha, "0.1.2"],
        "status.json's last result",
      );
      assertEqual(
        snapshot(host).floors[keys.team.fingerprint],
        release.counter,
        "the floor of the team's key",
      );
    },
  );
  await evidence.step(
    "The service runs the build that was there, and checks in",
    async () => {
      await until("the service runs", () => adapterFor({}).state().running, {
        timeoutMs: 120000,
      });
      const row = await until(
        "the device checks in on 0.1.1",
        async () => {
          const value = await s.api(`/devices/${device.deviceId}`);
          return (
            checkedIn(value, Date.now() - 120000) &&
            value.agent_version === "0.1.1" &&
            value
          );
        },
        { timeoutMs: 180000, intervalMs: 5000 },
      );
      assertEqual(
        row.agent_update.last.code,
        "START_FAILED",
        "the code the device reports",
      );
    },
  );

  // The same release again, under a new rollout: the host refuses it before any
  // byte is downloaded, and the service is not stopped.
  const before = snapshot(host);
  await evidence.step(
    "The same release offered again is refused as tried (RELEASE_ALREADY_TRIED) and nothing on the host moves",
    async () => {
      const preview = await review(s, release, device.deviceId);
      assertEqual(preview.will_update, [], "the devices that will update");
      const group = preview.wont_update.find(
        (g) => g.code === "RELEASE_ALREADY_TRIED",
      );
      assert(
        group,
        `The review lists ${JSON.stringify(preview.wont_update.map((g) => g.code))}, not RELEASE_ALREADY_TRIED.`,
      );
      assertEqual(
        group.devices.map((d) => d.device_id),
        [device.deviceId],
        "the devices in that group",
      );
      let refused = null;
      try {
        await s.api("/agent-update-rollouts", {
          release_id: release.id,
          selector: selectorFor(device.deviceId),
          rollout: gentle,
          review_token: preview.review_token,
          request_id: crypto.randomUUID(),
        });
      } catch (error) {
        refused = String(error.message);
      }
      assert(
        refused && /NOTHING_TO_UPDATE/.test(refused),
        `A second rollout of the release was ${refused ? `refused as ${refused}` : "created"}.`,
      );
      await sleep(45000);
      requireUnchanged(before, snapshot(host), "A refused second rollout");
      assertEqual(
        await lastResult(s, device.deviceId).then((l) => l?.code),
        "START_FAILED",
        "the code the device still reports",
      );
    },
  );
  // The server's review keeps most of this from ever being offered. A server that
  // offers it anyway, under a new rollout, meets the host's own refusal: the floor was
  // raised before the service stopped, so the release is refused before a byte is
  // downloaded, and the service is not stopped again.
  await withHostile(
    evidence,
    {
      stateDir: host.paths.stateDir,
      tried: release.dir,
      logName: "hostile-update-server-tried.log",
    },
    async (listener) => {
      await evidence.step(
        "The host itself refuses the release that rolled back, offered under a new rollout (RELEASE_ALREADY_TRIED): nothing is downloaded and Vector and the service are not touched",
        async () => {
          await agentChecksIn(listener);
          const quiet = snapshot(host);
          const state = await offerAndExpectRefusal(
            listener,
            "already_tried",
            "RELEASE_ALREADY_TRIED",
          );
          assertEqual(state.downloads, [], "the downloads the agent asked for");
          requireUnchanged(
            quiet,
            snapshot(host),
            "A release offered again after it rolled back",
          );
        },
      );
    },
  );
  saveContext({ released: { ...loadContext().released, "0.1.2": release } });
}

// ---------------------------------------------------------------- a build that never checks in

async function noCheckIn(evidence) {
  const { builds, keys, device } = loadContext();
  const host = updateHostFor();
  const s = await signedIn();
  const release = await prepareRelease(evidence, s, "0.1.3");
  const running = host.sha256(host.paths.agent);
  assertEqual(
    running,
    builds["0.1.1"].sha256,
    "the executable before the update",
  );
  const rollout = await startRollout(evidence, s, release, device.deviceId);
  await evidence.softStep(
    "The new build runs under the service while it is tried (the step is waiting for its check-in)",
    async () => {
      await host.waitForStage("trial", { timeoutMs: minutes(6) });
      await sleep(30000);
      const service = adapterFor({}).state();
      assert(
        service.running,
        `The service isn't running during the trial: ${service.summary}`,
      );
      assertEqual(
        host.versionOf(host.paths.agent).version,
        "0.1.3",
        "the build under trial",
      );
    },
  );
  const done = await waitForTarget(
    s,
    rollout,
    "the server counts the device as rolled back (five minutes without a check-in, then the previous build reports)",
    ended,
    minutes(15),
  );
  assertEqual(
    [done.state, done.code],
    ["rolled_back", "NO_CHECK_IN"],
    "the target",
  );
  await evidence.step(
    "The host is back on the build it had, and the floor stays at the new build's counter",
    () => {
      assertEqual(
        host.sha256(host.paths.agent),
        running,
        "the installed executable",
      );
      const status = host.status();
      assertEqual(
        [status.last.outcome, status.last.code, status.last.release],
        ["rolled_back", "NO_CHECK_IN", release.manifestSha],
        "status.json's last result",
      );
      assertEqual(
        snapshot(host).floors[keys.team.fingerprint],
        release.counter,
        "the floor of the team's key",
      );
    },
  );
  saveContext({ released: { ...loadContext().released, "0.1.3": release } });
}

// ---------------------------------------------------------------- a store file that is cut short

async function truncated(evidence) {
  const { device } = loadContext();
  const host = updateHostFor();
  const s = await signedIn();
  const release = await prepareRelease(evidence, s, "0.1.4");
  const running = host.sha256(host.paths.agent);
  await evidence.step(
    "The release store's file is cut short after the release was signed",
    () => {
      const stored = path.join(
        previewDir,
        "state",
        "artifacts",
        "agent-releases",
        release.build.sha256,
      );
      assert(fs.existsSync(stored), `The release store has no ${stored}.`);
      fs.truncateSync(stored, release.build.size - 4096);
    },
  );
  const before = snapshot(host);
  const rollout = await startRollout(evidence, s, release, device.deviceId);
  // The server hashes a build as it streams it and refuses to serve a store file
  // that is no longer the one that was signed, so no byte of it reaches the host
  // and the host's own size and digest checks (ARTIFACT_MISMATCH, which the stand-in
  // server proves) are never needed: the update ends as a failed download.
  const done = await waitForTarget(
    s,
    rollout,
    "the device ends the update as failed",
    ended,
    minutes(15),
  );
  assertEqual(
    [done.state, done.code],
    ["failed", "DOWNLOAD_FAILED"],
    "the target",
  );
  await evidence.step(
    "Nothing was installed, staged or left under a final name, and the service was never stopped",
    () => {
      assertEqual(
        host.sha256(host.paths.agent),
        running,
        "the installed executable",
      );
      requireUnchanged(before, snapshot(host), "A cut-short download");
    },
  );
  saveContext({ released: { ...loadContext().released, "0.1.4": release } });
}

// ---------------------------------------------------------------- the step killed

async function interruptOne(evidence, s, version, stage) {
  const { keys, device } = loadContext();
  const host = updateHostFor();
  const release = await prepareRelease(evidence, s, version);
  const old = host.sha256(host.paths.agent);
  const rollout = await startRollout(evidence, s, release, device.deviceId);
  let atKill;
  await evidence.step(
    `The step is killed with SIGKILL as soon as its journal says ${stage}`,
    async () => {
      await host.waitForStage(stage, { timeoutMs: minutes(6), intervalMs: 50 });
      host.killStep();
      atKill = { journal: host.journal(), counters: host.counters() };
      evidence.observe(`killed_in_${stage}`, atKill);
      assertEqual(
        atKill.journal?.stage,
        stage,
        "the journal's stage when the step was killed",
      );
      assertEqual(
        atKill.counters?.highest_counters?.[keys.team.fingerprint],
        release.counter,
        "the floor on disk when the step was killed: it is raised before the service stops",
      );
    },
  );
  await evidence.step(
    "The next run of the step (the timer's) settles it, with one complete executable and a result",
    async () => {
      const settled = await until(
        "the step is idle and has answered the release",
        () => {
          const status = host.status();
          return (
            status?.stage === "idle" &&
            status.last?.release === release.manifestSha &&
            status
          );
        },
        {
          timeoutMs: minutes(10),
          intervalMs: 3000,
          describe: () =>
            JSON.stringify(
              { status: host.status(), journal: host.journal() },
              null,
              2,
            ),
        },
      );
      const now = host.sha256(host.paths.agent);
      assert(
        [old, release.build.sha256].includes(now),
        `The executable is neither the build that was there nor the new one: ${now}`,
      );
      assertEqual(
        host.versionOf(host.paths.agent).version === version,
        now === release.build.sha256,
        "the executable's version agrees with its digest",
      );
      evidence.observe(`settled_after_${stage}`, {
        outcome: settled.last.outcome,
        code: settled.last.code,
        executable: now === old ? "old" : "new",
      });
      if (stage === "trial") {
        assertEqual(
          [settled.last.outcome, now],
          ["committed", release.build.sha256],
          "a trial interrupted once is continued and commits",
        );
        assertEqual(
          host.journal().interruptions,
          1,
          "the journal's count of interruptions",
        );
      } else if (now === old) {
        assertEqual(
          [settled.last.outcome, settled.last.code],
          ["failed", "INTERRUPTED"],
          "a swap that hadn't happened is recorded as interrupted",
        );
      } else {
        assertEqual(
          settled.last.outcome,
          "committed",
          "a swap that had happened continues into its trial and commits",
        );
      }
    },
  );
  await evidence.step(
    "The service runs, the device checks in, and the floor never moved down",
    async () => {
      await until("the service runs", () => adapterFor({}).state().running, {
        timeoutMs: 120000,
      });
      await until(
        "the device checks in",
        async () =>
          checkedIn(
            await s.api(`/devices/${device.deviceId}`),
            Date.now() - 120000,
          ),
        { timeoutMs: 180000, intervalMs: 5000 },
      );
      assert(
        snapshot(host).floors[keys.team.fingerprint] >= release.counter,
        "The floor was lowered.",
      );
    },
  );
  // A device is in at most one update rollout that hasn't ended, so the next
  // release can't be reviewed until the server has heard how this one ended.
  await evidence.step(
    "The server hears how the interrupted update ended",
    async () => {
      const ending = await waitForTarget(
        s,
        rollout,
        "the interrupted update's target ends",
        ended,
        minutes(6),
      );
      evidence.observe(`server_view_after_${stage}`, {
        state: ending.state,
        code: ending.code,
      });
    },
  );
  return release;
}

async function interrupt(evidence) {
  const s = await signedIn();
  const swapping = await interruptOne(evidence, s, "0.1.5", "swapping");
  const trial = await interruptOne(evidence, s, "0.1.6", "trial");
  saveContext({
    released: { ...loadContext().released, "0.1.5": swapping, "0.1.6": trial },
  });
}

// ---------------------------------------------------------------- the gap in a swap of two renames

/**
 * A swap of two renames has one moment with no executable in the directory: after
 * the first (the installed executable becomes the previous build) and before the
 * second (the staged file takes its place). The step is ended in it, which the
 * moment is too short to do from outside, so a program holds the staged file the way
 * a virus scanner does and the second rename waits for it, for the five seconds it
 * is allowed. Then the services are started as a boot may start them: the agent's
 * first, which has nothing to run, and the step's, whose first run puts the build
 * that was installed back and starts the agent. (Which of the two the Service Control
 * Manager starts first at a real boot isn't something a runner that can't be
 * restarted can show: both orders end the same.)
 */
async function bootGap(evidence) {
  const { keys, device } = loadContext();
  const host = updateHostFor();
  if (!host.bootGap)
    throw new Error(
      `A ${host.kind} host swaps in one rename: its directory never holds no executable, so there is no gap to end the step in.`,
    );
  const gap = host.bootGap;
  const s = await signedIn();
  const release = await prepareRelease(evidence, s, "0.1.8");
  const old = host.sha256(host.paths.agent);
  const oldVersion = host.versionOf(host.paths.agent).version;
  let restoreRestarts = null;
  let holder = null;
  try {
    await evidence.step(
      "The manager is told to wait five minutes before it restarts the step's service, so that ending its process leaves the directory as the step left it",
      () => {
        restoreRestarts = gap.pauseRestarts();
      },
    );
    holder = await evidence.step(
      "A program that holds the staged file as a virus scanner does (open for reading and writing, not for deletion) is waiting for it: the second rename will meet a sharing violation and wait",
      () => gap.holdStagedFile(),
    );
    await startRollout(evidence, s, release, device.deviceId);
    await evidence.step(
      "The step is ended between its two renames: the directory holds no executable, and the build that was installed is beside it",
      async () => {
        const found = await gap.waitForGap({ timeoutMs: minutes(8) });
        assert(
          found,
          `The directory never held no executable: the swap went through before the hold was in place (held: ${holder.holding()}). Status ${JSON.stringify(host.status())}, journal ${JSON.stringify(host.journal())}.`,
        );
        const killed = host.killStep();
        const atKill = {
          journal: host.journal(),
          counters: host.counters(),
          beside: host.besideExecutable(),
          held: holder.holding(),
        };
        evidence.observe("ended_in_the_gap", { ...found, killed, ...atKill });
        assert(
          !host.exists(host.paths.agent),
          "The executable was back before the step was ended.",
        );
        assertEqual(
          [
            atKill.journal?.stage,
            atKill.journal?.swap?.style,
            atKill.journal?.swap?.previous,
          ],
          ["swapping", "two_renames", path.basename(host.paths.previous)],
          "the journal when the step was ended in the gap",
        );
        assertEqual(
          host.sha256(host.paths.previous),
          old,
          "the build beside the gap is the one that was installed",
        );
        assertEqual(
          atKill.counters?.highest_counters?.[keys.team.fingerprint],
          release.counter,
          "the floor on disk when the step was ended: it is raised before the service stops",
        );
      },
    );
    await evidence.step(
      "The hold is let go of, and both services are stopped: nothing runs the step or the agent",
      async () => {
        await holder.release();
        holder = null;
        gap.stop(host.units.step);
        gap.stop(host.units.agent);
        assertEqual(
          [gap.query(host.units.step).state, gap.query(host.units.agent).state],
          ["STOPPED", "STOPPED"],
          "the two services",
        );
        assert(
          !host.exists(host.paths.agent),
          "An executable appeared with both services stopped.",
        );
      },
    );
    await evidence.step(
      "A boot that starts the agent's service before the step's: it can't start, because the directory holds no executable, and nothing is made of it",
      () => {
        const attempt = gap.tryStart(host.units.agent);
        evidence.observe("agent_started_before_the_step", attempt);
        assert(
          attempt.code !== 0 && attempt.state.state !== "RUNNING",
          `The agent's service started with no executable:\n${JSON.stringify(attempt, null, 2)}`,
        );
        assert(
          !host.exists(host.paths.agent),
          "Starting the agent's service made an executable.",
        );
      },
    );
    await evidence.step(
      "Then the step's service starts, and its first run puts the previous build back, starts the agent and ends the request as interrupted",
      async () => {
        gap.start(host.units.step);
        const settled = await until(
          "the step is idle and has answered the release",
          () => {
            const status = host.status();
            return (
              status?.stage === "idle" &&
              status.last?.release === release.manifestSha &&
              status
            );
          },
          {
            timeoutMs: minutes(6),
            intervalMs: 2000,
            describe: () =>
              JSON.stringify(
                {
                  status: host.status(),
                  journal: host.journal(),
                  step: host.stepService(),
                  agent: host.agentService(),
                  beside: host.besideExecutable(),
                },
                null,
                2,
              ),
          },
        );
        evidence.observe("settled_after_the_gap", {
          outcome: settled.last.outcome,
          code: settled.last.code,
        });
        assertEqual(
          host.sha256(host.paths.agent),
          old,
          "the executable after the step settled it: the build that was installed",
        );
        assertEqual(
          host.versionOf(host.paths.agent).version,
          oldVersion,
          "vectory version of the executable that was put back",
        );
        assertEqual(
          [settled.last.outcome, settled.last.code],
          ["failed", "INTERRUPTED"],
          "an update cut short before the new build took the executable's place",
        );
        assertEqual(
          host.besideExecutable(),
          [],
          "what the step left beside the executable: the staged file and the previous build are gone",
        );
      },
    );
    await evidence.step(
      "The agent's service runs again, the device checks in, and the floor stays where the step raised it",
      async () => {
        await until("the service runs", () => adapterFor({}).state().running, {
          timeoutMs: 120000,
        });
        await until(
          "the device checks in",
          async () =>
            checkedIn(
              await s.api(`/devices/${device.deviceId}`),
              Date.now() - 120000,
            ),
          { timeoutMs: 180000, intervalMs: 5000 },
        );
        assertEqual(
          snapshot(host).floors[keys.team.fingerprint],
          release.counter,
          "the floor of the team's key",
        );
      },
    );
  } finally {
    // What a failure leaves is put right: the hold, and the manager's own restarts.
    if (holder) await holder.release().catch(() => {});
    if (restoreRestarts) restoreRestarts();
  }
  saveContext({ released: { ...loadContext().released, "0.1.8": release } });
}

// ---------------------------------------------------------------- no room

async function diskFull(evidence) {
  const { device } = loadContext();
  const host = updateHostFor();
  const s = await signedIn();
  const release = await prepareRelease(evidence, s, "0.1.7");
  const sizeMiB = Math.ceil((release.build.size * 1.7) / 2 ** 20);
  // A host that can mount a file system over the step's directory gives it a small one;
  // one that can't (the path check refuses a mount point on Windows) takes the room
  // away from the volume it is on.
  const withLittleRoom = host.withLittleRoom
    ? (body) => host.withLittleRoom(release.build.size, body)
    : (body) =>
        host.withSmallStepFilesystem(sizeMiB, () =>
          body({ description: `on a ${sizeMiB} MiB file system` }),
        );
  await withLittleRoom(async (room) => {
    await evidence.step(
      `The step's directory has less room than two copies of the build (${room.description})`,
      () => {
        const free = host.stepFreeBytes();
        evidence.observe("room", {
          free_bytes: free,
          build_bytes: release.build.size,
        });
        assert(
          free < 2 * release.build.size,
          `The step's directory has ${free} bytes free, which is room for two copies of ${release.build.size}.`,
        );
      },
    );
    const running = host.sha256(host.paths.agent);
    const before = snapshot(host);
    const rollout = await startRollout(evidence, s, release, device.deviceId);
    const done = await waitForTarget(
      s,
      rollout,
      "the device ends the update as failed for lack of room",
      ended,
      minutes(12),
    );
    assertEqual([done.state, done.code], ["failed", "DISK_FULL"], "the target");
    await evidence.step(
      "The step stopped before it changed anything: the executable, the files beside it, the service",
      () => {
        assertEqual(
          host.sha256(host.paths.agent),
          running,
          "the installed executable",
        );
        const status = host.status();
        assertEqual(
          [status.last.outcome, status.last.code],
          ["failed", "DISK_FULL"],
          "status.json's last result",
        );
        // The agent keeps what it staged until the rollout ends, so what is under
        // <state>/updates/incoming is not part of what must stay as it was.
        requireUnchanged(before, snapshot(host), "A refused update", [
          "incoming",
        ]);
      },
    );
  });
  await evidence.step(
    "The step's directory is back on its own file system with what the step wrote",
    () => {
      assert(
        host.stepFreeBytes() > 4 * release.build.size,
        "The step's directory is still on the small file system.",
      );
      assert(
        host.status()?.last?.code === "DISK_FULL",
        "The step's result was lost with the small file system.",
      );
    },
  );
  saveContext({ released: { ...loadContext().released, "0.1.7": release } });
}

// ---------------------------------------------------------------- the stand-in listener

let hostileBinaryPath = null;

function hostileArgs(context, { stateDir, tried }) {
  const { keys, builds } = context;
  return [
    "--agent-state",
    stateDir,
    "--status",
    updateHostFor().paths.status,
    "--pinned-key",
    keys.team.keyFile,
    "--other-key",
    keys.other.keyFile,
    "--old-key",
    keys.old.keyFile,
    "--build",
    builds["0.1.1"].file,
    ...(tried ? ["--tried-release", tried] : []),
  ];
}

/**
 * Runs body while the stand-in listener answers the agent in the instance's place:
 * the instance is stopped first and started again after, whatever body does.
 */
async function withHostile(evidence, { stateDir, tried, logName }, body) {
  const context = loadContext();
  const binary = (hostileBinaryPath ??= buildHostileServer(
    path.join(work, "hostile"),
  ));
  await evidence.step(
    "The instance's listener is stopped, and the stand-in takes its port with the instance's TLS chain and manifest signing key",
    async () => {
      await instance.stop();
    },
  );
  let listener;
  try {
    listener = await startHostile({
      binary,
      args: hostileArgs(context, { stateDir, tried }),
      logName,
    });
    return await body(listener);
  } finally {
    await listener?.stop();
    await evidence.step("The instance is started again", async () => {
      await instance.start();
    });
  }
}

/** Waits until the agent has checked in with the stand-in listener. */
function agentChecksIn(listener) {
  return until(
    "the agent checks in with the stand-in listener",
    async () => (await listener.state()).heartbeats > 0,
    {
      timeoutMs: minutes(3),
      intervalMs: 3000,
      describe: async () => JSON.stringify(await listener.state()),
    },
  );
}

/**
 * Selects a scenario and waits for the agent's verdict on its offer: refused, with
 * the code the scenario says. Then it waits a little longer, so that anything the
 * agent would have done next has happened, and returns what the listener saw.
 */
async function offerAndExpectRefusal(listener, name, expected = null) {
  await listener.scenario(name);
  const code = expected ?? (await listener.state()).expected_code;
  await until(
    `the agent refuses ${name} with ${code}`,
    async () => {
      const report = verdictOn(await listener.state(), name);
      return (
        report && report.state === "refused" && report.code === code && report
      );
    },
    {
      timeoutMs: minutes(4),
      intervalMs: 2000,
      describe: async () => JSON.stringify(await listener.state(), null, 2),
    },
  );
  await sleep(5000);
  return listener.state();
}

// Offers that leave nothing behind but a refusal. A fork is not one of them: it freezes
// the host until it is pinned again, so it goes last, with its own steps.
const HOSTILE = [
  "wrong_key",
  "flipped_byte",
  "lower_counter",
  "expired",
  "issued_ahead",
  "wrong_platform",
  "artifact_path_elsewhere",
  "artifact_disagrees",
  "old_statement",
  "unpinned_rollover",
];
const FORK = "fork";
// A good release signed by one of the fork's two successors, with one of its two
// statements: refused only because the host remembers the fork.
const AFTER_FORK = "after_fork";

async function hostile(evidence) {
  const host = updateHostFor();
  const executable = host.sha256(host.paths.agent);
  await withHostile(
    evidence,
    {
      stateDir: host.paths.stateDir,
      logName: "hostile-update-server-offers.log",
    },
    async (listener) => {
      await evidence.step(
        "The agent checks in with the stand-in: its pins, its floors and its build are what they were",
        async () => {
          await agentChecksIn(listener);
          evidence.observe("before", snapshot(host));
        },
      );
      for (const name of HOSTILE)
        await evidence.softStep(name, async () => {
          const before = snapshot(host);
          const state = await offerAndExpectRefusal(listener, name);
          assertEqual(state.downloads, [], "the downloads the agent asked for");
          requireUnchanged(before, snapshot(host), `The offer ${name}`);
          evidence.observe(name, {
            code: state.expected_code,
            about: scenarioAbout(name),
          });
        });
      // A fork. The agent verifies every offer itself, so it refuses this one at once and
      // downloads nothing. What makes the host remember is the update step: the agent hands
      // it the offer's files and a request, with no build, and the step verifies them
      // again, writes the fork into root's files and answers the request.
      await evidence.softStep(
        "A fork is refused with nothing downloaded, and the agent hands the update step the evidence and no build",
        async () => {
          const before = snapshot(host);
          const state = await offerAndExpectRefusal(listener, FORK);
          assertEqual(state.downloads, [], "the downloads the agent asked for");
          // What the agent staged for the update step comes and goes: the step answers the
          // request within 30 seconds and the agent clears it at its next check-in. It is
          // the one thing this doesn't hold to what it was.
          requireUnchanged(before, snapshot(host), `The offer ${FORK}`, [
            "incoming",
          ]);
          evidence.observe(FORK, {
            code: state.expected_code,
            about: scenarioAbout(FORK),
          });
        },
      );
      await evidence.softStep(
        "After a fork the host says so, and takes nothing more until it is pinned again",
        async () => {
          const incoming = path.join(host.paths.updatesDir, "incoming");
          const request = path.join(host.paths.updatesDir, "request.json");
          const status = await until(
            "the update step records the fork",
            () => {
              const current = host.status();
              return current?.rollover_conflict ? current : null;
            },
            {
              timeoutMs: minutes(3),
              intervalMs: 3000,
              describe: () => JSON.stringify(host.status()),
            },
          );
          evidence.observe("rollover_conflict", status.rollover_conflict);
          assertEqual(
            host.counters()?.rollover_conflict,
            status.rollover_conflict,
            "the fork in the update step's own counters.json, which outlives status.json",
          );
          assertEqual(
            [status.last?.outcome, status.last?.code],
            ["refused", "KEY_ROLLOVER_CONFLICT"],
            "the result the update step gave the request",
          );
          await until(
            "the agent clears what it handed the update step, now that the step has answered",
            () => host.list(incoming).length === 0 && !host.exists(request),
            {
              timeoutMs: minutes(3),
              intervalMs: 3000,
              describe: () =>
                JSON.stringify({
                  incoming: host.list(incoming),
                  request: host.exists(request),
                }),
            },
          );

          // A good release, signed by one of the two successors and carrying one of the
          // two statements, verifies for a host that never saw the fork. This host saw it.
          const before = snapshot(host);
          const state = await offerAndExpectRefusal(listener, AFTER_FORK);
          assertEqual(state.downloads, [], "the downloads the agent asked for");
          requireUnchanged(before, snapshot(host), `The offer ${AFTER_FORK}`);
          assertEqual(
            host.status()?.rollover_conflict,
            status.rollover_conflict,
            "the fork the update step still holds",
          );
          evidence.observe(AFTER_FORK, {
            code: state.expected_code,
            about: scenarioAbout(AFTER_FORK),
          });
        },
      );
      await evidence.step(
        "The executable is the one the update phases left, and nothing is staged on the host",
        () => {
          assertEqual(
            host.sha256(host.paths.agent),
            executable,
            "the executable",
          );
          assertEqual(
            snapshot(host).incoming,
            [],
            "the files under <state>/updates/incoming",
          );
        },
      );
    },
  );
}

const scenarioAbout = (name) =>
  `scenario ${name} of tests/platform/hostile-update-server`;

// ---------------------------------------------------------------- no consent

async function noConsent(evidence) {
  const context = loadContext();
  const { builds, keys } = context;
  const host = updateHostFor();
  const adapter = adapterFor({});
  const empty = fs.mkdtempSync(path.join(work, "empty-state-"));

  await evidence.step(
    "Return the machine to the state before any agent",
    () => {
      host.cleanHost();
      assert(!adapter.state().installed, "A service is still registered.");
    },
  );
  const executable = host.exists(host.paths.agent)
    ? host.sha256(host.paths.agent)
    : null;

  // A key bundle that names the operator's fingerprint over another key: a setup that
  // matched on the member and not on the key would pin a stranger's.
  await withHostile(
    evidence,
    { stateDir: empty, logName: "hostile-update-server-bundle.log" },
    async (listener) => {
      await listener.bundle("lies");
      await evidence.step(
        "Setup with the operator's fingerprint refuses a key bundle whose fingerprint member lies, and changes nothing",
        async () => {
          const outcome = run(
            builds["0.1.0"].file,
            [
              "setup",
              "--server",
              `https://localhost:${agentPort}`,
              "--ca-sha256",
              new crypto.X509Certificate(fs.readFileSync(instanceFiles().ca))
                .fingerprint256,
              "--name",
              "ci-bundle-lie",
              "--vector-binary",
              vectorOf(host),
              "--token-stdin",
              "--json",
              ...createUserFlags(),
              "--agent-path",
              host.paths.agent,
              "--updates",
              "auto",
              "--update-key-sha256",
              keys.team.fingerprint,
            ],
            {
              elevated: true,
              input: "not-a-real-token\n",
              allowFailure: true,
              timeoutMs: 120000,
            },
          );
          assert(
            outcome.code !== 0,
            "Setup accepted a key bundle whose fingerprint member lies.",
          );
          assert(
            /RELEASE_KEY_INVALID/.test(outcome.text),
            `Setup refused, but not as RELEASE_KEY_INVALID:\n${outcome.text}`,
          );
          assertEqual(
            host.consentTraces(),
            [],
            "what a refused setup left on the machine",
          );
          assert(
            !adapter.state().installed,
            "A refused setup registered the service.",
          );
          assert(
            !host.exists(host.paths.stateDir),
            "A refused setup made the state directory.",
          );
          assertEqual(
            host.exists(host.paths.agent)
              ? host.sha256(host.paths.agent)
              : null,
            executable,
            "the installed executable",
          );
          assert(
            (await listener.state()).bundle_requests > 0,
            "Setup never asked for the key bundle.",
          );
        },
      );
    },
  );

  const s = await signedIn();
  const deviceName = `ci-noconsent-${Date.now().toString(36)}`;
  const setup = await evidence.step(
    `A host installed without the consent flags: vectory setup 0.1.0 enrolls ${deviceName}`,
    async () =>
      (
        await setupDevice(s, builds["0.1.0"].file, deviceName, [], {
          agentPath: host.paths.agent,
        })
      ).parsed,
  );
  const deviceId = setup.device.id;
  await evidence.step(
    "It runs, and it never made a file or a unit for updates",
    async () => {
      await until("the service runs", () => adapter.state().running, {
        timeoutMs: 90000,
        describe: () => adapter.describe(),
      });
      assertEqual(host.consentTraces(), [], "what updates left on the machine");
    },
  );
  await evidence.step(
    "The server knows the host takes no updates: its report says off, and a review puts it under UPDATES_OFF",
    async () => {
      const row = await until(
        "the device reports",
        async () => {
          const value = await s.api(`/devices/${deviceId}`);
          return (
            checkedIn(value, Date.now() - 180000) && value.agent_update && value
          );
        },
        { timeoutMs: minutes(3), intervalMs: 5000 },
      );
      assertEqual(
        [row.agent_update.consent, row.agent_update.state],
        ["off", "idle"],
        "what the device reports",
      );
      const release = Object.values(context.released ?? {})[0];
      if (release) {
        const preview = await review(s, release, deviceId);
        assert(
          preview.wont_update.some((group) => group.code === "UPDATES_OFF"),
          `The review lists ${JSON.stringify(preview.wont_update.map((group) => group.code))}.`,
        );
      }
    },
  );
  await evidence.step(
    "A minute and a half later there is still nothing for updates on the host",
    async () => {
      await sleep(90000);
      assertEqual(host.consentTraces(), [], "what updates left on the machine");
    },
  );

  await withHostile(
    evidence,
    { stateDir: host.paths.stateDir, logName: "hostile-update-server-off.log" },
    async (listener) => {
      await evidence.step(
        "A good release offered to the host that consented to nothing is ignored: nothing is downloaded, and no file or directory is made for it",
        async () => {
          await agentChecksIn(listener);
          await listener.scenario("consent_off");
          const report = await until(
            "the agent has been offered it twice and has reported",
            async () => verdictOn(await listener.state(), "consent_off"),
            { timeoutMs: minutes(3), intervalMs: 2000 },
          );
          await sleep(15000);
          assertEqual(
            (await listener.state()).downloads,
            [],
            "the downloads the agent asked for",
          );
          assertEqual(
            [report.consent, report.state],
            ["off", "idle"],
            "what the host reports",
          );
          assertEqual(
            host.consentTraces(),
            [],
            "what updates left on the machine",
          );
        },
      );
    },
  );
}

// ---------------------------------------------------------------- collect

async function collect(evidence) {
  const host = updateHostFor();
  await evidence.softStep("The step's files, journals and units", () => {
    const dir = path.join(outputRoot, "agent-update-logs");
    fs.mkdirSync(dir, { recursive: true });
    host.collect(dir);
  });
}

const phases = {
  build,
  enable,
  install,
  sandbox,
  update,
  "start-failure": startFailure,
  "no-check-in": noCheckIn,
  truncated,
  interrupt,
  "boot-gap": bootGap,
  "disk-full": diskFull,
  hostile,
  "no-consent": noConsent,
  collect,
};
if (!phases[phase]) {
  console.error(
    `Usage: node tests/platform/agent-update.mjs <${Object.keys(phases).join("|")}>`,
  );
  process.exit(2);
}
await main(`agent-update-${phase}`, (evidence) => phases[phase](evidence));
