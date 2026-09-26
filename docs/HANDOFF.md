# Vectory implementation handoff

Delivered 2026-09-26 as **0.1.0-dev**. This is an integrated development product, with real native Windows execution and an original dashboard inspired by Base44. It is not production qualified.

## Open the product

The current local demonstration is running at **http://127.0.0.1:8080**. Its generated administrator credentials are in the private, ignored `.local/preview/credentials.json`. A synthetic native agent remains running; its exact PID, executable and paths are recorded in `.local/preview/native-run.json`. No OS service or system trust-store entry was installed. Follow [LOCAL-DEMO.md](LOCAL-DEMO.md) to reproduce or stop the isolated fixture safely.

![Real dashboard with explicitly synthetic integration fixtures](screenshots/overview.png)

The dashboard includes fleet and device details, real telemetry/history, enrollment/downloads, static groups, a visual/code pipeline editor, immutable versions and diffs, target previews, conflicts/priorities, schedules, canaries, policies, recovery, issues, audits, users/MFA and instance settings. Light/dark themes, mobile navigation, keyboard alternatives and accessible dialogs are included. It uses the Rust API and SQLite; ordinary product views contain no hardcoded fleet data.

The Go agent uses outbound verified TLS/mTLS, signed device-bound manifests, monotonic generations, local capability restrictions, actual-file drift checks, journaled apply/rollback, local and remote pause, protected device-local secret references and tracked rotation. Actual Vector startup and liveness are required for verified application. Vector is not silently installed or upgraded.

## Executed verification

Native host: **Windows 11 Pro 10.0.26200 amd64**. Toolchains: **Go 1.26.8, Rust 1.94.0, Node 22.20.0**. The independently checksum-verified Vector version is **0.58.0**. Dashboard dependencies include **React 19.3.0, TypeScript 5.9.3 and Vite 7.3.6**; exact dependencies are locked.

- 24 backend tests and 21 independent real-TLS security subtests passed. Go tests, native Vector integration and `go vet` passed.
- The downloadable Windows `0.1.0-dev` artifact passed the full native workflow, including real receiver-observed credential rotation. Its SHA256 is `992da460f0bc448862e7585085790cf11161f401805495a2a8c776948d2a718b`.
- Ten real-server browser tests, six graph unit tests, six focused resource-race checks, 13 actual Vector catalog validations, and 112 persisted response-schema checks passed. Automated accessibility checks found no violations in the tested views.
- A 1,000-row synthetic fleet and 201-component persisted canvas passed actual UI workflows. A 32-second control-plane outage preserved the supervised Vector process, file hash and generation; reconnection took four seconds.
- A separate short HTTP/2 protocol simulation reached all 10,000 identities with zero request errors across 11,662 requests; p95 was 126.525 ms. It used an earlier recorded server build on shared hardware, without native Vector rollout. The earlier HTTP/1.1 failure remains documented. These measurements do not establish a supported fleet size.

See [ACCEPTANCE.md](ACCEPTANCE.md), [CAPACITY.md](CAPACITY.md), [agent evidence](../agent/TEST-EVIDENCE.md) and the raw `docs/evidence/` reports for scope, timestamps and limitations.

## Distribution and remaining gates

Source, migrations, generated OpenAPI/JSON Schema, Compose configuration, CI, service adapters, backup/restore tools and operational/security guides are included. Five unsigned agent binaries and offline archives, checksums, dependency SPDX inventory and local source-byte inventory are in `artifacts/releases/`. Same-host repeat builds matched binary/archive bytes. Linux ELF checks found no dynamic libc dependency. Non-Windows outputs are build-only; Intel macOS has no compatible upstream Vector 0.58 distribution.

Production release requires an available Docker engine for clean build/start and hostile-worker isolation tests; native Linux/macOS and oldest-OS environments; controlled privileged service install/reboot/upgrade checks; signing and publication identities; independent-builder reproducibility; and sustained load, long-outage and physical-fault testing. The local Docker Linux engine was unavailable. CI definitions are prepared, but remote CI execution is not claimed.

Remaining implementation hardening includes a separate OS identity for the Vector child, broader process CPU/RSS telemetry, and macOS helper-orphan handling under forced termination. Windows exporter CPU/RSS values remain explicitly unavailable. Local file/network allowlists are not a complete OS sandbox. Read [SECURITY-REVIEW.md](SECURITY-REVIEW.md), [THREAT-MODEL.md](THREAT-MODEL.md) and [COMPATIBILITY.md](COMPATIBILITY.md) before deployment. No release signatures, public packages or external deployment were created.

Start with [README](../README.md), [Compose quickstart](QUICKSTART.md), [agent installation](AGENT-INSTALL.md) and [backup/restore](BACKUP-RESTORE.md).
