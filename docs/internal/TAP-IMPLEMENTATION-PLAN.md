# Event sampling: implementation plan

Status: proposed, 2026-09-30. Nothing here is built. The decision, the measurements and the test catalogue are in [ADR 0011](../adr/0011-opt-in-event-sampling.md); the attacker table is in the [threat model](../security/THREAT-MODEL.md#event-sampling). This plan orders the work, names the files each package owns, assigns the tests (IDs A-, S-, P-, B- and N- come from the ADR's section 10) and lists what an independent reviewer must attack in the finished code. Ownership follows `AGENTS.md`: the lead owns `dashboard/`, `contracts/` and integration tests, the backend agent `server/`, the agent workstream `agent/`, security and release `deploy/`, `.github/`, operational docs and the independent review. A route or wire change needs the lead's agreement first.

## Start here (for the reviewer)

Ask these first; each has a one-line answer in the ADR and a test in the plan.

1. Can any byte of network data reach `settings.json`? (A-02; ADR section 1.)
2. Does the pipeline's `api` block still get through restricted mode after work package 0? (A-06; WP0.)
3. What does the agent do if 127.0.0.1:8686 is busy, and what if it becomes busy between the probe and Vector's bind? (A-08, A-15.)
4. After the window closes, how does the agent know nothing is still attached, and what does it do on macOS if it cannot tell? (A-09, N-01.)
5. Where can a raw event exist in the agent, and can it reach disk, a log or a panic dump? (A-11.)
6. Can a Vector upgrade change the constants this design rests on without anyone noticing? (WP3g.)
7. Can promotion (VRL sample, unit test) copy an event somewhere durable without the person confirming it? (B-04.)

## Prerequisite and ordering

| Order | Package | Depends on | Ships |
| --- | --- | --- | --- |
| 0 | Make `api` host-owned | nothing | alone, first |
| 1 | Contract | 0 agreed | before any code in 2 or 3 |
| 2 | Server | 1 | with 3 |
| 3a to 3c | Agent: consent, redactor, connection reader | 1 (3b and 3c need nothing else) | with 3d to 3f |
| 3d to 3f | Agent: window, tap runner, session engine | 3a to 3c | with 2 |
| 3g | Native behavior probe | 3d | with 3d; also a permanent CI job |
| 4 | Dashboard | 1, 2 | after 2 |
| 5 | Docs, ops, CI | 2 to 4 | with 4 |
| 6 | Integration tests and independent review | all | gate |

Release gates, all required: WP0 shipped; the native probe green on Linux CI; the independent review finished with its findings resolved; documentation matches behavior. macOS is separate: `configure-sampling` and the session engine stay disabled on `darwin` (a build constant listing the enabled platforms, initially `linux`) until N-01 passes on a native macOS runner.

## WP0: make `api` host-owned (prerequisite)

Today restricted mode accepts a loopback `api` block, so any publisher can open Vector's unauthenticated API for local users. Remove that, in the three places that mirror each other.

| Where | Change |
| --- | --- |
| `agent/internal/agent/policy.go` | Delete `case "api"` in `CapabilityPolicy.Check`; an `api` key then falls to the existing `default:` refusal (`UNSUPPORTED_LOCAL_CAPABILITY`, resource `api`). Remove the `api.address` case in `PolicyRefusal.Diagnostic`. Full mode returns before the switch and is unchanged. |
| `server/src/rollout.rs` | In `requires_full_mode`, take `"api"` out of `restricted_roots` and delete the loopback branch, so a pipeline with `api` needs a full-mode device at deployment review (`FULL_VECTOR_MODE_REQUIRED`). |
| `dashboard/src/hostRequirements.ts` | The same two edits (the root list at `"api"` and the loopback check). |
| Drift test | Extend the pattern of `tests/security/test_vrl_function_lists.py` to compare the restricted top-level setting lists in the agent, server and dashboard. |
| Tests | `agent/internal/agent/policy_refusal_test.go` (restricted refuses `api`, enabled or not; full accepts), a server test beside the existing mode tests in `server/tests/`, `dashboard/src/hostRequirements.test.ts`. The `api` sample in `agent/internal/agent/telemetry_rich_test.go` only exercises component-type parsing and stays. |
| Docs | `docs/user/security.md` (drop "a loopback-only `api`" from restricted-mode global settings), the allowlist sentence in [ADR 0005](../adr/0005-restricted-mode-by-default.md), `CHANGELOG.md`: "A pipeline that sets `api` now needs a full-mode device." |

Effect on running fleets: a version already deployed with an `api` block keeps running on restricted devices until the next apply, which then refuses it, keeps last-known-good and shows the refusal. The release note says so. No starter, template or fixture sets `api`.

## WP1: contract (lead)

Files: `contracts/CONTRACT.md`, `contracts/generate.mjs`, generated `contracts/openapi.json`, `contracts/protocol.schema.json`. Describe exactly what ADR section 9 lists: the manifest `sampling` object, `features` value `event_sampling`, the heartbeat `sampling` block, `POST /agent/v1/samples`, the seven dashboard routes with roles, the `SamplingRequest` shape, the `Device.sampling` projection, `GET /settings` `event_sampling`, and the new error codes (`SAMPLING_DISABLED`, `SAMPLING_NOT_ALLOWED`, `SAMPLING_UNAVAILABLE` with `reason`, `SAMPLING_BUSY`, `SAMPLING_EXPIRED`). Run `node contracts/generate.mjs` with no drift. Tests: P-05.

## WP2: server (backend agent)

**Migrations reserved: 0140 to 0149.** Used: 0140, 0141, 0142. Held and unused: 0143 to 0149.

Sketch (final SQL is the owner's; the constraints are the point):

```sql
-- 0140_event_sampling_requests.sql: metadata only. No column can hold event content.
CREATE TABLE sampling_requests (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 actor_id TEXT NOT NULL,
 request_id TEXT NOT NULL CHECK(length(request_id)=36),
 payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
 device_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 component_id TEXT NOT NULL CHECK(length(component_id) BETWEEN 1 AND 64),
 side TEXT NOT NULL CHECK(side IN ('outputs','inputs')),
 max_events INTEGER NOT NULL CHECK(max_events BETWEEN 1 AND 100),
 max_seconds INTEGER NOT NULL CHECK(max_seconds BETWEEN 5 AND 120),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 200),
 state TEXT NOT NULL CHECK(state IN ('requested','delivered','complete','empty','refused','aborted','cancelled','expired')),
 code TEXT CHECK(code IS NULL OR length(code)<=64),
 closed_by TEXT CHECK(closed_by IS NULL OR length(closed_by)<=32),
 events_kept INTEGER, bytes INTEGER,
 counts TEXT CHECK(counts IS NULL OR (json_valid(counts) AND length(counts)<=2048)),
 vector_restarted INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, start_by TEXT NOT NULL, finish_by TEXT NOT NULL,
 delivered_at TEXT, finished_at TEXT, first_read_at TEXT,
 UNIQUE(actor_id, request_id)
);
-- 0141_event_sampling_devices.sql: the per-device counter and last reported capability.
CREATE TABLE sampling_devices (
 device_id TEXT PRIMARY KEY,
 generation INTEGER NOT NULL DEFAULT 0,
 capability TEXT CHECK(capability IS NULL OR (json_valid(capability) AND length(capability)<=2048)),
 reported_at TEXT
);
-- 0142_event_sampling_indexes.sql
CREATE UNIQUE INDEX sampling_one_open ON sampling_requests(device_id) WHERE state IN ('requested','delivered');
CREATE INDEX sampling_due ON sampling_requests(finish_by) WHERE state IN ('requested','delivered');
CREATE INDEX sampling_by_device ON sampling_requests(device_id, created_at DESC);
```

Files the package owns:

| File | Work |
| --- | --- |
| `server/migrations/0140_*.sql`, `0141_*.sql`, `0142_*.sql` | As above. |
| `server/src/sampling.rs` (new) | The request lifecycle and one-way state machine; the bounded in-memory sample store (32 samples, 16 MiB, one per device, 4 per user, 15-minute TTL, purge on revoke, user disable and shutdown); the seven dashboard handlers; the upload handler with a body cap enforced while reading; the manifest object builder; the heartbeat `sampling` validator; the expiry sweep; the promotion audit. |
| `server/src/api.rs`, `server/src/lib.rs`, `server/src/main.rs` | Mount the routes with `authorize(..., &["operator"], true)` for mutations; agent route on the agent listener; `VECTORY_EVENT_SAMPLING` (`on` default, `off` removes routes and the feature); hold the store in `App`. |
| `server/src/device.rs` | `HEARTBEAT_FEATURES` gains `event_sampling` only when enabled; the signed payload gains `sampling` for the authenticated device's open request (state `requested` to `delivered`); parse and persist the heartbeat `sampling` block into `sampling_devices`; project `Device.sampling`. |
| `server/src/wake.rs` (on the integration branch) | `Registry::nudge(device)` answers a parked wait `changed:true` without a generation change, paced like other wakes; the wait's entry query also treats a `requested` sampling row as changed. `delivered` rows do not, so there is no loop. |
| `server/src/audit.rs` | Per-action detail allowlists for `event_sampling.request`, `.complete`, `.expired`, `.denied`, `.cancel`, `.read`, `.promote`: component ID, side, limits, reason, counts, codes, how it ended. Nothing else. |
| `server/src/device_revocation.rs`, `device_recovery_requests.rs`, `accounts.rs` | Revoking or recovering a device cancels its open request and purges its sample; disabling an account purges that account's samples. |
| `server/src/maintenance.rs` | The restore generation fence also raises `sampling_devices.generation` above each device's reported `highest_generation`. |
| `server/tests/event_sampling.rs` (new) | S-01 to S-14. |

Reviewer's attack surface: see the list at the end.

## WP3: agent (agent workstream)

All new files sit in `agent/internal/agent/` unless noted. `reconcile.go` and `vector.go` are shared and busy: keep edits there to the smallest hooks.

| Package | Files | Work | Tests |
| --- | --- | --- | --- |
| 3a Consent | `types.go` (`Settings.EventSampling`), `sampling_consent.go`, `sampling_settings.go`, `agent/cmd/vectory/commands.go` (`configure-sampling`), `agent/cmd/vectory/help.go`, `status.go`, `doctor.go` | Decode fail-closed (absent, malformed, unknown fields, out-of-range means off). `ConfigureSampling` and `DisableSampling` through `lockSettingsMaintenance`, `loadSettingsDocument` and `settingsDocument.save`. The command prints the consent text, needs a typed yes or `--yes`, refuses on Windows and on platforms not yet enabled. `setup`, `install`, `enroll` unchanged. | A-01, A-02, A-03, N-02 |
| 3b Redactor | `sampling_redact.go` | Rules 1 to 6 of ADR section 4 on top of `redactor` (`diagnose.go`), reading bound secrets with `readLocalSecret`, learning credential leaves and full-mode environment values through `learnConfiguration`. Streaming, per event. A distinct output type is the only thing the uploader accepts. | A-11 |
| 3c Connection reader | `sampling_conn_linux.go` (`/proc/net/tcp`), `sampling_conn_darwin.go` (`/usr/sbin/netstat -anp tcp`), `sampling_conn_other.go` (reports unsupported) | Count established sockets whose local port is 8686 and identify the tap's own by its ephemeral port. Parse errors are errors, never "none". | A-09 (unit), N-01 |
| 3d Window | `vector.go` (one new `VectorDriver` method that writes the overlay with or without the block and reloads through the existing `reload`), `sampling_window.go` | Port probe; candidate validation with a staged overlay; open, prove open; close, drift rule, prove closed; enforcement by `Stop` then `Activate`. Never calls `Activate` to open. | A-07, A-08, A-09, A-15 |
| 3e Tap runner | `sampling_tap.go` | The exact argv, scrubbed environment, no stdin, output caps, stderr signals, kill on deadline and process group, exit-code interpretation, non-log counting, never closing the pipe early. | A-10 |
| 3f Session engine | `sampling.go`, `types.go` (`State`: `HighestSamplingGeneration`, last result, bounded session history), `protocol.go` (upload call), `heartbeat_features.go` (`sampling` block, `featureEventSampling`), `reconcile.go` (call after `poll`, before `wait`; keep the verified manifest's object) | Verification order of ADR section 3; persist the generation before acting; preconditions; rate limits persisted; pause and Vector-exit polling every 500 ms; upload with one retry; result in the next heartbeat. | A-04, A-05, A-06, A-12, A-13, A-14 |
| 3g Native behavior probe | `agent/tests/native-sampling-probe.py` | Reproduce Appendix A experiments A to G against `VECTOR_TEST_BINARY` in a private network namespace and assert the constants: reload-enabled API binds 8686 whatever the address; a busy port stops Vector; a stream survives the block's removal and dies with Vector; the merge rules; tap exit codes and stderr signals; `--limit` edge values; no event loss across reloads. Fails loudly on any change. Runs in CI on Linux, on macOS where a runner exists, and whenever the pinned Vector changes. | A-15, N-01 |

## WP4: dashboard (lead)

| Files | Work |
| --- | --- |
| `dashboard/src/api.ts` (additive), `samplingModel.ts` (state machine and the copy table of ADR section 7) | Types and calls for the seven routes; one place for every refusal text; request identity kept the way the other keyed mutations keep it (`request_id`, exact-status read after an uncertain result). |
| `DeviceSampling.tsx`, `DeviceDetail.tsx` | The "Event sampling" card: not allowed, allowed (mode, caps, last session), window banner, platform and pipeline refusals, "Sample events…". |
| `SampleEventsPanel.tsx`, `SampleViewer.tsx` | Request form (component, side, count, window, required reason), progress, the scope banner, the tree and raw views, chips with tooltips, counts, "Delete now", restore after reload within the TTL. Events render as text only. |
| `PipelineDetails.tsx`, `SyntheticTester.tsx`, `PipelineEdge.tsx`, `CanvasActionMenu.tsx` | The node action beside "Test with samples" and the edge action, with the device picker that lists only devices running this pipeline and the reason next to each device that cannot sample. |
| `SamplePromotion.tsx`, `sampleStore.ts`, `sampleTests.ts` | "Use as VRL sample": an ephemeral, device-sourced set excluded from `writeSamples` until "Keep in this browser". "Create unit test": the preview and edit step, then `unitTestFromSample` per event into the draft, then `promote`. Shape placeholders become example values. |
| `dashboard/src/*.css`, help-center links | Styles in the design system's tokens; light, dark and 390 px. |
| Tests | vitest: model, copy completeness, no persistence. Playwright `dashboard/tests/sampling-browser.mjs`: B-01 to B-05, with the port free-check the other harnesses use. |

## WP5: docs, operations, CI (security and release)

- `docs/user/event-sampling.md` (new) and updates to `security.md` (qualify "Your events stay yours": unless the host owner turns on sampling; say what redaction does not guarantee and which hosts must not allow it), `cli.md`, `agents.md`, `troubleshooting.md`, `glossary.md`, `whats-new.md`; `CHANGELOG.md`.
- `docs/internal/REQUIREMENTS.md` rows and `docs/internal/CAPACITY.md`: the ADR appendix's cost table is the seed; add rates above 12,000 events/s when measured.
- `docs/product-specification.md` (lead): one sentence in sections 9 and 11 that host-approved, bounded sampling per ADR 0011 is allowed.
- `deploy/compose.yaml` and `deploy/Dockerfile`: no core dumps for the server process (`ulimit core=0`), and a documented note on swap, because samples live in server memory.
- `.github/workflows/ci.yml`: a Linux job for the native probe and the Linux protocol test; a macOS job when a runner exists.

## WP6: integration and independent review (lead, security)

`tests/security/protocol_test.go` and `tests/contracts.mjs`: P-01 to P-05, including the adversarial set from the ADR: replayed and wrong-device manifests, wrong nonce, expired session, oversized upload, a secret value in an event, consent removed and pause mid-session, a second session, a cross-user read, a foreign client in the window. The review starts from a build that has passed every test above.

## What an independent reviewer must attack in the finished code

1. **Consent.** Every path from network-decoded data to `settings.json`, by search and by test. The flag sets of `setup`, `install`, `enroll`. Whether consent is ever cached beyond what a stopped-agent change allows.
2. **Manifest parsing.** That a `sampling` object is never honored from an unsigned response, and that the generation is durable before any effect. A crash between persist and act. Two requests with equal generation.
3. **Preconditions and races.** Apply against sampling (one goroutine: prove it). Pause set between the check and the reload. Journal present. A deployment arriving during a window, and what `Activate` does to the overlay.
4. **The overlay.** Every writer of the managed file; that the block never lands there; that a crash at each step leaves no block after restart.
5. **The port.** Probe correctness, IPv6 and `TIME_WAIT`, the bind race, what supervision does after a bind failure stops Vector, and that it cannot loop.
6. **Closure.** Connection-table parsing (hex byte order, IPv4-mapped sockets, `localhost` resolving to `::1`, macOS `netstat` columns), fail-closed on every error, the restart path's use of the ordinary verified route, and any way for a foreign client to hide from detection.
7. **The tap runner.** Argument injection through component IDs, environment scrubbing, zombie and orphan processes, output caps, the exit-101 pipe panic, and reading exit 0 as proof of anything.
8. **Redaction.** Bypass by case, Unicode normalization, split values, nested JSON in strings, huge keys, deep nesting, long arrays, numeric secrets; key names and lengths as a side channel in shape mode. Whether a raw event can reach disk, a log line, a panic message, a diagnostic or a core dump. That the uploader cannot take an unredacted type. Hash key handling.
9. **Server authorization.** Every route's role and ownership rule, requester-only reads, 404 versus 403 leaks, request IDs as object references, CSRF and cross-site refusal, idempotency, the one-way state machine.
10. **Server storage.** Caps enforced before a body is buffered; purge on every path (TTL, revoke, disable, restart, delete now); no body in any log, `Debug` output, error message (`serde` errors that echo content), audit detail or export; the canary tests actually run.
11. **Wake integration.** That `nudge` cannot be provoked by a non-owner, that it cannot loop, and that the hint stays unsigned and contentless.
12. **Dashboard.** Markup injection through event content and component IDs, `localStorage` writes of device-sourced data, the promotion confirmations, URL and clipboard handling.
13. **Backups and restore.** No sample bytes anywhere; the generation fence.
14. **Platform gating.** That Windows (and macOS until enabled) refuses at every layer and cannot reach `vector tap`.
15. **Vector pin.** That the agent refuses to sample on any Vector series other than 0.58 and that the probe fails when a constant changes.
16. **Denial of service.** An operator or a compromised server flooding requests; a device flooding uploads; the writer-lock time the sampling queries add to a heartbeat.
17. **Documentation against behavior.** Every claim in the user docs and the consent text, checked against what the code does.
