# Vectory — implementation prompt for a team of agents

You are the lead engineering agent coordinating a team to design, implement, test, and document **Vectory**, a fully open-source, standalone, self-hosted configuration management portal for **Vector by Datadog**.

Implement a working product, including the Rust API, React/TypeScript dashboard, SQLite persistence, and portable Go agent. Work in a dedicated Vectory repository. If this prompt is provided inside an unrelated repository, establish the correct workspace before creating application code. Do not modify the unrelated project.

This document is the product specification and implementation contract. Deliver integrated vertical slices, not disconnected scaffolds, screenshots backed by mock data, or a plan without implementation. Make routine decisions autonomously and record consequential decisions in architecture decision records (ADRs). Ask only when missing information blocks a safe implementation or changes a product requirement. External publishing, signing credentials, and infrastructure access may require maintainer participation; prepare everything reviewable first and report the exact remaining prerequisite.

## 1. Product outcome and fixed constraints

An operator must be able to:

1. Start Vectory with Docker Compose on their own infrastructure.
2. Open a polished dashboard, securely initialize the first administrator, and download the appropriate agent and a time-limited, reusable installation token.
3. Install the agent on a machine already running Vector and enroll it under a unique machine name.
4. Visually build a Vector pipeline by connecting sources, transforms, and sinks; save drafts; inspect version history; publish an immutable version.
5. Assign that version to individual devices, device groups, or a combination, immediately or at a scheduled time.
6. Observe agents fetch and safely apply the assigned configuration through outbound-only communication.
7. See telemetry, deployment progress, drift, validation errors, rollback results, and actionable device issues.
8. Change bounded agent behavior through the same target-selection interface, including heartbeat interval and configuration-sync pause.

Fixed technology choices:

- **API/control plane:** Rust. Default to Tokio, Axum, Serde, and SQLx unless an ADR justifies another Rust implementation.
- **Dashboard:** TypeScript and React. Default to Vite, an accessible component system, and React Flow for the pipeline canvas. Use freely available library capabilities; no paid editor dependency.
- **Durable database:** SQLite for configurations, versions, users, devices, assignments, deployment state, and audit events.
- **Device agent:** Go, delivered as native binaries for supported Windows, macOS, and Linux targets.
- **Deployment:** Docker/Compose is the primary server installation path. Package the dashboard with the server for a simple same-origin installation.
- **Network direction:** Only the agent initiates communication with Vectory. No server-to-device connections, SSH, inbound agent API, reverse tunnel, remote shell, or general remote command feature. A response to an agent-initiated request is allowed.
- **Commercial model:** No SaaS dependency, billing, subscriptions, license server, paid feature gates, mandatory hosted identity, required external account, or phone-home analytics. Core operation must work without public internet once dependencies and release artifacts are available locally.

Vector remains the data plane. Vectory manages its configuration and reports health; it does not collect customers' pipeline event payloads by default. Vector is already installed; never silently install, upgrade, or replace it.

## 2. Team organization and execution rules

Create these workstreams, adapting their concurrency to available agent slots. A role is an ownership boundary, not a requirement to run every role simultaneously.

| Workstream | Responsibilities | Primary deliverables |
| --- | --- | --- |
| Lead/integrator | Architecture, sequencing, contracts, integration, acceptance evidence | ADRs, task board, integrated releases, final report |
| Security reviewer | Threat model, enrollment/authentication, authorization, secrets, abuse testing | Security design, negative tests, review findings |
| Rust backend | API, persistence, assignments, scheduler, desired-state resolver, audits | Server, migrations, OpenAPI, backend tests |
| Go agent | Enrollment, credentials, heartbeat, reconciliation, OS adapters | Agent, native integrations, recovery tests |
| Dashboard/UX | Design system, onboarding, fleet views, graph editor, deployment workflows | Accessible production UI, browser tests |
| Vector integration | Versioned component catalog, rendering, validation, telemetry, reload verification | Capability matrix, fixtures, integration adapters |
| QA/release/docs | Cross-platform tests, Compose, packaging, backup/restore, contributor experience | CI, release artifacts, operational documentation |

Before parallel implementation, agree on the domain model, OpenAPI contract, heartbeat/manifest schemas, error codes, artifact-hash definition, state machines, directory ownership, and test fixtures. Use generated or schema-validated clients to prevent Rust/Go/TypeScript contracts from drifting. Breaking contract changes require coordinated updates and tests.

Suggested repository layout: `server/`, `dashboard/`, `agent/`, `contracts/`, `vector-catalog/`, `deploy/`, `packaging/`, `tests/`, and `docs/`.

Give each agent a concrete deliverable, acceptance criteria, dependencies, and owned files. Do not let agents concurrently edit the same migration, shared schema, or release manifest without coordination. Integrate continuously. Keep security review independent from the author of sensitive code. A reviewer must check actual implementation, not merely approve this specification.

Maintain a requirements-to-tests checklist. Report what was run, observed, and still unverified. Compilation, a cross-compile, a mock test, and a real native integration test are different evidence. Never claim universal portability, perfect security, zero data loss, or unmeasured capacity.

## 3. Portability contract

The product goal is **maximum practical portability with minimal installation dependencies**. “Works on any version of Linux/macOS/Windows” cannot be an honest guarantee: operating systems, CPU architectures, Go runtimes, and Vector itself impose compatibility limits. Publish an explicit tested support matrix instead. Go's documented runtime minimums are a starting constraint, not proof of end-to-end compatibility. [Go minimum requirements](https://go.dev/wiki/MinimumRequirements)

Start with Linux amd64/arm64, macOS Intel/Apple Silicon, and Windows amd64. Add Windows arm64, Linux armv7, and other targets only when the agent and a compatible Vector distribution have passed native tests. Pin supported Go and Vector versions at implementation time and record minimum kernel/OS/CPU requirements. Do not retain an insecure obsolete toolchain merely to claim support for an end-of-life OS.

Deliver a small native binary per target. Prefer pure-Go dependencies and `CGO_ENABLED=0` Linux builds; inspect release artifacts to verify the intended absence of a dynamic libc dependency. Use conservative CPU instruction targets. Managed devices must not require Node, Python, Docker, a compiler, or a shell for normal agent operation. Windows and macOS binaries still depend on supported native OS APIs.

Implement tested adapters for filesystem replacement, file permissions/ACLs, credential storage, process control, and services. Support foreground operation under an external supervisor, plus systemd, launchd, and Windows Service Control Manager. Do not assume every Linux device has systemd, or that POSIX signals and rename semantics work on Windows.

Support private CAs, enterprise proxies, restricted egress, and offline installation bundles. “Offline installation” means no public-internet dependency; the agent must still be able to reach its Vectory server. Unsupported combinations must fail preflight with an actionable explanation, while preserving any running Vector instance.

## 4. Installation and enrollment

The dashboard's onboarding wizard must provide OS/architecture selection, verified release downloads, release checksums/signatures, server URL and CA instructions, token creation, installation commands, and enrollment status. Do not embed installation tokens in binaries or permanent download URLs.

Implement CLI commands such as `install`, `enroll`, `run`, `status`, `doctor`, `pause`, `resume`, `unenroll`, and `uninstall`, with stable exit codes and optional JSON output. Installation and enrollment are separate operations internally; a convenience command may combine them. Installation is idempotent. Upgrades preserve identity, settings, credentials, and recovery state. Uninstall preserves state unless an operator explicitly requests purging it.

Support the requested compatibility form:

```text
vectory -ip <server> -id <machine-name> -token <install-token>
```

Prefer this safer shape in generated instructions:

```text
vectory enroll --server https://vectory.example.com --id edge-01 --token-stdin
```

Also support a protected token file or interactive secret entry. Explain that a token supplied as a command argument can appear in shell history and process listings. A bare IP must still use HTTPS and match the certificate's IP SAN. Never provide an automatic insecure-TLS fallback.

Installation may require sudo/administrator rights to create directories, set permissions, and register a service. Steady-state execution must use the least privileged identity that can manage the explicitly configured Vector instance. Where necessary, use a narrow privileged helper restricted to fixed configuration paths and allowed service operations. Do not grant blanket sudo or let dashboard policy select executables, services, or arbitrary filesystem destinations.

Installation tokens must be cryptographically random, reusable until a configurable expiry, revocable, enrollment-only, and displayed once at creation. Store a secure verifier rather than plaintext. Support optional usage limits, allowed name prefixes/preapproved names, and administrator-defined enrollment scope. Default enrollment must not automatically grant a new device sensitive production assignments or secret access. A leaked reusable token permits enrollment within its scope; document and contain that risk.

Use a server-generated immutable device UUID plus a normalized, unique human-supplied machine name. The name is not an authentication credential. Enforce uniqueness with a database constraint and transactional enrollment. Two simultaneous enrollments for the same name must create exactly one device. Failed/expired/revoked enrollment must not create an active device record.

Before transmitting an enrollment token, verify the server using the OS trust store or a private CA/trust fingerprint obtained through a separately trusted channel. Never download an unknown CA from the enrollment endpoint and automatically trust it. Default to TLS 1.3; support TLS 1.2 only where a documented compatibility need exists, without insecure protocol/cipher fallback. [OWASP TLS guidance](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html)

Generate and persist the device private key locally with restrictive permissions/ACLs before enrollment; never transmit it. Prove possession when exchanging a valid token and enrollment request for a per-device identity and short-lived mTLS credential. The server constructs the certificate identity and allowed extended key usage itself; it must not trust CSR-requested names or privileges. Authenticate against the dedicated device trust chain plus the active UUID/certificate registration, not simply any certificate from a broad enterprise CA. Keep device credentials inaccessible to the Vector process wherever the local privilege model permits.

Never use the installation token for subsequent heartbeats. Make retries after a lost enrollment response idempotent and bound to the original key/request; matching a name alone must never permit identity recovery or takeover. Device replacement/re-enrollment requires an explicitly authorized recovery flow that revokes the old identity. Token possession proves permission to request enrollment, not that the machine is a particular trusted physical host; production access may require approval or separately provisioned device credentials.

The authenticated dashboard must display successful enrollment and an audit event. Unauthenticated responses must not expose device lists or distinguish useful name/token states. Apply rate limits, bounded request sizes, and generic failures; token holders receive only the enrollment information their scope permits.

## 5. Configuration, versions, and deployment state

Model these separately:

- **Configuration:** named pipeline with ownership/description and editable draft.
- **Draft revision:** immutable snapshot from each explicit save, with author, timestamp, and optional message. Use optimistic concurrency so simultaneous edits cannot silently overwrite one another.
- **Published version:** immutable graph, rendered Vector artifact, compatibility constraints, hash, validation results, author, and change description.
- **Assignment:** a published version or complete agent policy bound to a target selector and explicit priority.
- **Deployment:** immediate or scheduled activation, target snapshot, rollout policy, per-device progress, and cancellation/rollback history.
- **Device desired state:** authoritative resolved configuration and policy with monotonically increasing generations.
- **Device reported state/apply attempts:** what the agent has received, validated, written, activated, observed, or rejected.

Publishing makes a version available for assignment. It does not silently update every deployment that once used that configuration. The publish wizard may explicitly create a deployment in the same workflow. Editing a draft never changes a published artifact. Rollback creates a new desired-state generation pointing at an older immutable version.

Hash precisely defined artifact bytes with SHA-256. Keep canvas coordinates and presentation metadata outside the deployment-content hash. If device variables change the rendered artifact, compute a distinct artifact digest. Distinguish template/version identity, delivered artifact digest, and actual managed-file digest; do not mix their meanings. Version variable bindings, validate their types, and prevent substitution from changing the configuration structure unexpectedly.

Support YAML, TOML, and JSON import/export where Vector supports them. Preserve unsupported fields semantically; do not silently delete them through a visual edit. Explain any formatting/comment normalization. Store secret references rather than plaintext secrets in version history and exports.

Keep `desired`, `downloaded`, `validated`, `written`, `reload_requested`, `verified_applied`, `failed`, and `rolled_back` distinct. An HTTP download or successful file write is not deployment success.

## 6. Unified targeting, conflicts, and scheduling

Use the same reusable target selector for Vector configurations and agent policies:

```text
target devices = (explicit devices UNION members of selected groups)
                 MINUS explicit device exclusions
```

Deduplicate devices. Support static groups initially, with search, labels, and clear membership management. Self-reported device labels must not grant privileged group membership or secret access. Dynamic groups may follow once their security and reevaluation semantics are tested.

Each device receives one complete effective Vector configuration and one complete effective agent policy. Do not implicitly merge arbitrary YAML from several assignments. Resolve each resource type independently: the highest explicit priority wins; equal-priority assignments with identical payloads are equivalent; equal-priority different payloads are a conflict. There is no hidden direct-device override and no timestamp/SQL-order tie breaker.

Preview effective results and conflicts before activation. Reject a conflicting assignment or membership edit transactionally. If reconciliation detects an inconsistent state, preserve the last valid desired state and expose the conflict. The device page must explain why a version/policy applies, including the winning assignment, priority, and groups. Removing the last assignment retains the working Vector configuration and marks it unmanaged; it must not delete it or stop Vector.

Assignments to groups are persistent: subsequent membership changes trigger resolution, compatibility checks, audit events, and separately tracked convergence for affected devices. A deployment's original target snapshot remains immutable for accurate progress reporting. Define new-member handling during canary rollouts; do not let a newly joined device bypass an active gate. Removing a device from a group resolves its next applicable assignment rather than inventing a rollback.

Scheduling belongs to a deployment of an immutable version/policy. Store UTC activation time and display the selected local timezone. Make target mode explicit: a persistent selector follows group membership, while a snapshot targets fixed device UUIDs. For v1 scheduled deployment, freeze concrete target membership at scheduling time and activate assignments against those UUIDs; do not also create a live group binding as a side effect. Clearly show this behavior and offer a refresh-and-review operation before activation. Persistent group assignments remain a separate supported workflow; later scheduled live-selector support must define its membership semantics explicitly.

Use a durable scheduler with transactional state transitions and idempotent activation. Support cancellation, server-restart recovery, and a configured late-start deadline: missed schedules within the deadline activate once; older ones become visibly missed and require operator action. Revalidate device authorization/compatibility at activation. Document the outcome when cancellation races activation.

Support all-at-once and canary/batched rollouts with a health observation window, bounded failure threshold, pause/cancel, and explicit rollback. Separate candidate effective assignments from per-device released desired state: only release a new generation to a device when its rollout gate opens. Heartbeats must never deliver an unreleased candidate and bypass the canary. Define serialization/supersession when deployments overlap. Offline and verification-unknown devices cannot satisfy a success gate. Cancel withholds further admissions; already released devices may still apply until they observe a superseding generation. Stopping a rollout does not undo devices already updated; rollback is its own operation. Authorizing an assignment or privileged group change is a deployment-capable action and requires corresponding permissions.

## 7. Heartbeat and configuration protocol

Default to an outbound heartbeat every **60 seconds**, with jitter to avoid synchronized load. Use timeouts, bounded exponential backoff, retry-after handling, connection reuse, and bounded local telemetry queues. Keep control-state acknowledgments durable even when optional telemetry is dropped. Reconnection must not cause a fleet-wide request storm.

Agree on a versioned protocol before implementation. A heartbeat reports protocol/agent/Vector versions, supported capabilities, request/boot identifiers, reported generations, actual managed-content digest, apply state, pause acknowledgment, bounded telemetry, and sanitized errors. The server derives device identity from authentication, not from a trusted request-body UUID.

The response contains server time, the effective agent-policy revision, and desired configuration metadata including immutable version, generation, SHA-256 digest, size, compatibility constraints, and an authorized same-server artifact reference. Unchanged configurations require no repeated artifact download. Policy changes must still arrive when the configuration hash is unchanged.

Use HTTPS with server verification and per-device mTLS after enrollment. Authorize every heartbeat, artifact fetch, credential renewal, and status submission. A device can access only its currently authorized artifacts and report only its own state. Knowing an artifact hash or another UUID must grant no access. Bound historical artifact access explicitly if needed for recovery.

A hash detects content differences; it does not authenticate the server. Use a signed desired-state manifest with a standard audited implementation, binding recipient device UUID, configuration/policy generations, artifact digest/size, protocol/compatibility fields, validity interval, and a fresh unpredictable agent request nonce. A same-generation response may refresh validity only when its payload identity is unchanged and its nonce matches the outstanding request; a changed digest/policy under the same generation is a protocol error. Bootstrap signing trust through the verified enrollment connection; implement key rotation. Persist the highest accepted generations crash-safely. Reordered or stale responses cannot restore old desired state. A deliberate rollback uses a newer generation with older content. Define recovery after restoring an older server backup without silently resetting this protection. Bound clock-skew handling; never use unauthenticated server time to bypass certificate verification.

Do not follow artifact redirects that disclose credentials or accept arbitrary server-supplied external URLs. Protect against downgrade and freeze/replay behavior. Expired manifests stop new application, not the last-known-good Vector workload. Do not invent custom encryption or cryptographic primitives. A compromised server/signing authority remains powerful; signatures do not remove that trust boundary.

Implement certificate renewal before expiry using current valid authentication and proof of possession of any replacement key, with bounded overlap, CA rotation, and clock-skew diagnostics. An expired offline device uses the explicitly authorized recovery flow; never accept expired/revoked credentials as ordinary authentication or fall back to token heartbeats. Check revocation on every operation, including requests on already-established pooled TLS connections. Revoking an installation token stops new enrollments; revoking a device blocks that identity's future authorized API access. It cannot recall delivered configuration or immediately stop an offline host. Credential expiry or revocation must not remotely erase local Vector data. If a reverse proxy terminates mTLS, protect its connection to the API and reject client-forged identity headers.

## 8. Reconciliation, local drift, pause, and recovery

Before each reconciliation, recompute the digest of the **actual managed files**. Comparing only the remote hash to a cached last-applied hash will miss local manual edits and is unacceptable. Identical same-generation metadata remains valid for retries and drift repair. A higher generation with an already verified identical effective configuration does not require an unnecessary Vector reload when relevant bindings and activation requirements are unchanged; acknowledge the generation explicitly.

With sync enabled, detect and report local drift, then restore the desired artifact through the normal validation/apply path, even if the server version has not changed. With acknowledged sync pause, continue heartbeats, credential renewal, telemetry, and policy retrieval, but do not write configuration, reload, or restart Vector to reconcile it. Persist pause across agent restarts.

Dashboard pause must show `requested` until the agent acknowledges it. An offline device cannot be instantly paused through a pull protocol. Show the last acknowledgment time and effective pause reason. Provide a local emergency pause that cannot be silently removed by dashboard policy. Effective pause is local pause OR remote pause. Resume must explain that managed local edits will be replaced; resume follows the latest authorized desired generation.

Define the race between pause and an active apply: acknowledge pause only once no prohibited apply work can continue. Check effective pause immediately before committing staged changes. A local import may be offered as an explicit, authorized, redacted upload into a new draft; never silently promote local files to a published configuration.

Agent policies may set heartbeat interval, telemetry sampling/verbosity, bounded retry settings, and remote sync pause. Use complete versioned policies, local hard limits, and defaults. Policies cannot disable TLS/authentication, remove the local capability policy, stop heartbeats indefinitely, select arbitrary executables/paths, or act as an agent binary updater. Remote Vector/agent binary upgrades are outside v1; provide documented package-based upgrades.

For every apply attempt:

1. Acquire a single-process/apply lock; inspect recovery state and generations.
2. Fetch only the authenticated device's authorized bounded artifact; verify manifest, bytes, compatibility, and local capability policy.
3. Stage securely on the same filesystem as the managed configuration. Enforce path/ownership/ACL rules and reject symlink, path traversal, reparse-point, and executable-substitution attacks as applicable.
4. Validate with the actual installed Vector binary using argument arrays, time limits, output limits, and sanitized diagnostics. Do not use shell interpolation. Validate local environment requirements without disabling safety controls just to make a test pass.
5. Under the apply lock, recheck effective pause and the latest accepted desired generation immediately before committing, since fetch/validation may have taken time. Discard superseded staged work; acknowledge that server changes not yet polled cannot be known locally. Persist a recovery journal and last-known-good configuration, then atomically replace the managed content with a tested OS-specific implementation. Never leave a partially written active file.
6. Request reload through a supported version/platform adapter, or gracefully restart the configured service if required and allowed. Observe the documented interruption/delivery implications.
7. Verify Vector is running and obtain version-specific evidence that the intended configuration was accepted. If exact activation cannot be established, report `verification_unknown`, not success. Deliver at least one fully tested activation mode that proves the intended configuration is active; reporting unknown for every apply does not satisfy this product. If a reload lacks reliable acknowledgment, offer a controlled verified-restart fallback where allowed, or mark that mode unsupported for verified deployment.
8. On failure, restore last-known-good content, activate it, verify the rollback, and report both the original failure and rollback outcome. Suppress endless reapplication of the same rejected generation; allow bounded retry or an explicit new retry request.
9. Recover deterministically if the agent crashes or the host loses power between any two stages.

Keep a pre-attempt backup distinct from the last verified good artifact. Never overwrite last-known-good with an unverified locally drifted file; advance it only after verified activation. If pause arrives after commit, finish or safely roll back the in-flight transaction before acknowledging pause.

Start with one explicitly selected Vector instance and one managed generated configuration file per agent. Inventory the effective Vector startup arguments and existing config files during adoption. Preserve a backup and require explicit local adoption before taking ownership. Do not ignore existing include/config-directory files that alter the effective topology. Supporting unmanaged extra files requires tracking and validating them; otherwise stop with a clear diagnostic.

Do not promise lossless or duplicate-free reload/restart: behavior depends on Vector sources, checkpoints, buffers, and sinks. Verify the actual supported reload and validation capabilities. [Vector management](https://vector.dev/docs/administration/management/), [Vector validation](https://vector.dev/docs/administration/validating/)

## 9. Visual pipeline editor and dashboard quality

Deliver an original, modern, cohesive interface suitable for a public open-source product. Use Datadog Observability Pipelines as a functional reference, not a source of copied branding or assets. Include consistent typography, spacing, useful density, clear status language, restrained motion, and light/dark themes. Avoid decorative metrics and nonfunctional buttons.

The editor needs a searchable source/transform/sink palette; typed input/output handles; drag/drop and keyboard alternatives; connect/disconnect; multi-select; duplicate/delete; pan/zoom; fit view; auto-layout; undo/redo; and persisted canvas layout. Include a properties inspector with required fields, defaults, documentation links, validation errors, and a VRL editor where relevant.

Maintain one canonical configuration model used by graph and code views. Validate duplicate component IDs, missing inputs, incompatible connections, route outputs, cycles where forbidden by the selected Vector version, and unsupported fields. Represent named route outputs accurately. An edge must compile to the correct Vector `inputs` reference. Mark disconnected components clearly. Canvas movement alone must not deploy new runtime configuration.

Use a versioned component catalog based on supported Vector schemas/docs. Verify whether an official machine-readable schema covers the necessary fields; do not invent schema support. Provide generic schema-driven editing and a raw-code escape hatch for components lacking a bespoke form. Show unsupported visual components as explicit opaque nodes, preserve their data, and apply the same security/validation rules to raw imports.

Ship tested starter pipelines and a useful first catalog: file/syslog/HTTP or OpenTelemetry sources as supported, remap/filter/route/sample transforms, and console/HTTP plus common production sinks such as Elasticsearch, S3, or Loki. Select and test the exact initial set against the pinned Vector versions; distinguish fully supported forms from generic coverage. Do not claim every Vector component is fully supported because arbitrary text can be entered.

Include draft autosave with visible status, explicit saved revisions, unsaved-change protection, publish validation, semantic/text diffs, version history, and rollback deployment. Sample-event/VRL testing must use user-provided synthetic samples and isolated bounded execution; no production event tapping by default.

Required screens: overview, devices, device detail, groups, configurations/editor, version comparison, deployment preview/progress, schedules, agent policies, enrollment tokens/downloads, issues, audit log, users/security, and instance settings. Reuse target selection and result presentation across Vector and agent-policy operations.

Device detail must show desired versus reported state, effective assignment explanation, last heartbeat, Vector/agent versions, telemetry freshness, drift, pause requested/acknowledged, and remediation guidance. Distinguish offline, stale telemetry, paused, unmanaged, incompatible, applying, failed, rolled back, verified, and verification unknown. Never represent missing telemetry as zero errors or zero throughput.

Provide pagination/search/filtering, bulk operations with concrete target previews, accessible focus behavior, labels, keyboard navigation, sufficient contrast, loading/empty/error states, and helpful first-run examples. Keep infrastructure details out of normal user flows unless they affect a decision. Test the actual UI at realistic fleet sizes and canvas sizes, not only a three-node demo. [React Flow](https://reactflow.dev/)

## 10. Security model and secrets

Write a threat model covering external attackers, leaked reusable tokens, compromised devices, malicious authenticated users, stolen backups, compromised publishers/administrators, and a compromised server. Document what local operating-system administrators can bypass. Map trust boundaries and attack surfaces before writing sensitive code.

Vector configuration is privileged policy: its `exec` source can run programs, and secret backends may execute commands. File inputs and network sinks can read and exfiltrate data. Enforce a locally configured capability policy covering dangerous components, secret providers, file roots, and network destinations. Disable command-executing capabilities by default. Expanding that local policy requires explicit host-operator action; an ordinary dashboard deployment cannot weaken it. Define and test hostname/IP/DNS enforcement limits rather than claiming a string allowlist is a complete network sandbox. [Vector exec source](https://vector.dev/docs/reference/configuration/sources/exec/), [Vector secret backends](https://vector.dev/docs/reference/configuration/secrets/)

Server-side validation and sample execution must run in an isolated worker with no production secrets, no privileged host mounts, restricted filesystem, restricted network, resource/time/output limits, and no container-engine socket exposed to the public API process. Treat imported configs, parsers, templates, and validation output as hostile. Disabling Vector environment checks alone is not a security sandbox. Device-side validation must respect the local capability policy too. Enforce policy against the effective configuration after variable/secret substitution, or reject substitution/backend combinations that cannot be safely evaluated. Checking only the pre-substitution template is insufficient. Secret rotation that changes effective runtime behavior must trigger a tracked reconciliation even if the template's hash is unchanged.

Implement viewer, editor, publisher/operator, and administrator permissions with server-side enforcement. Separate draft editing from publishing, targeting, scheduling, group changes that affect deployment, token issuance, credential revocation, and secret administration. No self-service public signup. Secure first-admin bootstrap with a one-time local secret and transactional completion. No default password.

Use established authentication libraries and Argon2id for local password storage. Protect browser sessions with Secure/HttpOnly/SameSite cookies, CSRF protection, session rotation/revocation, expiration, login throttling, and security headers/CSP. Support MFA for privileged users and document recovery without introducing a mandatory external identity provider. An optional OIDC integration may follow after local authentication works. Do not keep long-lived administrative credentials in browser localStorage.

Prefer device-local secret references. If central secret distribution is included, encrypt values using an externally supplied master key and audited AEAD, authorize delivery per device, implement rotation, and exclude plaintext from history, ordinary responses, exports, diffs, logs, audits, telemetry, and validation stderr. Do not treat a backup containing both encrypted secrets and an unprotected master key as confidential. Device-local files and recovery copies need restrictive permissions and retention.

Audit enrollment, failures, publish, assignment, group edits, scheduling, pause/resume, policy changes, credential/secret actions, rollback, and administrative security changes. Record actor, target IDs, revisions, time, outcome, and request correlation; never record credentials or raw secrets. Keep security audits append-only at the application level. Do not call them tamper-proof against a database administrator. Support export to an operator-controlled external audit destination without requiring one.

Apply request/decompression/parser limits, SQL parameterization, object-level authorization, rate limits, bounded expensive work, output encoding, and dependency updates. A compromised device must not impersonate peers, grant itself groups, retrieve unrelated artifacts, or exhaust storage using unlimited metrics. Turn these into negative tests. [OWASP REST security guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)

## 11. Vector telemetry and operational visibility

Collect only bounded operational metrics by default: process health/uptime, version, component throughput, errors, discarded events, buffer pressure, available resource usage, apply progress, and sanitized diagnostic summaries. Keep device identity and sample timestamps explicit; handle process restarts/counter resets. Use allowlisted labels and series/cardinality limits. Store metric availability separately from zero values.

Implement telemetry adapters for supported Vector versions. Current official documentation describes a gRPC observability API, with a transition from earlier GraphQL versions, and warns that the API has no authentication. Keep it bound to loopback or an equivalently isolated local namespace. Do not expose it on an untrusted interface for convenience. A healthy `/health` response proves process availability, not that a particular configuration is active. Verify behavior against the pinned release. [Vector API](https://vector.dev/docs/reference/api/)

Vector's internal metrics can also feed a local metrics endpoint that the agent scrapes. Any generated monitoring components must be visible, versioned, collision-free, and included in validation. Do not silently modify unrelated pipelines merely to enable monitoring. Continue heartbeats and surface an actionable warning when telemetry is unavailable. No tap or raw event sampling by default. [Vector monitoring](https://vector.dev/docs/administration/monitoring/)

Provide per-device and fleet summaries with last-update timestamps, recent trends, affected-component drilldown, and a persistent issue list. Errors need a stage, code, sanitized message, occurrence count, first/last occurrence, desired version, and retry/remediation state. Retrying an apply is a bounded protocol operation, not an arbitrary remote command.

## 12. SQLite, capacity, and self-hosted operations

Use SQLite on a local persistent filesystem with WAL, foreign keys, migrations, appropriate indexes, short transactions, explicit durability settings, and bounded busy handling. Support one active control-plane instance initially. Do not advertise active-active replicas or put the WAL database on a network filesystem. Keep effective desired-state lookup indexed and cheap; resolve assignment changes outside the hot heartbeat path. [SQLite WAL constraints](https://sqlite.org/wal.html)

Persist current device snapshots and bounded recent/downsampled telemetry with configurable retention. Do not create an unbounded JSON history row for every heartbeat. Coalesce optional telemetry writes while preserving durable apply transitions and security audits. Document retention defaults, storage estimates, payload/series limits, queue limits, and drop counters. Offer optional Prometheus export or external long-term metrics storage without requiring another database for core features.

Ship Docker Compose with persistent state, health checks, secure initialization, TLS setup, non-root containers where practical, and documented secrets. Separate explicitly labeled local development settings from production settings. Do not ship public default credentials or disable certificate verification to simplify the quickstart.

Provide consistent online backup/restore of SQLite plus required keys and artifact state. Use SQLite-supported backup methods; copying only a live main database file is insufficient when WAL state exists. Test restore, migration failure, upgrade recovery, and signing/credential continuity. Explain how restoring old state interacts with agents' persisted anti-rollback generations.

Measure rather than invent capacity: exercise 100, 1,000, and 10,000 simulated authenticated agents with declared heartbeat intervals, jitter, telemetry size, configuration size, churn, hardware, and storage. Report API latency, error rate, CPU/RAM, SQLite contention/WAL growth, storage growth, and rollout convergence. Simulation does not establish native agent compatibility. Set release capacity claims and resource budgets from the results and identify the measured bottleneck.

## 13. Distribution and adoption

Deliver native archives plus `.deb`/`.rpm`, macOS package/Homebrew instructions, and Windows ZIP/MSI paths as validated release targets. Build a signed APT repository workflow and document repository bootstrap. `sudo apt install vectory` works only after the repository has been configured or a distribution carries the package. Never claim an unregistered package/repository already exists.

The dashboard must list only release artifacts actually available in its configured local release catalog, with verified metadata. Allow offline mirroring; it must not require contacting GitHub or a public service on every download. Include offline bundles with binaries, verification material, service definitions, and documentation. Package installation must not embed enrollment secrets or automatically enroll a machine.

Provide release checksums, signatures, SBOMs, provenance, reproducible-build instructions, dependency/license inventory, security scans, and a supported-version/deprecation policy. Native signing/notarization and public package publication require real maintainer credentials; unsigned development outputs must be labeled accurately. Prepare release automation without fabricating signatures or publishing externally without authorization.

Use Apache-2.0 as the proposed project license unless the owner chooses another open-source license. Include third-party notices, contribution guide, development setup, architecture docs, issue/PR templates, code of conduct, security disclosure policy, changelog, and a public roadmap. Check the Vectory name and package namespaces before publication, and clearly state the project's independent relationship to Vector/Datadog.

Ship a short Compose quickstart, an isolated local demonstration with synthetic data, starter pipelines, screenshots from the real product, troubleshooting, backup/restore and upgrade guides, compatibility matrix, and generated API documentation. No cloud account, paid service, proprietary font/CDN, or mandatory telemetry should be needed to run the UI or server.

## 14. Delivery milestones

Complete these in order, parallelizing independent work within each milestone:

1. **Contracts and risk decisions:** threat model, domain/state model, protocol/OpenAPI, compatibility matrix, component-catalog strategy, local capability policy, UX flows, ADRs, CI skeleton, and named work ownership. Immediately proceed to implementation after resolving genuine blockers.
2. **Secure end-to-end slice:** Compose server, initial admin, dashboard downloads/token flow, real Go enrollment, per-device credentials, heartbeat, one published configuration, one real Vector apply, acknowledgment, and actionable error display.
3. **Authoring and fleet management:** functional graph/code editor, imports, draft concurrency, version history/diffs, groups, shared targeting, deterministic conflict handling, agent policies, pause acknowledgment, and drift reconciliation.
4. **Deployment resilience:** durable schedules, canaries/batches, crash-safe apply/rollback, credential rotation/revocation, outages/reconnect, telemetry/issue screens, audit coverage, backup/restore.
5. **Cross-platform and release quality:** native OS/service tests, package workflows, accessibility/browser review, security review, load measurements, documentation, signed-release prerequisites, and a reproducible release candidate.

An early vertical slice is a milestone, not permission to stop with the other requested features absent. If external signing credentials or unavailable test machines prevent a release gate, complete independent implementation and clearly label the remaining gate. Do not describe an untested target as supported.

## 15. Required acceptance and adversarial tests

Automate meaningful unit, property, contract, integration, browser, fault-injection, and native-platform tests. The release checklist must cover:

- A clean self-hosted installation completes the actual download → enroll → edit → publish → assign → heartbeat → fetch → validate → activate → observe workflow.
- A reusable token enrolls multiple distinct names before expiry; expired, revoked, malformed, exhausted, and out-of-scope tokens fail. Duplicate-name races create one identity. Lost enrollment responses retry safely without takeover.
- Anonymous callers cannot enumerate devices; one device cannot read another's artifacts, submit another's status, or claim privileged groups. Every role is tested against restricted administrative operations.
- Wrong CA/hostname, bootstrap MITM, expired/revoked credentials, spoofed proxy headers, tampered artifact bytes, wrong-recipient manifests, nonce mismatches, stale/reordered generations, same-generation content changes, and invalid signatures are rejected. Test revocation while a pooled connection remains open. Legitimate certificate/signing-key rotation, expired-offline recovery, and explicit rollback succeed.
- Local manual edits are restored with sync enabled even if the server hash is unchanged. They persist during acknowledged pause, including after reboot. Heartbeats and renewal continue. Offline pause stays pending. Local emergency pause survives remote resume.
- Invalid configuration, incompatible Vector version, unknown component behavior, hostile paths, symlinks/reparse points, denied permissions, disk exhaustion, interrupted downloads, validation timeout, reload failure, and rollback failure produce accurate states without destroying last-known-good content.
- Crash/power-loss injection at every apply-journal boundary leaves a recoverable complete configuration. A healthy but unchanged old Vector process is not incorrectly marked as having applied a new version.
- Direct/group/exclusion targeting deduplicates correctly; priorities resolve deterministically; equal-priority conflicts and conflicting group edits are rejected. Future group members do not bypass rollout gates. Unassignment does not stop Vector.
- Draft concurrency conflicts are visible; published artifacts remain immutable; graph/code round trips preserve supported semantics and unknown fields; moving a node does not alter runtime content. Named route outputs render correctly.
- Schedules survive restart, activate once, enforce late-start rules, and resolve cancellation races predictably. Offline targets remain pending; canary failures halt further rollout; rollback remains possible.
- Unsafe Vector capabilities cannot bypass the local policy through code import, variables, or malicious secret substitution. Isolated validation cannot access server production secrets or unrestricted network resources. Logs, error messages, diffs, exports, backups, and telemetry are tested for secret leakage. Secret rotation is reconciled even with an unchanged template hash.
- Native tests cover the oldest claimed and current representative OS versions, clean install, reboot, service behavior, upgrade, identity preservation, spaced/Unicode paths, proxy/private CA, drift/pause, real Vector reload/restart, rollback, and uninstall. Cross-compiles alone do not pass these gates.
- Hours of control-plane outage leave Vector on last-known-good configuration; retries/queues stay bounded; recovery avoids a heartbeat stampede. Backup/restore and migrations preserve security and deployment state.
- Browser/accessibility tests cover real workflows, keyboard graph alternatives, loading/empty/error states, and realistic fleet/canvas sizes. Load tests report measured capacity and storage behavior.

## 16. Final handoff requirements

Deliver runnable source, reproducible setup commands, migrations, generated API/protocol documentation, a complete Compose quickstart, validated native agent artifacts or clearly labeled build-only outputs, packaging/release workflows, operational/security documentation, and the requirements-to-tests evidence report.

The final report must state what works, the exact tested versions/platforms, measured capacity, unresolved defects, and external release prerequisites. Link meaningful test results and show the real product. Never hide incomplete security, portability, activation verification, or recovery behavior behind a production-ready label.

Begin by inspecting the dedicated Vectory repository, establishing shared contracts and work ownership, and implementing the first secure vertical slice. Continue through the milestones until the requested v1 is complete or a concrete external dependency blocks further work.
