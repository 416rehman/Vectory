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
  // Pre-generated so lineage fields can name other deployments, and a clock
  // that gives every fixture event its own second.
  const deploymentIds = Array.from({ length: 223 }, () => randomUUID());
  // Two deployments name this group; the filter must find exactly them.
  const groupId = randomUUID();
  const at = (index, seconds = 0) =>
    new Date(
      Date.UTC(2026, 0, 3) + (index * 100 + seconds) * 1000,
    ).toISOString();
  // The operator's stored name is longer than the API allows, so the bound on
  // the creator's name is visible.
  const longUserName = "O".repeat(150);
  db.prepare("UPDATE users SET name=? WHERE id=?").run(
    longUserName,
    roles.operator.user.id,
  );
  const userNames = new Map([
    [admin.user.id, admin.user.name],
    [roles.viewer.user.id, roles.viewer.user.name],
    [roles.editor.user.id, roles.editor.user.name],
    [roles.operator.user.id, longUserName],
  ]);
  const policies = [
    record("policy", {
      id: randomUUID(),
      name: "Synthetic agent settings",
      created_at: "2026-01-01T00:00:00Z",
      heartbeat_seconds: 90,
      private: marker,
    }),
    // The marker sits past the 120 character bound of a projected name.
    record("policy", {
      id: randomUUID(),
      name: "P".repeat(200) + marker,
      created_at: "2026-01-01T00:00:00Z",
      private: marker,
    }),
  ];
  const audit = (entry) =>
    record("audit", {
      id: randomUUID(),
      outcome: "success",
      details: { private: marker },
      ...entry,
    });
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
  // Who created a deployment and which agent settings it applies. Each hostile
  // shape (an object, an unknown identity, oversized text) must project as null
  // or as bounded text, never as stored data.
  function provenanceFor(index, policy) {
    const fields = {};
    if (index % 6 === 1) fields.created_by = roles.operator.user.id;
    if (index % 6 === 2) fields.created_by = roles.editor.user.id;
    if (index % 6 === 4) fields.created_by = randomUUID();
    if (index % 6 === 5) fields.created_by = { private: marker };
    // Older deployments carry no creator; their audit trail names one.
    if (index % 12 === 3)
      audit({
        actor: roles.viewer.user.id,
        action: "deployment.create",
        target: deploymentIds[index],
        created_at: at(index, 90),
      });
    if (index % 12 === 9)
      audit({
        actor: roles.editor.user.id,
        action: "deployment.schedule",
        target: deploymentIds[index],
        created_at: at(index, 90),
      });
    if (policy)
      fields.policy_id =
        index === 100
          ? { private: marker }
          : index === 140
            ? randomUUID()
            : policies[index % 40 === 0 ? 0 : 1].id;
    return fields;
  }
  // Outcome timestamps and reasons written when a deployment ends.
  function outcomeFor(index, status) {
    const fields = {};
    if (status === "completed")
      fields.completed_at = index % 21 === 3 ? 12345 : at(index, 20);
    if (status === "failed") {
      fields.failed_at = index % 21 === 4 ? { private: marker } : at(index, 30);
      if (index % 14 === 4) fields.failure_reason = "threshold";
      if (index % 14 === 11) fields.failure_reason = "x".repeat(80) + marker;
    }
    if (status === "cancelled")
      fields.cancelled_at = index % 21 === 2 ? [marker] : at(index, 10);
    if (status === "unassigned") {
      fields.removed_at = at(index, 40);
      fields.status_before_removal =
        index % 21 === 0 && index > 0 ? "y".repeat(100) + marker : "active";
    }
    return fields;
  }
  // Rollback and replacement lineage. The marker rides along in every stored
  // entry so only the four named fields can leave.
  function lineageFor(index) {
    const fields = {};
    if (index === 10)
      Object.assign(fields, {
        rolled_back_by: deploymentIds[11],
        rolled_back_at: at(10, 50),
        status_before_rollback: "completed",
      });
    if (index === 11) fields.rollback_of = deploymentIds[10];
    if (index === 13) fields.rolled_back_by = { private: marker };
    if (index === 14) fields.rollback_of = 42;
    if (index === 17) fields.status_before_rollback = "z".repeat(100) + marker;
    if (index === 0)
      fields.replaced_by = [
        {
          deployment_id: deploymentIds[3],
          device_count: 15,
          at: at(0, 7),
          private: marker,
        },
        { deployment_id: deploymentIds[4], device_count: 3, at: at(0, 8) },
      ];
    if (index === 2)
      fields.replaced_by = [
        {
          deployment_id: deploymentIds[3],
          device_count: 5,
          at: at(2, 5),
          private: marker,
        },
        { deployment_id: randomUUID(), device_count: 1, at: at(2, 6) },
      ];
    if (index === 3) fields.replaces = [deploymentIds[2], randomUUID()];
    if (index === 5) fields.replaced_by = "not-an-array";
    if (index === 6) fields.replaces = { private: marker };
    return fields;
  }
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
        id: deploymentIds[index],
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
          group_ids: index === 30 || index === 31 ? [groupId] : [],
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
        ...provenanceFor(index, policy),
        ...outcomeFor(index, status),
        ...lineageFor(index),
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
    "INSERT INTO devices(id,name,data,revoked,policy,policy_generation) VALUES(?,?,?,?,?,?)",
  );
  const insertTarget = db.prepare(
    "INSERT INTO deployment_targets(deployment_id,device_id,state,generation,error,original,previous_version_id,released_at,verified_at) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  // The agent's failed attempt for a target and the first diagnostic a reader
  // may see for it (or null). Every stored object also carries the marker in
  // fields no projection may copy.
  function attemptFor(index) {
    let attempt,
      terminal,
      diagnostic = null;
    if (index % 7 === 0) {
      attempt = {
        generation: index,
        error: {
          diagnostics: [
            { message: `Rejected component ${index}`, private: marker },
          ],
          private: marker,
        },
        private: marker,
      };
      diagnostic = `Rejected component ${index}`;
    }
    if (index === 14) {
      attempt.error.diagnostics[0].message = "m".repeat(800);
      diagnostic = "m".repeat(500);
    }
    if (index === 21) {
      terminal = {
        generation: 21,
        error: { diagnostics: [{ message: "Terminal diagnostic" }] },
        private: marker,
      };
      diagnostic = "Terminal diagnostic";
    }
    if (index === 28) {
      // An attempt for another generation says nothing about this one.
      attempt.generation = 29;
      diagnostic = null;
    }
    // Stored attempt errors always have safe_error's shape: diagnostics are
    // objects with a message. A bare string or a summary field is not one,
    // so the server projects no diagnostic for either.
    if (index === 35) {
      attempt.error.diagnostics = ["Plain string diagnostic"];
      diagnostic = null;
    }
    if (index === 42) {
      attempt.error = { summary: "  Error summary  ", diagnostics: [] };
      diagnostic = null;
    }
    if (index === 49) {
      attempt.error.diagnostics[0].message = "   ";
      diagnostic = null;
    }
    // The apply step that failed: a token of lower-case letters and underscores,
    // at most 32 long, from this generation's terminal attempt first. Anything
    // else the agent stored there (case, digits, hyphens, length, type, another
    // generation, the marker) reads as none.
    let stage = null;
    if (attempt) {
      const stored = {
        14: "reload",
        35: "Validation",
        42: "a".repeat(33),
        49: marker,
        56: "a".repeat(32),
        63: "step2",
        70: "",
        77: 7,
        84: "reload_step",
        91: "hyphen-ated",
      };
      const shown = {
        14: "reload",
        21: "rollback",
        28: null,
        35: null,
        42: null,
        49: null,
        56: "a".repeat(32),
        63: null,
        70: null,
        77: null,
        84: "reload_step",
        91: null,
      };
      attempt.error.stage = index in stored ? stored[index] : "validation";
      if (terminal) terminal.error.stage = "rollback";
      stage = index in shown ? shown[index] : "validation";
    }
    return { attempt, terminal, diagnostic, stage };
  }
  // Agent settings for a device and the check-in interval a reader may see: an
  // integer from 10 to 3600 seconds. The column default (60 seconds) applies
  // unless a fixture stores its own settings, some of them hostile.
  const defaultSettings = JSON.stringify({
    heartbeat_seconds: 60,
    sync_paused: false,
    telemetry_enabled: true,
  });
  function settingsFor(index) {
    const stored = (heartbeat) =>
      JSON.stringify({
        heartbeat_seconds: heartbeat,
        sync_paused: false,
        telemetry_enabled: true,
        private: marker,
      });
    if (index === 15) return { policy: stored(10 ** 12), seconds: 3600 };
    if (index === 20) return { policy: stored(1), seconds: 60 };
    if (index === 25) return { policy: stored("fast"), seconds: 60 };
    if (index === 30)
      return { policy: stored(45), seconds: 45, acknowledged: true };
    if (index % 5 === 0) return { policy: stored(90), seconds: 90 };
    return { policy: defaultSettings, seconds: 60 };
  }
  // Apply-state events the audit trail holds for a device. A target shows only
  // those inside its own release window, in order, deduplicated, at most 12.
  const expectedTimelines = new Map([
    [
      1,
      [
        { state: "desired", at: at(1, 2) },
        { state: "downloaded", at: at(1, 3) },
        { state: "validated", at: at(1, 5) },
        { state: "s".repeat(32), at: at(1, 6) },
      ],
    ],
    [
      2,
      Array.from({ length: 12 }, (_, step) => ({
        state: `step-${step + 18}`,
        at: at(2, 2 + step + 18),
      })),
    ],
    [
      4,
      [
        { state: "desired", at: at(4, 2) },
        { state: "verified_applied", at: at(4, 44) },
      ],
    ],
  ]);
  const applyState = (deviceId, outcome, created_at, action) =>
    audit({
      actor: deviceId,
      action: action || "device.apply_state",
      target: deviceId,
      outcome,
      created_at,
    });
  const deviceIds = [];
  for (let index = 0; index < 151; index++) {
    const state = targetStates[index % targetStates.length];
    const { attempt, terminal, diagnostic, stage } = attemptFor(index);
    const settings = settingsFor(index);
    const lastSeen =
      index === 10
        ? "l".repeat(80) + marker
        : index === 11
          ? { private: marker }
          : index % 3 === 0
            ? at(index, 2)
            : undefined;
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
      last_seen: lastSeen,
      configuration_attempt: attempt,
      terminal_configuration_attempt: terminal,
      policy_generation: settings.acknowledged ? 5 : undefined,
      // An open data-plane problem on the version deployment 21 delivers. Only
      // four fields of it may reach a verified row of that deployment.
      data_plane:
        index === 6
          ? {
              version_id: versions[21].id,
              issues: [
                {
                  code: "DATA_PLANE_STALLED",
                  title: "Nothing is being delivered",
                  message: "No events were read in the last 10 minutes.",
                  hint: "Check that the source can reach its input.",
                  private: marker,
                  detail: { private: marker },
                },
              ],
            }
          : undefined,
      private: marker,
    };
    deviceIds.push(device.id);
    insertDevice.run(
      device.id,
      device.name,
      JSON.stringify(device),
      index % 13 === 0 ? 1 : 0,
      settings.policy,
      settings.acknowledged ? 3 : 0,
    );
    const released_at = state === "pending" ? null : at(index, 1);
    const verified_at = state === "verified_applied" ? at(index, 45) : null;
    const target = {
      device_id: device.id,
      device_name: device.name,
      state,
      generation: index,
      error: index % 7 === 0 ? "Synthetic observed failure" : null,
      original: index % 3 !== 0,
      released_at,
      verified_at,
      last_seen:
        typeof lastSeen === "string"
          ? [...lastSeen].slice(0, 64).join("")
          : null,
      // A replaced target names the deployment that took the device over.
      replaced_by:
        state === "removed" && index === 8
          ? deploymentIds[3]
          : state === "removed" && index === 18
            ? deploymentIds[4]
            : null,
      diagnostic,
      failure_stage: stage,
      check_in_seconds: settings.seconds,
      timeline: expectedTimelines.get(index) || [],
    };
    insertTarget.run(
      parent.id,
      device.id,
      target.state,
      target.generation,
      target.error,
      target.original ? 1 : 0,
      index % 9 === 2 ? versions[0].id : null,
      released_at,
      verified_at,
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
        null,
        null,
        null,
      );
  }
  // Timeline fixtures. Anything before the release, after verification, of
  // another action or on another device must stay out; long runs keep the last 12.
  {
    const [, first, second, , fourth] = deviceIds;
    applyState(first, "stale", at(1, 0));
    applyState(first, "desired", at(1, 2));
    applyState(first, "downloaded", at(1, 3));
    applyState(first, "downloaded", at(1, 4));
    applyState(first, "validated", at(1, 5));
    applyState(first, "s".repeat(40) + marker, at(1, 6));
    applyState(first, marker, at(1, 7), "device.enroll");
    for (let step = 0; step < 30; step++)
      applyState(
        second,
        `step-${String(step).padStart(2, "0")}`,
        at(2, 2 + step),
      );
    applyState(fourth, "stale", at(4, 0));
    applyState(fourth, "desired", at(4, 2));
    applyState(fourth, "verified_applied", at(4, 44));
    applyState(fourth, "late", at(4, 50));
  }
  // Other deployments' targets: a successor for two removed devices, rollback
  // availability from a removed and a verified target, and a paused canary.
  const extraTarget = (deployment, index, state, generation, previous) =>
    insertTarget.run(
      deployment.id,
      deviceIds[index],
      state,
      generation,
      null,
      1,
      previous ? versions[0].id : null,
      null,
      null,
    );
  extraTarget(deployments[3], 8, "pending", 0, false);
  extraTarget(deployments[4], 18, "pending", 0, false);
  extraTarget(deployments[20], 5, "removed", 5, true);
  extraTarget(deployments[21], 6, "verified_applied", 3, true);
  const paused = deployments[5];
  assert.equal(paused.status, "paused");
  extraTarget(paused, 30, "verified_applied", 1, false);
  extraTarget(paused, 31, "pending", 0, false);
  extraTarget(paused, 32, "failed", 1, false);
  const rollbackAvailable = (id) =>
    db
      .prepare(
        "SELECT count(*) AS n FROM deployment_targets WHERE deployment_id=? AND generation>0 AND state<>'removed' AND previous_version_id IS NOT NULL",
      )
      .get(id).n > 0;
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
    defaultSettings,
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
    "rollback_idempotency",
    "rollback_review",
    "request_correlation",
    "created_by_name",
    "policy_id",
    "policy_name",
    "rollback_available",
    "completed_at",
    "failed_at",
    "failure_reason",
    "cancelled_at",
    "removed_at",
    "status_before_removal",
    "status_before_rollback",
    "rolled_back_at",
    "rolled_back_by",
    "rolled_back_to_version",
    "rolled_back_to_configuration_name",
    "rollback_of",
    "rollback_of_version",
    "rollback_of_configuration_name",
    "replaced_by",
    "replaces",
  ].sort();
  const targetKeys = [
    "device_id",
    "device_name",
    "state",
    "generation",
    "error",
    "original",
    "released_at",
    "verified_at",
    "last_seen",
    "replaced_by",
    "diagnostic",
    "failure_stage",
    "check_in_seconds",
    "timeline",
  ].sort();
  const deliveryCodes = [
    "DATA_PLANE_STALLED",
    "DATA_PLANE_SINK_ERRORS",
    "DATA_PLANE_BUFFER_FULL",
    "DATA_PLANE_ERROR_DROPS",
  ];
  const route = (query = {}) =>
    "/deployments/history?" + new URLSearchParams(query);
  const targetRoute = (id, query = {}) =>
    `/deployments/${id}/targets?` + new URLSearchParams(query);
  const characters = (value) => [...value].length;
  const cut = (value, max) =>
    typeof value === "string" ? [...value].slice(0, max).join("") : null;
  const bounded = (value, max) =>
    value === null || (typeof value === "string" && characters(value) <= max);
  const uuidShape =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const timestampShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  const isId = (value) => value === null || uuidShape.test(value);
  const isWhen = (value) =>
    value === null ||
    (typeof value === "string" &&
      value.length <= 64 &&
      timestampShape.test(value));
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const isNumber = (value) =>
    value === null || (Number.isSafeInteger(value) && value >= 1);
  // The version number of the deployment with this id, as its record says.
  const versionNumberOf = (id) => {
    const found = deployments.find((d) => d.id === id);
    const version =
      found && typeof found.version_id === "string"
        ? versions.find((v) => v.id === found.version_id)
        : undefined;
    return version ? version.number : null;
  };
  // The pipeline name of the deployment with this id, bounded as the API
  // bounds lineage names.
  const pipelineNameOf = (id) => {
    const found = deployments.find((d) => d.id === id);
    const version =
      found && typeof found.version_id === "string"
        ? versions.find((v) => v.id === found.version_id)
        : undefined;
    const pipeline = version
      ? configurations.find((c) => c.id === version.configuration_id)
      : undefined;
    return pipeline ? cut(pipeline.name, 240) : null;
  };
  // What the provenance, outcome and lineage fields must read for a stored
  // deployment: text and identities only when they are the right type, bounded
  // where the API bounds them, and nothing else copied from lineage entries.
  function expectedFields(stored) {
    const actor =
      stored.created_by !== undefined
        ? stored.created_by
        : db
            .prepare(
              "SELECT json_extract(data,'$.actor') AS actor FROM records WHERE kind='audit' AND json_extract(data,'$.target')=? AND json_extract(data,'$.action') IN ('deployment.create','deployment.schedule') LIMIT 1",
            )
            .get(stored.id)?.actor;
    const text = (value) => (typeof value === "string" ? value : null);
    const policy = policies.find((p) => p.id === stored.policy_id);
    return {
      rollback_idempotency: true,
      rollback_review: true,
      request_correlation: true,
      created_by_name: cut(userNames.get(actor), 120),
      policy_id: text(stored.policy_id),
      policy_name: policy ? cut(policy.name, 120) : null,
      rollback_available: rollbackAvailable(stored.id),
      completed_at: text(stored.completed_at),
      failed_at: text(stored.failed_at),
      failure_reason: cut(stored.failure_reason, 64),
      cancelled_at: text(stored.cancelled_at),
      removed_at: text(stored.removed_at),
      status_before_removal: cut(stored.status_before_removal, 64),
      status_before_rollback: cut(stored.status_before_rollback, 64),
      rolled_back_at: text(stored.rolled_back_at),
      rolled_back_by: text(stored.rolled_back_by),
      rolled_back_to_version:
        typeof stored.rolled_back_by === "string"
          ? versionNumberOf(stored.rolled_back_by)
          : null,
      rolled_back_to_configuration_name:
        typeof stored.rolled_back_by === "string"
          ? pipelineNameOf(stored.rolled_back_by)
          : null,
      rollback_of: text(stored.rollback_of),
      rollback_of_version:
        typeof stored.rollback_of === "string"
          ? versionNumberOf(stored.rollback_of)
          : null,
      rollback_of_configuration_name:
        typeof stored.rollback_of === "string"
          ? pipelineNameOf(stored.rollback_of)
          : null,
      replaced_by: Array.isArray(stored.replaced_by)
        ? stored.replaced_by.map((entry) => ({
            deployment_id: entry.deployment_id,
            device_count: entry.device_count,
            at: entry.at,
            version_number: versionNumberOf(entry.deployment_id),
            configuration_name: pipelineNameOf(entry.deployment_id),
          }))
        : [],
      replaces: Array.isArray(stored.replaces)
        ? stored.replaces.map((id) => ({
            deployment_id: id,
            version_number: versionNumberOf(id),
            configuration_name: pipelineNameOf(id),
          }))
        : [],
    };
  }
  const newSummaryKeys = Object.keys(expectedFields(deployments[1]));
  const canaryGateKeys = [
    "evaluated_at",
    "observation_seconds",
    "observation_started_at",
    "pending_count",
    "reasons",
    "released_count",
    "state",
    "verified_count",
  ];
  // Why a released device does not yet count toward the canary's proof:
  // measuring and degraded come from the data-plane check on its version.
  const gateReasons = [
    "degraded",
    "measuring",
    "paused",
    "stale",
    "superseded",
    "unavailable",
    "unverified",
  ];
  function gate(value) {
    assert.deepEqual(Object.keys(value).sort(), canaryGateKeys);
    assert(["paused", "observing", "waiting"].includes(value.state));
    for (const field of ["released_count", "verified_count", "pending_count"])
      assert(isCount(value[field]), field);
    assert.deepEqual(Object.keys(value.reasons).sort(), gateReasons);
    assert(Object.values(value.reasons).every(isCount));
    assert(
      Number.isInteger(value.observation_seconds) &&
        value.observation_seconds >= 0 &&
        value.observation_seconds <= 86400,
    );
    assert(isWhen(value.observation_started_at));
    assert(isWhen(value.evaluated_at) && value.evaluated_at !== null);
  }
  function summary(value) {
    // A paused or active canary's own read also carries its gate.
    const { canary_gate, ...rest } = value;
    if (canary_gate !== undefined) gate(canary_gate);
    assert.deepEqual(Object.keys(rest).sort(), summaryKeys);
    assert(!JSON.stringify(value).includes(marker));
    // Advertised capabilities are literal booleans, never stored values.
    for (const flag of [
      "rollback_idempotency",
      "rollback_review",
      "request_correlation",
    ])
      assert.strictEqual(value[flag], true, flag);
    // Provenance: names and identities are bounded text or null.
    assert(bounded(value.created_by_name, 120));
    assert(isId(value.policy_id));
    assert(bounded(value.policy_name, 120));
    assert.equal(typeof value.rollback_available, "boolean");
    // Outcome: timestamps are date-shaped text, reasons short bounded text.
    for (const field of [
      "completed_at",
      "failed_at",
      "cancelled_at",
      "removed_at",
      "rolled_back_at",
    ])
      assert(isWhen(value[field]), field);
    for (const field of [
      "failure_reason",
      "status_before_removal",
      "status_before_rollback",
    ])
      assert(bounded(value[field], 64), field);
    // Lineage: identities, version numbers and exactly the advertised entry keys.
    assert(isId(value.rolled_back_by) && isId(value.rollback_of));
    assert(isNumber(value.rolled_back_to_version));
    assert(isNumber(value.rollback_of_version));
    // Lineage names the pipeline on the other side: bounded text or null.
    assert(bounded(value.rolled_back_to_configuration_name, 240));
    assert(bounded(value.rollback_of_configuration_name, 240));
    assert(Array.isArray(value.replaced_by));
    for (const entry of value.replaced_by) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "at",
        "configuration_name",
        "deployment_id",
        "device_count",
        "version_number",
      ]);
      assert(isId(entry.deployment_id) && entry.deployment_id !== null);
      assert(isCount(entry.device_count));
      assert(isWhen(entry.at) && entry.at !== null);
      assert(isNumber(entry.version_number));
      assert(bounded(entry.configuration_name, 240));
    }
    assert(Array.isArray(value.replaces));
    for (const entry of value.replaces) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "configuration_name",
        "deployment_id",
        "version_number",
      ]);
      assert(isId(entry.deployment_id) && entry.deployment_id !== null);
      assert(isNumber(entry.version_number));
      assert(bounded(entry.configuration_name, 240));
    }
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
  // One target row. A canary gate adds a per-target reason to a paused or
  // active deployment's rows.
  function targetProjection(target, gated = false) {
    const { gate_reason, delivery, ...rest } = target;
    if (gated)
      assert(gate_reason === null || gateReasons.includes(gate_reason));
    else assert.equal(gate_reason, undefined);
    assert.deepEqual(Object.keys(rest).sort(), targetKeys);
    assert(!JSON.stringify(target).includes(marker));
    assert(uuidShape.test(target.device_id));
    assert(
      target.device_name === null || typeof target.device_name === "string",
    );
    assert(typeof target.state === "string" && characters(target.state) <= 64);
    assert(isCount(target.generation));
    assert(bounded(target.error, 500));
    assert.equal(typeof target.original, "boolean");
    assert(isWhen(target.released_at) && isWhen(target.verified_at));
    // A device's own text is cut at 64 characters; reasons at 500.
    assert(bounded(target.last_seen, 64));
    assert(isId(target.replaced_by));
    assert(bounded(target.diagnostic, 500));
    assert(
      target.failure_stage === null ||
        (typeof target.failure_stage === "string" &&
          /^[a-z_]{1,32}$/.test(target.failure_stage)),
    );
    // Present only on a verified row whose device has an open data-plane
    // problem on this deployment's version: four fields, nothing else stored.
    if (delivery !== undefined) {
      assert.equal(target.state, "verified_applied");
      assert.deepEqual(Object.keys(delivery).sort(), [
        "code",
        "hint",
        "message",
        "title",
      ]);
      assert(deliveryCodes.includes(delivery.code));
      assert(
        typeof delivery.title === "string" && characters(delivery.title) <= 120,
      );
      assert(bounded(delivery.message, 300) && bounded(delivery.hint, 200));
    }
    assert(
      target.check_in_seconds === null ||
        (Number.isInteger(target.check_in_seconds) &&
          target.check_in_seconds >= 10 &&
          target.check_in_seconds <= 3600),
    );
    assert(Array.isArray(target.timeline) && target.timeline.length <= 12);
    for (const event of target.timeline) {
      assert.deepEqual(Object.keys(event).sort(), ["at", "state"]);
      assert(
        typeof event.state === "string" &&
          characters(event.state) >= 1 &&
          characters(event.state) <= 32,
      );
      assert(isWhen(event.at) && event.at !== null);
    }
    const times = target.timeline.map((event) => event.at);
    assert.deepEqual(times, [...times].sort());
  }
  function pageEnvelope(value, expectedKeys, gated = false) {
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
    for (const item of value.items) {
      if (expectedKeys === targetKeys) targetProjection(item, gated);
      else assert.deepEqual(Object.keys(item).sort(), expectedKeys);
    }
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
    "a data-plane delivery problem is projected only on the verified row it belongs to, as four fields",
    async () => {
      const page = await get(targetRoute(deployments[21].id));
      pageEnvelope(page, targetKeys);
      assert.equal(page.total, 1);
      assert.equal(page.items[0].device_id, deviceIds[6]);
      assert.deepEqual(page.items[0].delivery, {
        code: "DATA_PLANE_STALLED",
        title: "Nothing is being delivered",
        message: "No events were read in the last 10 minutes.",
        hint: "Check that the source can reach its input.",
      });
      // The same device on another deployment, and every other row, carry none.
      for (const row of (await get(targetRoute(parent.id))).items)
        assert.equal(row.delivery, undefined);
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
      const exercised = new Set();
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
          // Provenance, outcome and lineage read exactly what the stored
          // record says, bounded and typed, and nothing else.
          const expected = expectedFields(original);
          assert.deepEqual(
            Object.fromEntries(newSummaryKeys.map((key) => [key, item[key]])),
            expected,
            item.id,
          );
          for (const key of newSummaryKeys) {
            const value = item[key];
            if (
              value !== null &&
              value !== false &&
              !(Array.isArray(value) && !value.length)
            )
              exercised.add(key);
          }
          if (item.rollback_available === false) exercised.add("not_available");
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
      // The fixtures reached every new field with a real value, so the checks
      // above proved more than the absence of data.
      assert.deepEqual(
        [...newSummaryKeys, "not_available"].filter(
          (key) => !exercised.has(key),
        ),
        [],
      );
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
    "a paused canary's gate, per-target reasons, rollback availability and successors are bounded metadata",
    async () => {
      const metadata = await get(`/deployments/${paused.id}/summary`);
      summary(metadata);
      assert.equal(metadata.canary_gate.state, "paused");
      assert.equal(metadata.target_count, 3);
      for (const session of Object.values(roles))
        summary(await get(`/deployments/${paused.id}/summary`, session));
      const rows = await get(targetRoute(paused.id));
      pageEnvelope(rows, targetKeys, true);
      assert.equal(rows.total, 3);
      assert(rows.items.every((row) => row.gate_reason !== undefined));
      // Lists never carry the gate; only a deployment's own read does.
      const listed = (await get(route({ status: "paused", page_size: 50 })))
        .items;
      assert(listed.length > 0);
      assert(listed.every((item) => item.canary_gate === undefined));
      // Rollback is offered only while a released target that is still
      // assigned has a version to return to.
      const available = async (deployment) =>
        (await get(`/deployments/${deployment.id}/summary`)).rollback_available;
      assert.equal(await available(deployments[20]), false);
      assert.equal(await available(deployments[21]), true);
      assert.equal(await available(parent), true);
      assert.equal(await available(otherParent), false);
      // A removed target names only the deployment that took its device over.
      const removed = (
        await get(targetRoute(parent.id, { state: "removed", page_size: 50 }))
      ).items;
      assert.deepEqual(
        removed
          .filter((row) => row.replaced_by)
          .map((row) => row.replaced_by)
          .sort(),
        [deploymentIds[3], deploymentIds[4]].sort(),
      );
    },
  );
  await check(
    "sorting and group filters are allowlisted, deterministic and page without gaps",
    async () => {
      const every = async (path, query, pages) => {
        const items = [];
        for (let page = 1; page <= pages; page++) {
          const result = await get(
            path + new URLSearchParams({ ...query, page, page_size: 50 }),
          );
          items.push(...result.items);
        }
        return items;
      };
      const compareText = (a, b) => {
        const [left, right] = [a.toLowerCase(), b.toLowerCase()];
        return left < right ? -1 : left > right ? 1 : 0;
      };
      const compareValue = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      // What each order sorts by, read only from the projected fields. A
      // nameless deployment sorts by the label a reader sees for it.
      const keys = {
        name: (item) =>
          item.name ||
          (item.policy
            ? "Agent settings"
            : item.configuration_name || "Pipeline deployment"),
        created_at: (item) => item.created_at,
        scheduled_at: (item) => item.scheduled_at,
        verified: (item) => [item.verified_count, item.target_count],
      };
      const compare = {
        name: compareText,
        created_at: compareValue,
        scheduled_at: compareValue,
        verified: (a, b) => a[0] - b[0] || a[1] - b[1],
      };
      for (const sort of [
        "name",
        "status",
        "verified",
        "created_at",
        "scheduled_at",
      ])
        for (const direction of ["asc", "desc"]) {
          const query = { sort, direction };
          const items = await every("/deployments/history?", query, 5);
          // Every order covers every deployment once: pages never skip or repeat.
          assert.equal(items.length, deployments.length, sort + direction);
          assert.equal(
            new Set(items.map((item) => item.id)).size,
            items.length,
          );
          items.forEach(summary);
          // Repeating a query repeats its order exactly.
          const again = await every("/deployments/history?", query, 5);
          assert.deepEqual(
            again.map((item) => item.id),
            items.map((item) => item.id),
          );
          if (!keys[sort]) continue;
          const sign = direction === "asc" ? 1 : -1;
          for (let index = 1; index < items.length; index++) {
            const [left, right] = [items[index - 1], items[index]];
            const [a, b] = [keys[sort](left), keys[sort](right)];
            // Missing values sort last in either direction; ties go by id.
            const order =
              a === null || b === null
                ? (a === null) - (b === null)
                : sign * compare[sort](a, b);
            assert(
              order < 0 || (order === 0 && left.id < right.id),
              `${sort} ${direction} at ${index}`,
            );
          }
        }
      const grouped = await every(
        "/deployments/history?",
        { group_id: groupId },
        1,
      );
      assert.deepEqual(
        grouped.map((item) => item.id).sort(),
        [deploymentIds[30], deploymentIds[31]].sort(),
      );
      assert.equal((await get(route({ group_id: randomUUID() }))).total, 0);
      for (const sort of ["device_name", "state", "generation"])
        for (const direction of ["asc", "desc"]) {
          const rows = await every(
            `/deployments/${parent.id}/targets?`,
            { sort, direction },
            4,
          );
          assert.equal(rows.length, 151, sort + direction);
          assert.equal(new Set(rows.map((row) => row.device_id)).size, 151);
          if (sort === "state") continue;
          const sign = direction === "asc" ? 1 : -1;
          for (let index = 1; index < rows.length; index++) {
            const [left, right] = [rows[index - 1], rows[index]];
            const order =
              sign *
              (sort === "generation"
                ? left.generation - right.generation
                : compareText(left.device_name, right.device_name));
            assert(
              order < 0 || (order === 0 && left.device_id < right.device_id),
              `${sort} ${direction} at ${index}`,
            );
          }
        }
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
        "sort=bogus",
        "sort=NAME",
        "sort=",
        "sort=name&sort=status",
        "direction=sideways",
        "direction=ASC",
        "direction=asc&direction=desc",
        "group_id=not-a-uuid",
        "group_id=" + groupId.toUpperCase(),
        "group_id=" + groupId.replaceAll("-", ""),
        `group_id=${groupId}&group_id=${groupId}`,
      ])
        await get("/deployments/history?" + query, admin, 400);
      for (const query of [
        "state=" + "a".repeat(65),
        "state=%27%20OR%201%3D1",
        "state=failed&state=pending",
        "state=%C3%A9",
        "scheduled=true",
        "status=failed",
        "sort=name",
        "sort=bogus",
        "sort=state&sort=generation",
        "direction=up",
        "direction=asc&direction=desc",
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
