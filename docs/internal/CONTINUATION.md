# Continuing the work

Where Vectory stands, how to pick it up and what to do first, written so the next engineer can start without the conversation that produced it. Read [AGENTS.md](../../AGENTS.md) and the binding [product specification](../product-specification.md) first. Companion documents:

| Document | What it is |
| --- | --- |
| [WORK-QUEUE.md](WORK-QUEUE.md) | What to build or fix, in order, with scope and acceptance |
| [docs/security/OPEN-FINDINGS.md](../security/OPEN-FINDINGS.md) | Eleven open findings from an independent security review, each with its fix and test |
| [AUTHORING-GAPS.md](AUTHORING-GAPS.md) | What an operator still cannot do with Vector from Vectory, and the defects found while authoring |
| [REVIEW-PLAYBOOK.md](REVIEW-PLAYBOOK.md) | How to review a batch of changes with fresh eyes; run it at the end of each batch |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Each requirement of the specification, its status and the test behind it (checked by CI) |
| [HANDOFF.md](HANDOFF.md) | What works and what proves it, tested platforms, capacity, release prerequisites; it describes commit `a469266`, and the list below says what changed since |
| [CI.md](CI.md) | What each CI job proves and does not |

## State

The branch this file is on, version `0.1.0-dev`: a developer preview, not production qualified, with no public release. The requirements checklist reads 69 Met, 46 Partial, 0 Missing and 2 Unverified of 117 rows. Nothing is signed and nothing is published; the release prerequisites that need the maintainer are at the end of [HANDOFF.md](HANDOFF.md).

Landed since `a469266` (the details are in [CHANGELOG.md](../../CHANGELOG.md) and the user-facing [What's new](../user/whats-new.md)):

- **First run and install truth.** Setup says "Connected" only after a check-in. The install command never skips certificate checks: for a private CA it writes `vectory-ca.pem` and verifies against it, `--ca-sha256` pins it, `--ca-file` or the host's trust store are the alternatives, and Windows checks the download with `Get-FileHash`. `vectory allow` widens a restricted host's policy on that host. Enrollment tokens can bind a device name, list preapproved names and label devices; refused attempts say why.
- **Rollouts.** A live canary can be rolled back, lineage wording is consistent, a redeploy takes one conflict round, and Needs you drops resolved rollbacks. A canary has chosen devices, a watched delivery lane and an early release of the next stage. Publishing runs the pipeline's tests and refuses failing ones unless acknowledged. A device whose newest version failed but which still runs its previous one is held, not failed.
- **Fleet scale.** A paged, filterable device inventory read model, direct device lookup, member-free group reads and a slim Overview on the server; the dashboard reads a page at a time everywhere (picker, search, group editing, the deploy dialog, the command palette), says what it cannot measure, and shows what runs where.
- **Deploys in seconds.** A connected device is woken by `GET /agent/v1/wait` (the agent still opens every connection).
- **Operations.** Device CA rotation, a configurable late-start window for scheduled deployments, an all-at-once deployment to thousands of devices no longer stalls the server (assignment resolution borrowed instead of copying the deployment record per device), visible database load, and a capacity report of a release build at 10,000 simulated devices ([CAPACITY.md](CAPACITY.md)).
- **Agent.** Setup records and copies what an already-running Vector loads and stops for what it would not manage (`--adopt-existing` to proceed); an apply survives a full disk, a cut-off download, a validation timeout and a killed process with named findings; proxies are named; root commands keep the service's ownership.
- **CI and release.** A compose job starts the stack from the install guide and enrolls a device through the proxy; an end-to-end job runs the clean-install workflow on a fresh loopback instance; `release-candidate.yml` builds packages when dispatched (nothing is signed or published); `platforms.yml`, dispatched or on a change to its scripts, runs the agent as a real service on Linux, Windows and macOS and the dashboard in Firefox and WebKit. The proxy container keeps `NET_BIND_SERVICE` (Caddy's file capability fails under `cap_drop: ALL`) and has a health check.
- **Validator.** Sample tests keep Vector's stdin open until the last sample's output arrives; Vector dropped the in-flight events when stdin ended, so the last sample of a run lost its outputs about one run in a hundred.
- **Designed, not built.** Opt-in event sampling: [ADR 0011](../adr/0011-opt-in-event-sampling.md), [the plan](TAP-IMPLEMENTATION-PLAN.md) and the threat-model section.

**What was verified on this head, and what was not.** Run locally: `cargo fmt --check` and `cargo test --locked` (all 60 test binaries, native validator tests included, against Vector 0.58.0); agent `gofmt`, `go vet` for linux, darwin and windows, and `go test ./...` on Linux; dashboard `tsc -b`, `vitest run` (110 files, 1,301 tests) and Prettier; the doc-link, requirements and CI-table checks; contract regeneration with no drift; the help-center build; 25 browser harnesses (every one the recent merges touched, including `fleet-scale-browser` against a real server with 5,000 seeded devices) and the two device security harnesses. Not run locally: the independent protocol suite, the `end-to-end` and `compose` jobs, `help-center/tests/ci.mjs`, macOS and Windows. CI covered them in run 72, which passed.

## Your first hour

1. **Read** AGENTS.md, the specification, this file, then [WORK-QUEUE.md](WORK-QUEUE.md).
2. **Look at CI on the head of the branch** (workflow `checks`, [CI.md](CI.md) says what each job proves). Open a failing job's log before reading code. The last change to code (`b0349c3`, run 72) passed all nine jobs; every commit after it only edits documents. Two checks are flaky and failed in other runs of the same code (the first two items under "Known unstable or unproven"), so a red run on this code is not necessarily a regression.
3. **Set up the toolchain** from the table in [CONTRIBUTING.md](../../CONTRIBUTING.md) (Rust 1.94, Go 1.26.8, Node 22.12 or newer, Python 3.11 or newer) and put a checksum-verified Vector 0.58.0 under `.local/tools/` (the archive names and SHA-256 values are in `.github/workflows/ci.yml`; [docs/dev/DEVELOPMENT.md](../dev/DEVELOPMENT.md) explains the preview and the demo fleet).
4. **Run the fast checks** below on the checkout before changing anything, so you know what green looks like on your machine.
5. **Start the demo fleet** (`node scripts/demo.mjs --agents 4`; dashboard on `http://127.0.0.1:8080`, agent listener on `https://localhost:8443`, `--stop` stops it) and click through Overview, a device, a pipeline, a rollout. Every item in the queue is easier to judge after you have seen the product run.

## How to verify

Each command runs from the repository root unless it says otherwise. Set `VECTORY_TEST_VECTOR` (server) and `VECTOR_TEST_BINARY` (agent) to the Vector 0.58.0 binary so the native tests run instead of skipping.

| Area | Commands |
| --- | --- |
| Server | `cd server && cargo fmt --check && cargo test --locked --no-fail-fast` |
| Agent | `cd agent && gofmt -l . && GOOS=linux go vet ./... && GOOS=darwin go vet ./... && GOOS=windows go vet ./... && go test ./...` |
| Dashboard | `cd dashboard && npx tsc -b && npx vitest run && npx prettier --check src tests e2e` |
| Dashboard browsers | `cd dashboard && node tests/<name>-browser.mjs` (each harness serves the app with Vite and uses synthetic API replies; the list CI runs is in `.github/workflows/ci.yml`) |
| Independent protocol suite | build `server`, then `VECTORY_SECURITY_SERVER=<path to vectory-server> go test -v tests/security/protocol_test.go` |
| Contracts | `node contracts/generate.mjs` leaves no diff; `node tests/contracts.mjs` |
| Docs and records | `node scripts/check-doc-links.mjs`, `node scripts/check-requirements.mjs`, `node scripts/check-ci-table.mjs`, `node --test help-center/scripts/*.test.mjs` |
| Help center | `cd help-center && npm run build` (also checks the dashboard's links into it) |
| Capacity | `tests/load/README.md` |

A few security harnesses (`tests/security/*.mjs`) write `docs/evidence/*.json` when they pass. Do not commit stray evidence files from a local run.

**Playwright in a constrained container.** The harnesses call `chromium.launch()` with its defaults, so they need the Chromium build that the pinned Playwright expects. Where only another build is installed (the container this work was done in had one at `/opt/pw-browsers/chromium`, and downloading browsers was not allowed), run a harness with a small `node --require <preload>.cjs` file that patches `chromium.launch` to pass `executablePath` and sets `page.setDefaultNavigationTimeout` high, because on a loaded machine the first Vite compile of the whole app can outlast the default navigation timeout. Leave the assertion timeouts as the harness sets them. `scripts/capture-screenshots.mjs` takes `VECTORY_CHROMIUM` instead.

**Disk.** `server/target` is about 3 GB and `dashboard/node_modules` 0.6 GB; harness output accumulates under `.local/` (everything but `.local/tools` can be deleted). A worker that builds in its own checkout should delete `target/` when it finishes.

**No Docker.** The container this work was done in had no container runtime and none should be started there; the compose stack is exercised only by the `compose` job in CI.

## Known unstable or unproven

1. **The help-popover harness flakes** (`dashboard/tests/schema-control-browser.mjs`, the test named "help pointer hover and clicks close on departure and reopen without losing focus behavior"). In CI it failed in runs 65, 66 and 69 and passed in run 67, always at the same line: after the Close button was clicked, `help.focus()` on the trigger and `await expect(popup).toBeVisible()` times out, and the popup is not in the page at all. On the development machine it passed every time the whole file ran and failed only about once in 40 to 150 repetitions of this one test in a long browser session, so CI's browser (Playwright's own headless shell; the development container only had an older Chromium) behaves differently from it. Reproduce with the repeat knob:

   ```sh
   cd dashboard
   VECTORY_SCHEMA_TEST_FILTER="help pointer hover" VECTORY_SCHEMA_TEST_REPEAT=150 \
     node tests/schema-control-browser.mjs
   ```

   Root cause not found. Suspects, in order of likelihood, all in `dashboard/src/useHoverDisclosure.ts`:
   - `pointerFocus` is cleared by a 0 ms timer after `pointerdown`; if `help.focus()` lands first, `keyboardFocus` returns early, the mode stays "pointer", and the pending close timer closes the popup. Clear it on `pointerup` and `pointercancel` instead of by timer.
   - `pointerInside` is never reset when the popup unmounts under the pointer (no `pointerleave` fires for a removed node), so after clicking Close, `content` stays true: a later keyboard-opened popup does not close on blur until the pointer moves. This is a real defect whether or not it is the flake; reset both flags when the popup closes.
   - Chromium delivers a synthetic mouse move some time after layout changes under a stationary pointer (the popup unmounting), which can interleave with the harness's `focus()` calls.

   An earlier attempt to ignore stationary pointer enter and leave events broke the first hover step and was reverted. A later run of 400 repetitions with event tracing added to the hook (while other browsers were running) passed every round, so tracing perturbs the timing enough to hide the failure. The way to get a real answer is to look inside a failing CI run: add a trace of the hook's handlers (enter, leave, pointerdown, focus, the close timer, every update and close, with timestamps) to `window`, print it from the harness's failure handler, and put the file first in the `dashboard-browsers` job (it needs about eight minutes to start, against the 25 minutes the job takes to reach it). Throttling the page's CPU sixfold through the DevTools protocol (`Emulation.setCPUThrottlingRate`) for 200 repetitions did not reproduce it either, so what CI's browser does differently is probably not speed: use the same Chromium build as CI (Playwright's own headless shell) when trying to reproduce it. Fix the hook so its state does not depend on timer ordering; do not retry, skip or quarantine the test.
2. **An account e2e spec flakes.** `dashboard/e2e/account-lifecycle.spec.ts`, "administrator access changes use current revisions and public password reset links work once", failed in CI runs 67 and 71 and passed in the others, always at its last sign-in step: `login(publicPage, target, target.password, 401)` after "Back to sign in" gets a 400 where it expects 401. The sign-in form checks the email itself before it sends anything, and the server answers 400 only for an empty password (`db::string` refuses it), so the form submitted an empty password state right after the harness had filled it. Something clears or recreates the form after `toSignIn()` in `dashboard/src/AuthScreen.tsx` (its `setPassword("")`, the two `requestAnimationFrame` focus calls, and the `hashchange` that `toSignIn()` causes by restoring the route are the places to look), and a slow runner lets it land after the fill. If it is a real loss of typed input it is a product defect; either way the helper should wait for the sign-in heading before filling. The error context of the failing run (`artifacts/help-account-ci/contextual-artifacts/...`) is uploaded as a CI artifact.
3. **Not run on macOS or Windows by hand.** The agent's macOS fallback for reading a running Vector's environment and launchd jobs is covered only by the macOS CI job; the Windows installer, service and Add device command have never run under PowerShell outside CI's Go tests.
4. **Never exercised by a workflow:** reboot, agent or server upgrade, container isolation of the validator, the oldest supported OS versions, Linux on Arm64 hardware, Safari itself, and `release-candidate.yml` (it has never run). `platforms.yml` exercises the installers under systemd, launchd and the Windows Service Control Manager and the dashboard in Firefox and WebKit, but it has not yet been recorded green: until it is, treat those as unverified.
5. **Capacity figures** come from a release build on a shared 4-vCPU virtual machine with simulated devices: about 170 check-ins a second for unassigned devices, 140 to 160 for assigned ones with the single writer 97% busy, p99 1.5 to 3 s, peak RSS about 1.0 GiB, telemetry about 755 bytes a row. The 80 a second planning figure is derived, not measured. No fleet size is supported yet.

## Definition of done for a piece of work

- Tests for the new logic at the level that fits (vitest, `cargo test`, `go test`, a Playwright harness, the protocol suite for anything on the agent listener); the full checks of every area you touched.
- A wire or route change updates `contracts/CONTRACT.md` and `contracts/generate.mjs`, then `node contracts/generate.mjs` regenerates `openapi.json` and `protocol.schema.json`.
- User documentation in `docs/user/` and a `CHANGELOG.md` line in the same change, with no stale statements ([docs/dev/WRITING.md](../dev/WRITING.md) is the style guide). Never claim a state the server did not verify; a file write or a download is never reported as verified activation.
- Real data only in the ordinary product. The demo fleet is explicitly synthetic and labeled so; a simulated "applied" is never evidence.
- Screenshots of every visible change in light, dark and 390 px, looked at; a rehearsal on a live preview with the demo fleet.
- New CI harnesses are added to `.github/workflows/ci.yml` with `timeout-minutes` and listed in [CI.md](CI.md); `node scripts/check-ci-table.mjs` passes.
- At the end of a batch, run [the review playbook](REVIEW-PLAYBOOK.md) and fix what it finds.

## Writing rules for the repository

Text in the repository (code, comments, tests, test names, docs, the changelog and commit messages) says what the product does and why, on its own merits. It does not name who asked for something, review rounds, work-package identifiers, conversations or other products used as inspiration, and it does not carry business context. Commit messages carry at most one attribution trailer and no session or chat links.
