# Vectory server

The Rust control plane: the dashboard and API, the agent listener, the sandboxed validator and the `vectory-admin` maintenance tool. Operators should start with the Help center: [Install the server](../docs/user/install-server.md), [Server configuration](../docs/user/server-config.md) and [`vectory-admin`](../docs/user/vectory-admin.md).

## Build and test

```sh
cargo build --release --bins    # vectory-server, vector-validator, vectory-admin
cargo fmt --check
cargo test --locked
```

Set `VECTORY_TEST_VECTOR` to a Vector 0.58.0 binary to run the native validator and VRL tests; without it they print a skip notice. The toolchain is in [CONTRIBUTING.md](../CONTRIBUTING.md#prerequisites).

| Binary | Role |
| --- | --- |
| `vectory-server` | Dashboard, API and Help center over plain HTTP behind a TLS proxy, plus the agent listener over TLS 1.3. |
| `vector-validator` | Runs `vector validate` and VRL tests for the server. Belongs in an isolated container with no network, secrets or host mounts. |
| `vectory-admin` | Offline maintenance against a stopped server's data directory. |

The wire contract is in `../contracts/`: `CONTRACT.md`, the generated `openapi.json` (also served at `/api/v1/openapi.json`) and `protocol.schema.json`. Every environment variable is documented in [Server configuration](../docs/user/server-config.md), which a test keeps in sync with this source tree.

## Durable state

- SQLite with WAL, `FULL` synchronous writes, foreign keys, migrations, a five-second busy timeout, eight pooled connections and serialized writers. Every write transaction goes through `db::write_tx`: the process-wide writer lock plus `BEGIN IMMEDIATE`.
- Migration numbers have gaps (0001–0027, 0040, 0100, 0110). Number a new migration above the highest existing one; tests that replay old schemas rewind exact version ranges.
- Migrations run at startup and only move forward: an older server refuses a database a newer one migrated, so a downgrade means restoring the pre-upgrade backup. Migration 0100 indexes stored telemetry, which delays the first start after that upgrade on a large telemetry table.
- An exclusive lock on the data directory keeps out a second server or a running `vectory-admin`. No network filesystems, no active-active replicas.
- At startup the server makes the data directory, database, lock and key tree private: owner-only modes on Unix, and on Windows an access list for the current identity and SYSTEM only. It refuses symlinks and reparse points. Operating-system administrators remain trusted.
- The database and the `keys/` tree (device CA, manifest signing keys, `mfa-sealing.key`) belong together. A database that refers to a missing key refuses to start.

## Accounts and sessions

- Argon2id password hashes; hashed session tokens; 12-hour `Secure`, `HttpOnly`, `SameSite=Strict` cookies; a CSRF token on every change; roles enforced on every request.
- Time-based two-factor codes with replay protection and single-use recovery codes. Two-factor secrets are sealed with AES-GCM under `mfa-sealing.key`.
- Sign-in throttling counts failures only, per account and client, and answers `429` with `Retry-After`.
- First-administrator setup is transactional and has no default password.

## Device identity

- Enrollment verifies the CSR signature, uses only its public key, and issues a server-chosen UUID in a 30-day client-auth certificate. Every other CSR field is ignored.
- Retrying an enrollment is bound to the token, request ID and CSR key, so a lost response can't enroll twice. A token can't take over an existing device name.
- Heartbeats, renewals and artifact downloads check the client certificate's fingerprint against current revocation and expiry on every request, including on reused connections. Enrollment is the only unauthenticated agent route.
- Identity recovery uses a one-use, one-hour token scoped to the old identity and name. Using it revokes the old credentials and creates a new, unmanaged UUID.

## Signed manifests and key rotation

Each heartbeat reply is an Ed25519-signed manifest bound to the device, the nonce the agent sent, a five-minute validity window and the configuration and policy generations. Artifact reads return only that device's current immutable artifact.

`vectory-admin rotate-signing-key` keeps the previous key before replacing the current one. Each credential stays bound to the key it was issued with, and authenticated renewal delivers a new certificate with the current key, so devices never lose manifest trust. `keys/signing-history/` keeps up to four old keys; `prune-signing-keys` removes only keys no valid credential uses. Both are audited.

Device CA replacement is a stopped-server operation: install the reviewed new certificate and key, and trust the old CA during the overlap with `VECTORY_PREVIOUS_DEVICE_CA`. Test fleet renewal before you retire the old CA.

## Local secret references

Only an exact `vectory-secret:NAME` value is accepted, at a credential field of the generated table in `src/secret_fields.rs` (every Vector `SensitiveString` field plus reviewed credentials, per component type; `node scripts/generate-secret-fields.mjs` regenerates it). Names match `[A-Za-z][A-Za-z0-9_.-]{0,63}`. Prefixes, references in URLs, VRL or other fields, and plaintext credentials are refused, with the fix. The server never sees secret values: drafts, versions, exports, signatures and validation hold the reference only.

The agent substitutes values from protected local files, re-checks local policy, validates and verifies activation. Versions marked `uses_local_secrets` may report an effective digest that differs from the template, but verification then also requires the matching `applied_template_sha256`, the current generation and a higher `secret_revision`. Every other version must match the desired digest exactly.

## Rollouts

- Configuration and agent-settings assignments resolve separately. Higher priority wins; different payloads at the same priority conflict, and a stored conflict keeps the last valid desired state.
- Deployment creation takes the reviewed device IDs and rejects a changed target set in the same transaction.
- Scheduled snapshots survive restarts and expire an hour after their start time. Group membership changes re-resolve transactionally and can't skip canary gates.
- Canary stages need continuously fresh, verified heartbeats. Offline targets stay pending.
- Cancel stops further releases. Removing an assignment falls back to the next assignment, or leaves the device unmanaged with its workload running.

## Telemetry and limits

- Samples carry a timestamp plus optional throughput, errors, uptime, CPU, memory, discarded events and buffer bytes, and up to 50 components with a strict allowlist. Unknown or out-of-range values are rejected; missing values stay null.
- Samples coalesce into per-minute buckets kept for `VECTORY_TELEMETRY_RETENTION_DAYS`. `GET /api/v1/devices/{id}/telemetry` returns up to 120 recent buckets.
- The agent listener limits concurrent connections (`VECTORY_MAX_AGENT_CONNECTIONS`), TLS handshakes (128), parsed requests (128), HTTP/2 streams per connection (16), request bodies (1 MiB) and request time (15 seconds). These contain overload; they aren't a supported fleet size. Measurements are in [docs/internal/CAPACITY.md](../docs/internal/CAPACITY.md).
- Request limits count per client in bounded partitions that evict the key whose window ends soonest, so a full partition never turns a new client away. Unauthenticated agent-listener requests and invitation previews have a partition of their own and a global cap a minute ahead of each address's budget: 1,200 installer fetches, 1,200 agent downloads, 600 enrollments and 600 previews. A flood from many addresses can't displace sign-in keys.

## Audit

Audit events are append-only at the application and database-trigger level, which protects against the application but not against a database administrator. Every request gets an `X-Request-ID` that its audit events carry. Audit history is never pruned automatically.

The release catalog lists only files whose SHA-256 and size match. `signed` stays `false` until release signature verification exists.

## Known gaps

Windows native tests don't establish Linux or macOS service behavior, and cross-compiling doesn't establish support. Container isolation needs a Docker-capable runner to test. Signed packages, service and upgrade tests on each OS, long outage exercises and capacity claims all need their own evidence. See the [roadmap](../docs/ROADMAP.md).
