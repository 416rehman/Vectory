# Changelog

All notable changes to Vectory. The project is a developer preview and has no public release yet.

## 0.1.0-dev (unreleased)

The first self-hosted Vectory: a Rust and SQLite control plane, a React dashboard, an outbound-only Go agent, and a bundled Help center. See [What's new](docs/user/whats-new.md) for a tour.

### Highlights

- Visual pipeline editor for the 128 component types of Vector 0.58.0, with YAML, TOML and JSON import and export, VRL and pipeline tests, and immutable history with diffs.
- Publishing checked by an isolated Vector validator that fails closed; checks that need the device run on the device.
- Deployments to devices and groups with previews, priorities, canaries, schedules, pause, cancel and rollback.
- Outbound-only agents with mutual TLS, per-device signed manifests, protection against older configurations, drift repair and automatic restore of the last working configuration.
- Restricted and full modes, local allowances and device-local secret bindings, all controlled on the host.
- Device secrets in every credential field: a pipeline stores `vectory-secret:NAME`, each device fills in the value from its own file, and the device page shows which names each device has bound.
- Device metrics, issues, and an exportable audit log.
- Alerts in Slack, any webhook or email when an issue opens, a rollout fails or a device goes offline, with quiet hours, a delivery log with retries, and editable detection thresholds.
- Roles, two-factor sign-in with recovery codes, and administrator-issued reset links.
- A Help center bundled with the server, searchable offline, with every page available as Markdown and an `llms.txt` index.

### Fixed during development

Agents built before these fixes behave differently. Rebuild agents from this revision.

- **Enrollment preflight:** an unreadable CA file or invalid local option is rejected before connection settings are saved or an enrollment request is created. Earlier builds could save the connection settings first.
- **Combined `install` options** are validated together before anything is saved. Earlier builds could save one option and then reject the next.
- **Credential fields:** plain text in any field Vector marks as a credential is refused at save and publish, with the fix. Earlier builds took `vectory-secret:NAME` only in the `auth` fields of `http`, `loki` and `elasticsearch` sinks, so other credentials were stored in the pipeline. Published versions are unchanged.
- **Secret-binding maps** are parsed strictly: `null`, lists, duplicate names and trailing content are rejected. Earlier builds could treat `null` as "remove all bindings" or keep the last duplicate silently.
- **Capability-policy files** with malformed UTF-8 or unpaired Unicode escapes are rejected instead of being repaired with replacement characters.
- **Metrics endpoint:** `vectory configure-metrics` and `--clear-metrics-url` were added. Earlier builds could only set a URL with `install --metrics-url`.
- **Replaced Vector binaries** can be approved with `vectory re-adopt --expected-sha256`. Earlier builds had no approval path.

- **Restricted mode matches VRL calls, not substrings.** A metric named `http_requests_total`, a filter on `"http_request"` or a step called `http_requests` no longer needs Full Vector mode. The agent, the server and the dashboard decide from one list, and it now includes the functions that read a file (`validate_json_schema`, `parse_proto`, `encode_proto`).
- **`remap.file` is refused in restricted mode** like `files`, and an HTTP route's `path` is no longer judged as a file path. A refusal never suggests `/` as a file root.
- **Delivery health no longer fails an assignment.** A device that stops delivering pauses a persistent assignment (reason "data plane") instead of failing it, so the assignment keeps following its group and resumes when you do.
- **Tests Vector refuses to run are failures.** A misspelled test setting, an unknown step or a test with no expected output shows Vector's reason, and the tests it did not run are marked **Not run**, instead of "0 of 0 tests passed".
- **The documentation page's recovery screen** shows **Reload page** at once for a signed-out visitor; it used to appear after five seconds.
- **The installer's dry run** plans for the directory you chose with `--install-dir`.
- **A listener below port 1024** (syslog on 514, for example) now gets a `PRIVILEGED_PORT` diagnostic that says how to allow it, instead of a hint about a path.
- **Setup never leaves a stopped service behind.** It checks the service registration before it stops anything and starts the service again on every failure path; launchd stop and restart survive a long drain. The installer stays an upgrade command.
- **Agent changes to know about:** `vectory logs --json` prints one JSON object per line (use `--raw` for the raw lines), setup exits 130 when interrupted while it waits for the check-in, the packaged launchd plist is `io.vectory.agent.plist`, and a pre-release Vector such as 0.58.1-rc1 is refused up front.
- **The step after Applying is "Loading in Vector"**, not "Restarting Vector": Linux and macOS reload Vector in place (restarting only if the reload fails) and Windows restarts it. `vectory help` now lists exit code 78, and the Compose file makes the server wait for the validator's health check.

- **Device lists are lighter.** `GET /devices` and the Overview return list rows without the host runtime, the Vector log summary or per-component telemetry (about 80% smaller for a busy device); the device page still reads the full record.
- **The scheduler's cost no longer grows with history.** With two live rollouts on 20 devices a tick runs 17 queries whether none, 500 or 5,000 rollouts have finished (it used to run 965 at 500), and it rewrites nothing when nothing changed.
- **The anonymous rate limiter never refuses a new client because it is full.** It evicts the entry that expires soonest; installer, download, enrollment and invite traffic have their own partition and global per-minute caps, so it cannot crowd out sign-in.
- **Membership previews no longer queue behind heartbeats.** A busy server answers "Preview busy, retrying" and the dashboard retries quietly.
- **Revoking a device resolves its open issues** as revoked, so the Overview stops counting them.
- **Data-plane checks ignore a sample whose clock runs more than five minutes ahead**, instead of freezing evaluation until real time catches up.
- **The administrator's two-factor reset authenticates before it reads the request body**, and a rollout's device timeline shows each device's latest changes instead of the oldest 5,000 rows.
- **Upgrading:** migrations only go forward. An older server refuses a migrated database, so a downgrade means restoring a backup, and the first start after this release builds the telemetry index (slower on a large table).

### Documentation

- The Help center was reorganized around tasks: a quickstart, installing the server, connecting a device and deploying a first pipeline come first, followed by a security model and references for the agent CLI, server configuration, `vectory-admin` and ports.
- Repository copies of the guides became short pointers into the Help center, and internal evidence moved to `docs/internal/`.
- On phones, wide Help center tables stack into one labelled block per row.
- The API reference groups operations by resource and explains session authentication.
- `scripts/capture-screenshots.mjs` captures the product screenshots from the demo fleet.
