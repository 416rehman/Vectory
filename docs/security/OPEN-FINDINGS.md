# Open security findings

An independent, read-only source and runtime review of commit `f4d1826`, run against private instances with a real agent and Vector 0.58. It found no way for an unauthenticated peer, a lower role or a device to read a secret, take over an account, cross a role boundary or destroy data. It did find six availability or containment defects that are cheap to exploit, and several smaller ones. A finding is deleted from this file in the change that fixes it, together with its regression test; what is left below is what is still open, followed by the residual risks the fixes themselves left, which the next independent review should attack first.

Fixed since the review, each with regression tests (see the [changelog](../../CHANGELOG.md)): the shared sign-in, reset, invite, enrollment and installer buckets; the combined password-and-code sign-in; the `accept()` loop; idle handshakes; the Slack `text` field; enrollment audit rows; the Azure platform address; the Windows command quoting; the install command's local race; the restricted-mode `api` block; component IDs that name paths; and the packaged systemd unit. Findings 2 to 4 below came from a later review of the capability design.

Severity: **P2** is bounded or needs a precondition; **P3** is hygiene. Where a step could not be run in the review environment, the finding says so.

## P2

### 1. The unit that `vectory setup` registers is weaker than the packaged unit

The packaged unit (`packaging/systemd/vectory.service`) is fixed: `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=-/var/lib/vectory-agent -/etc/vectory/managed -/var/lib/vector`, `KillMode=mixed`, and a packaging test that keeps it so. The unit that `vectory setup` and `vectory service-install` write (`systemdUnitFile` in `agent/internal/agent/service_linux.go`) still has `ProtectSystem=full` and `ProtectHome=read-only`, so everything outside `/usr`, `/boot` and `/etc` stays writable wherever file permissions allow and home directories stay readable, and a unit in `/etc/systemd/system` takes precedence over the packaged one. It is left as it is on purpose: pipelines may write wherever the host allows (full mode, or a restricted-mode file root from `vectory allow --file-root`), and a strict sandbox would break them silently. **Fix:** the sandbox follows the host's allowances and mode, with one source for both units and a drop-in directory setup never overwrites; the design is part of [the capability tiers decision](../internal/WORK-QUEUE.md#9-capability-tiers-and-managed-assets). **Test:** the generated and the packaged unit agree on the sandbox lines; a restricted-mode file root appears in the generated `ReadWritePaths`.

### 2. Restricted mode accepts ambient cloud credentials

Restricted mode accepts an `elasticsearch` sink with `auth.strategy: aws` and no keys (Vector validated that configuration, and `policy.go` refuses nothing about it). The AWS credential chain then reaches the instance metadata service, which no allowance names; by the schema, `http` and `loki` have the same shape. Not tested against a real metadata service. **Fix:** a reviewed list of ambient-credential shapes in the capability table, refused in restricted mode unless the host grants `instance-credentials` ([ADR 0012](../adr/0012-graduated-capability-tiers.md)). **Test:** the golden fixtures for AWS, GCP and Azure shapes.

### 3. `vectory allow --file-root` does not enforce the state-directory rule

[Installation](../user/installation.md) says never to allow the state directory as a file root, but `validateInstallPolicy` does not enforce it: a root that covers the managed configuration directory could let a pipeline read resolved device secrets, a root that covers a bound secret file (`vectory configure-secrets`) lets a `file` source read it, and a root of `/` covers everything. Reasoned from the code, not tested. **Fix:** refuse `/`, volume roots, and any root that overlaps the state directory, the managed configuration directory, the assets directory or a bound secret file ([ADR 0014](../adr/0014-device-secrets-in-headers-and-urls.md) section 3). **Test:** each refused root, in `install_options` tests and through `vectory allow`.

### 4. A file root covering a socket directory reaches local services

A file root that covers `/run` would let a sink that connects to Unix sockets reach local service sockets. Not reachable with today's restricted component set; it becomes reachable as components are approved. **Fix:** Unix-socket destinations are named exactly (`--network unix:PATH`) and a file root never implies them ([ADR 0012](../adr/0012-graduated-capability-tiers.md)).

### 5. Restricted mode accepts an AWS credentials file that can run a program

The `http`, `loki`, `prometheus_exporter` and `elasticsearch` sinks take `credentials_file` under their `auth` block, and the agent treats it as an ordinary path that only has to lie under an allowed file root. Measured with Vector 0.58.0 (an `aws_s3` sink): a profile file with `credential_process` made Vector run that program during `vector validate`. Exploiting it needs a file under an allowed root that parses as an AWS profile, which is easy once any approved component can write under a root. **Fix:** refuse `credentials_file` in restricted mode (the capability table already refuses it everywhere). **Test:** a policy test per sink, and a native test with the real Vector that the program never runs.

## P3

- Hypothesis, not demonstrated: a flood of a public endpoint delaying writers through the process-wide writer mutex. A control flood showed the same or higher write latency without the lock in the path.

## Residual risks the fixes left

Named by the authors of the fixes; none is a reproduced defect.

- Many addresses can still spend the shared budgets: about ten addresses at 60 a minute reach the 600 a minute shared sign-in budget. Enrollment, installer, downloads, password reset and invite redemption keep no reserve for known operators. The sign-in reserve (100 of the 600) is opened by any completed sign-in, including a low-privilege account's, and lives in memory.
- Valid ClientHellos that then stall still hold a handshake slot for up to 10 seconds. Slots are the connection limit divided by eight, clamped to 128 to 4,096 (2,048 by default); there is no per-address cap on handshakes in flight.
- An `accept()` error the listener does not recognize is treated as passing (a pause of at most 100 ms, one log line per 10 seconds) and never ends the server, so a permanent error of an unknown kind would retry quietly.
- The combined sign-in form: anyone who knows a password can lock it and spend the account's factor budget (the second step pauses for up to five minutes per window) until an administrator resets the password; a right combined code does not clear its wrong-code count; a password step whose second step never completes keeps its reservation (10 per account and client in 15 minutes).
- Enrollment refusals are audited once per (token, reason, minute), which hides a second host retrying the same dead token within that minute.
- The packaged unit was verified with `systemd-analyze verify`, `systemd-analyze security --offline`, its unit test and a read-only mount namespace, not on a running systemd. A path under `/home` probably also needs `ProtectHome=read-only` in the operator's drop-in; that is untested and not documented.
- A restricted device that already runs a version with an `api` block keeps running it but will not start that configuration again after a restart or reboot until a version without the block applies or the host moves to full mode (documented).
- The component ID rule exists twice (Rust in `server/src/validation.rs`, Go in `agent/internal/agent/policy.go`) with no drift test; a shared fixture, as the VRL function lists have, would pin it. The same holds for the restricted top-level setting lists in the agent, server and dashboard.
- The Windows command quoting was measured against PowerShell 7.5 on Linux only, not Windows PowerShell 5.1, and the new native tests have not run on Windows or macOS (on Windows the containment test runs only its refusal half).
- Some regression tests depend on the host: the descriptor-exhaustion tests use `ulimit -n` (POSIX only), two Go subtests skip without the loopback addresses 127.0.0.2 and 127.0.0.3, and the listener test skips when fewer than 140 sockets fit.
- The recorded load measurements in `docs/internal/CAPACITY.md` and `docs/security/SECURITY-REVIEW.md` were taken with 128 handshake permits; the limit now scales with the connection limit, so the runs should be repeated.

## What was attacked and held

Wake-up hint authentication order and bounds; device certificate checks and device CA rotation, including a live test that a retired key is refused; enrollment token normalization, races and idempotence; the install trust chain on POSIX (the pin equals the CA, no `-k`); `vectory allow` symlink and `host:port` matching; most of the notification address blocklist; secret sealing; CSRF; per-role list visibility.

## Not covered

List, sort and filter parameters of the fleet-scale reads; live response headers (security headers were read from source, not from a running proxy); the sample-test change in the validator worker (`server/src/bin/vector-validator.rs`, which holds stdin open until the last sample's output arrives); Windows and macOS hosts; anything after commit `f4d1826`, which includes the publish gate, canary choice, held-device, fleet-scale dashboard and agent adoption work, and the fixes listed at the top.
