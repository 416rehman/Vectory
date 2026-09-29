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
  process.env.VECTORY_PIPELINE_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-pipeline-review-"),
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
    "Independent real HTTP lifecycle checks against disposable development state. Synthetic accounts and one database-seeded device; no native validation, enrollment or activation claim.",
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

  await check(
    "viewer and operator cannot mutate draft lifecycle; CSRF and authentication remain required",
    async () => {
      const before = {
        configs: configurationCount(),
        revisions: revisionCount(current.id),
      };
      for (const actor of [roles.viewer, roles.operator])
        for (const action of ["duplicate", "archive", "unarchive", "restore"]) {
          await call(
            "POST",
            `/configurations/${current.id}/${action}`,
            {
              revision: current.revision,
              name: "Forbidden copy",
              revision_id: originalRevision.id,
            },
            actor,
            403,
          );
        }
      await call(
        "POST",
        `/configurations/${current.id}/archive`,
        { revision: current.revision },
        admin,
        403,
        { "x-csrf-token": "invalid" },
      );
      await call(
        "POST",
        `/configurations/${current.id}/archive`,
        { revision: current.revision },
        undefined,
        401,
      );
      assert.equal(configurationCount(), before.configs);
      assert.equal(revisionCount(current.id), before.revisions);
    },
  );
  await check(
    "stale or invalid revisions cannot duplicate, restore or change archive state",
    async () => {
      for (const action of ["duplicate", "archive", "unarchive", "restore"]) {
        const stale = await call(
          "POST",
          `/configurations/${current.id}/${action}`,
          {
            revision: current.revision + 1,
            name: "Stale copy",
            revision_id: originalRevision.id,
          },
          roles.editor,
          409,
        );
        assert.equal(stale.body.error.code, "STALE_REVISION");
        await call(
          "POST",
          `/configurations/${current.id}/${action}`,
          {
            revision: 0,
            name: "Invalid copy",
            revision_id: originalRevision.id,
          },
          roles.editor,
          400,
        );
      }
    },
  );
  await check(
    "restore accepts exactly one same-pipeline immutable source, never submitted configuration bytes",
    async () => {
      for (const input of [
        {},
        { revision_id: originalRevision.id, version_id: published.id },
        { revision_id: foreignRevision.id },
        { version_id: foreignVersion.id },
        { revision_id: null },
      ])
        await call(
          "POST",
          `/configurations/${current.id}/restore`,
          { revision: current.revision, ...input },
          roles.editor,
          400,
        );
      await call(
        "GET",
        `/configurations/${current.id}/revisions/${foreignRevision.id}`,
        undefined,
        roles.viewer,
        404,
      );
      const changedConfig = structuredClone(initialConfig);
      changedConfig.transforms.sample.rate = 20;
      current = (
        await call(
          "PUT",
          `/configurations/${current.id}/draft`,
          {
            revision: current.revision,
            name: "Current name retained",
            description: "Current description retained",
            config: changedConfig,
            graph: { nodes: [], edges: [] },
          },
          roles.editor,
        )
      ).body;
      const before = current.revision;
      current = (
        await call(
          "POST",
          `/configurations/${current.id}/restore`,
          {
            revision: current.revision,
            revision_id: originalRevision.id,
            config: { malicious_client_override: true },
            message: "Restore original revision",
          },
          roles.editor,
        )
      ).body;
      assert.equal(current.revision, before + 1);
      assert.equal(current.name, "Current name retained");
      assert.equal(current.description, "Current description retained");
      assert.deepEqual(current.config, original.config);
      assert.deepEqual(current.graph, original.graph);
      const latest = (
        await call(
          "GET",
          `/configurations/${current.id}/history?kind=revisions&page=1&page_size=12`,
          undefined,
          admin,
        )
      ).body.items[0];
      assert.deepEqual(latest.source, {
        kind: "revision",
        id: originalRevision.id,
      });
      assert.equal(latest.author_id, roles.editor.user.id);
      current = (
        await call(
          "POST",
          `/configurations/${current.id}/restore`,
          { revision: current.revision, version_id: published.id },
          roles.editor,
        )
      ).body;
      assert.deepEqual(current.config, published.config);
    },
  );
  await check(
    "duplicate creates an independent revision-one draft with provenance and no inherited versions or bindings",
    async () => {
      const copy = (
        await call(
          "POST",
          `/configurations/${current.id}/duplicate`,
          {
            revision: current.revision,
            name: "Synthetic independent duplicate",
            description: "Copy description",
          },
          roles.editor,
        )
      ).body;
      assert.notEqual(copy.id, current.id);
      assert.equal(copy.revision, 1);
      assert.equal(copy.archived, false);
      assert.deepEqual(copy.config, current.config);
      assert.deepEqual(copy.graph, current.graph);
      assert.deepEqual(
        (
          await call(
            "GET",
            `/configurations/${copy.id}/versions`,
            undefined,
            admin,
          )
        ).body,
        [],
      );
      const copyHistory = (
        await call(
          "GET",
          `/configurations/${copy.id}/history?kind=revisions`,
          undefined,
          admin,
        )
      ).body;
      assert.equal(copyHistory.total, 1);
      assert.deepEqual(copyHistory.items[0].source, {
        kind: "draft",
        id: current.id,
        revision: current.revision,
      });
      assert.equal(
        db
          .prepare("SELECT count(*) total FROM records WHERE kind='deployment'")
          .get().total,
        1,
      );
      assert.deepEqual(bindings(), baselineBindings);
    },
  );
  await check(
    "archiving freezes edits and publication while retaining immutable history and assignments",
    async () => {
      const beforeRevision = current.revision;
      current = (
        await call(
          "POST",
          `/configurations/${current.id}/archive`,
          { revision: current.revision },
          roles.editor,
        )
      ).body;
      assert.equal(current.archived, true);
      assert(current.archived_at);
      assert.equal(current.revision, beforeRevision + 1);
      await call(
        "PUT",
        `/configurations/${current.id}/draft`,
        { revision: current.revision, config: initialConfig, graph },
        roles.editor,
        409,
      );
      await call(
        "POST",
        `/configurations/${current.id}/restore`,
        { revision: current.revision, version_id: published.id },
        roles.editor,
        409,
      );
      await call(
        "POST",
        `/configurations/${current.id}/publish`,
        { revision: current.revision },
        roles.operator,
        409,
      );
      await call(
        "POST",
        `/configurations/${current.id}/archive`,
        { revision: current.revision },
        roles.editor,
        409,
      );
      const readable = (
        await call("GET", `/versions/${published.id}`, undefined, roles.viewer)
      ).body;
      assert.deepEqual(readable, published);
      assert.equal(sha(readable.artifact), published.sha256);
      assert.equal(
        db
          .prepare("SELECT data FROM records WHERE kind='version' AND id=?")
          .get(published.id).data,
        immutable,
      );
      assert.deepEqual(bindings(), baselineBindings);
      assert.equal(
        (
          await call(
            "GET",
            `/deployments/${deployment.id}`,
            undefined,
            roles.viewer,
          )
        ).body.version_id,
        published.id,
      );
    },
  );
  await check(
    "published archived versions remain deployable and archived drafts can be copied",
    async () => {
      const copy = (
        await call(
          "POST",
          `/configurations/${current.id}/duplicate`,
          { revision: current.revision, name: "Synthetic copy of archive" },
          roles.editor,
        )
      ).body;
      assert.equal(copy.archived, false);
      assert.equal(copy.revision, 1);
      const result = (
        await call(
          "POST",
          "/deployments",
          { ...deploymentRequest, priority: 11 },
          roles.operator,
        )
      ).body;
      assert.equal(result.version_id, published.id);
      // Deploying already released identical immutable bytes does not need a new generation.
      assert.equal(
        bindings()[0].desired_generation,
        baselineBindings[0].desired_generation,
      );
      const before = current.revision;
      current = (
        await call(
          "POST",
          `/configurations/${current.id}/unarchive`,
          { revision: current.revision },
          roles.editor,
        )
      ).body;
      assert.equal(current.archived, false);
      assert.equal(current.archived_at, null);
      assert.equal(current.revision, before + 1);
      current = (
        await call(
          "PUT",
          `/configurations/${current.id}/draft`,
          { revision: current.revision, config: initialConfig, graph },
          roles.editor,
        )
      ).body;
    },
  );
  await check(
    "metadata history is paginated and excludes full artifacts; full revision detail remains parent-bound",
    async () => {
      for (let index = 0; index < 13; index++)
        current = (
          await call(
            "PUT",
            `/configurations/${current.id}/draft`,
            {
              revision: current.revision,
              config: initialConfig,
              graph,
              message: `Synthetic pagination ${index}`,
            },
            roles.editor,
          )
        ).body;
      const first = (
        await call(
          "GET",
          `/configurations/${current.id}/history?kind=revisions&page=1&page_size=12`,
          undefined,
          roles.viewer,
        )
      ).body;
      const next = (
        await call(
          "GET",
          `/configurations/${current.id}/history?kind=revisions&page=2&page_size=12`,
          undefined,
          roles.viewer,
        )
      ).body;
      assert.equal(first.items.length, 12);
      assert.equal(first.total, revisionCount(current.id));
      assert(next.items.length > 0);
      assert.equal(
        new Set([...first.items, ...next.items].map((item) => item.id)).size,
        first.items.length + next.items.length,
      );
      for (const item of [...first.items, ...next.items])
        for (const forbidden of ["config", "graph", "artifact", "validation"])
          assert.equal(Object.hasOwn(item, forbidden), false);
      assert(
        first.items.every(
          (item, index, list) =>
            !index || list[index - 1].revision > item.revision,
        ),
      );
      const detail = (
        await call(
          "GET",
          `/configurations/${current.id}/revisions/${originalRevision.id}`,
          undefined,
          roles.viewer,
        )
      ).body;
      assert.deepEqual(detail.config, original.config);
      assert.deepEqual(detail.graph, original.graph);
      for (const query of [
        "page=0",
        "page_size=0",
        "page_size=51",
        "kind=devices",
        "page=18446744073709551615&page_size=50",
      ])
        await call(
          "GET",
          `/configurations/${current.id}/history?${query}`,
          undefined,
          roles.viewer,
          400,
        );
      await call(
        "GET",
        `/configurations/${current.id}/history`,
        undefined,
        undefined,
        401,
      );
    },
  );
  await check(
    "historical sources and runtime generations survive all draft lifecycle operations",
    async () => {
      const latestBinding = bindings()[0];
      assert.equal(latestBinding.desired_version_id, published.id);
      assert.equal(
        latestBinding.desired_generation,
        baselineBindings[0].desired_generation,
      );
      assert.equal(
        latestBinding.policy_generation,
        baselineBindings[0].policy_generation,
      );
      assert.equal(
        db
          .prepare("SELECT data FROM records WHERE kind='version' AND id=?")
          .get(published.id).data,
        immutable,
      );
      const savedOriginal = (
        await call(
          "GET",
          `/configurations/${current.id}/revisions/${originalRevision.id}`,
          undefined,
          admin,
        )
      ).body;
      assert.equal(savedOriginal.revision, 1);
      assert.deepEqual(savedOriginal.config, original.config);
      assert.equal(savedOriginal.name, original.name);
    },
  );
  evidence.passed = true;
} finally {
  db?.close();
  await stop();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith("vectory-pipeline-review-"));
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
      process.env.VECTORY_PIPELINE_EVIDENCE ||
        path.join(root, "docs/evidence/pipeline-review.json"),
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
}
