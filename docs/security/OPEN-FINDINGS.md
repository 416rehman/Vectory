# Open security findings

An independent, read-only source and runtime review of commit `f4d1826`, run against private instances with a real agent and Vector 0.58. It found no way for an unauthenticated peer, a lower role or a device to read a secret, take over an account, cross a role boundary or destroy data. It did find six availability or containment defects that are cheap to exploit, and several smaller ones. A finding is deleted from this file in the change that fixes it, together with its regression test; what is left below is what is still open, followed by the residual risks the fixes themselves left, which the next independent review should attack first.

Fixed since the review (server side, with regression tests; see the [changelog](../../CHANGELOG.md)): the shared sign-in, reset, invite, enrollment and installer buckets, the combined password-and-code sign-in, the `accept()` loop, idle handshakes, the Slack `text` field, enrollment audit rows, the Azure platform address, the packaged systemd unit, and the server halves of the restricted-mode `api` block and of component IDs. The agent and dashboard halves are listed below.

Severity: **P1** is exploitable without special access or weakens a stated guarantee; **P2** is bounded or needs a precondition; **P3** is hygiene. Where a step could not be run in the review environment (for example PowerShell, Slack), the finding says so.

## P1

### 5. Restricted mode lets a pipeline open Vector's unauthenticated local API (agent half open)

- **What happens.** A restricted-compatible pipeline containing `"api": {"enabled": true, "address": "127.0.0.1:8686"}` is accepted by the agent. Vector's API has no authentication, so any local user (even uid 65534) can run `vector tap` and read live events, including secrets in log lines. Reproduced on a real restricted agent.
- **Fixed.** The server: a version with a top-level `api` block (enabled or not, any address) now needs full mode, so a restricted device is never offered it and the deploy review reports `FULL_VECTOR_MODE_REQUIRED`.
- **Still open.** `agent/internal/agent/policy.go` (`case "api"` accepts a loopback address), and the dashboard's own compatibility check (`dashboard/src/hostRequirements.ts` still lists `api` among the restricted roots and has an "API listener outside loopback" requirement), which now disagrees with the server.
- **Fix.** Refuse a top-level `api` block in restricted mode on the agent with a stable code, and make the dashboard's check agree with the server. Vectory injects its own loopback API only where a feature needs one (see [the event sampling plan](../internal/TAP-IMPLEMENTATION-PLAN.md), WP0).
- **Test.** A policy test that a restricted device refuses `{"api":{"enabled":true,"address":"127.0.0.1:8686"}}`; full mode unchanged.

### 6. The Windows Add device command can be injected through typographic quotes

- **What happens.** `quote()` for Windows doubles only the ASCII apostrophe. PowerShell also treats U+2018, U+2019, U+201A and U+201B as single-quote characters, so a value containing one closes the string and the rest runs in the elevated shell the operator pastes the command into. The generated command looks correct because the glyphs are near-identical. The last step (PowerShell's parsing) is documented language behavior that was not executed in the review environment.
- **Where.** `dashboard/src/enrollmentCommands.ts` `quote()`. The same builders exist in `hostApprovalCommands.ts` and any other Windows command builder.
- **Fix.** For Windows, double each of U+2018 to U+201B inside the single-quoted string (as for `'`), and reject control characters; reject the same characters in fields the UI validates.
- **Test.** `enrollmentCommands.test.ts`: for each of the four characters, `quote("a’; calc; ’", "windows")` contains no unescaped quote character.

## P2

### 7. Absolute-path component IDs make Vector create state outside `data_dir` (agent half open)

A component named `/some/dir/snk` makes Vector join the ID onto `data_dir` for checkpoints and disk buffers, and an absolute path replaces the base. A real restricted agent created buffer files outside its state directory and outside every allowed file root. A publisher can create directories and Vector's fixed-name files anywhere the service account can write; names and content are constrained, so this is a containment gap, not code execution. **Fixed:** the server's `validate` refuses `/`, `\` and control characters in component IDs, memory table names and `source_key`, naming the component and the rule (Vector 0.58 itself refuses only `.`, so nothing else is refused). **Still open:** `agent/internal/agent/policy.go` ignores component IDs. **Fix:** refuse the same set in restricted and in full mode (a state-directory containment issue, not a capability), and refuse an ID that starts with a Windows drive prefix such as `C:x` on both the agent and the server: Vector accepts `:`, and `Path::join` on Windows lets a drive prefix replace the base. **Test:** `"/tmp/x"`, `"a/b"` and `"C:\\x"` are refused by both; ordinary IDs still pass; a native test with the real Vector that the directory outside `data_dir` is never created.

### 9. The unit that `vectory setup` registers is weaker than the packaged unit

The packaged unit (`packaging/systemd/vectory.service`) is fixed: `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=-/var/lib/vectory-agent -/etc/vectory/managed -/var/lib/vector`, `KillMode=mixed`, and a packaging test that keeps it so. The unit that `vectory setup` and `vectory service-install` write (`systemdUnitFile` in `agent/internal/agent/service_linux.go`) still has `ProtectSystem=full` and `ProtectHome=read-only`, so everything outside `/usr`, `/boot` and `/etc` stays writable wherever file permissions allow and home directories stay readable, and a unit in `/etc/systemd/system` takes precedence over the packaged one. It is left as it is on purpose: pipelines may write wherever the host allows (full mode, or a restricted-mode file root from `vectory allow --file-root`), and a strict sandbox would break them silently. **Fix:** the sandbox follows the host's allowances and mode, with one source for both units and a drop-in directory setup never overwrites; the design is part of [the capability tiers decision](../internal/WORK-QUEUE.md#9-capability-tiers-and-managed-assets). **Test:** the generated and the packaged unit agree on the sandbox lines; a restricted-mode file root appears in the generated `ReadWritePaths`.

## P3

- The pinned install command writes `vectory-ca.pem` and `vectory-install.sh` with fixed names in the current directory and runs the script with `sudo sh` after `sha256sum -c`. A local user who can write that directory can swap the file between the check and the run. Use a `mktemp -d` and keep the check and the run in one shell function. The `curl -L` also lacks `--proto =https --proto-redir =https`.
- Hypothesis, not demonstrated: a flood of a public endpoint delaying writers through the process-wide writer mutex. A control flood showed the same or higher write latency without the lock in the path.

## Residual risks the fixes left

Named by the authors of the fixes; none is a reproduced defect.

- Many addresses can still spend the shared budgets: about ten addresses at 60 a minute reach the 600 a minute shared sign-in budget. Enrollment, installer, downloads, password reset and invite redemption keep no reserve for known operators. The sign-in reserve (100 of the 600) is opened by any completed sign-in, including a low-privilege account's, and lives in memory.
- Valid ClientHellos that then stall still hold a handshake slot for up to 10 seconds. Slots are the connection limit divided by eight, clamped to 128 to 4,096 (2,048 by default); there is no per-address cap on handshakes in flight.
- An `accept()` error the listener does not recognize is treated as passing (a pause of at most 100 ms, one log line per 10 seconds) and never ends the server, so a permanent error of an unknown kind would retry quietly.
- The combined sign-in form: anyone who knows a password can lock it and spend the account's factor budget (the second step pauses for up to five minutes per window) until an administrator resets the password; a right combined code does not clear its wrong-code count; a password step whose second step never completes keeps its reservation (10 per account and client in 15 minutes).
- Enrollment refusals are audited once per (token, reason, minute), which hides a second host retrying the same dead token within that minute.
- The packaged unit was verified with `systemd-analyze verify`, `systemd-analyze security --offline`, its unit test and a read-only mount namespace, not on a running systemd. A path under `/home` probably also needs `ProtectHome=read-only` in the operator's drop-in; that is untested and not documented.
- Some regression tests depend on the host: the descriptor-exhaustion tests use `ulimit -n` (POSIX only), two Go subtests skip without the loopback addresses 127.0.0.2 and 127.0.0.3, and the listener test skips when fewer than 140 sockets fit.
- The recorded load measurements in `docs/internal/CAPACITY.md` and `docs/security/SECURITY-REVIEW.md` were taken with 128 handshake permits; the limit now scales with the connection limit, so the runs should be repeated.

## What was attacked and held

Wake-up hint authentication order and bounds; device certificate checks and device CA rotation, including a live test that a retired key is refused; enrollment token normalization, races and idempotence; the install trust chain on POSIX (the pin equals the CA, no `-k`); `vectory allow` symlink and `host:port` matching; most of the notification address blocklist; secret sealing; CSRF; per-role list visibility.

## Not covered

List, sort and filter parameters of the fleet-scale reads; live response headers (security headers were read from source, not from a running proxy); the sample-test change in the validator worker (`server/src/bin/vector-validator.rs`, which holds stdin open until the last sample's output arrives); Windows and macOS hosts; anything after commit `f4d1826`, which includes the publish gate, canary choice, held-device, fleet-scale dashboard and agent adoption work, and the fixes listed at the top.
