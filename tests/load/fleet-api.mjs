// Before/after sizes and times of the dashboard's fleet reads, two server
// builds against identical copies of one seeded synthetic fleet (see
// fleet-fixture.mjs). Both servers run side by side and are sampled in turn,
// so a busy machine slows both alike. Disposable state only: a new private
// directory, a fresh database, and servers started and stopped as children.
//
//   node tests/load/fleet-api.mjs --before <old vectory-server> --after <new vectory-server> \
//     [--before-label 9434fef] [--after-label HEAD] [--devices 5000] [--groups 500] \
//     [--samples 5] [--port <first of three free ports>] [--out <evidence.json>]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  deviceName,
  fixtureId,
  heartbeat,
  seedFleet,
} from "./fleet-fixture.mjs";

const { values: options } = parseArgs({
  options: {
    before: { type: "string" },
    after: { type: "string" },
    "before-label": { type: "string", default: "before" },
    "after-label": { type: "string", default: "after" },
    devices: { type: "string", default: "5000" },
    groups: { type: "string", default: "500" },
    samples: { type: "string", default: "5" },
    port: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!options.before || !options.after)
  throw Error("Pass --before and --after server binaries");
const devices = Number(options.devices),
  groups = Number(options.groups),
  samples = Number(options.samples);
// The shared projection lives two seconds; waiting longer makes a read cold.
const COLD_WAIT_MS = 2300,
  HEARTBEAT_MS = 45000;

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-fleet-api-"),
);
await fs.chmod(temporary, 0o700);
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const builds = {};
for (const which of ["before", "after"]) {
  const executable = path.join(temporary, `vectory-server-${which}`);
  await fs.copyFile(path.resolve(options[which]), executable);
  await fs.chmod(executable, 0o700);
  builds[which] = {
    label: options[`${which}-label`],
    executable,
    sha256: sha(await fs.readFile(executable)),
  };
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
const ports = options.port
  ? [0, 1, 2].map((n) => Number(options.port) + n)
  : [await freePort(), await freePort(), await freePort()];
const children = new Set();
function interrupt() {
  for (const child of children) child.kill("SIGKILL");
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toUpperCase().startsWith("VECTORY_"),
  ),
);
const secret = randomBytes(32).toString("hex"),
  password = randomBytes(24).toString("base64url"),
  email = "fleet-measurement@example.test";

async function start(executable, state, port) {
  const child = spawn(executable, [], {
    cwd: temporary,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...environment,
      VECTORY_DEVELOPMENT: "true",
      VECTORY_COOKIE_SECURE: "false",
      VECTORY_HTTP_ADDR: `127.0.0.1:${port}`,
      VECTORY_DATA_DIR: state,
      VECTORY_DASHBOARD_DIR: path.join(temporary, "no-dashboard"),
      VECTORY_BOOTSTRAP_SECRET: secret,
      RUST_LOG: "vectory_server=warn",
      NO_COLOR: "1",
    },
  });
  children.add(child);
  let log = "";
  const collect = (data) => (log = (log + data).slice(-65536));
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null)
      throw Error(`Server exited during startup:\n${log}`);
    try {
      if (
        (
          await fetch(origin + "/api/v1/status", {
            signal: AbortSignal.timeout(2000),
          })
        ).ok
      )
        break;
    } catch {}
    if (attempt > 600) throw Error("Server did not start");
    await delay(100);
  }
  return { child, origin, log: () => log };
}
async function stop(server) {
  const { child } = server;
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGINT");
    await Promise.race([closed, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await closed;
    }
  }
  children.delete(child);
}
async function call(server, method, route, { session, body } = {}) {
  const started = performance.now();
  const response = await fetch(server.origin + "/api/v1" + route, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session
        ? { cookie: session.cookie, "x-csrf-token": session.csrf }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const ms = performance.now() - started;
  return { status: response.status, bytes, ms, headers: response.headers };
}
const json = (result) => JSON.parse(result.bytes.toString("utf8"));
async function signIn(server) {
  const result = await call(server, "POST", "/login", {
    body: { email, password },
  });
  assert.equal(result.status, 200, "sign-in");
  return {
    cookie: result.headers.get("set-cookie").split(";")[0],
    csrf: json(result).csrf_token,
  };
}

const evidence = {
  recorded_at: new Date().toISOString(),
  scope:
    "Isolated synthetic fleet seeded directly in SQLite (tests/load/fleet-fixture.mjs) and served by two real server builds on loopback. No enrollment, agent, Vector process or production data; verified_applied is fixture input. Debug builds on a shared development host: compare the two builds with each other, not with any capacity target.",
  host: {
    platform: process.platform,
    release: os.release(),
    cpus: os.cpus().length,
    memory_bytes: os.totalmem(),
    load_average_start: os.loadavg(),
    node: process.version,
  },
  builds: Object.fromEntries(
    Object.entries(builds).map(([which, build]) => [
      which,
      { label: build.label, sha256: build.sha256 },
    ]),
  ),
  samples,
  cold_wait_ms: COLD_WAIT_MS,
  results: [],
  checks: [],
};
const servers = {};
try {
  // Initialize a database with the new build, create the measuring account
  // through the API, then seed the fleet with the server stopped.
  const seedState = path.join(temporary, "state-after");
  const first = await start(builds.after.executable, seedState, ports[0]);
  const admin = await call(first, "POST", "/bootstrap", {
    body: {
      bootstrap_secret: secret,
      name: "Fleet measurement",
      email,
      password,
    },
  });
  assert.equal(admin.status, 200, "bootstrap");
  const actor = json(admin).user.id;
  await stop(first);
  const seeded = Date.now();
  evidence.fixture = seedFleet(path.join(seedState, "vectory.db"), {
    devices,
    groups,
    actor,
  });
  evidence.fixture.seed_ms = Date.now() - seeded;
  console.log("Seeded", evidence.fixture);
  await fs.cp(seedState, path.join(temporary, "state-before"), {
    recursive: true,
  });
  const states = {
    before: path.join(temporary, "state-before"),
    after: seedState,
  };
  let stamped = 0;
  const keepCheckedIn = () => {
    if (Date.now() - stamped < HEARTBEAT_MS) return;
    for (const state of Object.values(states))
      heartbeat(path.join(state, "vectory.db"));
    stamped = Date.now();
  };
  keepCheckedIn();
  servers.before = await start(
    builds.before.executable,
    states.before,
    ports[1],
  );
  servers.after = await start(builds.after.executable, states.after, ports[2]);
  const sessions = {
    before: await signIn(servers.before),
    after: await signIn(servers.after),
  };
  // Let the first scheduler ticks settle before measuring.
  await delay(6000);

  // A healthy device on the syslog rollout (shape 0 of 20).
  const probe = fixtureId(
    "device",
    Math.min(1000, Math.floor((devices - 1) / 20) * 20),
  );
  const everything = fixtureId("group", 0),
    metrics = fixtureId("group", 11);
  const metricsGroup = json(
    await call(servers.after, "GET", `/groups/${metrics}`, {
      session: sessions.after,
    }),
  );
  // The membership preview adds five unmanaged devices and removes five members.
  const added = [15, 35, 55, 75, 95].map((n) => fixtureId("device", n));
  const proposed = [...metricsGroup.device_ids.slice(5), ...added];
  const preview = {
    group_id: metrics,
    device_ids: proposed,
    revision: metricsGroup.revision,
  };
  const reads = [
    { server: "before", name: "devices", route: "/devices" },
    { server: "before", name: "groups", route: "/groups" },
    {
      server: "before",
      name: "overview_slim_param",
      route: "/overview?slim=1",
    },
    { server: "before", name: "overview", route: "/overview" },
    { server: "before", name: "device", route: `/devices/${probe}` },
    {
      server: "before",
      name: "membership_preview",
      method: "POST",
      route: "/groups/membership-preview",
      body: preview,
    },
    {
      server: "after",
      name: "inventory_page_1",
      route: "/devices/inventory",
      cached: true,
    },
    {
      server: "after",
      name: "inventory_q",
      route: "/devices/inventory?q=web-01",
      cached: true,
    },
    {
      server: "after",
      name: "overview_slim",
      route: "/overview?slim=1",
      cached: true,
    },
    { server: "after", name: "overview", route: "/overview" },
    { server: "after", name: "device", route: `/devices/${probe}` },
    {
      server: "after",
      name: "device_with_groups",
      route: `/devices/${probe}?include=groups`,
    },
    {
      server: "after",
      name: "group_members",
      route: `/groups/${everything}/members`,
      cached: true,
    },
    { server: "after", name: "groups_slim", route: "/groups?slim=1" },
    { server: "after", name: "groups", route: "/groups" },
    { server: "after", name: "devices", route: "/devices" },
    {
      server: "after",
      name: "inventory_ids",
      route: "/devices/inventory/ids",
      cached: true,
    },
    {
      server: "after",
      name: "membership_preview",
      method: "POST",
      route: "/groups/membership-preview",
      body: preview,
    },
  ];
  const timings = new Map(
    reads.map((read) => [read, { cold: [], warm: [], busy: 0 }]),
  );
  const last = new Map();
  async function measure(read) {
    const server = servers[read.server],
      session = sessions[read.server];
    for (let attempt = 0; ; attempt++) {
      const result = await call(server, read.method || "GET", read.route, {
        session,
        body: read.body,
      });
      // The membership preview yields to the writer lock ("Preview busy,
      // retrying"); only the attempt that ran is timed, the refusals counted.
      if (
        (result.status === 429 || result.status === 503) &&
        attempt < 400 &&
        result.bytes.includes("CAPACITY_BUSY")
      ) {
        timings.get(read).busy++;
        await delay(50);
        continue;
      }
      assert.equal(
        result.status,
        200,
        `${read.server} ${read.route}: ${result.bytes.toString("utf8").slice(0, 300)}`,
      );
      return result;
    }
  }
  // Warm-up: one of each, not recorded.
  for (const read of reads) await measure(read);
  for (let sample = 0; sample < samples; sample++) {
    // Alternate the order so neither build always goes first.
    const order = sample % 2 ? [...reads].reverse() : reads;
    for (const read of order) {
      keepCheckedIn();
      await delay(COLD_WAIT_MS);
      const cold = await measure(read);
      timings.get(read).cold.push(cold.ms);
      last.set(read, cold);
      if (read.cached) timings.get(read).warm.push((await measure(read)).ms);
    }
    console.log(`Sample ${sample + 1} of ${samples} done`);
  }
  const stats = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const round = (value) => Math.round(value * 10) / 10;
    return {
      median: round(sorted[Math.floor(sorted.length / 2)]),
      min: round(sorted[0]),
      max: round(sorted.at(-1)),
    };
  };
  const placeholder = (route) =>
    route
      .replace(probe, "{device}")
      .replace(everything, "{all servers}")
      .replace(metrics, "{metrics relays}");
  for (const read of reads) {
    const result = last.get(read);
    const body = json(result);
    const t = timings.get(read);
    evidence.results.push({
      server: read.server,
      build: builds[read.server].label,
      name: read.name,
      method: read.method || "GET",
      route: placeholder(read.route),
      bytes: result.bytes.length,
      gzip_bytes: gzipSync(result.bytes).length,
      rows: Array.isArray(body)
        ? body.length
        : Array.isArray(body.items)
          ? body.items.length
          : Array.isArray(body.devices)
            ? body.devices.length
            : Array.isArray(body.ids)
              ? body.ids.length
              : undefined,
      ms: stats(t.cold),
      warm_ms: stats(t.warm),
      busy_retries: t.busy || undefined,
    });
  }
  evidence.load_average_end = os.loadavg();

  // What the numbers describe: the same fleet on both builds.
  keepCheckedIn();
  const read = async (which, route) =>
    json(
      await call(servers[which], "GET", route, { session: sessions[which] }),
    );
  const check = (name, test) => {
    test();
    evidence.checks.push(name);
    console.log("PASS", name);
  };
  const oldOverview = await read("before", "/overview");
  const newOverview = await read("after", "/overview");
  const slim = await read("after", "/overview?slim=1");
  const inventory = await read("after", "/devices/inventory");
  const live = evidence.fixture.live;
  check("both builds list every device, revoked included", () => {
    assert.equal(oldOverview.devices.length, evidence.fixture.devices);
    assert.equal(newOverview.devices.length, evidence.fixture.devices);
  });
  check("the fleet was checked in while it was measured", () => {
    // Offline and never-connected shapes are one in ten of the live devices.
    const online = oldOverview.devices.filter(
      (d) =>
        d.status !== "revoked" &&
        d.status !== "offline" &&
        d.status !== "awaiting_first_check_in",
    ).length;
    assert.ok(online >= live * 0.85, `${online} of ${live} online`);
    assert.equal(slim.counts.connection.online, online);
    assert.equal(oldOverview.devices_online, newOverview.devices_online);
  });
  check("the slim Overview leaves out only devices", () => {
    assert.equal("devices" in slim, false);
    assert.equal(slim.counts.total, live);
    assert.deepEqual(
      Object.keys(slim).sort(),
      Object.keys(newOverview)
        .filter((key) => key !== "devices")
        .sort(),
    );
  });
  check("the inventory pages the live fleet", () => {
    assert.equal(inventory.total, live);
    assert.equal(inventory.items.length, Math.min(50, live));
    assert.equal(
      inventory.counts.status.revoked,
      evidence.fixture.devices - live,
    );
    // Revoked devices are every twentieth; names sort naturally.
    const names = [];
    for (let n = 0; n < devices; n++)
      if (n % 20 !== 19) names.push(deviceName(n));
    names.sort(
      new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare,
    );
    assert.deepEqual(
      inventory.items.map((item) => item.name),
      names.slice(0, 50),
    );
  });
  check("a device reads the same on both builds", () => {
    const strip = (device) => {
      const copy = structuredClone(device);
      delete copy.last_seen;
      if (copy.telemetry) delete copy.telemetry.sampled_at;
      return copy;
    };
    const before = last.get(
      reads.find((r) => r.server === "before" && r.name === "device"),
    );
    const after = last.get(
      reads.find((r) => r.server === "after" && r.name === "device"),
    );
    assert.deepEqual(strip(json(after)), strip(json(before)));
  });
  check("both builds preview the same membership change", () => {
    const before = json(
      last.get(
        reads.find(
          (r) => r.server === "before" && r.name === "membership_preview",
        ),
      ),
    );
    const after = json(
      last.get(
        reads.find(
          (r) => r.server === "after" && r.name === "membership_preview",
        ),
      ),
    );
    assert.deepEqual(after, before);
  });
  for (const which of ["before", "after"]) {
    const log = servers[which].log();
    evidence[`${which}_log_errors`] = (log.match(/ERROR/g) || []).length;
  }
} finally {
  for (const server of Object.values(servers)) await stop(server);
  for (const child of children) child.kill("SIGKILL");
  if (!options.keep) await fs.rm(temporary, { recursive: true, force: true });
}
const table = evidence.results.map(
  (r) =>
    `| ${r.build} | ${r.method} ${r.route} | ${r.bytes.toLocaleString("en-US")} | ${r.gzip_bytes.toLocaleString("en-US")} | ${r.ms.median} | ${r.warm_ms ? r.warm_ms.median : ""} |`,
);
console.log(
  [
    "| Build | Read | Bytes | Gzip bytes | Median ms | Warm median ms |",
    "| --- | --- | --- | --- | --- | --- |",
    ...table,
  ].join("\n"),
);
if (options.out)
  await fs.writeFile(options.out, JSON.stringify(evidence, null, 2) + "\n");
