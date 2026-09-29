-- Notifications (server/src/notifications.rs, server/src/notifier.rs).
--
-- Channels hold their public settings in `data` and their secrets (webhook
-- URL, signing secret, header value, SMTP password) sealed with the instance
-- key in `sealed`. Neither the API nor the audit trail ever returns `sealed`.
CREATE TABLE notification_channels (
 id TEXT PRIMARY KEY,
 data TEXT NOT NULL CHECK(json_valid(data) AND length(data) <= 65536),
 sealed TEXT NOT NULL DEFAULT '' CHECK(length(sealed) <= 16384),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
-- The outbox. Hooks write an event in the same transaction as the change it
-- describes; `identity` makes each fact one event however often it is seen.
-- A channel-targeted event (device offline/back) names its channel.
CREATE TABLE notification_events (
 id INTEGER PRIMARY KEY,
 identity TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL,
 channel_id TEXT,
 data TEXT NOT NULL CHECK(json_valid(data) AND length(data) <= 16384),
 created_at TEXT NOT NULL,
 processed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notification_events_pending ON notification_events(id) WHERE processed=0;
CREATE INDEX notification_events_created ON notification_events(created_at);
-- One row per message a channel should get: an event, a digest of several,
-- or a test. Status moves queued/held -> sending -> delivered | retrying |
-- failed | gave_up; digested rows were folded into a digest; dropped rows
-- belonged to a channel that was removed or turned off before they went out.
CREATE TABLE notification_deliveries (
 id TEXT PRIMARY KEY,
 channel_id TEXT NOT NULL,
 event_id INTEGER,
 kind TEXT NOT NULL CHECK(kind IN ('event','digest','test')),
 status TEXT NOT NULL CHECK(status IN ('queued','held','sending','retrying','delivered','failed','gave_up','digested','dropped')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT,
 digest_id TEXT,
 data TEXT NOT NULL CHECK(json_valid(data) AND length(data) <= 65536),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(channel_id, event_id)
);
CREATE INDEX notification_deliveries_due ON notification_deliveries(next_attempt_at) WHERE status IN ('queued','held','retrying');
CREATE INDEX notification_deliveries_channel ON notification_deliveries(channel_id, status);
CREATE INDEX notification_deliveries_updated ON notification_deliveries(updated_at);
-- The delivery log: every attempt, with a bounded and redacted error.
CREATE TABLE notification_attempts (
 id INTEGER PRIMARY KEY,
 delivery_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 attempt INTEGER NOT NULL,
 at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('delivered','failed','gave_up')),
 status_code INTEGER,
 latency_ms INTEGER NOT NULL,
 error TEXT CHECK(error IS NULL OR length(error) <= 600),
 next_attempt_at TEXT,
 data TEXT NOT NULL CHECK(json_valid(data) AND length(data) <= 4096)
);
CREATE INDEX notification_attempts_recent ON notification_attempts(at DESC, id DESC);
CREATE INDEX notification_attempts_channel ON notification_attempts(channel_id, at DESC, id DESC);
-- A device that went quiet: when it was last seen, which channels were told,
-- and its first check-in after it came back (it must check in once more
-- before "back online" goes out, so a flapping device sends nothing new).
CREATE TABLE notification_outages (
 device_id TEXT PRIMARY KEY,
 since TEXT NOT NULL,
 returned_at TEXT,
 notified TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(notified))
);
-- Private notifier state, such as how far it has read the audit trail.
CREATE TABLE notification_state (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
-- Start reading the audit trail here: nothing that happened before the
-- upgrade is announced.
INSERT INTO notification_state(key,value)
SELECT 'audit_cursor', CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM audit_sequence;
-- Editable data-plane detection thresholds (server/src/detection.rs). No row
-- means the built-in defaults.
CREATE TABLE detection_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 data TEXT NOT NULL CHECK(json_valid(data) AND length(data) <= 4096),
 revision INTEGER NOT NULL,
 updated_at TEXT NOT NULL,
 updated_by TEXT
);
