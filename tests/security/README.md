# Independent checks

Scripts here test Vectory from outside its own test suites. They use synthetic data only, on disposable state: a real `vectory-server` on a temporary data folder and a loopback port, or the real dashboard in Chromium with intercepted transport. None touches a preview instance, a real account or a real device, and none needs credentials.

Scripts that write evidence take its path from an environment variable. Without it, the server checks, `schema-fixtures.mjs`, `schema-review.mjs` and `resource-race.mjs` write `docs/evidence/<name>.json`, a tracked folder, so set the variable when you run one by hand; the others write under `.local/`. CI writes under `artifacts/`.

Everything the older review process produced that no longer runs from a clean checkout is in `archive/`; its README says why and what covers the same guarantees now.

## Checks that start the server

Build the server first (`cargo build --manifest-path server/Cargo.toml --bin vectory-server`), then run from the repository root. Each script copies the binary to a temporary folder, seeds SQLite fixtures directly (with marker strings, so a leak of any secret is visible), drives the HTTP API, asserts exact response key sets, bounds and authorization, and removes the fixture. Evidence is written only when everything passed.

| Script | What it proves | Server override | Evidence variable | CI |
| --- | --- | --- | --- | --- |
| `account-review.mjs` | Staged sign-in with two-factor, account authorization by role, and password reset races. | `VECTORY_ACCOUNT_SERVER` | `VECTORY_ACCOUNT_EVIDENCE` | dashboard job |
| `pipeline-review.mjs` | Pipeline lifecycle authorization and immutable version history. | `VECTORY_PIPELINE_SERVER` | `VECTORY_PIPELINE_EVIDENCE` | dashboard job |
| `library-review.mjs` | The pipeline library is bounded and isolated: every field of a row has a type, a size limit and no secrets, including the versions that live devices run (`running_versions`); queries cannot reach other rows. | `VECTORY_LIBRARY_SERVER` | `VECTORY_LIBRARY_EVIDENCE` | dashboard job |
| `rollback-review.mjs` | Rollback priority and transaction boundaries. | `VECTORY_ROLLBACK_SERVER` | `VECTORY_ROLLBACK_EVIDENCE` | dashboard job |
| `deployment-history-review.mjs` | Deployment history is bounded and target-isolated: summaries, canary gate, target timelines, provenance, successors, sorting and group filters, every field typed, sized and free of secrets. It expects the current server's fields (`failure_stage`, `delivery`, the `measuring` and `degraded` gate reasons) and fails on an older build by design. | `VECTORY_DEPLOYMENT_HISTORY_SERVER` | `VECTORY_DEPLOYMENT_HISTORY_EVIDENCE` | dashboard job |
| `issue-review.mjs` | Issue acknowledgement authorization and transactions; rendered titles and messages come from codes and validated diagnostics, never from stored free text; `/issues/groups` is bounded; every projected field is typed and sized. | `VECTORY_ISSUE_SERVER` | `VECTORY_ISSUE_EVIDENCE` | dashboard job |
| `audit-order-review.mjs` | Durable audit chronology and migration boundaries. | `VECTORY_AUDIT_ORDER_SERVER` | `VECTORY_AUDIT_ORDER_EVIDENCE` | dashboard job |
| `audit-review.mjs` | Bounded audit queries and the private snapshot export lifecycle. | `VECTORY_AUDIT_SERVER` | `VECTORY_AUDIT_EVIDENCE` | dashboard job |
| `protocol_test.go` | Adversarial TLS and protocol checks on a native server with an ephemeral CA: `VECTORY_SECURITY_SERVER=$PWD/server/target/debug/vectory-server go test -v tests/security/protocol_test.go`. Skips without the variable. | `VECTORY_SECURITY_SERVER` | none | server job |
| `test_backup.py` | `deploy/backup.py`: a live WAL backup restores the database and keys with the generation intact, and a tampered backup is rejected. `python3 -m unittest discover -s tests/security -p 'test_*.py' -v` | none | none | operational job |

The default server is `server/target/debug/vectory-server` (with `.exe` on Windows). Add or change a projected field in the server and `library-review.mjs`, `deployment-history-review.mjs` or `issue-review.mjs` fails until its allowlist lists the new field; that is deliberate. When you add a field, add its type, its maximum length and a marker-based assertion that no secret can reach it, not only its name.

## Dashboard checks that need no server

These run the real React code in Chromium with synthetic transport. Install the browser once with `(cd dashboard && npx playwright install chromium)` and `npm ci` in `dashboard/`.

| Script | What it proves | How to run | Evidence variable | CI |
| --- | --- | --- | --- | --- |
| `resource-race.mjs` | The shared `useResource` hook ignores stale, slow and interleaved replies: the newest same-path reply wins, path changes hide old data, unmount stops work. | `node tests/security/resource-race.mjs` | `VECTORY_RESOURCE_RACE_EVIDENCE` | dashboard job |
| `resource-polling.mjs` | The same hook's 15 s polling and 30 s deadline with controlled timers: no overlapping reads, stalled headers and bodies time out and abort, reload cancels older reads, StrictMode keeps one request and one poll. | `node tests/security/resource-polling.mjs` | `VECTORY_RESOURCE_REPORT` | dashboard job |
| `schema-fixtures.mjs` | Representative Vector configurations validate against the pinned schema and survive a JSON round trip unchanged (34 probes). Set `VECTORY_TEST_VECTOR` to a Vector 0.58.0 binary to add three `vector validate --no-environment` probes. | `node tests/security/schema-fixtures.mjs` | `VECTORY_SCHEMA_FIXTURES_EVIDENCE` | dashboard job |
| `schema-review.mjs` | The schema controls lose no data: credentials stay references, durations stay numeric, map keys rename and duplicate with their values, list items keep their values and pending drafts through reordering, nullable values come back after null, hostile map keys stay own properties, read-only fields offer only View. | `node tests/security/schema-review.mjs` | `VECTORY_SCHEMA_REVIEW_EVIDENCE` | dashboard job |
| `lazy-page-recovery-review.mjs` | In the production build a missing, stalled or malicious page chunk leaves the shell usable, shows a recovery page with no raw payload, reloads only deliberately and never loops, and keeps unsaved editor work behind the leave guard. Serves `dashboard/dist`, so run `npm run build` in `dashboard/` first (10 groups, 4 Axe scans). | `node tests/security/lazy-page-recovery-review.mjs` | `VECTORY_LAZY_PAGE_OUTPUT` (a folder) | dashboard job |

## Device page reviews (Vite dev server, not in CI yet)

Four reviews of the device page and its dialogs, run against the real app under Vite with intercepted transport. Each loads the app once before its first group (the first load bundles dependencies and can take about half a minute on a cold cache), uses the shared cache in `dashboard/node_modules/.vite`, and writes a report and Axe-checked screenshots to its output folder (`.local/<name>-after` by default, set the variable to change it). A whole run takes one to two minutes. To run some groups, list their numbers: `VECTORY_DEVICE_IDENTITY_ONLY=5,6 node tests/security/device-identity-review.mjs`.

| Script | What it proves | Group filter and output variables | State |
| --- | --- | --- | --- |
| `device-identity-review.mjs` | The device page, its version and pipeline reads, its metrics and the selected-device banner never show or act on a reply that names another record; a wrong reply is an error with an exact retry; held reads cannot overwrite a newer route; roles and a changed account cannot reach device actions (13 groups, 4 Axe scans). | `VECTORY_DEVICE_IDENTITY_ONLY`, `VECTORY_DEVICE_IDENTITY_OUTPUT` | passes |
| `device-retry-context-review.mjs` | Retry application keeps its reviewed preconditions: one request per activation, old waits abort when permission, generation, pause, revocation or capability changes, an unknown reply keeps recovery read-only until a fresh status and an explicit retry, no automatic resend (14 groups, 4 Axe scans). | `VECTORY_DEVICE_RETRY_CONTEXT_ONLY`, `VECTORY_DEVICE_RETRY_CONTEXT_OUTPUT` | passes |
| `device-revocation-review.mjs` | Revoking a device identity reads the exact status first, confirms a lost reply from that status without a second request, keeps the reminder through a reload, and ignores held outcomes after a role, account or route change (15 groups). | `VECTORY_DEVICE_REVOCATION_ONLY`, `VECTORY_DEVICE_REVOCATION_OUTPUT` | 14 of 15: group 15 fails, see below |
| `device-recovery-request-review.mjs` | Authorize device recovery shows a token once, keeps an exact cancellation identity through lost replies, reloads and storage failures, and never resends creation (17 groups). | `VECTORY_DEVICE_RECOVERY_ONLY`, `VECTORY_DEVICE_RECOVERY_REQUEST_OUTPUT` | 16 of 17: group 16 fails, see below |

The two failing groups are a real defect, not stale expectations. With a 90-character unbroken device name the page scrolls sideways at 899 px wide (`scrollWidth` 910, and 900 for an 89-character name) and far more at 375 px, because the breadcrumb's `<nav>` is a flex item without `min-width: 0` and so never shrinks to the ellipsis that `.page-breadcrumb [aria-current="page"]` already provides. Reproduce with `VECTORY_DEVICE_REVOCATION_ONLY=15 node tests/security/device-revocation-review.mjs`. Add the four reviews to the dashboard job (with `working-directory: .` and their output variables under `artifacts/`) once that is fixed. Rerun them after any change to `DeviceDetail.tsx`, `TargetDialog.tsx` or the recovery dialogs: they name buttons, dialogs and copy exactly.

## Helper

`attempt-native.py` is a module and a command. `server/tests/*_native.py` and `agent/tests/native-upgrade.py` load it by path to start a disposable Rust server, a Go agent and the pinned Vector with fresh TLS and enrollment (`python3 tests/security/attempt-native.py --server <vectory-server> --agent <vectory> --vector <vector> --expect before|after|legacy --output <folder under .local>`). It needs Python's `cryptography` and `psutil`. Do not rename or move it.
