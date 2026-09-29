// Synthetic notification channels for component harnesses. Nothing here was
// read from a real instance; the shapes follow contracts/CONTRACT.md.

/** One channel as GET /notifications/channels lists it. */
export function syntheticChannel(overrides = {}) {
  const at = overrides.created_at ?? "2026-09-20T09:00:00Z";
  return {
    id: "00000000-0000-4000-8000-00000000c001",
    name: "Synthetic on-call webhook",
    kind: "webhook",
    enabled: true,
    allow_private: false,
    webhook: {
      url_hint: "https://hooks.example.test/…",
      host: "hooks.example.test",
      header_name: null,
      signing_secret_set: false,
      header_value_set: false,
    },
    email: null,
    rules: {
      events: ["issue.opened", "issue.resolved", "rollout.failed"],
      offline_minutes: 15,
      min_severity: "warning",
      pipeline_ids: [],
      group_ids: [],
      quiet_hours: null,
    },
    secrets_readable: true,
    revision: 1,
    created_at: at,
    updated_at: at,
    status: {
      state: "idle",
      last_attempt_at: null,
      last_delivered_at: null,
      last_error: null,
      last_status_code: null,
      pending: 0,
    },
    ...overrides,
  };
}

/**
 * An instance with one channel set up. Overview and Issues ask this of
 * administrators to decide whether to mention notifications; with a channel
 * they stay quiet, so harnesses about other things see no extra line.
 */
export const configuredChannels = {
  items: [syntheticChannel()],
  max_channels: 20,
};
