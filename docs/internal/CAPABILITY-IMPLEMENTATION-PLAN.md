# Capability tiers and managed assets: implementation plan

Status: proposed, 2026-10-02. Nothing here is built. The decisions are [ADR 0012](../adr/0012-graduated-capability-tiers.md) (tiers, host approvals, the service sandbox) and [ADR 0013](../adr/0013-managed-assets.md) (managed assets); the attacker tables are in the [threat model](../security/THREAT-MODEL.md#graduated-capability-tiers). This plan orders the work, names the files each package owns, states every wire and storage change, lists the tests each package needs and what an independent reviewer must attack. Ownership follows `AGENTS.md`: the lead owns `dashboard/`, `contracts/`, `vector-catalog/` and the generators in `scripts/` that write it, plus integration tests; the backend agent `server/`; the agent workstream `agent/`; security and release `deploy/`, `packaging/`, `.github/`, operational docs and the independent review. A route or wire change needs the lead's agreement first.

## Start here (for the reviewer)

Each question has a one-line answer in an ADR and a test below.

1. Can anything a server sends add a component, capability, file root, destination or listener to a host's policy, or change its sandbox? (WP3, WP6; ADR 0012 section 3.)
2. With no allowances, does a restricted device reach anything outside Vector after this change? (The `empty-host` fixtures, WP2.)
3. Can a template, a passthrough option or an ambient credential reach a resource no allowance names? (WP2 fixtures, WP3.)
4. Do the agent, the server and the dashboard compute the same needs for every fixture? (WP2, run in WP3, WP4, WP5.)
5. Can a value in `settings.json` become a unit directive, or widen the sandbox without root seeing it? (WP6.)
6. Can a device fetch an asset its current version doesn't pin? (WP7, WP11.)
7. Can a running Vector see an asset change under it, or lose a file its last verified configuration names? (WP8.)
8. Can a private key end up stored on the server? (WP7.)

## Prerequisites and ordering

| Order | Package | Depends on | Ships |
| --- | --- | --- | --- |
| 0 | Prerequisites | nothing | first |
| 1 | Contract | 0 agreed | before any code in 3 to 9 |
| 2 | Capability table and generator | 1 | with 3 |
| 3 | Agent policy and commands | 2 | with 4 and 5 |
| 4 | Server needs and reports | 1, 2 | with 3 and 5 |
| 5 | Dashboard: deploy review, chips, capabilities card | 1, 2, 4 | with 3 and 4 |
| 6 | Service sandbox | 3 | with 3 to 5, or the release after |
| 7 | Managed assets on the server | 1 | with 8 and 9 |
| 8 | Managed assets on the agent | 1, 2, 3 | with 7 and 9 |
| 9 | Managed assets in the dashboard | 5, 7 | with 7 and 8 |
| 10 | Docs, operations, CI | each package | with each package |
| 11 | Integration tests and independent review | all | gate |

**Two releases.** The first ships work packages 0 to 6 with the first review waves of the table (WP2): the 18 components restricted mode runs today, reviewed into the table so none of them changes tier; the default-allow set (the 16 in-memory transforms, `static_metrics` beside `demo_logs` and `internal_metrics`, the harmless global settings, confined templates, enrichment tables under allowed roots, the `file` sink); and the first approvals (Kafka, AWS S3, Datadog logs and metrics, `host_metrics`, `journald`, `docker_logs`). The second ships managed assets, work packages 7 to 9, with CSV, MaxMind and PEM certificate kinds.

**Release gates, all required:** the generator's `--check` and completeness check green; the golden fixtures pass in Go, Rust and TypeScript; the native probe green on Linux; the native systemd sandbox job green; the independent review finished with its findings resolved; documentation matches behavior.

## Wire and storage changes

Every change is additive. Old agents and old servers keep their shapes (ADR 0012 section 8, ADR 0013's compatibility section).

**Manifest (server to agent, signed).**

- `features` gains `capabilities` and `assets`, listed by every server that accepts the heartbeat fields below.
- `desired` gains `assets?: [{name, sha256, size, kind, path}]`, present only when the version pins assets: at most 16, `sha256` lowercase 64-hex, `size` 1 to 10,485,760 and at most 67,108,864 together, `kind` one of `csv`, `mmdb`, `pem_certificates`, `name` matching `^[A-Za-z][A-Za-z0-9_.-]{0,63}$` and unique, `path` exactly `/agent/v1/assets/{sha256}`. In Go, `Desired.Assets []AssetRef` with `json:"assets,omitempty"`, so `Identity(m.Desired)` is unchanged for manifests without assets.

**Heartbeat (agent to server)**, sent only after a verified manifest lists the feature (`addHeartbeatFeatures`):

```json
"capabilities": {
  "table": "0.58.0/1f3a9c0e2b7d4a65",
  "components": ["aws_s3", "kafka"],
  "capabilities": ["managed-ca"],
  "network": ["broker.example.net:9092", "unix:/run/app.sock"],
  "listeners": ["0.0.0.0:514"],
  "file_roots": ["/var/log/nginx"],
  "truncated": false,
  "sandbox": {"kind": "systemd", "mode": "strict", "read_only": []},
  "allow_restart": true
},
"assets": [
  {"name": "geo-country", "sha256": "…", "state": "present", "checked_at": "2026-10-02T09:14:00Z"}
]
```

Bounds the server enforces, rejecting unknown keys as it does for `host_runtime`: `table` at most 64 printable bytes; `components` at most 128 of `[a-z0-9_]{1,64}`; `capabilities` only the known names; `network`, `listeners` and `file_roots` at most 128 entries of at most 512 printable bytes each, with `truncated` true when the agent cut a list; `sandbox.kind` one of `systemd`, `launchd`, `windows`, `none`; `sandbox.mode` one of `strict`, `full`, `custom`, `unknown`; `read_only` at most 16 absolute paths; the whole object at most 16 KiB. `assets` at most 64 entries; `state` one of `present`, `missing`, `downloading`, `failed`, `drifted`; `code` an agent diagnostic code. An empty `assets` array means "supported, nothing in use".

**Agent route.** `GET /agent/v1/assets/{sha256}` (mutual TLS): `200` with the bytes, `Content-Type: application/octet-stream`, `Content-Length`, `ETag: "<sha256>"`, `Cache-Control: no-store`; `403 FORBIDDEN` unless the digest is pinned by the device's current desired version or an unexpired validation for that device; `404` for a malformed digest; `429` with `Retry-After` (`RATE_LIMITED` beyond 30 a minute per device, `CAPACITY_BUSY` at 32 transfers or a second transfer for the same device). Streams after the 15-second handler step, cut off after a 20-second stall or 5 minutes, never redirects.

**Dashboard API** (`/api/v1`, session cookie, CSRF on mutations).

| Route | Roles | Purpose | Errors |
| --- | --- | --- | --- |
| `GET /assets?search=&kind=&page=1&page_size=12` | any signed-in role | `{items: AssetSummary[], total, page, page_size, storage: {bytes_used, bytes_limit, assets, assets_limit}}` | 400 |
| `GET /assets/{name}` | any | `Asset`: the summary plus the latest 50 `revisions: [{revision, sha256, size, uploaded_at, uploaded_by, pinned_by, stored}]` | 404 |
| `GET /assets/{name}/usage` | any | `{drafts: [{configuration_id, configuration_name}], versions: [{version_id, configuration_id, configuration_name, number, sha256, devices}], devices}`, at most 50 of each | 404 |
| `GET /assets/{name}/content?revision=N` | editor, operator, admin | The bytes, `Content-Disposition: attachment`, `Cache-Control: no-store` | 403, 404 |
| `PUT /assets/{name}/content` | editor, operator, admin | Create (`If-None-Match: *`, `X-Asset-Kind`) or add a revision (`If-Match: "<current sha256>"`); `X-Asset-SHA256` required. `201 Asset`, or `200 Asset` with `unchanged: true` for the current bytes | 400 `INVALID_INPUT` with `reason` (`name_invalid`, `kind_invalid`, `kind_mismatch`, `digest_mismatch`, `not_csv`, `not_mmdb`, `not_certificates`, `contains_private_key`), 409 `CONFLICT` (name exists), 409 `STALE_REVISION`, 413 `PAYLOAD_TOO_LARGE`, 429 `RATE_LIMITED`, 507 `ASSET_STORAGE_FULL` |
| `PATCH /assets/{name}` | editor, operator, admin | `{description, revision}` → `Asset` | 400, 404, 409 `STALE_REVISION` |
| `DELETE /assets/{name}?revision=N` | operator, admin | Tombstone the name; pinned bytes stay. `{ok: true}` | 404, 409 `STALE_REVISION` |

`AssetSummary` is `{name, kind, description, revision, sha256, size, updated_at, updated_by: {id, name} | null, usage: {drafts, versions, devices}}`.

**Other additions.**

- **Version:** `assets: [{name, sha256, size, kind}]` and `uses_managed_assets: boolean`, optional on legacy records.
- **Device:** read-only `capabilities` (the stored report, its `reported_at`, and counts) and `assets: {reported_at, items}`; list rows keep only counts.
- **Preview:** `host_requirements: [{device_ids, table: "match" | "older" | "none", full_mode: [{section, id, type, setting, reason}], components: [{type, reach, approved}], capabilities: [{name, approved}], network: [{value, approved}], listeners: [...], file_roots: [...], assets: {count, bytes}}]`, grouped by identical needs, at most 50 groups; `approved` is `true`, `false`, or `null` when the device reported nothing. `blockers` gains `MANAGED_ASSETS_UNSUPPORTED`. `FULL_VECTOR_MODE_REQUIRED` keeps its code.
- **Errors:** `ASSET_STORAGE_FULL` (507) joins the contract's code list.
- **Audit:** `device.capabilities` (added and removed entries, observed from the report), `asset.create`, `asset.revise`, `asset.describe`, `asset.delete`, `asset.collect`; `configuration.publish` details gain `assets: [{name, revision, sha256}]`. Each has a per-action detail allowlist in `server/src/audit.rs`.
- **Agent diagnostics:** `COMPONENT_NOT_APPROVED`, `CAPABILITY_NOT_APPROVED`, `UNCONFINED_TEMPLATE_DENIED`, `TEMPLATE_RESOURCE_DENIED`, `PASSTHROUGH_OPTION_DENIED`, `SANDBOX_READ_ONLY`, `ASSET_DOWNLOAD_FAILED`, `ASSET_MISMATCH`, `ASSET_STORAGE_FULL`, `ASSET_REFERENCE_REFUSED`, `ASSET_DRIFT`, each with a fixed hint in `codeHints` and a sentence in the server's per-code rendering.
- **Local settings** (`settings.json` → `capability_policy`, and the `install --capability-policy` file): `allowed_components: string[]`, `allowed_capabilities: string[]`; `allowed_network_hosts` accepts `unix:/absolute/path`.
- **CLI:** `vectory allow [--network HOST:PORT | unix:PATH]... [--listener ADDR:PORT]... [--file-root PATH]... [--component TYPE]... [--capability NAME]... [--yes]`; `vectory disallow` with the same flags; `vectory capabilities [--json]`; `--yes` on `install` with `--capability-policy`, `--allow-full-vector-config` or `--vector-data-dir`.
- **Contract wording:** `secret_revision` becomes the materialization counter (device secrets or managed assets); `uses_local_secrets` or `uses_managed_assets` marks a materialized version.

**Migrations reserved: 0150 to 0159.** Used, in the order they ship: 0150 with the capability tiers, 0151 and 0152 with managed assets. Held and unused: 0153 to 0159. The package writes the final SQL; the constraints are the point. A blob has no kind: two names of different kinds may hold the same bytes, and the kind travels with the name and the version's pins.

```sql
-- 0150_device_capability_reports.sql: written only when a report changes.
CREATE TABLE device_reports (
 device_id TEXT PRIMARY KEY REFERENCES devices(id),
 capabilities TEXT CHECK(capabilities IS NULL OR (json_valid(capabilities) AND length(capabilities) <= 16384)),
 capabilities_sha256 TEXT CHECK(capabilities_sha256 IS NULL OR length(capabilities_sha256)=64),
 capabilities_reported_at TEXT
);
-- 0151_managed_assets.sql
CREATE TABLE asset_blobs (
 sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 10485760),
 bytes BLOB NOT NULL CHECK(length(bytes)=size),
 created_at TEXT NOT NULL
);
CREATE TABLE assets (
 name TEXT PRIMARY KEY COLLATE NOCASE CHECK(length(name) BETWEEN 1 AND 64),
 kind TEXT NOT NULL CHECK(kind IN ('csv','mmdb','pem_certificates')),
 current_sha256 TEXT REFERENCES asset_blobs(sha256),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
 deleted_at TEXT,
 CHECK((deleted_at IS NULL) = (current_sha256 IS NOT NULL))
);
CREATE TABLE asset_revisions (
 name TEXT NOT NULL COLLATE NOCASE, revision INTEGER NOT NULL CHECK(revision >= 1),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), size INTEGER NOT NULL,
 uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL,
 PRIMARY KEY(name, revision)
);
CREATE TABLE version_assets (
 version_id TEXT NOT NULL, name TEXT NOT NULL,
 sha256 TEXT NOT NULL REFERENCES asset_blobs(sha256),
 PRIMARY KEY(version_id, name)
);
CREATE TRIGGER asset_blobs_no_update BEFORE UPDATE ON asset_blobs
 BEGIN SELECT RAISE(ABORT,'asset blobs are immutable'); END;
CREATE TRIGGER asset_blobs_keep_referenced BEFORE DELETE ON asset_blobs
 WHEN EXISTS (SELECT 1 FROM version_assets WHERE sha256=old.sha256)
   OR EXISTS (SELECT 1 FROM assets WHERE current_sha256=old.sha256)
 BEGIN SELECT RAISE(ABORT,'asset blob is still referenced'); END;
CREATE TRIGGER asset_revisions_no_update BEFORE UPDATE ON asset_revisions
 BEGIN SELECT RAISE(ABORT,'asset revisions are immutable'); END;
CREATE TRIGGER version_assets_no_update BEFORE UPDATE ON version_assets
 BEGIN SELECT RAISE(ABORT,'version asset pins are immutable'); END;
CREATE TRIGGER version_assets_no_delete BEFORE DELETE ON version_assets
 BEGIN SELECT RAISE(ABORT,'version asset pins are immutable'); END;
ALTER TABLE device_reports ADD COLUMN assets TEXT
 CHECK(assets IS NULL OR (json_valid(assets) AND length(assets) <= 16384));
ALTER TABLE device_reports ADD COLUMN assets_sha256 TEXT
 CHECK(assets_sha256 IS NULL OR length(assets_sha256)=64);
ALTER TABLE device_reports ADD COLUMN assets_reported_at TEXT;
-- 0152_managed_asset_indexes.sql
CREATE INDEX version_assets_digest ON version_assets(sha256);
CREATE INDEX assets_current ON assets(current_sha256);
CREATE INDEX asset_revisions_digest ON asset_revisions(sha256);
CREATE INDEX asset_blobs_age ON asset_blobs(created_at);
```

## WP0: prerequisites (agent workstream, with the lead)

| Where | Change |
| --- | --- |
| `agent/internal/agent/policy.go` | The agent halves of security findings 5 and 7 ([work queue item 1](WORK-QUEUE.md#1-fix-the-open-security-findings)): restricted mode refuses a top-level `api` block (the same change as WP0 of the [event-sampling plan](TAP-IMPLEMENTATION-PLAN.md#wp0-make-api-host-owned-prerequisite); whichever plan starts first makes it); both modes refuse component IDs containing `/`, `\`, control characters or a Windows drive prefix. The table makes `api` host owned, and the sandbox assumes IDs never become paths. |
| `tests/security/test_vrl_function_lists.py` or a sibling | A drift test over today's three component lists (`supported` in `policy.go`, `localTypes` in `scripts/generate-vector-catalog.mjs`, `fullModeRequirements` in `dashboard/src/hostRequirements.ts`), so replacing them with the table in WP2 to WP5 is a pure refactor the test can watch. |

## WP1: contract (lead)

Files: `contracts/CONTRACT.md`, `contracts/generate.mjs`, generated `contracts/openapi.json` and `contracts/protocol.schema.json`. Describe everything in [Wire and storage changes](#wire-and-storage-changes). `node contracts/generate.mjs` leaves no diff; `tests/contracts.mjs` validates real bodies, including an old agent's heartbeat and an old server's manifest.

## WP2: capability table and generator (lead)

| File | Work |
| --- | --- |
| `vector-catalog/capabilities.json` (new) | The reviewed source (ADR 0012 section 2): per component type and kind the tier, the reach sentence, resource fields and kinds, refused fields and reasons, template fields, ambient credential shapes, vendor defaults to write out; global settings; enrichment table types; the two VRL lists; the asset fields of ADR 0013. Shared schema types classified once. |
| `scripts/generate-capability-table.mjs` (new) | Writes `agent/internal/agent/capability_table_generated.go`, `server/src/capability_table.rs` and `dashboard/src/generated/capability-table.json`; `--check` fails when one is stale; the completeness check fails on an unclassified component, or on a resource-like field (by name or schema type) without a classification. |
| `scripts/generate-vector-catalog.mjs` | `device_capability` (`builtin`, `approval`, `full`, replacing `allowed` and `requires_review`) from the table instead of `localTypes`, with its four readers changed in the same release (`requires_full_mode` in `server/src/rollout.rs`, `dashboard/src/hostRequirements.ts`, `dashboard/src/PipelineSettings.tsx`, `tests/catalog.mjs`); `tls.key_file` joins the reviewed plain-string credentials, so `scripts/generate-secret-fields.mjs` regenerates the device-secret table with it (ADR 0013 section 7). |
| `vector-catalog/fixtures/capabilities/` (new) | Golden fixtures: a configuration and its expected needs. At least: an empty host for each tier; each resource kind; every case of [ADR 0012's template measurements](../adr/0012-graduated-capability-tiers.md#templates-at-validation); `base_dir` inside and outside a root; URIs with IPv6 literals, userinfo, percent-encoding and `@` in the path; ambient credential shapes for AWS, GCP and Azure; `librdkafka_options` with an allowed key, `sasl.kerberos.kinit.cmd` and `plugin.library.paths`; Unix-socket sinks; roots overlapping the state directory and the managed configuration; each enrichment table type; the VRL enrichment functions; every global setting; asset references of each kind, in a wrong field and unpinned. |
| `tests/security/test_vrl_function_lists.py` | The refusal list loses the two enrichment-table functions; the device-only list keeps them; both stay drift-tested. |
| Help center | `docs/user/security.md`'s component lists generated from the JSON copy and checked by the Help center's tests, so the docs can't drift from the table. |

**Review waves**, each a table change with its fixtures. The default-allow set and the first approvals ship in the first release; the rest move from full mode as their profiles are reviewed: wave 2, the remaining built-in network components (`socket`, `vector`, `statsd`, `splunk_hec*`, `prometheus_scrape`, `prometheus_remote_write`, `http_client`, `opentelemetry` as a sink, `amqp`, `mqtt`, `redis` as a source, and the listener sources beyond today's `http_server`, `syslog` and `opentelemetry`); wave 3, the remaining approvals.

**Tests.** The generator's `--check` and completeness in CI; a test that feeds the completeness check a schema with one new `*_file` field and expects a failure naming it; every fixture parses and has an expectation for every needs category; the Help center check that the generated lists match.

## WP3: agent policy and commands (agent workstream)

| Files | Work |
| --- | --- |
| `policy.go`, `capability_table_generated.go` | `Needs(config)`, pure and table-driven; `Check` compares needs with the policy and keeps the first refusal in a stable order; new refusal codes and `PolicyRefusal.Diagnostic` texts worded by reason; `DescribeAllowances` covers components, capabilities and `unix:` destinations. The policy check receives the asset paths substituted (used by WP8). |
| `types.go` | `CapabilityPolicy.AllowedComponents`, `AllowedCapabilities`. |
| `install_options.go` | `ReadInstallPolicy` accepts the two new keys and still refuses unknown ones; `validateInstallPolicy` accepts `unix:` destinations, refuses `/`, volume roots and roots overlapping the state directory, the managed configuration directory or the assets directory, and validates component and capability names against the table (built in: a note; full mode: refused with the full-mode command; unknown: the nearest names). `InstallOptions.AddAllowances` gains a removal counterpart for `disallow`. |
| `heartbeat_features.go` | The `capabilities` report, bounded and truncated as the contract says. |
| `diagnose.go` | `codeHints` for the new codes. |
| `agent/cmd/vectory/commands.go`, `help.go` | `allow --component`, `--capability`, `unix:` destinations; `disallow`; `capabilities` (human and `--json`). |
| `status.go`, `doctor.go` | The one-line capability summary; doctor's Mode line with approvals. |

**Tests.**

- Every golden fixture through `Needs`.
- `Check`: refusal order, each code with its field and fix, full mode unchanged, recovery content (`startExisting`, `restoreLastGood`), `re-adopt` and local diagnostics checked the same way.
- The settings bytes are identical after processing manifests with every hostile shape (unknown `desired` fields, a `policy` naming components); the source scan of [ADR 0011](../adr/0011-opt-in-event-sampling.md) (A-02) extended to the new fields.
- `allow` and `disallow`: each input rule, idempotence, JSON output, the `vectory logs` note; a settings file from an older build without the new fields; a file with the new fields read by a build that ignores them is stricter.
- Golden output of `vectory capabilities` and the status line.
- Native, with the pinned Vector (`VECTOR_TEST_BINARY`): a restricted device applies a version using `log_schema`, `timezone`, `dedupe` and a confined template; refuses an unconfined one; with `--component kafka` and the broker allowed, applies a Kafka sink pointed at an unreachable local address (Vector starts; the health check fails and doesn't block); refuses an `elasticsearch` sink with ambient AWS credentials until `--capability instance-credentials`.

## WP4: server needs and reports (backend agent)

| Files | Work |
| --- | --- |
| `server/src/capability_table.rs` (generated), `server/src/capabilities.rs` (new) | The Rust `needs`; report validation; the stored report and its projection; the `device.capabilities` audit on change. |
| `server/src/rollout.rs` | `requires_full_mode` becomes `needs` per rendered artifact for devices that report a table, and stays as the legacy rule for those that don't; `compatibility_problems` blocks only full-mode needs (and `MANAGED_ASSETS_UNSUPPORTED`, WP7); the preview groups `host_requirements`. |
| `server/src/device.rs` | `HEARTBEAT_FEATURES` gains `capabilities`; parse the report before the writer transaction; write `device_reports` only when its digest changes. |
| `server/src/api.rs`, `server/src/audit.rs` | The preview's new field; the audit allowlist. |
| `server/migrations/0150_device_capability_reports.sql` | As sketched. |

**Tests.** Every golden fixture through the Rust `needs`. The preview with per-device variables naming different listeners, the regression for [authoring finding 6](AUTHORING-GAPS.md#p2): each device's group names its own listener. Grouping and the 50-group bound. A legacy agent gets today's rule and `table: "none"`. Report validation (unknown keys, bounds, control characters, oversize) rejects the heartbeat atomically, like `host_runtime`. The report row is written only on change, and the audit fires once per change. The role matrix of the preview is unchanged. A load run (`tests/load/capacity.py`) shows no added writer time per check-in when the report doesn't change.

## WP5: dashboard (lead)

| Files | Work |
| --- | --- |
| `dashboard/src/hostRequirements.ts`, `generated/capability-table.json` | The TypeScript `needs` over the table, keeping the functions template cards and the library call (`describeNeeds`, `hostApprovals`), now with the tier and reach of each component. |
| `dashboard/src/hostApprovalCommands.ts` | `--component`, `--capability` and `unix:` flags; one line with the prompt for agents that report `allow_restart`; today's three steps for older agents and foreground agents; Windows quoting covers the typographic quotes of security finding 6. |
| `dashboard/src/TargetDialog.tsx` | `HostApprovalNote` renders the preview's per-device groups: approved, missing or unknown per item, plain reasons (authoring finding 13), one command per host; the full-mode blocker copy. |
| `DeviceCapabilities.tsx` (new, one mount point in `DeviceDetail.tsx`) | The capabilities card: mode, approvals, allowances counts with lists on demand, sandbox state and reported read-only paths with their fix, "Only someone on this host can change this." |
| The editor's component picker and inspector header | The tier chip and reach sentence from the table. |
| `api.ts` | Types for the new fields. |

**Tests.** Vitest: every golden fixture through the TypeScript `needs`; the command builder for each OS, service manager, state directory, legacy agent and hostile value; the copy for each group shape. Playwright: extend the deploy harness with the shared fleet replies (`dashboard/tests/fleet-replies.mjs`) for approved, missing and unknown items, a legacy agent and the full-mode blocker; a device-page harness for the card's states; Axe; screenshots in light, dark and 390 px.

## WP6: service sandbox (agent workstream; packaging and CI with security and release)

| Files | Work |
| --- | --- |
| `agent/internal/agent/service_linux.go` | `systemdUnit(spec)` writes the base unit (strict) for setup, `service-install` and the package; `sandboxDropIn(settings, dir)` writes `10-vectory-sandbox.conf` for the host's mode and allowances (`ProtectHome=tmpfs` with `BindPaths=` for a root under `/home`, `/root` or `/run/user`); every value revalidated (absolute, no control characters) and quoted; a foreign file of that name stops it; `daemon-reload` after a change. |
| `apply_restart.go` (new) | One helper for "stop the service, commit, regenerate, reload, start, wait for the first check-in", with the prompt, `--yes`, the root check before any change, the foreground-agent refusal, and a start again if anything fails after the stop. Used by `allow`, `disallow` and `install`. |
| `service_darwin.go`, `launchd.go`, `service_windows.go` | The same restart through each manager, no sandbox file. |
| `setup.go` | Regenerate the base unit and the drop-in on every run; restart a running service when either changed, not only for a new build (`startService`). |
| `reconcile.go`, `diagnose.go` | The write preflight before `Validate` (`access(W_OK)` on each path `Needs` says Vector writes, or its nearest existing parent; Linux and macOS); `SANDBOX_READ_ONLY` from the preflight and from Vector's `Read-only file system (os error 30)`; not held back. |
| `doctor.go` | The Sandbox check: `systemctl show` for `ProtectSystem`, `ProtectHome`, `ReadWritePaths` and `DropInPaths`, compared with the drop-in the policy would generate; operator drop-ins listed; roots inside the private `/tmp`; "No operating-system sandbox" on macOS and Windows. |
| `heartbeat_features.go` | `sandbox` in the capabilities report. |
| `agent/cmd/vectory/commands.go`, `prompt_unix.go`, `prompt_windows.go` | `--yes`; the yes-or-no prompt; the texts of ADR 0012 section 6. |
| `packaging/systemd/vectory.service`, `packaging/test_systemd_unit.py` | The packaged file becomes the generator's output for the package paths, with its comments; the Python test keeps checking its properties. |
| `.github/workflows/ci.yml`, `docs/internal/CI.md` | A Linux job on a GitHub-hosted Ubuntu runner, which runs systemd, for the native sandbox test (`timeout-minutes: 10`). |

**Tests.** The packaged unit equals the generator (`VECTORY_UPDATE_GOLDEN=1` rewrites it). Drop-ins for restricted and full mode, roots under `/home`, data directory sources. Hostile values (a newline, quotes, `%`, `$`, backslashes, spaces, Unicode, a leading `-` or `+`) never produce a second directive or a different path: CI parses the generated files with `systemd-analyze verify` and compares `systemctl show -p ReadWritePaths` with the intended set. A foreign `10-vectory-sandbox.conf` stops setup; `override.conf` is never touched. The restart helper with fake service operations: each step, each failure after the stop (the service is started again), the prompt on a terminal, no terminal without `--yes`, `--yes`, not root (refused before any change), a foreground agent. The preflight with a fake `access`. Doctor against recorded `systemctl show` output. The native job installs the unit, runs a `file` sink under an allowed root (writes) and outside one in full mode (`SANDBOX_READ_ONLY` from the preflight), then `vectory allow --file-root … --yes` and checks the write succeeds; it checks `ProtectHome=tmpfs` with `BindPaths=` under `/home`, and falls back to `ProtectHome=read-only` if that fails on the runner's systemd.

## WP7: managed assets on the server (backend agent)

| Files | Work |
| --- | --- |
| `server/migrations/0151_managed_assets.sql`, `0152_managed_asset_indexes.sql` | As sketched, including the `assets` columns of `device_reports`. |
| `server/src/assets.rs` (new) | The dashboard routes; the upload streamed to a private temporary file under the data directory while hashing (`Content-Length` required, 10 MiB checked before reading, 120-second deadline, 2 at a time, 60 an hour per person); the kind checks and the private-key scan; quota (`VECTORY_ASSET_STORAGE_BYTES`, default 1 GiB) and the 256-name limit; usage; the 64 MiB shared cache with one load per blob; the background collection of unpinned, non-current revisions older than 7 days, a bounded number per tick, audited. |
| `server/src/api.rs` | Mount the routes, the upload with its own body limit; the publish transaction pins references and writes `version_assets`; draft save checks reference placement and syntax. |
| `server/src/validation.rs` | References only at asset fields; a private key in any draft value refused; `static_candidate` replaces references with placeholder paths and reports `deferred_reasons: ["managed assets"]`. |
| `server/src/variables.rs` | `safe_value` refuses `vectory-asset:`; `declarations` refuses a path that holds a reference. |
| `server/src/device.rs` | The agent route (authorization, transfer limits, the cache); `desired.assets` from the version's pins; `HEARTBEAT_FEATURES` gains `assets`; the `assets` report into `device_reports`. |
| `server/src/rollout.rs`, `canary_gate.rs`, `configuration_attempt.rs`, `device.rs` | `MANAGED_ASSETS_UNSUPPORTED` in `compatibility_problems`, rechecked at scheduled activation, later waves and group expansion; "materialized" (`uses_local_secrets` or `uses_managed_assets`) wherever verification checks secrets today. |
| `server/src/audit.rs`, `server/src/main.rs`, `server/src/lib.rs` | Allowlists; the setting; the cache and transfer limits in `App`. |

**Tests.** Upload: create, replace with `If-Match`, a stale revision, the same bytes (no revision), a header digest that differs, each kind's checks, a private key in each kind and in odd forms (lowercase label, CRLF, leading spaces), 413 before reading the body, a missing `Content-Length`, the quota, the name limit, the rate limit, the role matrix and CSRF. Publish: latest and pinned references, unknown, deleted and wrong-kind names, a reference outside an asset field, the 16 and 64 MiB limits, audit details. Storage: the triggers refuse updates and deletes of referenced blobs; collection keeps current and pinned revisions and removes the rest after 7 days. The agent route: the current version's asset, another device's, an older version's, a guessed digest, a revoked device, an unexpired and an expired validation; the transfer limits (a stalled reader, the deadline, the 33rd transfer, a second transfer for one device); the cache loads a blob once for many readers. The manifest's list equals the version's pins. A version with assets is never released to an agent without the `assets` report, including in later waves and for new group members. An asset-only version is verified only with the template digest, the effective digest and a raised counter. A backup round trip (`tests/security/test_backup.py`) holds blobs and pins. A measurement of the writer hold for a 10 MiB insert under check-in load goes into `docs/internal/CAPACITY.md`.

## WP8: managed assets on the agent (agent workstream)

| Files | Work |
| --- | --- |
| `types.go` | `Desired.Assets`, `AssetRef`; asset records in `State` (size, fingerprint, verified time). |
| `protocol.go` | `VerifyEnvelope` checks the asset list; a streaming download beside `Client.request`, with a 30-second stall limit and a 5-minute deadline, bounded by the signed size. |
| `assets.go` (new) | Fetch, verify and place (temporary file, sync, `0400`, rename, directory sync); references from the template must equal the manifest list; substitution at the generated asset fields only; the retained set (managed file, `good-<sha>.json`, `pre-attempt.json`, the current template, an open validation); removal after an apply and at startup; drift fingerprints and repair; the 192 MiB cap; the `assets` report. |
| `reconcile.go` | The hook after `loadTemplate`; "materialized" (secrets or assets) in the counter raise, `markApplied` and failure suppression; no download while paused. |
| `policy.go` | The substituted paths accepted exactly; `managed-ca` for `tls.ca_file`. |
| `heartbeat_features.go`, `diagnose.go`, `download.go`, `status.go`, `storage.go` | The report; codes and messages; status lines; temporary files in the assets directory in `removeStaleLeftovers`. |

**Tests.** Manifest checks (count, size, total, kind, path, duplicate names). A cut-off, oversized, stalled or altered download leaves no file under a final name. Placement modes and atomicity. Substitution only at table fields; `ASSET_REFERENCE_REFUSED` elsewhere and for an unpinned reference; a list that disagrees with the artifact refused. The policy check accepts exactly the substituted paths and refuses a literal path into the assets directory; `managed-ca`. Retention across an apply, a local rollback with the server unreachable, and the pre-attempt copy; removal; on Windows, a file held open stays for the next pass. Drift: a changed file is detected by its fingerprint, set aside, fetched again and reloaded; while paused it is only reported. The cap and a full disk fail without holding the version back. Crash injection between placement and the journal leaves a recoverable state. The counter rises for an asset-only version. An old server's manifest changes nothing. Native, with the pinned Vector: a CSV table and a MaxMind table (a tiny database the test writes itself) applied, looked up by VRL, replaced by a new revision, rolled back offline.

## WP9: managed assets in the dashboard (lead)

| Files | Work |
| --- | --- |
| `Assets.tsx` (new, a Pipelines tab), `assetModel.ts` | The list with storage use, an asset's page with revisions and usage, Replace and Delete with their usage shown. |
| `AssetUpload.tsx` (new) | Kind detection, the SHA-256 computed with Web Crypto, a non-secret reminder saved before sending, recovery by reading the asset and comparing digests, refusals in plain words. |
| The editor's schema fields | **Use an asset** on asset fields from the generated table; "latest" or "pinned" with **Use latest**. |
| The publish review, `TargetDialog.tsx` | Pins and changes since the previous version; download size per device and the `MANAGED_ASSETS_UNSUPPORTED` blocker. |
| `DeviceAssets.tsx` (new, one mount point in `DeviceDetail.tsx`) | Reported presence per asset, never inferred. |
| `api.ts`, navigation, the command palette | Types, the route, entries. |

**Tests.** Vitest for the model, the copy, the digest and recovery logic and the field detection. A Playwright harness, `dashboard/tests/assets-browser.mjs`, with the shared fleet replies: upload, replace, a private key refused, too large, storage full, a stale replace, recovery after a lost response, each role. Extensions of the editor, publish, deploy and device harnesses. Axe; screenshots in light, dark and 390 px. The harness joins the dashboard job in `.github/workflows/ci.yml` with `timeout-minutes: 10` and a row in `docs/internal/CI.md`.

## WP10: docs, operations, CI (security and release)

- `docs/user/security.md`: the tiers, with lists generated from the table; what a host approval trusts; `managed-ca` and `instance-credentials`; assets are not secrets; the sandbox claims for Linux with systemd, macOS and Windows.
- `docs/user/cli.md` (every new command and flag; its reference test enforces it), `agents.md` (approving components; the restart), `installation.md` (what the systemd service can write, replacing "planned work"), `pipelines.md` (templates; assets in the editor), a new `assets.md` registered in `help-center/pages.mjs`, `troubleshooting.md` (a row per new code), `glossary.md`, `server-config.md` (`VECTORY_ASSET_STORAGE_BYTES`; its reference test enforces it), `administer.md` (backup size, quota), `whats-new.md`, `CHANGELOG.md` (with the three tightenings of ADR 0012), and [ADR 0005](../adr/0005-restricted-mode-by-default.md)'s allowlist sentence.
- `docs/internal/REQUIREMENTS.md` rows for the local capability policy and artifact identity; `docs/internal/CAPACITY.md` (asset transfers and the upload's writer hold); `docs/internal/CI.md`; `docs/security/OPEN-FINDINGS.md` (finding 9 deleted with WP6; the ambient-credential gap recorded until WP3 closes it).
- `.github/workflows/ci.yml`: the generator's `--check` and completeness; the native probe of ADR 0012 Appendix A on Linux (`agent/tests/native-capability-probe.py`, also run whenever the pinned Vector changes); the native systemd job; the assets harness.

## WP11: integration tests and independent review (lead, security)

`tests/security/protocol_test.go` gains subtests: a manifest that tries every hostile shape leaves the policy and the sandbox unchanged; the asset route refuses another device's asset, an older version's, a guessed digest and a revoked device, and bounds a stalled reader; an oversized or altered asset never lands. `tests/contracts.mjs` validates the new bodies. On a live preview with the demo fleet: a restricted device applies `log_schema`, `timezone` and `dedupe`; one `vectory allow` makes a Kafka pipeline apply; a CSV table and a CA certificate (with `managed-ca`) arrive and are reported present; a rollback restores the earlier asset with the server stopped; a file sink outside the sandbox shows `SANDBOX_READ_ONLY` on the device page. The independent review starts from a build that has passed every test above.

## What an independent reviewer must attack in the finished code

1. **Where policy comes from.** Every path from network-decoded data to `settings.json` and to the sandbox drop-in, by search and by test. Whether a report from a device can ever be used as a grant.
2. **The table's judgement.** Each built-in and approval profile, field by field: a resource field classified as data, a passthrough map left open (the librdkafka key list), an ambient credential shape missed for one auth type, a vendor default left implicit, a component whose protocol follows redirects or discovers peers.
3. **Three checkers, one answer.** Fixture coverage of every rule; configurations generated at random and compared across Go, Rust and TypeScript.
4. **Templates.** Static-part extraction for URIs (IPv6 literals, userinfo, percent-encoding, `@` and `\` in paths) and file paths (`..`, `%` specifiers, `base_dir` outside a root, a symbolic link planted inside an allowed root); the probe that pins Vector's confinement.
5. **File roots and Unix sockets.** Overlap checks with symbolic links, case-insensitive file systems, `..` forms, Windows drive letters and UNC paths; a `unix:` destination that resolves elsewhere.
6. **Unit generation.** Injection through any value; quoting; `ProtectHome=tmpfs` with `BindPaths=`; drop-in ordering; a foreign file; a failed `daemon-reload`; every failure path after the service stops.
7. **The restart command.** Bypassing the prompt (terminal detection, `--yes` in dashboard output), the root check before any change, races with an agent starting at the same time, lock ownership.
8. **The write preflight.** `access` semantics (`EROFS` against `EACCES`, missing paths, mount propagation, network file systems) and paths `Needs` misses.
9. **Asset authorization.** Digest guessing, cross-device access, revocation, transitions during a rollout, the shared cache, `403` against `404` leaks.
10. **Asset transfer.** Memory bounds, slow readers holding slots, uploads without `Content-Length` or with chunked bodies, temporary-file cleanup, disk exhaustion on the server.
11. **Upload checks.** Private-key detection (labels, whitespace, line endings, DER or PKCS#12 bytes in another kind), a MaxMind marker on hostile data, CSV with a byte-order mark, NUL or invalid UTF-8.
12. **Placement on the device.** Symbolic-link races in the assets directory, rename atomicity on Windows, permissions, partial files, removal of a file a retained configuration names, drift fingerprints on coarse timestamps.
13. **Verification evidence.** That an asset-only version can't be marked verified without the effective file, the counter, the canary gate, and the downgrade and upgrade identity case.
14. **Backups.** Asset bytes present and consistent with versions; collection during a backup; a restore missing a blob fails visibly.
15. **Old agents and servers.** Every combination in the compatibility sections of both ADRs.
16. **Capacity.** The report written only on change; the writer hold of a 10 MiB insert; an all-at-once rollout of an asset.
17. **Documentation against behavior.** Every claim in `security.md`, the sandbox claims per operating system, and the asset visibility statements, checked against the code.
