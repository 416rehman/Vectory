// Independent HTTP and SQLite checks on disposable, explicitly synthetic state.
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
  process.env.VECTORY_AUDIT_ORDER_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-audit-order-review-"),
);
await fs.chmod(temporary, 0o700);
const executable = path.join(temporary, path.basename(source));
await fs.copyFile(source, executable);
await fs.chmod(executable, 0o700);
const state = path.join(temporary, "state");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const evidence = {
  recorded_at: new Date().toISOString(),
  server_sha256: sha(await fs.readFile(executable)),
  scope:
    "Disposable real HTTP audit chronology checks with synthetic same-second events, migration backfill, transaction rollback and offline VACUUM/restart. Historical backfill uses the surviving insertion-order approximation; it cannot recover previously lost chronology.",
  checks: [],
};
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toUpperCase().startsWith("VECTORY_"),
  ),
);
const bootstrap = randomBytes(32).toString("hex");
let child, db, origin;
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
async function start() {
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
      throw Error("Disposable audit server did not start");
    await delay(50);
  }
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
function openDatabase() {
  db = new DatabaseSync(path.join(state, "vectory.db"));
  db.exec("PRAGMA busy_timeout=5000");
}
function insertAudit(event) {
  db.prepare(
    "INSERT INTO records(kind,id,data,created_at) VALUES('audit',?,?,?)",
  ).run(event.id, JSON.stringify(event), event.created_at);
}
const mapping = () =>
  db
    .prepare("SELECT sequence,audit_id FROM audit_sequence ORDER BY sequence")
    .all();
const records = () =>
  db
    .prepare(
      "SELECT id,data,created_at FROM records WHERE kind='audit' ORDER BY id",
    )
    .all();
async function call(method, route, body, session, expected = 200) {
  const response = await fetch(origin + "/api/v1" + route, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session
        ? { cookie: session.cookie, "x-csrf-token": session.csrf }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${route}: ${data.error?.code || response.status}`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  return {
    body: data,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
    csrf: data.csrf_token,
    user: data.user,
  };
}
async function check(name, test) {
  await test();
  evidence.checks.push({ name, passed: true });
  console.log("PASS", name);
}
try {
  origin = `http://127.0.0.1:${await freePort()}`;
  await start();
  const admin = await call("POST", "/bootstrap", {
    bootstrap_secret: bootstrap,
    name: "Synthetic chronology administrator",
    email: "admin@example.test",
    password: randomBytes(24).toString("base64url"),
  });
  const pipeline = (
    await call(
      "POST",
      "/configurations",
      {
        name: "Synthetic chronology pipeline",
        description: "Disposable fixture",
        config: {
          sources: { logs: { type: "demo_logs", format: "json" } },
          sinks: { out: { type: "blackhole", inputs: ["logs"] } },
        },
        graph: { nodes: [], edges: [] },
      },
      admin,
    )
  ).body;
  await stop();
  openDatabase();
  assert.equal(
    db.prepare("SELECT success FROM _sqlx_migrations WHERE version=10").get()
      ?.success,
    1,
  );
  // Reconstruct only the schema from before the audit ordinal (migration 10)
  // and its browsing indexes (migration 12) in this isolated fixture, preserving
  // the remaining migration history and immutable audit records.
  db.exec(
    "DROP TRIGGER audit_sequence_insert; DROP TABLE audit_sequence; DROP INDEX audit_actor; DROP INDEX audit_target; DROP INDEX audit_device; DROP INDEX audit_action_outcome; DELETE FROM _sqlx_migrations WHERE version IN (10,12);",
  );
  const legacy = [];
  for (let i = 0; i < 30; i++) {
    const event = {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      actor: admin.user.id,
      action: "fixture.legacy",
      target: pipeline.id,
      outcome: "success",
      created_at: "2099-01-01T00:00:00Z",
    };
    insertAudit(event);
    legacy.push(event.id);
  }
  const beforeMigration = records();
  db.close();
  db = undefined;
  await start();
  openDatabase();
  await check(
    "migration backfills every audit without rewriting records and preserves surviving tied insertion order",
    async () => {
      assert.deepEqual(records(), beforeMigration);
      assert.equal(mapping().length, beforeMigration.length);
      assert.equal(
        db
          .prepare("SELECT success FROM _sqlx_migrations WHERE version=10")
          .get()?.success,
        1,
      );
      const recent = (await call("GET", "/overview", undefined, admin)).body
        .recent_activity;
      const audit = (await call("GET", "/audit", undefined, admin)).body;
      assert.deepEqual(
        recent.map((x) => x.id),
        legacy.slice().reverse().slice(0, 20),
      );
      assert.deepEqual(
        audit.slice(0, 30).map((x) => x.id),
        legacy.slice().reverse(),
      );
    },
  );
  const tied = [];
  for (let i = 0; i < 30; i++) {
    const event = {
      id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      actor: admin.user.id,
      action: "fixture.current",
      target: pipeline.id,
      outcome: "success",
      created_at: "2099-02-01T00:00:00Z",
    };
    insertAudit(event);
    tied.push(event.id);
  }
  const newer = {
    id: randomUUID(),
    actor: admin.user.id,
    action: "fixture.newer",
    target: pipeline.id,
    outcome: "success",
    created_at: "2099-03-01T00:00:00Z",
  };
  insertAudit(newer);
  const older = {
    ...newer,
    id: randomUUID(),
    action: "fixture.older_inserted_last",
    created_at: "2098-01-01T00:00:00Z",
  };
  insertAudit(older);
  const expected = [
    newer.id,
    ...tied.slice().reverse(),
    ...legacy.slice().reverse(),
    older.id,
  ];
  async function assertOrder() {
    const recent = (await call("GET", "/overview", undefined, admin)).body
      .recent_activity;
    const audit = (await call("GET", "/audit", undefined, admin)).body;
    assert.deepEqual(
      recent.map((x) => x.id),
      expected.slice(0, 20),
    );
    assert.deepEqual(
      audit.slice(0, expected.length).map((x) => x.id),
      expected,
    );
    for (const entry of [...recent, ...audit]) {
      for (const internal of ["sequence", "insertion_order", "rowid"])
        assert.equal(entry[internal], undefined);
    }
    for (const entry of recent) {
      assert.equal(entry.actor_id, admin.user.id);
      assert.equal(entry.actor, "Synthetic chronology administrator");
      assert.equal(entry.target_name, "Synthetic chronology pipeline");
    }
  }
  await check(
    "Overview and Audit Log use timestamp then permanent sequence, preserve names and reject anonymous reads",
    async () => {
      await call("GET", "/overview", undefined, undefined, 401);
      await call("GET", "/audit", undefined, undefined, 401);
      await assertOrder();
    },
  );
  await check(
    "rolled-back audit inserts leave neither record nor sequence mapping",
    async () => {
      const before = mapping();
      const id = randomUUID();
      db.exec("BEGIN IMMEDIATE");
      try {
        insertAudit({ ...newer, id });
        assert(
          db
            .prepare("SELECT sequence FROM audit_sequence WHERE audit_id=?")
            .get(id),
        );
      } finally {
        db.exec("ROLLBACK");
      }
      assert.equal(
        db
          .prepare("SELECT id FROM records WHERE kind='audit' AND id=?")
          .get(id),
        undefined,
      );
      assert.equal(
        db
          .prepare("SELECT sequence FROM audit_sequence WHERE audit_id=?")
          .get(id),
        undefined,
      );
      assert.deepEqual(mapping(), before);
      await assertOrder();
    },
  );
  await check(
    "offline VACUUM and server restart retain exact audit bytes, sequence values and both HTTP orderings",
    async () => {
      const before = mapping(),
        bytes = records();
      db.close();
      db = undefined;
      await stop();
      openDatabase();
      db.exec("VACUUM");
      assert.deepEqual(mapping(), before);
      assert.deepEqual(records(), bytes);
      db.close();
      db = undefined;
      await start();
      openDatabase();
      assert.deepEqual(mapping(), before);
      assert.deepEqual(records(), bytes);
      await assertOrder();
    },
  );
  evidence.synthetic_audit_events = 62;
  evidence.passed = true;
} finally {
  db?.close();
  await stop();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith("vectory-audit-order-review-"));
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
      process.env.VECTORY_AUDIT_ORDER_EVIDENCE ||
        path.join(root, "docs/evidence/audit-order-review.json"),
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
}
