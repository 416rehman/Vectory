// Independent lifecycle authorization/integrity checks on disposable loopback state.
// The seeded device is an explicitly synthetic resolver fixture, never a live agent.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const source = path.resolve(
  process.env.VECTORY_ROLLBACK_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-rollback-review-"),
);
await fs.chmod(temporary, 0o700);
const executable = path.join(temporary, path.basename(source));
await fs.copyFile(source, executable);
await fs.chmod(executable, 0o700);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const evidence = {
  recorded_at: new Date().toISOString(),
  server_sha256: sha(await fs.readFile(executable)),
  scope:
    "Independent rollback authorization/priority checks against disposable real HTTP state. Explicitly synthetic database-seeded devices; no native activation claim.",
  checks: [],
};
let child, db;
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
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await Promise.race([closed, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}
const interrupt = () => child?.kill("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function check(name, test) {
  await test();
  evidence.checks.push({ name, passed: true });
  console.log("PASS", name);
}
try {
  const origin = `http://127.0.0.1:${await freePort()}`,
    state = path.join(temporary, "state");
  const bootstrap = randomBytes(32).toString("hex"),
    password = randomBytes(24).toString("base64url");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("VECTORY_"),
    ),
  );
  child = spawn(executable, [], {
    cwd: temporary,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...environment,
      VECTORY_DEVELOPMENT: "true",
      VECTORY_COOKIE_SECURE: "false",
      VECTORY_HTTP_ADDR: new URL(origin).host,
      VECTORY_DATA_DIR: state,
      VECTORY_DASHBOARD_DIR: path.join(root, "dashboard/dist"),
      VECTORY_BOOTSTRAP_SECRET: bootstrap,
      RUST_LOG: "vectory_server=info",
      NO_COLOR: "1",
    },
  });
  let log = "",
    startError;
  child.on("error", (error) => {
    startError = error;
  });
  const collect = (data) => {
    log = (log + data).slice(-32768);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const deadline = Date.now() + 20000;
  while (!log.includes("dashboard listener ready")) {
    if (startError) throw startError;
    if (child.exitCode !== null || Date.now() >= deadline)
      throw Error("Disposable lifecycle server did not start");
    await delay(50);
  }
  async function call(
    method,
    route,
    data,
    session,
    expected = 200,
    extra = {},
  ) {
    const response = await fetch(origin + "/api/v1" + route, {
      method,
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...(session
          ? { cookie: session.cookie, "x-csrf-token": session.csrf }
          : {}),
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${route}: ${body.error?.code || response.status}`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    return {
      body,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      csrf: body.csrf_token,
      user: body.user,
    };
  }
  const admin = await call("POST", "/bootstrap", {
    bootstrap_secret: bootstrap,
    name: "Synthetic lifecycle administrator",
    email: "admin@example.test",
    password,
  });
  const roles = {};
  for (const role of ["viewer", "editor", "operator"]) {
    await call(
      "POST",
      "/users",
      {
        name: `Synthetic ${role}`,
        email: `${role}@example.test`,
        password,
        role,
      },
      admin,
    );
    roles[role] = await call("POST", "/login", {
      email: `${role}@example.test`,
      password,
    });
  }
  const initialConfig = {
    sources: { example: { type: "demo_logs", format: "json" } },
    transforms: { sample: { type: "sample", inputs: ["example"], rate: 10 } },
    sinks: { discard: { type: "blackhole", inputs: ["sample"] } },
  };
  const graph = {
    nodes: [
      {
        id: "example",
        position: { x: 37, y: 91 },
        data: { note: "Retain original graph coordinates" },
      },
    ],
    edges: [],
  };
  const create = async (name) =>
    (
      await call(
        "POST",
        "/configurations",
        {
          name,
          description: "Original description",
          config: initialConfig,
          graph,
        },
        roles.editor,
      )
    ).body;
  let current = await create("Synthetic source pipeline");
  const foreign = await create("Synthetic other pipeline");
  const original = structuredClone(current);
  const originalRevision = (
    await call(
      "GET",
      `/configurations/${current.id}/history?kind=revisions&page=1&page_size=12`,
      undefined,
      admin,
    )
  ).body.items[0];
  const foreignRevision = (
    await call(
      "GET",
      `/configurations/${foreign.id}/history?kind=revisions&page=1&page_size=12`,
      undefined,
      admin,
    )
  ).body.items[0];
  const published = (
    await call(
      "POST",
      `/configurations/${current.id}/publish`,
      { revision: current.revision, message: "Immutable baseline" },
      roles.operator,
    )
  ).body;
  const foreignVersion = (
    await call(
      "POST",
      `/configurations/${foreign.id}/publish`,
      { revision: foreign.revision },
      roles.operator,
    )
  ).body;
  assert.equal(sha(published.artifact), published.sha256);
  db = new DatabaseSync(path.join(state, "vectory.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const deviceId = randomUUID();
  const device = {
    id: deviceId,
    name: "synthetic-lifecycle-device",
    os: "windows",
    arch: "amd64",
    vector_version: "0.58.0",
    agent_version: "0.1.0-dev",
    configuration_mode: "full",
    last_seen: new Date().toISOString(),
    status: "unmanaged",
    labels: {},
    desired_generation: 0,
    reported_generation: 0,
    apply_state: "unmanaged",
    sync_paused: false,
    pause_acknowledged: false,
    created_at: new Date().toISOString(),
  };
  db.prepare("INSERT INTO devices(id,name,data) VALUES(?,?,?)").run(
    deviceId,
    device.name,
    JSON.stringify(device),
  );
  const deploymentRequest = {
    version_id: published.id,
    selector: { device_ids: [deviceId], group_ids: [], exclude_ids: [] },
    expected_device_ids: [deviceId],
    priority: 10,
    target_mode: "snapshot",
    scheduled_at: null,
    rollout: {
      kind: "all",
      canary_size: 1,
      batch_size: 1,
      observation_seconds: 0,
      failure_threshold: 0,
    },
  };
  const deployment = (
    await call("POST", "/deployments", deploymentRequest, roles.operator)
  ).body;
  const bindings = () =>
    db
      .prepare(
        "SELECT id,desired_version_id,desired_generation,assignment_id,policy_assignment_id,policy_generation,policy FROM devices ORDER BY id",
      )
      .all();
  const baselineBindings = bindings();
  assert.equal(baselineBindings[0].desired_version_id, published.id);
  const immutable = db
    .prepare("SELECT data FROM records WHERE kind='version' AND id=?")
    .get(published.id).data;
  const configurationCount = () =>
    db
      .prepare("SELECT count(*) total FROM records WHERE kind='configuration'")
      .get().total;
  const revisionCount = (id) =>
    db
      .prepare(
        "SELECT count(*) total FROM records WHERE kind='revision' AND json_extract(data,'$.configuration_id')=?",
      )
      .get(id).total;

  const makeDevice = async (name) => {
    const id = randomUUID(),
      fixture = { ...device, id, name };
    db.prepare("INSERT INTO devices(id,name,data) VALUES(?,?,?)").run(
      id,
      name,
      JSON.stringify(fixture),
    );
    await call(
      "POST",
      "/deployments",
      {
        ...deploymentRequest,
        selector: { device_ids: [id], group_ids: [], exclude_ids: [] },
        expected_device_ids: [id],
      },
      roles.operator,
    );
    return id;
  };
  const deploy = async (id, priority) =>
    (
      await call(
        "POST",
        "/deployments",
        {
          ...deploymentRequest,
          version_id: foreignVersion.id,
          selector: { device_ids: [id], group_ids: [], exclude_ids: [] },
          expected_device_ids: [id],
          priority,
        },
        roles.operator,
      )
    ).body;
  const snapshot = (id) =>
    db
      .prepare(
        "SELECT desired_version_id,desired_generation,assignment_id FROM devices WHERE id=?",
      )
      .get(id);
  const high = await deploy(deviceId, 1000000);
  await check(
    "rollback keeps operator authorization and CSRF checks",
    async () => {
      const before = snapshot(deviceId);
      for (const session of [roles.viewer, roles.editor])
        await call(
          "POST",
          `/deployments/${high.id}/rollback`,
          undefined,
          session,
          403,
        );
      await call(
        "POST",
        `/deployments/${high.id}/rollback`,
        undefined,
        undefined,
        401,
      );
      await call(
        "POST",
        `/deployments/${high.id}/rollback`,
        undefined,
        roles.operator,
        403,
        { "x-csrf-token": "wrong" },
      );
      assert.deepEqual(snapshot(deviceId), before);
    },
  );
  await check(
    "ceiling rollback restores a prior version with a newer generation and terminal old binding",
    async () => {
      const before = snapshot(deviceId);
      const originalTargets = db
        .prepare("SELECT * FROM deployment_targets WHERE deployment_id=?")
        .all(high.id);
      const rollback = (
        await call(
          "POST",
          `/deployments/${high.id}/rollback`,
          undefined,
          roles.operator,
        )
      ).body;
      assert.equal(rollback.priority, 1000000);
      assert.equal(rollback.version_id, published.id);
      assert.equal(rollback.target_mode, "snapshot");
      assert.deepEqual(rollback.selector.device_ids, [deviceId]);
      assert.equal(
        (await call("GET", `/deployments/${high.id}`, undefined, admin)).body
          .status,
        "unassigned",
      );
      const after = snapshot(deviceId);
      assert.equal(after.desired_version_id, published.id);
      assert.equal(after.desired_generation, before.desired_generation + 1);
      assert.equal(after.assignment_id, rollback.id);
      assert.deepEqual(
        db
          .prepare("SELECT * FROM deployment_targets WHERE deployment_id=?")
          .all(high.id),
        originalTargets,
      );
      await call(
        "POST",
        `/deployments/${high.id}/rollback`,
        undefined,
        roles.operator,
        409,
      );
      assert.deepEqual(snapshot(deviceId), after);
    },
  );
  await check(
    "conflicting ceiling restoration rolls back every removal and generation change",
    async () => {
      const id = await makeDevice("synthetic-ceiling-conflict");
      const original = await deploy(id, 1000000);
      await deploy(id, 1000000);
      const before = snapshot(id),
        rawBefore = db
          .prepare("SELECT data FROM records WHERE kind='deployment' AND id=?")
          .get(original.id).data;
      const count = db
        .prepare("SELECT count(*) total FROM records WHERE kind='deployment'")
        .get().total;
      await call(
        "POST",
        `/deployments/${original.id}/rollback`,
        undefined,
        roles.operator,
        409,
      );
      assert.deepEqual(snapshot(id), before);
      assert.equal(
        db
          .prepare("SELECT data FROM records WHERE kind='deployment' AND id=?")
          .get(original.id).data,
        rawBefore,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) total FROM records WHERE kind='deployment'")
          .get().total,
        count,
      );
    },
  );
  await check(
    "ordinary rollback still cancels further admissions and uses the next valid priority",
    async () => {
      const id = await makeDevice("synthetic-ordinary-rollback"),
        original = await deploy(id, 20),
        before = snapshot(id);
      const rollback = (
        await call(
          "POST",
          `/deployments/${original.id}/rollback`,
          undefined,
          roles.operator,
        )
      ).body;
      assert.equal(rollback.priority, 21);
      assert.equal(rollback.version_id, published.id);
      assert.equal(
        (await call("GET", `/deployments/${original.id}`, undefined, admin))
          .body.status,
        "cancelled",
      );
      assert.equal(snapshot(id).desired_version_id, published.id);
      assert.equal(
        snapshot(id).desired_generation,
        before.desired_generation + 1,
      );
    },
  );
  await check(
    "late audit failure restores the original ceiling binding and all runtime counters",
    async () => {
      const id = await makeDevice("synthetic-audit-failure");
      const original = await deploy(id, 1000000);
      const before = snapshot(id);
      const raw = db
        .prepare("SELECT data FROM records WHERE kind='deployment' AND id=?")
        .get(original.id).data;
      const counts = () =>
        db
          .prepare(
            "SELECT kind,count(*) AS n FROM records WHERE kind IN ('deployment','audit') GROUP BY kind ORDER BY kind",
          )
          .all();
      const priorCounts = counts();
      db.exec(
        "CREATE TRIGGER reject_review_rollback_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.rollback' BEGIN SELECT RAISE(FAIL,'synthetic late rollback audit failure'); END",
      );
      try {
        const result = await call(
          "POST",
          `/deployments/${original.id}/rollback`,
          undefined,
          roles.operator,
          500,
        );
        assert(
          !JSON.stringify(result.body).includes(
            "synthetic late rollback audit failure",
          ),
        );
        assert.deepEqual(snapshot(id), before);
        assert.equal(
          db
            .prepare(
              "SELECT data FROM records WHERE kind='deployment' AND id=?",
            )
            .get(original.id).data,
          raw,
        );
        assert.deepEqual(counts(), priorCounts);
      } finally {
        db.exec("DROP TRIGGER reject_review_rollback_audit");
      }
    },
  );
  await check(
    "a live canary rolls back in one reviewed step; exclusions state exactly what they keep",
    async () => {
      const fleet = [];
      for (const name of [
        "synthetic-canary-a",
        "synthetic-canary-b",
        "synthetic-canary-c",
      ]) {
        const id = randomUUID();
        db.prepare("INSERT INTO devices(id,name,data) VALUES(?,?,?)").run(
          id,
          name,
          JSON.stringify({ ...device, id, name }),
        );
        fleet.push(id);
      }
      fleet.sort();
      const selector = { device_ids: fleet, group_ids: [], exclude_ids: [] };
      const base = (
        await call(
          "POST",
          "/deployments",
          {
            ...deploymentRequest,
            selector,
            expected_device_ids: fleet,
            priority: 30,
          },
          roles.operator,
        )
      ).body;
      const canary = (
        await call(
          "POST",
          "/deployments",
          {
            ...deploymentRequest,
            version_id: foreignVersion.id,
            selector,
            expected_device_ids: fleet,
            priority: 30,
            replaces: [base.id],
            rollout: {
              kind: "canary",
              canary_size: 1,
              batch_size: 1,
              observation_seconds: 3600,
              failure_threshold: 0,
            },
          },
          roles.operator,
        )
      ).body;
      const untouched = () => fleet.slice(1).map(snapshot);
      const before = untouched();
      const plan = (
        await call(
          "GET",
          `/deployments/${canary.id}/rollback-preview`,
          undefined,
          roles.operator,
        )
      ).body;
      assert.deepEqual(Object.keys(plan).sort(), [
        "blockers",
        "eligible_devices",
        "excluded_devices",
        "previous_configuration_id",
        "previous_configuration_name",
        "previous_version_id",
        "previous_version_number",
        "priority",
        "ready",
        "review_token",
        "source_action",
        "source_deployment_id",
        "source_status",
        "source_version_id",
      ]);
      assert.equal(plan.source_status, "active");
      assert.equal(plan.ready, true);
      assert.deepEqual(plan.blockers, []);
      assert.deepEqual(
        plan.eligible_devices.map((d) => d.device_id),
        [fleet[0]],
      );
      assert.equal(plan.excluded_devices.length, 2);
      for (const excluded of plan.excluded_devices) {
        assert.deepEqual(Object.keys(excluded).sort(), [
          "current",
          "device_id",
          "device_name",
          "effect",
          "next",
          "reason",
        ]);
        assert.equal(excluded.reason, "not_released");
        assert.equal(excluded.effect, "unchanged");
        assert.equal(excluded.next, null);
        assert.deepEqual(Object.keys(excluded.current).sort(), [
          "configuration_name",
          "version_number",
        ]);
        assert.equal(
          excluded.current.configuration_name,
          "Synthetic source pipeline",
        );
        assert([...excluded.current.configuration_name].length <= 240);
        assert(Number.isSafeInteger(excluded.current.version_number));
        assert(excluded.current.version_number >= 1);
      }
      const rollback = (
        await call(
          "POST",
          `/deployments/${canary.id}/rollback`,
          { request_id: randomUUID(), review_token: plan.review_token },
          roles.operator,
        )
      ).body;
      assert.equal(rollback.version_id, published.id);
      assert.equal(rollback.priority, 31);
      assert.deepEqual(
        rollback.targets.map((t) => t.device_id),
        [fleet[0]],
      );
      const source = (
        await call("GET", `/deployments/${canary.id}`, undefined, admin)
      ).body;
      assert.equal(source.status, "cancelled");
      assert.equal(source.status_before_rollback, "active");
      assert.equal(snapshot(fleet[0]).desired_version_id, published.id);
      assert.deepEqual(untouched(), before);
    },
  );
  evidence.passed = true;
} finally {
  db?.close();
  await stop();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith("vectory-rollback-review-"));
  await fs.rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (evidence.passed) {
    evidence.fixture_removed = true;
    evidence.finished_at = new Date().toISOString();
    const output = path.resolve(
      process.env.VECTORY_ROLLBACK_EVIDENCE ||
        path.join(root, "docs/evidence/rollback-review.json"),
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
}
