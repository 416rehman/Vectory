# ADR 0007: Three state machines, and only verified application is success

Proposed 2026-09-29. This records the states defined in `contracts/CONTRACT.md` and `contracts/protocol.schema.json` as implemented at commit `a469266`; no one has reviewed or accepted it yet.

## Context

The specification (section 5, line 136) asks to keep `desired`, `downloaded`, `validated`, `written`, `reload_requested`, `verified_applied`, `failed` and `rolled_back` distinct, and says that an HTTP download or a successful file write is not deployment success. Deployments also need scheduling, canaries, cancellation and rollback states that the dashboard, the scheduler and the agent agree on.

## Decision

- **Apply attempt**, reported by the agent for one signed candidate: `desired`, `downloaded`, `validated`, `written`, `reload_requested`, then `verified_applied`, `verification_unknown`, `failed` or `rolled_back`, plus `paused` while a pause keeps the workload unchanged. A device's `apply_state` adds `unmanaged` for a device without an assignment.
- Only `verified_applied` counts as success, for canary gates and for deployment progress. It needs version-specific evidence from Vector that it accepted the configuration; a download, a write or a running process is not enough.
- **Deployment status**: `scheduled`, `active`, `paused`, `completed`, `cancelled`, `failed`, `missed` and `unassigned`. A schedule more than one hour late becomes `missed` instead of activating (`server/src/rollout.rs`). Cancel stops further releases; devices that already received the version keep it. Rollback is a separate deployment with a newer generation pointing at older content.
- **Deployment target**, one per device: `pending` until the rollout releases it, then the released generation and the device's apply state, `removed` when the device leaves a persistent deployment, and `blocked` when a scheduled activation meets an active canary.

## Consequences

- Every surface must use these words. The dashboard maps them in `dashboard/src/status.ts`, and a Help center test checks its state diagrams against that file.
- An agent that cannot prove activation reports `verification_unknown`, which never satisfies a canary gate.
- The late-start window is fixed at one hour, although the specification asks for a configured deadline, and the outcome of cancellation racing activation is not yet documented.
