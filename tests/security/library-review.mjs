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
  process.env.VECTORY_LIBRARY_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-library-review-"),
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
    "Independent real HTTP library query checks against disposable development state. Synthetic large configuration/version records exercise metadata projections and bounds; no native execution claim.",
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
        current_password: password,
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
  const marker =
    "PRIVATE_BODY_MUST_NOT_APPEAR_" + randomBytes(12).toString("hex");
  const fixtures = [];
  const insert = db.prepare(
    "INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)",
  );
  for (let index = 0; index < 120; index++) {
    const time = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    const item = {
      id: randomUUID(),
      name: `Synthetic ${String(index).padStart(3, "0")}`,
      description:
        index === 7
          ? "Literal %_[]\\quote' token and Café"
          : "Synthetic metadata fixture",
      revision: index + 1,
      created_at: time,
      updated_at: time,
      archived: index % 3 === 0,
      archived_at: index % 3 === 0 ? time : null,
      config: {
        sources: {
          logs: { type: "demo_logs", future: marker + "x".repeat(32768) },
        },
        transforms: {},
        sinks: { discard: { type: "blackhole", inputs: ["logs"] } },
      },
      graph: { nodes: [{ id: marker }], edges: [] },
    };
    insert.run("configuration", item.id, JSON.stringify(item), time);
    fixtures.push(item);
  }
  const selected = fixtures[7];
  const versionIds = new Map();
  // The last version's number is text, so it can only ever project as 0.
  for (const number of [2, 11, 3, marker]) {
    const version = {
      id: randomUUID(),
      configuration_id: selected.id,
      number,
      created_at: selected.created_at,
      config: selected.config,
      graph: selected.graph,
      artifact: marker.repeat(2048),
      validation: { output: marker },
    };
    insert.run(
      "version",
      version.id,
      JSON.stringify(version),
      version.created_at,
    );
    if (number === 11) selected.expectedLatest = version.id;
    versionIds.set(number, version.id);
  }
  // Devices report the version they last verified. Only live devices whose
  // verified version belongs to this pipeline count, once per version.
  const insertDevice = db.prepare(
    "INSERT INTO devices(id,name,data,revoked) VALUES(?,?,?,?)",
  );
  const device = (index, verified, revoked = 0) => {
    const id = randomUUID();
    insertDevice.run(
      id,
      `Synthetic library device ${index}`,
      JSON.stringify({
        id,
        name: `Synthetic library device ${index}`,
        status: "online",
        verified_configuration_attempt: verified,
        private: marker,
      }),
      revoked,
    );
  };
  const verified = (version_id) => ({
    version_id,
    generation: 1,
    state: "verified_applied",
    private: marker,
  });
  device(1, verified(versionIds.get(2)));
  device(2, verified(versionIds.get(2)));
  device(3, verified(versionIds.get(11)));
  device(4, verified(versionIds.get(marker)));
  // Not counted: a revoked device, an unknown version, a wrong type, no report.
  device(5, verified(versionIds.get(3)), 1);
  device(6, verified(randomUUID()));
  device(7, verified({ private: marker }));
  device(8, undefined);
  const expectedRunning = [
    { id: versionIds.get(11), number: 11, devices: 1 },
    { id: versionIds.get(2), number: 2, devices: 2 },
    { id: versionIds.get(marker), number: 0, devices: 1 },
  ];
  const projectionKeys = [
    "id",
    "name",
    "description",
    "revision",
    "created_at",
    "updated_at",
    "archived",
    "archived_at",
    "component_counts",
    "latest_version",
    "assigned_devices",
    "running_versions",
  ].sort();
  const uuidShape =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  // The versions of a pipeline that live devices verified: an id, a number and
  // a device count each, newest first, and nothing about the devices.
  function running(items) {
    assert(Array.isArray(items));
    for (const entry of items) {
      assert.deepEqual(Object.keys(entry).sort(), ["devices", "id", "number"]);
      assert(uuidShape.test(entry.id));
      assert(Number.isSafeInteger(entry.number) && entry.number >= 0);
      assert(Number.isSafeInteger(entry.devices) && entry.devices >= 1);
    }
    assert.deepEqual(
      items.map((entry) => [entry.number, entry.id]),
      [...items]
        .sort((a, b) => b.number - a.number || (a.id < b.id ? -1 : 1))
        .map((entry) => [entry.number, entry.id]),
    );
  }
  function projection(page) {
    assert(page.items.length <= 50);
    assert(!JSON.stringify(page).includes(marker));
    for (const item of page.items) {
      assert.deepEqual(Object.keys(item).sort(), projectionKeys);
      assert.deepEqual(item.component_counts, {
        sources: 1,
        transforms: 0,
        sinks: 1,
      });
      assert(Number.isSafeInteger(item.assigned_devices));
      assert(item.assigned_devices >= 0);
      running(item.running_versions);
      if (item.latest_version) {
        assert.deepEqual(Object.keys(item.latest_version).sort(), [
          "author",
          "created_at",
          "draft_changed",
          "id",
          "number",
        ]);
        assert.equal(typeof item.latest_version.draft_changed, "boolean");
        assert(
          item.latest_version.author === null ||
            item.latest_version.author.length <= 240,
        );
      }
    }
  }
  const route = (values) =>
    "/configurations/library?" + new URLSearchParams(values);
  await check(
    "authentication is required and every workspace role receives metadata only",
    async () => {
      await call("GET", "/configurations/library", undefined, undefined, 401);
      for (const session of [admin, ...Object.values(roles)]) {
        const result = (
          await call("GET", "/configurations/library", undefined, session)
        ).body;
        assert.equal(result.total, 80);
        assert.equal(result.page_size, 12);
        assert.equal(result.items.length, 12);
        projection(result);
      }
    },
  );
  await check(
    "bounded pages preserve exact counts, stable ordering and last-page boundaries",
    async () => {
      const all = [];
      for (let page = 1; page <= 4; page++) {
        const result = (
          await call(
            "GET",
            route({ state: "all", sort: "name", page, page_size: 50 }),
            undefined,
            admin,
          )
        ).body;
        assert.equal(result.total, 120);
        assert.equal(result.page, page);
        projection(result);
        assert.equal(result.items.length, [50, 50, 20, 0][page - 1]);
        all.push(...result.items.map((x) => x.id));
        assert(Buffer.byteLength(JSON.stringify(result)) < 100000);
      }
      assert.deepEqual(
        all,
        fixtures.map((x) => x.id),
      );
      assert.equal(new Set(all).size, 120);
      for (const [stateName, count] of [
        ["active", 80],
        ["archived", 40],
      ]) {
        const result = (
          await call(
            "GET",
            route({ state: stateName, page_size: 50 }),
            undefined,
            admin,
          )
        ).body;
        assert.equal(result.total, count);
        assert(
          result.items.every((x) => x.archived === (stateName === "archived")),
        );
        projection(result);
      }
    },
  );
  await check(
    "literal substring search cannot inject SQL, wildcard matches or inspect body fields",
    async () => {
      for (const search of ["%_[]\\quote'", "SYNTHETIC 007", "Café"]) {
        const result = (
          await call("GET", route({ state: "all", search }), undefined, admin)
        ).body;
        assert.equal(result.total, 1);
        assert.equal(result.items[0].id, selected.id);
        projection(result);
      }
      for (const search of ["' OR 1=1 --", "Synthetic%", marker]) {
        const result = (
          await call("GET", route({ state: "all", search }), undefined, admin)
        ).body;
        assert.equal(result.total, 0);
        assert.deepEqual(result.items, []);
      }
    },
  );
  await check(
    "latest version summary stays parent-bound, numeric and free of immutable payloads",
    async () => {
      const result = (
        await call(
          "GET",
          route({ state: "all", search: "Synthetic 007" }),
          undefined,
          admin,
        )
      ).body;
      assert.equal(result.items[0].latest_version.id, selected.expectedLatest);
      assert.equal(result.items[0].latest_version.number, 11);
      projection(result);
      const other = (
        await call(
          "GET",
          route({ state: "all", search: "Synthetic 008" }),
          undefined,
          admin,
        )
      ).body;
      assert.equal(other.items[0].latest_version, null);
      // Running versions come only from live devices' verified versions of
      // this pipeline; a pipeline nothing runs reports none.
      assert.deepEqual(result.items[0].running_versions, expectedRunning);
      assert.deepEqual(other.items[0].running_versions, []);
      assert.equal(result.items[0].assigned_devices, 0);
      const detail = (
        await call("GET", `/configurations/${selected.id}`, undefined, admin)
      ).body;
      assert(detail.config.sources.logs.future.startsWith(marker));
    },
  );
  await check(
    "malformed, oversized, duplicate and unknown query parameters fail closed",
    async () => {
      const bad = [
        "page=0",
        "page=-1",
        "page=1.5",
        "page=18446744073709551616",
        "page=18446744073709551615&page_size=50",
        "page=9007199254740992&page_size=1",
        "page_size=0",
        "page_size=51",
        "state=ACTIVE",
        "state=deleted",
        "sort=created",
        "sort=name;DROP TABLE records",
        "page=1&page=2",
        "include=config",
        "search=" + "a".repeat(201),
        "search=" + encodeURIComponent("é".repeat(201)),
        "search=" + encodeURIComponent("😀".repeat(201)),
      ];
      for (const query of bad)
        await call(
          "GET",
          "/configurations/library?" + query,
          undefined,
          admin,
          400,
        );
      assert.equal(
        (
          await call(
            "GET",
            route({ state: "all", search: "a".repeat(200) }),
            undefined,
            admin,
          )
        ).body.total,
        0,
      );
      assert.equal(
        (
          await call(
            "GET",
            route({ state: "all", search: "😀".repeat(200) }),
            undefined,
            admin,
          )
        ).body.total,
        0,
      );
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM records WHERE kind='configuration'",
          )
          .get().n,
        120,
      );
    },
  );
  await check(
    "offboarding invalidates library access without changing metadata records",
    async () => {
      const viewer = (await call("GET", "/users", undefined, admin)).body.find(
        (x) => x.id === roles.viewer.user.id,
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
      await call(
        "GET",
        "/configurations/library",
        undefined,
        roles.viewer,
        401,
      );
      assert.equal(
        (await call("GET", route({ state: "all" }), undefined, admin)).body
          .total,
        120,
      );
    },
  );
  evidence.synthetic_configurations = 120;
  evidence.configuration_body_bytes_each = 32768;
  evidence.passed = true;
} finally {
  db?.close();
  await stop();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith("vectory-library-review-"));
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
      process.env.VECTORY_LIBRARY_EVIDENCE ||
        path.join(root, "docs/evidence/library-review.json"),
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
}
