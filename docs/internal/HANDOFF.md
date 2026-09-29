# Vectory handoff

This report describes commit `a469266` (2026-09-29), version **0.1.0-dev**. Vectory is a developer preview: it is not production qualified and has no public release. The CI workflow `checks` passed all six jobs on that commit ([run #45](https://github.com/416rehman/Vectory/actions/runs/36617131583)). The requirement-by-requirement status, with the test behind each claim, is in [REQUIREMENTS.md](REQUIREMENTS.md). The earlier narrative handoff is kept as a historical record in [HANDOFF-2026-09-27.md](HANDOFF-2026-09-27.md); most of the evidence it names was never committed.

## What works, and what proves it

| Area | Evidence (what runs on every push unless stated) | Kind |
| --- | --- | --- |
| Control plane | `cargo test --locked` in the `server` job, including the native validator tests against the Vector 0.58.0 binary from the pinned `timberio/vector:0.58.0-debian` image | Unit, HTTP, native |
| Agent protocol security | [`tests/security/protocol_test.go`](../../tests/security/protocol_test.go), 21 subtests against the server built in the same job: TLS 1.2, an untrusted CA and a wrong host name refused; malformed, out-of-scope, exhausted and revoked tokens refused; CSR privileges overridden; one device from a duplicate-name race; cross-device artifact isolation; spoofed proxy headers; revocation on a reused connection | HTTP |
| Agent | `go test ./...` in the `agent` job on three operating systems with `VECTOR_TEST_BINARY` set: real validation, activation, drift repair, rollback, reload or restart, telemetry, secret rotation and full mode; plus `go vet` and `govulncheck` | Unit, native |
| Dashboard | `npm test` (Vitest unit tests), then 45 harness steps (41 scripts) against the production build: browser checks, most with synthetic API responses, and HTTP reviews against real server processes | Unit, browser, HTTP |
| Help center and accounts | `help-center/tests/ci.mjs` starts a fresh server and runs the public help checks and two Playwright specs (`help-center.spec.ts`, `account-lifecycle.spec.ts`) against it | Browser, HTTP |
| Operations | Backup and restore tests on a synthetic schema, release-verifier negative tests, `docker compose config`, and a build of both container images, in the `operational` job | Unit, build |
| The full loop on Linux | `node scripts/demo.mjs` runs real agents with real Vector 0.58.0 on synthetic data against a local server. The specification audit observed four such agents verified on their pipelines on 2026-09-29. Not automated | Manual |

## Tested platforms

| CI runner | Jobs | Versions |
| --- | --- | --- |
| `ubuntu-24.04` | `server`, `dashboard`, `agent`, `operational` | Rust 1.94.0; Go 1.26.8; Node 22 (major version pinned, patch as the runner resolves it); Python 3.13; Chromium as bundled with Playwright 1.63.0; Vector 0.58.0 (`x86_64-unknown-linux-gnu` archive checked by SHA-256 for the agent, digest-pinned image for the server) |
| `windows-2025` | `agent` | Go 1.26.8; Vector 0.58.0 `x86_64-pc-windows-msvc`, checked by SHA-256 |
| `macos-15` (Apple silicon) | `agent` | Go 1.26.8; Vector 0.58.0 `arm64-apple-darwin`, checked by SHA-256 |

Not tested by any workflow: the installers under systemd, launchd or the Windows Service Control Manager; reboot; agent or server upgrade; a Compose start; container isolation of the validator; the oldest OS versions; Linux on Arm64 hardware; Firefox and Safari. Minimums and the per-platform status are in [Compatibility](../user/compatibility.md).

## Capacity

Measured once, on 2026-09-26, with a debug build of the server (SHA-256 `68cb4de6…`; the source commit was not recorded) on a shared Windows 11 development host (AMD Ryzen 9 5950X, 16 cores, 128 GiB). Simulated authenticated agents over HTTP/2 for 70 seconds each, 60-second heartbeats with jitter: 100, 1,000 and 10,000 identities sent 115, 1,161 and 11,662 requests with no errors, p95 latency 8.6, 8.4 and 126.5 ms. It measured the heartbeat protocol only: no configuration churn, artifact downloads, native agents or rollout convergence, and SQLite lock waits were not instrumented. It predates later heartbeat and data-plane changes. **No fleet size is supported yet.** Details and the raw file: [CAPACITY.md](CAPACITY.md).

## Open defects

From the specification audit and the round-2 reviews, each re-checked against `a469266`. Severity follows the reviews: P0 breaks a hard requirement or a status claim, P1 misses a required capability or test.

| Sev. | Defect | Where |
| --- | --- | --- |
| P0 | For a server with a private CA, the generated Linux and macOS install command downloads the installer with `curl -k`. The page's SHA-256 check protects the bytes, but the specification forbids skipping certificate verification. | `dashboard/src/enrollmentCommands.ts` |
| P0 | The specification asks Add device for an explicit system-trust or CA-file choice with `--ca-file=`. The dashboard instead pins the server's CA automatically with `--ca-sha256`; the choice needs an owner decision (ADR 0010, proposed). | `dashboard/src/enrollmentCommands.ts` |
| P0 | Rollback is refused while a canary is in progress (`UNSAFE_SOURCE_REMOVAL`); the operator has to cancel the rollout first. | `server/src/rollback_review.rs` |
| P1 | The clean-install workflow (download, enroll, edit, publish, assign, activate, observe) is not automated; `tests/native-workflow.mjs` runs by hand. Compose has never been started by a workflow. `release-candidate.yml` has never run, so no package is built or installed by a workflow. | CI |
| P1 | Fault injection is missing for disk exhaustion, an interrupted download, a validation timeout, the proxy path and a real process kill at each journal boundary. | `agent/internal/agent` |
| P1 | Device-CA rotation is only a manual stopped-server overlap (`VECTORY_PREVIOUS_DEVICE_CA`), with no command and no test. | `server/src/crypto.rs` |
| P1 | Enrollment tokens have no preapproved-name list and no administrator-defined enrollment scope. The scheduled late-start deadline is fixed at one hour, and the outcome of cancel racing activation is undocumented. | `server/src/token_requests.rs`, `server/src/rollout.rs` |
| P1 | Adoption does not inventory or back up the running Vector's startup arguments and configuration files. | `agent/internal/agent/setup.go` |
| P1 | CI runs `go test` without `-json` or `-v`, so its log cannot show that each native test ran rather than skipped. | `.github/workflows/ci.yml` |
| P1 | First run: on a host without systemd, setup reports success and the device goes offline minutes later; a first version that fails to start is shown as "Its local config, from before Vectory"; delivery failures are invisible without a metrics exporter; Add device blocks a second install command until an already-used token is revoked. | agent `setup.go`, `reconcile.go`; `server/src/data_plane.rs`; `dashboard/src/enrollmentTokenRequests.ts` |
| P1 | Fleet scale: `GET /devices` has no paging, several pages download the whole fleet, and group membership checks are quadratic. The Overview and the rollout page disagree about a canary that applied but is not delivering. | `server/src/api.rs`, `dashboard/src` |
| P1 | Rollout wording and flow: rollback sentences name the wrong version, Needs you keeps resolved rollbacks for a day, redeploying after a rollback takes two conflict rounds, the publish review says "Checked" beside tests Vector refused (tests never gate publishing), and the Overview does not show what runs where. | `dashboard/src`, `server/src/api.rs` |
| P2 | Contract drift is not gated in CI; 37 of 60 browser harnesses and 12 of 14 Playwright specs, including the fleet-size and canvas-size checks, are outside CI; Unix settings access preservation, node-move digest stability and migration failure are untested; telemetry storage estimates are undocumented; creating an administrator needs no password re-entry. | various |

## Release prerequisites that need the maintainer

- **Signing identities:** a cosign key for `SHA256SUMS`, an Apple Developer ID and notarization account, and an Authenticode certificate. Until then every download stays labeled unsigned.
- **Publication:** approved names and hosts for the container images, the APT repository, the Homebrew tap and the MSI, after a check of the Vectory name and package namespaces.
- **A first `release-candidate.yml` run** on a protected CI identity, to produce the SBOM and provenance, and a review of the license inventory (`NOASSERTION` entries).
- **Policy:** a supported-version and deprecation schedule, and private vulnerability reporting switched on for the repository.
- **Test machines** for the oldest supported OS versions and Linux on Arm64, where hosted runners don't reach.
