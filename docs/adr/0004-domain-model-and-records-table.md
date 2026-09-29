# ADR 0004: Domain documents in one records table, contended state in its own tables

Proposed 2026-09-29. This records the storage model as implemented since commit `2f18fb7` (2026-09-26) and as it stands at `a469266`; no one has reviewed or accepted it yet.

## Context

The specification (section 5) asks for separate configurations, draft revisions, published versions, assignments, deployments, device desired state and device reported state, with immutable revisions and versions, optimistic concurrency and an append-only audit. Everything lives in one SQLite database (ADR 0001). The domain changed daily while it was built, and most of it is read far more often than it is written.

## Decision

- Domain documents are JSON rows in one table, `records(kind, id, data, created_at)` (`server/migrations/0001_initial.sql`). The kinds are `configuration` (a pipeline and its editable draft), `revision` (an immutable draft snapshot), `version` (an immutable published version: graph, configuration, rendered artifact, SHA-256, size, validation and author), `deployment` (an assignment of a version or agent settings to a selector, with priority, target mode, rollout policy, schedule and status), `group`, `policy` (agent settings), `issue` and `audit`.
- Database triggers refuse any update to `version`, `revision` and `audit` rows and any deletion of `audit` rows. A separate `audit_sequence` table keeps audit order across equal timestamps (`0010_audit_sequence.sql`).
- State that is contended, security-sensitive or on the heartbeat path has its own table with real constraints: `users`, `sessions`, `devices` (unique, case-insensitive name; desired generation and policy columns), `credentials`, `enrollment_tokens`, `enrollments`, `deployment_targets` (one row per device per deployment, with its generation and state), `telemetry` buckets, and the per-operation request registries added from migration `0014` on.
- Pages that must stay bounded query the JSON through expression indexes (migrations `0006` to `0009`) instead of scanning a kind.
- All writes go through `db::write_tx`: one process-wide writer and `BEGIN IMMEDIATE`.

## Consequences

- New fields in a document need no migration, but SQLite does not check their types. The Rust code validates each shape, and a misspelled field is simply absent.
- Immutability of versions, revisions and audit events holds against the application, not against someone with direct database access. The audit is append-only at the application level, not tamper-proof.
- Collection endpoints that read a whole kind, and full-fleet computations such as `GET /devices`, grow with the data; bounded pages exist for pipelines, deployments, issues and the audit log, not yet for devices.
- Moving a kind to its own table later needs a data migration and a compatibility window for the API.
