// Independent bounded-query checks against disposable HTTP state.
// Large fixtures are explicitly synthetic; no ordinary product fleet data is seeded.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const source = path.resolve(
  process.env.VECTORY_AUDIT_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-audit-review-"),
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
    "Independent real HTTP audit history and prepared JSONL export checks against disposable development state. Synthetic records exercise bounded projections, snapshot integrity, strict queries, resource and originating-session authorization. No production load or browser-save claim.",
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
  const started = performance.now();
  await test();
  evidence.checks.push({
    name,
    passed: true,
    duration_ms: Math.round(performance.now() - started),
  });
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
  async function startServer() {
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
  await startServer();
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
      signal: AbortSignal.timeout(
        route.startsWith("/audit/exports") ? 130000 : 15000,
      ),
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
    name: "Synthetic audit administrator",
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
  // Strict fixture setup is intentionally local to this disposable database.
  const marker = "PRIVATE_AUDIT_EXTENSION_" + randomBytes(12).toString("hex");
  const insert = db.prepare(
    "INSERT INTO records(kind,id,data,created_at) VALUES('audit',?,?,?)",
  );
  const fixtures = [];
  function seed(values = {}) {
    const event = {
      id: randomUUID(),
      actor: admin.user.id,
      action: "fixture.audit",
      target: randomUUID(),
      outcome: "success",
      created_at: "2099-01-01T00:00:00Z",
      private_extension: marker + "x".repeat(16384),
      token: marker,
      ...values,
    };
    insert.run(event.id, JSON.stringify(event), event.created_at);
    fixtures.push(event);
    return event;
  }
  const device = randomUUID(),
    replacement = randomUUID(),
    actorDevice = randomUUID();
  for (const [id, name, revoked] of [
    [device, "Literal %_[]' audit retired", 1],
    [replacement, "Literal %_[]' audit replacement", 0],
    [actorDevice, "Synthetic audit actor", 0],
  ])
    db.prepare(
      "INSERT INTO devices(id,name,data,revoked,desired_generation,policy_generation) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      name,
      JSON.stringify({ id, name, private_extension: marker }),
      revoked,
      1,
      1,
    );
  db.exec("BEGIN");
  for (let i = 0; i < 123; i++)
    seed({
      id: `10000000-0000-4000-8000-${String(999999 - i).padStart(12, "0")}`,
      action: i % 2 ? "device.revoke" : "device.renew",
      target: device,
    });
  const literal = seed({
    action: "fixture.literal",
    target: "Literal %_[]' Caf\u00e9",
  });
  const exactTarget = seed({ action: "device.revoke", target: device });
  const exactActor = seed({
    action: "device.renew",
    actor: device,
    target: actorDevice,
  });
  const exactStored = seed({
    action: "issue.acknowledge",
    device_id: device,
    target: "a".repeat(64),
    reason: "Operator reviewed retirement",
    issue_revision: 2,
  });
  const compound = seed({
    action: "deployment.release",
    target: `${randomUUID()}:${device}`,
  });
  const recovery = seed({
    action: "device.recovery_complete",
    target: `${device}:${replacement}`,
  });
  const substring = seed({
    action: "fixture.no_exact_device",
    target: `prefix-${device}-suffix`,
  });
  const bodyOnly = seed({
    action: "fixture.no_exact_device",
    details: { device_id: device },
    target: randomUUID(),
  });
  const malformedCompound = seed({
    action: "deployment.release",
    target: ":" + "x".repeat(35) + "!" + device,
  });
  const malformedRecovery = seed({
    action: "device.recovery_complete",
    target: "x".repeat(36) + ":" + device,
  });
  const fence = seed({
    action: "server.restore_generation_fence",
    target: "server",
    details: { device_id: device, generation: 9, private_extension: marker },
  });
  db.exec("COMMIT");
  const route = (values = {}) =>
    "/audit/history?" + new URLSearchParams(values);
  const snapshot = () =>
    db
      .prepare("SELECT id,data FROM records WHERE kind='audit' ORDER BY id")
      .all();
  const immutableBefore = snapshot();
  const summaryKeys = [
    "id",
    "actor_id",
    "actor",
    "actor_kind",
    "action",
    "target",
    "target_id",
    "target_kind",
    "target_exists",
    "target_name",
    "device_id",
    "device_name",
    "outcome",
    "created_at",
    "request_id",
  ].sort();
  function safeSummary(value) {
    assert.deepEqual(Object.keys(value).sort(), summaryKeys);
    assert(!JSON.stringify(value).includes(marker));
    assert.equal(typeof value.target_exists, "boolean");
    for (const [key, v] of Object.entries(value))
      if (key !== "target_exists") assert(v === null || typeof v === "string");
  }
  const page = async (filters = {}, session = admin) =>
    (await call("GET", route(filters), undefined, session)).body;
  const detail = async (event, session = admin) =>
    (await call("GET", `/audit/${event.id}`, undefined, session)).body;
  const eventIds = async (filters = {}) => {
    const first = await page({ ...filters, page_size: 50 }),
      values = [...first.items];
    for (let n = 2; values.length < first.total; n++)
      values.push(
        ...(await page({ ...filters, page_size: 50, page: n })).items,
      );
    return values.map((x) => x.id);
  };
  await check(
    "all authenticated roles read bounded metadata; unauthenticated reads do not reveal query or record details",
    async () => {
      await call("GET", route({ page: 0 }), undefined, undefined, 401);
      await call("GET", `/audit/${literal.id}`, undefined, undefined, 401);
      for (const session of [admin, ...Object.values(roles)]) {
        const result = await page({}, session);
        assert.equal(result.page, 1);
        assert.equal(result.page_size, 12);
        assert.equal(result.items.length, 12);
        for (const row of result.items) safeSummary(row);
        const item = await detail(exactStored, session);
        assert.deepEqual(
          Object.keys(item).sort(),
          [...summaryKeys, "details"].sort(),
        );
        assert.deepEqual(item.details, {
          reason: exactStored.reason,
          issue_revision: 2,
        });
        assert(!JSON.stringify(item).includes(marker));
      }
      await call("GET", `/audit/${randomUUID()}`, undefined, admin, 404);
    },
  );
  await check(
    "bounded stable pages preserve sequence ties without loading private extensions",
    async () => {
      const result = await page({ page_size: 50 });
      assert.equal(result.total, immutableBefore.length);
      const sorted = db
        .prepare(
          "SELECT r.id FROM records r JOIN audit_sequence s ON s.audit_id=r.id WHERE r.kind='audit' ORDER BY s.created_at DESC,s.sequence DESC",
        )
        .all()
        .map((x) => x.id);
      assert.deepEqual(await eventIds(), sorted);
      result.items.forEach(safeSummary);
      evidence.largest_page_bytes = Buffer.byteLength(JSON.stringify(result));
      assert(evidence.largest_page_bytes < 100000);
      assert.equal((await page({ page: 99999 })).items.length, 0);
      assert.deepEqual(await eventIds({ action: "fixture.literal" }), [
        literal.id,
      ]);
      assert.deepEqual(await eventIds({ actor_id: device }), [exactActor.id]);
      assert.deepEqual(
        await eventIds({ target_id: device }),
        fixtures
          .filter((x) => x.target === device)
          .reverse()
          .map((x) => x.id),
      );
      const family = await page({ family: "device" });
      assert.equal(
        family.total,
        fixtures.filter((x) => x.action.startsWith("device.")).length,
      );
      assert.equal((await page({ outcome: "failure" })).total, 0);
      assert.equal(
        (
          await page({
            from: "2099-01-01T00:00:00Z",
            to: "2099-01-01T00:00:00.000Z",
          })
        ).total,
        fixtures.length,
      );
    },
  );
  await check(
    "literal search and exact historical device identity exclude private fields and replacement conflation",
    async () => {
      assert.deepEqual(await eventIds({ search: "%_[]' Caf\u00e9" }), [
        literal.id,
      ]);
      assert.equal((await page({ search: marker })).total, 0);
      assert.equal((await page({ search: exactStored.reason })).total, 0);
      const expected = fixtures
        .filter(
          (x) =>
            x.target === device ||
            x.actor === device ||
            x.device_id === device ||
            x === compound ||
            x === recovery ||
            x === fence,
        )
        .reverse()
        .map((x) => x.id);
      assert.deepEqual(await eventIds({ device_id: device }), expected);
      assert.deepEqual(
        await eventIds({ device_id: device.toUpperCase() }),
        expected,
      );
      assert.deepEqual(await eventIds({ device_id: replacement }), [
        recovery.id,
      ]);
      assert.equal((await page({ device_id: randomUUID() })).total, 0);
      assert(!expected.includes(substring.id));
      assert(!expected.includes(bodyOnly.id));
      assert(!expected.includes(malformedCompound.id));
      assert(!expected.includes(malformedRecovery.id));
      assert.deepEqual((await detail(fence)).details, {
        device_id: device,
        generation: 9,
      });
    },
  );
  await check(
    "strict query parsing rejects duplicates, malformed encoding, unsafe bounds and contradictory dates",
    async () => {
      const bad = [
        "unexpected=1",
        "page=0",
        "page=-1",
        "page=1.2",
        "page=9007199254740992",
        "page_size=0",
        "page_size=51",
        "page=1&page=2",
        "search=a&search=b",
        "search=%FF",
        "search=%zz",
        "search=%00",
        "device_id=bad",
        "device_id=" + device.replaceAll("-", ""),
        "action=device.revoke&family=device",
        "family=bad%20family",
        "outcome=bad%00outcome",
        "from=2026-99-01T00%3A00%3A00Z",
        "from=2026-01-01",
        "from=2026-01-01T00%3A00%3A00%2B01%3A00",
        "from=2026-02-01T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00Z",
        "from=2026-01-01T00%3A00%3A00.0001Z",
      ];
      for (const query of bad)
        await call("GET", "/audit/history?" + query, undefined, admin, 400);
      await call(
        "GET",
        route({ search: "\u{1f642}".repeat(201) }),
        undefined,
        admin,
        400,
      );
      assert.equal((await page({ search: "\u{1f642}".repeat(200) })).total, 0);
      await call(
        "GET",
        `/audit/${literal.id}?unexpected=1`,
        undefined,
        admin,
        400,
      );
      assert.deepEqual(snapshot(), immutableBefore);
    },
  );

  async function prepare(
    filters = {},
    session = admin,
    expected = 200,
    extra = {},
  ) {
    return (
      await call("POST", "/audit/exports", filters, session, expected, extra)
    ).body;
  }
  const discard = async (file, session = admin, expected = 200) =>
    call("DELETE", `/audit/exports/${file.id}`, undefined, session, expected);
  async function download(file, session = admin, expected = 200) {
    const response = await fetch(origin + file.download_path, {
      headers: session ? { cookie: session.cookie } : {},
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (expected !== 200) {
      await response.arrayBuffer();
      return null;
    }
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    assert.equal(
      Number(response.headers.get("content-length")),
      file.byte_count,
    );
    assert.equal(
      response.headers.get("content-disposition"),
      `attachment; filename="vectory-audit-${file.id}.jsonl"`,
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.length, file.byte_count);
    assert.equal(sha(buffer), file.sha256);
    assert(!buffer.includes(Buffer.from(marker)));
    const lines = buffer.toString("utf8").split("\n");
    assert.equal(lines.pop(), "");
    const values = lines.map((x) => JSON.parse(x)),
      header = values[0],
      trailer = values.at(-1),
      events = values.slice(1, -1);
    assert.equal(header.type, "metadata");
    assert.equal(header.format, "vectory.audit.jsonl.v1");
    assert.equal(header.row_count, file.row_count);
    assert.equal(trailer.type, "complete");
    assert.equal(trailer.complete, true);
    assert.equal(trailer.row_count, events.length);
    assert.equal(events.length, file.row_count);
    assert.equal(
      trailer.events_sha256,
      sha(
        lines
          .slice(1, -1)
          .map((x) => x + "\n")
          .join(""),
      ),
    );
    assert.equal(header.limits.rows, 100000);
    assert.equal(header.limits.bytes, 134217728);
    assert.equal(header.limits.preparation_seconds, 120);
    for (const item of events) {
      assert.equal(item.type, "audit");
      const { details, ...summary } = item.event;
      safeSummary(summary);
      assert.equal(typeof details, "object");
    }
    return { header, trailer, events: events.map((x) => x.event), buffer };
  }
  await check(
    "every authenticated read role can explicitly prepare an integrity-checked complete filtered JSONL snapshot",
    async () => {
      await prepare({}, null, 401);
      await prepare({}, admin, 403, { "x-csrf-token": "invalid" });
      await prepare({}, admin, 403, { "sec-fetch-site": "cross-site" });
      for (const session of [admin, ...Object.values(roles)]) {
        const file = await prepare({ action: "fixture.literal" }, session);
        assert.deepEqual(
          Object.keys(file).sort(),
          [
            "id",
            "row_count",
            "byte_count",
            "sha256",
            "created_at",
            "expires_at",
            "download_path",
            "filters",
          ].sort(),
        );
        assert.equal(
          file.download_path,
          `/api/v1/audit/exports/${file.id}/download`,
        );
        assert.equal(
          Date.parse(file.expires_at) - Date.parse(file.created_at),
          600000,
        );
        assert.equal(file.row_count, 1);
        assert.deepEqual(file.filters, { action: "fixture.literal" });
        assert.match(file.sha256, /^[0-9a-f]{64}$/);
        const data = await download(file, session);
        assert.deepEqual(data.header.filters, { action: "fixture.literal" });
        assert.equal(data.events[0].id, literal.id);
        assert.deepEqual(data.events[0].details, {});
        await discard(file, session);
        await download(file, session, 404);
      }
      assert.deepEqual(snapshot(), immutableBefore);
    },
  );
  await check(
    "export preparation rejects unknown and duplicate filter members; file IDs remain bound to owner and original session",
    async () => {
      for (const filters of [
        { page: 1 },
        { search: "\u{1f642}".repeat(201) },
        { action: "device.revoke", family: "device" },
        { from: "invalid" },
      ])
        await prepare(filters, admin, 400);
      const malformed = await fetch(origin + "/api/v1/audit/exports", {
        method: "POST",
        headers: {
          cookie: admin.cookie,
          "x-csrf-token": admin.csrf,
          "content-type": "application/json",
        },
        body: '{"action":"device.revoke","action":"device.renew"}',
      });
      assert.equal(malformed.status, 400);
      await malformed.arrayBuffer();
      const second = await call("POST", "/login", {
        email: "viewer@example.test",
        password,
      });
      const file = await prepare({ action: "fixture.literal" }, roles.viewer);
      assert.deepEqual(
        (await call("GET", "/audit/exports", undefined, roles.viewer)).body,
        [file],
      );
      assert.deepEqual(
        (await call("GET", "/audit/exports", undefined, second)).body,
        [],
      );
      assert.deepEqual(
        (await call("GET", "/audit/exports", undefined, admin)).body,
        [],
      );
      await call(
        "GET",
        "/audit/exports?unknown=1",
        undefined,
        roles.viewer,
        400,
      );
      await call("GET", "/audit/exports", undefined, undefined, 401);
      await call(
        "GET",
        `/audit/exports/${file.id}/download?unknown=1`,
        undefined,
        roles.viewer,
        400,
      );
      await call(
        "DELETE",
        `/audit/exports/${file.id}?unknown=1`,
        undefined,
        roles.viewer,
        400,
      );
      await download(file, null, 401);
      await download(file, second, 404);
      await download(file, admin, 404);
      await discard(file, second, 404);
      await discard(file, admin, 404);
      await call(
        "DELETE",
        `/audit/exports/${file.id}`,
        undefined,
        roles.viewer,
        403,
        { "x-csrf-token": "invalid" },
      );
      await download(file, roles.viewer);
      await discard(file, roles.viewer);
    },
  );
  await check(
    "retained export quotas fail explicitly, discarded artifacts release capacity and retained files are private",
    async () => {
      const left = await prepare({ action: "fixture.literal" }, admin),
        right = await prepare({}, admin);
      const another = await call("POST", "/login", {
        email: "admin@example.test",
        password,
      });
      const expectedAfterLogin = snapshot();
      await prepare({}, another, 429);
      const third = await prepare(
          { action: "fixture.literal" },
          roles.operator,
        ),
        fourth = await prepare({}, roles.operator);
      await prepare({}, roles.editor, 429);
      const directory = path.join(state, "audit-exports"),
        names = await fs.readdir(directory);
      assert.equal(names.length, 4);
      for (const name of names) {
        assert(/^audit-.*\.jsonl$/.test(name));
        const stat = await fs.lstat(path.join(directory, name));
        assert(stat.isFile());
        assert(!stat.isSymbolicLink());
        if (process.platform !== "win32") assert.equal(stat.mode & 0o077, 0);
      }
      if (process.platform !== "win32")
        assert.equal((await fs.stat(directory)).mode & 0o077, 0);
      else {
        const paths = [
          directory,
          ...names.map((name) => path.join(directory, name)),
        ];
        const quoted = paths
          .map((value) => `'${value.replaceAll("'", "''")}'`)
          .join(",");
        const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @(${quoted}) | ForEach-Object { $acl=Get-Acl -LiteralPath $_; [pscustomobject]@{ protected=$acl.AreAccessRulesProtected; owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; current=$sid; identities=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) } } | ConvertTo-Json -Depth 4`;
        const { stdout } = await promisify(execFile)(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { windowsHide: true },
        );
        for (const acl of JSON.parse(stdout)) {
          assert.equal(acl.protected, true);
          assert.equal(acl.owner, acl.current);
          assert.deepEqual(
            [...new Set(acl.identities)].sort(),
            [acl.current, "S-1-5-18"].sort(),
          );
        }
        evidence.windows_acl_checked = true;
      }
      if (process.platform === "win32") {
        const quoted = names
          .map(
            (name) => `'${path.join(directory, name).replaceAll("'", "''")}'`,
          )
          .join(",");
        const command = `$ErrorActionPreference='Stop'; $held=@(); @(${quoted}) | ForEach-Object { $held += [IO.File]::Open($_,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite) }; [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null; $held | ForEach-Object { $_.Dispose() }`;
        const holder = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", command],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        try {
          await new Promise((resolve, reject) => {
            holder.stdout.once("data", () => resolve());
            holder.once("exit", (code) =>
              reject(Error(`Synthetic file holder exited ${code}`)),
            );
            holder.once("error", reject);
          });
          await discard(left, admin);
          assert.equal((await fs.readdir(directory)).length, 4);
          await prepare({}, roles.editor, 429);
          await download(left, admin, 404);
        } finally {
          const exited = new Promise((resolve) => holder.once("exit", resolve));
          holder.stdin.end("\n");
          await exited;
        }
        await call("GET", "/audit/exports", undefined, admin);
        assert.equal((await fs.readdir(directory)).length, 3);
        evidence.windows_locked_cleanup_quota_checked = true;
      } else await discard(left, admin);
      const replacementFile = await prepare({}, roles.editor);
      assert.equal((await fs.readdir(directory)).length, 4);
      for (const [file, session] of [
        [right, admin],
        [third, roles.operator],
        [fourth, roles.operator],
        [replacementFile, roles.editor],
      ])
        await discard(file, session);
      assert.deepEqual(await fs.readdir(directory), []);
      assert.deepEqual(snapshot(), expectedAfterLogin);
    },
  );
  await check(
    "prepared files preserve their snapshot while later audit writes continue",
    async () => {
      const file = await prepare({ family: "fixture" }, roles.editor);
      const later = seed({
        action: "fixture.later",
        private_extension: marker,
      });
      const data = await download(file, roles.editor);
      assert(!data.events.some((x) => x.id === later.id));
      assert.equal(
        (await page({ family: "fixture" })).total,
        file.row_count + 1,
      );
      const sequence = db
        .prepare("SELECT sequence FROM audit_sequence WHERE audit_id=?")
        .get(later.id).sequence;
      assert(sequence > data.header.snapshot_sequence);
      await discard(file, roles.editor);
    },
  );
  await check(
    "large snapshot downloads stop on live session revocation and never return a complete shortened file",
    async () => {
      const baseline = (await fs.readdir(path.join(state, "audit-exports")))
        .length;
      db.exec("BEGIN");
      for (let i = 0; i < 16000; i++)
        seed({
          action: "issue.acknowledge",
          target: "b".repeat(64),
          reason: "Synthetic reviewed retirement " + "r".repeat(965),
          issue_revision: i,
          private_extension: marker,
        });
      db.exec("COMMIT");
      const preparing = prepare({ action: "issue.acknowledge" }, roles.viewer);
      let observed = false;
      for (let i = 0; i < 1000; i++) {
        const files = await fs.readdir(path.join(state, "audit-exports"));
        if (files.length > baseline) {
          for (const name of files)
            try {
              if (
                (await fs.stat(path.join(state, "audit-exports", name))).size >
                0
              )
                observed = true;
            } catch {}
        }
        if (observed) break;
        await delay(5);
      }
      assert(
        observed,
        "Observed private snapshot preparation before injecting a later write",
      );
      db.prepare("UPDATE users SET name=? WHERE id=?").run(
        "Changed after audit snapshot",
        admin.user.id,
      );
      const later = seed({
        action: "issue.acknowledge",
        target: "c".repeat(64),
        reason: "Synthetic post-snapshot event",
        issue_revision: 1,
        private_extension: marker,
      });
      const file = await preparing;
      assert(file.byte_count > 16 * 1024 * 1024);
      const data = await download(file, roles.viewer);
      assert(!data.events.some((x) => x.id === later.id));
      assert.equal(data.header.row_count, 16001);
      assert(
        data.events.every(
          (event) => event.actor === "Synthetic audit administrator",
        ),
      );
      assert.equal(
        data.events.filter((x) => x.action === "issue.acknowledge").length,
        16001,
      );
      const response = await new Promise((resolve, reject) => {
        const request = http.get(
          origin + file.download_path,
          { headers: { cookie: roles.viewer.cookie } },
          resolve,
        );
        request.on("error", reject);
      });
      assert.equal(response.statusCode, 200);
      response.pause();
      const sessionToken = roles.viewer.cookie.split("=")[1];
      db.prepare("DELETE FROM sessions WHERE verifier=?").run(
        sha(sessionToken),
      );
      let received = 0,
        ended = false;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          response.destroy();
          reject(Error("Revoked download did not terminate"));
        }, 15000);
        response.on("data", (chunk) => (received += chunk.length));
        response.on("end", () => {
          ended = true;
          clearTimeout(timer);
          resolve();
        });
        response.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
        response.on("aborted", () => {
          clearTimeout(timer);
          resolve();
        });
        response.resume();
      });
      assert.equal(ended, false);
      assert(received < file.byte_count);
      evidence.revoked_download = {
        declared_bytes: file.byte_count,
        received_bytes: received,
        completed: false,
      };
      await download(file, roles.viewer, 401);
      await prepare({}, roles.viewer, 401);
      await call("GET", "/audit/history", undefined, roles.viewer, 401);
    },
  );
  await check(
    "oversized exports reject before publishing a ready artifact and leave no extra file",
    async () => {
      db.exec("BEGIN");
      for (let i = 0; i < 100001; i++)
        seed({
          action: "fixture.cap",
          target: "",
          actor: "scheduler",
          private_extension: "",
          token: "",
        });
      db.exec("COMMIT");
      const before = (
        await fs.readdir(path.join(state, "audit-exports"))
      ).sort();
      const result = await prepare(
        { action: "fixture.cap" },
        roles.operator,
        413,
      );
      assert.equal(result.error.code, "EXPORT_TOO_LARGE");
      assert.deepEqual(
        (await fs.readdir(path.join(state, "audit-exports"))).sort(),
        before,
      );
      assert.equal((await page({ action: "fixture.cap" })).total, 100001);
    },
  );
  await check(
    "server restart clears private artifacts and invalidates prepared IDs without changing audit records",
    async () => {
      const file = await prepare({ action: "fixture.literal" }, roles.editor);
      const beforeCount = db
        .prepare("SELECT count(*) AS n FROM records WHERE kind='audit'")
        .get().n;
      db.close();
      db = undefined;
      await stop();
      await startServer();
      assert.deepEqual(await fs.readdir(path.join(state, "audit-exports")), []);
      assert.deepEqual(
        (await call("GET", "/audit/exports", undefined, roles.editor)).body,
        [],
      );
      await download(file, roles.editor, 404);
      assert.equal((await page()).total, beforeCount);
    },
  );
  evidence.synthetic_events = fixtures.length;
  evidence.passed = true;
} finally {
  db?.close();
  await stop();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith("vectory-audit-review-"));
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
      process.env.VECTORY_AUDIT_EVIDENCE ||
        path.join(root, "docs/evidence/audit-review.json"),
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
}
