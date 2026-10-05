# Continuing the work

Where Vectory stands, how to pick it up and what to do first, written so that a new contributor can start from the repository alone. Read [AGENTS.md](../../AGENTS.md) and the binding [product specification](../product-specification.md) first. Companion documents:

| Document | What it is |
| --- | --- |
| [WORK-QUEUE.md](WORK-QUEUE.md) | What to build or fix, in order, with scope and acceptance |
| [docs/security/OPEN-FINDINGS.md](../security/OPEN-FINDINGS.md) | Current open security findings, proposed fixes and residual risks |
| [AUTHORING-GAPS.md](AUTHORING-GAPS.md) | What an operator still cannot do with Vector from Vectory, and the defects found while authoring |
| [REVIEW-PLAYBOOK.md](REVIEW-PLAYBOOK.md) | A checklist for reviewing a batch of changes, by area; run it at the end of each batch |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Each requirement of the specification, its status and the test behind it (checked by CI) |
| [HANDOFF.md](HANDOFF.md) | Historical status and prerequisites at `a469266`; use this file and the release gates for the current state |
| [CI.md](CI.md) | What each CI job proves and does not |

## State

This file records the work toward version `0.1.0`: an unsigned developer preview, not production qualified. The requirements checklist reads 80 Met, 42 Partial, 0 Missing and 0 Unverified of 122 rows. The runnable candidate at `74dacc7` passed the [checks, platforms and unsigned-candidate workflows](RELEASE-REVIEW-0.1.md); use the [release gates](RELEASE-0.1.md#gates) for later branch-head evidence and publication status. Agent updates ([ADR 0015](../adr/0015-operator-issued-agent-updates.md)) are built, and a real service of each operating system takes, tries and takes back a build in CI ([RELEASE-0.1.md](RELEASE-0.1.md), gate 8). Release artifacts remain unsigned; the publication procedure and remaining maintainer steps are in [RELEASE-0.1.md](RELEASE-0.1.md#publication-maintainer-steps) and [packaging/README.md](../../packaging/README.md).

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

**Earlier local verification at `b0349c3`, not the current release head.** Run locally: `cargo fmt --check` and `cargo test --locked` (all 60 test binaries, native validator tests included, against Vector 0.58.0); agent `gofmt`, `go vet` for linux, darwin and windows, and `go test ./...` on Linux; dashboard `tsc -b`, `vitest run` (110 files, 1,301 tests) and Prettier; the doc-link, requirements and CI-table checks; contract regeneration with no drift; the help-center build; 25 browser harnesses (every one the recent merges touched, including `fleet-scale-browser` against a real server with 5,000 seeded devices) and the two device security harnesses. Not run locally: the independent protocol suite, the `end-to-end` and `compose` jobs, `help-center/tests/ci.mjs`, macOS and Windows. CI covered them in run 72, which passed.

## Your first hour

1. **Read** AGENTS.md, the specification, this file, then [WORK-QUEUE.md](WORK-QUEUE.md).
2. **Look at CI on the head of the branch** (workflow `checks`, [CI.md](CI.md) says what each job proves). Open a failing job's log before reading code. The [release review](RELEASE-REVIEW-0.1.md) records the green nine-job checks, native platform and unsigned-candidate workflows at `74dacc7`; check the [release gates](RELEASE-0.1.md#gates) and newer head runs before relying on them. Investigate any new failure on its own evidence.
3. **Set up the toolchain** from the table in [CONTRIBUTING.md](../../CONTRIBUTING.md) (Rust 1.94, Go 1.26.8, Node 22.12 or newer, Python 3.11 or newer) and put a checksum-verified Vector 0.58.0 under `.local/tools/` (the archive names and SHA-256 values are in `.github/workflows/ci.yml`; [docs/dev/DEVELOPMENT.md](../dev/DEVELOPMENT.md) explains the preview and the demo fleet).
4. **Run the fast checks** below on the checkout before changing anything, so you know what green looks like on your machine.
5. **Start the demo fleet** (`node scripts/demo.mjs --agents 4`; dashboard on `http://127.0.0.1:8080`, agent listener on `https://127.0.0.1:8443`, `--stop` stops it) and click through Overview, a device, a pipeline, a rollout. Every item in the queue is easier to judge after you have seen the product run.

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
| Docs and records | `node scripts/check-doc-links.mjs`, `node scripts/check-requirements.mjs`, `node scripts/check-ci-table.mjs`, `node scripts/check-writing-rules.mjs`, `node --test scripts/*.test.mjs help-center/scripts/*.test.mjs` |
| Help center | `cd help-center && npm run build` (also checks the dashboard's links into it) |
| Capacity | `tests/load/README.md` |

A few security harnesses (`tests/security/*.mjs`) write `docs/evidence/*.json` when they pass. Do not commit stray evidence files from a local run.

**Playwright in a constrained container.** The harnesses call `chromium.launch()` with its defaults, so they need the Chromium build that the pinned Playwright expects. Where only another build is installed (for example a container without network access that ships Chromium under `/opt/pw-browsers`), run a harness with a small `node --require <preload>.cjs` file that patches `chromium.launch` to pass `executablePath` and sets `page.setDefaultNavigationTimeout` high, because on a loaded machine the first Vite compile of the whole app can outlast the default navigation timeout. Leave the assertion timeouts as the harness sets them. `scripts/capture-screenshots.mjs` takes `VECTORY_CHROMIUM` instead.

**Disk.** `server/target` is about 3 GB and `dashboard/node_modules` 0.6 GB; harness output accumulates under `.local/` (everything but `.local/tools` can be deleted). A scratch checkout that builds should delete `target/` when it finishes.

**No container runtime needed.** The compose stack is exercised only by the `compose` job in CI; everything else here runs without one.

## Known limits and earlier browser flakes

The help-popover and account sign-in focus flakes recorded in earlier versions of this guide were fixed in `334a013`, with deterministic regression tests. The `dashboard` and `dashboard-browsers` jobs passed at the reviewed `74dacc7` candidate. A new failure still needs its own diagnosis; see the [release gates](RELEASE-0.1.md#gates) for later head qualification.

1. **Mac and Windows have not been checked by hand.** The macOS launchd and Windows service, installer and Add device paths ran in the native `platforms.yml` jobs at `74dacc7`; test on the oldest supported operating systems before claiming broader support.
2. **Workflow gaps remain.** Reboot, server upgrade, package-managed agent upgrade, the oldest supported OS versions, Linux on Arm64 hardware and Safari itself have not been exercised. At `74dacc7`, the `platforms.yml` jobs exercised a real service updating its agent on Linux, macOS and Windows, the `compose` job checked the validator container network boundary, and the unsigned candidate built and verified. See the [release gates](RELEASE-0.1.md#gates) for later branch-head qualification.
3. **Capacity figures** come from a release build on a shared 4-vCPU virtual machine with simulated devices: about 170 check-ins a second for unassigned devices, 140 to 160 for assigned ones with the single writer 97% busy, p99 1.5 to 3 s, peak RSS about 1.0 GiB, telemetry about 755 bytes a row. The 80 a second planning figure is derived, not measured. No fleet size is supported yet.

## Definition of done for a piece of work

- Tests for the new logic at the level that fits (vitest, `cargo test`, `go test`, a Playwright harness, the protocol suite for anything on the agent listener); the full checks of every area you touched.
- A wire or route change updates `contracts/CONTRACT.md` and `contracts/generate.mjs`, then `node contracts/generate.mjs` regenerates `openapi.json` and `protocol.schema.json`.
- User documentation in `docs/user/` and a `CHANGELOG.md` line in the same change, with no stale statements ([docs/dev/WRITING.md](../dev/WRITING.md) is the style guide). Never claim a state the server did not verify; a file write or a download is never reported as verified activation.
- Real data only in the ordinary product. The demo fleet is explicitly synthetic and labeled so; a simulated "applied" is never evidence.
- Screenshots of every visible change in light, dark and 390 px, looked at; a rehearsal on a live preview with the demo fleet.
- New CI harnesses are added to `.github/workflows/ci.yml` with `timeout-minutes` and listed in [CI.md](CI.md); `node scripts/check-ci-table.mjs` passes.
- At the end of a batch, run [the review playbook](REVIEW-PLAYBOOK.md) and fix what it finds.

## Writing rules for the repository

Text in the repository (code, comments, tests, test names, docs, the changelog and commit messages) says what the product does and why, on its own merits. `node scripts/check-writing-rules.mjs` checks the mechanical part in CI; scripts/writing-rules-allow.json lists the few exceptions, each with its reason. Commit messages say what changed and why, and carry at most one attribution trailer.
