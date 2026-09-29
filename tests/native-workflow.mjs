import fs from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
// The clean-install workflow against a running preview (scripts/preview.sh):
// first administrator (on a fresh instance), agent download from the release
// listing with its SHA-256, install, enroll, publish, assign, apply, drift,
// pause, metrics and a device-local secret. VECTORY_AGENT_BIN skips the
// download; VECTORY_NATIVE_WORKFLOW_OUTPUT picks the report folder.
const root = path.resolve(import.meta.dirname, ".."),
  local = process.env.VECTORY_PREVIEW_DIR || path.join(root, ".local/preview"),
  windows = process.platform === "win32",
  webPort = process.env.VECTORY_PREVIEW_WEB_PORT || "8080",
  agentPort = process.env.VECTORY_PREVIEW_AGENT_PORT || "8443",
  output = path.resolve(
    root,
    process.env.VECTORY_NATIVE_WORKFLOW_OUTPUT || "docs/evidence",
  );
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
const base = `http://127.0.0.1:${webPort}/api/v1`;
const credentialsPath = path.join(local, "credentials.json");
let credentials = await fs
  .readFile(credentialsPath, "utf8")
  .then(JSON.parse)
  .catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
// A fresh instance gets its first administrator from the preview's one-time
// bootstrap secret, as an operator's first visit does.
const bootstrapped = !(await fetch(`${base}/status`).then((r) => r.json()))
  .initialized;
if (bootstrapped) {
  credentials ??= {
    name: "Native workflow operator",
    email: "native-workflow@vectory.local",
    password: crypto.randomBytes(24).toString("base64url"),
  };
  await fs.writeFile(credentialsPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
  const bootstrap_secret = (
    await fs.readFile(path.join(local, "bootstrap.secret"), "utf8")
  ).trim();
  const setup = await fetch(`${base}/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, bootstrap_secret }),
  });
  if (!setup.ok) throw Error(`First administrator setup failed: HTTP ${setup.status}`);
  console.log("PASS first administrator created with the one-time bootstrap secret.");
} else if (!credentials)
  throw Error(`This preview is set up but ${credentialsPath} is missing. Use a fresh VECTORY_PREVIEW_DIR.`);
const login = await fetch(`${base}/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: credentials.email,
    password: credentials.password,
  }),
});
if (!login.ok) throw Error(`Login failed ${login.status}`);
const session = await login.json(),
  cookie = login.headers.get("set-cookie").split(";")[0];
async function api(endpoint, body, method = body ? "POST" : "GET") {
  const result = await fetch(base + endpoint, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrf_token,
      Cookie: cookie,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await result.json();
  if (!result.ok)
    throw Error(`${endpoint}: ${result.status} ${JSON.stringify(value)}`);
  return value;
}
const runId = Date.now().toString(36),
  agentRoot = path.join(root, ".local", `native workflow ${runId}`),
  state = path.join(agentRoot, "state"),
  managed = path.join(agentRoot, "config", "managed.json"),
  dataDir = path.join(agentRoot, "vector-data");
await fs.mkdir(path.dirname(managed), { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
const config = {
  data_dir: dataDir,
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
await fs.writeFile(managed, JSON.stringify(config, null, 2));
const policyPath = path.join(agentRoot, "capabilities.json");
await fs.writeFile(
  policyPath,
  JSON.stringify({ allowed_file_roots: [dataDir] }),
);
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
// The agent this host would install: its build from the server's release
// listing, downloaded as a signed-in user and checked against the listed
// SHA-256 and size before it is run.
async function downloadAgent() {
  const os = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform],
    arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  const release = (await api("/releases")).find(
    (r) => r.os === os && r.arch === arch,
  );
  if (!release)
    throw Error(
      `The server lists no agent build for ${os}/${arch}. Build one with python3 packaging/build-release.py, or set VECTORY_AGENT_BIN.`,
    );
  const response = await fetch(`http://127.0.0.1:${webPort}${release.url}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw Error(`Agent download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()),
    digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256 || bytes.length !== release.size)
    throw Error(
      `${release.name} does not match the release listing: got SHA-256 ${digest} and ${bytes.length} bytes, listed ${release.sha256} and ${release.size} bytes.`,
    );
  const file = path.join(agentRoot, "bin", windows ? "vectory.exe" : "vectory");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { mode: 0o755 });
  console.log(
    `PASS downloaded ${release.name} (${release.source} build, version ${release.version}) from the release listing; SHA-256 ${digest} matches.`,
  );
  return {
    file,
    source: { kind: "release listing", name: release.name, version: release.version, sha256: digest, size: bytes.length, origin: release.source },
  };
}
const agent = process.env.VECTORY_AGENT_BIN
    ? { file: path.resolve(process.env.VECTORY_AGENT_BIN), source: { kind: "VECTORY_AGENT_BIN" } }
    : await downloadAgent(),
  binary = agent.file,
  vector = officialVector();
const binaryDigest = crypto
  .createHash("sha256")
  .update(await fs.readFile(binary))
  .digest("hex");
async function cli(args, input) {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
const metricsPort = await new Promise((resolve) => {
  const listener = net.createServer().listen(0, "127.0.0.1", () => {
    const p = listener.address().port;
    listener.close(() => resolve(p));
  });
});
const received = new Set();
const receiver = http.createServer((req, res) => {
  if (req.method === "POST") received.add(req.headers.authorization);
  req.resume();
  req.on("end", () => res.end());
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
receiver.unref();
const sinkPort = receiver.address().port;
let daemon,
  keepPreview = false;
const createdDeployments = [];
try {
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
  const secretFile = path.join(state, "synthetic-http-token"),
    bindings = path.join(agentRoot, "secret-bindings.json"),
    firstSecret = crypto.randomBytes(24).toString("base64url"),
    secondSecret = crypto.randomBytes(24).toString("base64url");
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
      { windowsHide: true, stdio: "ignore" },
    );
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error("Fixture secret ACL setup failed")),
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
  const device = (await api("/devices")).find(
    (d) => d.name === `local-${process.platform}-${runId}`,
  );
  if (!device) throw Error("Enrollment not visible in authenticated fleet");
  console.log("PASS trusted TLS enrollment -> real device in SQLite.");
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
  const bytes = await fs.readFile(managed);
  if (
    crypto.createHash("sha256").update(bytes).digest("hex") !== version.sha256
  )
    throw Error("Managed bytes do not match exact artifact digest");
  console.log("PASS managed content matches immutable published SHA-256.");
  const drift = structuredClone(config);
  drift.transforms.enrich.source = '.environment = "manually-edited"';
  await fs.writeFile(managed, JSON.stringify(drift));
  await until(
    "same-generation actual-file drift detected and repaired",
    async (d) =>
      d.actual_sha256 === version.sha256 &&
      d.apply_state === "verified_applied" &&
      crypto
        .createHash("sha256")
        .update(await fs.readFile(managed))
        .digest("hex") === version.sha256,
    35000,
  );
  if (
    crypto
      .createHash("sha256")
      .update(await fs.readFile(managed))
      .digest("hex") !== version.sha256
  )
    throw Error("Drift was not actually repaired");
  await cli(["pause", "--state-dir", state, "--json"]);
  await until(
    "local emergency pause reported without losing verified state",
    (d) =>
      d.local_paused === true &&
      d.status === "paused" &&
      d.apply_state === "verified_applied",
    35000,
  );
  await fs.writeFile(managed, JSON.stringify(drift));
  await new Promise((r) => setTimeout(r, 13000));
  if (
    crypto
      .createHash("sha256")
      .update(await fs.readFile(managed))
      .digest("hex") === version.sha256
  )
    throw Error("Paused drift was overwritten");
  console.log("PASS paused manual edits preserved while heartbeats continue.");
  await cli(["resume", "--state-dir", state, "--json"]);
  await until(
    "resume repairs latest desired artifact",
    (d) =>
      d.actual_sha256 === version.sha256 &&
      d.apply_state === "verified_applied",
    40000,
  );
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
        first_administrator_bootstrapped: bootstrapped,
        result: "passed",
        checks: [
          ...(bootstrapped ? ["first administrator from the one-time bootstrap secret"] : []),
          ...(agent.source.kind === "release listing"
            ? ["agent downloaded from the server's release listing, SHA-256 and size verified"]
            : []),
          "native install and explicit adoption",
          "verified TLS/CSR enrollment",
          "dashboard control-plane CRUD and immutable publish",
          "preview and assignment",
          "mTLS signed desired state and authorized artifact fetch",
          "actual Vector validate/activation acknowledgment",
          "exact artifact SHA256",
          "same-generation actual-file drift repair",
          "local pause preserves edits with heartbeats",
          "resume restores latest desired state",
        ],
        device_name: device.name,
        generation: verified.desired_generation,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS complete native control-plane workflow. Isolated demo agent remains running for the dashboard preview.",
  );
  keepPreview = true;
} finally {
  if (!keepPreview) {
    if (daemon && daemon.exitCode === null) daemon.kill();
    for (const id of createdDeployments.reverse())
      await api(`/deployments/${id}/unassign-preview`, {})
        .then(review => api(`/deployments/${id}/unassign`, { review_token: review.review_token }))
        .catch(() => {});
  }
  receiver.closeAllConnections();
  if (receiver.listening)
    await new Promise((resolve) => receiver.close(resolve));
}
