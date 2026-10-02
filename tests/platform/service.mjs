#!/usr/bin/env node
// The agent as an operating-system service on this host: systemd on Linux,
// launchd on macOS, the Service Control Manager on Windows. Each phase is one
// workflow step, so a failed run names the phase that failed, and each writes
// an evidence file (VECTORY_PLATFORM_OUTPUT, default artifacts/platforms).
//
//   node tests/platform/service.mjs install          vectory setup as a service for the
//                                                     unprivileged account, enrolled against
//                                                     the instance (first administrator on a
//                                                     fresh one), then what the manager and
//                                                     the API report
//   node tests/platform/service.mjs apply [label]    tests/native-workflow.mjs in service
//                                                     mode against that device
//   node tests/platform/service.mjs lifecycle        restart, a killed agent, stop and start
//   node tests/platform/service.mjs uninstall        service-uninstall removes the
//                                                     registration and keeps the state
//   node tests/platform/service.mjs stop-foreground  stops the detached agent that
//                                                     tests/native-workflow.mjs leaves running
//   node tests/platform/service.mjs collect          logs and the manager's view, for the artifact
//
// Needs the instance of scripts/preview.sh (or packaging/Start-LocalPreview.ps1,
// see .github/workflows/platforms.yml), the pinned Vector in VECTORY_VECTOR_BIN
// and, on Linux and macOS, passwordless sudo; on Windows, an elevated process.
// Phases share what they learn through .local/platform/context.json.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  adapterFor,
  agentProcesses,
  describeProcesses,
  expectProperties,
} from "./adapters.mjs";
import { bind, readStatus, tryStatus } from "./checks.mjs";
import {
  agentPort,
  checkedIn,
  connect,
  downloadAgent,
  previewDir,
} from "./instance.mjs";
import {
  contextFile,
  linux,
  macos,
  main,
  outputRoot,
  parseDuration,
  readContext,
  root,
  run,
  sha256File,
  until,
  windows,
  writeContext,
} from "./lib.mjs";

const programData = process.env.ProgramData || "C:\\ProgramData";
const programFiles = process.env.ProgramFiles || "C:\\Program Files";
/** Where `vectory setup` puts things by default (docs/user/cli.md). */
const defaults = windows
  ? {
      stateDir: `${programData}\\Vectory\\agent`,
      managedConfig: `${programData}\\Vectory\\managed\\vector.json`,
      agent: `${programFiles}\\Vectory\\vectory.exe`,
      vector: `${programFiles}\\Vector\\bin\\vector.exe`,
    }
  : macos
    ? {
        stateDir: "/Library/Application Support/Vectory/agent",
        managedConfig:
          "/Library/Application Support/Vectory/managed/vector.json",
        agent: "/usr/local/bin/vectory",
        vector: "/usr/local/bin/vector",
      }
    : {
        stateDir: "/var/lib/vectory-agent",
        managedConfig: "/etc/vectory/managed/vector.json",
        agent: "/usr/local/bin/vectory",
        vector: "/usr/local/bin/vector",
      };
/** The longest a stop may wait: Vector's 300 s drain limit and the agent's margin. */
const STOP_LIMIT_SECONDS = 330;

const phase = process.argv[2];
const label = process.argv[3] || "service";

function printSetup(result) {
  for (const step of result.steps ?? [])
    console.log(
      `  [${step.status}] ${step.label}: ${step.detail}${step.fix ? `\n        ${step.fix}` : ""}`,
    );
}

/** Copies the pinned Vector to a place the service account can run it. */
function installVector(source) {
  if (!source)
    throw new Error("Set VECTORY_VECTOR_BIN to the pinned Vector 0.58.0.");
  if (windows) {
    fs.mkdirSync(path.dirname(defaults.vector), { recursive: true });
    fs.copyFileSync(source, defaults.vector);
  } else {
    run("mkdir", ["-p", path.dirname(defaults.vector)], { elevated: true });
    run("install", ["-m", "0755", source, defaults.vector], { elevated: true });
  }
  const version = run(defaults.vector, ["--version"]).stdout.trim();
  if (!version.startsWith("vector 0.58.0 "))
    throw new Error(`Unexpected Vector at ${defaults.vector}: ${version}`);
  return defaults.vector;
}

function assertElevated() {
  if (windows) {
    const groups = run("whoami.exe", ["/groups"], { quiet: true }).stdout;
    if (!groups.includes("S-1-16-12288"))
      throw new Error(
        "This process is not elevated: setup registers a Windows service.",
      );
  } else if (process.getuid() !== 0) {
    run("sudo", ["-n", "true"]);
  }
}

// ---- install ----------------------------------------------------------

async function install(evidence) {
  const adapter = adapterFor({});
  await evidence.step(
    "The host is ready: administrator rights, no earlier service, no agent Vector running",
    async () => {
      assertElevated();
      const before = adapter.state();
      if (before.installed)
        throw new Error(
          `A ${adapter.serviceName} service is already registered here: ${before.summary}`,
        );
      const running = agentProcesses();
      if (running.vectors.length || running.supervisors.length)
        throw new Error(
          `An agent's Vector already runs here, and setup would refuse to take it over:\n${describeProcesses()}`,
        );
    },
  );

  const vector = await evidence.step(
    "Install the pinned Vector 0.58.0 where the service account can run it",
    async () => {
      const target = installVector(process.env.VECTORY_VECTOR_BIN);
      evidence.observe("vector", { path: target, sha256: sha256File(target) });
      return target;
    },
  );

  const instance = await evidence.step(
    "Sign in to the instance (the first administrator on a fresh one)",
    () => connect(),
  );
  const { api, cookie } = instance;

  const download = await evidence.step(
    "Download the agent from the server's release listing",
    () =>
      downloadAgent({
        api,
        cookie,
        directory: path.join(root, ".local", "platform", "agent"),
      }),
  );
  evidence.observe("agent_download", download.source);

  const runId = Date.now().toString(36);
  const deviceName = `ci-${adapter.kind}-${runId}`;
  const caPem = path.join(root, ".local", "pki", "ca.pem");
  const fingerprint = new crypto.X509Certificate(fs.readFileSync(caPem))
    .fingerprint256;

  const result = await evidence.step(
    `vectory setup registers the ${adapter.kind} service and enrolls ${deviceName} (CA pinned)`,
    async () => {
      const token = await api("/tokens", {
        name: `Platform ${adapter.kind} ${runId}`,
        expires_hours: 1,
        max_uses: 1,
      });
      const args = [
        "setup",
        "--server",
        `https://localhost:${agentPort}`,
        "--ca-sha256",
        fingerprint,
        "--name",
        deviceName,
        "--vector-binary",
        vector,
        "--token-stdin",
        "--json",
        ...(adapter.createUser ? ["--create-user"] : []),
      ];
      // The token goes in on stdin, never in the arguments the log shows.
      const outcome = run(download.file, args, {
        elevated: true,
        input: `${token.token}\n`,
        timeoutMs: 300000,
        allowFailure: true,
      });
      let parsed;
      try {
        parsed = JSON.parse(outcome.stdout);
      } catch {
        throw new Error(
          `vectory setup exited ${outcome.code} without a JSON result:\n${outcome.text}`,
        );
      }
      printSetup(parsed);
      if (outcome.code !== 0 || !parsed.ok)
        throw new Error(
          `vectory setup exited ${outcome.code}; see the steps above.`,
        );
      if (parsed.service !== adapter.kind || parsed.needs_attention)
        throw new Error(
          `Setup registered "${parsed.service}" (needs attention: ${Boolean(parsed.needs_attention)}); expected ${adapter.kind}.`,
        );
      if (parsed.state_dir !== defaults.stateDir)
        throw new Error(
          `Setup used the state directory ${parsed.state_dir}, not the documented default ${defaults.stateDir}.`,
        );
      if (parsed.device?.name !== deviceName)
        throw new Error(
          `Setup enrolled ${JSON.stringify(parsed.device)}, not ${deviceName}.`,
        );
      evidence.observe("setup", {
        steps: parsed.steps,
        device: parsed.device,
        state_dir: parsed.state_dir,
      });
      return parsed;
    },
  );

  await evidence.softStep(
    "The agent is installed at the default path with the downloaded build",
    () => {
      if (!fs.existsSync(defaults.agent))
        throw new Error(`${defaults.agent} does not exist.`);
      const installed = sha256File(defaults.agent);
      if (installed !== download.source.sha256)
        throw new Error(
          `${defaults.agent} (SHA-256 ${installed}) is not the downloaded build ${download.source.sha256}.`,
        );
      if (!windows) {
        const info = fs.statSync(defaults.agent);
        if ((info.mode & 0o777) !== 0o755)
          throw new Error(
            `${defaults.agent} has mode ${(info.mode & 0o777).toString(8)}, not 755.`,
          );
        if (info.uid !== 0)
          throw new Error(
            `${defaults.agent} belongs to uid ${info.uid}, not root.`,
          );
      }
      evidence.observe("agent", { path: defaults.agent, sha256: installed });
    },
  );

  const context = {
    kind: adapter.kind,
    serviceName: adapter.serviceName,
    account: adapter.account,
    deviceName,
    deviceId: result.device.id,
    server: result.server,
    stateDir: defaults.stateDir,
    managedConfig: defaults.managedConfig,
    agent: defaults.agent,
    agentSha256: download.source.sha256,
    vector,
  };
  writeContext(context);
  const live = adapterFor(context);

  await evidence.step(
    "The service manager reports the service running",
    async () => {
      await until("the service is running", () => live.state().running, {
        timeoutMs: 60000,
        describe: () => live.describe(),
      });
      evidence.observe("service_after_setup", live.state().summary);
    },
  );

  await evidence.softStep(
    "The registration is what the documentation says",
    () => registration(context, live, evidence),
  );

  if (linux)
    await evidence.step(
      "Vector's default data directory exists for the service account (the agent uses it when a pipeline sets no data_dir)",
      () => {
        run(
          "install",
          [
            "-d",
            "-o",
            "vectory",
            "-g",
            "vectory",
            "-m",
            "0750",
            "/var/lib/vector",
          ],
          { elevated: true },
        );
      },
    );

  await evidence.softStep(
    "vectory status and vectory doctor agree with the manager",
    () => {
      const view = readStatus(context);
      evidence.observe("status", {
        service: view.service,
        agent_running: view.agent_running,
        device: view.device,
        next_step: view.next_step,
      });
      if (
        !view.service?.installed ||
        view.service.state !== "running" ||
        !view.agent_running
      )
        throw new Error(
          `status says the service is not running:\n${JSON.stringify(view.service)}`,
        );
      if (view.device?.name !== deviceName)
        throw new Error(
          `status names ${view.device?.name}, not ${deviceName}.`,
        );
      if (!view.vector_binary_ok)
        throw new Error(
          `status says the adopted Vector binary changed: ${view.vector_binary}`,
        );
      const doctor = run(
        defaults.agent,
        ["doctor", "--state-dir", defaults.stateDir, "--json"],
        { elevated: true, allowFailure: true },
      );
      const report = JSON.parse(doctor.stdout || "{}");
      evidence.observe("doctor", report.checks);
      if (doctor.code !== 0 || report.ok !== true)
        throw new Error(
          `vectory doctor reports a failure (exit ${doctor.code}).`,
        );
    },
  );

  await evidence.step(
    "The device is online in the API under the service manager the agent reports",
    async () => {
      const device = await until(
        `${deviceName} has checked in with service_manager ${adapter.kind}`,
        async () => {
          const row = await api(`/devices/${context.deviceId}`);
          return (
            checkedIn(row, Date.now() - 120000) &&
            row.service_manager === adapter.kind &&
            row
          );
        },
        {
          timeoutMs: 120000,
          describe: async () =>
            JSON.stringify(await api(`/devices/${context.deviceId}`), null, 2),
        },
      );
      const detail = device;
      evidence.observe("device", {
        id: detail.id,
        name: detail.name,
        status: detail.status,
        os: detail.os,
        arch: detail.arch,
        service_manager: detail.service_manager,
        state_dir: detail.state_dir,
        agent_sha256: detail.agent_sha256,
        configuration_mode: detail.configuration_mode,
        last_seen: device.last_seen,
      });
      if (detail.state_dir && detail.state_dir !== defaults.stateDir)
        throw new Error(
          `The API shows state_dir ${detail.state_dir}, not ${defaults.stateDir}.`,
        );
      if (detail.agent_sha256 && detail.agent_sha256 !== download.source.sha256)
        throw new Error(
          `The API shows agent_sha256 ${detail.agent_sha256}, not the installed ${download.source.sha256}.`,
        );
      if (detail.configuration_mode !== "restricted")
        throw new Error(
          `The device runs in ${detail.configuration_mode} mode; setup's default is restricted.`,
        );
    },
  );
}

/** The properties the documentation promises about each manager's registration. */
async function registration(context, adapter, evidence) {
  if (adapter.kind === "systemd") {
    const properties = adapter.show([
      "LoadState",
      "ActiveState",
      "SubState",
      "MainPID",
      "UnitFileState",
      "FragmentPath",
      "User",
      "Group",
      "Restart",
      "RestartUSec",
      "KillMode",
      "TimeoutStopUSec",
      "NoNewPrivileges",
      "PrivateTmp",
      "ProtectSystem",
      "ProtectHome",
      "UMask",
      "ReadWritePaths",
      "ExecStart",
      "Result",
      "NRestarts",
      "ControlGroup",
    ]);
    evidence.observe("systemd_properties", properties);
    expectProperties(
      properties,
      {
        LoadState: "loaded",
        ActiveState: "active",
        SubState: "running",
        UnitFileState: "enabled",
        FragmentPath: "/etc/systemd/system/vectory.service",
        User: "vectory",
        Restart: "on-failure",
        KillMode: "mixed",
        TimeoutStopUSec: (value) => parseDuration(value) === STOP_LIMIT_SECONDS,
        NoNewPrivileges: "yes",
        PrivateTmp: "yes",
        ProtectSystem: "full",
        ProtectHome: "read-only",
        UMask: "0077",
        MainPID: (value) => Number(value) > 1,
        ExecStart: (value) =>
          value.includes(
            `argv[]=${context.agent} run --state-dir ${context.stateDir}`,
          ),
        ReadWritePaths: (value) =>
          value.includes(context.stateDir) &&
          value.includes(path.dirname(context.managedConfig)),
      },
      "The generated unit",
    );
    const owner = run("ps", ["-o", "user=", "-p", properties.MainPID], {
      quiet: true,
    }).stdout.trim();
    if (owner !== "vectory")
      throw new Error(
        `The agent (pid ${properties.MainPID}) runs as ${owner}, not vectory.`,
      );
    const journal = adapter.journal();
    const lines = journal
      .split("\n")
      .filter((line) => /^\d{4}-\d\d-\d\dT/.test(line));
    evidence.observe("journal_lines", lines.length);
    if (!lines.length)
      throw new Error(
        `journalctl -u vectory.service shows no lines:\n${journal}`,
      );
    if (!journal.includes("Vectory agent"))
      throw new Error(
        `The journal has ${lines.length} lines but not the agent's start line ("Vectory agent ..."):\n${lines.slice(-20).join("\n")}`,
      );
  } else if (adapter.kind === "launchd") {
    const plistText = run("cat", [adapter.plist], { elevated: true }).stdout;
    const mode = run("stat", [
      "-f",
      "%Lp %Su:%Sg",
      adapter.plist,
    ]).stdout.trim();
    evidence.observe("plist", { path: adapter.plist, mode, text: plistText });
    const missing = [
      `<key>Label</key><string>io.vectory.agent</string>`,
      `<key>UserName</key><string>${adapter.account}</string>`,
      `<string>${context.agent}</string>`,
      `<string>${context.stateDir}</string>`,
      `<key>KeepAlive</key><true/>`,
    ].filter((fragment) => !plistText.includes(fragment));
    if (missing.length)
      throw new Error(
        `The launch daemon definition lacks:\n  ${missing.join("\n  ")}\n${plistText}`,
      );
    if (mode !== "644 root:wheel")
      throw new Error(`${adapter.plist} is ${mode}, not 644 root:wheel.`);
    const state = adapter.state();
    evidence.observe("launchctl_print", state.raw);
    if (!state.running)
      throw new Error(
        `launchd does not report the daemon running:\n${state.raw}`,
      );
    const owner = run("ps", ["-o", "user=", "-p", String(state.pid)], {
      quiet: true,
    }).stdout.trim();
    if (owner !== adapter.account)
      throw new Error(
        `The agent (pid ${state.pid}) runs as ${owner}, not ${adapter.account}.`,
      );
  } else {
    const configuration = run("sc.exe", ["qc", adapter.serviceName]).stdout;
    const failure = run("sc.exe", ["qfailure", adapter.serviceName]).stdout;
    evidence.observe("sc_qc", configuration);
    evidence.observe("sc_qfailure", failure);
    const problems = [];
    if (!/SERVICE_START_NAME\s*:\s*NT SERVICE\\Vectory/i.test(configuration))
      problems.push("the service does not run as NT SERVICE\\Vectory");
    if (!/START_TYPE\s*:\s*2\s+AUTO_START\s+\(DELAYED\)/i.test(configuration))
      problems.push("the service is not set to start automatically, delayed");
    if (
      !configuration.includes(context.agent) ||
      !configuration.includes("service --state-dir") ||
      !configuration.includes(context.stateDir)
    )
      problems.push(
        `its command line is not ${context.agent} service --state-dir ${context.stateDir}`,
      );
    if (!/RESTART\s+--\s+Delay\s+=\s+5000 milliseconds/i.test(failure))
      problems.push("its recovery actions do not restart after 5 seconds");
    if (problems.length)
      throw new Error(
        `The service registration differs from the documentation:\n  ${problems.join("\n  ")}\n${configuration}\n${failure}`,
      );
  }
}

// ---- apply ------------------------------------------------------------

async function apply(evidence) {
  const context = readContext();
  const adapter = adapterFor(context);
  const output = path.join(outputRoot, `native-workflow-${label}`);
  await evidence.step(
    `tests/native-workflow.mjs against ${context.deviceName} (${label})`,
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
      if (result.status !== 0)
        throw new Error(
          `tests/native-workflow.mjs exited ${result.status ?? result.signal}.`,
        );
    },
  );
  await evidence.step(
    "Its evidence says the workflow passed against the service",
    () => {
      const report = JSON.parse(
        fs.readFileSync(path.join(output, "native-workflow.json"), "utf8"),
      );
      evidence.observe("native_workflow", report);
      if (report.result !== "passed" || report.agent_mode !== "service")
        throw new Error(`Unexpected report: ${JSON.stringify(report)}`);
    },
  );
  await evidence.softStep(
    "The service still runs, and so does one Vector under the service account",
    async () => {
      if (!adapter.state().running)
        throw new Error(`The service stopped:\n${adapter.describe()}`);
      // The agent may be restarting Vector (Windows always does when it applies a change).
      const { vectors } = await until(
        "one supervisor and one Vector run",
        () => {
          const found = agentProcesses();
          return (
            found.vectors.length === 1 &&
            found.supervisors.length === 1 &&
            found
          );
        },
        { timeoutMs: 60000, describe: describeProcesses },
      );
      evidence.observe("vector_processes", vectors);
      const owner = vectors[0].user.replace(/\+$/, "");
      if (owner && !adapter.account.startsWith(owner))
        throw new Error(
          `Vector (pid ${vectors[0].pid}) runs as ${vectors[0].user}, not ${adapter.account}.`,
        );
    },
  );
}

// ---- lifecycle --------------------------------------------------------

async function lifecycle(evidence) {
  const context = readContext();
  const { api } = await connect();
  const { adapter, device, settled } = bind(context, api);

  const before = await evidence.step(
    "A pipeline from the apply phase is running under the service",
    async () => {
      // The server's record is the baseline; the agent's own status, where an
      // administrator can read it, must agree.
      const row = await device();
      if (row.apply_state !== "verified_applied" || !row.actual_sha256)
        throw new Error(
          `No pipeline is verified on the device:\n${JSON.stringify(row)}`,
        );
      const view = tryStatus(context);
      evidence.observe("status_readable", Boolean(view));
      if (view && view.state?.last_good_sha256 !== row.actual_sha256)
        throw new Error(
          `The server reports ${row.actual_sha256} but the agent's last known good is ${view.state?.last_good_sha256}.`,
        );
      if (!adapter.state().running)
        throw new Error(`The service is not running:\n${adapter.describe()}`);
      await until(
        "one supervisor and one Vector run",
        () => {
          const found = agentProcesses();
          return found.vectors.length === 1 && found.supervisors.length === 1;
        },
        { timeoutMs: 60000, describe: describeProcesses },
      );
      return { lastGood: row.actual_sha256 };
    },
  );
  const lastGood = before.lastGood;

  await evidence.step(
    "Restart: the device returns online, Vector runs, the last known good is intact",
    async () => {
      const earlier = adapter.state();
      const oldVectors = agentProcesses().vectors.map((row) => row.pid);
      const began = Date.now();
      const command = adapter.restart();
      const now = await until(
        "a new agent process runs",
        () => {
          const state = adapter.state();
          return state.running && state.pid !== earlier.pid && state;
        },
        { timeoutMs: 180000, describe: () => adapter.describe() },
      );
      await settled("after the restart", began, { lastGood, oldVectors });
      evidence.observe("restart", {
        command,
        old_pid: earlier.pid,
        new_pid: now.pid,
        seconds: (Date.now() - began) / 1000,
      });
    },
  );

  await evidence.step(
    "Kill the agent: the manager restarts it and no Vector is orphaned",
    async () => {
      const earlier = adapter.state();
      const oldVectors = agentProcesses().vectors.map((row) => row.pid);
      const began = Date.now();
      const command = adapter.crash(earlier.pid);
      const now = await until(
        "the manager starts a new agent process",
        () => {
          const state = adapter.state();
          return state.running && state.pid !== earlier.pid && state;
        },
        { timeoutMs: 180000, describe: () => adapter.describe() },
      );
      if (adapter.kind === "systemd" && now.restarts < 1)
        throw new Error(
          `systemd restarted it, but NRestarts is ${now.restarts}: ${now.summary}`,
        );
      await settled("after the kill", began, { lastGood, oldVectors });
      evidence.observe("crash", {
        command,
        old_pid: earlier.pid,
        new_pid: now.pid,
        restarts: now.restarts,
        seconds: (Date.now() - began) / 1000,
      });
    },
  );

  await evidence.step(
    "Stop: Vector drains and is gone within the stop limit, nothing is left behind",
    async () => {
      const oldVectors = agentProcesses().vectors.map((row) => row.pid);
      const began = Date.now();
      const command = adapter.stop();
      const took = (Date.now() - began) / 1000;
      if (took >= STOP_LIMIT_SECONDS)
        throw new Error(
          `Stopping took ${took} s, not under ${STOP_LIMIT_SECONDS} s.`,
        );
      await until(
        "the manager reports the service stopped",
        () => !adapter.state().running,
        { timeoutMs: 30000, describe: () => adapter.describe() },
      );
      await until(
        "no supervisor or Vector remains",
        () => {
          const { vectors, supervisors } = agentProcesses();
          return vectors.length === 0 && supervisors.length === 0;
        },
        { timeoutMs: 60000, describe: describeProcesses },
      );
      const view = tryStatus(context);
      if (view?.agent_running)
        throw new Error(
          "vectory status still says the agent runs after the service stopped.",
        );
      if (view && view.state?.last_good_sha256 !== lastGood)
        throw new Error("The last known good changed while stopping.");
      const facts = {
        status_readable: Boolean(view),
        command,
        seconds: took,
        old_vectors: oldVectors,
        manager: adapter.state().summary,
      };
      if (adapter.kind === "systemd") {
        const result = adapter.show(["Result", "ExecMainStatus"]);
        const journal = adapter.journal(
          `${new Date(began - 2000).toISOString().replace("T", " ").slice(0, 19)} UTC`,
        );
        facts.result = result.Result;
        facts.exit_status = result.ExecMainStatus;
        if (result.Result !== "success")
          throw new Error(
            `systemd records the stop as ${result.Result}, not success.`,
          );
        if (journal.includes("Drain limit reached"))
          throw new Error(
            `Vector was terminated before it finished draining:\n${journal}`,
          );
      }
      evidence.observe("stop", facts);
    },
  );

  await evidence.step(
    "Start again: the device returns online with the last known good",
    async () => {
      const began = Date.now();
      const command = adapter.start();
      await until(
        "the manager reports the service running",
        () => adapter.state().running,
        { timeoutMs: 120000, describe: () => adapter.describe() },
      );
      await settled("after the start", began, { lastGood });
      evidence.observe("start", {
        command,
        seconds: (Date.now() - began) / 1000,
      });
    },
  );
}

// ---- uninstall --------------------------------------------------------

async function uninstall(evidence) {
  const context = readContext();
  const adapter = adapterFor(context);
  await evidence.step("service-uninstall removes the registration", () => {
    // Windows refuses to remove a running service; the other managers stop it.
    if (windows) adapter.stop();
    run(context.agent, ["service-uninstall"], {
      elevated: true,
      timeoutMs: 400000,
    });
    if (!adapter.unregistered())
      throw new Error(
        `The manager still knows the service:\n${adapter.describe()}`,
      );
    evidence.observe("registration_after", adapter.artifacts());
  });
  await evidence.step("Nothing the agent started is left running", async () => {
    await until(
      "no supervisor or Vector remains",
      () => {
        const { vectors, supervisors } = agentProcesses();
        return vectors.length === 0 && supervisors.length === 0;
      },
      { timeoutMs: 60000, describe: describeProcesses },
    );
  });
  await evidence.step(
    "The state, the identity, the managed configuration and the agent are kept",
    () => {
      const view = tryStatus(context);
      evidence.observe(
        "status_after",
        view && {
          service: view.service,
          agent_running: view.agent_running,
          device: view.device,
        },
      );
      if (view) {
        if (view.device?.name !== context.deviceName)
          throw new Error(
            `The identity is gone: ${JSON.stringify(view.device)}`,
          );
        if (view.service?.installed)
          throw new Error(
            `status still shows an installed service: ${JSON.stringify(view.service)}`,
          );
      }
      const listing = run(
        windows ? "cmd.exe" : "ls",
        windows
          ? ["/c", "dir", "/b", context.stateDir]
          : ["-1", context.stateDir],
        { elevated: true, quiet: true },
      );
      const files = listing.stdout.split(/\r?\n/).filter(Boolean);
      evidence.observe("state_files", files);
      for (const name of ["settings.json", "state.json"])
        if (!files.includes(name))
          throw new Error(
            `${name} is gone from ${context.stateDir}: ${files.join(", ")}`,
          );
      const managed = windows
        ? { code: fs.existsSync(context.managedConfig) ? 0 : 1 }
        : run("test", ["-f", context.managedConfig], {
            elevated: true,
            allowFailure: true,
            quiet: true,
          });
      if (managed.code !== 0)
        throw new Error(`${context.managedConfig} was removed.`);
      if (!fs.existsSync(context.agent))
        throw new Error(`${context.agent} was removed.`);
    },
  );
}

// ---- stop-foreground --------------------------------------------------

async function stopForeground(evidence) {
  await evidence.step(
    "Stop the detached agent that tests/native-workflow.mjs left running",
    async () => {
      const file = path.join(previewDir, "native-run.json");
      if (!fs.existsSync(file)) {
        console.log("  No detached agent was started.");
        return;
      }
      const { pid } = JSON.parse(fs.readFileSync(file, "utf8"));
      const isAlive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error.code === "EPERM";
        }
      };
      if (isAlive()) {
        if (windows)
          run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            allowFailure: true,
          });
        else process.kill(pid, "SIGTERM");
        await until(`agent ${pid} has exited`, () => !isAlive(), {
          timeoutMs: 120000,
        });
      }
      // The pid could be reused later: the next phase must not mistake it for the agent.
      fs.renameSync(file, `${file}.stopped`);
      await until(
        "no supervisor or Vector remains",
        () => {
          const { vectors, supervisors } = agentProcesses();
          return vectors.length === 0 && supervisors.length === 0;
        },
        { timeoutMs: 120000, describe: describeProcesses },
      );
    },
  );
}

// ---- collect ----------------------------------------------------------

async function collect(evidence) {
  const directory = path.join(outputRoot, "logs");
  fs.mkdirSync(directory, { recursive: true });
  const attempt = (name, body) => {
    try {
      body();
    } catch (error) {
      console.log(`  could not collect ${name}: ${error.message}`);
    }
  };
  let context = null;
  attempt("the context", () => {
    context = readContext();
  });
  const adapter = adapterFor(context ?? { agent: defaults.agent });
  const agent = context?.agent ?? defaults.agent;
  const stateDir = context?.stateDir ?? defaults.stateDir;
  await evidence.step(
    "Collect the manager's view, the agent's status and Vector's log",
    () => {
      attempt("the manager's view", () => adapter.collect(directory));
      // status and logs are secret-free by design; the state directory itself holds the private key and is never copied.
      attempt("vectory status", () =>
        fs.writeFileSync(
          path.join(directory, "status.json"),
          run(agent, ["status", "--state-dir", stateDir, "--json"], {
            elevated: true,
            allowFailure: true,
            quiet: true,
          }).text,
        ),
      );
      attempt("vectory doctor", () =>
        fs.writeFileSync(
          path.join(directory, "doctor.json"),
          run(agent, ["doctor", "--state-dir", stateDir, "--json"], {
            elevated: true,
            allowFailure: true,
            quiet: true,
          }).text,
        ),
      );
      attempt("vectory logs", () =>
        fs.writeFileSync(
          path.join(directory, "vector-log.txt"),
          run(agent, ["logs", "--state-dir", stateDir, "--lines", "400"], {
            elevated: true,
            allowFailure: true,
            quiet: true,
          }).text,
        ),
      );
      attempt("the processes", () =>
        fs.writeFileSync(
          path.join(directory, "agent-processes.txt"),
          describeProcesses(),
        ),
      );
      if (fs.existsSync(contextFile))
        fs.copyFileSync(contextFile, path.join(directory, "context.json"));
    },
  );
}

const phases = {
  install,
  apply,
  lifecycle,
  uninstall,
  "stop-foreground": stopForeground,
  collect,
};
if (!phases[phase]) {
  console.error(
    `Usage: node tests/platform/service.mjs <${Object.keys(phases).join("|")}> [label]`,
  );
  process.exit(2);
}
await main(phase === "apply" ? `apply-${label}` : phase, (evidence) =>
  phases[phase](evidence),
);
// Collecting logs must never fail the job that already has its own verdict.
if (phase === "collect") process.exitCode = 0;
