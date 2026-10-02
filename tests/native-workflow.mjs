import fs from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { agentPort, connect, downloadAgent, previewDir } from "./platform/instance.mjs";
import { windows, windowsPowerShellEnv } from "./platform/lib.mjs";
// The clean-install workflow against a running preview (scripts/preview.sh):
// first administrator (on a fresh instance), agent download from the release
// listing with its SHA-256, install, enroll, publish, assign, apply, drift,
// pause, metrics and a device-local secret. VECTORY_AGENT_BIN skips the
// download; VECTORY_NATIVE_WORKFLOW_OUTPUT picks the report folder.
//
// VECTORY_NATIVE_AGENT_MODE=service runs the same publish, assign, apply,
// drift, pause and resume steps against a device whose agent an operating
// system service keeps running (tests/platform/service.mjs installs it and
// starts this script). It enrolls, installs and starts nothing itself, so it
// also skips the steps that need the agent stopped: metrics and secrets.
// It needs VECTORY_NATIVE_DEVICE_NAME (the enrolled device), VECTORY_NATIVE_STATE_DIR
// and VECTORY_NATIVE_MANAGED_CONFIG (the service's folders) and VECTORY_AGENT_BIN
// (the installed agent). On Linux and macOS it reads and writes those folders,
// which belong to the service account, and runs the agent's commands, through
// sudo unless it runs as root.
const root = path.resolve(import.meta.dirname, ".."),
  local = previewDir,
  output = path.resolve(
    root,
    process.env.VECTORY_NATIVE_WORKFLOW_OUTPUT || "docs/evidence",
  ),
  mode = process.env.VECTORY_NATIVE_AGENT_MODE || "foreground",
  service = mode === "service";
if (!["foreground", "service"].includes(mode))
  throw Error(`VECTORY_NATIVE_AGENT_MODE must be foreground or service, not ${mode}.`);
const serviceSetting = (name) => {
  if (!process.env[name]) throw Error(`Service mode needs ${name}.`);
  return process.env[name];
};
const priorRun = await fs
  .readFile(path.join(local, "native-run.json"), "utf8")
  .then(JSON.parse)
  .catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
if (priorRun) {
  let running = false;
  try {
    process.kill(priorRun.pid, 0);
    running = true;
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  if (running)
    throw Error(
      "A prior synthetic fixture PID is still running. Verify its executable and state path, then stop it before repeating this test.",
    );
}
const { api, cookie, bootstrapped } = await connect();
const runId = Date.now().toString(36),
  agentRoot = path.join(root, ".local", `native workflow ${runId}`),
  state = service
    ? serviceSetting("VECTORY_NATIVE_STATE_DIR")
    : path.join(agentRoot, "state"),
  managed = service
    ? serviceSetting("VECTORY_NATIVE_MANAGED_CONFIG")
    : path.join(agentRoot, "config", "managed.json"),
  dataDir = path.join(agentRoot, "vector-data");
// A service's host picks Vector's data directory, so its pipeline sets none.
const config = {
  ...(service ? {} : { data_dir: dataDir }),
  sources: { demo: { type: "demo_logs", format: "json", interval: 1 } },
  transforms: {
    enrich: {
      type: "remap",
      inputs: ["demo"],
      source: '.environment = "local-verification"\n.managed_by = "vectory"',
    },
  },
  sinks: {
    output: {
      type: "console",
      inputs: ["enrich"],
      encoding: { codec: "json" },
      target: "stderr",
    },
  },
};
const policyPath = path.join(agentRoot, "capabilities.json");
if (!service) {
  await fs.mkdir(path.dirname(managed), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(managed, JSON.stringify(config, null, 2));
  await fs.writeFile(
    policyPath,
    JSON.stringify({ allowed_file_roots: [dataDir] }),
  );
}
function officialVector() {
  if (process.env.VECTORY_VECTOR_BIN) return process.env.VECTORY_VECTOR_BIN;
  if (windows) return path.join(root, ".local/tools/vector-0.58.0/bin/vector.exe");
  const tools = path.join(root, ".local/tools");
  const found = existsSync(tools)
    ? readdirSync(tools)
        .map((entry) => path.join(tools, entry, "bin", "vector"))
        .find((candidate) => existsSync(candidate))
    : undefined;
  if (!found)
    throw Error("Place the verified official Vector 0.58.0 build under .local/tools or set VECTORY_VECTOR_BIN");
  return found;
}
const agent = service
    ? { file: path.resolve(serviceSetting("VECTORY_AGENT_BIN")), source: { kind: "installed service agent" } }
    : process.env.VECTORY_AGENT_BIN
      ? { file: path.resolve(process.env.VECTORY_AGENT_BIN), source: { kind: "VECTORY_AGENT_BIN" } }
      : await downloadAgent({ api, cookie, directory: path.join(agentRoot, "bin") }),
  binary = agent.file,
  vector = service ? null : officialVector();
const binaryDigest = crypto
  .createHash("sha256")
  .update(await fs.readFile(binary))
  .digest("hex");
// A service's folders belong to its account: an unprivileged runner on Linux
// and macOS reaches them, and the agent's commands, through sudo.
const sudo = service && !windows && process.getuid() !== 0;
async function cli(args, input) {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = sudo
      ? spawn("sudo", ["-n", binary, ...args], { stdio: ["pipe", "pipe", "pipe"] })
      : spawn(binary, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(Error(`Agent ${args[0]} exited ${code}: ${output}`)),
    );
    child.stdin.end(input || "");
  });
}
async function readManaged() {
  if (!sudo) return fs.readFile(managed);
  return new Promise((resolve, reject) =>
    execFile("sudo", ["-n", "cat", managed], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
}
async function writeManaged(text) {
  if (!sudo) return fs.writeFile(managed, text);
  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-n", "tee", managed], { stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(Error(`sudo tee ${managed} exited ${code}`))));
    child.stdin.end(text);
  });
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const metricsPort = service
  ? null
  : await new Promise((resolve) => {
      const listener = net.createServer().listen(0, "127.0.0.1", () => {
        const p = listener.address().port;
        listener.close(() => resolve(p));
      });
    });
const received = new Set();
const receiver = service
  ? null
  : http.createServer((req, res) => {
      if (req.method === "POST") received.add(req.headers.authorization);
      req.resume();
      req.on("end", () => res.end());
    });
if (receiver) {
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiver.unref();
}
const sinkPort = receiver?.address().port;
const secretFile = path.join(state, "synthetic-http-token"),
  bindings = path.join(agentRoot, "secret-bindings.json"),
  firstSecret = crypto.randomBytes(24).toString("base64url"),
  secondSecret = crypto.randomBytes(24).toString("base64url");
let daemon,
  keepPreview = false;
const createdDeployments = [];
try {
  let device;
  if (service) {
    const name = serviceSetting("VECTORY_NATIVE_DEVICE_NAME");
    device = (await api("/devices")).find((d) => d.name === name);
    if (!device)
      throw Error(`The instance lists no device named ${name}. Install and enroll its service first.`);
    console.log(`PASS ${name} is enrolled and an operating-system service keeps its agent running.`);
  } else {
    config.sources.metrics = {
      type: "internal_metrics",
      scrape_interval_secs: 1,
    };
    config.sinks.metrics_out = {
      type: "prometheus_exporter",
      inputs: ["metrics"],
      address: `127.0.0.1:${metricsPort}`,
    };
    await fs.writeFile(managed, JSON.stringify(config, null, 2));
    await fs.writeFile(
      policyPath,
      JSON.stringify({
        allowed_file_roots: [dataDir],
        allowed_listen_addresses: [`127.0.0.1:${metricsPort}`],
        allowed_network_hosts: [`127.0.0.1:${sinkPort}`],
      }),
    );
    await cli([
      "install",
      "--state-dir",
      state,
      "--vector-binary",
      vector,
      "--managed-config",
      managed,
      "--capability-policy",
      policyPath,
      "--metrics-url",
      `http://127.0.0.1:${metricsPort}/metrics`,
      "--adopt",
      "--json",
    ]);
    await fs.writeFile(secretFile, firstSecret, { mode: 0o600 });
    await fs.writeFile(bindings, JSON.stringify({ API_TOKEN: secretFile }));
    if (windows) await new Promise((resolve, reject) => {
      const p = spawn(
        "powershell",
        [
          "-NoProfile",
          "-File",
          path.join(root, "tests/protect-fixture.ps1"),
          "-Path",
          secretFile,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: windowsPowerShellEnv(),
        },
      );
      let said = "";
      p.stdout.on("data", (chunk) => (said += chunk));
      p.stderr.on("data", (chunk) => (said += chunk));
      p.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              Error(
                `Fixture secret ACL setup failed (${code}): ${said.trim().slice(0, 800)}`,
              ),
            ),
      );
      p.on("error", reject);
    });
    await cli([
      "configure-secrets",
      "--state-dir",
      state,
      "--secret-files",
      bindings,
    ]);
    console.log(
      "PASS native install/adoption in isolated path containing spaces.",
    );
    const token = await api("/tokens", {
      name: `Native verification ${runId}`,
      expires_hours: 1,
      max_uses: 1,
      name_prefix: `local-${process.platform}-`,
    });
    await cli(
      [
        "enroll",
        "--state-dir",
        state,
        "--server",
        `https://localhost:${agentPort}`,
        "--ca-file",
        path.join(root, ".local/pki/ca.pem"),
        "--id",
        `local-${process.platform}-${runId}`,
        "--token-stdin",
        "--json",
      ],
      token.token + "\n",
    );
    device = (await api("/devices")).find(
      (d) => d.name === `local-${process.platform}-${runId}`,
    );
    if (!device) throw Error("Enrollment not visible in authenticated fleet");
    console.log("PASS trusted TLS enrollment -> real device in SQLite.");
  }
  const configuration = await api("/configurations", {
    name: `Synthetic ${process.platform} pipeline ${runId}`,
    description:
      "Real native integration fixture. Synthetic events only; console output is discarded locally.",
    config,
    graph: { nodes: [], edges: [] },
  });
  const version = await api(`/configurations/${configuration.id}/publish`, {
    revision: configuration.revision,
    message: "Native end-to-end verification",
  });
  const selector = { device_ids: [device.id], group_ids: [], exclude_ids: [] },
    rollout = {
      kind: "all",
      canary_size: 1,
      batch_size: 10,
      observation_seconds: 2,
      failure_threshold: 0,
    };
  createdDeployments.push(
    (
      await api("/deployments", {
        policy: {
          heartbeat_seconds: 10,
          sync_paused: false,
          telemetry_enabled: true,
        },
        selector,
        priority: 100,
        target_mode: "snapshot",
        rollout,
      })
    ).id,
  );
  const preview = await api("/deployments/preview", {
    version_id: version.id,
    selector,
    priority: 100,
    target_mode: "snapshot",
    rollout,
  });
  if (preview.conflicts?.length) throw Error("Unexpected conflict");
  const deployment = await api("/deployments", {
    version_id: version.id,
    selector,
    priority: 100,
    target_mode: "snapshot",
    rollout,
  });
  createdDeployments.push(deployment.id);
  if (!service) {
    const out = openSync(path.join(agentRoot, "agent.log"), "a"),
      err = openSync(path.join(agentRoot, "agent-error.log"), "a");
    daemon = spawn(binary, ["run", "--state-dir", state, "--json"], {
      windowsHide: true,
      detached: true,
      stdio: ["ignore", out, err],
    });
    daemon.unref();
    closeSync(out);
    closeSync(err);
    await fs.writeFile(
      path.join(local, "native-run.json"),
      JSON.stringify(
        {
          pid: daemon.pid,
          binary,
          device_id: device.id,
          configuration_id: configuration.id,
          version_id: version.id,
          deployment_id: deployment.id,
          state,
          managed,
          agentRoot,
        },
        null,
        2,
      ),
    );
  }
  async function until(label, predicate, timeout = 70000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const d = await api(`/devices/${device.id}`);
      if (await predicate(d)) {
        console.log(
          `PASS ${label} (${((Date.now() - start) / 1000).toFixed(1)}s)`,
        );
        return d;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const d = await api(`/devices/${device.id}`);
    throw Error(`${label} timed out: ${JSON.stringify(d)}`);
  }
  const verified = await until(
    "publish -> assign -> mTLS heartbeat -> fetch -> actual Vector validation/activation -> acknowledged verified",
    (d) =>
      d.apply_state === "verified_applied" &&
      d.reported_generation === d.desired_generation,
  );
  // On Windows the service writes its files for itself and SYSTEM only: an
  // administrator may be unable to read the managed file, and the steps that
  // edit it are then skipped and said so. The agent's own report of the file's
  // digest (actual_sha256) still proves what is in it.
  const skipped = [];
  let managedAccess = true;
  if (service && windows)
    await readManaged().catch((error) => {
      if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
      managedAccess = false;
      console.log(
        `SKIP editing the managed file: ${managed} belongs to the service account and ${error.code} refuses this administrator.`,
      );
      skipped.push("reading and editing the managed file (drift repair and edits while paused): the service account owns it");
    });
  if (managedAccess) {
    if (sha256(await readManaged()) !== version.sha256)
      throw Error("Managed bytes do not match exact artifact digest");
  } else if (verified.actual_sha256 !== version.sha256)
    throw Error(`The agent reports the managed file as ${verified.actual_sha256}, not the published ${version.sha256}`);
  console.log("PASS managed content matches immutable published SHA-256.");
  const drift = structuredClone(config);
  drift.transforms.enrich.source = '.environment = "manually-edited"';
  if (managedAccess) {
    await writeManaged(JSON.stringify(drift));
    await until(
      "same-generation actual-file drift detected and repaired",
      async (d) =>
        d.actual_sha256 === version.sha256 &&
        d.apply_state === "verified_applied" &&
        sha256(await readManaged()) === version.sha256,
      35000,
    );
    if (sha256(await readManaged()) !== version.sha256)
      throw Error("Drift was not actually repaired");
  }
  await cli(["pause", "--state-dir", state, "--json"]);
  await until(
    "local emergency pause reported without losing verified state",
    (d) =>
      d.local_paused === true &&
      d.status === "paused" &&
      d.apply_state === "verified_applied",
    35000,
  );
  if (managedAccess) {
    await writeManaged(JSON.stringify(drift));
    await new Promise((r) => setTimeout(r, 13000));
    if (sha256(await readManaged()) === version.sha256)
      throw Error("Paused drift was overwritten");
    console.log("PASS paused manual edits preserved while heartbeats continue.");
  }
  await cli(["resume", "--state-dir", state, "--json"]);
  await until(
    "resume repairs latest desired artifact",
    (d) =>
      d.actual_sha256 === version.sha256 &&
      d.apply_state === "verified_applied",
    40000,
  );
  if (!service) {
    const metricDevice = await until(
      "actual Vector operational metrics reach the dashboard API",
      (d) =>
        d.telemetry?.events_per_second > 0 && d.telemetry?.components?.length > 0,
      40000,
    );
    const secretConfig = structuredClone(config);
    secretConfig.sinks.output = {
      type: "http",
      inputs: ["enrich"],
      uri: `http://127.0.0.1:${sinkPort}/events`,
      encoding: { codec: "json" },
      batch: { timeout_secs: 0.1 },
      auth: { strategy: "bearer", token: "vectory-secret:API_TOKEN" },
    };
    const secretDoc = await api("/configurations", {
        name: `Local secret verification ${runId}`,
        description:
          "Synthetic loopback HTTP only; secret value remains on the host.",
        config: secretConfig,
        graph: { nodes: [], edges: [] },
      }),
      secretVersion = await api(`/configurations/${secretDoc.id}/publish`, {
        revision: secretDoc.revision,
        message: "Device-local reference verification",
      });
    const secretDeployment = await api("/deployments", {
      version_id: secretVersion.id,
      selector,
      priority: 200,
      target_mode: "snapshot",
      rollout,
    });
    createdDeployments.push(secretDeployment.id);
    const firstApplied = await until(
      "real signed secret template activates with separate effective hash",
      (d) =>
        d.apply_state === "verified_applied" &&
        d.reported_generation === d.desired_generation &&
        d.applied_template_sha256 === secretVersion.sha256 &&
        d.actual_sha256 !== secretVersion.sha256 &&
        received.has("Bearer " + firstSecret),
    );
    await fs.writeFile(secretFile, secondSecret);
    const secondApplied = await until(
      "same-generation secret rotation reaches actual receiver and control plane",
      (d) =>
        d.apply_state === "verified_applied" &&
        d.reported_generation === d.desired_generation &&
        d.reported_generation === firstApplied.reported_generation &&
        d.applied_template_sha256 === secretVersion.sha256 &&
        d.secret_revision > firstApplied.secret_revision &&
        d.actual_sha256 !== firstApplied.actual_sha256 &&
        received.has("Bearer " + secondSecret),
    );
    for (const endpoint of [
      "/configurations",
      "/audit",
      "/issues",
      `/versions/${secretVersion.id}`,
      `/devices/${device.id}`,
    ]) {
      const body = JSON.stringify(await api(endpoint));
      if (body.includes(firstSecret) || body.includes(secondSecret))
        throw Error("Local secret appeared in server response");
    }
    const removalReview = await api(`/deployments/${secretDeployment.id}/unassign-preview`, {});
    await api(`/deployments/${secretDeployment.id}/unassign`, { review_token: removalReview.review_token });
    await until(
      "remove secret assignment restores the original console pipeline",
      (d) =>
        d.apply_state === "verified_applied" &&
        d.actual_sha256 === version.sha256,
    );
    await new Promise((resolve) => receiver.close(resolve));
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, "native-secret-telemetry.json"),
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          result: "passed",
          agent_binary_sha256: binaryDigest,
          same_generation_rotation: true,
          template_digest_unchanged: true,
          effective_digest_changed: true,
          secret_revision: secondApplied.secret_revision,
          receiver_observed_both_values: true,
          no_secret_in_server_responses: true,
          component_count: metricDevice.telemetry.components.length,
          actual_events_per_second: metricDevice.telemetry.events_per_second,
          scope:
            `Real Rust TLS API + Go agent + pinned ${process.platform} Vector + explicit loopback synthetic receiver/exporter.`,
        },
        null,
        2,
      ),
    );
  }
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(
    path.join(output, "native-workflow.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        vector: "0.58.0",
        agent_binary_sha256: binaryDigest,
        agent_source: agent.source,
        agent_mode: mode,
        skipped,
        first_administrator_bootstrapped: bootstrapped,
        result: "passed",
        checks: [
          ...(bootstrapped ? ["first administrator from the one-time bootstrap secret"] : []),
          ...(agent.source.kind === "release listing"
            ? ["agent downloaded from the server's release listing, SHA-256 and size verified"]
            : []),
          ...(service
            ? ["the agent runs as an operating-system service under its own account"]
            : ["native install and explicit adoption", "verified TLS/CSR enrollment"]),
          "dashboard control-plane CRUD and immutable publish",
          "preview and assignment",
          "mTLS signed desired state and authorized artifact fetch",
          "actual Vector validate/activation acknowledgment",
          "exact artifact SHA256",
          ...(managedAccess
            ? ["same-generation actual-file drift repair", "local pause preserves edits with heartbeats"]
            : ["local pause is reported by the device"]),
          "resume restores latest desired state",
        ],
        device_name: device.name,
        generation: verified.desired_generation,
      },
      null,
      2,
    ),
  );
  if (service)
    console.log(
      "PASS complete native control-plane workflow against the service. Its assignments are removed; the service keeps running.",
    );
  else {
    console.log(
      "PASS complete native control-plane workflow. Isolated demo agent remains running for the dashboard preview.",
    );
    keepPreview = true;
  }
} finally {
  if (!keepPreview) {
    if (daemon && daemon.exitCode === null) daemon.kill();
    for (const id of createdDeployments.reverse())
      await api(`/deployments/${id}/unassign-preview`, {})
        .then(review => api(`/deployments/${id}/unassign`, { review_token: review.review_token }))
        .catch(() => {});
  }
  receiver?.closeAllConnections();
  if (receiver?.listening)
    await new Promise((resolve) => receiver.close(resolve));
}
