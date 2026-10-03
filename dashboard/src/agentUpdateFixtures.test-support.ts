// Synthetic data for the tests of agent updates. Every key here is one of the
// published test keys of the shared vectors (their seeds are public): none is
// a real key and none may be pinned on a host.
import type {
  AgentRelease,
  AgentUpdates,
  DeviceAgentUpdate,
  ReleaseKey,
  UpdatePreview,
  UpdateRollout,
  UpdateRolloutDetail,
  UpdateTarget,
} from "./agentUpdateModel";

export const id = (n: number) =>
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
export const manifestDigest = "a".repeat(64);
export const artifactDigest = "b".repeat(64);

export const releaseKey = (over: Partial<ReleaseKey> = {}): ReleaseKey => ({
  fingerprint: teamFingerprint,
  public_key: teamLine,
  custody: "offline",
  state: "current",
  created_at: "2026-10-03T12:00:00Z",
  created_by_name: "Maria Costa",
  retired_at: null,
  revoked_at: null,
  revoked_reason: null,
  introduced_by: null,
  devices_pinning: 12,
  device_names: ["edge-01", "edge-02"],
  ...over,
});

export const updates = (over: Partial<AgentUpdates> = {}): AgentUpdates => ({
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

export const release = (over: Partial<AgentRelease> = {}): AgentRelease => ({
  id: id(30),
  version: "0.1.1",
  counter: 7,
  state: "ready",
  expired: false,
  manifest_sha256: manifestDigest,
  issued_at: "2026-10-03T12:00:00Z",
  expires_at: "2027-04-01T12:00:00Z",
  signer: { fingerprint: teamFingerprint, custody: "offline" },
  artifacts: [
    {
      os: "linux",
      arch: "amd64",
      file: "vectory-0.1.1-linux-amd64",
      size: 15204352,
      sha256: artifactDigest,
    },
  ],
  prepared_by_name: "Maria Costa",
  prepared_at: "2026-10-03T12:00:00Z",
  withdrawn_at: null,
  withdrawn_reason: null,
  rollouts: [],
  ...over,
});

const zeroCounts = {
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
export const counts = (over: Partial<typeof zeroCounts> = {}) => ({
  ...zeroCounts,
  ...over,
});

export const rollout = (over: Partial<UpdateRollout> = {}): UpdateRollout => ({
  id: id(40),
  name: null,
  release: {
    id: id(30),
    version: "0.1.1",
    counter: 7,
    manifest_sha256: manifestDigest,
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
  state_counts: counts({ verified: 12, pending: 29 }),
  degraded: 0,
  ...over,
});

export const detail = (
  over: Partial<UpdateRolloutDetail> = {},
): UpdateRolloutDetail => ({
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

export const target = (over: Partial<UpdateTarget> = {}): UpdateTarget => ({
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

export const preview = (over: Partial<UpdatePreview> = {}): UpdatePreview => ({
  release: {
    id: id(30),
    version: "0.1.1",
    counter: 7,
    manifest_sha256: manifestDigest,
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

export const report = (
  over: Partial<DeviceAgentUpdate> = {},
): DeviceAgentUpdate => ({
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
