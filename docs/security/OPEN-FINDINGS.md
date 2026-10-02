# Open security findings

An independent, read-only source and runtime review of commit `f4d1826`, run against private instances with a real agent and Vector 0.58. It found no way for an unauthenticated peer, a lower role or a device to read a secret, take over an account, cross a role boundary or destroy data. It did find six availability or containment defects that are cheap to exploit, and several smaller ones. **None of the findings below is fixed yet.** Each lists where the code is, what happens, and the regression test that closes it.

Severity: **P1** is exploitable without special access or weakens a stated guarantee; **P2** is bounded or needs a precondition; **P3** is hygiene. Where a step could not be run in the review environment (for example PowerShell, Slack), the finding says so.

## P1

### 1. One address can lock every user out of sign-in, password reset, enrollment and the installer

- **What happens.** The global bucket of each public endpoint is charged before the per-client bucket, and refused calls still count. A client that sends more than the global budget from one address keeps the bucket full for every other address for as long as it keeps sending. Measured with two loopback addresses: 700 failed sign-ins from one address made a valid sign-in from another answer `429`; 350 reset requests blocked reset and invite redemption; 700 enrollment attempts blocked enrollment; 1,250 installer requests blocked `install.sh` for everyone with `Retry-After: 57` while agent downloads (a separate bucket) still answered `200`.
- **Where.** `server/src/auth.rs` `login` (`login-global` 600 per minute runs before `login-client:{group}` at 60); `server/src/accounts.rs` `public_code` (`password-reset-global` 300, no per-client cap; invite redemption); `server/src/device.rs` `enroll` (`enrollment` 600 per minute, then 60 per client); `server/src/install.rs` (1,200 global, then per client); `server/src/ledger.rs` `hit` counts refused calls.
- **Impact.** Remote and unauthenticated. One host at about 10 requests a second keeps sign-in unusable, so the operator who would respond cannot sign in, and it blocks first enrollment, installer downloads and password recovery. Existing sessions and enrolled devices are unaffected.
- **Fix.** Check the per-client bucket first and charge the global bucket only for requests that passed it. Reserve a small share of the global bucket for clients that recently authenticated (`login-known` already exists). Add a per-client cap to `password-reset-global`.
- **Test.** 700 bad sign-ins from address A, then a valid sign-in from address B succeeds; the same for reset, enrollment and installer. A unit test that a request refused by the per-client bucket does not advance the global counter.

### 2. Combined password and TOTP sign-in has no limit on guessing the second factor

- **What happens.** Posting `{email, password, totp_code}` to `/api/v1/login` refunds the failure budget right after the password check (`keys.succeeded`), and `mfa::verify_login` has only replay protection, no attempt counter. The five-attempt lock of the two-step challenge never applies. With a known password, only the per-client limiter of 60 a minute applies. The verifier accepts three time steps, so each guess succeeds with probability 3 in 10^6: about 23% a day from one address (arithmetic, not measured). The threat model's "stolen password, five attempts" does not hold for this path.
- **Where.** `server/src/auth.rs` `login` (the `succeeded` call near the password check); `server/src/mfa.rs` `verify_login`; the two-step path in `server/src/login_challenges.rs` is the correct pattern. The dashboard uses the two-step form; the combined form is kept for existing clients.
- **Fix.** Call `succeeded` only after the factor verified (or when the account has none), and count wrong factors against the same per-account budget as the challenge. Better: remove the combined form once the CLI uses the challenge.
- **Test.** A correct password plus six wrong codes from two addresses ends in `SIGNIN_THROTTLED` or `MFA_TOO_MANY_ATTEMPTS`; a correct code inside the lock is refused too.

### 3. One failed `accept()` on the agent listener ends the whole server

- **What happens.** In `serve_tls`, `listener.accept().await?` propagates the first error out of the accept loop and out of `main`, so the dashboard exits as well as the agent listener; parked wake-up waits are dropped instead of answered. Reproduced with a low descriptor limit and about 400 raw connections. At a production limit it needs proportionally more sockets, but the path is unconditional for any transient `accept()` error, including `ENFILE` caused by another process.
- **Where.** `server/src/device.rs` `serve_tls` (the `accept().await?`); `server/src/main.rs` (the `select!` over `axum::serve` and `serve_tls`).
- **Fix.** Treat `accept()` errors as recoverable: log, back off 10 to 100 ms on `EMFILE`, `ENFILE`, `ENOBUFS`, `ENOMEM`, continue on `ECONNABORTED` and `EINTR`, return only when the listener is unusable. Do the same for the dashboard listener if `axum::serve` can surface it.
- **Test.** `serve_tls` with an injected listener that returns `Err(EMFILE)` once and then a real connection serves the second connection. An integration test with a low descriptor limit asserts `/api/v1/status` still answers.

### 4. 260 idle raw connections make a real device request fail for several seconds

- **What happens.** Each accepted connection waits for one of 128 handshake permits and then up to 10 seconds for a ClientHello. A connection that sends nothing holds its permit for the full 10 seconds. With 260 such sockets a real device's request failed after 10 s (connection reset), then took 2.7 s, then recovered once the flood stopped. A continuous flood keeps the effect continuous. The server stays up (unlike finding 3).
- **Where.** `server/src/device.rs` `serve_tls` (`handshakes = Semaphore::new(128)`, the 10 s acquire and accept timeouts).
- **Fix.** A read-idle timeout well under 10 s for a connection that has sent no bytes, independent of the handshake-completion timeout, and size the handshake semaphore relative to `VECTORY_MAX_AGENT_CONNECTIONS`.
- **Test.** Open 200 raw sockets and assert a concurrent mutually authenticated request completes within a fixed short bound (for example 2 s).

### 5. Restricted mode lets a pipeline open Vector's unauthenticated local API

- **What happens.** A restricted-compatible pipeline containing `"api": {"enabled": true, "address": "127.0.0.1:8686"}` is accepted. Vector's API has no authentication, so any local user (even uid 65534) can run `vector tap` and read live events, including secrets in log lines. Reproduced on a real restricted agent.
- **Where.** `agent/internal/agent/policy.go` (`case "api"` accepts a loopback address); `server/src/rollout.rs` `requires_full_mode` (`api` is in the restricted roots).
- **Fix.** Refuse a top-level `api` block in restricted mode in both places with a stable code. Vectory injects its own loopback API only where a feature needs one (see [the event sampling plan](../internal/TAP-IMPLEMENTATION-PLAN.md), WP0).
- **Test.** A policy test that a restricted device refuses `{"api":{"enabled":true,"address":"127.0.0.1:8686"}}`, and a server test that `requires_full_mode` returns true for it.

### 6. The Windows Add device command can be injected through typographic quotes

- **What happens.** `quote()` for Windows doubles only the ASCII apostrophe. PowerShell also treats U+2018, U+2019, U+201A and U+201B as single-quote characters, so a value containing one closes the string and the rest runs in the elevated shell the operator pastes the command into. The generated command looks correct because the glyphs are near-identical. The last step (PowerShell's parsing) is documented language behavior that was not executed in the review environment.
- **Where.** `dashboard/src/enrollmentCommands.ts` `quote()`. The same builders exist in `hostApprovalCommands.ts` and any other Windows command builder.
- **Fix.** For Windows, double each of U+2018 to U+201B inside the single-quoted string (as for `'`), and reject control characters; reject the same characters in fields the UI validates.
- **Test.** `enrollmentCommands.test.ts`: for each of the four characters, `quote("a’; calc; ’", "windows")` contains no unescaped quote character.

## P2

### 7. Absolute-path component IDs make Vector create state outside `data_dir`

A component named `/some/dir/snk` makes Vector join the ID onto `data_dir` for checkpoints and disk buffers, and an absolute path replaces the base. A real restricted agent created buffer files outside its state directory and outside every allowed file root. A publisher can create directories and Vector's fixed-name files anywhere the service account can write; names and content are constrained, so this is a containment gap, not code execution. **Where:** `server/src/validation.rs` `validate` (component ID checks: empty, longer than 128, contains `.`); `agent/internal/agent/policy.go` ignores component IDs. **Fix:** reject IDs containing `/` or `\`, and any character outside `[A-Za-z0-9_-]`, in `validate` and in `policy.go`. **Test:** `"/tmp/x"` and `"a/b"` are refused in both.

### 8. Slack-style webhook payloads carry the headline unescaped in the top-level `text`

An editor who names a pipeline `<!channel> <@U123ABC> *bold* <https://evil.example|click here>` gets the blocks escaped but the top-level `text` field (bounded to 300 characters) raw. Slack renders `text` as fallback text with its markup, so this may trigger a channel-wide mention or a disguised link (Slack was not run; this is a hypothesis). **Where:** `server/src/notifier.rs` `webhook_body`. **Fix:** pass `text` through `slack_escape` for Slack destinations and keep the raw headline only in `event.headline` of the generic format. **Test:** a headline with `<`, `>` and `&` yields an escaped `text`.

### 9. The packaged systemd unit is weaker than it was

`packaging/systemd/vectory.service` has `ProtectSystem=full` where it had `strict`, `ProtectHome=read-only` where it had `true`, and `ReadWritePaths` changed to `-/var/lib/vectory-agent -/etc/vectory/managed`. Under `full`, everything outside `/usr`, `/boot` and `/etc` is writable wherever file permissions allow, and home directories are readable; finding 7 or any Vector escape then reaches more of the host. **Fix:** restore `ProtectSystem=strict` with explicit `ReadWritePaths` (the leading `-` is fine) and `ProtectHome=true`; keep `KillMode=mixed`. **Test:** a packaging test that greps the unit for both.

### 10. Refused enrollment attempts with a real token write one audit row each

With a real but revoked, used-up or expired token, 50 refused attempts added 50 audit rows (junk tokens are deduplicated to one). The growth is bounded only by the enrollment limiters, which finding 1 shows are shared. **Fix:** deduplicate per (token id, reason) per window, as for junk tokens. **Test:** 50 refused attempts add at most a handful of rows.

### 11. Azure's platform address is accepted as a notification destination

`168.63.129.16` (the Azure WireServer, reachable from every Azure VM and not link-local) is classified public, so a webhook destination pointing at it is accepted even though the policy blocks every other cloud metadata address. **Where:** `server/src/outbound.rs` `classify_v4` (the explicit metadata list beside `100.100.100.200` and `192.0.0.192`). **Fix:** add it to that list, with the same message. **Test:** the existing metadata table in `outbound.rs` gains the address, also with private addresses allowed.

## P3

- The pinned install command writes `vectory-ca.pem` and `vectory-install.sh` with fixed names in the current directory and runs the script with `sudo sh` after `sha256sum -c`. A local user who can write that directory can swap the file between the check and the run. Use a `mktemp -d` and keep the check and the run in one shell function. The `curl -L` also lacks `--proto =https --proto-redir =https`.
- `login` marks a client as known after the password alone, so a password holder without the second factor is exempt from the account-wide throttle for that window (`SignInKeys::succeeded`). Fixing finding 2 covers it.
- Hypothesis, not demonstrated: a flood of a public endpoint delaying writers through the process-wide writer mutex. A control flood showed the same or higher write latency without the lock in the path.

## What was attacked and held

Wake-up hint authentication order and bounds; device certificate checks and device CA rotation, including a live test that a retired key is refused; enrollment token normalization, races and idempotence; the install trust chain on POSIX (the pin equals the CA, no `-k`); `vectory allow` symlink and `host:port` matching; most of the notification address blocklist; secret sealing; CSRF; per-role list visibility.

## Not covered

List, sort and filter parameters of the fleet-scale reads; live response headers (security headers were read from source, not from a running proxy); the sample-test change in the validator worker (`server/src/bin/vector-validator.rs`, which holds stdin open until the last sample's output arrives); Windows and macOS hosts; anything after commit `f4d1826`, which includes the publish gate, canary choice, held-device, fleet-scale dashboard and agent adoption work.
