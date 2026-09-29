#!/usr/bin/env node
// One-command local demo: a loopback Vectory preview plus a small fleet of real
// agents running the official Vector binary with synthetic demo_logs events.
// Everything lives under .local/; nothing touches system services or trust stores.
//
//   node scripts/demo.mjs            start (or reuse) the preview and a 4-agent fleet
//   node scripts/demo.mjs --agents 6 choose the fleet size (1-12)
//   node scripts/demo.mjs --stop     stop the demo agents and the preview
import fs from "node:fs/promises";
import { existsSync, openSync, closeSync, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const local = path.join(root, ".local");
const preview = process.env.VECTORY_PREVIEW_DIR || path.join(local, "preview");
const demoRoot = process.env.VECTORY_DEMO_DIR || path.join(local, "demo");
const web = `http://127.0.0.1:${process.env.VECTORY_PREVIEW_WEB_PORT || 8080}`;
const agentServer = `https://localhost:${process.env.VECTORY_PREVIEW_AGENT_PORT || 8443}`;
const VECTOR_VERSION = "0.58.0";
// Each agent's pipeline exports Vector's metrics on its own loopback port; the
// agent discovers the exporter in the running configuration by itself.
const metricsPortBase = Number(process.env.VECTORY_DEMO_METRICS_PORT_BASE || 19600);
const args = process.argv.slice(2);
const agentCount = Math.min(
  12,
  Math.max(1, Number(args[args.indexOf("--agents") + 1]) || 4),
);

const say = (message) => console.log(`\x1b[2m›\x1b[0m ${message}`);
const done = (message) => console.log(`\x1b[32m✓\x1b[0m ${message}`);
const fail = (message) => {
  console.error(`\x1b[31m✗\x1b[0m ${message}`);
  process.exit(1);
};

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0)
    fail(
      `${command} ${commandArgs.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  return result.stdout;
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function stopDemo() {
  const agents = await fs
    .readdir(path.join(demoRoot, "agents"))
    .catch(() => []);
  const stopping = [];
  for (const name of agents) {
    const pidFile = path.join(demoRoot, "agents", name, "agent.pid");
    const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
    if (!pid) continue;
    // Only stop a process whose command line is this demo agent.
    const cmdline = await fs
      .readFile(`/proc/${pid}/cmdline`, "utf8")
      .catch(() => "");
    const ours =
      process.platform !== "linux" || cmdline.includes(path.join(demoRoot));
    try {
      if (ours) {
        process.kill(pid, "SIGTERM");
        stopping.push(pid);
      }
    } catch {
      /* already stopped */
    }
    await fs.rm(pidFile, { force: true });
  }
  // Vector drains in-flight events for up to its graceful shutdown limit (60 s
  // by default), longer while a destination is down. Wait, so a restart does
  // not find the previous agent still holding its state directory.
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 90_000;
  if (stopping.some(alive)) say("Waiting for Vector to drain and the agents to exit…");
  while (stopping.some(alive) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 500));
  if (stopping.some(alive)) say("Some agents are still stopping; they exit on their own.");
  run(path.join(root, "scripts/preview.sh"), ["stop"]);
  done("Demo agents and preview stopped. State remains in .local/ for next time.");
}

function vectorTarget() {
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (!arch) fail(`No official Vector build is mapped for ${process.arch}.`);
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  if (process.platform === "darwin" && arch === "aarch64")
    return "arm64-apple-darwin";
  fail(
    `This demo supports Linux (x86_64/aarch64) and Apple Silicon macOS. Vector ${VECTOR_VERSION} has no official build for ${process.platform}/${process.arch}.`,
  );
}

async function ensureVector() {
  const target = vectorTarget();
  const tools = path.join(local, "tools");
  const binary = path.join(tools, `vector-${target}`, "bin", "vector");
  if (existsSync(binary)) return binary;
  const archive = `vector-${VECTOR_VERSION}-${target}.tar.gz`;
  const release = `https://github.com/vectordotdev/vector/releases/download/v${VECTOR_VERSION}`;
  say(`Downloading the official Vector ${VECTOR_VERSION} release (${target})…`);
  await fs.mkdir(tools, { recursive: true });
  const sums = await fetch(`${release}/vector-${VECTOR_VERSION}-SHA256SUMS`).then(
    (r) => (r.ok ? r.text() : fail(`Could not download SHA256SUMS (HTTP ${r.status}).`)),
  );
  const expected = sums
    .split("\n")
    .find((line) => line.trim().endsWith(`  ${archive}`))
    ?.split(/\s+/)[0];
  if (!expected) fail(`SHA256SUMS does not list ${archive}.`);
  const response = await fetch(`${release}/${archive}`);
  if (!response.ok) fail(`Could not download ${archive} (HTTP ${response.status}).`);
  const file = path.join(tools, archive);
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(file);
  if (actual !== expected)
    fail(`Checksum mismatch for ${archive}: expected ${expected}, got ${actual}.`);
  run("tar", ["xzf", file, "-C", tools]);
  await fs.rm(file);
  if (!existsSync(binary)) fail(`The archive did not contain ${binary}.`);
  done(`Vector ${VECTOR_VERSION} verified (SHA-256 ${actual.slice(0, 16)}…).`);
  return binary;
}

async function ensureBuilds() {
  const server = path.join(root, "server/target/debug/vectory-server");
  if (!existsSync(server)) {
    say("Building the server (first run only)…");
    run("cargo", ["build", "--bins"], { cwd: path.join(root, "server"), stdio: "inherit" });
  }
  if (!existsSync(path.join(root, "dashboard/dist/index.html")))
    fail("Build the dashboard first: (cd help-center && npm ci) && (cd dashboard && npm ci && npm run build)");
  const agent = path.join(demoRoot, "bin", "vectory");
  say("Building the agent…");
  await fs.mkdir(path.dirname(agent), { recursive: true });
  run("go", ["build", "-trimpath", "-o", agent, "./cmd/vectory"], {
    cwd: path.join(root, "agent"),
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  return agent;
}

async function session() {
  const credentialsPath = path.join(preview, "credentials.json");
  let credentials = await fs
    .readFile(credentialsPath, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const status = await fetch(`${web}/api/v1/status`).then((r) => r.json());
  if (!status.initialized) {
    credentials ??= {
      name: "Demo operator",
      email: "operator@vectory.local",
      password: crypto.randomBytes(18).toString("base64url"),
    };
    await fs.writeFile(credentialsPath, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
    });
    const bootstrap_secret = (
      await fs.readFile(path.join(preview, "bootstrap.secret"), "utf8")
    ).trim();
    const result = await fetch(`${web}/api/v1/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credentials, bootstrap_secret }),
    });
    if (!result.ok) fail(`Workspace setup failed (HTTP ${result.status}).`);
    done("Created the demo administrator.");
  }
  if (!credentials)
    fail(`This preview is already set up but ${credentialsPath} is missing.`);
  const login = await fetch(`${web}/api/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  if (!login.ok) fail(`Sign-in failed (HTTP ${login.status}).`);
  const body = await login.json();
  if (body.mfa_required)
    fail("The preview administrator uses two-factor sign-in; seed the demo from a fresh preview.");
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const api = async (endpoint, payload, method = payload ? "POST" : "GET") => {
    const response = await fetch(`${web}/api/v1${endpoint}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": body.csrf_token,
        Cookie: cookie,
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok)
      throw Error(`${method} ${endpoint}: HTTP ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  return { api, credentials };
}

function agentCli(agent, cliArgs, input = "") {
  const result = spawnSync(agent, cliArgs, { input, encoding: "utf8" });
  if (result.status !== 0)
    throw Error(`vectory ${cliArgs[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const names = ["edge-nyc-01", "edge-nyc-02", "edge-fra-01", "web-ams-01", "web-ams-02", "edge-sfo-01", "edge-sfo-02", "web-sin-01", "edge-syd-01", "web-lon-01", "edge-tor-01", "web-sao-01"];

async function startAgent(agent, vector, api, token, name, index) {
  const home = path.join(demoRoot, "agents", name);
  const state = path.join(home, "state");
  const managed = path.join(home, "config", "managed.json");
  const data = path.join(home, "vector-data");
  const metricsPort = metricsPortBase + index;
  const pidFile = path.join(home, "agent.pid");
  const priorPid = Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
  if (priorPid) {
    try {
      process.kill(priorPid, 0);
      return { name, metricsPort, reused: true };
    } catch {
      /* restart below */
    }
  }
  if (!existsSync(path.join(state, "settings.json"))) {
    await fs.mkdir(path.dirname(managed), { recursive: true });
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(
      managed,
      JSON.stringify({
        data_dir: data,
        sources: { local_demo: { type: "demo_logs", format: "syslog", interval: 1 } },
        sinks: { discard: { type: "blackhole", inputs: ["local_demo"] } },
      }),
    );
    agentCli(agent, [
      "install",
      "--state-dir", state,
      "--vector-binary", vector,
      "--managed-config", managed,
      "--adopt",
      "--allow-full-vector-config",
      "--json",
    ]);
  }
  if (!existsSync(path.join(state, "identity.json"))) {
    agentCli(
      agent,
      [
        "enroll",
        "--state-dir", state,
        "--server", agentServer,
        "--ca-file", path.join(local, "pki", "ca.pem"),
        "--id", name,
        "--token-stdin",
        "--json",
      ],
      token + "\n",
    );
  }
  const log = openSync(path.join(home, "agent.log"), "a");
  const daemon = spawn(agent, ["run", "--state-dir", state], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  daemon.unref();
  closeSync(log);
  await fs.writeFile(pidFile, String(daemon.pid));
  return { name, metricsPort, reused: false };
}

function demoPipeline(format) {
  // No data_dir: each device supplies its own (here the adopted file's).
  return {
    sources: {
      app_logs: { type: "demo_logs", format, interval: 0.2 },
      vector_metrics: { type: "internal_metrics", scrape_interval_secs: 5 },
    },
    transforms: {
      parse: {
        type: "remap",
        inputs: ["app_logs"],
        source:
          format === "apache_common"
            ? '. = parse_apache_log!(.message, format: "common")\n.environment = "demo"'
            : '. |= parse_syslog!(.message)\n.environment = "demo"',
      },
      by_severity: {
        type: "route",
        inputs: ["parse"],
        route: {
          errors:
            format === "apache_common" ? "(int(.status) ?? 0) >= 500" : '.severity == "err" || .severity == "crit"',
        },
      },
      sample_rest: {
        type: "sample",
        inputs: ["by_severity._unmatched"],
        rate: 10,
      },
    },
    sinks: {
      errors_out: { type: "blackhole", inputs: ["by_severity.errors"] },
      archive: { type: "blackhole", inputs: ["sample_rest"] },
      metrics_exporter: {
        type: "prometheus_exporter",
        inputs: ["vector_metrics"],
        address: "127.0.0.1:9598",
      },
    },
  };
}

async function main() {
  if (args.includes("--stop")) return stopDemo();
  if (!["linux", "darwin"].includes(process.platform))
    fail("Use docs/LOCAL-DEMO.md on Windows; this script supports Linux and macOS.");
  const agent = await ensureBuilds();
  const vector = await ensureVector();
  say("Starting the loopback preview…");
  run(path.join(root, "scripts/preview.sh"), ["start"], {
    env: { ...process.env, VECTORY_PREVIEW_VECTOR: vector, VECTORY_INSTANCE_NAME: "Vectory demo" },
  });
  const { api, credentials } = await session();
  const token = await api("/tokens", {
    name: `Demo fleet ${new Date().toISOString().slice(0, 16)}`,
    expires_hours: 1,
    max_uses: agentCount,
  });
  const fleet = [];
  for (let i = 0; i < agentCount; i++) {
    fleet.push(await startAgent(agent, vector, api, token.token, names[i], i));
    done(`${names[i]} ${fleet.at(-1).reused ? "already running" : "enrolled and running"}`);
  }
  // Give first heartbeats a moment so the devices exist before deployment.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const devices = await api("/devices");
  const byName = new Map(devices.map((d) => [d.name, d]));
  const groups = await api("/groups");
  const groupFor = async (name, description, members) => {
    const existing = groups.find((g) => g.name === name);
    if (existing) return existing;
    return api("/groups", {
      name,
      description,
      device_ids: members.map((m) => byName.get(m)?.id).filter(Boolean),
    });
  };
  const edge = fleet.filter((d) => d.name.startsWith("edge"));
  const webHosts = fleet.filter((d) => d.name.startsWith("web"));
  await groupFor("Edge collectors", "Synthetic demo edge hosts", edge.map((d) => d.name)).catch((e) => say(`Group skipped: ${e.message}`));
  await groupFor("Web tier", "Synthetic demo web hosts", webHosts.map((d) => d.name)).catch((e) => say(`Group skipped: ${e.message}`));

  const everyone = fleet.map((d) => byName.get(d.name)?.id).filter(Boolean);
  const deployments = await api("/deployments");
  if (!deployments.some((d) => d.policy?.heartbeat_seconds === 15)) {
    // A short check-in interval keeps the demo responsive; production defaults to 60s.
    await api("/deployments", {
      policy: { heartbeat_seconds: 15, sync_paused: false, telemetry_enabled: true },
      selector: { device_ids: everyone, group_ids: [], exclude_ids: [] },
      priority: 100,
      target_mode: "snapshot",
      rollout: { kind: "all", canary_size: 1, batch_size: 10, observation_seconds: 30, failure_threshold: 0 },
    });
    done("Applied 15-second check-ins to the demo fleet.");
  }
  const existing = await api("/configurations");
  for (const [label, format, members] of [
    ["Edge syslog processing", "syslog", edge],
    ["Web access logs", "apache_common", webHosts],
  ]) {
    if (!members.length || existing.some((c) => c.name === `${label} (synthetic demo)`)) continue;
    const config = demoPipeline(format);
    const created = await api("/configurations", {
      name: `${label} (synthetic demo)`,
      description: "Synthetic demo_logs events: parse, route errors, sample the rest. Nothing leaves the host.",
      config,
      graph: { nodes: [], edges: [] },
      variables: [
        { name: "metrics_address", path: "/sinks/metrics_exporter/address", type: "string" },
      ],
    });
    const version = await api(`/configurations/${created.id}/publish`, {
      revision: created.revision,
      message: "Initial synthetic demo version",
    });
    const targets = members.map((m) => byName.get(m.name)).filter(Boolean);
    const bindings = { defaults: {}, devices: {} };
    for (const member of members) {
      const device = byName.get(member.name);
      if (!device) continue;
      bindings.devices[device.id] = {
        metrics_address: `127.0.0.1:${member.metricsPort}`,
      };
    }
    await api("/deployments", {
      version_id: version.id,
      selector: { device_ids: targets.map((d) => d.id), group_ids: [], exclude_ids: [] },
      priority: 100,
      target_mode: "snapshot",
      rollout: { kind: "all", canary_size: 1, batch_size: 10, observation_seconds: 30, failure_threshold: 0 },
      variable_bindings: bindings,
    });
    done(`Published and deployed “${label}” to ${targets.length} device(s).`);
  }
  console.log(`\nOpen ${web} and sign in as ${credentials.email}.`);
  console.log(`Password: ${path.relative(root, path.join(preview, "credentials.json"))}   Stop: node scripts/demo.mjs --stop`);
}

main().catch((error) => fail(error.message));
