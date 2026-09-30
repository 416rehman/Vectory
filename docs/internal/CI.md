# What CI proves

Each automated job, what a green run shows, and what it does not. The job lists match `.github/workflows/`; `node scripts/check-ci-table.mjs` fails when they drift.

## ci.yml

Runs on every push and pull request.

| Job | Runs | A green run shows | It does not show |
| --- | --- | --- | --- |
| `server` | Cargo tests, the validator tests against Vector 0.58.0 copied from the pinned image, the cargo-audit gate, and the adversarial TLS and protocol suite against the built server | Server logic, migrations and validation with real Vector; TLS and protocol negatives on a real binary | A release build, Compose, or behaviour under load |
| `dashboard` | Vitest, Prettier, drift checks of generated files and contracts, the Markdown link check and the requirements checklist check, help checks, 23 browser harnesses, the isolated server reviews and the help and account specs on a disposable server | UI logic and flows in real React; authorization and bounds over real HTTP | Most harnesses answer from an intercepted synthetic API; no agents or TLS listener |
| `agent` | Go tests on ubuntu-24.04, windows-2025 and macos-15 with the official Vector 0.58.0 (SHA-256 pinned), a check of the `go test -json` stream, vet and govulncheck | Every native test ran and passed on each OS; the stream and a per-OS table in the job summary are kept; only the documented Windows reload skip is allowed | Service managers, reboot, upgrade, proxies or the oldest supported OS versions |
| `operational` | Python backup and VRL-list tests, release verifier regressions, `docker compose config`, image builds | Backups restore and reject tampering; the images build | That the images start: see `compose` |
| `end-to-end` | A fresh loopback instance (`scripts/preview.sh`, real validator) with `tests/native-workflow.mjs`, `scripts/check-installer.mjs`, `tests/contracts.mjs`, four dashboard specs and `tests/templates.mjs` | Section 15's first test on Linux with real Vector: first administrator, agent download checked by SHA-256, install, enroll over verified TLS, publish, assign, verified apply, drift repair, pause and resume, metrics, device secret rotation; the one-command installer; live API responses match the shared schemas; a 201-component pipeline loads; every starter validates | Compose or the TLS proxy (it is a development instance), service managers, other operating systems, long-running operation |
| `compose` | `docs/user/install-server.md` on one runner: a private CA, protected secret files, `.env`, build, `up --wait`, the first administrator, a device enrolled with the installer through the published agent port, and probes from inside the validator | The quickstart works as written; health checks pass; the image's bundled agent installs; the validator has no network route (resolved configuration, a refused connection and a failed name lookup) | Upgrades, backup and restore in containers, a public CA, production networking |
| `dashboard-browsers` | 40 more browser harnesses, each green locally before it was added; `scripts/check-ci-table.mjs` | The same as the dashboard job's harnesses; this page names every job | Anything about the server: their transport is synthetic |

## release-candidate.yml

Runs only when dispatched; [packaging/README.md](../../packaging/README.md#release-candidate-workflow) has the command. Nothing is signed or published.

| Job | A green run shows | It does not show |
| --- | --- | --- |
| `agents` | The five agents build statically; archives, catalog and checksums verify; `.deb` and `.rpm` build with the pinned nfpm | Native behaviour on each OS |
| `packages` | The `.deb` and `.rpm` install, run and remove on Debian 12 and AlmaLinux 9 without creating an account or state | Service start under systemd, upgrades, running the arm64 build |
| `msi` | The MSI installs silently, the agent runs, no service is registered, removal cleans up | Signing, upgrades, service registration |
| `images` | Both images build, run as UID 10001 and 10002, and refuse to start without their safety settings; SPDX SBOMs of both | A vulnerability verdict: the SBOMs are its input |
| `sbom` | CycloneDX SBOMs of the Rust, Go and npm dependencies and a license inventory | License clearance |
| `assemble` | One verified folder with `SHA256SUMS` and `CANDIDATE.json`, including whether the image's agents are byte-identical to the release agents | Signatures or provenance |
| `attest` | GitHub build provenance for `SHA256SUMS`, only with `attest` and a configured `release` environment | Anything about the candidate's contents |

## Kept out of CI

| Check | Why |
| --- | --- |
| `tests/editor-connections-browser.mjs` | Waits for autosave; the editor now saves on an explicit Save. Needs updating. |
| `tests/catalog.mjs` | Rewrites the tracked `vector-catalog/catalog.json`, and its labels differ from the committed file. Decide which is right, then make it a check. |
| `tests/fleet-browser.mjs` | Written for Windows (`vectory-server.exe`, a `python` command). |
| `tests/initialize-preview.mjs` | A helper for a preview on port 8080, not a check. |
| `dashboard/e2e`: accessibility, audit-history, catalog, deployment-history, editor-details, pipeline-lifecycle, security-actions, workflows | Fail against a fresh instance at 7ae722d: they wait for autosave, look for the Overview's former "Needs attention" heading, expect older copy, or assume one pipeline and fixed data. They need a fixture dataset and updating. |
| `server/tests/*_native.py`, `agent/tests/native-upgrade.py` | Native scenarios that need extra Python packages; the upgrade test needs Windows. |
| `tests/load` | Capacity measurements, not a pass or fail check. |
