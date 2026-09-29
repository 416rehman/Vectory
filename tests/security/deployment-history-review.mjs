// Independent bounded-query checks against disposable HTTP state.
// Large fixtures are explicitly synthetic; no ordinary product fleet data is seeded.
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
  process.env.VECTORY_DEPLOYMENT_HISTORY_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-deployment-history-review-"),
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
    "Independent real HTTP deployment-history query checks against disposable development state. Synthetic deployment, target and immutable-version records exercise metadata projections, identity binding and bounds; no native execution claim.",
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
      throw Error("Disposable deployment history server did not start");
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
    const responseText = await response.text();
    let body;
    try {
      body = JSON.parse(responseText);
    } catch {
      body = { text: responseText };
    }
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
    name: "Synthetic deployment history administrator",
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
  db = new DatabaseSync(path.join(state, "vectory.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const marker = "PRIVATE_BODY_" + randomBytes(12).toString("hex");
  const insert = db.prepare(
    "INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)",
  );
  function record(kind, value) {
    insert.run(kind, value.id, JSON.stringify(value), value.created_at);
    return value;
  }
  const configurations = Array.from({ length: 3 }, (_, index) =>
    record("configuration", {
      id: randomUUID(),
      name: `Synthetic pipeline ${index}`,
      description: marker,
      revision: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      config: { private: marker + "x".repeat(32768) },
      graph: { nodes: [{ id: marker }], edges: [] },
    }),
  );
  const deployments = [],
    versions = [];
  const statuses = [
    "unassigned",
    "missed",
    "cancelled",
    "completed",
    "failed",
    "paused",
    "scheduled",
  ];
  for (let index = 0; index < 223; index++) {
    // Paired timestamps exercise the deterministic id tie-breaker.
    const time = new Date(
      Date.UTC(2026, 0, 1, 0, Math.floor(index / 2)),
    ).toISOString();
    const version = record("version", {
      id: randomUUID(),
      configuration_id: configurations[index % 3].id,
      number: index + 1,
      created_at: time,
      config: { private: marker + "v".repeat(8192) },
      graph: { private: marker },
      artifact: marker.repeat(512),
      validation: { output: marker },
    });
    versions.push(version);
    const policy = index % 20 === 0;
    const status = statuses[index % statuses.length];
    deployments.push(
      record("deployment", {
        id: randomUUID(),
        name:
          index === 219
            ? "Oversized legacy name " + "x".repeat(65536) + marker
            : index === 221
              ? { private: marker }
              : index === 7
                ? "Literal %_[]\\quote' Caf\u00e9"
                : `Synthetic deployment ${String(index).padStart(3, "0")}`,
        version_id: policy
          ? index === 220
            ? { private: marker }
            : null
          : version.id,
        policy: policy
          ? {
              heartbeat_seconds: 90,
              sync_paused: index % 40 === 0,
              telemetry_enabled: true,
              private: marker,
            }
          : null,
        selector: {
          device_ids:
            index === 0 ? Array.from({ length: 5000 }, () => randomUUID()) : [],
          group_ids: [],
          exclude_ids: [],
          private: marker,
        },
        priority: index,
        target_mode: "snapshot",
        status,
        scheduled_at:
          status === "scheduled" || index % 2 === 0
            ? "2099-01-01T00:00:00Z"
            : null,
        created_at: time,
        rollout: {
          kind: "canary",
          canary_size: 1,
          batch_size: 10,
          observation_seconds: 60,
          failure_threshold: 0,
          private: marker,
        },
        private: marker,
      }),
    );
  }
  // The populated target parent is terminal, so background scheduling cannot mutate the fixture.
  const parent = deployments[0],
    otherParent = deployments[7];
  assert.equal(parent.status, "unassigned");
  assert.equal(otherParent.status, "unassigned");
  const targetStates = [
    "pending",
    "desired",
    "downloaded",
    "validated",
    "verified_applied",
    "verification_unknown",
    "failed",
    "rolled_back",
    "removed",
    "future_state",
  ];
  const targets = [];
  const insertDevice = db.prepare(
    "INSERT INTO devices(id,name,data,revoked) VALUES(?,?,?,?)",
  );
  const insertTarget = db.prepare(
    "INSERT INTO deployment_targets(deployment_id,device_id,state,generation,error,original) VALUES(?,?,?,?,?,?)",
  );
  for (let index = 0; index < 151; index++) {
    const device = {
      id: randomUUID(),
      name:
        index === 9
          ? "Literal %_[]\\target'"
          : `Synthetic device ${String(index).padStart(3, "0")}`,
      os: "windows",
      arch: "amd64",
      agent_version: "synthetic",
      vector_version: "0.58.0",
      configuration_mode: "restricted",
      status: "unmanaged",
      apply_state: "unmanaged",
      reported_generation: 0,
      created_at: "2026-01-01T00:00:00Z",
      private: marker,
    };
    insertDevice.run(
      device.id,
      device.name,
      JSON.stringify(device),
      index % 13 === 0 ? 1 : 0,
    );
    const target = {
      device_id: device.id,
      device_name: device.name,
      state: targetStates[index % targetStates.length],
      generation: index,
      error: index % 7 === 0 ? "Synthetic observed failure" : null,
      original: index % 3 !== 0,
    };
    insertTarget.run(
      parent.id,
      device.id,
      target.state,
      target.generation,
      target.error,
      target.original ? 1 : 0,
    );
    targets.push(target);
    if (index < 37)
      insertTarget.run(
        otherParent.id,
        device.id,
        "failed",
        8000 + index,
        "Other parent synthetic failure",
        1,
      );
  }
  // A reused display name must never move historical progress to a new identity.
  const retired = targets[0];
  const reusedName = retired.device_name;
  retired.device_name = `${reusedName}#retired-${retired.device_id}`;
  db.prepare(
    "UPDATE devices SET name=?,data=json_set(data,'$.name',?) WHERE id=?",
  ).run(retired.device_name, retired.device_name, retired.device_id);
  const replacementId = randomUUID();
  insertDevice.run(
    replacementId,
    reusedName,
    JSON.stringify({
      id: replacementId,
      name: reusedName,
      status: "unmanaged",
      apply_state: "unmanaged",
      vector_version: "0.58.0",
      private: marker,
    }),
    0,
  );
  const summaryKeys = [
    "id",
    "name",
    "configuration_id",
    "configuration_name",
    "version_id",
    "version_number",
    "policy",
    "priority",
    "target_mode",
    "status",
    "scheduled_at",
    "created_at",
    "rollout",
    "target_count",
    "verified_count",
    "state_counts",
  ].sort();
  const targetKeys = [
    "device_id",
    "device_name",
    "state",
    "generation",
    "error",
    "original",
  ].sort();
  const route = (query = {}) =>
    "/deployments/history?" + new URLSearchParams(query);
  const targetRoute = (id, query = {}) =>
    `/deployments/${id}/targets?` + new URLSearchParams(query);
  function summary(value) {
    assert.deepEqual(Object.keys(value).sort(), summaryKeys);
    assert(!JSON.stringify(value).includes(marker));
    assert(value.name === null || typeof value.name === "string");
    if (typeof value.name === "string") assert([...value.name].length <= 120);
    assert(value.version_id === null || typeof value.version_id === "string");
    assert.deepEqual(Object.keys(value.rollout).sort(), [
      "batch_size",
      "canary_size",
      "failure_threshold",
      "kind",
      "observation_seconds",
    ]);
    if (value.policy)
      assert.deepEqual(Object.keys(value.policy).sort(), [
        "heartbeat_seconds",
        "sync_paused",
        "telemetry_enabled",
      ]);
    assert.equal(
      Object.values(value.state_counts).reduce((sum, n) => sum + n, 0),
      value.target_count,
    );
    assert.equal(
      value.verified_count,
      value.state_counts.verified_applied || 0,
    );
  }
  function pageEnvelope(value, expectedKeys) {
    // DeploymentHistoryPage may advertise actor-scoped request discovery.
    const { request_history, ...envelope } = value;
    assert([undefined, true].includes(request_history));
    assert.deepEqual(Object.keys(envelope).sort(), [
      "items",
      "page",
      "page_size",
      "total",
    ]);
    assert(value.items.length <= 50);
    assert(!JSON.stringify(value).includes(marker));
    for (const item of value.items)
      assert.deepEqual(Object.keys(item).sort(), expectedKeys);
  }
  const get = async (url, session = admin, expected = 200) =>
    (await call("GET", url, undefined, session, expected)).body;
  const historicalSnapshot = () =>
    sha(
      JSON.stringify({
        deployments: db
          .prepare(
            "SELECT id,data FROM records WHERE kind='deployment' ORDER BY id",
          )
          .all(),
        targets: db
          .prepare(
            "SELECT * FROM deployment_targets ORDER BY deployment_id,device_id",
          )
          .all(),
        devices: db
          .prepare(
            "SELECT id,name,desired_generation,policy_generation,assignment_id,policy_assignment_id,revoked FROM devices ORDER BY id",
          )
          .all(),
        audits: db
          .prepare("SELECT id,data FROM records WHERE kind='audit' ORDER BY id")
          .all(),
      }),
    );
  const before = historicalSnapshot();
  await check(
    "all read surfaces require authentication and return only bounded projections for every workspace role",
    async () => {
      for (const url of [
        route(),
        `/deployments/${parent.id}/summary`,
        targetRoute(parent.id),
        `/deployments/${randomUUID()}/summary`,
      ])
        await call("GET", url, undefined, undefined, 401);
      for (const session of [admin, ...Object.values(roles)]) {
        const result = await get(route(), session);
        assert.equal(result.total, deployments.length);
        assert.equal(result.page_size, 12);
        assert.equal(result.items.length, 12);
        pageEnvelope(result, summaryKeys);
        result.items.forEach(summary);
        summary(await get(`/deployments/${parent.id}/summary`, session));
        pageEnvelope(await get(targetRoute(parent.id), session), targetKeys);
      }
      await get(`/deployments/${randomUUID()}/summary`, admin, 404);
      await get(targetRoute(randomUUID()), admin, 404);
    },
  );
  await check(
    "history pages cover more than 200 versions with stable bounds and exact metadata",
    async () => {
      const ordered = [...deployments].sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
      );
      const seen = [];
      let largest = 0;
      for (let page = 1; page <= 6; page++) {
        const result = await get(route({ page, page_size: 50 }));
        pageEnvelope(result, summaryKeys);
        assert.equal(result.total, deployments.length);
        assert.equal(result.page, page);
        assert.equal(result.items.length, [50, 50, 50, 50, 23, 0][page - 1]);
        largest = Math.max(largest, Buffer.byteLength(JSON.stringify(result)));
        result.items.forEach((item) => {
          summary(item);
          const original = deployments.find((d) => d.id === item.id);
          assert.equal(
            item.name,
            typeof original.name === "string"
              ? [...original.name].slice(0, 120).join("")
              : null,
          );
          if (original.policy) {
            assert.equal(item.version_number, null);
            assert.equal(item.configuration_name, null);
          } else {
            const version = versions.find((v) => v.id === original.version_id);
            assert.equal(item.version_number, version.number);
            assert.equal(item.configuration_id, version.configuration_id);
            assert.equal(
              item.configuration_name,
              configurations.find((c) => c.id === version.configuration_id)
                .name,
            );
          }
        });
        seen.push(...result.items.map((item) => item.id));
      }
      assert.deepEqual(
        seen,
        ordered.map((item) => item.id),
      );
      assert.equal(new Set(seen).size, deployments.length);
      assert(largest < 100000);
      evidence.largest_50_summary_page_bytes = largest;
    },
  );
  await check(
    "schedule presence and deployment status remain independent historical filters",
    async () => {
      for (const scheduled of [true, false]) {
        const expected = deployments.filter(
          (d) => !!d.scheduled_at === scheduled,
        );
        const result = await get(route({ scheduled, page_size: 50 }));
        assert.equal(result.total, expected.length);
        assert(result.items.every((d) => !!d.scheduled_at === scheduled));
      }
      for (const status of [...statuses, "active"]) {
        const result = await get(route({ status, page_size: 50 }));
        assert.equal(
          result.total,
          deployments.filter((d) => d.status === status).length,
        );
        assert(result.items.every((d) => d.status === status));
        const scheduled = await get(
          route({ status, scheduled: true, page_size: 50 }),
        );
        assert.equal(
          scheduled.total,
          deployments.filter((d) => d.status === status && d.scheduled_at)
            .length,
        );
      }
    },
  );
  await check(
    "literal and Unicode searches inspect advertised metadata, never selector or configuration bodies",
    async () => {
      for (const search of [
        "%_[]\\quote'",
        "Caf\u00e9",
        "SYNTHETIC DEPLOYMENT 222",
      ]) {
        const result = await get(route({ search }));
        assert.equal(result.total, 1);
        assert.equal(
          result.items[0].id,
          search.includes("222") ? deployments[222].id : deployments[7].id,
        );
      }
      assert.equal(
        (await get(route({ search: configurations[0].name }))).total,
        deployments.filter(
          (d) =>
            typeof d.version_id === "string" &&
            versions.find((v) => v.id === d.version_id).configuration_id ===
              configurations[0].id,
        ).length,
      );
      for (const search of [
        marker,
        "' OR 1=1 --",
        "Synthetic%",
        parent.selector.device_ids[0],
      ]) {
        const result = await get(route({ search }));
        assert.equal(result.total, 0);
        assert.deepEqual(result.items, []);
      }
      assert.equal(
        (await get(route({ search: "Sync paused" }))).total,
        deployments.filter((d) => d.policy?.sync_paused).length,
      );
      for (const search of [
        "90s heartbeat, Sync paused",
        "90s heartbeat Sync paused",
        "90s heartbeat, Pause sync",
      ]) {
        assert.equal(
          (await get(route({ search }))).total,
          deployments.filter((d) => d.policy?.sync_paused).length,
        );
      }
      assert.equal(
        (await get(route({ search: "Version 223" }))).items[0].version_id,
        versions[222].id,
      );
      for (const search of ["a".repeat(200), "\u{1f600}".repeat(200)])
        assert.equal((await get(route({ search }))).total, 0);
    },
  );
  await check(
    "parent-bound targets retain complete historical counts without leaking device records or cross-parent state",
    async () => {
      const metadata = await get(`/deployments/${parent.id}/summary`);
      summary(metadata);
      assert.equal(metadata.target_count, 151);
      assert.equal(
        metadata.verified_count,
        targets.filter((t) => t.state === "verified_applied").length,
      );
      assert.equal(
        metadata.state_counts.removed,
        targets.filter((t) => t.state === "removed").length,
      );
      const seen = [];
      for (let page = 1; page <= 5; page++) {
        const result = await get(
          targetRoute(parent.id, { page, page_size: 50 }),
        );
        pageEnvelope(result, targetKeys);
        assert.equal(result.total, 151);
        assert.equal(result.items.length, [50, 50, 50, 1, 0][page - 1]);
        assert(Buffer.byteLength(JSON.stringify(result)) < 40000);
        for (const target of result.items) {
          const expected = targets.find(
            (t) => t.device_id === target.device_id,
          );
          assert.deepEqual(target, expected);
          seen.push(target.device_id);
        }
      }
      assert.equal(new Set(seen).size, 151);
      const targetOrder = [...targets].sort((a, b) => {
        const left = a.device_name.toLowerCase(),
          right = b.device_name.toLowerCase();
        return (
          (left < right ? -1 : left > right ? 1 : 0) ||
          a.device_id.localeCompare(b.device_id)
        );
      });
      assert.deepEqual(
        seen,
        targetOrder.map((target) => target.device_id),
      );
      assert(!seen.includes(replacementId));
      assert.equal(
        (await get(targetRoute(parent.id, { search: reusedName }))).items[0]
          .device_id,
        retired.device_id,
      );
      assert.equal(
        (await get(targetRoute(parent.id, { search: replacementId }))).total,
        0,
      );
      const foreign = await get(targetRoute(otherParent.id, { page_size: 50 }));
      assert.equal(foreign.total, 37);
      assert(
        foreign.items.every(
          (t) => t.state === "failed" && t.generation >= 8000,
        ),
      );
      for (const state of targetStates) {
        const result = await get(
          targetRoute(parent.id, { state, page_size: 50 }),
        );
        assert.equal(
          result.total,
          targets.filter((t) => t.state === state).length,
        );
        assert(result.items.every((t) => t.state === state));
      }
      const target = targets[9];
      for (const search of [target.device_id, "%_[]\\target'"]) {
        const result = await get(targetRoute(parent.id, { search }));
        assert.equal(result.total, 1);
        assert.deepEqual(result.items[0], target);
      }
      for (const search of [
        marker,
        "' OR 1=1 --",
        "Synthetic%",
        "Synthetic observed failure",
      ])
        assert.equal((await get(targetRoute(parent.id, { search }))).total, 0);
    },
  );
  await check(
    "malformed, duplicate, overflow and unknown query fields fail closed on both surfaces",
    async () => {
      const common = [
        "page=0",
        "page=-1",
        "page=1.5",
        "page=9007199254740992",
        "page=18446744073709551616",
        "page_size=0",
        "page_size=51",
        "page=1&page=2",
        "search=a&search=b",
        "include=config",
        "search=%",
        "search=%GG",
        "search=%FF",
        "page=1&%70age=2",
        "search=" + "a".repeat(201),
        "search=" + encodeURIComponent("\u{1f600}".repeat(201)),
      ];
      for (const query of common) {
        await get("/deployments/history?" + query, admin, 400);
        await get(`/deployments/${parent.id}/targets?` + query, admin, 400);
      }
      for (const query of [
        "status=unknown",
        "status=ACTIVE",
        "status=all&status=failed",
        "scheduled=1",
        "scheduled=TRUE",
        "scheduled=true&scheduled=false",
        "state=failed",
        "sort=name",
      ])
        await get("/deployments/history?" + query, admin, 400);
      for (const query of [
        "state=" + "a".repeat(65),
        "state=%27%20OR%201%3D1",
        "state=failed&state=pending",
        "state=%C3%A9",
        "scheduled=true",
        "status=failed",
      ])
        await get(`/deployments/${parent.id}/targets?` + query, admin, 400);
      await get(`/deployments/${parent.id}/summary?include=config`, admin, 400);
      await get(`/deployments/${parent.id}/summary?page=1`, admin, 400);
      assert.equal(
        (await get(targetRoute(parent.id, { state: "unknown_future_state" })))
          .total,
        0,
      );
      assert.equal(
        historicalSnapshot(),
        before,
        "Read-only history queries must not alter assignments, generations, targets or audit history",
      );
    },
  );
  await check(
    "future name input is bounded for both preview and creation while legacy full detail remains compatible",
    async () => {
      const policy = {
        heartbeat_seconds: 60,
        sync_paused: false,
        telemetry_enabled: true,
      };
      const request = {
        policy,
        selector: { device_ids: [], group_ids: [], exclude_ids: [] },
        priority: 1,
        target_mode: "snapshot",
        rollout: {
          kind: "all",
          canary_size: 1,
          batch_size: 10,
          observation_seconds: 0,
          failure_threshold: 0,
        },
      };
      for (const name of [
        42,
        true,
        {},
        [],
        "x".repeat(121),
        "\u{1f600}".repeat(121),
      ]) {
        for (const endpoint of ["/deployments/preview", "/deployments"])
          await call("POST", endpoint, { ...request, name }, admin, 400);
      }
      for (const name of [
        undefined,
        null,
        "",
        "x".repeat(120),
        "\u{1f600}".repeat(120),
      ]) {
        const result = await call(
          "POST",
          "/deployments/preview",
          { ...request, name },
          admin,
        );
        assert.deepEqual(result.body.devices, []);
      }
      const legacy = await get(`/deployments/${deployments[219].id}`);
      assert.equal(legacy.name, deployments[219].name);
      assert(legacy.name.endsWith(marker));
      assert.equal(
        (await get(`/deployments/${deployments[221].id}/summary`)).name,
        null,
      );
      assert.equal(
        (await get(`/deployments/${deployments[220].id}/summary`)).version_id,
        null,
      );
      assert.equal(
        historicalSnapshot(),
        before,
        "Rejected names and valid previews must not mutate historical or runtime state",
      );
    },
  );
  await check(
    "offboarding revokes all history surfaces while retaining immutable operational history",
    async () => {
      const viewer = (await get("/users")).find(
        (user) => user.id === roles.viewer.user.id,
      );
      await call(
        "PUT",
        `/users/${viewer.id}`,
        {
          name: viewer.name,
          role: viewer.role,
          enabled: false,
          revision: viewer.revision,
          current_password: password,
        },
        admin,
      );
      for (const url of [
        route(),
        `/deployments/${parent.id}/summary`,
        targetRoute(parent.id),
      ])
        await get(url, roles.viewer, 401);
      assert.equal((await get(route())).total, deployments.length);
      assert.equal(
        (await get(`/deployments/${parent.id}/summary`)).target_count,
        151,
      );
    },
  );
  evidence.synthetic_deployments = deployments.length;
  evidence.synthetic_versions = versions.length;
  evidence.synthetic_devices = targets.length + 1;
  evidence.synthetic_target_rows = targets.length + 37;
  evidence.passed = true;
} finally {
  db?.close();
  await stop();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(
    path.basename(temporary).startsWith("vectory-deployment-history-review-"),
  );
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
      process.env.VECTORY_DEPLOYMENT_HISTORY_EVIDENCE ||
        path.join(root, "docs/evidence/deployment-history-review.json"),
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
}
console.log(
  `Passed ${evidence.checks.length} independent deployment history checks.`,
);
