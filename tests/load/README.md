# Isolated protocol load experiment

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
