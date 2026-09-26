# Vectory agent

The Go agent manages one explicitly adopted Vector 0.58.0 process and one JSON configuration. It connects outbound to the dedicated Vectory agent TLS listener. It never installs Vector and never accepts remote commands, executable paths, service names, or a weakening of its local capability policy.

## Build and checks

Go 1.26.8 is pinned in `go.mod`, verified against the [official release feed](https://go.dev/dl/?mode=json). Normal builds are pure Go:

```powershell
cd agent
$env:CGO_ENABLED='0'
go build -trimpath -o vectory.exe ./cmd/vectory
go test ./...
go vet ./...
$env:VECTOR_TEST_BINARY='C:\absolute\path\vector.exe'
go test -v ./internal/agent -run TestNativeVectorActivationAndRollback
```

The native test uses an explicitly synthetic `demo_logs` pipeline and a blackhole sink. It actually validates, starts Vector, observes its acknowledgment and liveness, repairs drift, and rolls back a startup that terminates early. Tests without `VECTOR_TEST_BINARY` skip that native check and cannot establish native compatibility.

## Adoption and enrollment

Stop and disable the old Vector service before adoption. Inventory its command line, include files and `--config-dir` paths. Move all intended semantics into the sole managed JSON document; Vectory supplies only that document when starting its child. Preserve the original service definition so adoption can be reversed. `install --adopt` is the host operator's explicit assertion that this inventory and shutdown are complete. The agent does not take over unrelated running processes.

Use a dedicated service account and dedicated private state/config directories. The installer protects the state directory, managed file's parent directory and generated files: POSIX modes 0700/0600, Windows protected DACL for the installing identity and SYSTEM. Run installation and steady operation under the same intended account, or explicitly provision equivalent account ACLs. Do not point `--managed-config` into a shared directory: adoption deliberately makes that directory private. State and Vector data directories should be separate; never allow the agent state directory as a pipeline file root.

Create an operator-owned local policy, for example:

```json
{
  "allowed_file_roots": ["C:\\ProgramData\\VectorData"],
  "allowed_network_hosts": ["logs.example.net:443"],
  "allowed_listen_addresses": ["127.0.0.1:4318"]
}
```

Create the data directory and set the published config's `data_dir` to that existing absolute path. Full Vector validation checks the real environment; Vectory does not bypass it with `--no-environment` or `--skip-healthchecks`. On Windows, Vector's default `/var/lib/vector` normally does not exist, so an explicit `data_dir` is necessary.

```powershell
vectory install --state-dir C:\ProgramData\Vectory --vector-binary 'C:\Program Files\Vector\bin\vector.exe' --managed-config C:\ProgramData\VectoryConfig\managed.json --capability-policy C:\secure\capabilities.json --adopt
Get-Content C:\secure\enrollment-token.txt | vectory enroll --state-dir C:\ProgramData\Vectory --server https://vectory.example.net:8443 --ca-file C:\secure\server-ca.pem --id edge-01 --token-stdin
vectory doctor --state-dir C:\ProgramData\Vectory
vectory run --state-dir C:\ProgramData\Vectory
```

On Linux/macOS use the same commands with absolute platform paths. The `service` command implements Windows SCM service execution and is also usable under an external Unix supervisor. Explicit `service-install` registers the current absolute executable and state directory; `service-start`, `service-stop`, and `service-uninstall` invoke only the fixed Vectory service. On Linux/macOS supply `--service-user <existing-unprivileged-account>`; systemd/launchd registration requires root, preserves differing existing definitions, and assigns only the dedicated state/config trees to that account. Windows registration uses the dedicated `NT SERVICE\Vectory` virtual account and grants it the dedicated state/config directories. Host operators must separately provision that account's Vector binary execution and data-root access. Service installation does not start the workload or establish tested service operation. The CLI never silently enables privileged services. `run --once` is a test convenience and stops the owned child when it exits; use continuous `run` for a lasting workload.

Enrollment also accepts a protected `--token-file`, hidden interactive input, or compatibility form `vectory -ip <server> -id <machine-name> -token <token>`. Compatibility enrollment assumes installation is already completed and still requires HTTPS hostname/IP SAN validation. Command-line tokens can appear in shell history and process listings. No token is persisted. A private CA must come through a separately trusted channel; the agent never bootstraps server trust from an unverified endpoint.

## Operation and state

- `status --json` reports actual current file digest, cached apply state, pause, drift and metric availability. It does not invent throughput/error counters.
- `pause` writes a durable local emergency marker immediately. A run in progress may finish/roll back a commit already started; the next heartbeat acknowledges pause only after that work completes. Remote resume cannot remove local pause.
- `resume` removes only local pause. Manual changes are replaced on the next authorized reconciliation unless remote pause remains enabled.
- `retry` clears suppression of a rejected generation while the daemon is stopped; restart the daemon afterward. A new server generation also permits a new attempt.
- `recover-enrollment --token-stdin` uses an administrator-issued, one-use device recovery token while the daemon is stopped. It preserves the local workload and local emergency pause, generates a new local key, and enrolls the replacement UUID. A durable identity transition journal resets generations only after the explicitly authorized replacement identity is committed. The old device's groups/assignments do not transfer. Authentication failures never trigger this operation automatically.
- `unenroll` removes local key/certificate/enrollment request while stopped, retaining workload/state. Revoke the device in the dashboard separately; offline local deletion cannot revoke server authorization. Re-enrollment of the old name requires the control plane's explicit recovery procedure.
- `uninstall` preserves identity/state. Remove service registration and binaries with the package manager. `uninstall --purge` deletes only the explicitly supplied installed state directory, while stopped; the externally configured managed file is retained.

Exit codes: 0 successful command, 1 operational/security/preflight error, 2 invalid command/options. `--json` provides machine-readable output. Errors omit configuration text, Vector's raw output, enrollment credentials and server error bodies.

Generations and semantic identities are durably persisted before fetching artifacts. Every poll hashes the actual managed file. A same-generation manifest is valid only if its desired/policy identities remain unchanged. Explicit rollback requires a newer generation. Local recovery uses a content-addressed last **verified** artifact; the separate pre-attempt snapshot can contain drift and is never promoted automatically. Journal fault tests cover validation, prepare, write, reload request, observed activation and durable verification. These are simulated boundary failures, not a claim of tested physical power loss.

The supervised lifecycle is deliberate: stopping/crashing the agent causes its helper to stop its owned Vector child; restarting the agent starts the current managed workload and recovers incomplete transactions. A control-plane outage or expired/revoked credential does not stop an already running child. Expired credentials do not prevent restoration of local last-good content at startup; network TLS still rejects expired credentials. There is no token-heartbeat fallback. Ordinary supervisor startup can launch the preserved current file while sync is paused, without replacing local edits.

## Verification and local security boundary

The fixed binary is SHA256-pinned at adoption and checked before each validation/start. Validation and launch use argument arrays and scrubbed environments, strict timeouts and bounded output. Activation requires the exact Vector 0.58 startup record from this newly started child, two seconds of liveness and a matching managed-file digest. A health endpoint, unrelated process, downloaded file or write cannot establish activation.

For this pinned release, JSON internal logging uses **stdout** (`src/trace.rs`), so console sinks must explicitly use `target: "stderr"`; stdout/default console is denied to prevent pipeline payloads from forging startup acknowledgment. The wrapper discards pipeline output and does not forward logs/events to the control plane.

Supported local-policy component set: sources `demo_logs`, `internal_metrics`, `file`, `http_server`, `syslog`, `opentelemetry`; transforms `remap`, `filter`, `route`, `sample`, `reduce`, `log_to_metric`; sinks `console`, `blackhole`, `http`, `loki`, `elasticsearch`, `prometheus_exporter`. Unknown components/root settings fail closed. File roots, exact network host:port destinations and listener addresses require local allowances. Network components must provide explicit destinations/listeners so implicit defaults cannot bypass local allowances. Execution sources, secret providers, external VRL files, environment substitution (`$VAR` and `${VAR}`), dynamic resource templates and unsafe VRL external lookups are denied. Disk data paths and TLS material paths must fall within allowed roots. API binding must be explicit loopback.

These are configuration restrictions, **not** a complete filesystem/network sandbox. DNS rebinding, allowed HTTP redirects/endpoints, changes to resources after validation and local administrators remain outside the static allowlist guarantee. Apply host firewall/network namespace and filesystem confinement when this stronger boundary is required. Agent and its Vector child currently share an OS principal; separate credential protection against a fully compromised Vector child is a remaining hardening gate. Windows restart uses forced termination; no lossless delivery claim is made. Linux uses SIGTERM with a bounded kill fallback.

Server certificate rotation uses the separately provisioned OS/private-CA trust store. Client credential and manifest signing trust refresh through authenticated renewal; replacement server CAs require local trust provisioning. Renewal generates a replacement ECDSA key and stores it before the request. A single private `identity.json` atomically commits the corresponding key, certificate and signing trust. Old PEM files are compatibility mirrors; torn mirrors cannot replace the canonical identity. An expired/revoked offline identity needs the explicit administrator recovery token flow. Restore of an old server database must not reset agent generations.

## Optional local telemetry

Provide a visible `internal_metrics` source feeding a `prometheus_exporter` sink with an explicit loopback address in the published pipeline. Authorize that listener in the local capability policy and pass `install --metrics-url http://127.0.0.1:9598/metrics` (idempotent install can add this local setting while stopped). The agent never inserts monitoring components and never enables an unauthenticated public endpoint. Only literal loopback IPs and an explicit port/path are accepted; redirects/proxies are disabled for this scrape.

The adapter accepts at most 1 MiB, 5,000 series, 10,000 lines and 32 KiB per line, with a three-second timeout. It reports aggregate source events/second from `component_sent_events_total` (excluding internal_metrics sources), observed cumulative `component_errors_total` and `component_discarded_events_total`, current `buffer_size_bytes`, and `uptime_seconds`. At most 50 components with strict IDs up to 100 characters report their sent-event rate, error/discard counters and buffer bytes when observed. Component types are bounded; host, URI, filename, error-detail and arbitrary labels are discarded. The server stores bounded sample history separately. The adapter accepts the pinned `vector_` namespace or an empty namespace. First samples, counter/process resets, missing series and unreachable exporters do not become invented zeros. CPU and RSS remain unavailable because the tested Windows internal exporter does not expose those process resources. Remote telemetry pause stops collection but does not stop heartbeats or workload. No event payloads or user samples are uploaded.

## Device-local credential references

Publish the exact string `vectory-secret:API_TOKEN` in a supported sink's `auth.user`, `auth.password`, or `auth.token` field. The only supported sink types are `http`, `loki` and `elasticsearch`; references anywhere else, embedded text, provider execution and interpolation are rejected. Names match `[A-Za-z][A-Za-z0-9_.-]{0,63}`. The host operator approves a local JSON map such as `{"API_TOKEN":"C:\\secure\\api-token.txt"}` with `install --secret-files <absolute-map.json>` or stopped-agent `configure-secrets --secret-files <absolute-map.json>`. The map and secret files stay on that device; configuring an empty map removes its bindings.

Each file must be a regular, single-link private file owned by the agent account or system administrator, with at most 16 KiB UTF-8 text and no NUL. One final CRLF/LF is removed; other contents are inserted only as a JSON string value. Unix uses descriptor-relative no-follow traversal with handle ownership/mode checks; Windows uses pinned handles, handle DACL/owner checks, no write/delete sharing and reparse/final-path checks. Symlinks, hardlinks and broadly readable files fail closed. Provision permissions for the actual service identity. Rotate by replacing the protected local file; the next authorized, unpaused poll re-renders even when the desired generation is unchanged.

The immutable artifact hash describes the reference template. `actual_sha256` describes the rendered managed file, while `applied_template_sha256` binds the last verified rendered file to its published template. A monotonic local `secret_revision` records each new effective attempt before validation; `applied_secret_revision` identifies the last verified local revision and does not move on rollback. Failed effective digests are suppressed, but a changed local value allows another same-generation attempt. Effective configuration is rechecked against the local capability policy and actual Vector validator. Generic error categories suppress subprocess diagnostics. The rendered managed file, stages and last-good/pre-attempt backups contain credentials and are protected with the agent's private file permissions; status, heartbeat, template cache and exports contain no resolved values. These hashes are operational identifiers, not password-strength protection; use high-entropy credentials.

## Evidence and remaining release gates

See [TEST-EVIDENCE.md](TEST-EVIDENCE.md). Windows 11 amd64 native foreground, local-secret rotation and loopback telemetry tests pass with official Vector 0.58.0. Linux amd64/arm64 and macOS amd64/arm64 binaries are **cross-compiled only** here; they are not tested support claims. Native package installation, SCM/systemd/launchd/reboot/upgrade tests, earliest supported OS tests, real power-loss tests, macOS orphan-child handling after helper SIGKILL, separate Vector identity, process-resource telemetry adapters and long-duration outage tests remain release gates. Do not label these artifacts production ready.
