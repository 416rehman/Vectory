# Measured protocol load and limits

The final 2026-09-26 Go HTTP/2 experiment reached all 100, 1,000 and 10,000 authenticated protocol identities with zero request failures after connection-admission fixes. The earlier HTTP/1.1 experiment failed at 10,000 and is preserved below. **There is no production fleet-capacity claim.** Clients and debug server shared a Windows development host; other development work was not suspended. These are short protocol simulations, not isolated hardware benchmarks or native-agent/Vector qualification.

## Go HTTP/2 rerun after admission fixes

The server SHA256 was `68cb4de673a3d3d6b05a2b522b4c3b966507e4feffbe1bb888afc6988b8da177`; the Go 1.26.8 driver SHA256 was `2d780587b65d68daeb7022c25bfa88725d841bf7d4e53db0475713563ac267e7`. All successful responses negotiated HTTP/2.0 over TLS 1.3. Each identity used a unique certificate, private connection pool and the Go DefaultTransport-clone pattern used by the real agent. Connection admission defaults to 16,384 accepted connections, with separate limits of 128 concurrent TLS handshakes, 128 parsed requests, 16 HTTP/2 streams per connection and a 15-second request deadline. The previously shared authenticated/anonymous rate tables were also separated. These limits bound resources; the maximum is not a supported fleet-size promise.

| Identities | Successful / attempted requests | Distinct successful identities | Error rate | Successful latency p50 / p95 / p99 |
| --- | --- | --- | --- | --- |
| 100 | 115 / 115 | 100 | 0% | 6.881 / 8.579 / 11.039 ms |
| 1,000 | 1,161 / 1,161 | 1,000 | 0% | 6.055 / 8.415 / 18.545 ms |
| 10,000 | 11,662 / 11,662 | 10,000 | 0% | 7.706 / 126.525 / 187.995 ms |

| Identities | Mean / peak sampled CPU (100% = one core) | Peak sampled RSS | DB logical bytes after | Peak WAL bytes | Persisted telemetry buckets |
| --- | --- | --- | --- | --- | --- |
| 100 | 1.258% / 7.8% | 29,655,040 | 401,408 | 3,481,432 | 115 |
| 1,000 | 9.893% / 29.2% | 81,281,024 | 2,506,752 | 4,165,352 | 1,140 |
| 10,000 | 60.230% / 226.2% | 564,801,536 | 23,834,624 | 4,181,832 | 11,657 |

Each driver's traffic timer ran about 70 seconds with initial uniform 0-60-second jitter and subsequent 0.8-1.2 interval jitter. **CPU means include credential preparation before traffic**, over server observation windows of 72.050 / 80.075 / 151.866 seconds; they must not be presented as means during the traffic window alone. Preparing 10,000 transports took 80.291 seconds outside its 70.543-second traffic timer. Samples and exact intervals are retained in the [raw HTTP/2 measurement](../evidence/load-http2-2026-09-26.json). Telemetry was 73 JSON bytes and the immutable configuration 1,230 bytes. Per-minute telemetry coalescing explains fewer buckets than requests. Before-run DB plus sidecars totaled 332,096 / 1,497,136 / 13,229,456 bytes, which differs from the after-run logical-page metric.

All 10,000 identities obtained a cryptographically checked first manifest within 60.042 seconds of the traffic timer; this mostly reflects the intentional 60-second initial jitter. It is not rollout convergence. Enrollment and desired state were seeded offline; `verified_applied` is explicit synthetic fixture input. Churn, artifact downloads and native Vector activation were zero. SQLite lock-wait duration was not instrumented. The final server build changed audit correlation, retention configuration and owned-path preflight after this copied binary; its security suite was rerun separately. Hardware is the same shared Windows development host described below. Independent load generators, release builds, prolonged telemetry retention, realistic network latency, real artifact/configuration rollouts and reconnect bursts remain required before a capacity commitment.

## Preserved HTTP/1.1 failure boundary

The earlier run used the old 512 accepted-connection lifetime bound. The 10,000-identity case failed and motivated the admission redesign and protocol-representative rerun.

Hardware: Windows 11 host, build 10.0.26200, AMD Ryzen 9 5950X (16 cores / 32 logical processors), 137,354,223,616 bytes RAM, local C: volume on an ADATA SX8100NP NVMe drive. The server executable was copied before measurement and had SHA256 `d71881bbe51256b2c596ed1b6a3186ec1f8ff3e3e8c05fd0c4173f7cb1fd8676`; this records the measured revision even when later source changes occur. It was a Rust debug build, not a release build. Python 3.11.0, aiohttp 3.13.5, cryptography 46.0.6 and psutil 7.0.0 generated load over loopback TLS 1.3 and **HTTP/1.1**.

Every identity had a unique certificate/key and a separate connection pool. Heartbeats used a 60-second interval, initial uniform 0–60-second jitter and subsequent 0.8–1.2 jitter. Failures used bounded exponential retry. Each scenario requested 70 seconds and completed in about 70.8 seconds. Telemetry was 78 JSON bytes; the seeded configuration was 1,230 bytes. Churn and artifact downloads were zero. Enrollment was seeded offline, and `verified_applied` was synthetic input. No actual Vector activation, configuration rollout or canary convergence was measured.

| Identities | Successful / attempted requests | Distinct successful identities | Error rate | Successful latency p50 / p95 / p99 |
| --- | --- | --- | --- | --- |
| 100 | 118 / 118 | 100 | 0% | 12.226 / 29.503 / 131.974 ms |
| 1,000 | 1,185 / 1,185 | 1,000 | 0% | 9.386 / 17.882 / 115.961 ms |
| 10,000 | 2,560 / 24,656 | 2,507 | 89.6171% | 31.316 / 294.623 / 356.250 ms |

| Identities | Server mean CPU (100% = one core) | Peak sampled RSS | DB logical bytes after | Peak WAL bytes | Persisted telemetry rows |
| --- | --- | --- | --- | --- | --- |
| 100 | 1.701% | 25,714,688 | 348,160 | 3,127,112 | 118 |
| 1,000 | 12.386% | 42,565,632 | 2,084,864 | 4,144,752 | 1,185 |
| 10,000 | 44.953% | 79,323,136 | 12,922,880 | 4,177,712 | 2,560 |

The database+sidecar size before the runs was 274,432 / 1,101,824 / 9,469,952 bytes respectively. These starting totals include shared-memory/WAL files and are not identical to the final logical-page metric. Successful signed-manifest first-response convergence maxima were 59.186 / 59.983 / 63.458 seconds; the last figure covers only 2,507 successful identities. It is not rollout convergence. SQLite lock-wait duration was not instrumented, so the report cannot isolate writer contention; no HTTP 500/503/429 response was observed in this run.

The 10,000 case produced 22,096 connector failures, predominantly local connection aborts. Source review found a fixed limit of 512 concurrent accepted TLS connections held for each connection's lifetime. The HTTP/1.1 idle-header timeout was 15 seconds; sampled server sockets peaked at 586 including sockets in other states. The failure pattern is consistent with admission saturation, but operating-system and shared-host effects were not separately isolated. Do not interpret fast rejection latency (all-request p95 84.064 ms) as successful performance. Client event-loop lag peaked at 278.858 ms after the harness correction, with 69 monitor samples over the run.

The [raw corrected measurement](../evidence/load-protocol-2026-09-26.json) retains per-second samples, exact counts, error types and binary hash. The [earlier failed experiment](../evidence/load-initial-client-limited.json) is preserved: synchronous TLS setup and Windows socket enumeration starved its client event loop, yielding only five samples at 10,000 identities. It is unsuitable for server-capacity inference. The corrected harness preloads TLS contexts outside timing and collects blocking process information on a monitoring thread; preparing 10,000 TLS contexts took 164.973 seconds outside measurement.

Before setting a fleet limit, test a release build on a dedicated host with independent load generators, native HTTP/2 agents, bounded connection/handshake admission, sustained telemetry retention, real artifact distribution, configuration churn, measured database contention, canary completion, and outage/reconnect bursts. `tests/load/README.md` documents the command and private fixture handling. The current measurements establish a failure boundary, not a universal 1,000-device support promise.
