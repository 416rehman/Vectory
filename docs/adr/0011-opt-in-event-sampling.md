# ADR 0011: Event sampling is opt-in on the host, bounded, redacted on the device and audited

Proposed 2026-09-30. Nothing described here is built. The design was measured on the pinned Vector 0.58.0 ([Appendix A](#appendix-a-proof-of-concept)) and is written to be attacked before any code exists. Existing behavior is cited by file and function as read at commit `abac209`. The wake-up feature (`GET /agent/v1/wait`) is newer than that commit and is cited from commit `4a41669`.

## Verdict

**Ship only on Linux and macOS first.** Not on Windows in version 1. Linux is measured here; macOS is enabled only after the same measurements (Appendix A, experiments C6, D6, E1 to E3) pass on a native macOS runner. One prerequisite comes first (work package 0 in the [implementation plan](../internal/TAP-IMPLEMENTATION-PLAN.md)).

1. **The mechanism works and stays out of the deployment path.** Reloads that only add or remove an `api` block in the runtime overlay opened and closed Vector's API twice each with no lost or duplicated events, in 1 to 5 ms where Vector did not rate-limit the log line that times it. The managed file, its digest, last-known-good and the journal are never touched.
2. **Vector 0.58.0 imposes three hard constraints, all measured.** A reload can only enable the API on `127.0.0.1:8686`, whatever address is configured. A failed bind stops Vector. Streams already attached survive the API's removal until Vector exits. So a random port is impossible, a busy port is an outage, and "the window closed" needs proof and, when another client is attached, a restart.
3. **The API has no authentication.** Any local user can read every component's raw events while it is open, and can keep a stream open after it closes. Consent is per host and says so. The window is short, watched and force-closed, which is why hosts with untrusted local users must not allow it.
4. **Redaction cannot make value sampling safe for production hosts.** Free text carries secrets no rule can find. The default mode is `shape` (field names, types and sizes only). `values` (redacted values) is an explicit host choice meant for sandbox and staging hosts.
5. **The host does not own the API today.** Restricted mode accepts a loopback `api` block set by the pipeline (`CapabilityPolicy.Check` in `agent/internal/agent/policy.go`, `requires_full_mode` in `server/src/rollout.rs`, [security model](../user/security.md)). Any publisher can turn on the tap surface for local users now. Close that first.

## Context

**What the specification requires.** Only the agent opens connections (section 1, line 29). There is "no production event tapping by default" (section 9, line 221) and "no tap or raw event sampling by default" (section 11, line 273). Vector's API "has no authentication" and stays on loopback (section 11, line 271). The [security model](../user/security.md) promises "Your events stay yours". An explicit, host-approved, bounded mechanism does not contradict these if the default stays off and nothing a server or an operator can do enables it remotely. This ADR keeps to that.

**What people need.** Real events from a real device, to write VRL and unit tests against. Today `dashboard/src/SyntheticTester.tsx` accepts only hand-written samples, and `dashboard/src/sampleStore.ts` says so: "Samples are user-written test data; they never come from devices."

**What Vector 0.58.0 does** (measured; experiment letters refer to Appendix A):

- The `api` block has two options, `enabled` and `address` (default `127.0.0.1:8686`). It has no authentication. The observability service has eight methods, all `Get*` or `Stream*` (`GetMeta`, `GetComponents`, `StreamOutputEvents` and five more); none is named for a change.
- The address is honored only when the process starts. Enabling the API by reload binds `127.0.0.1:8686` and ignores the configured address, whichever file carries the block (A, B4, C1). Changing the address while the API runs is ignored (B2).
- A failed bind stops Vector: at startup (C5) and at reload (C6, "Vector is stopping").
- Removing the block, or `enabled: false`, on reload closes the listener (B3, B5). **A stream that is already attached keeps flowing** for at least 25 seconds and through later reloads; only stopping Vector ended it (E3, E4, E5).
- Across several config files `enabled` is an OR, the address comes from whichever file sets it, and two different addresses are refused (C2 to C4, G2 to G4). An overlay can neither switch off a pipeline's API nor override its address.
- `vector tap` writes events to stdout as `{"log":{...}}` and status lines to stderr. It exits 0 for an unknown component, an idle component, a sink's outputs, the end of `--duration-ms` and (with `--no-reconnect`) a lost connection. It exits 2 for invalid `--limit` or `--interval` and 69 when the API is unreachable. With no component argument it taps everything. Its argument is a comma-separated list of glob patterns. `--limit` is per interval and Vector drops the excess. A limit of 1,000,000 or more returns nothing (D, F1, H).
- Vector accepts component IDs containing spaces, commas, `*`, brackets, quotes, a leading `-` and even a newline. Only `.` is refused (F1g).
- Any local user, with no credential, can tap every component including raw source output, call `GetMeta` and `GetComponents`, and read `/health` (E1, E2).
- A tap costs almost nothing when polite and a lot when abused (F2b).

**What Vectory does today that matters:**

- Restricted mode allows a loopback `api` block, and full mode allows any. The [security model](../user/security.md) lists "a loopback-only `api`" among restricted-mode global settings, and [ADR 0005](0005-restricted-mode-by-default.md) describes the allowlist.
- The agent already loads a second config file next to the managed one, the runtime overlay (`runtimeOverlay`, `writeRuntimeOverlay` and `vectorConfigArgs` in `hostruntime.go` and `vector.go`; `host-runtime.json` in the state directory). It exists so the managed file stays byte-identical to its verified digest. `VectorDriver.Activate` regenerates it from scratch on every apply and restart.
- Unix reloads Vector with SIGHUP (`reloadChild` in `process_linux.go`, `process_darwin.go`). Windows never reloads: `VectorDriver.canReload` returns false and `reloadChild` is empty in `process_windows.go`.
- `settings.json` is written only by locked local maintenance (`lockSettingsMaintenance`, `loadSettingsDocument`, `settingsDocument.save` in `settings_update.go`), and only from CLI commands.
- The signed manifest is verified by `VerifyEnvelope` (`protocol.go`), which decodes with `json.Unmarshal` into `Manifest` (`types.go`): unknown fields are ignored, so an additive signed field is backward compatible.
- Sample sets are stored in browser `localStorage` (`vectory.samples.v1:<user>:<pipeline>`), and "Create unit test" (`unitTestFromSample` in `dashboard/src/sampleTests.ts`) writes into the draft, which becomes immutable revisions, published versions, exports and backups.

## Decision

- **Consent lives on the host.** A dedicated command, `vectory configure-sampling --allow`, writes `event_sampling` into the local `settings.json`. Absent, unreadable or malformed means off. No manifest field, policy, installer flag or dashboard action can write it.
- **The mechanism is a short API window opened by reload.** On Linux and macOS the agent adds an `api` block to the runtime overlay, reloads Vector, runs the adopted binary's `vector tap` against `127.0.0.1:8686`, then removes the block, reloads, proves the window is closed and restarts Vector if any other client stayed attached. Windows is unsupported in version 1.
- **A request rides the signed manifest.** A new top-level `sampling` object in the signed payload, bound to the device UUID, the heartbeat nonce and a per-device generation the agent persists before acting. The wake-up hint may make the agent check in sooner and nothing more.
- **Redaction happens on the device, always.** Two modes: `shape` (default) and `values`. There is no raw mode. Requests cannot change redaction.
- **The server keeps samples in memory only,** for 15 minutes, readable by the requester alone. The database, audit log, exports and backups hold metadata and counts, never events.
- **Copying a sample into a VRL sample set or a unit test is a separate, explicit, audited step,** because it makes the data durable.

## 1. Consent

**Decision.** The host says yes in `settings.json`:

```json
"event_sampling": {
  "allowed": true,
  "mode": "shape",
  "max_events": 20,
  "max_seconds": 30,
  "max_bytes": 131072,
  "redact_fields": ["customer_id"],
  "hash_fields": [],
  "min_gap_seconds": 30,
  "max_sessions_per_hour": 12,
  "granted_at": "2026-09-30T00:00:00Z"
}
```

The object is a new `Settings.EventSampling` field in `agent/internal/agent/types.go`. The command is `vectory configure-sampling --allow [--values] [--max-events N] [--max-seconds N] [--max-bytes N] [--redact-field NAME]... [--hash-field NAME]... [--yes]`, and `vectory configure-sampling --off` removes it. Bounds: events 1 to 100, seconds 5 to 120, bytes 8 KiB to 512 KiB, at most 64 extra field names each. Without `--values` the mode is `shape`. The command prints the consent text below and needs a typed yes or `--yes`. Like `configure-metrics` and `configure-secrets`, it runs while the agent is stopped, under `lockSettingsMaintenance`, and preserves ownership and access through `preserveSettingsSecurity`. On Windows it refuses.

> **Allow event sampling on this host?**
> While a sampling window is open (up to 30 s, at most 12 an hour), Vector's own API listens on 127.0.0.1:8686 with no password. Any user on this machine can read every event of every component until it closes. Vectory closes the window, checks that nothing stayed connected, and restarts Vector if something did.
> Only field names, types and sizes leave this host. (`--values`: Up to 20 events per request leave this host with secrets and common credential patterns redacted. Redaction is best effort: free text can still contain secrets.)
> Allow this only where every local user may read these events. Undo it with `vectory configure-sampling --off`. Stop it at once with `vectory pause`.

**Why.** Every other host consent already works this way: `install --allow-full-vector-config` (`ConfigureFullVector` in `reconcile.go`), `configure-secrets`, `configure-metrics`. The stopped-agent rule gives grant and change an explicit checkpoint. Reusing `settings.json` keeps one place that says what the host allowed, one ownership-preserving writer and one status view.

**While it is allowed.** The device page shows an "Event sampling" card: "Allowed on this host", the mode, the caps and the last session. While a request is open it shows "A sampling window can be open on this host until 14:03:20. Any user on that machine can read its events until then." The card states that the host owner set it and that Vectory cannot change it. `vectory status` and `vectory doctor` print the same facts. The agent reports the state in the heartbeat's `sampling` block. That report is unsigned and only steers the UI; the agent enforces consent on every request.

**How a host revokes.**

- `vectory pause` is instant. A paused device (local or remote) refuses to start a session, and a session in flight stops within 500 ms: the agent kills its tap, discards the events, closes the window and reports `PAUSED`. Pause also protects hand edits: a reload re-reads the managed file, so the agent never reloads for sampling while a device is paused or drifted.
- `vectory configure-sampling --off` removes the consent durably. It needs the agent stopped, and stopping the service stops Vector, which ends any window and any attached stream.

**Can a remote policy, a compromised server or a compromised operator turn it on? No.** The proof, by code path:

1. The agent reads consent only from `Settings`, loaded by `LoadSettings` (`storage.go`) and `loadSettingsDocument` (`settings_update.go`).
2. `settings.json` has exactly these writers: `ConfigureMetrics` and `ClearMetrics` (`telemetry.go`), `ConfigureSecretFiles` (`secrets.go`), `ConfigureFullVector` (`reconcile.go`), `InstallWithOptions` (`install_options.go`), `EnrollWithOptions` (`enrollment_options.go`), `Unenroll` (`recovery.go`), `PurgeState` (`lifecycle.go`) and `ReAdopt` (`readoption.go`). Each is called from a command in `agent/cmd/vectory/commands.go` or `setup.go` with values from the command line. None accepts a `Manifest`, `Policy` or response body.
3. The only network-decoded control data is the manifest. `Engine.Poll` (`reconcile.go`) stores it in `State` (`state.json`), and `Policy` has three fields: `heartbeat_seconds`, `sync_paused`, `telemetry_enabled` (`types.go`). Nothing converts a manifest field into a `Settings` field.
4. `ReadInstallPolicy` (`install_options.go`) rejects any field of the allowances file other than the four capability fields, so that file cannot carry consent.
5. The server-rendered `install.sh` ends in `vectory setup ... "$@"` ([contract](../../contracts/CONTRACT.md), `GET /install.sh`). To keep a hostile installer from granting consent, `setup`, `install` and `enroll` never gain a sampling flag; only `configure-sampling` sets it.
6. Two tests pin this (A-02, A-03): the settings bytes are identical before and after the agent processes manifests that carry every hostile shape, and a source scan fails if any function outside the list above reaches a settings writer or if any flag of `setup`, `install` or `enroll` mentions sampling.

A compromised agent process or a local administrator can edit `settings.json`. That is outside what remote checks can protect, as the [threat model](../security/THREAT-MODEL.md) already says for local administrators.

## 2. The API window

**Decision.** On Linux and macOS the agent opens the API with a reload of the runtime overlay and closes it the same way. Steps:

1. **Preconditions,** all checked under the agent's single goroutine (`Run` in `reconcile.go`), so no apply can overlap: consent present; not paused (local or remote); no `journal.json`; apply state settled (`verified_applied`); managed file digest equals `State.LastGoodSHA256`; Vector alive and verified (`Driver.Alive`); the managed file contains no `api` key at all; the component ID passes the ID rule (section 4) and exists in the managed file; the request's side fits the component kind; rate limits allow it.
2. **Port probe.** Bind and release `127.0.0.1:8686`. If that fails, refuse with `PORT_IN_USE`. This matters because a failed bind at reload stops Vector (C6).
3. **Candidate.** The overlay is the ordinary overlay content plus `{"api":{"enabled":true,"address":"127.0.0.1:8686"}}`. `vector validate` runs on the managed file and a staged copy of that overlay (`VectorDriver.Validate` already stages one).
4. **Open.** A new driver method writes the overlay with `writeRuntimeOverlay`, sends the reload byte to the supervisor and waits for "Vector has reloaded." plus the liveness observation (`VectorDriver.reload`). It never calls `Activate`, which would regenerate the overlay without the block. The agent then proves the window is open by a TCP connect and `GET /health` returning `{"ok":true}`, and takes a baseline of the connection table.
5. **Sample** (section 4), polling every 500 ms for pause, Vector exit and foreign clients.
6. **Close.** Kill the tap. Write the overlay without the block, reload, then prove closure: a connect to 8686 is refused, and after the tap has exited no established socket has local port 8686. Linux reads `/proc/net/tcp`. macOS reads `/usr/sbin/netstat -anp tcp`. If the table cannot be read, closure is unproven and the agent restarts Vector.
7. **Enforce.** If any client is still attached, restart Vector through the ordinary verified path (`Driver.Stop` then `Driver.Activate`) and report `closed_by: foreign_client` and `vector_restarted: true`. A client that connects during the window, before close, aborts the session at the next poll and the events are discarded.
8. **Report.** The result goes out in the heartbeat and the upload.

**It touches nothing that carries deployment evidence.** The managed file, `State.LastGoodSHA256`, `AppliedTemplateSHA256`, the journal and the template digest are never written. A crash at any step leaves at worst an overlay with the block on disk. That block dies at the next `Activate`, which rebuilds the overlay from scratch, and an agent crash already closes the supervisor's stdin, which stops Vector (`vectorHost` in `vector.go`), which closes the API. Test A-07 injects a crash at every step.

**Windows: unsupported in version 1, with no second consent.** There is no reload, so opening the window is a restart (where the address would be honored) and closing it is a second restart. Two restarts per session interrupt delivery, and the specification says restart is not lossless or duplicate-free (section 8, line 207). A "consent to restart" would be a different and heavier decision than event visibility. The consent command refuses on Windows, and the heartbeat reports `platform` as the reason sampling is unavailable, so the dashboard says "Event sampling isn't available on Windows yet."

**What a hostile local user can do in the window, and what limits it.** With no credential: tap any component, raw and unredacted, including sources; list components and types; read `/health` (E1, E2). Worse, a stream attached before the window closes keeps flowing after it closes (E3). Random ports and short windows do not help: a listener is visible to every user in `/proc/net/tcp`, and the port is fixed anyway. Nothing on the host can authenticate this API. What limits the damage:

- Consent is per host and names the exposure. Hosts with untrusted local users must not allow sampling.
- The window is at most `max_seconds` (default 30, cap 120), at most `max_sessions_per_hour` (default 12) and at least `min_gap_seconds` apart (default 30). At the defaults the API is open for at most 10% of an hour.
- The agent polls the connection table every 500 ms, aborts on a foreign client, and discards the events. After closing it restarts Vector if any client remains, so the exposure ends with the window instead of with the attacker's patience.
- The API has no method that changes anything. The eight methods are reads and streams.
- What remains: a foreign client can read whatever passes in up to 500 ms before detection, and can crash Vector by squatting port 8686 (next paragraph). Both need a consenting host and an operator's request.

**If the port is busy or squatted.** The probe refuses without touching Vector. A local user who binds 8686 between the probe and Vector's bind makes the reload stop Vector; the agent's supervision restarts it with the ordinary backoff and the overlay is regenerated without the block. That is an availability cost a local user can impose only during a requested window. The plan measures it (A-15).

**If the pipeline already defines an `api` block.** Sampling refuses with `PIPELINE_DEFINES_API` and the device page says so. The overlay cannot help: `enabled` ORs across files, the address comes from the pipeline, and a different address is refused (C2 to C4, G2 to G4). If the pipeline's block is enabled, the API is already open and permanent, which is exactly the exposure this ADR exists to avoid. That is why work package 0 makes restricted mode refuse `api` in pipelines. Full mode stays as it is (publishers there are trusted with the host), but sampling stays unavailable and the device page warns "This pipeline turns on Vector's own API. Anyone on this host can read its events."

## 3. Request and authorization

**Who.** Operators and Administrators. Editors and Viewers get 403. The server has no permission enum: `auth::authorize(state, headers, roles, mutation)` takes a per-route role list, and administrators always pass. So the route is `roles = ["operator"]`. A new `sample_events` permission would invent an abstraction the code does not have; the role list is where a future finer model would plug in. Reading a sample's events is narrower than requesting it: the requester only (below).

**Scope and bounds.** One device per request; the path names it (`POST /api/v1/devices/{id}/sampling`) and there is no group or fleet route. Body (strict, unknown fields rejected): `request_id` (UUID, the idempotency key used elsewhere in the contract), `component_id`, `side` (`outputs` or `inputs`), optional `max_events` (1 to 100, default 20) and `max_seconds` (5 to 120, default 30), and a mandatory `reason` of 8 to 200 printable characters. The bytes cap is the host's, not the operator's. CSRF is required (`x-csrf-token`, and `sec-fetch-site: cross-site` is refused, as in `authorize_in`). Limits: 6 requests a minute per user, 12 an hour per device, one open request per device (a partial unique index), 64 open requests instance-wide. `VECTORY_EVENT_SAMPLING=off` removes the routes (404 `SAMPLING_DISABLED`) and the manifest feature, like `VECTORY_AGENT_WAKE_LIMIT=0` does for waits.

**How it reaches the agent.** In the signed manifest, never the wake hint. The heartbeat handler (`heartbeat` in `server/src/device.rs`) adds a `sampling` object to the payload it signs, next to `features`, when an open request exists for the authenticated device:

```json
"sampling": {"id": "…", "generation": 7, "component_id": "remap", "side": "outputs", "max_events": 20, "max_seconds": 30}
```

The payload already carries the device UUID, the agent's fresh nonce, `issued_at` and `expires_at` (five minutes). The request state moves `requested` to `delivered` on first inclusion and the request is included in later manifests until it expires, so a lost response is retried at the next check-in. The unsigned wake hint stays a hint: when a request is created, the server nudges the device's parked wait so it answers `changed:true`, and the agent checks in and receives the signed object. The wait's entry query also treats a `requested` row as changed, and `delivered` rows do not, so there is no wake loop. A forged wake can only cause an early heartbeat; the wake-up contract at commit `4a41669` says the same.

**What the agent verifies before acting,** in this order, refusing with a code in its next heartbeat:

1. `VerifyEnvelope`: signature, recipient device UUID, nonce echo, validity window, generation floors.
2. The manifest lists `event_sampling` and the manifest is unexpired at the moment the session would start (`m.ExpiresAt`, the same test `Reconcile` applies before commit).
3. `generation` is greater than `State.HighestSamplingGeneration`, which the agent persists in `state.json` before doing anything, exactly as it persists `HighestGeneration`. A replayed or reordered request is refused, and a crash after persisting does not run it twice.
4. Consent (section 1) and host caps: the effective limits are the minimum of the request and the host.
5. The component ID matches `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`, exists in the managed file, and the side fits its kind (sources: `outputs`; transforms: either; sinks: `inputs`).
6. The section 2 preconditions, rate limits and platform.

The server never trusts the reported consent: it only avoids creating requests that would be refused. The agent's checks stand alone. A compromised server can sign any request, so consent, caps, the agent's own rate limits, the ID rule and redaction are what bound it, not the signature. Restoring an older server backup could lower the server's sampling generation; the agent then refuses new requests as stale, and `vectory-admin`'s generation fence (`server/src/maintenance.rs`) is extended to raise it from the reported `highest_generation`.

## 4. Execution and redaction

**What runs.** The pinned binary's `vector tap`, executed by the agent after `checkBinary` verifies its digest, with an argument array (no shell), the scrubbed environment (`cleanEnvironment`, no `VECTOR_URL`), no stdin and no inherited handles:

```text
vector tap --url http://127.0.0.1:8686 --outputs-of=<id> --limit <max_events> --interval 500 --duration-ms <max_seconds*1000> --format json --no-reconnect
```

`--inputs-of=<id>` for the `inputs` side. Notes: the equals form is required, because `--outputs-of -x` is a usage error (exit 2) while `--outputs-of=-x` is taken as a pattern (H3). `--no-reconnect` is required, because the default reconnects forever after Vector stops (G1). The agent does not use `-q`: stderr's `[tap] Pattern 'x' successfully matched.` and `failed to match` lines are how it tells "unknown" from "idle" (H1, H2). It counts stdout lines itself and kills the client at `max_events`, because `--limit` is per interval. It never closes the pipe early: a closed pipe makes the client panic (exit 101, A). Exit 0 is not evidence of success (a lost connection also exits 0), so the agent compares elapsed time and `Driver.Alive`.

The ID rule exists because Vector accepts IDs that tap reads as patterns: a component named `*` or `a,b` would select others, and one named `-x` is a flag (F1g, H3, H4). A pipeline author controls IDs, so an ID outside the rule is not sampleable and the dashboard says "Rename this component to use letters, digits, `_` or `-` to sample it."

**Limits.** Wall clock `max_seconds` plus 5 s (context deadline, `WaitDelay` 1 s, then kill). Raw bytes read at most 1 MiB. At most 100 events, 16 KiB each, `max_bytes` after redaction (default 128 KiB, cap 512 KiB). Stderr keeps 4 KiB. One session at a time, on the agent's single goroutine.

**Why not a direct gRPC client.** It would add a protobuf and gRPC stack (size and supply-chain surface) to a binary whose selling point is small and pure Go, and duplicate a client that ships in the pinned, digest-verified binary the agent already executes for validation. The client's measured cost is 30 to 35 MB of memory and 1 to 2% of a core when abused.

**What leaves the host.** One upload (section 5): the component's ID, kind and type; the side; the mode; the redacted events; counts (seen, kept, non-log, truncated, redactions by rule); timestamps; how the session ended. Log events only: metric and trace events (shape `{"metric":...}`, F1f) are counted and dropped in version 1.

**Redaction is by default and cannot be turned off remotely.** It runs in the agent, streaming, so a raw line is dropped as soon as its redacted form exists and no raw event is written to disk or logged. The request has no redaction field, the manifest has none, and no policy reaches it. There is no raw mode: the upload function accepts only the type the redactor returns, and test A-11 pins that. Rules, applied in this order to every log event (depth at most 16, arrays at most 64 items, maps at most 256 keys):

1. **Field names.** Case-insensitive, on the last key segment and the dotted path. Substring match for `password`, `secret`, `token`, `credential`, `apikey`, `api_key`, `api-key`, `private_key`, `passphrase`, `authorization`; whole-segment match for `auth`, `pwd`, `passwd`, `cookie`, `set-cookie`, `session`, `bearer`, `jwt`, `signature`. The whole subtree becomes `«redacted»` (the marker `redactedToken` in `diagnose.go`).
2. **Secret-bound values.** Every value the agent holds for a bound local secret (`Settings.SecretFiles`, read with `readLocalSecret`), every credential leaf of the effective configuration, and, in full mode, every referenced environment value (what `redactor.learnConfiguration` already learns via `addSecret`) is replaced wherever it occurs inside a string. Values of four bytes or more match as substrings; shorter ones match as whole words only (`replaceWord`), the trade-off the diagnostics redactor already documents. Values never leave; names are already reported (`secret_names`).
3. **Patterns,** in strings and keys: `Authorization`-style `Bearer`/`Basic`/`Token` values, JWTs, AWS access key IDs, PEM private-key blocks, `scheme://user:pass@` userinfo, `password=`, `token=`, `secret=` and `api_key=` pairs (value to the next delimiter), and any run of 40 or more `[A-Za-z0-9_-]` characters. These are heuristics; they miss some secrets and hit some identifiers (a 64-character SHA-256 is redacted).
4. **Truncation.** Strings over 1,024 bytes are cut at a character boundary and end `…«truncated N bytes»`. An event over 16 KiB after redaction becomes `{"«truncated»":"event larger than 16 KiB","bytes":N}`.
5. **Host extras.** `redact_fields` names more fields for rule 1. `hash_fields` (values mode) replaces a value with `«hash:xxxxxxxx»`, the first 8 hex characters of an HMAC-SHA-256 under a random per-session key held in memory, so equal values match within one session and cannot be looked up in a dictionary.
6. **Shape mode,** after rules 1 and 2: every leaf becomes a typed placeholder: `«string:24»` (byte length), `«number»`, `«bool»`, `«timestamp»` for RFC 3339 strings, `null` stays `null`; arrays keep their length and show at most three items. Keys and nesting stay, after rule 3 on keys. Only structure leaves the host.

**What redaction does not guarantee.**

- A secret inside free text that matches no rule (a password typed in a chat message, a token split across fields, a secret in base64, hex or another encoding).
- A native-provider or `SECRET[...]` value the agent cannot enumerate: in full mode with native secret backends, rule 2 cannot cover those values.
- Personal data (names, email addresses, IP addresses, identifiers) that is not a secret. The field-name rules do not include personal data.
- Field names and structure themselves, which can identify a customer or a system.
- Secrets under four bytes inside longer words.

**What that means for who may sample what.** `shape` mode is safe to allow widely: the exposure is field names, types, lengths and event rates. `values` mode should be allowed only on sandbox and staging hosts, or on hosts whose event data every Operator and Administrator may see, and never where events carry regulated or third-party personal data. This is why `shape` is the default and `--values` is a separate, named choice on the host. The device page shows the mode, and the viewer states it.

## 5. Upload and storage

**Route.** `POST /agent/v1/samples` on the agent listener (mTLS, same authentication as `heartbeat`; identity comes from the certificate, never the body). The body is at most 1 MiB by the existing limit and the server refuses more than 512 KiB of sample (413 `PAYLOAD_TOO_LARGE`). Rate limit 6 a minute per device. The handler validates structure and bounds in memory before it takes the writer lock, and holds the lock only for one state transition.

**Replay protection.** The upload is bound to a request the server created: `id` (a server UUID), `generation`, and the device from the certificate. The request state is a one-way machine (`requested`, `delivered`, then one of `complete`, `empty`, `refused`, `aborted`, `cancelled`, `expired`). A first upload moves `delivered` to a final state. A second upload for the same request is answered `409 CONFLICT` and stores nothing; an upload for another device's request is `404` (object-level authorization); an upload after expiry or cancellation is `410 SAMPLING_EXPIRED`. Nothing an agent sends can move a request backwards.

**Storage.** Memory only, in a bounded map inside the server process: at most 32 samples and 16 MiB in total, one per device, 4 per user. Kept for 15 minutes after completion, then dropped and the request reads `expired`. Dropped at once when the device is revoked, the requester's account is disabled, the requester presses "Delete now", or the server stops. A restart loses stored samples by design; open requests survive in the database and finish normally. Nothing is written to SQLite, to a file, to the audit log or to a server log.

**Why memory only, instead of encrypting at rest.** An encrypted store needs a key that is not in the database, key rotation and a place in the backup story ("Do not treat a backup containing both encrypted secrets and an unprotected master key as confidential", section 10). A 15-minute sample gains nothing from durability, and no bytes at rest means nothing to leak from a backup, a database copy, a disk image or an export. The residual risk moves to process memory, swap and core dumps: the plan disables core dumps for the server process in the Compose files and documents swap.

**Reads.** `GET /api/v1/devices/{id}/sampling/{request_id}/events` returns events to the requester only. Anyone else, administrators included, gets 404. The read needs a valid session, an enabled account and the operator role still held. The first read is audited.

**What is logged and audited.** Actions, in the audit log's per-action detail allowlist (`server/src/audit.rs`, `_ => &[]` for unknown actions): `event_sampling.request` (device, component ID, side, limits, reason), `.complete` (events kept, bytes, non-log events, truncated events, redactions by rule, how it ended, whether Vector restarted), `.expired`, `.denied` (permission, host consent, device state, rate limit, with the reason code), `.cancel`, `.read` (first read, counts), `.promote` (section 7). No event, field name from an event or value is ever a detail. A test plants a canary string in an event and searches the database file and WAL, the audit export, the server log and the backup for it (S-08 to S-10).

**What a backup or a database copy contains.** Request rows: device, requester, component ID, side, limits, reason, counts, state and timestamps. Audit events with the allowlisted details. No events, no samples, no key for them. A restore therefore cannot bring back sampled data, and the sampling generation joins the restore fence.

## 6. What a malicious or compromised party can do

The full table (mitigation and residual risk per row) is the new section of the [threat model](../security/THREAT-MODEL.md#event-sampling). The rows: a compromised server, an operator with a stolen session, a curious local user on the host, a network attacker, a pipeline author who names a component, a compromised device, another operator reading a sample, and a local user who squats the port. The residual risks, stated plainly:

- **A compromised server** can sign requests for any consenting device. It is bounded by consent, host caps, the agent's own rate limits (at most 12 sessions an hour), the ID rule and redaction; in `values` mode it can still collect redacted events from any component of a consenting device.
- **A stolen operator session** can request and read samples for consenting devices until the session is revoked; the rate limits and the audit trail apply.
- **A curious local user** can read everything in a window, unredacted, and can crash Vector during one. This is the reason for the host-level consent and the wording of its prompt.
- **A pipeline author** controls component IDs and event content. IDs are validated; event content is untrusted data rendered as text, never as markup.

## 7. Product behavior

**Where it starts.**

- **Canvas node:** the inspector of a selected component gets "Sample events…" next to "Test with samples" (`dashboard/src/SyntheticTester.tsx` lives there). On a source it samples `outputs`; on a transform it offers `outputs` or `inputs`; on a sink `inputs`.
- **Canvas edge:** the connection's menu offers "Sample events on this connection…", which samples the outputs of the connection's source component. Route outputs cannot be told apart (tap reports the component, not the output), so on a route the panel says "All outputs of this route".
- **Device page:** the "Event sampling" card has "Sample events…", which asks for the component from the device's running pipeline.

From the canvas, the panel first asks for a device and lists only devices running this pipeline, with the reason next to any device that cannot sample.

**The request.** Component and side (prefilled), how many events (up to the host's cap) and how long, a required reason (8 to 200 characters), and a note: "Redacted on the device and kept for 15 minutes, for you only." The button is "Start sampling".

**What the panel shows, in order.** "Waiting for edge-01 to check in" (usually a few seconds when the device holds a wait, up to its check-in interval otherwise), "Sampling window open on edge-01 · 12 s left", "Redacting and uploading", then the result. Cancel is available until the window opens; afterwards it discards the result, and the on-host window ends at its own bound.

**The viewer.** A scope banner: "Showing up to 20 events from remap on edge-01, redacted on the device. Kept for 14:32 more, visible only to you. Redaction is best effort: check the events before you copy them anywhere." In `shape` mode: "This host hides values. You're seeing field names and types only." Events render as text in a JSON tree with a raw toggle. `«redacted»`, `«truncated N bytes»`, `«hash:…»` and shape placeholders are chips with a tooltip naming the rule, and a summary line counts them ("12 values redacted: 4 by field name, 8 by pattern, 0 secrets; 2 truncated"). Nothing is ever interpreted as HTML.

**Empty and error states, with the exact copy.**

| State | Copy |
| --- | --- |
| Host has not allowed it | "Event sampling is off on edge-01. Someone with access to that host can turn it on with `vectory configure-sampling`. Vectory can't change it from here." |
| Old agent | "edge-01 runs agent 0.1.0, which can't sample events. Upgrade the agent, then try again." |
| Windows | "Event sampling isn't available on Windows yet." |
| Device offline | "edge-01 hasn't checked in for 7 min. Sampling needs a device that's online." |
| Paused or not settled | "edge-01 is paused, applying a change, or running a file that differs from what was deployed. Sampling starts when it's settled." |
| Pipeline turns on the API | "This pipeline turns on Vector's own API, so sampling can't open a separate window. Remove the `api` setting and deploy again." |
| Component can't be sampled | "Rename this component to use letters, digits, `_` or `-` to sample it." |
| Port in use | "Another program on edge-01 is using port 8686, which Vector needs for a sampling window. Stop that program or try again later." |
| Rate limit | "Sampling on edge-01 is limited to 12 a hour. Try again in 4 min." |
| Another window open | "A sampling window is already open on edge-01 (started by Ana). Try again when it closes." |
| Component idle | "No events reached remap in 30 seconds. It may be idle, or nothing upstream is sending. Try a longer window or sample another component." |
| Another client attached | "Another program connected to Vector's API during the window, so the window was closed by restarting Vector. No events were kept." |
| Paused or revoked mid-window | "Sampling stopped: the host paused this device. No events were kept." |
| Vector restarted | "Vector restarted during the window. No events were kept." |
| Expired | "This sample was deleted after 15 minutes." |

**"Use as VRL sample".** Adds the selected events to a sample set for that component in the synthetic tester. Device events are never written to `localStorage` on their own: the set is held in memory and flagged as device-sourced, and it is excluded from `writeSamples` until the person chooses "Keep in this browser", which says "Kept in this browser until you delete it." In `shape` mode the placeholders become neutral example values (`«string:24»` to `"example"`, numbers to 0, booleans to false) and the set is named "Shape of remap on edge-01 (example values)".

**"Create unit test".** A preview lists exactly what will be written, with each event editable and each field removable, and says: "This copies 3 events into your pipeline. Drafts, published versions and backups keep them, and devices that run this version receive them." Confirming writes `tests[].inputs` (one `insert_at: <component>`, `type: log`, `log_fields: <event>` per event, through `unitTestFromSample`) into the current draft. It calls `POST …/promote` so `event_sampling.promote` records who copied how many events, with no bodies. The unit test is a draft change like any other: unsaved changes and revisions behave as they do today.

## 8. Capacity and failure

**Bounds.**

| Bound | Value |
| --- | --- |
| Events per request | 1 to 100 (default 20), also capped by the host |
| Window | 5 to 120 s (default 30), also capped by the host |
| Event size, string size | 16 KiB, 1 KiB |
| Sample size after redaction | host cap 8 to 512 KiB (default 128 KiB) |
| Per device | one open request, 12 requests an hour, 12 sessions an hour and 30 s between them at the agent's defaults |
| Per user | 6 requests a minute, 4 stored samples |
| Instance | 64 open requests, 32 stored samples, 16 MiB |
| Request lifetime | must start within 3 minutes, must finish within its window plus 60 s, else `expired` |
| Stored sample | 15 minutes after completion |

**Time.** A session is the delay to the next check-in (seconds with a held wait, up to the interval, 60 s by default, without), plus about 1 s to validate and reload, at least one tap interval (0.5 s to the first events), a close and proof of about 1 to 3 s, and an upload. Typical: 5 to 10 s with wake-ups. The agent does not check in during a session, so one heartbeat is delayed by at most the window plus about 10 s.

**Measured cost of a session** (Appendix A, F2b; 12,000 events/s through one transform on a 4-CPU VM, 0.58.0). The agent's own tap (about 20 events/s) is inside the noise: CPU within ±6 points of baseline, memory +5 to +10 MB, throughput and transform latency unchanged (61 to 69 µs). One greedy client streaming every event adds about 6 points of CPU and 21 to 27 MB. Five greedy clients on all components (an attack) take Vector from 38% to 80% of a core, memory from 48 to 136 MB and mean transform latency from 61 µs to 1,123 µs, and cost 0.9% of throughput. A tap reload takes 1 to 5 ms and lost or duplicated no events (F3). Rates above 12,000 events/s were not measured.

**Failures.**

| Event | What happens | What the person sees |
| --- | --- | --- |
| Agent dies mid-session | The supervisor's stdin closes, Vector stops, the API goes with it. On restart `Activate` rebuilds the overlay without the block. The request expires. | "edge-01 stopped responding during the window. No events were kept." |
| Server restarts | Open requests are in the database and finish; stored samples are gone. | A finished sample reads "deleted after 15 minutes" early, with the reason "The server restarted". |
| Vector restarts or exits mid-session | The tap ends, the agent sees `Driver.Alive` false, discards the events and reports `VECTOR_RESTARTED`. The restart regenerates the overlay. | "Vector restarted during the window. No events were kept." |
| Requester closes the tab | Nothing changes; the sample waits 15 minutes. | Reopening the device page restores the viewer. |
| Upload fails | One retry with backoff inside the window plus 60 s; then the request expires. | "The device couldn't deliver the sample." |
| Pause or consent removal mid-session | Tap killed, events discarded, window closed, `PAUSED`. | See the table above. |
| Reload rejected | Vector keeps the old configuration; the window never opens. | "Vector didn't accept the sampling window." |
| Foreign client, port squatter | Sections 2 and 6. | See the table above. |

## 9. Wire and API surface

**Manifest (server to agent, signed).** New optional top-level `sampling` object (section 3). It is not part of `Policy` or `Desired`, so `Identity(m.Policy)` and `Identity(m.Desired)` and the same-generation checks in `VerifyEnvelope` are unaffected. `features` gains `event_sampling`, listed only when the feature is enabled (`VECTORY_EVENT_SAMPLING` is not `off`).

**Heartbeat (agent to server).** New optional `sampling` object, sent only after a verified manifest lists `event_sampling` (the rule in `agent/internal/agent/heartbeat_features.go`):

```json
"sampling": {
  "supported": true, "allowed": true, "mode": "shape",
  "max_events": 20, "max_seconds": 30, "max_bytes": 131072,
  "unavailable": "platform",
  "highest_generation": 7,
  "last": {"id": "…", "generation": 7, "state": "complete", "code": null, "closed_by": "limit", "events": 20, "bytes": 2992, "vector_restarted": false, "at": "2026-09-30T00:00:00Z"}
}
```

The server allowlists every key and bound and rejects unknown keys, like telemetry. `unavailable` is one of `platform`, `pipeline_defines_api`, or absent.

**Upload (agent to server).** `POST /agent/v1/samples` (mTLS):

```json
{"id": "…", "generation": 7, "state": "complete", "code": null,
 "component": {"id": "remap", "kind": "transform", "type": "remap"}, "side": "outputs", "mode": "values",
 "events": [{"host": "web-01", "message": "GET /checkout 503"}],
 "counts": {"seen": 20, "kept": 20, "non_log": 0, "truncated": 0, "redactions": {"field": 0, "secret": 0, "pattern": 1}},
 "started_at": "…", "ended_at": "…", "closed_by": "limit", "vector_restarted": false}
```

`state` is `complete`, `empty`, `refused` or `aborted`; refusals and aborts carry no events. Response: `200 {"ok":true}`. Errors: 401 `UNAUTHENTICATED`, 404 `NOT_FOUND`, 409 `CONFLICT`, 410 `SAMPLING_EXPIRED`, 413 `PAYLOAD_TOO_LARGE`, 429 `RATE_LIMITED`, 400 `INVALID_INPUT`.

**Dashboard routes** (`/api/v1`, session cookie, CSRF on mutations):

| Route | Roles | Purpose | Errors |
| --- | --- | --- | --- |
| `POST /devices/{id}/sampling` | operator, admin | Create a request; returns 202 with the `SamplingRequest` metadata; the same `request_id` and body return it again | 400 `INVALID_INPUT`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 404 `SAMPLING_DISABLED`, 409 `SAMPLING_NOT_ALLOWED`, 409 `SAMPLING_UNAVAILABLE` (with `reason`), 409 `SAMPLING_BUSY`, 409 `IDEMPOTENCY_CONFLICT`, 429 `RATE_LIMITED` |
| `GET /devices/{id}/sampling` | any signed-in role | Consent and capability as last reported, the open request and the last one, metadata only | 404 `NOT_FOUND` |
| `GET /devices/{id}/sampling/{request_id}` | any signed-in role | One request's metadata and state | 404 `NOT_FOUND` |
| `GET /devices/{id}/sampling/{request_id}/events` | the requester | The redacted events | 404 `NOT_FOUND` (anyone else), 410 `SAMPLING_EXPIRED` |
| `POST /devices/{id}/sampling/{request_id}/cancel` | the requester, admin | Cancel; before the window opens it stops delivery, afterwards it discards the result | 404, 409 `CONFLICT` if already final |
| `DELETE /devices/{id}/sampling/{request_id}/events` | the requester | "Delete now" | 404 |
| `POST /devices/{id}/sampling/{request_id}/promote` | the requester | Record that events were copied (`kind`: `vrl_sample` or `unit_test`, `count`) | 404, 400 |

`SamplingRequest` is `{id, request_id, device_id, requester:{id,name}, component_id, side, max_events, max_seconds, reason, state, code?, closed_by?, events?, bytes?, redactions?, vector_restarted?, created_at, expires_at, finished_at?}`. `GET /devices/{id}` gains a read-only `sampling` projection (`allowed`, `mode`, caps, `unavailable`). `GET /settings` gains `event_sampling: {enabled}`.

**Old agents and old servers.** An old agent never reports `sampling`, so the server treats the device as unsupported (`SAMPLING_UNAVAILABLE`, `agent_too_old`) and never puts a `sampling` object in its manifest. A new agent talking to an old server never sees `event_sampling` in `features`, so it sends no `sampling` field, uploads nothing and ignores nothing it needs to. An old agent that did receive a `sampling` object would ignore it (unknown JSON fields are ignored by `json.Unmarshal`), and the server never sends it one.

## 10. Test plan

Each behavior above has a test in one of five layers. The IDs are used in the [implementation plan](../internal/TAP-IMPLEMENTATION-PLAN.md), which assigns them.

**Agent (Go).**

- A-01 Consent absent, malformed or with unknown fields refuses with `HOST_NOT_ALLOWED`; `settings.json` unchanged.
- A-02 The settings bytes are identical before and after processing manifests that carry every hostile shape (a `sampling` object with `allowed` fields, a policy with `event_sampling`); a source scan fails if a function outside the eight writers reaches a settings writer.
- A-03 `setup`, `install` and `enroll` reject any sampling flag; a flag-name scan fails if one mentions sampling.
- A-04 Replayed envelope, wrong device UUID, wrong nonce, expired manifest, equal or lower generation: each refused; `HighestSamplingGeneration` is persisted before acting; a crash after persisting does not run the request twice.
- A-05 Component ID rule: unknown ID, side and kind mismatch, glob, comma, leading dash, `.`, 65 characters; the argument array contains exactly one `--outputs-of=<id>` and no shell.
- A-06 Preconditions: local pause, remote pause, drift, journal present, Vector down, apply in flight, an `api` key in the managed file (enabled or not), Windows: each refused with its code and Vector untouched.
- A-07 The overlay carries the block only during a session; the managed file, digest, last-known-good and journal bytes are identical before and after; `Activate` rebuilds the overlay without it; a crash injected at every step leaves no block after restart.
- A-08 Port probe: 8686 taken by another listener refuses without a reload and Vector stays up.
- A-09 Closure: a foreign client during the window aborts and discards; a stream that stays after close triggers the restart path; an unreadable connection table restarts (fail closed); closure is proven by a refused connect.
- A-10 Tap runner: caps on events, seconds, raw and redacted bytes; stderr signals; exit-code handling including a lost connection with exit 0; kill on deadline; malformed lines; non-log events counted.
- A-11 Redaction: every rule; a property test that no bound secret value appears in any output for random events embedding it (with the documented exception of encodings the rules do not decode); shape mode; per-session hash key; host extras; the upload function accepts only the redactor's type.
- A-12 `vectory pause` during a window: aborts within 500 ms, closes, uploads no events. Stopping the service ends the window.
- A-13 Rate limits (minimum gap, hourly cap) persist across restarts.
- A-14 The heartbeat `sampling` field appears only after the manifest lists `event_sampling`; an old server's shape is unchanged.
- A-15 Real Vector, Linux: open, close and reload continuity; busy port at probe and at bind (Vector stopped and restarted); foreign client; Vector killed mid-session.
- N-01 macOS native: A-15 plus the `netstat` reader. N-02 Windows: the consent command refuses and the heartbeat reports `platform`.

**Server (Rust).**

- S-01 Role matrix: viewer and editor 403; operator and admin succeed; missing CSRF and cross-site 403.
- S-02 Strict body, reason bounds and control characters, ID rule and existence in the running version, side, caps, unknown fields 400.
- S-03 One open request per device (409 `SAMPLING_BUSY`); replay of the same `request_id` and body; a changed body 409 `IDEMPOTENCY_CONFLICT`.
- S-04 Rate limits per user and per device.
- S-05 Gating: host not allowed, old agent, offline, revoked device.
- S-06 The manifest carries the object only for the authenticated device, only while `requested` or `delivered` and unexpired, signed, with the nonce; state transitions.
- S-07 Upload: device authentication, another device's request 404, size 413, second upload 409, expired and cancelled 410, malformed structure, depth and size limits.
- S-08 Storage: a canary in an event is absent from the database file and WAL after upload; the 15-minute purge; revoke purges; restart drops; only the requester reads (another operator and an administrator get 404); capacity bounds.
- S-09 Audit: the actions and their allowlisted details; the canary is absent from the audit log, an audit export and the server log.
- S-10 Backup and restore: the archive has no canary; the restore fence raises the sampling generation.
- S-11 `VECTORY_EVENT_SAMPLING=off`. S-12 A created request wakes a parked wait, the wait's entry sees `requested`, and there is no loop once `delivered`. S-13 Heartbeat `sampling` validation. S-14 Promotion audit.

**Protocol suite (`tests/security`, `tests/contracts.mjs`).**

- P-01 End to end with a real agent, server and Vector on Linux: consent, request, sample, redaction, upload, read, window closed, events flowing unchanged.
- P-02 A replayed manifest carrying a `sampling` object and a manifest for another device are refused by the agent; a tampered `sampling` field fails the signature.
- P-03 One device's certificate uploading for another device's request gets 404.
- P-04 Oversized upload, a secret canary in an event, a cross-user read, a second session, consent removed and pause mid-session, an expired session, a foreign client in the window.
- P-05 `protocol.schema.json` and `openapi.json` validate real bodies.

**Browser (Playwright, vitest).**

- B-01 Device card states: not allowed, shape, values, window open, offline, old agent, Windows.
- B-02 Request dialog: required reason, caps, focus and keyboard, CSRF, the copy for each refusal.
- B-03 Viewer: chips, an event containing `<img onerror>` renders as text, dark mode, 390 px.
- B-04 Promotion: "Use as VRL sample" writes nothing to `localStorage` until "Keep in this browser"; "Create unit test" shows the preview, writes `tests[].inputs` into the draft and calls `promote`; shape placeholders become example values.
- B-05 Reload and tab close restore the viewer within the TTL; "Delete now"; the expired state.

## Alternatives rejected

- **An always-on API** (random port at Vector start, agent-owned). Vector honors the address only at start, so the window could not be reopened on that port; the API would be open for local users all the time; and streams attach for good. Rejected as the opposite of consent.
- **A server-side tap.** The server has no route to a device and must not get one (section 1). Rejected.
- **A file-sink tee** (the overlay adds a `file` or `socket` sink fed by the component). It changes the customer's topology and adds back-pressure to a production pipeline that `tap` avoids (a full or slow sink blocks its sources); restricted mode does not allow a `file` sink, so the agent would have to bypass its own policy for its own component; it puts plaintext events on disk; and it still needs two reloads. Its one advantage, no unauthenticated listener, does not outweigh these. Rejected.
- **A fleet-wide or group sample.** One device per request is what makes the exposure, the audit and the rate limits meaningful. Rejected.
- **Restarting Vector per session on Linux and macOS.** It would allow a random port, but a restart interrupts delivery twice per session. Reload measured at 1 to 5 ms with no loss. Rejected as the default; a restart remains the enforcement step when another client stays attached.
- **A direct gRPC client in the agent.** See section 4.
- **A request on the unsigned wake hint,** or on a new unsigned route. Violates "the request must be signed". Rejected.
- **A `sample_events` permission enum.** The server has none (section 3).
- **Encrypted samples in SQLite.** See section 5.
- **A raw mode, or a request-level redaction switch.** Rejected: redaction is not something a server or an operator may turn off.
- **A restricted-mode carve-out that lets the pipeline's own `api` block be reused.** The window would be permanent. Rejected.

## Consequences

- **Prerequisite.** Restricted mode must stop accepting a pipeline `api` block before sampling ships: `CapabilityPolicy.Check` in `policy.go`, `requires_full_mode` in `rollout.rs`, the dashboard's device compatibility check, and the lists in [security.md](../user/security.md) and [ADR 0005](0005-restricted-mode-by-default.md). A pipeline that sets `api` will then need a full-mode device; the release note says so. No starter pipeline or fixture uses an `api` block (only editor tests do).
- **The "events never pass through Vectory" statements need one qualification:** "unless the host owner turns on event sampling", with the redaction limits stated. That covers [security.md](../user/security.md) and the specification's sections 9 and 11, which should record that host-approved, bounded sampling is allowed by them.
- **Copies are durable once promoted.** Draft revisions, versions and backups keep events written into unit tests. The promotion dialog and audit event exist for that reason.
- **Vector upgrades need a re-measurement.** Sampling depends on 0.58's address, bind and stream behavior. The agent supports the 0.58 series; any bump reruns experiments A to G (they are scripted in the plan).
- **The server gains an instance switch and a bounded in-memory store,** and the agent gains a session engine on its single goroutine. The plan lists files and owners.

## Open risks

- **macOS is unmeasured.** The same experiments must pass on a native runner; the connection reader differs.
- **The bind race.** A local user who binds 8686 between the probe and Vector's bind stops Vector. Bounded by consent, the requested window and Vector's restart; not eliminated.
- **Foreign readers before detection.** Up to 500 ms of raw events, plus whatever a client had streamed before the agent's next poll.
- **Heuristic redaction.** See section 4. Free text is the open case.
- **Process memory.** Samples live in server memory and briefly in the agent's; swap and core dumps can persist them.
- **Not measured:** rates above 12,000 events/s, route outputs, sinks with acknowledgements, disk buffers, IPv6, very large events, non-UTF-8 content.

## Appendix A: Proof of concept

Placeholder: the transcript is added in the next commit.
