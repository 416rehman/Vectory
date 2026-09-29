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
  process.env.VECTORY_ISSUE_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-issue-review-"),
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
    "Independent real HTTP issue lifecycle checks against disposable development state. Synthetic issue/device records exercise acknowledgement versus verified recovery, CAS, authorization, audit rollback and bounded projections; no native activation claim.",
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
      throw Error("Disposable issue server did not start");
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
    if (expected !== null)
      assert.equal(
        response.status,
        expected,
        `${method} ${route}: ${body.error?.code || response.status}`,
      );
    assert.equal(response.headers.get("cache-control"), "no-store");
    return {
      status: response.status,
      body,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      csrf: body.csrf_token,
      user: body.user,
    };
  }
  const admin = await call("POST", "/bootstrap", {
    bootstrap_secret: bootstrap,
    name: "Synthetic issue administrator",
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
  const marker = "PRIVATE_EXTENSION_" + randomBytes(12).toString("hex");
  const reasonMarker =
    "Acknowledgement-only " + randomBytes(12).toString("hex");
  const insert = db.prepare(
    "INSERT INTO records(kind,id,data,created_at) VALUES('issue',?,?,?)",
  );
  const fixtures = [];
  function seed(
    index,
    disposition,
    { revoked = true, missing = false, legacy = false, name } = {},
  ) {
    const deviceId = randomUUID();
    const deviceName =
      name || `Synthetic issue device ${String(index).padStart(3, "0")}`;
    if (!missing)
      db.prepare(
        "INSERT INTO devices(id,name,data,revoked,desired_generation,policy_generation) VALUES(?,?,?,?,?,?)",
      ).run(
        deviceId,
        deviceName,
        JSON.stringify({
          id: deviceId,
          name: deviceName,
          status: revoked ? "revoked" : "offline",
          os: "linux",
          arch: "amd64",
          labels: {},
          private_extension: marker,
        }),
        revoked ? 1 : 0,
        index + 10,
        index + 20,
      );
    const time = new Date(
      Date.UTC(2026, 0, 1, 0, Math.floor(index / 2)),
    ).toISOString();
    const issue = {
      id: sha(`${deviceId}:APPLY_FAILED:apply`),
      device_id: deviceId,
      code: "APPLY_FAILED",
      stage: "apply",
      message:
        "Device reported an operational failure. Inspect the local agent status for sanitized diagnostics.",
      count: index + 1,
      first_seen: time,
      last_seen: time,
      created_at: time,
      resolved: disposition === "resolved",
      desired_version_id: null,
      revision: 1,
      acknowledged: disposition === "acknowledged",
      acknowledged_at: disposition === "acknowledged" ? time : null,
      acknowledged_by: disposition === "acknowledged" ? admin.user.id : null,
      acknowledged_by_name:
        disposition === "acknowledged" ? "Synthetic historical actor" : null,
      acknowledgement_reason:
        disposition === "acknowledged" ? reasonMarker : null,
      private_extension: marker + "x".repeat(32768),
    };
    if (legacy)
      for (const key of [
        "revision",
        "acknowledged",
        "acknowledged_at",
        "acknowledged_by",
        "acknowledged_by_name",
        "acknowledgement_reason",
      ])
        delete issue[key];
    insert.run(issue.id, JSON.stringify(issue), time);
    fixtures.push({
      issue,
      deviceName: missing ? null : deviceName,
      revoked: missing ? null : revoked,
      disposition,
    });
    return issue;
  }
  for (let index = 0; index < 123; index++)
    seed(index, ["open", "acknowledged", "resolved"][index % 3], {
      legacy: index === 0,
    });
  const literal = seed(123, "open", { name: "Literal %_[]' Caf\u00e9" });
  const old = seed(124, "open", { name: "Same-name device#retired-synthetic" });
  const replacement = seed(125, "open", {
    revoked: false,
    name: "Same-name device",
  });
  const missing = seed(126, "open", { missing: true });
  const active = seed(127, "open", { revoked: false });
  const legacy = fixtures[0].issue;
  const resolved = fixtures[2].issue;
  const route = (query) => "/issues/history?" + new URLSearchParams(query);
  const detail = async (issue, session = admin) =>
    (await call("GET", `/issues/${issue.id}`, undefined, session)).body;
  const action = (
    issue,
    verb,
    revision,
    reason = "Reviewed retired device",
    session = admin,
    expected = 200,
    extra = {},
  ) =>
    call(
      "POST",
      `/issues/${issue.id}/${verb}`,
      { revision, reason },
      session,
      expected,
      extra,
    );
  const readStored = (issue) =>
    JSON.parse(
      db
        .prepare("SELECT data FROM records WHERE kind='issue' AND id=?")
        .get(issue.id).data,
    );
  const writeStored = (issue, change) =>
    db
      .prepare("UPDATE records SET data=? WHERE kind='issue' AND id=?")
      .run(JSON.stringify({ ...readStored(issue), ...change }), issue.id);
  const auditSnapshot = () =>
    db
      .prepare(
        "SELECT r.id,r.data,s.sequence FROM records r JOIN audit_sequence s ON s.audit_id=r.id WHERE r.kind='audit' ORDER BY s.sequence",
      )
      .all();
  const runtimeSnapshot = () =>
    db
      .prepare(
        "SELECT id,revoked,desired_generation,policy_generation,desired_version_id,assignment_id,policy_assignment_id,policy FROM devices ORDER BY id",
      )
      .all();
  const issueKeys = [
    "id",
    "device_id",
    "device_name",
    "device_revoked",
    "code",
    "stage",
    "message",
    "count",
    "first_seen",
    "last_seen",
    "desired_version_id",
    "resolved",
    "revision",
    "acknowledged",
    "acknowledged_at",
    "acknowledged_by",
    "acknowledged_by_name",
    "acknowledgement_reason",
    "disposition",
  ].sort();
  writeStored(fixtures[3].issue, { first_seen: { private: marker } });
  writeStored(fixtures[4].issue, { first_seen: "x".repeat(65536) + marker });
  function projection(issue) {
    assert.deepEqual(Object.keys(issue).sort(), issueKeys);
    assert(!JSON.stringify(issue).includes(marker));
    assert(Number.isSafeInteger(issue.revision) && issue.revision >= 1);
    assert.equal(issue.resolved, issue.disposition === "resolved");
    for (const field of ["first_seen", "last_seen"]) {
      assert(issue[field] === null || typeof issue[field] === "string");
      if (issue[field] !== null) assert(issue[field].length <= 64);
    }
    assert.equal(
      issue.message,
      "Device reported an operational failure. Inspect the local agent status for sanitized diagnostics.",
    );
  }
  await check(
    "authenticated reads project bounded issue metadata for all workspace roles and preserve legacy defaults",
    async () => {
      for (const path of [
        "/issues",
        "/issues/history",
        `/issues/${legacy.id}`,
      ]) {
        await call("GET", path, undefined, undefined, 401);
        for (const session of [admin, ...Object.values(roles)]) {
          const body = (await call("GET", path, undefined, session)).body;
          for (const issue of Array.isArray(body) ? body : body.items || [body])
            projection(issue);
        }
      }
      await call(
        "GET",
        "/issues/history?unexpected=private",
        undefined,
        undefined,
        401,
      );
      await call("GET", `/issues/${"0".repeat(64)}`, undefined, undefined, 401);
      const issue = await detail(legacy);
      assert.equal(issue.revision, 1);
      assert.equal(issue.acknowledged, false);
      assert.equal(issue.acknowledgement_reason, null);
      assert.equal((await detail(missing)).device_revoked, null);
      assert.equal((await detail(missing)).device_name, null);
      await call("GET", `/issues/${"0".repeat(64)}`, undefined, admin, 404);
    },
  );
  await check(
    "SQL pages, state filters and actionable Overview count preserve exact historical totals",
    async () => {
      const expected = fixtures
        .slice()
        .sort(
          (a, b) =>
            b.issue.last_seen.localeCompare(a.issue.last_seen) ||
            a.issue.id.localeCompare(b.issue.id),
        );
      const ids = [];
      for (let page = 1; page <= 4; page++) {
        const body = (
          await call(
            "GET",
            route({ state: "all", page, page_size: 50 }),
            undefined,
            admin,
          )
        ).body;
        assert.equal(body.total, fixtures.length);
        assert.equal(body.page_size, 50);
        assert.equal(body.items.length, [50, 50, 28, 0][page - 1]);
        body.items.forEach(projection);
        ids.push(...body.items.map((x) => x.id));
        evidence.largest_50_issue_page_bytes = Math.max(
          evidence.largest_50_issue_page_bytes || 0,
          Buffer.byteLength(JSON.stringify(body)),
        );
      }
      assert.deepEqual(
        ids,
        expected.map((x) => x.issue.id),
      );
      for (const stateName of ["open", "acknowledged", "resolved"]) {
        const body = (
          await call(
            "GET",
            route({ state: stateName, page_size: 50 }),
            undefined,
            admin,
          )
        ).body;
        assert.equal(
          body.total,
          fixtures.filter((x) => x.disposition === stateName).length,
        );
        assert(body.items.every((x) => x.disposition === stateName));
      }
      const overview = (await call("GET", "/overview", undefined, admin)).body;
      assert.equal(
        overview.issues_open,
        fixtures.filter((x) => x.disposition === "open").length,
      );
    },
  );
  await check(
    "literal search excludes acknowledgement reasons and private bodies; malformed query fields fail closed",
    async () => {
      for (const search of ["%_[]'", "Caf\u00e9", literal.device_id]) {
        const body = (
          await call("GET", route({ state: "all", search }), undefined, admin)
        ).body;
        assert.equal(body.total, 1);
        assert.equal(body.items[0].id, literal.id);
      }
      for (const device_id of [
        literal.device_id,
        literal.device_id.toUpperCase(),
      ]) {
        const body = (
          await call(
            "GET",
            route({ state: "all", device_id }),
            undefined,
            admin,
          )
        ).body;
        assert.equal(body.total, 1);
        assert.equal(body.items[0].id, literal.id);
      }
      assert.equal(
        (
          await call(
            "GET",
            route({ state: "all", device_id: randomUUID() }),
            undefined,
            admin,
          )
        ).body.total,
        0,
      );
      for (const search of [
        marker,
        reasonMarker,
        "' OR 1=1 --",
        "Synthetic%",
        "\u{1f600}".repeat(200),
      ]) {
        const body = (
          await call("GET", route({ state: "all", search }), undefined, admin)
        ).body;
        assert.equal(body.total, 0);
      }
      for (const query of [
        "page=0",
        "page=-1",
        "page=1.5",
        "page=9007199254740992",
        "page=18446744073709551616",
        "page_size=0",
        "page_size=51",
        "state=OPEN",
        "state=retired",
        "page=1&page=2",
        "include=private_extension",
        "device_id=not-a-uuid",
        "device_id=" + literal.device_id.replaceAll("-", ""),
        "device_id=" + literal.device_id + "&device_id=" + old.device_id,
        "search=%",
        "search=%GG",
        "search=%FF",
        "search=" + "x".repeat(201),
        "search=" + encodeURIComponent("\u{1f600}".repeat(201)),
      ])
        await call("GET", "/issues/history?" + query, undefined, admin, 400);
    },
  );
  await check(
    "only live operators or administrators with CSRF can act on unresolved revoked identities",
    async () => {
      for (const verb of ["acknowledge", "reopen"]) {
        await action(old, verb, 1, "Reviewed", undefined, 401, {
          cookie: "",
          "x-csrf-token": "",
        });
        for (const session of [roles.viewer, roles.editor])
          await action(old, verb, 1, "Reviewed", session, 403);
        await action(old, verb, 1, "Reviewed", admin, 403, {
          "x-csrf-token": "invalid",
        });
      }
      for (const issue of [active, replacement, missing, resolved])
        await action(issue, "acknowledge", 1, "Reviewed", admin, 409);
      await action(old, "reopen", 1, "Reviewed", admin, 409);
      for (const reason of [
        "",
        " \t\r\n",
        "bad\u0000reason",
        "x".repeat(1001),
        "\u{1f600}".repeat(1001),
        false,
        {},
      ])
        await action(old, "acknowledge", 1, reason, admin, 400);
      for (const revision of [
        0,
        -1,
        1.1,
        Number.MAX_SAFE_INTEGER + 1,
        "1",
        null,
      ])
        await action(old, "acknowledge", revision, "Reviewed", admin, 400);
      await call(
        "POST",
        `/issues/${old.id}/acknowledge`,
        {
          revision: 1,
          reason: "Client cannot report recovery",
          resolved: true,
          device_revoked: true,
        },
        admin,
        400,
      );
      await call(
        "GET",
        `/issues/${old.id}?include=private`,
        undefined,
        admin,
        400,
      );
      const same = await detail(old);
      assert.equal(same.acknowledged, false);
      assert.equal(same.revision, 1);
    },
  );
  await check(
    "acknowledgement is audited disposition only and never changes verified recovery or replacement identity",
    async () => {
      const beforeRuntime = runtimeSnapshot(),
        before = await detail(old),
        audits = auditSnapshot();
      const overview = (await call("GET", "/overview", undefined, admin)).body;
      const updated = (
        await action(
          old,
          "acknowledge",
          before.revision,
          "  Retired after review  ",
          roles.operator,
        )
      ).body;
      projection(updated);
      assert.equal(updated.resolved, false);
      assert.equal(updated.acknowledged, true);
      assert.equal(updated.disposition, "acknowledged");
      assert.equal(updated.revision, before.revision + 1);
      assert.equal(updated.acknowledgement_reason, "Retired after review");
      assert.equal(updated.acknowledged_by, roles.operator.user.id);
      assert.equal(updated.acknowledged_by_name, "Synthetic operator");
      assert.equal(updated.count, before.count);
      assert.equal(updated.last_seen, before.last_seen);
      assert.deepEqual(runtimeSnapshot(), beforeRuntime);
      assert.equal((await detail(replacement)).acknowledged, false);
      assert.equal(
        (await call("GET", "/overview", undefined, admin)).body.issues_open,
        overview.issues_open - 1,
      );
      const afterAudits = auditSnapshot();
      assert.equal(afterAudits.length, audits.length + 1);
      const event = JSON.parse(afterAudits.at(-1).data);
      assert.equal(event.target, old.id);
      assert.equal(event.actor, roles.operator.user.id);
      assert(JSON.stringify(event).includes("Retired after review"));
      await action(old, "acknowledge", updated.revision, "Again", admin, 409);
      assert.equal(auditSnapshot().length, afterAudits.length);
      db.prepare("UPDATE users SET name='Renamed operator' WHERE id=?").run(
        roles.operator.user.id,
      );
      assert.equal(
        (await detail(old)).acknowledged_by_name,
        "Synthetic operator",
      );
    },
  );
  await check(
    "occurrence and disposition revisions reject stale actions and reopen cannot masquerade as recovery",
    async () => {
      const before = await detail(legacy);
      writeStored(legacy, {
        count: before.count + 1,
        revision: before.revision + 1,
      });
      const audits = auditSnapshot();
      await action(
        legacy,
        "acknowledge",
        before.revision,
        "Stale occurrence",
        admin,
        409,
      );
      assert.deepEqual(auditSnapshot(), audits);
      const updated = (
        await action(
          legacy,
          "acknowledge",
          before.revision + 1,
          "\u{1f600}".repeat(1000),
        )
      ).body;
      assert.equal(updated.resolved, false);
      const reopened = (
        await action(legacy, "reopen", updated.revision, "Reopened for review")
      ).body;
      assert.equal(reopened.resolved, false);
      assert.equal(reopened.disposition, "open");
      assert.equal(reopened.acknowledged, false);
      assert.equal(reopened.acknowledgement_reason, null);
      assert.equal(reopened.acknowledged_at, null);
      assert.equal(reopened.acknowledged_by, null);
      assert.equal(reopened.revision, updated.revision + 1);
      await action(
        legacy,
        "acknowledge",
        before.revision + 1,
        "Stale before ABA",
        admin,
        409,
      );
      const revision = reopened.revision;
      const raceAudits = auditSnapshot();
      const results = await Promise.all([
        action(legacy, "acknowledge", revision, "Concurrent A", admin, null),
        action(legacy, "acknowledge", revision, "Concurrent B", admin, null),
      ]);
      assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
      assert.equal(auditSnapshot().length, raceAudits.length + 1);
      const now = await detail(legacy);
      assert.equal(now.revision, revision + 1);
      assert.equal(now.acknowledged, true);
    },
  );
  await check(
    "late audit failure rolls back issue disposition and ordering records atomically",
    async () => {
      const before = readStored(literal),
        audits = auditSnapshot(),
        runtime = runtimeSnapshot();
      db.exec(
        "CREATE TRIGGER fixture_reject_issue_audit BEFORE INSERT ON records WHEN new.kind='audit' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;",
      );
      try {
        await action(literal, "acknowledge", 1, "Must roll back", admin, 500);
      } finally {
        db.exec("DROP TRIGGER fixture_reject_issue_audit");
      }
      assert.deepEqual(readStored(literal), before);
      assert.deepEqual(auditSnapshot(), audits);
      assert.deepEqual(runtimeSnapshot(), runtime);
    },
  );
  await check(
    "offboarding revokes both issue reads and actions without changing issue history",
    async () => {
      const operator = (
        await call("GET", "/users", undefined, admin)
      ).body.find((x) => x.id === roles.operator.user.id);
      await call(
        "PUT",
        `/users/${operator.id}`,
        {
          name: operator.name,
          role: operator.role,
          enabled: false,
          revision: operator.revision,
          current_password: password,
        },
        admin,
      );
      const before = readStored(literal),
        audits = auditSnapshot();
      await call("GET", "/issues/history", undefined, roles.operator, 401);
      await call(
        "GET",
        `/issues/${literal.id}`,
        undefined,
        roles.operator,
        401,
      );
      await action(
        literal,
        "acknowledge",
        1,
        "Revoked session",
        roles.operator,
        401,
      );
      assert.deepEqual(readStored(literal), before);
      assert.deepEqual(auditSnapshot(), audits);
    },
  );
  evidence.synthetic_issues = fixtures.length;
  evidence.passed = true;
} finally {
  db?.close();
  await stop();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith("vectory-issue-review-"));
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
      process.env.VECTORY_ISSUE_EVIDENCE ||
        path.join(root, "docs/evidence/issue-review.json"),
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
}
