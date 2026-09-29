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
  const insertRecord = db.prepare(
    "INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)",
  );
  // Pipeline and version records an issue can point at. The long name puts the
  // marker beyond the projection's 240 character bound; the odd version numbers
  // (a string, a number no client can represent) must never appear.
  const longName = "N".repeat(260) + marker;
  const contexts = [
    ["Synthetic pipeline A", 1],
    [longName, 2],
    ["Synthetic pipeline C", "7"],
    ["Synthetic pipeline D", 2 ** 60],
  ].map(([name, number]) => {
    const configuration = {
      id: randomUUID(),
      name,
      description: marker,
      revision: 1,
      created_at: "2026-01-01T00:00:00Z",
      config: { private: marker },
      graph: { nodes: [{ id: marker }], edges: [] },
    };
    const version = {
      id: randomUUID(),
      configuration_id: configuration.id,
      number,
      created_at: "2026-01-01T00:00:00Z",
      config: { private: marker },
      artifact: marker,
    };
    insertRecord.run(
      "configuration",
      configuration.id,
      JSON.stringify(configuration),
      configuration.created_at,
    );
    insertRecord.run(
      "version",
      version.id,
      JSON.stringify(version),
      version.created_at,
    );
    return { configuration, version };
  });
  // Stored diagnostics come from agents. The first is well formed; each of the
  // others breaks one rule, so the rendered projection must drop it whole.
  const diagnostic = {
    severity: "error",
    code: "VALIDATION_FAILED",
    message: "Unknown component type",
    component_kind: "sink",
    component_id: "out",
    line: 12,
    column: 3,
    hint: "Check the sink type.",
  };
  const hostileDiagnostics = [
    [{ ...diagnostic, private: marker }],
    Array.from({ length: 11 }, () => diagnostic),
    [{ ...diagnostic, message: "m".repeat(301) }],
    [{ ...diagnostic, severity: marker }],
    { private: marker },
  ];
  const fixtures = [];
  function seed(
    index,
    disposition,
    { revoked = true, missing = false, legacy = false, name, extra = {} } = {},
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
      // Older servers stored free text; it must never be shown.
      message: marker + " stored free text",
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
      ...extra,
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
  const stamp = (index) =>
    new Date(Date.UTC(2026, 0, 1, 0, Math.floor(index / 2))).toISOString();
  // Inputs for the rendered and contextual fields. Every hostile value carries
  // the marker, an oversized string or the wrong type, so a projection that
  // echoed stored data would show it.
  function extrasFor(index, disposition) {
    const extra = {};
    const bucket = index % 16;
    if (bucket === 1) extra.diagnostics = [diagnostic];
    if (bucket >= 2 && bucket <= 6)
      extra.diagnostics = hostileDiagnostics[bucket - 2];
    if (bucket === 7) {
      extra.code = "VALIDATION_FAILED";
      if (Math.floor(index / 16) % 2 === 1) extra.diagnostics = [diagnostic];
    }
    if (bucket === 8) extra.code = "C".repeat(300);
    if (bucket === 9) extra.stage = "s".repeat(200);
    if (bucket === 10) extra.reports = -3;
    if (bucket === 11) extra.reports = 2 ** 60;
    if (bucket === 12) extra.reports = index + 40;
    if (bucket === 13) extra.deployment_id = "d".repeat(300);
    if (bucket === 14) extra.deployment_id = { private: marker };
    if (bucket === 15) extra.deployment_id = randomUUID();
    if (index % 5 >= 1)
      extra.desired_version_id = contexts[(index % 5) - 1].version.id;
    if (index % 25 === 5) extra.desired_version_id = { private: marker };
    if (index % 25 === 10) extra.desired_version_id = "v".repeat(200);
    if (disposition === "resolved") {
      const variant = Math.floor(index / 3) % 5;
      extra.resolved_reason = [
        "verified",
        "unassigned",
        marker,
        undefined,
        "unassigned",
      ][variant];
      extra.resolved_at =
        variant === 4 ? "x".repeat(65536) + marker : stamp(index);
    } else if (index % 4 === 0) {
      // A stale resolution on an unresolved issue must not read as one.
      extra.resolved_reason = "unassigned";
      extra.resolved_at = stamp(index);
    }
    return extra;
  }
  for (let index = 0; index < 123; index++) {
    const disposition = ["open", "acknowledged", "resolved"][index % 3];
    seed(index, disposition, {
      legacy: index === 0,
      extra: extrasFor(index, disposition),
    });
  }
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
  // Every field an issue may expose. `title`, `message` and `diagnostics` are
  // rendered from the failure code and validated diagnostics, never from stored
  // text; the rest are bounded copies of stored fields or joined context.
  const issueKeys = [
    "id",
    "device_id",
    "device_name",
    "device_revoked",
    "code",
    "stage",
    "title",
    "message",
    "diagnostics",
    "count",
    "reports",
    "first_seen",
    "last_seen",
    "desired_version_id",
    "version_number",
    "configuration_id",
    "configuration_name",
    "deployment_id",
    "resolved",
    "resolved_reason",
    "resolved_at",
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
  const characters = (value) => [...value].length;
  const bounded = (value, max) =>
    value === null || (typeof value === "string" && characters(value) <= max);
  const timestampShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  const diagnosticKeys = new Set([
    "severity",
    "code",
    "component_kind",
    "component_id",
    "route_output",
    "field",
    "line",
    "column",
    "reason",
    "message",
    "hint",
  ]);
  function projection(issue) {
    assert.deepEqual(Object.keys(issue).sort(), issueKeys);
    assert(!JSON.stringify(issue).includes(marker));
    assert(Number.isSafeInteger(issue.revision) && issue.revision >= 1);
    assert.equal(issue.resolved, issue.disposition === "resolved");
    for (const field of ["first_seen", "last_seen"]) {
      assert(issue[field] === null || typeof issue[field] === "string");
      if (issue[field] !== null) assert(issue[field].length <= 64);
    }
    // Identity and context copy bounded text or null, never another type.
    assert(typeof issue.code === "string" && characters(issue.code) <= 128);
    assert(typeof issue.stage === "string" && characters(issue.stage) <= 64);
    for (const [field, max] of [
      ["desired_version_id", 128],
      ["configuration_id", 128],
      ["configuration_name", 240],
      ["deployment_id", 128],
    ])
      assert(bounded(issue[field], max), field);
    assert(
      issue.version_number === null ||
        (Number.isSafeInteger(issue.version_number) &&
          issue.version_number >= 1),
    );
    assert(Number.isSafeInteger(issue.count) && issue.count >= 0);
    assert(Number.isSafeInteger(issue.reports) && issue.reports >= 0);
    // The plain-language reason is rendered, short and never stored text.
    assert(
      typeof issue.title === "string" &&
        issue.title.length > 0 &&
        characters(issue.title) <= 80,
    );
    assert(
      typeof issue.message === "string" &&
        issue.message.length > 0 &&
        characters(issue.message) <= 500,
    );
    assert(Array.isArray(issue.diagnostics) && issue.diagnostics.length <= 10);
    assert(Buffer.byteLength(JSON.stringify(issue.diagnostics)) <= 6000);
    for (const item of issue.diagnostics) {
      assert(item && typeof item === "object" && !Array.isArray(item));
      assert(Buffer.byteLength(JSON.stringify(item)) <= 512);
      assert(Object.keys(item).every((key) => diagnosticKeys.has(key)));
      assert(["error", "warning"].includes(item.severity));
      assert(typeof item.code === "string" && characters(item.code) <= 48);
      assert(
        typeof item.message === "string" &&
          characters(item.message) >= 1 &&
          characters(item.message) <= 300,
      );
      if ("hint" in item) assert(characters(item.hint) <= 200);
    }
    // A resolution names a verified recovery or a removed assignment, nothing else.
    if (issue.resolved)
      assert(["verified", "unassigned"].includes(issue.resolved_reason));
    else assert.equal(issue.resolved_reason, null);
    assert(
      issue.resolved_at === null ||
        (timestampShape.test(issue.resolved_at) &&
          issue.resolved_at.length <= 64),
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
  const firstCharacters = (value, max) => [...value].slice(0, max).join("");
  await check(
    "titles, reasons and context are rendered from validated inputs and bounded, whatever an older server stored",
    async () => {
      const seen = new Map();
      for (let page = 1; page <= 3; page++) {
        const body = (
          await call(
            "GET",
            route({ state: "all", page, page_size: 50 }),
            undefined,
            admin,
          )
        ).body;
        for (const item of body.items) seen.set(item.id, item);
      }
      assert.equal(seen.size, fixtures.length);
      const rendered = new Map();
      let joined = 0,
        oversized = 0,
        dropped = 0,
        fallbacks = 0;
      for (const { issue: stored } of fixtures) {
        const item = seen.get(stored.id);
        projection(item);
        assert.equal(item.code, firstCharacters(stored.code, 128));
        assert.equal(item.stage, firstCharacters(stored.stage, 64));
        const version =
          typeof stored.desired_version_id === "string"
            ? firstCharacters(stored.desired_version_id, 128)
            : null;
        assert.equal(item.desired_version_id, version);
        const context = contexts.find((entry) => entry.version.id === version);
        // Only a real version record resolves to a number, pipeline and name.
        assert.equal(
          item.version_number,
          context &&
            Number.isSafeInteger(context.version.number) &&
            context.version.number >= 1
            ? context.version.number
            : null,
        );
        assert.equal(
          item.configuration_id,
          context ? context.configuration.id : null,
        );
        assert.equal(
          item.configuration_name,
          context ? firstCharacters(context.configuration.name, 240) : null,
        );
        if (context) joined++;
        if (context?.configuration.name === longName) {
          assert.equal(characters(item.configuration_name), 240);
          oversized++;
        }
        assert.equal(
          item.deployment_id,
          typeof stored.deployment_id === "string"
            ? firstCharacters(stored.deployment_id, 128)
            : null,
        );
        const count =
          Number.isSafeInteger(stored.count) && stored.count >= 0
            ? stored.count
            : 0;
        assert.equal(item.count, count);
        // A report count that cannot be trusted falls back to the attempts.
        assert.equal(
          item.reports,
          Number.isSafeInteger(stored.reports) && stored.reports >= 0
            ? stored.reports
            : count,
        );
        assert.equal(
          item.resolved_reason,
          stored.resolved
            ? ["verified", "unassigned"].includes(stored.resolved_reason)
              ? stored.resolved_reason
              : "verified"
            : null,
        );
        assert.equal(
          item.resolved_at,
          typeof stored.resolved_at === "string" &&
            stored.resolved_at.length <= 64
            ? stored.resolved_at
            : null,
        );
        // Diagnostics survive only when every field passes validation.
        const valid =
          JSON.stringify(stored.diagnostics) === JSON.stringify([diagnostic]);
        assert.deepEqual(item.diagnostics, valid ? [diagnostic] : []);
        if (!valid && stored.diagnostics !== undefined) dropped++;
        // Title and message are a function of the code and diagnostics alone.
        const known = stored.code === "VALIDATION_FAILED";
        const key = `${known ? "known" : "default"}:${valid ? "diagnostic" : "fallback"}`;
        const seenBefore = rendered.get(key);
        if (!seenBefore) rendered.set(key, [item.title, item.message]);
        else assert.deepEqual([item.title, item.message], seenBefore, key);
        if (valid) {
          assert(item.message.startsWith(diagnostic.message));
          assert(item.message.includes("line 12, column 3"));
        } else fallbacks++;
      }
      // The fixtures really exercised each path, not just their absence.
      assert(joined > 50 && oversized > 10 && dropped > 20 && fallbacks > 60);
      // Rendering never depends on which older server wrote the record.
      assert.notEqual(
        rendered.get("known:fallback")[0],
        rendered.get("default:fallback")[0],
      );
      assert.equal(
        rendered.get("known:diagnostic")[0],
        rendered.get("known:fallback")[0],
      );
      assert.equal(
        rendered.get("default:diagnostic")[0],
        rendered.get("default:fallback")[0],
      );
      assert.notEqual(
        rendered.get("default:diagnostic")[1],
        rendered.get("default:fallback")[1],
      );
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
    "grouped issues bound each device list and expose only validated, rendered fields",
    async () => {
      // Sixty more open issues on live devices with no version push one group
      // past the 50-device list bound.
      for (let index = 300; index < 360; index++)
        seed(index, "open", { revoked: false });
      const groupKeys = [
        "key",
        "code",
        "title",
        "message",
        "diagnostics",
        "version_id",
        "version_number",
        "configuration_id",
        "configuration_name",
        "deployment_ids",
        "device_count",
        "issue_count",
        "attempts",
        "reports",
        "first_seen",
        "last_seen",
        "devices",
      ].sort();
      const query = (extra) => "/issues/groups?" + new URLSearchParams(extra);
      await call("GET", "/issues/groups", undefined, undefined, 401);
      for (const session of Object.values(roles))
        await call("GET", query({ state: "all" }), undefined, session);
      const groups = [];
      let total = 0;
      for (let page = 1; page <= 4; page++) {
        const body = (
          await call(
            "GET",
            query({ state: "all", page, page_size: 50 }),
            undefined,
            admin,
          )
        ).body;
        assert.deepEqual(Object.keys(body).sort(), [
          "items",
          "page",
          "page_size",
          "total",
        ]);
        assert.equal(body.page, page);
        assert.equal(body.page_size, 50);
        assert(body.items.length <= 50);
        total = body.total;
        groups.push(...body.items);
        evidence.largest_50_group_page_bytes = Math.max(
          evidence.largest_50_group_page_bytes || 0,
          Buffer.byteLength(JSON.stringify(body)),
        );
        if (groups.length >= total) break;
      }
      assert.equal(groups.length, total);
      const expected = new Map();
      for (const { issue: stored } of fixtures) {
        const version =
          typeof stored.desired_version_id === "string"
            ? firstCharacters(stored.desired_version_id, 128)
            : "";
        const key = `${version}\0${firstCharacters(stored.code, 128)}`;
        expected.set(key, [...(expected.get(key) || []), stored]);
      }
      assert.equal(total, expected.size);
      const counted = (value) =>
        Number.isSafeInteger(value) && value >= 0 ? value : 0;
      let capped = 0;
      for (const group of groups) {
        assert.deepEqual(Object.keys(group).sort(), groupKeys);
        assert(!JSON.stringify(group).includes(marker));
        assert(/^[0-9a-f]{64}$/.test(group.key));
        assert(typeof group.code === "string" && characters(group.code) <= 128);
        assert(bounded(group.version_id, 128) && group.version_id !== "");
        const members = expected.get(
          `${group.version_id || ""}\0${group.code}`,
        );
        assert(members, "Every group must come from stored issues");
        // Counts describe the whole group even when the device list is capped.
        assert.equal(group.issue_count, members.length);
        assert.equal(
          group.device_count,
          new Set(members.map((member) => member.device_id)).size,
        );
        assert.equal(
          group.attempts,
          members.reduce((sum, member) => sum + counted(member.count), 0),
        );
        assert.equal(
          group.reports,
          members.reduce(
            (sum, member) =>
              sum +
              (Number.isSafeInteger(member.reports) && member.reports >= 0
                ? member.reports
                : counted(member.count)),
            0,
          ),
        );
        assert.equal(group.devices.length, Math.min(50, members.length));
        if (members.length > 50) capped++;
        for (const device of group.devices) {
          projection(device);
          assert.equal(device.code, group.code);
          assert.equal(device.desired_version_id || "", group.version_id || "");
        }
        assert(
          group.deployment_ids.length <= 50 &&
            group.deployment_ids.every(
              (id) => typeof id === "string" && characters(id) <= 128,
            ),
        );
        assert.deepEqual(
          group.deployment_ids,
          [...new Set(group.deployment_ids)].sort(),
        );
        // The group reads like its newest device: same rendered reason.
        const first = group.devices[0];
        assert.equal(group.title, first.title);
        assert.equal(group.message, first.message);
        assert.deepEqual(group.diagnostics, first.diagnostics);
        assert.equal(group.version_number, first.version_number);
        assert.equal(group.configuration_id, first.configuration_id);
        assert.equal(group.configuration_name, first.configuration_name);
        for (const field of ["first_seen", "last_seen"])
          assert(
            group[field] === null ||
              (timestampShape.test(group[field]) && group[field].length <= 64),
          );
      }
      assert.equal(capped, 1, "One group must exceed the device list bound");
      for (const bad of [
        "page=0",
        "page_size=51",
        "state=OPEN",
        "device_id=" + literal.device_id,
        "include=private",
        "page=1&page=2",
        "search=%GG",
        "search=" + "x".repeat(201),
      ])
        await call("GET", "/issues/groups?" + bad, undefined, admin, 400);
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
    "only live operators or administrators with CSRF can act on unresolved issues whose device record exists",
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
      // A device record that is gone or an issue that recovered cannot be acted on.
      for (const issue of [missing, resolved])
        await action(issue, "acknowledge", 1, "Reviewed", admin, 409);
      await action(old, "reopen", 1, "Reviewed", admin, 409);
      const badNotes = [
        "bad\u0000reason",
        "x".repeat(1001),
        "\u{1f600}".repeat(1001),
        false,
        {},
      ];
      for (const reason of badNotes)
        await action(old, "acknowledge", 1, reason, admin, 400);
      // Reopening must say why; an acknowledgement note is optional.
      for (const reason of ["", " \t\r\n", null, ...badNotes])
        await action(old, "reopen", 1, reason, admin, 400);
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
    "an issue on a live device is acknowledged without a note and reopened only with one",
    async () => {
      const before = await detail(active);
      assert.equal(before.device_revoked, false);
      const audits = auditSnapshot();
      const acknowledged = (
        await action(
          active,
          "acknowledge",
          before.revision,
          null,
          roles.operator,
        )
      ).body;
      projection(acknowledged);
      assert.equal(acknowledged.disposition, "acknowledged");
      assert.equal(acknowledged.acknowledgement_reason, null);
      assert.equal(acknowledged.revision, before.revision + 1);
      assert.equal(auditSnapshot().length, audits.length + 1);
      const event = JSON.parse(auditSnapshot().at(-1).data);
      assert.equal(event.target, active.id);
      assert.equal(event.reason, null);
      // Reopening states why; the note is trimmed like any other.
      await action(
        active,
        "reopen",
        acknowledged.revision,
        "  ",
        roles.operator,
        400,
      );
      assert.equal(auditSnapshot().length, audits.length + 1);
      const reopened = (
        await action(
          active,
          "reopen",
          acknowledged.revision,
          "  Needs another look  ",
          roles.operator,
        )
      ).body;
      projection(reopened);
      assert.equal(reopened.disposition, "open");
      assert.equal(reopened.acknowledgement_reason, null);
      assert.equal(
        JSON.parse(auditSnapshot().at(-1).data).reason,
        "Needs another look",
      );
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
