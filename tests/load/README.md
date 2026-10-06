# Isolated protocol load experiment

## Capacity run: rollout, churn and saturation (`capacity.py`)

`capacity.py` measures one server build on one Linux host, end to end: a copy of the given binary on loopback ports 8390 (dashboard API) and 8391 (agent listener), device identities seeded offline and signed by the server's own device CA, and `fleet/main.go` driving them, one TLS connection pool per device over HTTP/2. Each simulated device checks every signed manifest (signature, device, nonce, generation) and sends a full telemetry sample: every device-level field the server accepts, at full float precision, plus three components. During the run the harness:

- creates an all-at-once deployment to every seeded device through the dashboard API; devices download the artifact, check its digest and report the apply in a follow-up check-in two seconds later, as the agent does;
- enrolls new devices through `POST /agent/v1/enroll` at a steady rate (from ten loopback source addresses, under the per-address limit), each followed by its first check-in;
- steps the check-in interval down by phase (60, 30, 15, 10 and 5 seconds by default) to find where the server saturates.

It samples the server's and the load generator's CPU and memory and the whole host's busy CPUs from `/proc` every second, the database and WAL sizes, rollout progress from the database, and the server's once-a-minute `vectory_server::sqlite` writer line (writes, `busy_percent`, lock waits, WAL size). Afterwards it measures the telemetry table's exact storage with SQLite's `dbstat`.

```sh
cargo build --release --locked --manifest-path server/Cargo.toml --bin vectory-server
go build -o /private/capacity-driver tests/load/fleet/main.go
python3 tests/load/capacity.py --server server/target/release/vectory-server \
  --driver /private/capacity-driver --out /private/new-directory --result /private/capacity.json
```

It needs Python 3.11 or later with `cryptography`, and Go 1.24 or later. `--devices`, `--phases`, `--duration`, `--deploy-at` and `--enroll-per-minute` change the scenario. `--server-memory-mb` and `--driver-memory-mb` (4,096 each by default) cap each process's address space, so a runaway allocation fails in that process instead of exhausting a shared host. The fixture directory holds private keys and is deleted afterwards unless `--keep` is given; the result file holds measurements only. The server, the load generator and anything else running on the host share its CPUs, and the result records all three. Simulated devices never run Vector: their `verified_applied` reports are fixture input, not activation.

## Earlier protocol experiments

Both harnesses provision a new private fixture directory, copy a real native server binary, create a private TLS CA, and register unique CA-signed device keys in a fresh SQLite database. They exercise the actual TLS 1.3 mutual-authentication listener, heartbeat persistence, telemetry storage, and Ed25519 signed manifests. Every successful response is checked for signature, nonce, device UUID, generation and artifact digest. They never connect to the ordinary application fleet. `benchmark.py` uses Python/aiohttp and explicitly selects HTTP/1.1. `benchmark_http2.py` launches a Go driver with the native agent's DefaultTransport-clone pattern and records the actual negotiated HTTP protocol for every response.

Install dependencies in an isolated environment. Versions used for the recorded experiment were Python 3.11.0, aiohttp 3.13.5, cryptography 46.0.6 and psutil 7.0.0. For this repository's local test setup, optional `.local/load-deps` is added to the Python import path.

```sh
python -m pip install aiohttp==3.13.5 cryptography==46.0.6 psutil==7.0.0
python tests/load/benchmark.py --server /absolute/path/vectory-server --out /private/new-directory --agents 100 1000 10000 --duration 70 --interval 60
```

For the representative Go transport, build with Go 1.26.8 (use `.exe` on Windows):

```sh
go build -o /private/load-http2 tests/load/http2/main.go
python tests/load/benchmark_http2.py --server /absolute/path/vectory-server --driver /private/load-http2 --out /private/new-http2-directory --agents 100 1000 10000 --duration 70 --interval 60
```

The Go driver prepares credential transports before its own measurement timer. Server monitoring begins before this preparation, so its CPU average covers the explicitly reported longer observation window, including idle setup time. Do not label that average as CPU during the 70-second traffic interval. Per-second samples and peak CPU are retained. HTTP/2 protocol counts, Go version, setup duration and server/driver digests are in the report. These clients execute the signed protocol but are not full Vectory agent processes.

The output directory must not exist. It contains private test CA/device keys and databases; keep it private and never publish it. `summary.json` and per-size `result.json` contain measurement data without keys and can be retained separately. The server is started/stopped only as a child of this test; no system services or trust stores change.

Enrollment and desired configuration are seeded offline to exclude the enrollment endpoint's intentional global rate limit. The clients are protocol simulators, not native agents or Vector processes. Their synthetic `verified_applied` status is a fixture input and must never be cited as observed activation. There is no real artifact transfer, configuration churn, rollback, canary rollout or device environment validation. Initial heartbeat jitter is uniform 0–60 seconds; subsequent successful intervals use a 0.8–1.2 multiplier. Failed requests use exponential delay bounded to 300 seconds with jitter. Each client has its own credential, TLS connection pool (limit 2, idle timeout 90 seconds), and a 30-second total request timeout.

Blocking certificate loading finishes before timing. Windows socket enumeration runs in a monitoring thread so it cannot stall all clients. Results include successful and all-request latency percentiles, number of attempted/successful identities, errors, signed-manifest convergence, request/response bytes, server CPU/RSS, client event-loop lag, and SQLite logical/WAL sizes. CPU percentage uses 100% per logical core. The monitor's sampled peaks can miss short spikes; slow monitoring or client scheduling is reported as a measurement limitation.

The client and server share one machine and use loopback. A debug server build, one short run, or passing 1,000 identities does not establish production capacity. See [CAPACITY.md](../../docs/internal/CAPACITY.md) for measured results and failures. Production qualification requires a release build, independent load generators, native agents, real network latency, sustained telemetry, database growth, configuration churn, rollout convergence, outage/backoff and saturation tests.

## Fleet reads through the dashboard API

`fleet-api.mjs` compares two server builds on the reads the dashboard makes of a large fleet: the device inventory, a device, group members, the Overview and a membership preview. `fleet-fixture.mjs` seeds the fleet straight into a fresh database: 5,000 devices in twenty repeating shapes (healthy, not delivering, updating, offline, failed, check required, paused, unmanaged, never connected, revoked), six pipelines, an all-at-once rollout, a canary, a persistent group assignment, and 500 groups from 1 to every device. It refuses a database that already has devices, pipelines or groups, and labels every device `fixture=fleet-scale`.

```sh
node tests/load/fleet-api.mjs --before /absolute/path/old/vectory-server \
  --after /absolute/path/new/vectory-server --out /private/fleet-api.json
```

It copies both binaries into a new private directory, initializes the database with the new build through the API, stops it, seeds, and copies the state so both builds read the same rows. Both servers then run side by side on loopback and are sampled in turn, so a busy machine slows both alike. Reads of the shared projection wait out its two-second lifetime before each sample, and a second read right after it is reported as warm. The harness stamps the fixture's reporting devices as checked in every 45 seconds; nothing enrolls, runs Vector or reports a real apply. The directory is deleted afterwards unless `--keep` is given.

The dashboard is checked against the same fixture by `dashboard/tests/fleet-scale-browser.mjs`: a real server and the real dashboard build with the 5,000-device fleet seeded into a disposable database. It pages through Devices, searches, selects everything a search finds, edits a group of thousands and reads the Overview. It fails when a read returns more than a page of devices, when the Overview reads more than the slim response, or when a click or key press takes a second to paint. It needs a built dashboard and a built server, so CI's dashboard job does not run it:

```sh
(cd dashboard && npm run build)
cargo build --manifest-path server/Cargo.toml
node dashboard/tests/fleet-scale-browser.mjs   # --server, --dist, --port and --out change the defaults
```

Its report (`.local/fleet-scale/report.json`) lists every read the pages made with its size, the time each scenario took and the measured latencies.
