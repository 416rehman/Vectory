# Vectory control plane

Rust 1.88 or newer; the native test run used Rust 1.94.0 on Windows amd64 and Vector 0.58.0. Build all three executables with `cargo build --release --bins`. `vectory-server` serves the dashboard/API and the separate agent TLS listener. `vector-validator` belongs in the restricted validation container. `vectory-admin` performs local maintenance while the server is stopped.

The shared wire contract and generated OpenAPI live in `../contracts/`. Authenticated users can also retrieve `/api/v1/openapi.json`. A schema describes the protocol; it is not a certificate or a signed release artifact.

## Configuration

| Variable | Default / meaning |
| --- | --- |
| `VECTORY_DATA_DIR` | `./data`; local persistent filesystem, one active server |
| `VECTORY_HTTP_ADDR` | `127.0.0.1:8080`; place production behind a trusted TLS reverse proxy. Development mode requires a literal loopback IP and port, such as `127.0.0.1:8080` or `[::1]:8080` |
| `VECTORY_AGENT_ADDR` | `0.0.0.0:8443`; direct TLS 1.3, never trust proxy certificate headers. When development mode has no validator, an enabled agent listener must instead use a literal loopback IP and port |
| `VECTORY_TLS_CERT`, `VECTORY_TLS_KEY` | Required server certificate/key in production |
| `VECTORY_BOOTSTRAP_SECRET_FILE` | Protected file containing at least 24 random characters for first initialization |
| `VECTORY_BOOTSTRAP_SECRET` | Environment alternative; the file takes precedence |
| `VECTORY_COOKIE_SECURE` | `true`; disabling requires explicit development mode |
| `VECTORY_DEVELOPMENT` | `false`; permits development HTTP cookies and an absent agent listener, but binds the dashboard/API only to loopback |
| `VECTORY_DASHBOARD_DIR` | `../dashboard/dist` |
| `VECTORY_RELEASES_DIR` | `DATA_DIR/releases`; Compose uses a separate read-only `/app/releases` |
| `VECTORY_INSTANCE_NAME` | `Vectory` |
| `VECTORY_VALIDATION_URL` | Isolated Vector 0.58 worker base URL; required for production startup. It may be absent only in explicit development mode, where checks and publication are structural-only |
| `VECTORY_MAX_AGENT_CONNECTIONS` | 16384, clamped 64–65536; capacity is a resource bound, not a supported fleet-size claim |
| `VECTORY_TELEMETRY_RETENTION_DAYS` | 7, clamped 1–30; one coalesced sample per device per minute |
| `VECTORY_PREVIOUS_DEVICE_CA` | Optional explicit PEM trust bundle for previous client CAs during planned CA overlap |
| `RUST_LOG` | Standard tracing filter; no request bodies or private keys are logged |

The worker additionally needs `VECTORY_VALIDATOR_ISOLATED=true`, `VECTORY_VECTOR_BINARY` (Compose uses `/usr/bin/vector`), and optionally `VECTORY_VALIDATOR_ADDR` (default `0.0.0.0:8081`). The isolation flag is an operator assertion, not sandbox enforcement. Use the supplied Compose restrictions: no production secrets or host mounts, no engine socket, restricted network, read-only filesystem, bounded temporary storage, non-root identity, CPU/memory/PID limits. Both `/validate` and `/vrl-test` use the pinned executable, cleared environment, fixed arguments, two execution slots, a five-second deadline, and bounded output. The API also limits worker calls and total output. Production startup rejects a missing worker URL; an explicitly configured but unavailable worker blocks publication. Only explicit development mode may run structural-only checks and publication without a worker. Development always restricts dashboard/API HTTP to literal loopback addresses; structural-only development also restricts the agent TLS listener to loopback when TLS certificates enable it. Set `VECTORY_AGENT_ADDR=127.0.0.1:8443` for that local preview, since its ordinary default is the production wildcard address. Environment-dependent Vector checks remain a device responsibility.

## Identity and durable state

SQLite uses WAL, FULL synchronous durability, foreign keys, migrations, a five-second busy timeout, eight pooled connections, and serialized writers. An exclusive filesystem lock prevents a second server or maintenance process. Do not use network filesystems or active-active replicas.

Initialization replaces permissions on the owned root, database/sidecars, lock, and key tree. It rejects symbolic links/reparse points before modifying owned entries. On Windows the protected replacement DACL grants only the current identity and SYSTEM and changes ownership to the current identity; failure aborts startup. Linux uses owner-only directory/file modes. Release mirrors and operator backup subdirectories are not recursively modified. OS administrators remain trusted and can override these controls.

Browser sessions use Argon2id password verification, hashed session tokens, CSRF tokens, expiry, Secure/HttpOnly/SameSite cookies, and server-enforced roles. MFA uses time-based codes with transactional replay protection plus single-use recovery codes. Its separate AES-GCM sealing key is part of the backup. Existing MFA records with a missing key fail startup; the server never silently resets MFA. Keep recovery codes offline. First-admin bootstrap is transactional and has no default password.

Enrollment verifies the CSR signature, uses only its public key, and issues a server-controlled UUID/client-auth certificate. Enrollment response retry is bound to the token, request ID and CSR public key. Reusable enrollment tokens cannot take over an existing name. An administrator can explicitly create a one-use, one-hour recovery token scoped to the old identity and exact name. Consumption revokes the old credentials, retires the old name, and creates a fresh unmanaged UUID without inherited groups or assignments.

Agent requests require TLS 1.3. Heartbeat, artifact and renewal authorization checks the actual client certificate fingerprint against current database revocation/expiry state, including reused connections. Enrollment is the only unauthenticated TLS route. Each signed manifest binds the current device, fresh request nonce, validity window, configuration generation and policy generation. Artifact reads permit only that device's current desired immutable artifact.

## Signing-key rotation

Stop the server; use the same protected state directory:

```text
vectory-admin --data-dir PATH rotate-signing-key
vectory-admin --data-dir PATH prune-signing-keys
```

Rotation retains the previous Ed25519 private key before atomically replacing the current key. Each credential is bound to its signing key: existing certificates continue receiving their registered signer; authenticated renewal delivers a new certificate and current public signing key. The agent atomically installs its renewed identity. This avoids switching manifest trust before a device has learned the new key. Previous private keys stay in `keys/signing-history`; at most four are retained. Pruning only removes keys with no unexpired, unrevoked credential references. Rotation/pruning append audit events. A restored database referring to a missing signing key fails startup. Back up the complete key tree.

Client CA overlap is separately configured through `VECTORY_PREVIOUS_DEVICE_CA`; certificate authorization still requires the fingerprint registry. CA replacement is an operator-managed stopped-server operation with a reviewed matching certificate/key pair and previous trust bundle, not a dashboard button. Test the complete fleet renewal path before retiring old trust.

## Recovery after restoring an older backup

Never reset agent anti-rollback counters. First restore the consistent database and complete key tree using the operational backup procedure, stop the server, and export the restored payload identities:

```text
vectory-admin --data-dir PATH generation-recovery-state
```

Save the JSON output using UTF-8. For each affected known device, obtain its actual durable local `highest_generation`, `highest_policy_generation`, and `secret_revision`. The latter is the highest materialization **attempt**, not only the last successful attempt. Fill in `highest_secret_revision` with this value. Verify the restored configuration/version and complete policy; an old backup can contain policy that is no longer appropriate. The report has this shape:

```json
{
  "devices": [{
    "device_id": "THE-EXISTING-DEVICE-UUID",
    "highest_generation": 42,
    "highest_policy_generation": 19,
    "highest_secret_revision": 7,
    "expected_version_id": "THE-REVIEWED-VERSION-ID-OR-NULL",
    "expected_sha256": "THE-REVIEWED-ARTIFACT-SHA256-OR-NULL",
    "expected_policy_sha256": "THE-EXPORTED-CANONICAL-POLICY-SHA256"
  }]
}
```

Use JSON `null` for both version and artifact fields when the restored device is unmanaged. The export intentionally emits null counters so an unreviewed export is rejected. Unknown/revoked devices, duplicate IDs, missing counters, counters older than server state, integer overflow, and mismatching reviewed payloads abort the whole operation. If local identity/counters are unavailable, do not guess or zero them: use the separate explicit device recovery flow and a fresh unmanaged identity.

```text
vectory-admin --data-dir PATH recover-generations --report REVIEWED.json
vectory-admin --data-dir PATH recover-generations --report REVIEWED.json --apply
```

The first command only previews. `--apply` uses one transaction to move configuration and policy generations to the supplied maxima plus one, preserve the local secret attempt floor, reset affected rollout evidence, and append `server.restore_generation_fence` records containing old/new counters and reviewed hashes. No remote generation-reset endpoint exists. Restart the server and verify fresh agent acknowledgments. Operator-supplied counters are trusted local recovery evidence; this operation cannot independently discover an offline host's counter.

## Local secret references

Only an exact `vectory-secret:NAME` string is accepted in `sinks.<id>.auth.user`, `.password`, or `.token`, and only for `http`, `loki`, or `elasticsearch` sinks. Names match `[A-Za-z][A-Za-z0-9_.-]{0,63}`. Embedded prefixes, references in URLs/VRL/other fields, arbitrary secret backends, environment expansion, and plaintext credential fields are rejected. The server never obtains secret material. Drafts, versions, exports, signatures and validation contain the reference template only.

The agent binds names to protected local files, performs literal JSON-string replacement, rechecks the effective capability policy, validates, and verifies actual activation. The immutable artifact hash identifies the template. A published version carries `uses_local_secrets`; only these versions permit a distinct effective `actual_sha256`, and verification also requires the matching `applied_template_sha256`, current configuration generation, and a positive monotonic `secret_revision`. Changing effective bytes without advancing the tracked revision fails verification. Failed/rolled-back attempts remain failures even if hash fields match. Attempts and effective digest changes are audited; no secret values are stored. Ordinary versions always require exact actual/desired digest equality.

## Rollouts, metrics and bounds

Assignments resolve configuration and policy separately. Higher priority wins; equal-priority differing payloads conflict transactionally. An inconsistent stored conflict preserves the last valid desired state. Scheduled snapshots survive restart, expire after the one-hour late-start deadline, and can be explicitly refreshed with a reviewed target list. Creation accepts expected_device_ids from the concrete preview and rejects changed membership transactionally. Persistent membership changes re-resolve transactionally; new members cannot bypass canary gates. Canary observations require continuously fresh verified heartbeats, including the final wave. Offline targets remain pending. Cancel stops future admission and keeps already delivered assignments. Explicit unassignment removes the binding, falls back to another effective assignment if present, or becomes unmanaged while retaining the local workload. Rollback currently requires a shared previous managed version; heterogeneous prior versions need separate targeted rollback deployments.

Telemetry accepts a sample timestamp plus optional throughput, errors, uptime, CPU seconds, memory bytes, discarded events and buffer bytes. Component samples are capped at 50 unique IDs of at most 100 characters with a strict label/metric allowlist. Unknown metrics and negative/unbounded numbers are rejected. Missing values remain absent/null, never invented zeros. Policy can disable telemetry. Current snapshots are overwritten; per-minute buckets are coalesced and pruned by retention. Authenticated `GET /api/v1/devices/{id}/telemetry` returns up to 120 recent buckets in chronological order. An example 500-byte sample at one minute for seven days is about 5 MB of JSON per device before database/index overhead; 50-component samples are larger. Size storage from real measured payloads and shorten retention as needed.

The agent listener bounds active connections, concurrent TLS handshakes (128), concurrent parsed requests (128), HTTP/2 streams per connection (16), request body size (1 MiB), and request deadline (15 seconds). Per-device authenticated rate-limit capacity is separated from anonymous login keys. This is overload containment, not a promise that the configured maximum fleet performs acceptably. Capacity evidence is in `../docs/evidence/`; use the tested configuration and protocol, and retain failed experiments when judging limits.

Audits are append-only at the application/database-trigger level, not tamper-proof against a database administrator. Each request gets a server-generated `X-Request-ID` echoed in its audit events. Enrollment failures are sanitized and bounded by enrollment admission limits. Authorized users can export the JSON audit feed to an operator-controlled destination. Security audit history is not automatically deleted; plan its storage/archival separately.

Release catalog files are listed only when locally present with matching SHA256 and size. `signed` is deliberately false until a real release signature verification workflow is integrated. A catalog boolean is not cryptographic verification.

## Verification and remaining external gates

```text
cargo test --all-targets
cargo build --bins
```

Set `VECTORY_TEST_VECTOR` to the actual pinned binary to run native worker validation and synthetic VRL tests; without it the native test prints a skip notice. Control-plane tests cover role/CSRF enforcement, immutable versions, durable schedules, canary freshness, persistent membership, signed nonce manifests, restricted artifact access, MFA replay/recovery, device recovery, retry/unassignment, signing rotation overlap, state locking, Windows ACL/owner repair, generation recovery, local-secret digest evidence and bounded telemetry history. Independent TLS/protocol and dependency gates are maintained outside this directory.

Windows native tests do not establish Linux/macOS service behavior. Cross-compilation does not establish native support. The Docker isolation boundary still requires a Docker-capable runner; the development machine had no Docker engine. Public signed packages, signing identities, representative OS service/upgrade testing, prolonged outage/fault injection and capacity release claims require the corresponding evidence. Do not describe this build as production-ready on the basis of compilation alone.
