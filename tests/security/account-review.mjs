// Independent real-HTTP account checks on disposable state, never a preview instance.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(root, "dashboard/package.json"));
const Ajv = require("ajv/dist/2020").default;
const schemaBytes = await fs.readFile(
  path.join(root, "contracts/protocol.schema.json"),
);
const schema = JSON.parse(schemaBytes);
const ajv = new Ajv({ strict: false, allErrors: true });
require("ajv-formats")(ajv);
ajv.addSchema(schema);
const source = path.resolve(
  process.env.VECTORY_ACCOUNT_SERVER ||
    path.join(
      root,
      "server/target/debug",
      process.platform === "win32" ? "vectory-server.exe" : "vectory-server",
    ),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-account-review-"),
);
await fs.chmod(temporary, 0o700);
const executable = path.join(temporary, path.basename(source));
await fs.copyFile(source, executable);
await fs.chmod(executable, 0o700);
const evidence = {
  recorded_at: new Date().toISOString(),
  scope:
    "Independent real HTTP on disposable loopback development instances. Synthetic accounts only. Delayed validator fixture checks authorization ordering, not native Vector validation. Expiry is forced only in isolated test databases.",
  server_sha256: createHash("sha256")
    .update(await fs.readFile(executable))
    .digest("hex"),
  protocol_schema_sha256: createHash("sha256")
    .update(schemaBytes)
    .digest("hex"),
  contract_checks: {},
  checks: [],
};
const servers = new Set();
const sha = (text) => createHash("sha256").update(text).digest("hex");
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const selected = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}
async function stop(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const closed = new Promise((resolve) => server.once("close", resolve));
  server.kill("SIGTERM");
  await Promise.race([closed, delay(3000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await closed;
  }
  servers.delete(server);
}
const interrupt = () => {
  for (const server of servers) server.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
async function fixture(name, validationUrl, task) {
  const state = path.join(temporary, name);
  const origin = `http://127.0.0.1:${await port()}`;
  const secret = randomBytes(32).toString("hex");
  const password = randomBytes(24).toString("hex");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("VECTORY_"),
    ),
  );
  const start = () =>
    spawn(executable, [], {
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
        VECTORY_BOOTSTRAP_SECRET: secret,
        ...(validationUrl ? { VECTORY_VALIDATION_URL: validationUrl } : {}),
        RUST_LOG: "vectory_server=info",
        NO_COLOR: "1",
      },
    });
  let log = "",
    failure;
  const collect = (chunk) => {
    log = (log + chunk).slice(-32768);
  };
  let server;
  async function restart() {
    if (server) await stop(server);
    log = "";
    failure = undefined;
    server = start();
    servers.add(server);
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.on("error", (error) => {
      failure = error;
    });
    const deadline = Date.now() + 20000;
    while (!log.includes("dashboard listener ready")) {
      if (failure) throw failure;
      if (server.exitCode !== null || server.signalCode !== null)
        throw Error("Isolated server exited");
      if (Date.now() >= deadline) throw Error("Isolated server did not start");
      await delay(50);
    }
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
    if (expected !== null)
      assert.equal(
        response.status,
        expected,
        `${method} ${route}: ${body.error?.code || response.status}`,
      );
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (response.status === 200 && ["/login", "/login/mfa"].includes(route)) {
      for (const name of [
        "LoginResult",
        body.mfa_required ? "LoginChallenge" : "Session",
      ]) {
        const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
        assert(validate(body), `${name}: ${JSON.stringify(validate.errors)}`);
        evidence.contract_checks[name] =
          (evidence.contract_checks[name] || 0) + 1;
      }
    }
    return {
      status: response.status,
      body,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      csrf: body.csrf_token,
      user: body.user,
    };
  }
  const login = (email, pass = password, extra = {}, expected = 200) =>
    call(
      "POST",
      "/login",
      { email, password: pass, ...extra },
      undefined,
      expected,
    );
  try {
    await restart();
    const admin = await call("POST", "/bootstrap", {
      bootstrap_secret: secret,
      name: "Synthetic administrator",
      email: "admin@example.test",
      password,
    });
    const create = async (role, email) =>
      (
        await call(
          "POST",
          "/users",
          { name: role, role, email, password, current_password: password },
          admin,
        )
      ).body;
    const current = async (id) =>
      (await call("GET", "/users", undefined, admin)).body.find(
        (user) => user.id === id,
      );
    const edit = (user, changes, actor = admin, expected = 200, extra = {}) =>
      call(
        "PUT",
        `/users/${user.id}`,
        {
          name: user.name,
          role: user.role,
          enabled: user.enabled,
          revision: user.revision,
          current_password: password,
          ...changes,
        },
        actor,
        expected,
        extra,
      );
    const issue = async (user) =>
      (
        await call(
          "POST",
          `/users/${user.id}/password-reset`,
          { revision: user.revision, current_password: password },
          admin,
        )
      ).body;
    await task({
      state,
      call,
      login,
      admin,
      password,
      create,
      current,
      edit,
      issue,
      restart,
    });
  } finally {
    await stop(server);
  }
}
async function check(name, run) {
  await run();
  evidence.checks.push({ name, passed: true });
  console.log("PASS", name);
}
function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/=+$/, ""))
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  const key = Buffer.from(
    (bits.match(/.{8}/g) || []).map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  return String(
    (digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
}

function assertChallenge(response) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    "challenge_token",
    "expires_at",
    "mfa_required",
  ]);
  assert.equal(response.body.mfa_required, true);
  assert.match(response.body.challenge_token, /^[0-9a-f]{64}$/);
  assert.equal(response.cookie, undefined);
  assert.equal(response.csrf, undefined);
  assert.equal(response.user, undefined);
  const remaining = Date.parse(response.body.expires_at) - Date.now();
  assert(remaining > 295000 && remaining <= 300000);
  return response.body;
}
const complete = (f, challenge, factor, expected = 200, headers = {}) =>
  f.call(
    "POST",
    "/login/mfa",
    { challenge_token: challenge.challenge_token, ...factor },
    undefined,
    expected,
    headers,
  );
async function mfaFixture(name, task) {
  await fixture(name, null, async (f) => {
    const person = await f.create("viewer", `${name}@example.test`);
    const session = await f.login(person.email);
    const setup = await f.call(
      "POST",
      "/mfa/setup",
      { password: f.password },
      session,
    );
    const enabled = await f.call(
      "POST",
      "/mfa/confirm",
      { code: totp(setup.body.secret) },
      session,
    );
    const db = new DatabaseSync(path.join(f.state, "vectory.db"));
    try {
      await task({
        ...f,
        person,
        session,
        db,
        secret: setup.body.secret,
        codes: enabled.body.recovery_codes,
        begin: async (password = f.password) =>
          assertChallenge(await f.login(person.email, password)),
      });
    } finally {
      db.close();
    }
  });
}

try {
  await fixture("access", null, async (f) => {
    const person = await f.create("editor", "editor@example.test"),
      editor = await f.login(person.email);
    await check(
      "account edits enforce role, CSRF and password reauthentication without invalidating a valid session",
      async () => {
        await f.edit(person, { role: "admin" }, editor, 403);
        await f.edit(person, {}, f.admin, 403, { "x-csrf-token": "wrong" });
        const wrong = await f.edit(
          person,
          { current_password: "incorrect-current-password" },
          f.admin,
          403,
        );
        assert.equal(wrong.body.error.code, "WRONG_PASSWORD");
        await f.call("GET", "/session", undefined, f.admin);
      },
    );
    await check(
      "concurrent account edits accept exactly one revision and preserve sessions for name-only changes",
      async () => {
        const replies = await Promise.all([
          f.edit(person, { name: "Name A" }, f.admin, null),
          f.edit(person, { name: "Name B" }, f.admin, null),
        ]);
        assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          replies.find((r) => r.status === 409).body.error.code,
          "STALE_REVISION",
        );
        await f.call("GET", "/session", undefined, editor);
      },
    );
    await check(
      "disable revokes existing sessions and reset codes; reenable cannot restore either",
      async () => {
        const reset = await f.issue(await f.current(person.id));
        const updated = (
          await f.edit(await f.current(person.id), { enabled: false })
        ).body;
        await f.call("GET", "/session", undefined, editor, 401);
        await f.login(person.email, f.password, {}, 401);
        await f.call(
          "POST",
          "/password-reset",
          { code: reset.code, new_password: "not-an-active-account-password" },
          undefined,
          401,
        );
        await f.call(
          "POST",
          `/users/${person.id}/password-reset`,
          { revision: updated.revision, current_password: f.password },
          f.admin,
          409,
        );
        await f.edit(updated, { enabled: true });
        await f.call("GET", "/session", undefined, editor, 401);
        await f.call(
          "POST",
          "/password-reset",
          { code: reset.code, new_password: "old-code-must-still-fail" },
          undefined,
          401,
        );
        const fresh = await f.login(person.email);
        await f.edit(await f.current(person.id), { role: "viewer" });
        await f.call("GET", "/session", undefined, fresh, 401);
        const viewer = await f.login(person.email);
        await f.call(
          "POST",
          "/configurations",
          { name: "Denied", config: {} },
          viewer,
          403,
        );
      },
    );
  });
  await fixture("sessions", null, async (f) => {
    const person = await f.create("viewer", "sessions@example.test"),
      first = await f.login(person.email),
      second = await f.login(person.email);
    await check(
      "revoke-other-sessions keeps only the current browser; password change rotates its cookie and CSRF",
      async () => {
        await f.call(
          "POST",
          "/account/revoke-sessions",
          { current_password: f.password },
          first,
        );
        await f.call("GET", "/session", undefined, first);
        await f.call("GET", "/session", undefined, second, 401);
        await f.call(
          "POST",
          "/account/password",
          { current_password: f.password, new_password: "short" },
          first,
          400,
        );
        const reset = await f.issue(await f.current(person.id));
        const next = "different-strong-synthetic-password";
        const rotated = await f.call(
          "POST",
          "/account/password",
          { current_password: f.password, new_password: next },
          first,
        );
        assert(rotated.cookie && rotated.cookie !== first.cookie);
        assert(rotated.csrf && rotated.csrf !== first.csrf);
        await f.call("GET", "/session", undefined, first, 401);
        await f.call("GET", "/session", undefined, rotated);
        await f.login(person.email, f.password, {}, 401);
        await f.login(person.email, next);
        await f.call(
          "POST",
          "/password-reset",
          { code: reset.code, new_password: "cancelled-reset-password" },
          undefined,
          401,
        );
      },
    );
  });
  await fixture("resets", null, async (f) => {
    const person = await f.create("viewer", "mfa@example.test"),
      session = await f.login(person.email);
    const setup = await f.call(
      "POST",
      "/mfa/setup",
      { password: f.password },
      session,
    );
    const confirmed = await f.call(
      "POST",
      "/mfa/confirm",
      { code: totp(setup.body.secret) },
      session,
    );
    assert.equal(confirmed.body.recovery_codes.length, 8);
    const codes = confirmed.body.recovery_codes;
    const db = new DatabaseSync(path.join(f.state, "vectory.db"));
    try {
      const initial = await f.issue(await f.current(person.id));
      await check(
        "reset codes are high-entropy, hash-only, fifteen-minute values and replacement invalidates the old code",
        async () => {
          assert.match(initial.code, /^[0-9a-f]{64}$/);
          const remaining = Date.parse(initial.expires_at) - Date.now();
          assert(remaining > 895000 && remaining <= 900000);
          const row = db
            .prepare(
              "SELECT verifier FROM password_reset_codes WHERE user_id=?",
            )
            .get(person.id);
          assert.equal(row.verifier, sha(initial.code));
          assert(
            !JSON.stringify(
              db.prepare("SELECT * FROM records WHERE kind='audit'").all(),
            ).includes(initial.code),
          );
        },
      );
      const replacement = await f.issue(await f.current(person.id));
      await f.call(
        "POST",
        "/password-reset",
        { code: initial.code, new_password: "superseded-reset-password" },
        undefined,
        401,
      );
      let winner;
      await check(
        "concurrent redemption succeeds once, starts no session and preserves mandatory MFA",
        async () => {
          const passwords = [
            "first-strong-reset-password",
            "second-strong-reset-password",
          ];
          const replies = await Promise.all(
            passwords.map((new_password) =>
              f.call(
                "POST",
                "/password-reset",
                { code: replacement.code, new_password },
                undefined,
                null,
              ),
            ),
          );
          assert.deepEqual(replies.map((r) => r.status).sort(), [200, 401]);
          winner = passwords[replies.findIndex((r) => r.status === 200)];
          assert(!replies.find((r) => r.status === 200).cookie);
          await f.call("GET", "/session", undefined, session, 401);
          await f.call(
            "POST",
            "/password-reset",
            { code: replacement.code, new_password: "replayed-reset-password" },
            undefined,
            401,
          );
          const challenge = assertChallenge(
            await f.login(person.email, winner),
          );
          const signedIn = await complete(f, challenge, {
            recovery_code: codes[0],
          });
          assert.equal(
            (await f.call("GET", "/mfa", undefined, signedIn)).body.enabled,
            true,
          );
          await complete(
            f,
            assertChallenge(await f.login(person.email, winner)),
            { recovery_code: codes[0] },
            401,
          );
          const invalid = await f.call(
            "POST",
            "/mfa/disable",
            { password: winner, code: "123" },
            signedIn,
            403,
          );
          assert.equal(invalid.body.error.code, "INVALID_MFA_CODE");
          await f.call("GET", "/session", undefined, signedIn);
        },
      );
      await check(
        "expired and cross-site reset attempts fail without consuming a still-valid code",
        async () => {
          const expired = await f.issue(await f.current(person.id));
          db.prepare(
            "UPDATE password_reset_codes SET expires_at='2000-01-01T00:00:00Z' WHERE verifier=?",
          ).run(sha(expired.code));
          await f.call(
            "POST",
            "/password-reset",
            { code: expired.code, new_password: "expired-reset-password" },
            undefined,
            401,
          );
          const valid = await f.issue(await f.current(person.id));
          const next = "cross-site-rejection-keeps-code-valid";
          await f.call(
            "POST",
            "/password-reset",
            { code: valid.code, new_password: next },
            undefined,
            403,
            { "sec-fetch-site": "cross-site" },
          );
          await f.call("POST", "/password-reset", {
            code: valid.code,
            new_password: next,
          });
          await complete(
            f,
            assertChallenge(await f.login(person.email, next)),
            { recovery_code: codes[1] },
          );
        },
      );
      await check(
        "unknown reset attempts are throttled and expose no account details",
        async () => {
          const unknown = randomBytes(32).toString("hex");
          for (let i = 0; i < 8; i++) {
            const response = await f.call(
              "POST",
              "/password-reset",
              { code: unknown, new_password: "unknown-code-password" },
              undefined,
              401,
            );
            assert(!JSON.stringify(response.body).includes(person.email));
          }
          await f.call(
            "POST",
            "/password-reset",
            { code: unknown, new_password: "unknown-code-password" },
            undefined,
            429,
          );
        },
      );
    } finally {
      db.close();
    }
  });
  await check(
    "password verification reveals MFA only for correct credentials and creates no authenticated capability",
    async () => {
      await mfaFixture("mfa-boundary", async (f) => {
        const plain = await f.create("viewer", "plain@example.test");
        const bad = await Promise.all(
          [f.person.email, plain.email, "unknown@example.test"].map((email) =>
            f.login(email, "wrong-synthetic-password", {}, 401),
          ),
        );
        assert.deepEqual(bad[0].body, bad[1].body);
        assert.deepEqual(bad[1].body, bad[2].body);
        for (const response of bad) {
          assert.equal(response.cookie, undefined);
          assert.equal(response.body.mfa_required, undefined);
        }
        const before = f.db.prepare("SELECT count(*) n FROM sessions").get().n;
        const challenge = await f.begin();
        assert.equal(
          f.db.prepare("SELECT count(*) n FROM sessions").get().n,
          before,
        );
        const row = f.db
          .prepare("SELECT * FROM login_challenges WHERE user_id=?")
          .get(f.person.id);
        assert.equal(row.verifier, sha(challenge.challenge_token));
        assert.equal(row.attempts, 0);
        assert(!JSON.stringify(row).includes(challenge.challenge_token));
        await f.call("GET", "/session", undefined, undefined, 401, {
          cookie: `vectory_session=${challenge.challenge_token}`,
        });
        await f.call("GET", "/users", undefined, undefined, 401, {
          authorization: `Bearer ${challenge.challenge_token}`,
        });
        await f.call(
          "POST",
          "/groups",
          { name: "No early authority", device_ids: [] },
          {
            cookie: `vectory_session=${challenge.challenge_token}`,
            csrf: challenge.challenge_token,
          },
          401,
        );
        const audit = JSON.stringify(
          (await f.call("GET", "/audit", undefined, f.admin)).body,
        );
        for (const secret of [
          challenge.challenge_token,
          f.password,
          f.secret,
          ...f.codes,
        ])
          assert(!audit.includes(secret));
        // A first step sent with an existing browser cookie must not rotate or upgrade it.
        const pending = await f.call(
          "POST",
          "/login",
          { email: f.person.email, password: f.password },
          f.admin,
        );
        assertChallenge(pending);
        assert.equal(
          (await f.call("GET", "/session", undefined, f.admin)).user.id,
          f.admin.user.id,
        );
      });
    },
  );
  await check(
    "MFA challenge input is strict, cross-site requests cannot consume it, and replacement and expiry invalidate it",
    async () => {
      await mfaFixture("mfa-expiry", async (f) => {
        const first = await f.begin();
        const factor = { recovery_code: f.codes[0] };
        for (const value of [
          { challenge_token: first.challenge_token },
          {
            challenge_token: first.challenge_token,
            totp_code: "123",
            recovery_code: f.codes[0],
          },
          { challenge_token: first.challenge_token, recovery_code: null },
          {
            challenge_token: first.challenge_token,
            recovery_code: f.codes[0],
            user_id: f.person.id,
          },
        ])
          await f.call("POST", "/login/mfa", value, undefined, 400);
        await complete(f, first, factor, 403, {
          "sec-fetch-site": "cross-site",
        });
        assert.equal(
          f.db
            .prepare("SELECT attempts FROM login_challenges WHERE user_id=?")
            .get(f.person.id).attempts,
          0,
        );
        const second = await f.begin();
        assert.notEqual(second.challenge_token, first.challenge_token);
        assert.equal(
          (await complete(f, first, factor, 401)).body.error.code,
          "MFA_CHALLENGE_EXPIRED",
        );
        f.db
          .prepare(
            "UPDATE login_challenges SET expires_at='2000-01-01T00:00:00Z' WHERE verifier=?",
          )
          .run(sha(second.challenge_token));
        assert.equal(
          (await complete(f, second, factor, 401)).body.error.code,
          "MFA_CHALLENGE_EXPIRED",
        );
        assert.equal(
          f.db
            .prepare(
              "SELECT count(*) n FROM mfa_recovery_codes WHERE user_id=?",
            )
            .get(f.person.id).n,
          8,
        );
        await complete(f, await f.begin(), factor);
      });
    },
  );
  await check(
    "concurrent invalid factors exhaust a durable five-attempt challenge and a new challenge cannot reset the account rate limit",
    async () => {
      await mfaFixture("mfa-attempts", async (f) => {
        const first = await f.begin();
        const replies = await Promise.all(
          Array.from({ length: 5 }, () =>
            complete(f, first, { totp_code: "badbad" }, 401),
          ),
        );
        assert.equal(
          replies.filter((r) => r.body.error.code === "INVALID_MFA_CODE")
            .length,
          4,
        );
        // The fifth wrong factor exhausts the challenge with a distinct code.
        assert.equal(
          replies.filter((r) => r.body.error.code === "MFA_TOO_MANY_ATTEMPTS")
            .length,
          1,
        );
        assert.equal(
          f.db
            .prepare("SELECT count(*) n FROM login_challenges WHERE user_id=?")
            .get(f.person.id).n,
          0,
        );
        await complete(f, first, { recovery_code: f.codes[0] }, 401);
        const second = await f.begin();
        for (let n = 0; n < 5; n++)
          await complete(f, second, { totp_code: "badbad" }, 401);
        const third = await f.begin();
        await complete(f, third, { recovery_code: f.codes[0] }, 429);
        assert.equal(
          f.db
            .prepare(
              "SELECT count(*) n FROM mfa_recovery_codes WHERE user_id=?",
            )
            .get(f.person.id).n,
          8,
        );
        assert.equal(
          f.db
            .prepare("SELECT attempts FROM login_challenges WHERE user_id=?")
            .get(f.person.id).attempts,
          0,
        );
      });
    },
  );
  await check(
    "recovery consumption, challenge deletion, audit and session issuance roll back together and concurrent completion succeeds once",
    async () => {
      await mfaFixture("mfa-atomic", async (f) => {
        const challenge = await f.begin();
        const factor = { recovery_code: f.codes[0] };
        const before = {
          sessions: f.db.prepare("SELECT count(*) n FROM sessions").get().n,
          audit: f.db
            .prepare("SELECT count(*) n FROM records WHERE kind='audit'")
            .get().n,
        };
        for (const point of ["mfa.recovery_code", "login", "session"]) {
          const trigger =
            point === "session"
              ? "CREATE TRIGGER fail_mfa_review BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'synthetic session failure'); END"
              : `CREATE TRIGGER fail_mfa_review BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='${point}' AND json_extract(NEW.data,'$.outcome')='success' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`;
          f.db.exec(trigger);
          try {
            const staged = await complete(f, challenge, factor, 500);
            const compatibility = await f.login(
              f.person.email,
              f.password,
              factor,
              500,
            );
            assert.equal(staged.cookie, undefined);
            assert.equal(compatibility.cookie, undefined);
            assert.equal(
              f.db
                .prepare(
                  "SELECT count(*) n FROM mfa_recovery_codes WHERE user_id=?",
                )
                .get(f.person.id).n,
              8,
            );
            assert.equal(
              f.db.prepare("SELECT count(*) n FROM sessions").get().n,
              before.sessions,
            );
            assert.equal(
              f.db
                .prepare("SELECT count(*) n FROM records WHERE kind='audit'")
                .get().n,
              before.audit,
            );
            assert.equal(
              f.db
                .prepare(
                  "SELECT verifier FROM login_challenges WHERE user_id=?",
                )
                .get(f.person.id).verifier,
              sha(challenge.challenge_token),
            );
          } finally {
            f.db.exec("DROP TRIGGER fail_mfa_review");
          }
        }
        const replies = await Promise.all([
          complete(f, challenge, factor, null),
          complete(f, challenge, factor, null),
        ]);
        assert.deepEqual(replies.map((r) => r.status).sort(), [200, 401]);
        assert.equal(replies.filter((r) => r.cookie).length, 1);
        assert.equal(
          f.db
            .prepare(
              "SELECT count(*) n FROM mfa_recovery_codes WHERE user_id=?",
            )
            .get(f.person.id).n,
          7,
        );
        const loggedIn = replies.find((r) => r.status === 200);
        await f.call("GET", "/session", undefined, loggedIn);
        const next = await f.begin();
        assert.equal(
          (await complete(f, next, factor, 401)).body.error.code,
          "INVALID_MFA_CODE",
        );
        await complete(f, next, { recovery_code: f.codes[1] });
      });
    },
  );
  await check(
    "successful authenticator completion consumes its time step and a fresh challenge does not permit TOTP replay",
    async () => {
      await mfaFixture("mfa-totp", async (f) => {
        const first = await f.begin();
        const code = totp(f.secret, Math.floor(Date.now() / 30000) + 1);
        const result = await complete(f, first, { totp_code: code });
        await f.call("GET", "/session", undefined, result);
        const second = await f.begin();
        assert.equal(
          (await complete(f, second, { totp_code: code }, 401)).body.error.code,
          "INVALID_MFA_CODE",
        );
        await complete(f, second, { recovery_code: f.codes[0] });
      });
    },
  );
  await check(
    "account edits, password changes and reset redemption invalidate pending password-verified challenges",
    async () => {
      for (const mutation of [
        "rename",
        "role",
        "disable-reenable",
        "password",
        "reset",
      ]) {
        await mfaFixture(`mfa-${mutation}`, async (f) => {
          const challenge = await f.begin();
          if (mutation === "rename")
            await f.edit(await f.current(f.person.id), {
              name: "Renamed after password verification",
            });
          if (mutation === "role")
            await f.edit(await f.current(f.person.id), { role: "operator" });
          if (mutation === "disable-reenable") {
            await f.edit(await f.current(f.person.id), { enabled: false });
            const denied = await f.login(f.person.email, f.password, {}, 401);
            assert.equal(denied.body.mfa_required, undefined);
            assert.equal(denied.cookie, undefined);
            await f.edit(await f.current(f.person.id), { enabled: true });
          }
          if (mutation === "password")
            await f.call(
              "POST",
              "/account/password",
              {
                current_password: f.password,
                new_password: "replacement-synthetic-password",
              },
              f.session,
            );
          if (mutation === "reset") {
            const reset = await f.issue(await f.current(f.person.id));
            await f.call("POST", "/password-reset", {
              code: reset.code,
              new_password: "replacement-reset-password",
            });
          }
          assert.equal(
            (await complete(f, challenge, { recovery_code: f.codes[0] }, 401))
              .body.error.code,
            "MFA_CHALLENGE_EXPIRED",
          );
          assert.equal(
            f.db
              .prepare(
                "SELECT count(*) n FROM mfa_recovery_codes WHERE user_id=?",
              )
              .get(f.person.id).n,
            8,
          );
        });
      }
    },
  );
  await check(
    "explicit session revocation and logout also invalidate pending MFA challenges",
    async () => {
      for (const mutation of ["revoke", "logout"])
        await mfaFixture(`mfa-${mutation}`, async (f) => {
          const challenge = await f.begin();
          if (mutation === "revoke")
            await f.call(
              "POST",
              "/account/revoke-sessions",
              { current_password: f.password },
              f.session,
            );
          else await f.call("POST", "/logout", undefined, f.session);
          assert.equal(
            (await complete(f, challenge, { recovery_code: f.codes[0] }, 401))
              .body.error.code,
            "MFA_CHALLENGE_EXPIRED",
          );
        });
    },
  );
  await check(
    "MFA disable and fresh enrollment cannot turn an old challenge into a password-only session",
    async () => {
      await mfaFixture("mfa-enrollment", async (f) => {
        const challenge = await f.begin();
        await f.call(
          "POST",
          "/mfa/disable",
          { password: f.password, recovery_code: f.codes[0] },
          f.session,
        );
        assert.equal(
          (await complete(f, challenge, { recovery_code: f.codes[1] }, 401))
            .body.error.code,
          "MFA_CHALLENGE_EXPIRED",
        );
        const setup = await f.call(
          "POST",
          "/mfa/setup",
          { password: f.password },
          f.session,
        );
        const enabled = await f.call(
          "POST",
          "/mfa/confirm",
          { code: totp(setup.body.secret) },
          f.session,
        );
        await complete(
          f,
          challenge,
          { recovery_code: enabled.body.recovery_codes[0] },
          401,
        );
        await complete(f, await f.begin(), {
          recovery_code: enabled.body.recovery_codes[0],
        });
      });
    },
  );
  await check(
    "a server restart clears pending challenges while retaining MFA enrollment and unconsumed recovery codes",
    async () => {
      await mfaFixture("mfa-restart", async (f) => {
        const challenge = await f.begin();
        await f.restart();
        assert.equal(
          (await complete(f, challenge, { recovery_code: f.codes[0] }, 401))
            .body.error.code,
          "MFA_CHALLENGE_EXPIRED",
        );
        assert.equal(
          f.db.prepare("SELECT count(*) n FROM login_challenges").get().n,
          0,
        );
        assert.equal(
          f.db
            .prepare(
              "SELECT count(*) n FROM mfa_recovery_codes WHERE user_id=?",
            )
            .get(f.person.id).n,
          8,
        );
        await complete(f, await f.begin(), { recovery_code: f.codes[0] });
      });
    },
  );
  await fixture("last-admin", null, async (f) => {
    const other = await f.create("admin", "second-admin@example.test"),
      second = await f.login(other.email);
    await check(
      "simultaneous administrator self-removals retain exactly one enabled administrator",
      async () => {
        const replies = await Promise.all([
          f.edit(f.admin.user, { role: "viewer" }, f.admin, null),
          f.edit(other, { role: "viewer" }, second, null),
        ]);
        assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
        const survivor = replies[0].status === 409 ? f.admin : second;
        const users = (await f.call("GET", "/users", undefined, survivor)).body;
        const admins = users.filter(
          (user) => user.enabled && user.role === "admin",
        );
        assert.equal(admins.length, 1);
        await f.edit(admins[0], { enabled: false }, survivor, 409);
      },
    );
  });
  let release, reached;
  const pending = new Promise((resolve) => {
    reached = resolve;
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const validator = http.createServer(async (request, response) => {
    for await (const chunk of request) {
      /* Consume this explicitly synthetic validator input. */
    }
    reached();
    await hold;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        valid: true,
        errors: [],
        warnings: [],
        vector_validated: false,
        vector_version: "0.58.0",
      }),
    );
  });
  await new Promise((resolve) => validator.listen(0, "127.0.0.1", resolve));
  try {
    await fixture(
      "offboard-race",
      `http://127.0.0.1:${validator.address().port}`,
      async (f) => {
        const person = await f.create("operator", "publisher@example.test"),
          publisher = await f.login(person.email);
        const config = {
          sources: { sample: { type: "demo_logs", format: "json" } },
          sinks: { out: { type: "blackhole", inputs: ["sample"] } },
        };
        const draft = (
          await f.call(
            "POST",
            "/configurations",
            {
              name: "Synthetic authorization race",
              config,
              graph: { nodes: [], edges: [] },
            },
            f.admin,
          )
        ).body;
        await check(
          "offboarding defeats an already-started publication after external validation finishes",
          async () => {
            const attempt = f.call(
              "POST",
              `/configurations/${draft.id}/publish`,
              { revision: draft.revision },
              publisher,
              401,
            );
            await Promise.race([
              pending,
              delay(3000).then(() => {
                throw Error("Publish did not reach controlled validator");
              }),
            ]);
            await f.edit(person, { enabled: false });
            release();
            await attempt;
            const db = new DatabaseSync(path.join(f.state, "vectory.db"), {
              readOnly: true,
            });
            try {
              assert.equal(
                db
                  .prepare(
                    "SELECT count(*) n FROM records WHERE kind='version'",
                  )
                  .get().n,
                0,
              );
            } finally {
              db.close();
            }
          },
        );
      },
    );
  } finally {
    release();
    validator.closeAllConnections();
    await new Promise((resolve) => validator.close(resolve));
  }
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.failure = error.message;
  throw error;
} finally {
  for (const server of servers) await stop(server);
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert(path.basename(temporary).startsWith("vectory-account-review-"));
  await fs.rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  evidence.fixture_removed = true;
  evidence.finished_at = new Date().toISOString();
  const output = path.resolve(
    process.env.VECTORY_ACCOUNT_EVIDENCE ||
      path.join(root, "docs/evidence/account-review.json"),
  );
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
