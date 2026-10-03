// Synthetic replies to the server's agent update routes, for browser harnesses
// that isolate the dashboard from a server. They follow the contract's rules
// (who may do what, the password, the revision, the review token and the
// request identity, the order of the review's reasons) over whatever the
// harness holds in `state`, so a harness edits its own lists and the replies
// follow. Every key here is one of the published test keys of the shared
// release vectors: none is a real key, and nothing here says a device runs
// anything.
import { createHash } from "node:crypto";

export const id = (n) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const teamFingerprint =
  "05cc6c02351af0cb1be9877e7cdcd326c68310018746cb7bbbf6beb29392618b";
export const nextFingerprint =
  "5f0681261c9f25fae4e8a4e2e6701582cf20e228f711848bb8bc9db7190acadb";
export const finalFingerprint =
  "9df9d354c16a22b386d6acd0bc6d5e3adbd9b013416b16faa27546a4377d10b2";
export const teamLine =
  "vectory-release-key ed25519 3n1kX5uZnEN2wf+ZrjTlfd3sqUPQff1ANP0I/elZz7o= team";
export const nextLine =
  "vectory-release-key ed25519 EfEAEZ4zQhLJkpS72PMa8tlIIRVq/eIn895jrezMZpY= team-next";
export const finalLine =
  "vectory-release-key ed25519 fP/vTaQk5ujYmxovIxpccphQ5rrr+lUZ71EVXQJMdKM= team-final";
/** A key line's fingerprint: SHA-256 of its 32 key bytes, in lower-case hex. */
const fingerprintOf = (line) =>
  createHash("sha256")
    .update(Buffer.from(line.split(" ")[2], "base64"))
    .digest("hex");
/** The published rollover envelope and signature file of the shared examples. */
export const rolloverEnvelope = {
  statement:
    "eyJzY2hlbWEiOiJ2ZWN0b3J5LnJlbGVhc2Uta2V5LXJvbGxvdmVyLnYxIiwiZnJvbSI6IjA1Y2M2YzAyMzUxYWYwY2IxYmU5ODc3ZTdjZGNkMzI2YzY4MzEwMDE4NzQ2Y2I3YmJiZjZiZWIyOTM5MjYxOGIiLCJ0byI6InZlY3RvcnktcmVsZWFzZS1rZXkgZWQyNTUxOSBFZkVBRVo0elFoTEprcFM3MlBNYTh0bElJUlZxL2VJbjg5NWpyZXpNWnBZPSB0ZWFtLW5leHQiLCJpc3N1ZWRfYXQiOiIyMDI2LTExLTAyVDA5OjAwOjAwWiJ9",
  signature:
    "mzO9h8MIeHaIgfeTLc5mHlE3k1EEeGTLff4gDN8RyXqQE2yHitf4WCF9MTKwgbI+PZrWriwVbwL/sbUD5mQhDw==",
};
export const signatureFile = `{"schema":"vectory.agent-release-signatures.v1","signatures":[{"key":"${teamFingerprint}","signature":"92Djw+8q0PShRNfEeTrnmFmFFmfd/QA+Tc/tmfgVAh+hAMMtcEOYJAoAav8IQCXEql5SQcO3rdpCDDaQGqlbAA=="}]}\n`;
export const manifestText =
  '{"schema":"vectory.agent-release.v1","version":"0.1.1","counter":7,"issued_at":"2026-10-03T12:00:00Z","expires_at":"2027-04-01T12:00:00Z","min_from":"0.1.0","service_definition":1,"artifacts":[{"os":"linux","arch":"amd64","format":"executable","file":"vectory-0.1.1-linux-amd64","size":15204352,"sha256":"4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f"}]}';
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const manifestSha256 = sha256(manifestText);

const created = "2026-10-03T12:00:00Z";

export const releaseKey = (over = {}) => ({
  fingerprint: teamFingerprint,
  public_key: teamLine,
  custody: "offline",
  state: "current",
  created_at: created,
  created_by_name: "Maria Costa",
  retired_at: null,
  revoked_at: null,
  revoked_reason: null,
  introduced_by: null,
  devices_pinning: 12,
  device_names: ["edge-01", "edge-02"],
  ...over,
});

export const noCounts = {
  pending: 0,
  offered: 0,
  downloading: 0,
  staged: 0,
  waiting_for_host: 0,
  waiting_for_window: 0,
  applying: 0,
  restarted: 0,
  verified: 0,
  rolled_back: 0,
  refused: 0,
  failed: 0,
  cancelled: 0,
  skipped: 0,
};

export const release = (over = {}) => ({
  id: id(30),
  version: "0.1.1",
  counter: 7,
  state: "ready",
  expired: false,
  manifest_sha256: manifestSha256,
  issued_at: created,
  expires_at: "2027-04-01T12:00:00Z",
  signer: { fingerprint: teamFingerprint, custody: "offline" },
  artifacts: [
    {
      os: "linux",
      arch: "amd64",
      file: "vectory-0.1.1-linux-amd64",
      size: 15204352,
      sha256:
        "4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f",
    },
  ],
  prepared_by_name: "Maria Costa",
  prepared_at: created,
  withdrawn_at: null,
  withdrawn_reason: null,
  rollouts: [],
  ...over,
});

export const rollout = (over = {}) => ({
  id: id(40),
  name: null,
  release: {
    id: id(30),
    version: "0.1.1",
    counter: 7,
    manifest_sha256: manifestSha256,
  },
  selector: { device_ids: [], group_ids: [id(50)], exclude_ids: [] },
  rollout: {
    canary_size: 1,
    batch_size: 10,
    observation_seconds: 300,
    failure_threshold: 0,
  },
  status: "active",
  failure_reason: null,
  cancel_reason: null,
  revision: 2,
  created_at: "2026-10-03T12:30:00Z",
  created_by_name: "Maria Costa",
  paused_at: null,
  completed_at: null,
  failed_at: null,
  cancelled_at: null,
  observation_started_at: null,
  target_count: 41,
  state_counts: { ...noCounts, verified: 12, pending: 29 },
  degraded: 0,
  ...over,
});

export const updatesBody = (over = {}) => ({
  enabled: true,
  custody: "offline",
  revision: 3,
  current_key: releaseKey(),
  stopped: null,
  active_rollouts: 1,
  fleet: {
    devices_total: 46,
    versions: [
      { version: "0.1.1", devices: 3 },
      { version: "0.1.0", devices: 41 },
      { version: "unknown", devices: 2 },
    ],
    levels: {
      automatic: 30,
      ask: 4,
      off: 9,
      cannot_update: 3,
      not_reported: 0,
    },
  },
  frozen_devices: { total: 0, items: [] },
  catalog: [
    {
      version: "0.1.1",
      platforms: [
        { os: "linux", arch: "amd64" },
        { os: "linux", arch: "arm64" },
      ],
      devices_behind: 41,
      release: null,
    },
  ],
  ...over,
});

/** What the server says before anyone turned agent updates on. */
export const updatesOff = () => ({
  enabled: false,
  custody: null,
  revision: 0,
  current_key: null,
  stopped: null,
  active_rollouts: 0,
  fleet: null,
  frozen_devices: null,
  catalog: null,
});

export const detailBody = (over = {}) => ({
  ...rollout(),
  stages: [
    {
      kind: "canary",
      index: 0,
      state: "passed",
      released_at: "2026-10-03T12:31:00Z",
      size: 1,
      counts: { verified: 1 },
      devices: [
        {
          device_id: id(1),
          device_name: "edge-01",
          state: "verified",
          code: null,
        },
      ],
      more: 0,
    },
    {
      kind: "batch",
      index: 1,
      state: "in_progress",
      released_at: "2026-10-03T12:40:00Z",
      size: 10,
      counts: { verified: 4, applying: 2, waiting_for_host: 1, offered: 3 },
      devices: [],
      more: 0,
    },
  ],
  failures: [],
  evaluated_at: "2026-10-03T12:45:00Z",
  check_in_seconds: 60,
  ...over,
});

export const targetRow = (over = {}) => ({
  device_id: id(1),
  device_name: "edge-01",
  stage: 0,
  state: "verified",
  code: null,
  from_version: "0.1.0",
  to_version: "0.1.1",
  released_at: "2026-10-03T12:31:00Z",
  updated_at: "2026-10-03T12:36:00Z",
  verified_at: "2026-10-03T12:36:00Z",
  ...over,
});

export const report = (over = {}) => ({
  consent: "auto",
  paused: false,
  track: "patch",
  windows: ["Mon-Fri 02:00-04:00"],
  window_open: false,
  next_window_at: "2026-10-05T02:00:00Z",
  keys: [teamFingerprint],
  eligibility: "eligible",
  state: "idle",
  release_version: null,
  code: null,
  rollover_conflict: null,
  last: null,
  reported_at: "2026-10-03T12:45:00Z",
  ...over,
});

export const previewBody = (over = {}) => ({
  release: {
    id: id(30),
    version: "0.1.1",
    counter: 7,
    manifest_sha256: manifestSha256,
  },
  will_update: [
    {
      device_id: id(1),
      device_name: "edge-01",
      consent: "auto",
      windows: ["Mon-Fri 02:00-04:00"],
      next_window_at: "2026-10-05T02:00:00Z",
    },
    {
      device_id: id(2),
      device_name: "edge-02",
      consent: "ask",
      windows: [],
      next_window_at: null,
    },
  ],
  wont_update: [
    {
      code: "UPDATES_OFF",
      reason: "Updates are off on edge-03.",
      fix: "Run the Upgrade agent command with updates on, once.",
      devices: [{ device_id: id(3), device_name: "edge-03", successors: null }],
    },
    {
      code: "RELEASE_ALREADY_TRIED",
      reason: "edge-04 tried 0.1.1 and rolled back; it takes the next release.",
      fix: null,
      devices: [{ device_id: id(4), device_name: "edge-04", successors: null }],
    },
    {
      code: "KEY_ROLLOVER_CONFLICT",
      reason:
        "edge-05 saw two successors of its key and stopped accepting updates.",
      fix: "Run the Upgrade agent command with the right key.",
      devices: [
        {
          device_id: id(5),
          device_name: "edge-05",
          successors: [nextFingerprint, finalFingerprint],
        },
      ],
    },
  ],
  warnings: [
    {
      code: "OFFLINE",
      message:
        "Offline now. It updates if it checks in while the rollout runs.",
      devices: [{ device_id: id(2), device_name: "edge-02" }],
    },
  ],
  canary: { size: 1, chosen_by_you: false, device_ids: [id(1)] },
  review_token: "c".repeat(64),
  ...over,
});

const ok = (json) => ({ status: 200, json });
const refuse = (status, code, message) => ({
  status,
  json: { error: { code, message } },
});
const page = (items, params, size = 12) => {
  const number = Number(params.get("page") || 1);
  const pageSize = Number(params.get("page_size") || size);
  return {
    items: items.slice((number - 1) * pageSize, number * pageSize),
    total: items.length,
    page: number,
    page_size: pageSize,
  };
};
const keyLine =
  /^vectory-release-key ed25519 [A-Za-z0-9+/]{43}= [\x21-\x7e][\x20-\x7e]{0,62}$/;

/**
 * @param {object} state What the harness holds; the replies read and change it.
 * @param {string} [state.role] "viewer" | "editor" | "operator" | "admin".
 * @param {string} [state.password] The password a request must carry.
 * @param {object} state.updates The `AgentUpdates` reply.
 * @param {object[]} state.keys The key history.
 * @param {object[]} state.releases
 * @param {object[]} state.rollouts
 * @param {object} state.details Rollout details by ID.
 * @param {object} state.targets Target rows by rollout ID.
 * @param {object} [state.preview] The review the preview route gives.
 * @param {object[]} state.writes Every change a request made, for the harness to read.
 */
export function agentUpdateReplies(state) {
  state.writes ||= [];
  state.ledger ||= new Map();
  const may = (...roles) => roles.includes(state.role || "admin");
  const refused = (what) =>
    refuse(403, "FORBIDDEN", `${what} needs another role.`);
  const advance = () => {
    state.updates.revision += 1;
  };
  const current = () => state.keys.find((key) => key.state === "current");

  function settings(body) {
    if (!may("admin")) return refused("Changing agent updates");
    if (body.current_password !== (state.password ?? "correct horse"))
      return refuse(403, "WRONG_PASSWORD", "The password is wrong.");
    if (body.revision !== state.updates.revision)
      return refuse(409, "STALE_REVISION", "Agent updates changed.");
    state.writes.push({ route: "settings", body });
    if (body.enabled === false) {
      if (state.updates.active_rollouts > 0)
        return refuse(
          409,
          "AGENT_UPDATE_ROLLOUTS_ACTIVE",
          "An update rollout is running.",
        );
      state.updates.enabled = false;
      state.updates.fleet = null;
      state.updates.catalog = null;
      advance();
      return ok(state.updates);
    }
    const kind = body.custody?.kind;
    if (state.updates.enabled && kind && kind !== state.updates.custody)
      return refuse(409, "CUSTODY_LOCKED", "Custody is fixed.");
    if (!state.updates.current_key && !kind)
      return refuse(409, "CUSTODY_REQUIRED", "Choose a custody.");
    if (kind === "offline") {
      if (!keyLine.test(body.custody.public_key || ""))
        return refuse(
          422,
          "RELEASE_KEY_INVALID",
          "That isn't a valid release key.",
        );
      if (state.keys.some((key) => key.public_key === body.custody.public_key))
        return refuse(
          409,
          "RELEASE_KEY_IN_USE",
          "That key is already registered.",
        );
      for (const key of state.keys)
        if (key.state === "current") key.state = "retired";
      const added = releaseKey({
        fingerprint: fingerprintOf(body.custody.public_key),
        public_key: body.custody.public_key,
        custody: "offline",
        devices_pinning: 0,
        device_names: [],
      });
      state.keys.unshift(added);
      state.updates.current_key = added;
      state.updates.custody = "offline";
    } else if (kind === "server") {
      for (const key of state.keys)
        if (key.state === "current") key.state = "retired";
      const added = releaseKey({
        fingerprint: finalFingerprint,
        public_key: finalLine,
        custody: "server",
        devices_pinning: 0,
        device_names: [],
      });
      state.keys.unshift(added);
      state.updates.current_key = added;
      state.updates.custody = "server";
    }
    state.updates.enabled = true;
    state.updates.fleet ||= updatesBody().fleet;
    state.updates.catalog ||= updatesBody().catalog;
    advance();
    return ok(state.updates);
  }

  function preview(body) {
    if (!may("operator", "admin")) return refused("Reviewing a rollout");
    const found = state.releases.find((item) => item.id === body.release_id);
    if (!found || found.state !== "ready" || found.expired)
      return refuse(409, "RELEASE_NOT_READY", "That release isn't ready.");
    state.writes.push({ route: "preview", body });
    state.previewCalls = [...(state.previewCalls || []), body];
    const base = state.preview || previewBody();
    const named = body.rollout.canary_device_ids || [];
    return ok({
      ...base,
      release: {
        id: found.id,
        version: found.version,
        counter: found.counter,
        manifest_sha256: found.manifest_sha256,
      },
      canary: named.length
        ? {
            size: body.rollout.canary_size,
            chosen_by_you: true,
            device_ids: named,
          }
        : base.canary,
      review_token: sha256(
        JSON.stringify([
          found.manifest_sha256,
          body.rollout,
          named,
          base.will_update.length,
        ]),
      ),
    });
  }

  function create(body) {
    if (!may("operator", "admin")) return refused("Starting a rollout");
    if (state.updates.stopped)
      return refuse(409, "AGENT_UPDATES_STOPPED", "Updates are stopped.");
    const digest = JSON.stringify({ ...body, request_id: undefined });
    if (body.request_id && state.ledger.has(body.request_id)) {
      const first = state.ledger.get(body.request_id);
      return first.digest === digest
        ? ok({ ...first.rollout, request_id: body.request_id })
        : refuse(
            409,
            "IDEMPOTENCY_CONFLICT",
            "A different request used this identity.",
          );
    }
    const found = state.releases.find((item) => item.id === body.release_id);
    if (!found || found.state !== "ready" || found.expired)
      return refuse(409, "RELEASE_NOT_READY", "That release isn't ready.");
    const reviewed = preview({ ...body, review_token: undefined }).json;
    if (state.staleReview || reviewed.review_token !== body.review_token)
      return refuse(409, "UPDATE_REVIEW_CHANGED", "The review changed.");
    const made = rollout({
      id: id(40 + state.rollouts.length + 1),
      release: reviewed.release,
      selector: body.selector,
      rollout: { ...body.rollout, canary_device_ids: undefined },
      name: body.name || null,
      state_counts: { ...noCounts, pending: reviewed.will_update.length },
      target_count: reviewed.will_update.length,
      status: "active",
    });
    state.rollouts.unshift(made);
    state.details[made.id] = detailBody({
      ...made,
      stages: [],
      failures: [],
    });
    state.targets[made.id] = reviewed.will_update.map((device) =>
      targetRow({
        device_id: device.device_id,
        device_name: device.device_name,
        stage: null,
        state: "pending",
        released_at: null,
        verified_at: null,
        from_version: null,
      }),
    );
    state.writes.push({ route: "create", body });
    if (body.request_id)
      state.ledger.set(body.request_id, { digest, rollout: made });
    return ok(
      body.request_id ? { ...made, request_id: body.request_id } : made,
    );
  }

  function transition(rolloutId, verb) {
    if (!may("operator", "admin")) return refused("Changing a rollout");
    const row = state.rollouts.find((item) => item.id === rolloutId);
    if (!row) return refuse(404, "NOT_FOUND", "No such update rollout.");
    const applies =
      verb === "pause"
        ? row.status === "active"
        : verb === "resume"
          ? row.status === "paused"
          : ["active", "paused"].includes(row.status);
    if (!applies)
      return refuse(409, "CONFLICT", "That doesn't apply to this rollout now.");
    row.status =
      verb === "pause" ? "paused" : verb === "resume" ? "active" : "cancelled";
    if (verb === "cancel") {
      row.cancel_reason = "operator";
      row.cancelled_at = "2026-10-03T13:00:00Z";
    }
    if (verb === "pause") row.paused_at = "2026-10-03T13:00:00Z";
    if (verb === "resume") row.paused_at = null;
    row.revision += 1;
    if (state.details[rolloutId]) Object.assign(state.details[rolloutId], row);
    state.writes.push({ route: verb, id: rolloutId });
    return ok(row);
  }

  return {
    /** The reply to a request about agent updates, or null when it isn't one. */
    handle(method, url, body, raw) {
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const params = url.searchParams;
      if (
        !/^\/(agent-updates|agent-release-keys|agent-releases|agent-update-rollouts)(\/|$)/.test(
          path,
        )
      )
        return null;
      if (path === "/agent-updates" && method === "GET")
        return ok(state.updates);
      if (path === "/agent-updates/settings" && method === "PUT")
        return settings(body || {});
      // Every other route answers 404 while updates are off.
      if (!state.updates.enabled)
        return refuse(404, "AGENT_UPDATES_OFF", "Agent updates are off.");
      if (path === "/agent-updates/stop" && method === "POST") {
        if (!may("operator", "admin")) return refused("Stopping updates");
        if (!state.updates.stopped) {
          state.updates.stopped = {
            reason: body.reason,
            by_name: "Maria Costa",
            at: "2026-10-03T13:00:00Z",
          };
          for (const row of state.rollouts)
            if (["active", "paused"].includes(row.status)) {
              row.status = "cancelled";
              row.cancel_reason = "stop";
            }
          state.updates.active_rollouts = 0;
          advance();
        }
        state.writes.push({ route: "stop", body });
        return ok(state.updates);
      }
      if (path === "/agent-updates/stop/clear" && method === "POST") {
        if (!may("admin")) return refused("Clearing the stop");
        if (body.revision !== state.updates.revision)
          return refuse(409, "STALE_REVISION", "Agent updates changed.");
        if (!state.updates.stopped)
          return refuse(409, "CONFLICT", "Nothing is stopped.");
        state.updates.stopped = null;
        advance();
        state.writes.push({ route: "stop-clear", body });
        return ok(state.updates);
      }
      if (path === "/agent-release-keys" && method === "GET")
        return ok(state.keys);
      if (path === "/agent-release-keys/rotate" && method === "POST") {
        if (!may("admin")) return refused("Rotating the key");
        if (body.current_password !== (state.password ?? "correct horse"))
          return refuse(403, "WRONG_PASSWORD", "The password is wrong.");
        if (state.updates.custody !== "server")
          return refuse(409, "CONFLICT", "Only server custody rotates.");
        const old = current();
        old.state = "retired";
        const added = releaseKey({
          fingerprint: nextFingerprint,
          custody: "server",
          introduced_by: rolloverEnvelope,
          devices_pinning: 0,
          device_names: [],
        });
        state.keys.unshift(added);
        state.updates.current_key = added;
        advance();
        state.writes.push({ route: "rotate" });
        return ok(added);
      }
      if (path === "/agent-release-keys/rollover" && method === "POST") {
        if (!may("admin")) return refused("Uploading a rollover");
        if (body.current_password !== (state.password ?? "correct horse"))
          return refuse(403, "WRONG_PASSWORD", "The password is wrong.");
        if (body.statement !== rolloverEnvelope.statement)
          return refuse(
            422,
            "RELEASE_SIGNATURE_INVALID",
            "The signature doesn't verify.",
          );
        const old = current();
        old.state = "retired";
        const added = releaseKey({
          fingerprint: nextFingerprint,
          public_key: nextLine,
          custody: "offline",
          introduced_by: rolloverEnvelope,
          devices_pinning: 0,
          device_names: [],
        });
        state.keys.unshift(added);
        state.updates.current_key = added;
        advance();
        state.writes.push({ route: "rollover" });
        return ok(added);
      }
      const revoke = path.match(
        /^\/agent-release-keys\/([a-f0-9]{64})\/revoke$/,
      );
      if (revoke && method === "POST") {
        if (!may("admin")) return refused("Revoking a key");
        if (body.current_password !== (state.password ?? "correct horse"))
          return refuse(403, "WRONG_PASSWORD", "The password is wrong.");
        const key = state.keys.find((item) => item.fingerprint === revoke[1]);
        if (!key) return refuse(404, "NOT_FOUND", "No such key.");
        if (key.state === "revoked")
          return refuse(409, "CONFLICT", "Already revoked.");
        if (key.state === "current") state.updates.current_key = null;
        key.state = "revoked";
        key.revoked_at = "2026-10-03T13:00:00Z";
        key.revoked_reason = body.reason;
        advance();
        state.writes.push({ route: "revoke", body });
        return ok(key);
      }
      if (path === "/agent-releases" && method === "GET")
        return ok(state.releases);
      if (path === "/agent-releases" && method === "POST") {
        if (!may("admin")) return refused("Preparing a release");
        if (
          !state.updates.catalog?.some(
            (entry) => entry.version === body.version,
          )
        )
          return refuse(409, "RELEASE_NOT_IN_CATALOG", "Not in the catalog.");
        if (
          state.releases.some(
            (item) =>
              item.version === body.version && item.state !== "withdrawn",
          )
        )
          return refuse(409, "RELEASE_EXISTS", "A release exists.");
        const server = state.updates.custody === "server";
        const made = release({
          id: id(30 + state.releases.length + 1),
          version: body.version,
          counter: 8 + state.releases.length,
          state: server ? "ready" : "awaiting_signature",
          signer: server
            ? { fingerprint: current().fingerprint, custody: "server" }
            : null,
        });
        state.releases.unshift(made);
        const entry = state.updates.catalog.find(
          (item) => item.version === body.version,
        );
        entry.release = { id: made.id, state: made.state };
        state.writes.push({ route: "prepare", body });
        return ok(made);
      }
      const manifest = path.match(/^\/agent-releases\/([^/]+)\/manifest$/);
      if (manifest && method === "GET")
        return {
          status: 200,
          body: manifestText,
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": 'attachment; filename="release.json"',
          },
        };
      const signature = path.match(/^\/agent-releases\/([^/]+)\/signature$/);
      if (signature && method === "PUT") {
        if (!may("admin")) return refused("Uploading a signature");
        const row = state.releases.find((item) => item.id === signature[1]);
        if (!row) return refuse(404, "NOT_FOUND", "No such release.");
        if (row.state !== "awaiting_signature")
          return refuse(409, "CONFLICT", "Only an unsigned release takes one.");
        if (String(raw) !== signatureFile)
          return refuse(
            422,
            "RELEASE_SIGNATURE_INVALID",
            "The signature doesn't verify.",
          );
        row.state = "ready";
        row.signer = {
          fingerprint: current().fingerprint,
          custody: current().custody,
        };
        const entry = state.updates.catalog?.find(
          (item) => item.version === row.version,
        );
        if (entry) entry.release = { id: row.id, state: "ready" };
        state.writes.push({
          route: "signature",
          id: row.id,
          bytes: String(raw),
        });
        return ok(row);
      }
      const withdraw = path.match(/^\/agent-releases\/([^/]+)\/withdraw$/);
      if (withdraw && method === "POST") {
        if (!may("admin")) return refused("Withdrawing a release");
        const row = state.releases.find((item) => item.id === withdraw[1]);
        if (!row) return refuse(404, "NOT_FOUND", "No such release.");
        if (row.state === "withdrawn")
          return refuse(409, "CONFLICT", "Already withdrawn.");
        row.state = "withdrawn";
        row.withdrawn_at = "2026-10-03T13:00:00Z";
        row.withdrawn_reason = body.reason;
        state.writes.push({ route: "withdraw", body });
        return ok(row);
      }
      const one = path.match(/^\/agent-releases\/([^/]+)$/);
      if (one && method === "GET") {
        const row = state.releases.find((item) => item.id === one[1]);
        return row ? ok(row) : refuse(404, "NOT_FOUND", "No such release.");
      }
      if (path === "/agent-update-rollouts" && method === "GET") {
        let rows = state.rollouts;
        const search = (params.get("search") || "").toLowerCase();
        if (search)
          rows = rows.filter((row) =>
            `${row.name || ""} ${row.release.version}`
              .toLowerCase()
              .includes(search),
          );
        if (params.get("status"))
          rows = rows.filter((row) => row.status === params.get("status"));
        return ok(page(rows, params));
      }
      if (path === "/agent-update-rollouts/preview" && method === "POST")
        return preview(body);
      if (path === "/agent-update-rollouts" && method === "POST")
        return create(body);
      const targets = path.match(/^\/agent-update-rollouts\/([^/]+)\/targets$/);
      if (targets && method === "GET") {
        let rows = state.targets[targets[1]] || [];
        const search = (params.get("search") || "").toLowerCase();
        if (search)
          rows = rows.filter((row) =>
            (row.device_name || "").toLowerCase().includes(search),
          );
        if (params.get("state"))
          rows = rows.filter((row) => row.state === params.get("state"));
        return ok(page(rows, params));
      }
      const act = path.match(
        /^\/agent-update-rollouts\/([^/]+)\/(pause|resume|cancel)$/,
      );
      if (act && method === "POST") return transition(act[1], act[2]);
      const detail = path.match(/^\/agent-update-rollouts\/([^/]+)$/);
      if (detail && method === "GET") {
        const row = state.details[detail[1]];
        return row
          ? ok(row)
          : refuse(404, "NOT_FOUND", "No such update rollout.");
      }
      return refuse(404, "NOT_FOUND", "No such route.");
    },
  };
}

/** A fresh state for a harness: updates on, an offline key, one ready release and its rollout. */
export function onState(over = {}) {
  const live = rollout();
  return {
    role: "admin",
    password: "correct horse",
    updates: updatesBody(),
    keys: [releaseKey()],
    releases: [release({ rollouts: [{ id: live.id, status: "active" }] })],
    rollouts: [live],
    details: { [live.id]: detailBody() },
    targets: { [live.id]: [targetRow()] },
    writes: [],
    ...over,
  };
}
/** A fresh state with updates off. */
export function offState(over = {}) {
  return {
    role: "admin",
    password: "correct horse",
    updates: updatesOff(),
    keys: [],
    releases: [],
    rollouts: [],
    details: {},
    targets: {},
    writes: [],
    ...over,
  };
}
