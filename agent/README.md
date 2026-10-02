# Vectory agent

The Go agent that runs on each device. It adopts one installed Vector 0.58.0 binary and one JSON configuration file, connects out to the Vectory agent listener, and applies the versions it is sent. It never installs Vector, never accepts a remotely chosen executable or service, and never lets the server widen its local policy.

Operators should start with the Help center: [Connect a device](../docs/user/installation.md), [Manage agents](../docs/user/agents.md) and the [Agent CLI](../docs/user/cli.md) reference.

## Build and test

Go 1.26.8 is pinned in `go.mod`; an older Go fetches it automatically. Builds are pure Go:

```sh
CGO_ENABLED=0 go build -trimpath -o vectory ./cmd/vectory
gofmt -l .
go vet ./...
go test ./...
VECTOR_TEST_BINARY=/path/to/vector go test -v ./internal/agent -run TestNativeVector
```

On Windows, build `vectory.exe` the same way and set `VECTOR_TEST_BINARY` to `vector.exe`. The native tests run a synthetic `demo_logs` pipeline with real Vector: they validate, start it, observe its startup and liveness, repair drift and roll back a failed start. Without `VECTOR_TEST_BINARY` they skip.

| Package | Contents |
| --- | --- |
| `cmd/vectory` | The CLI: commands, flags and output. |
| `internal/agent` | Enrollment, protocol, reconciliation, the apply journal, supervision, local policy, secrets, telemetry and services. |

## How it applies a version

1. **Persist first.** Generations and the desired identity are saved before anything is fetched. A manifest with the same generation must carry the same identity; a rollback always arrives as a newer generation.
2. **Fetch and check.** The artifact is fetched by SHA-256 from the agent listener and compared byte for byte.
3. **Render.** Local secret bindings are substituted in memory; the effective configuration is checked against the local policy.
4. **Validate** with the adopted Vector, and run the pipeline's tests when it has any. A failing destination health check doesn't reject a version: Vector buffers and retries at runtime, so refusing would only keep the old pipeline running or keep Vector down. When the pipeline omits `data_dir`, the agent supplies this host's own directory in a separate runtime file (`<state-dir>/host-runtime.json`), so the managed file still matches the published version exactly. The directory chosen at the first activation is remembered (`<state-dir>/vector-data-dir.json`), so checkpoints and disk buffers never move.
5. **Apply** through a journal that records each step: prepare, write, start, observe and verify. On Linux and macOS a running Vector is reloaded in place (SIGHUP) and must log `Vector has reloaded.`; if it refuses (for example a changed `data_dir`), the agent restarts it instead. An interruption at any step recovers on the next start.
6. **Verify.** Activation requires Vector 0.58's startup record from the newly started process, two seconds of liveness and a matching managed-file digest. A health endpoint, another process, a download or a written file never counts.
7. **Roll back** to the last verified configuration if the new one fails. The separate pre-attempt snapshot can contain drift and is never promoted automatically.

`reported_generation` only moves to a generation whose exact content was verified. `configuration_attempt` records the candidate's generation, version, template digest, stage, local secret revision and a fixed, safe error category, and travels on every heartbeat. A failed attempt is suppressed so a bad version can't restart Vector in a loop; `vectory retry` (agent stopped), a new generation or a changed local secret allow another attempt.

## Supervision

- The agent owns its Vector process. Stopping the agent stops Vector; starting it starts the current managed configuration and finishes any incomplete journal.
- A control-plane outage, or an expired or revoked credential, never stops a running Vector. There is no fallback to token-based heartbeats.
- If Vector exits, a local health check restores the established configuration even while the server is unreachable. Restarts back off through 10, 20, 40, 80, 160 and 300 seconds, resetting after a minute of healthy running. A local or remote sync pause blocks automatic restarts.
- Linux and macOS stop Vector with SIGTERM and give it `--graceful-shutdown-seconds` (default 60, 5 to 300) to drain before a kill. Windows still uses forced termination.

## Local state and maintenance

- The state directory is private: identity, settings, generation counters, the journal and verified copies. `identity.json` commits the key, certificate and signing trust atomically.
- Maintenance commands take the agent's operation lock, so they need the agent stopped. `pause` and `resume` work while it runs.
- `uninstall --purge` fences other Vectory operations on the same path, writes a marker inside the state directory so an interrupted purge can resume, and deletes only that directory. Stop older agent binaries first: they don't observe the fence.
- On Windows, a per-path global mutex coordinates the service and maintenance accounts. A local user who can guess the path can hold it and block maintenance (never purge state), so restrict untrusted local logons on managed hosts.
- Vector's own log goes to `<state-dir>/vector.log` (rotated at 10 MiB into one `.1` file); `vectory logs [--follow]` reads it. Treat it like other private host files. Heartbeats carry at most ten redacted diagnostics per failed attempt and a redacted summary of Vector's warnings and errors: secrets, URL credentials and environment values are removed.
- Command errors never include configuration text, enrollment credentials or server error bodies.

## Security boundary

- **Network:** outbound only, TLS 1.3 minimum, system trust plus an optional private CA, no redirects, and `HTTPS_PROXY` honored through `CONNECT`.
- **Identity:** the private key is generated on the device. Renewal creates a new ECDSA key in the certificate's last day and commits it atomically. Server certificate rotation relies on the device's trust store or CA file.
- **Binary pinning:** the adopted Vector's SHA-256 is checked before every validation and start. `re-adopt --expected-sha256` approves a replacement.
- **Restricted mode** is a static allowlist in `policy.go`: the reviewed components, explicit destinations and listeners, file roots within local allowances, no `api` block (Vector's API has no authentication), and no environment substitution, dynamic templates, secret providers, external VRL files, executables or disabled TLS verification. Console sinks must target stderr, because Vector 0.58 writes its JSON startup log to stdout and pipeline output must not be able to forge it. Both modes refuse a component ID that contains a `/`, a `\` or a control character, or that starts with a drive letter and a colon (`^[A-Za-z]:`, like `C:x`): Vector joins an ID onto its `data_dir`, so a path would make it write outside it.
- **Not a sandbox:** these are configuration checks. DNS changes, redirects from allowed endpoints, files that change after validation and local administrators are outside them. The agent and its Vector share an operating-system account; separating them is future hardening.

## Local secrets

- Only an exact `vectory-secret:NAME` value at a credential field of the agent's own generated table (`secret_fields_generated.go`: every Vector `SensitiveString` field plus reviewed credentials, per component type) is resolved, in both modes. The server never chooses the fields. Heartbeats report bound names, never paths or values.
- The bindings file is strict JSON: one object, UTF-8 without a BOM, at most 2 MiB and 64 names, absolute paths only, no duplicates or trailing data. It replaces all bindings; `{}` clears them.
- Each secret file must be regular, single-link and private to the agent's account or an administrator, at most 16 KiB of UTF-8 without NUL. Unix reads it with no-follow, descriptor-relative traversal; Windows pins handles and checks the owner, access list and final path.
- In full mode, values containing `$VAR`, `${`, `$$` or `SECRET[` are refused so Vector's own interpolation can't reinterpret them.
- The rendered file, staging copies and verified backups contain the values and stay private. Status, heartbeats, the template cache and exports never do. `secret_revision` increases before each new effective attempt; `applied_secret_revision` records the last verified one.

## Telemetry

The agent scrapes a `prometheus_exporter` sink it finds in the running configuration: one on a literal loopback address, without TLS or auth, whose inputs reach an `internal_metrics` source. `configure-metrics --metrics-url` overrides discovery. Scrapes are bounded to 1 MiB, 5,000 series, 10,000 lines and 32 KiB per line, within three seconds, with redirects and proxies disabled.

It reports events in (sources other than `internal_metrics` and `internal_logs`), events out (sinks other than those fed only by such sources, like the exporter), bytes, errors per minute, discarded events split into expected filtering and drops due to errors, buffer fill, uptime and up to 50 running components. It drops host, URI, file and free-form labels and never invents zeros for missing series. It never inserts monitoring components or opens a public endpoint, and never uploads events.

## Test evidence

CI runs `go test ./...` with the native tests enabled on Ubuntu 24.04, Windows Server 2025 and macOS 15 (Apple silicon), against the official Vector 0.58.0 archive checked by its pinned SHA-256: real validation, reload or restart, drift repair, rollback, telemetry, secret rotation and full mode. [TEST-EVIDENCE.md](TEST-EVIDENCE.md) is the historical record of the earlier Windows runs, including a foreground upgrade. Linux x86-64 also runs end to end with real Vector 0.58.0 in the local demo fleet. Service registration, reboot and upgrade on each platform, power-loss tests, macOS child cleanup after a forced kill, and long outages are still release gates. See [Compatibility](../docs/user/compatibility.md).
