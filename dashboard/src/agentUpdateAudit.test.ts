import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { AuditDetailSchema, AuditHistoryPageSchema } from "./api";

// The audit rows of agent updates, as the contract describes them, must read
// as they are: the event list and its drawer are how a person finds out who
// changed a key or stopped every update.
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");
const protocol = JSON.parse(
  readFileSync(
    new URL("../../contracts/protocol.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(protocol);
const contract = (name: string, value: unknown) => {
  const check = ajv.getSchema(`${protocol.$id}#/$defs/${name}`);
  expect(check, name).toBeTruthy();
  expect(check(value) ? [] : check.errors, name).toEqual([]);
};

const uuid = (n: number) =>
  `20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (c: string) => c.repeat(64);
const event = (
  action: string,
  target_kind: string,
  details: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: uuid(1),
  actor_id: uuid(2),
  actor: "Morgan Lee",
  actor_kind: "user",
  action,
  target: "server",
  target_id: null,
  target_kind,
  target_name: null,
  device_id: null,
  device_name: null,
  outcome: "success",
  created_at: "2026-10-03T10:00:00Z",
  request_id: null,
  details,
  ...extra,
});

const samples: [string, string, Record<string, unknown>][] = [
  [
    "agent_update.enable",
    "server",
    { custody: "offline", fingerprint: digest("a") },
  ],
  [
    "agent_update.stop",
    "server",
    { reason: "Bad build", cancelled_rollouts: 2 },
  ],
  [
    "agent_release_key.rollover",
    "agent_release_key",
    { fingerprint: digest("b"), from_fingerprint: digest("a") },
  ],
  [
    "agent_release.signature_upload",
    "agent_release",
    {
      source: "upload",
      version: "0.1.1",
      counter: 7,
      manifest_sha256: digest("c"),
      release_id: uuid(3),
    },
  ],
  [
    "agent_release.expire",
    "agent_release",
    {
      version: "0.1.1",
      counter: 7,
      manifest_sha256: digest("c"),
      release_id: uuid(3),
      cancelled_rollouts: 1,
    },
  ],
  [
    "agent_update_rollout.release",
    "agent_update_rollout",
    {
      rollout_id: uuid(4),
      stage: "canary",
      device_ids: [uuid(5), uuid(6)],
      released_count: 2,
    },
  ],
  [
    "agent_update_rollout.gate",
    "agent_update_rollout",
    { stage: "batch 1", gate_state: "failed", verified_count: 1 },
  ],
  [
    "device.agent_update",
    "device",
    {
      rollout_id: uuid(4),
      release_id: uuid(3),
      version: "0.1.1",
      from_version: "0.1.0",
      to_version: "0.1.1",
      code: "NO_CHECK_IN",
    },
  ],
  [
    "agent_update.disable",
    "server",
    { withdrawn_releases: 1, cancelled_rollouts: 0 },
  ],
];

describe("the audit rows of agent updates", () => {
  it("reads every event the contract lists, with its details", () => {
    for (const [action, kind, details] of samples) {
      const row = event(action, kind, details);
      contract("AuditDetail", row);
      expect(AuditDetailSchema.parse(row), action).toEqual(row);
    }
  });

  it("reads the three new kinds of target in the list as well", () => {
    const items = [
      "agent_release_key",
      "agent_release",
      "agent_update_rollout",
    ].map((kind) => {
      const { details: _details, ...summary } = event("x.y", kind, {});
      return summary;
    });
    const page = { items, total: 3, page: 1, page_size: 12 };
    contract("AuditHistoryPage", page);
    expect(AuditHistoryPageSchema.parse(page).items).toHaveLength(3);
  });

  it("leaves out a detail that doesn't fit its shape instead of hiding the event", () => {
    const row = event("agent_release_key.rotate", "agent_release_key", {
      fingerprint: "not a fingerprint",
      custody: "somewhere",
      counter: 0,
      reason: "kept",
    });
    const parsed = AuditDetailSchema.parse(row);
    expect(parsed.details).toEqual({ reason: "kept" });
    expect(parsed.action).toBe("agent_release_key.rotate");
  });

  it("shows no member the contract doesn't list", () => {
    const parsed = AuditDetailSchema.parse(
      event("agent_update.enable", "server", {
        custody: "server",
        private_key: "never shown",
      }),
    );
    expect(parsed.details).toEqual({ custody: "server" });
  });
});
