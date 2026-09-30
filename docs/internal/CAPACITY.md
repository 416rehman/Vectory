# Measured protocol load and limits

**Current measurement (2026-09-30, release build, a shared 4-vCPU Linux VM, simulated devices).** 10,000 devices without assignments, checking in every minute: about 170 check-ins a second with the single database writer half busy and a median per-second p99 latency of 34 ms. With all 10,000 devices in an all-at-once deployment, the writer spends about twice as long per check-in (the scheduler's work for the active rollout included) and saturates at 140 to 160 check-ins a second: p99 1.5 to 3 seconds, and the check-ins above that are refused with HTTP 503 and retried with backoff. The database writer is the bottleneck; CPU (under one vCPU for the server) and memory (1.0 GiB peak) are not. **There is no supported fleet size.** The run that led here also found and fixed a memory blow-up in deployment resolution. Details and older experiments follow.

## Release build: 10,000 devices, a rollout and churn (2026-09-29 and 30)

**Build.** `cargo build --release` (thin LTO, one codegen unit, stripped) of the server sources at `4d60c2b`, SHA-256 `ec87936838e0c59e677285648a236b5650c193e8d9b9d4f8ad70ee0eaba3016c`, measured from commit `aecd80a` (no server changes in between). Run 1 below used the sources of `21bd03f`, before the fix it found (SHA-256 `c6a64fdb204ffd4c7542a55b4c3313ad0685d1921992c19e67a763a19b13a377`). Raw measurements, sampled and without keys: [run 1](../evidence/capacity-2026-09-29.json), [run 2](../evidence/capacity-2026-09-30.json).

**Hosts.** Linux 6.18 virtual machines with 4 vCPUs, 15.7 GiB of RAM, no swap and a virtio disk, shared with other development work. Run 1 ran on an Intel Xeon at 2.10 GHz. The host restarted before run 2, which ran on an Intel Xeon at 2.80 GHz; a 4 KiB write plus `fsync` took 0.33 ms on average there (p99 2.1 ms). The load generator ran on the same host over loopback, so the server, the load generator and anything else running share the four vCPUs; the numbers below say how busy the host was. Run 1 started once the one-minute load average had dropped under 3 (after a 9-minute wait), run 2 on an idle host (2.2); other work resumed during both (load average up to 3.6 in run 1 before its stall, 2.2 to 6.0 in run 2). The server and the load generator each ran under a 4 GiB address-space limit in run 2.

**Harness.** `tests/load/capacity.py` with the Go driver `tests/load/fleet` (Go 1.24.7), described in [the load test README](../../tests/load/README.md). 10,000 identities were seeded offline, signed by the server's own device CA and registered as enrollment registers them. Each simulated device has its own key, certificate and HTTP/2 connection pool over TLS 1.3, checks every signed manifest (signature, device, nonce, generation), and sends a full telemetry sample: all 17 device-level numbers at full precision and three components, about 2 KB per check-in. The run:

- starts at a 60-second check-in interval (0 to 60 seconds of initial jitter, then 0.8 to 1.2 times the interval);
- at 120 seconds creates an all-at-once deployment of one pipeline (1,229-byte artifact) to all 10,000 devices through the dashboard API. Each device downloads the artifact at its next check-in, checks the digest, and reports the apply in a follow-up check-in two seconds later, as the agent does;
- from 30 seconds to the end enrolls new devices through `POST /agent/v1/enroll` at 5 a second (half the server-wide limit, from ten loopback source addresses), each followed by its first check-in;
- then steps the interval down to 30, 15, 10 and 5 seconds, 150 seconds each, to find where the server saturates.

Simulated devices never run Vector: their `verified_applied` reports are fixture input, not activation evidence.

### Run 1: a deployment to 10,000 listed devices exhausted memory (fixed)

Before the deployment, from 60 to 120 seconds, the server handled 165 check-ins a second and 5 enrollments a second without an error. The median per-second p99 latency was 37 ms (worst second 123 ms). The server used 0.37 vCPU and 519 to 536 MiB of RSS, the load generator 0.15 vCPU, and the whole host 1.3 busy vCPUs (load average 2.4 to 3.6). The writer lock was busy 43 to 46% of each minute, with a mean wait of 7.5 ms.

The deployment request took 27.8 seconds. During it the server's RSS rose from 536 MiB to 8.4 GiB, and to 11.5 GiB during the next scheduler tick. No check-in succeeded afterwards: every one got HTTP 503 (all 128 agent request slots were waiting for the writer lock) or HTTP 408 after 15 seconds, no device learned about the deployment, and the host ran out of memory (load average 27 to 30). The server was stopped 13 minutes into the run at 11.5 GiB RSS.

The cause: `resolve`, which runs under the writer lock on every deployment change and scheduler tick, copied the whole deployment record once for every device it wins. The record carries its selector, here 10,000 device IDs (a deployment reviewed in the dashboard also stores the reviewed target list), so one pass allocated about 8 GB and took longer than a check-in may wait. Commit `4d60c2b` borrows the record instead. `winners_among` still copies for the deployment preview, group edits, rollback review and assignment removal, which see the same growth when they cover thousands of devices: see "Open limits" below.

### Run 2: after the fix

**Before the deployment** (60 to 120 seconds; no device had an assignment) the load generator attempted 180 check-ins a second. The median per-second p99 latency was 34 ms. 1,032 attempts got HTTP 503: retries of a first minute in which all 10,000 devices connected and checked in for the first time (writer 89% busy). In the minute before the deployment the writer was 52% busy for 10,221 writes, with a mean wait of 87 ms. The server used 0.45 vCPU and 554 MiB of RSS, the host 0.7 busy vCPUs.

**The deployment request** took 20.3 seconds and held the writer for 20.2 of them in one transaction. Check-ins that waited longer than 15 seconds got HTTP 408; the rest of that minute's queue got HTTP 503.

**After it**, with every device assigned, the writer stayed 96 to 98% busy for the rest of the run at 123 to 176 writes a second. Shorter check-in intervals added refusals, not throughput:

| Phase (settled window) | Nominal check-ins/s | Succeeded/s | p50 / p95 / p99 of successes | Refused (503 / 408) | Server vCPU | Host busy vCPUs | Writer busy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 60 s interval (60–360 s, includes the deployment) | 167 | 140 | 656 ms / 1.19 s / 3.02 s | 39,096 / 123 | 0.85 | 1.7 | 52%, then 97–98% |
| 30 s (390–510 s) | 333 | 83 | 918 ms / 1.86 s / 13.3 s | 17,710 / 106 | 0.66 | 1.5 | 98–99% |
| 15 s (525–660 s) | 667 | 145 | 769 ms / 1.36 s / 1.89 s | 19,431 / 0 | 0.91 | 2.2 | 97% |
| 10 s (670–810 s) | 1,000 | 161 | 698 ms / 1.27 s / 1.48 s | 20,913 / 0 | 0.93 | 2.3 | 97% |
| 5 s (815–960 s) | 2,000 | 144 | 782 ms / 1.50 s / 2.10 s | 18,307 / 0 | 0.87 | 2.5 | 97% |

"Nominal" is 10,000 divided by the interval; refused devices back off (10 seconds doubling to 5 minutes), so fewer attempts arrive. In the 30-second phase one reporting window stretched to 96 seconds with a 2.6-second hold and 15-second waits; its cause wasn't isolated. Each check-in carried about 2 KB. SQLite reported no errors and never hit its busy timeout: all waiting happened on the server's own writer lock. The WAL file stayed near 4.2 MB until the deployment's transaction grew it to 56.6 MB, a size it then kept: SQLite reuses the file and nothing truncates it. Server RSS peaked at 1.00 GiB; the load generator used about 1 GiB.

**The rollout.** Half of the 10,000 targets were verified 116 seconds after the deployment request and 90% after 616 seconds. When the run ended, 840 seconds after it, 9,035 were verified and 965 still waited: their check-ins kept getting HTTP 503 and backing off. 9,333 artifact downloads succeeded (p50 1.4 ms, p99 6.7 ms); 2,256 got HTTP 503, because downloads share the 128 agent request slots with check-ins queued for the writer, although they never take the writer themselves.

**Enrollment churn.** Of 4,500 enrollments at 5 a second, 2,280 succeeded (p50 682 ms, p99 3.2 s), 2,214 got HTTP 503 and 6 got HTTP 408. 1,817 of the new devices' first check-ins succeeded; 463 got HTTP 503.

**Storage.** 78,624 telemetry history rows took 755 bytes each with their indexes (585 bytes of JSON), measured with `dbstat`; see [Monitor devices](../user/telemetry.md#storage-and-limits) for what that means per day. At the end the database held 12,280 devices (2.5 KB of JSON each) in 157 MB.

**An interrupted attempt** of run 2, with the same binary on run 1's host, stopped after 5 minutes when the host restarted: its deployment request took 15.1 seconds, 9,958 of the 10,000 targets were verified 196 seconds after it, the writer was 97% busy at about 200 writes a second, and server RSS stayed under 940 MiB.

### What this means

- **Budget on this hardware.** About 170 check-ins a second from unassigned devices, with the writer half busy and a median per-second p99 of 34 ms; 140 to 160 a second once devices are assigned, at which point latency reaches seconds and the excess is refused. Half of the assigned ceiling, about 80 check-ins a second, is a reasonable planning figure (5,000 devices at the default one-minute interval, or 10,000 at two minutes); that figure is derived, not measured.
- **The bottleneck is the single database writer.** Every check-in, enrollment and scheduler tick is serialized behind one lock and one SQLite transaction. At saturation the lock was held 97% of the time while the server process used under one vCPU and the host had 1.5 to 2.5 of its 4 vCPUs busy, so more vCPUs would not raise the ceiling; doing less work per check-in under the lock would.
- **Memory and connections were not limits** after the fix: 1.0 GiB of RSS for 10,000 connected devices and a 10,000-target deployment.

### Open limits these runs found

- Creating a deployment for 10,000 devices holds the writer for 15 to 20 seconds in one transaction, so check-ins queued behind it time out.
- The 128 agent request slots are shared by check-ins, downloads and enrollments. When check-ins queue for the writer, downloads and enrollments are refused too, although only enrollment needs the writer.
- `winners_among` still copies the whole deployment record for every device in scope, for the deployment preview, group edits, rollback review and assignment removal. By the same arithmetic as run 1, previewing a second deployment over the same 10,000 listed devices would copy the first record about 20,000 times; this wasn't measured.
- Telemetry history grows by about 1.1 MB per device per day at the default interval: about 76 GB for 10,000 devices over the default 7 days.

**Not measured:** real agents and Vector activation (applies are synthetic), canary rollouts, dashboard reads during the load, network latency, a dedicated host or independent load generators, fleets of 100 and 1,000 devices on a release build, hours of sustained load, and reconnect storms after an outage.

## Go HTTP/2 rerun after admission fixes (2026-09-26, debug build, Windows)

The final 2026-09-26 Go HTTP/2 experiment reached all 100, 1,000 and 10,000 authenticated protocol identities with zero request failures after connection-admission fixes. The earlier HTTP/1.1 experiment failed at 10,000 and is preserved below. Clients and debug server shared a Windows development host; other development work was not suspended. These are short protocol simulations, not isolated hardware benchmarks or native-agent/Vector qualification.

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
