# ADR 0008: One generated table of credential fields, with the agent's copy authoritative

Proposed 2026-09-29. This records the device-secret design merged in commit `9434fef` (fields marked in `dc30234`) as it stands at `a469266`; no one has reviewed or accepted it yet.

## Context

The specification (section 10, line 261) prefers device-local secret references. Earlier builds accepted `vectory-secret:NAME` only in the auth fields of three sinks, so other credentials were stored in pipelines. A reference is only safe if the server cannot choose where a device writes the secret's value: otherwise a pipeline could move a credential into a URL, a header or a program.

## Decision

- `scripts/generate-vector-catalog.mjs` marks every credential field of the pinned Vector 0.58.0 schema: every `SensitiveString` field, plus reviewed credentials that Vector types as plain strings. At `a469266` that is 251 fields in 85 component types.
- `scripts/generate-secret-fields.mjs` writes the same table three times: `agent/internal/agent/secret_fields_generated.go`, `server/src/secret_fields.rs` and `dashboard/src/generated/secret-fields.json`. CI fails when any copy is stale (`--check`).
- The agent substitutes a value only at a whole string field its own table lists and refuses a reference anywhere else. It never takes the list of fields from the server.
- The server accepts an exact `vectory-secret:NAME` at those fields and refuses plain text there, at draft save and at publish, with the fix in the message. The dashboard shows each credential field as a secret picker.

## Consequences

- A new Vector version, or a field the schema doesn't mark, needs a regenerated table and a new agent build before devices accept references there.
- An older agent keeps its own older table, so a newer server can't widen where it substitutes.
- The server never sees secret values: drafts, versions, exports, signatures and validation hold only the reference. Rendered files on the device contain the values and must stay private to the agent's account.
