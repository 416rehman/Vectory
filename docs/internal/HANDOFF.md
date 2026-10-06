# Vectory status at `a469266` (historical)

This historical report describes commit `a469266` (2026-09-29), version **0.1.0-dev**. At that point Vectory was a developer preview, not production qualified, with no public release. The CI workflow `checks` passed all six jobs on that commit ([run #45](https://github.com/416rehman/Vectory/actions/runs/36617131583)). For current requirement statuses and release gates, see [REQUIREMENTS.md](REQUIREMENTS.md) and [RELEASE-0.1.md](RELEASE-0.1.md#gates).

> **Current state.** Work has landed since `a469266`. [CONTINUATION.md](CONTINUATION.md) explains the current checkout and how to verify it. The tables and prerequisites below are historical; several listed defects have since been fixed, and the unsigned release-candidate and platform workflows passed at `a012c1e`. Current open work is in [the release gates](RELEASE-0.1.md#gates), [WORK-QUEUE.md](WORK-QUEUE.md), [the security findings](../security/OPEN-FINDINGS.md) and [AUTHORING-GAPS.md](AUTHORING-GAPS.md).

## What works, and what proves it

| Area | Evidence (what runs on every push unless stated) | Kind |
| --- | --- | --- |
| Control plane | `cargo test --locked` in the `server` job, including the native validator tests against the Vector 0.58.0 binary from the pinned `timberio/vector:0.58.0-debian` image | Unit, HTTP, native |
| Agent protocol security | [`tests/security/protocol_test.go`](../../tests/security/protocol_test.go), 24 subtests and a CA-rotation test against the server built in the same job: TLS 1.2, an untrusted CA and a wrong host name refused; malformed, out-of-scope, exhausted and revoked tokens refused; CSR privileges overridden; one device from a duplicate-name race; cross-device artifact isolation; spoofed proxy headers; revocation on a reused connection | HTTP |
| Agent | `go test ./...` in the `agent` job on three operating systems with `VECTOR_TEST_BINARY` set: real validation, activation, drift repair, rollback, reload or restart, telemetry, secret rotation and full mode; plus `go vet` and `govulncheck` | Unit, native |
| Dashboard | `npm test` (Vitest unit tests), then 45 harness steps (41 scripts) against the production build: browser checks, most with synthetic API responses, and HTTP reviews against real server processes | Unit, browser, HTTP |
| Help center and accounts | `help-center/tests/ci.mjs` starts a fresh server and runs the public help checks and two Playwright specs (`help-center.spec.ts`, `account-lifecycle.spec.ts`) against it | Browser, HTTP |
| Operations | Backup and restore tests on a synthetic schema and (in the `server` job) on a real migrated database, release-verifier negative tests, `docker compose config`, and a build of both container images, in the `operational` job | Unit, build |
| The full loop on Linux | `node scripts/demo.mjs` runs real agents with real Vector 0.58.0 on synthetic data against a local server. The specification audit observed four such agents verified on their pipelines on 2026-09-29. Not automated | Manual |

## Tested platforms

| CI runner | Jobs | Versions |
| --- | --- | --- |
| `ubuntu-24.04` | `server`, `dashboard`, `agent`, `operational` | Rust 1.94.0; Go 1.26.8; Node 22 (major version pinned, patch as the runner resolves it); Python 3.13; Chromium as bundled with Playwright 1.63.0; Vector 0.58.0 (`x86_64-unknown-linux-gnu` archive checked by SHA-256 for the agent, digest-pinned image for the server) |
| `windows-2025` | `agent` | Go 1.26.8; Vector 0.58.0 `x86_64-pc-windows-msvc`, checked by SHA-256 |
| `macos-15` (Apple silicon) | `agent` | Go 1.26.8; Vector 0.58.0 `arm64-apple-darwin`, checked by SHA-256 |

Not tested by any workflow: the installers under systemd, launchd or the Windows Service Control Manager; reboot; agent or server upgrade; a Compose start; container isolation of the validator; the oldest OS versions; Linux on Arm64 hardware; Firefox and Safari. Minimums and the per-platform status are in [Compatibility](../user/compatibility.md).

## Capacity

Measured on 2026-09-29 and 30 with a release build on a shared 4-vCPU Linux VM that also ran the load generator, with simulated devices. 10,000 devices checking in every minute without assignments reached about 170 check-ins a second, with the single database writer half busy and a median per-second p99 latency of 34 ms. With all 10,000 devices in an all-at-once deployment the writer saturates at 140 to 160 check-ins a second: p99 1.5 to 3 seconds, and the excess is refused with HTTP 503 and retried. The deployment request held the writer for about 20 seconds, and 90% of the targets had verified after about ten minutes. The run found and fixed a memory blow-up (a deployment to 10,000 listed devices needed more than 11 GiB); it did not run native agents or Vector, and 100 and 1,000 devices were not measured again. About 80 check-ins a second with assignments is a planning figure derived from those runs, not a measurement. **No fleet size is supported yet.** Details and the raw files: [CAPACITY.md](CAPACITY.md).

## Open defects at `a469266`

From an audit against the specification and from independent reviews. Each was re-checked against `a469266`; defects fixed on the branch since then are removed (the install command's `curl -k`, the missing trust choice, rollback during a canary, an unautomated clean install and `go test` without `-json`). Severity: P0 breaks a hard requirement or a status claim, P1 misses a required capability or test.

| Sev. | Defect | Where |
| --- | --- | --- |
| P1 | `release-candidate.yml` has never run, so no package is built or installed by a workflow. The `compose` job starts the stack in CI: on its first run all three services were healthy and the validator had no route to the internet, but its request to the proxy was refused in the first second and now retries, so the job has not yet passed. | CI |
| P1 | Fault injection is missing for disk exhaustion, an interrupted download, a validation timeout, the proxy path and a real process kill at each journal boundary. | `agent/internal/agent` |
| P1 | Adoption does not inventory or back up the running Vector's startup arguments and configuration files. | `agent/internal/agent/setup.go` |
| P1 | First run: on a host without systemd, setup reports success and the device goes offline minutes later; a first version that fails to start is shown as "Its local config, from before Vectory"; delivery failures are invisible without a metrics exporter; Add device blocks a second install command until an already-used token is revoked. | agent `setup.go`, `reconcile.go`; `server/src/data_plane.rs`; `dashboard/src/enrollmentTokenRequests.ts` |
| P1 | Fleet scale: `GET /devices` has no paging, several pages download the whole fleet, and group membership checks are quadratic. The Overview and the rollout page disagree about a canary that applied but is not delivering. | `server/src/api.rs`, `dashboard/src` |
| P1 | Rollout wording and flow: rollback sentences name the wrong version, Needs you keeps resolved rollbacks for a day, redeploying after a rollback takes two conflict rounds, the publish review says "Checked" beside tests Vector refused (tests never gate publishing), and the Overview does not show what runs where. | `dashboard/src`, `server/src/api.rs` |
| P2 | Contract drift is not gated in CI; 37 of 60 browser harnesses and 12 of 14 Playwright specs, including the fleet-size and canvas-size checks, are outside CI; Unix settings access preservation is untested; creating an administrator needs no password re-entry. | various |

## Release prerequisites identified at `a469266` (historical)

- **Signing identities:** a cosign key for `SHA256SUMS`, an Apple Developer ID and notarization account, and an Authenticode certificate. Until then every download stays labeled unsigned.
- **Publication:** approved names and hosts for the container images, the APT repository, the Homebrew tap and the MSI, after a check of the Vectory name and package namespaces.
- **A first `release-candidate.yml` run** on a protected CI identity, to produce the SBOM and provenance, and a review of the license inventory (`NOASSERTION` entries).
- **Policy:** a supported-version and deprecation schedule, and private vulnerability reporting switched on for the repository.
- **Test machines** for the oldest supported OS versions and Linux on Arm64, where hosted runners don't reach.
