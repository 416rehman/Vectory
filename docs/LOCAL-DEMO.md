# Isolated local demonstration and integration tests

This development workflow is for the current Windows checkout. It creates private `.local/` state, uses synthetic `demo_logs`, and does not change OS trust or register services. Production installation uses [Compose with verified HTTPS](QUICKSTART.md), not development cookies.

Prerequisites: Node.js 22/npm, Rust 1.94+, pinned Go 1.26.8 (Go can fetch the declared toolchain), and a separately obtained, checksum-verified **Vector 0.58.0** Windows executable. Put the latter at `.local/tools/vector-0.58.0/bin/vector.exe`. Verify the official distribution before executing it; see [acceptance evidence](ACCEPTANCE.md). Never use an unknown binary for adoption.

From the repository root, in PowerShell:

```powershell
Push-Location dashboard
npm ci
npm run build
npm exec playwright -- install chromium
Pop-Location
Push-Location server
cargo build --locked
Pop-Location
Push-Location agent
go build -trimpath -o vectory.exe ./cmd/vectory
Pop-Location
go run packaging/dev-pki/main.go --out .local/pki --hosts localhost,127.0.0.1,::1
./packaging/Start-LocalPreview.ps1
node tests/initialize-preview.mjs
node tests/native-workflow.mjs
```

The PKI generator requires a new destination. Preserve an existing local CA/state between runs; do not overwrite trust under an already enrolled device. `Start-LocalPreview.ps1` serves the built dashboard at **http://127.0.0.1:8080** and a verified agent TLS listener at **https://localhost:8443**. The local admin email is `operator@vectory.local`; its generated random password remains in `.local/preview/credentials.json` and is never a committed/default password. This file, bootstrap secret, test CA key and device state must remain private.

The native workflow creates a new explicit synthetic device/configuration, publishes and targets it, starts the agent in a path containing spaces, verifies actual Vector activation and exact artifact hash, repairs drift, tests local pause, then resumes. It also reads actual Vector component metrics through an explicitly permitted loopback exporter, creates a private synthetic credential file, verifies device-local secret substitution and rotation against a temporary loopback HTTP receiver, checks that those values never appear in server responses, and restores the console pipeline. It leaves the synthetic daemon running for dashboard inspection; `.local/preview/native-run.json` records its PID, binary and paths. Set `VECTORY_AGENT_BIN` to an absolute agent executable path to test a particular candidate. Before repeating the native workflow, stop the prior synthetic daemon after checking that its executable and command line match this file. Never stop an unrelated Vector/agent process. No production device is adopted by these tests.

For the Vite development UI, run `npm run dev` in `dashboard/` and visit **http://127.0.0.1:5173**. Vite proxies `/api` to the loopback server. Then:

```powershell
Push-Location dashboard
npm test
npm run test:browser
Pop-Location
node tests/contracts.mjs
node tests/catalog.mjs
node tests/fleet-browser.mjs
node tests/security/resource-race.mjs
./tests/native-outage.ps1
```

Browser tests use the real API/database and create clearly named test accounts, tokens, configurations, groups and schedules. They require a synthetic offline device left by a prior native fixture for non-live recovery/removal tests. Secrets are read from the private credentials file, not from environment-independent defaults. Run these only against this isolated preview. Screenshots and nonsensitive evidence are written to `docs/`; failure traces are ignored. `VECTORY_UI_URL=http://127.0.0.1:8080` can test the built dashboard without Vite.

The loopback server runs structural validation; it does not execute arbitrary user VRL on the API host. Synthetic VRL testing reports capability unavailable until the isolated validator is deployed. The actual worker's bounded native invocation is tested separately in Rust, while Compose container isolation still requires a Docker engine for verification.

Independent negative TLS tests create their own short-lived server state and TLS listeners:

```powershell
$env:VECTORY_SECURITY_SERVER=(Resolve-Path server/target/debug/vectory-server.exe)
go test -v tests/security/protocol_test.go
```

For actual agent activation/rollback and metrics integration:

```powershell
$env:VECTOR_TEST_BINARY=(Resolve-Path .local/tools/vector-0.58.0/bin/vector.exe)
Push-Location agent
go test -v ./internal/agent -run 'TestNativeVector'
Pop-Location
```

The [load harness](../tests/load/README.md) runs an isolated synthetic protocol population, not native Vector workloads. Its measured failure boundary is recorded in [CAPACITY.md](CAPACITY.md).
