# Develop Vectory locally

Run a private Vectory on loopback, with real agents running real Vector, and run the test suites against it. Everything lives in `.local/`: nothing registers a service or touches your system's trust store. The toolchain versions are in [CONTRIBUTING.md](../../CONTRIBUTING.md#prerequisites).

## Linux and macOS

### Build

```sh
(cd help-center && npm ci)
(cd dashboard && npm ci && npm run build)
(cd server && cargo build --bins)
```

`npm run build` in `dashboard/` builds the dashboard, then the Help center into `dashboard/dist/help/`.

### Start a preview

```sh
scripts/preview.sh           # start; also: status, restart, stop
```

```text
Preview running at http://127.0.0.1:8080 (agent TLS https://127.0.0.1:8443).
Bootstrap secret: /home/you/Vectory/.local/preview/bootstrap.secret
Add a device from Devices > Add device. The server log (/home/you/Vectory/.local/preview/server.log) shows only the ends of the CA fingerprint; Add device shows all of it.
```

On first start the script creates a short-lived test CA in `.local/pki/` (with `go run packaging/dev-pki/main.go`) and a random bootstrap secret. It starts the validator when it finds a Vector binary under `.local/tools/`; without one, pipeline checks are structural only. Logs are in `.local/preview/server.log` and `validator.log`. Run `scripts/preview.sh restart` after rebuilding.

To run several previews side by side, give each its own folder and ports:

```sh
export VECTORY_PREVIEW_DIR=$PWD/.local/preview-b
export VECTORY_PREVIEW_WEB_PORT=8180
export VECTORY_PREVIEW_AGENT_PORT=8183
export VECTORY_PREVIEW_VALIDATOR_PORT=8181
scripts/preview.sh
```

### Add a demo fleet

```sh
node scripts/demo.mjs --agents 4    # 1 to 12 agents
node scripts/demo.mjs --stop        # stops the agents and the preview
```

The demo builds the agent, downloads Vector 0.58.0 and checks it against the official SHA-256 list, starts the preview and creates an administrator, `operator@vectory.local`, with a random password in `.local/preview/credentials.json`. It then enrolls the agents with the address **Add device** shows (`https://127.0.0.1:8443` here), puts them in two groups, sets 15-second check-ins, and publishes and deploys two pipelines that generate synthetic `demo_logs` events. Nothing leaves the machine.

Each agent keeps its state in `.local/demo/agents/<name>/`. Running the demo again reuses agents that are still running and restarts the ones that stopped. Set `VECTORY_DEMO_DIR` and `VECTORY_DEMO_METRICS_PORT` (default `19600`) to keep a second demo apart.

### Test

```sh
(cd dashboard && npx tsc -b && npm test)
(cd server && cargo test --locked)
(cd agent && go vet ./... && go test ./...)
node --test help-center/scripts/*.test.mjs
node help-center/tests/ci.mjs
```

- `help-center/tests/ci.mjs` starts its own disposable server, so it doesn't need the preview. It needs `server/target/debug/vectory-server` and a built dashboard.
- Most browser harnesses in `dashboard/tests/` and `tests/` run against the preview at `http://127.0.0.1:8080` and create clearly named synthetic accounts, tokens and pipelines. Set `VECTORY_UI_URL` to point them elsewhere. Install their browser once with `(cd dashboard && npx playwright install chromium)`.
- Native tests run the real Vector binary:

  ```sh
  VECTOR="$PWD/.local/tools/vector-x86_64-unknown-linux-gnu/bin/vector"
  VECTORY_TEST_VECTOR="$VECTOR" cargo test --locked --manifest-path server/Cargo.toml
  (cd agent && VECTOR_TEST_BINARY="$VECTOR" go test ./internal/agent -run TestNativeVector)
  ```

- `node tests/native-workflow.mjs` drives a whole workflow against the preview: a synthetic device and pipeline, activation, drift repair, pause, metrics and secret rotation.
- Independent TLS checks: `VECTORY_SECURITY_SERVER=$PWD/server/target/debug/vectory-server go test -v tests/security/protocol_test.go`.

### Capture product screenshots

Start from a fresh demo, so recent activity shows the fleet rather than earlier test runs: stop the demo, then delete `.local/preview/state`, `.local/preview/credentials.json` and `.local/demo`. Build a Linux agent release first so **Add device** offers a download:

```sh
python3 packaging/build-release.py --out artifacts/releases --target linux/amd64
node scripts/demo.mjs --agents 4
node scripts/capture-screenshots.mjs              # or name screens: editor overview
```

It signs in as the demo administrator, changes nothing but its own session and local form selections, and signs out again. It writes 1440-pixel-wide light screenshots of the demo pipeline in the editor, Overview, Devices, a device, the pipeline's rollout, Add device and the Help center, plus a dark editor for the README, to `docs/screenshots/product-*.png`. Most images are 900 pixels tall; Overview captures the complete page, while the device and Add device frames are taller to show complete sections. For Add device, it selects Linux and restricted mode but does not create an install command or token. It first verifies that the instance contains only demo records, exactly one demo enrollment token, and devices matching local demo agents. It waits for the demo devices to verify application, for the rollout to finish and for page loading indicators to clear, and refuses an editor capture until Vector accepts the pipeline. Editor images also wait for live graph rates; Overview waits for running-version rates, nonzero fleet throughput and a chart with two completed data buckets. Each telemetry wait is limited to four minutes and fails rather than saving an empty image. It refuses to save **Add device** if opening it issued an enrollment token.

For a fresh Linux capture without a local Linux toolchain, dispatch the `product screenshots (synthetic demo)` GitHub Actions workflow. It starts an isolated demo, runs the same capture guard, and uploads the images as a short-lived artifact. Review all eight images before replacing the tracked screenshots; a successful capture is evidence of the demo state, not an automatic visual approval.

| Variable | Use |
| --- | --- |
| `VECTORY_PREVIEW_DIR`, `VECTORY_PREVIEW_WEB_PORT` | The same preview settings as `scripts/preview.sh`. |
| `VECTORY_DEMO_DIR` | The demo agent directory used by `scripts/demo.mjs`; set this when capturing an isolated demo outside `.local/demo`. |
| `VECTORY_SCREENSHOTS_DIR` | Write somewhere else, for example to review before you replace the committed images. |
| `VECTORY_CHROMIUM` | A Chromium executable, when Playwright's own browser isn't installed. |

## Windows (PowerShell)

Put a checksum-verified Vector 0.58.0 at `.local/tools/vector-0.58.0/bin/vector.exe`, then:

```powershell
Push-Location help-center; npm ci; Pop-Location
Push-Location dashboard; npm ci; npm run build; Pop-Location
Push-Location server; cargo build --locked; Pop-Location
Push-Location agent; go build -trimpath -o vectory.exe ./cmd/vectory; Pop-Location
go run packaging/dev-pki/main.go --out .local/pki --hosts localhost,127.0.0.1,::1
./packaging/Start-LocalPreview.ps1
node tests/initialize-preview.mjs
node tests/native-workflow.mjs
```

`Start-LocalPreview.ps1` serves the dashboard at `http://127.0.0.1:8080` and the agent listener at `https://localhost:8443`. `initialize-preview.mjs` creates `operator@vectory.local` with a random password in `.local/preview/credentials.json`. The native workflow leaves its synthetic agent running and records its process in `.local/preview/native-run.json`; stop that process before you run the workflow again.

Windows-specific checks:

```powershell
./tests/native-outage.ps1
$env:VECTOR_TEST_BINARY = (Resolve-Path .local/tools/vector-0.58.0/bin/vector.exe)
Push-Location agent; go test -v ./internal/agent -run 'TestNativeVector'; Pop-Location
```

## Rules for test data

- Use synthetic data only. Never point a test at a real installation or real hosts.
- Keep `.local/` private: it holds a test CA key, bootstrap secrets, credentials and device state.
- Don't commit screenshots or evidence from ad-hoc runs. Product screenshots come from `scripts/capture-screenshots.mjs`.
