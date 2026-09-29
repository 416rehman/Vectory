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

## Fleet reads through the dashboard API (2026-09-29)

This measures what one dashboard read costs at 5,000 devices before and after server-side paging (the fleet-scale reads in `contracts/CONTRACT.md`). Two debug builds read identical copies of one synthetic fleet, side by side on a shared development host. **Compare the builds with each other; this is not a capacity claim.**

**Fixture.** `tests/load/fleet-fixture.mjs` seeded 5,000 devices (4,750 live, 250 revoked; 27,507,936 bytes of stored device JSON, about 5.5 KB each), 500 groups with 21,551 memberships (all live devices, ten regions of 475, 50 racks of 100, 438 teams of 1 to 30), six pipelines and 4,500 rollout targets. Devices repeat twenty shapes: healthy, not delivering, updating, offline, failed, check required, paused, unmanaged, never connected and revoked, on an all-at-once rollout, a canary, a persistent group assignment and finished rollouts. Nothing enrolled or ran Vector; `verified_applied` is fixture input. The harness re-stamped the reporting devices' check-ins every 45 seconds so they stayed online.

**Builds and host.** Before: `9434fef`, SHA-256 `1224817308adac16c7d5a6e461a94f654414d5fc2e4be09c08c9dbb40638f671`. After: `e08cf8e` (the server sources of the final commit), SHA-256 `0be8d0739c84c9c7cf1d7ea3737aa250367823bec9104ee04217e0f72bd6048c`. Both are `cargo build` debug builds without debug info. Linux, 4 CPUs, 16 GB, load average 7 to 11 from other builds during the run; Node 22 `fetch` over loopback. `tests/load/fleet-api.mjs` sampled each read five times, alternating the order, and waited 2.3 seconds before each sample. **Cold** is that first read, which builds the shared projection (it lives two seconds); **warm** is the same read right after it, as another viewer or poller within two seconds sees it. Medians; minimum and maximum are in the [raw evidence](../evidence/fleet-api-2026-09-29.json).

| Read | Before | After |
| --- | --- | --- |
| Devices page, first page | `GET /devices` + `GET /groups`: 11,285,445 bytes; 2,898 + 82 ms | `GET /devices/inventory`: 111,354 bytes (50 rows); 1,459 ms cold, 38 ms warm |
| Devices page, search `web-01` | The same download, filtered in the browser | `GET /devices/inventory?q=web-01`: 127,792 bytes; 1,563 ms cold, 51 ms warm |
| Overview, `slim=1` | Parameter ignored: 10,377,261 bytes; 3,335 ms | 35,465 bytes; 1,466 ms cold, 108 ms warm |
| Overview, default | 10,377,261 bytes; 2,923 ms | 10,393,377 bytes; 2,118 ms |
| `GET /devices/{id}` | 6,922 bytes; 2,077 ms | 6,922 bytes, identical JSON; 5.5 ms |
| Device page and its groups | `GET /devices/{id}` + `GET /groups`: 934,466 bytes; 2,077 + 82 ms | `GET /devices/{id}?include=groups`: 7,283 bytes; 18 ms |
| Members of a 4,750-device group | `GET /groups` + `GET /devices`: 11,285,445 bytes; 82 + 2,898 ms | `GET /groups/{id}/members`: 4,311 bytes (50 rows); 1,236 ms cold, 108 ms warm |
| Membership preview, 10 changes | `POST /groups/membership-preview`: 12,411 bytes; 130 ms | Same route, same answer: 12,411 bytes; 85 ms |

Other reads on the new build: `GET /groups?slim=1` 88,480 bytes in 43 ms (the default `GET /groups` is 936,471 bytes in 133 ms, 927,544 bytes in 82 ms before); `GET /devices/inventory/ids` 185,290 bytes for 4,750 IDs in 1,479 ms cold, 26 ms warm; the legacy `GET /devices`, same response, 10,357,901 bytes in 1,720 ms (2,898 ms before, which also parsed the fields list rows drop). Compressed by a proxy, `GET /devices` would still be 308,100 bytes against 8,155 for an inventory page.

What the numbers mean:

- **Size no longer grows with the fleet** for the inventory, members, a device and the slim Overview. Only the legacy `GET /devices`, the default Overview (for its `devices`) and `GET /groups` without `slim` still do; the dashboard moves off them next.
- **A cold read costs one fleet projection**, 1.2 to 1.5 seconds here: reading every device's list row once, then counting and summarizing in memory. It no longer grows with the number of requests: concurrent readers share one build, and every read within two seconds is warm. A single dashboard polling every 15 seconds mostly reads cold. Release builds are usually several times faster than these debug builds; this run didn't measure them.
- **A device page stopped projecting the fleet.** `server/tests/fleet_scale.rs` counts SQL statements and rows instead of time: `GET /devices/{id}` runs 5 statements returning 4 rows with 1 or 2,000 devices. A projection build runs 17 statements with 20 or 2,000 devices; its rows grow with the fleet (76 at 20 devices, 2,350 at 2,000). Reads served from it run a fixed 3 to 9 statements and at most 15 rows. The test fails if any of that starts growing with the fleet.
- **The membership preview is unchanged.** It takes the writer lock and answers "Preview busy" while a scheduler tick holds it: the new build's server refused 7 attempts across the six previews (the old one none, by timing), and the harness retried every 50 ms. Only the attempt that ran is timed.

The harness checked that both builds listed all 5,000 devices, that the fleet stayed checked in, that the slim Overview differs from the default only by `devices`, that the inventory's first page is the first 50 live devices in natural name order, and that both builds returned identical device JSON and identical previews.
