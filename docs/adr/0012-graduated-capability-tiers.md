# ADR 0012: Restricted mode grows in tiers the host approves, and the service sandbox follows them

Proposed 2026-10-02. Nothing described here is built. Existing behavior is cited by file and symbol as read at commit `021e303`. The Vector 0.58.0 behaviors this design rests on were measured with the pinned binary ([Appendix A](#appendix-a-measurements)). Managed files that versions carry are [ADR 0013](0013-managed-assets.md). The order of work, the files and the tests are in the [implementation plan](../internal/CAPABILITY-IMPLEMENTATION-PLAN.md), and the attacker tables in the [threat model](../security/THREAT-MODEL.md#graduated-capability-tiers).

## Verdict

1. **Restricted mode runs everything that stays inside Vector.** Built in on every restricted device: 78 of the 128 components of Vector 0.58.0, 13 of its 16 general global settings (plus `data_dir` and `proxy` with an allowance), templates where Vector confines them, and in-memory enrichment tables. A restricted device with no allowances still reaches nothing outside Vector: no host file, network address, program, environment value or host credential.
2. **What reaches beyond its own settings needs the host.** 46 components need a one-time approval of their type on each host (`vectory allow --component kafka`); 4 need full mode. Destinations, listeners and file roots keep their per-item allowances.
3. **One generated table decides it.** The agent compiles its own copy and the server never tells it what to allow. The server and the dashboard read copies of the same table, and CI fails when a copy, a fixture or the pinned schema disagrees with it.
4. **The deploy review computes what each device needs** from the artifact rendered for that device, variables included, and prints one command per host.
5. **On Linux with systemd the service sandbox follows the host's allowances.** In restricted mode Vector can write only to the agent's state directory (which holds the managed assets), its data directory (`/var/lib/vector` or the one the host chose), the managed configuration directory and the allowed file roots. `vectory allow` regenerates the sandbox and asks before it restarts the service.
6. **Two gaps close on the way.** Restricted mode today accepts `auth.strategy: aws` on `elasticsearch` ([measured](#ambient-aws-credentials)) and, by the schema, on `http` and `loki`; with no explicit keys, the AWS credential chain reaches instance metadata, which no allowance names. And nothing stops a file root from covering a Unix socket that a component then connects to.

## Context

**What restricted mode allows today.** `CapabilityPolicy.Check` in `agent/internal/agent/policy.go` accepts six sources, six transforms and six sinks (the `supported` map), a few top-level settings (`data_dir`, `acknowledgements`, `healthchecks`, `timezone`, `tests`, and a loopback `api` block, which the server already refuses and the agent still accepts: [security finding 5](../security/OPEN-FINDINGS.md)), and only the file roots, destinations and listeners in the host's allowances. `walkIn` refuses `{{`, `%{`, `$NAME` and `${` anywhere, every key named `enrichment_tables`, `command`, `exec`, `provider`, `secret`, `secrets`, `files` or `source_files`, and calls of the twelve functions in `externalVRL`. Anything else needs full mode (`vectory install --allow-full-vector-config`), which trusts every publisher with everything Vector can do as its service account ([ADR 0005](0005-restricted-mode-by-default.md)).

**What it costs.** [AUTHORING-GAPS.md](../internal/AUTHORING-GAPS.md) records the result: harmless globals such as `log_schema` and `telemetry` are refused (row 2); ten of the twelve refused transforms only work on events in memory (row 4); templates need full mode (row 7); enrichment tables are refused and their files must be placed by hand (rows 13, 14 and 27). The deploy dialog computes host commands from the published base configuration, not from each device's rendered one, so it can take three rounds (its finding 6), and its notices are jargon (its finding 13). Graduated tiers are the first of the missing capabilities it ranks.

**Three copies that can drift.** The agent's `supported` map; the server's `requires_full_mode` in `server/src/rollout.rs`, which reads `device_capability: "allowed"` from `vector-catalog/catalog.json`, set by `localTypes` in `scripts/generate-vector-catalog.mjs`; and `fullModeRequirements` and `hostApprovals` in `dashboard/src/hostRequirements.ts`. Only the VRL function lists have a drift test (`tests/security/test_vrl_function_lists.py`). Security finding 5 was such a drift: the server and the agent disagreed about `api`.

**What the specification requires.** Configuration is privileged policy; command execution is off by default; widening the local policy needs explicit host action and an ordinary deployment cannot weaken it; hostname and IP enforcement limits are stated, not implied (section 10, line 239). Policy is enforced on the effective configuration after substitution (line 241). The agent opens every connection (section 1, line 29).

**What Vector 0.58.0 does** (Appendix A):

- It confines templates in 25 sinks. At validation it refuses a template with no literal prefix, a URI whose host or port is templated, a template mixed with `?` or `#`, and a file path whose literal prefix is `/`. At run time the `file` sink drops an event whose rendered path leaves the base directory (`confinement_failed`). One setting, `dangerously_allow_unconfined_template_resolution`, turns all of it off for a sink.
- A `lua` script can run programs (`os.execute`) and write files (`io.open`).
- Without `--dangerously-allow-env-var-interpolation`, which the agent passes only in full mode (`vectorConfigArgs` in `vector.go`), `${NAME}` stays literal text.
- `vector validate --no-environment`, which the server's isolated worker runs, loads neither enrichment-table files nor TLS files. The plain `vector validate` that the agent runs loads both and refuses a missing CSV or a malformed MaxMind database.

**What the service sandbox does today** (security finding 9). The unit that `vectory setup` writes (`systemdUnitFile` in `agent/internal/agent/service_linux.go`) has `ProtectSystem=full` and `ProtectHome=read-only`: Vector can write wherever the service account can, except `/usr`, `/boot`, `/etc` and home directories. The packaged unit (`packaging/systemd/vectory.service`) is strict, with `ReadWritePaths` for the state directory, the managed configuration directory and `/var/lib/vector`, so a file root that `vectory allow` added fails with `Read-only file system (os error 30)` until the operator adds a drop-in by hand. The two units are separate texts.

## Decision

- **Three tiers per component and setting, read the same way everywhere:** *Built in*, *Host approval* and *Full mode* (section 1). Restricted and full stay the only two device modes.
- **A reviewed source file, `vector-catalog/capabilities.json`, generates the table** for the agent, the server and the dashboard. Unreviewed means full mode, as today (section 2).
- **The host approves component types and two named capabilities** with `vectory allow`, removes them with `vectory disallow`, and reads the whole picture with `vectory capabilities` (section 3).
- **The agent checks the effective configuration against its own table and the host's approvals**, after secrets and managed assets are substituted (section 4).
- **The server computes each device's needs** from its rendered artifact and returns them with the deploy preview; the dashboard prints one command per host (section 5).
- **On Linux with systemd the sandbox is generated from the host's mode and allowances** into a drop-in that Vectory owns. The commands that change the policy regenerate it and restart the service with consent (section 6).

## 1. The tiers

| Tier | What it means | How a host grants it |
| --- | --- | --- |
| **Built in** | Works on every restricted device. Every resource it touches is named in its settings and approved one by one. | Nothing. Its destinations, listeners and file roots still need `vectory allow --network`, `--listener` or `--file-root`. |
| **Host approval** | Reaches something its settings don't name: cluster members a server advertises, a vendor's endpoints, or this host's own state. | `vectory allow --component TYPE`, once per host. Named resources still need their allowances. |
| **Full mode** | Runs programs, loads code, replaces the signed pipeline, or can't be bounded at all. | Only full mode: `vectory install --allow-full-vector-config`. |

**A component is built in only when its reviewed profile shows all five:** it runs no program and loads no code from the host; every host resource it reaches is a field of a known kind (a URL, a `host:port` or a list of them, a listener address, a file path, glob or directory, a Unix socket path); it uses no ambient credential (instance metadata, the service environment, files its settings don't name); it connects to no peer its settings don't name; and every passthrough option that could break one of these is refused in restricted mode. A component that fails only the third or fourth test, or reads host-wide state, is a host-approval component. One that fails the first is full mode. A vendor's default endpoint counts as named only when written out: restricted mode keeps refusing implicit defaults, as `component` in `policy.go` does for `http`, `loki` and `elasticsearch` today.

### Components

The target tier of every component of Vector 0.58.0. A component reaches its tier when its profile is reviewed into the table; until then it stays full mode (section 2).

| Transforms (18) | Components | Why |
| --- | --- | --- |
| Built in (16) | aggregate, dedupe, delay, exclusive_route, filter, incremental_to_absolute, log_to_metric, metric_to_log, reduce, remap, route, sample, tag_cardinality_limit, throttle, trace_to_log, window | Work only on events in memory. VRL in `remap` and in every condition is still scanned for functions that reach outside the event, and `remap.file` and `remap.files` stay refused. |
| Host approval (1) | aws_ec2_metadata | Reads this host's cloud identity from the instance metadata service. |
| Full mode (1) | lua | A script can run programs and write files ([measured](#lua)). |

| Sources (48) | Components | Why |
| --- | --- | --- |
| Built in (30) | demo_logs, internal_metrics, static_metrics | Generate events inside Vector. |
| | file | Reads only paths under allowed file roots, as today. |
| | aws_kinesis_firehose, datadog_agent, dnstap, fluent, heroku_logs, http (the deprecated alias), http_server, logstash, opentelemetry, prometheus_pushgateway, prometheus_remote_write, socket, splunk_hec, statsd, syslog, vector | Only listen: on an allowed listener address, or on a Unix socket under an allowed file root. |
| | amqp, apache_metrics, eventstoredb_metrics, http_client, mqtt, nginx_metrics, postgresql_metrics, prometheus_scrape, redis, websocket | Connect only to destinations their settings name. |
| Host approval (15) | kafka, mongodb_metrics, nats, pulsar | Connect to cluster members the server advertises, beyond those named. |
| | aws_s3, aws_sqs, gcp_pubsub, okta | Reach a vendor's service endpoints, derived from a region or domain, and fetch what the replies point to (the S3 objects queue messages name, Okta's next pages). |
| | aws_ecs_metrics, docker_logs, host_metrics, internal_logs, journald, kubernetes_logs, windows_event_log | Read this host's own state: container metadata, container and pod logs, system metrics, the journal, the event log, and Vector's own log, which can quote paths and resolved values. |
| Full mode (3) | exec | Runs programs. |
| | file_descriptor, stdin | Read a descriptor or standard input the agent never connects; there is nothing to bound or approve. |

| Sinks (62) | Components | Why |
| --- | --- | --- |
| Built in (32) | blackhole, console | Write nothing outside Vector (`console` to stderr only, as today). |
| | file, prometheus_exporter, websocket_server | Write under an allowed file root, or listen on an allowed address. The monitoring exporter keeps its exemption (`monitoringExporter` in `policy.go`). |
| | amqp, appsignal, clickhouse, elasticsearch, greptimedb, greptimedb_logs, greptimedb_metrics, honeycomb, http, humio_logs, humio_metrics, influxdb_logs, influxdb_metrics, keep, loki, mezmo, mqtt, opentelemetry, papertrail, postgres, prometheus_remote_write, socket, splunk_hec_logs, splunk_hec_metrics, statsd, vector, websocket | Send only to destinations their settings name. |
| Host approval (30) | databend, doris, kafka, nats, pulsar, redis, webhdfs | Write to hosts a server names: cluster members, a Redis Sentinel primary, the data node a WebHDFS or Doris redirect points to. Databend's upload path isn't reviewed to the built-in standard yet. |
| | aws_cloudwatch_logs, aws_cloudwatch_metrics, aws_kinesis_firehose, aws_kinesis_streams, aws_s3, aws_sns, aws_sqs, axiom, azure_blob, azure_logs_ingestion, databricks_zerobus, datadog_events, datadog_logs, datadog_metrics, datadog_traces, gcp_chronicle_unstructured, gcp_cloud_storage, gcp_pubsub, gcp_stackdriver_logs, gcp_stackdriver_metrics, new_relic, sematext_logs, sematext_metrics | Reach a vendor's endpoints, derived from a region, site or account. |
| Full mode (0) | none | No sink runs a program. Passthrough options that could are refused field by field (below). |

An approval names a component type and covers it as a source and as a sink: `--component kafka` approves both. `redis` and `aws_kinesis_firehose` are built in as sources and need approval only as sinks.

**Passthrough options and refused fields.** A built-in or approved component can still carry a field that breaks the rules; its profile refuses that field in restricted mode, whatever the tier. Examples the review must cover: `librdkafka_options` on both Kafka components passes properties straight to librdkafka, including `sasl.kerberos.kinit.cmd`, which runs a command, and `plugin.library.paths`, which loads a shared library, so only a reviewed list of tuning keys is accepted; `journalctl_path` and `extra_args` on `journald`; `dangerously_allow_unconfined_template_resolution` on every sink that has it; `auth.strategy: aws` without explicit keys, `auth.imds`, `auth.assume_role`, `auth.profile` and `auth.credentials_file` outside an allowed root, on every component that has them ([measured](#ambient-aws-credentials)), unless the host granted `instance-credentials`.

### Global settings

| Tier | Settings | Why |
| --- | --- | --- |
| Built in | acknowledgements, buffer_utilization_ewma_half_life_seconds, expire_metrics, expire_metrics_per_metric_set, expire_metrics_secs, healthchecks, latency_ewma_alpha, log_schema, metrics_storage_refresh_period, schema, telemetry, tests, timezone, wildcard_matching | They tune Vector's own behavior: event field names, metric expiry, smoothing, schema checks, the time zone, input matching, unit tests. None reaches the host. |
| Built in with a resource | data_dir, proxy, enrichment_tables | `data_dir` must sit under an allowed file root, as today. Each `proxy` URL is a destination and needs its allowance. Enrichment tables by type, below. |
| Host owned | api | Vector's API has no authentication. Only the host decides whether it exists ([ADR 0011](0011-opt-in-event-sampling.md), Step 0 of its implementation plan). |
| Full mode | provider, secret | A configuration provider replaces the signed pipeline with content fetched elsewhere. Secret backends can run programs and read files; device secrets ([ADR 0008](0008-device-secret-field-table.md)) are restricted mode's alternative. |

### Templates

Templates are built in where Vector confines them, because confinement keeps event data out of the parts that choose a resource (measured [at validation](#templates-at-validation) and [at run time](#templates-at-run-time)). The agent does not rely on Vector alone:

- `dangerously_allow_unconfined_template_resolution: true` is refused.
- In a field that names a resource, the static part is checked like a literal. A URI's scheme, host and port must be literal and approved. A file path's base directory, its `base_dir` or its literal prefix up to the last separator before the first `{{` or `%`, must lie under an allowed file root. Both rules are at least as strict as Vector's.
- A template in a field that names no resource (an index, a topic, a key prefix, a label, a header value) is data within an approved destination and passes.
- `$NAME`, `${NAME}` and `%{` stay refused. Vector would not interpolate them without the full-mode flag, but a pipeline that seems to read the environment and doesn't is a trap. Environment interpolation stays full mode: in restricted mode the agent scrubs Vector's environment (`cleanEnvironment` in `vector.go`), so there would be nothing worth reading.

Event data can still choose the suffix: which file under the base directory, which topic after `logs-`, which key under a prefix. It can create many of them. That is resource use within an approved root or destination, not a new reach.

### Enrichment tables and VRL

A `memory` table is built in. A `file`, `geoip` or `mmdb` table reads one file, which must lie under an allowed file root or be a managed asset (ADR 0013). `get_enrichment_table_record` and `find_enrichment_table_records` leave restricted mode's refusal list: they can only name tables declared in the same configuration, and Vector refuses any other name when it compiles the program ([measured](#enrichment-lookups)). The server keeps them in its list of functions that a device must check (`DEVICE_VRL_FUNCTIONS` in `server/src/validation.rs`), because its worker cannot load the table.

### Host capabilities

Two choices are neither a component nor a resource, so they get a name:

| Capability | Lets pipelines | Why it needs the host |
| --- | --- | --- |
| `managed-ca` | Trust CA certificates that Vectory delivers with a version (`vectory-asset:` in `tls.ca_file`; ADR 0013). | A CA certificate decides whom a pipeline's TLS trusts. Without it, pipelines trust the host's store and CA files under allowed roots. |
| `instance-credentials` | Sign with this host's own cloud identity: an AWS instance or task role, a GCP service account through the metadata server, an Azure managed identity. | It is the host's credential, fetched from an endpoint no allowance names. |

### Resources

Destinations, listeners and file roots work as today (`network`, `listenerAllowed` and `file` in `policy.go`), with three changes:

- **A Unix socket that a component connects to is a destination named by its exact path**, `--network unix:/run/app.sock`, never covered by a file root. A root covering `/run` would otherwise let a `socket` sink write raw bytes to any local service socket, such as Docker's API. A socket a source listens on stays under a file root.
- **A file root may not be `/` or a volume root, and may not contain or lie inside** the agent's state directory, the managed configuration directory or the managed assets directory. The docs already say never to allow the state directory; `validateInstallPolicy` in `install_options.go` doesn't enforce it.
- **Values are checked after every substitution**, device secrets and managed assets included (section 4).

### How an operator reads it

- **On the host:** `vectory capabilities` prints the mode, the components built in, those approved here, those that need approval, those that need full mode, the approved capabilities and the allowed resources, from the agent's own table. `vectory status` adds one line, for example `restricted · kafka, aws_s3 approved · 3 destinations, 1 listener, 2 file roots · sandbox follows allowances`.
- **In the editor and the library:** the component picker and the inspector header carry the tier as a chip: none for built in, **Host approval** or **Full mode**, with the reason from the table.
- **In the deploy review:** each device's needs, grouped by reason in plain words: "Runs programs (needs full mode): exec. Needs host approval: kafka, which connects to the brokers its cluster advertises. Uses destination broker.example.net:9092." Then one command per host (section 5).
- **On the device page:** a capabilities card with the mode, the approvals and allowances as last reported, the sandbox, and "Only someone on this host can change this."

## 2. One generated table

**Source.** `vector-catalog/capabilities.json` is reviewed by hand and keyed by the pinned Vector version and schema digest. It holds, per component type and kind, the tier, a one-sentence reach statement (shown to operators), the resource fields with their kind (`url`, `host_port`, `host_port_list`, `listen`, `file`, `glob`, `dir`, `unix_listen`, `unix_connect`), the refused fields with the reason, the template fields and whether each names a resource, the credential shapes counted as ambient, and the vendor default it must write out. It also holds the global settings, the enrichment table types, the VRL function lists and the asset fields of ADR 0013. Shared definitions are classified once by schema type (`vector_core::tls::settings::TlsConfig`, `vector::aws::auth::AwsAuthentication`, `vector::gcp::GcpAuthConfig`, `vector::sinks::azure_common::config::AzureAuthentication`, `vector_core::config::proxy::ProxyConfig`, `vector::sinks::util::uri::UriSerde`, `vector::template::Template`) and apply wherever they appear.

**Generator.** `scripts/generate-capability-table.mjs` writes it three times, as `scripts/generate-secret-fields.mjs` does for credential fields: `agent/internal/agent/capability_table_generated.go`, `server/src/capability_table.rs` and `dashboard/src/generated/capability-table.json`. The catalog's `device_capability` becomes `builtin`, `approval` or `full`, derived from the same file instead of `localTypes`.

**Checks in CI.**

1. `--check` fails when an output is stale.
2. Completeness against the pinned schema: every component has a tier; every field of a built-in or approval component that looks like a resource, by name (`*_file`, `*_path`, `path`, `*_dir`, `endpoint`, `uri`, `url`, `address`, `host`, `server`, `bootstrap_servers`, `connection_string`, `command`, `*_options`) or by schema type (`stdlib::PathBuf`, `stdlib::SocketAddr`, `SocketListenAddr`, `UriSerde`, the TLS, auth and proxy types above), has a classification. A new Vector release that adds such a field fails until someone reviews it. That is the drift test against Vector itself.
3. Golden fixtures in `vector-catalog/fixtures/capabilities/`: each is a configuration with its expected needs. The agent (Go), the server (Rust) and the dashboard (TypeScript) each run every fixture through their own needs function and must produce the same answer. This tests the three checkers, not only the three copies of the data.
4. `tests/security/test_vrl_function_lists.py` follows the new split between functions restricted mode refuses and functions only a device can evaluate.
5. A native probe with the pinned binary reproduces Appendix A and fails loudly when Vector's confinement, Lua or validation behavior changes. It runs on Linux CI and whenever the pinned Vector changes.

**Fail closed.** A component type, setting or table type absent from the agent's table is full mode. An older agent keeps its older table, so a newer server can't widen what it allows (the same property as ADR 0008).

## 3. Host approvals

**Where they live.** Two new lists in the local capability policy (`CapabilityPolicy` in `policy.go`, saved in `settings.json`): `allowed_components` (type names, at most 128) and `allowed_capabilities` (`managed-ca`, `instance-credentials`). Both are additive grants, so an older agent that reads a newer file ignores them and is stricter, never looser. `ReadInstallPolicy` accepts both in the allowances file for `install --capability-policy` and still refuses every other unknown field.

**Commands.** All of them use the locked, access-preserving writer (`lockSettingsMaintenance`, `commitSettingsWithRetryReset`), so an approval clears the hold on a version this host refused, as allowances do today.

- `vectory allow` gains `--component NAME` and `--capability NAME`, both repeatable, and `--network` accepts `unix:/abs/path`. A name that is built in is a no-op with a note ("dedupe is built in; every restricted device runs it"). A full-mode name is refused with the command that grants full mode. An unknown name is refused with the nearest known names.
- `vectory disallow` takes the same flags and removes entries. Today removal means replacing every list with `install --capability-policy`.
- `vectory capabilities [--json]` is read-only (section 1).
- Section 6 adds `--yes` and the restart to `allow`, `disallow` and the policy options of `install`.

**What a server can't do.** No manifest, policy or response field reaches these lists. `settings.json` keeps its existing writers, all local commands; the event-sampling ADR lists them and its source-scan test (A-02 there) extends to the new fields.

**Reporting.** The agent reports its approvals in the heartbeat (section 7). The server stores the report, audits a change it observes (`device.capabilities`, added and removed entries), and uses it only to explain: the agent enforces locally, and a compromised device can lie about its own report.

## 4. What the agent checks

The order in `Reconcile` (`reconcile.go`) stays: download and verify the template, substitute managed assets (ADR 0013) and device secrets (`resolveLocalSecrets` in `secrets.go`), then check, stage, validate, commit, activate. `CapabilityPolicy.Check` becomes two parts:

1. `Needs(config)` reads the effective configuration with the generated table and returns everything it needs: full-mode items, component types to approve, capabilities, destinations, listeners, Unix sockets, file roots, and the paths Vector will write (section 6). It is pure and has the same golden fixtures as the server and the dashboard.
2. `Check` compares those needs with the policy and returns the first refusal in a stable order, as today. Full mode returns before it, as today.

Refusal codes keep their meaning: `UNSUPPORTED_LOCAL_CAPABILITY` for full-mode items (now worded by reason, "Source `cmd` (exec) runs programs, which only full mode allows"), and `NETWORK_DESTINATION_DENIED`, `LISTENER_DENIED`, `FILE_ACCESS_DENIED`, `DYNAMIC_CAPABILITY_DENIED`, `TLS_VERIFICATION_REQUIRED` and `CONSOLE_TARGET_DENIED` as before. New codes: `COMPONENT_NOT_APPROVED` and `CAPABILITY_NOT_APPROVED` (with the exact `vectory allow` flag in the hint), `UNCONFINED_TEMPLATE_DENIED`, `TEMPLATE_RESOURCE_DENIED`, `PASSTHROUGH_OPTION_DENIED` and `SANDBOX_READ_ONLY` (section 6). `PolicyRefusal.Diagnostic` renders each with the field and the fix. A policy refusal still holds the version back until the host changes its policy; `SANDBOX_READ_ONLY` doesn't, because its fix is outside the policy (section 6).

The same `Check` runs on recovery content (`startExisting`, `restoreLastGood`), in `vectory re-adopt` and in local diagnostics, as today.

## 5. Per-device needs and the deploy review

**The server computes them.** `POST /deployments/preview` already renders each target's artifact (`variables::target_artifact`) and checks `requires_full_mode` on it. That function becomes the Rust `needs` over the generated table, and the preview returns `host_requirements`: needs grouped by identical sets, each with its device IDs, compared with what each device last reported (approved, missing or unknown). Variables are applied, which closes authoring finding 6. Keeping one renderer avoids rendering artifacts a second time in TypeScript; the dashboard's copy of the table serves the editor and the library, before any device is chosen.

**Blockers.** `FULL_VECTOR_MODE_REQUIRED` keeps its code and blocks only full-mode needs. Host-approval needs don't block, like host allowances today: the review shows them, and a device without the approval refuses the version with the exact command. A device whose agent reports no table is an older agent; for it the server keeps today's `requires_full_mode` rule, and the review says "edge-4 runs agent 0.1.0, which can't approve components: upgrade the agent, or use full mode."

**One command per host.** The dashboard builds it with `hostCommands` (`dashboard/src/hostApprovalCommands.ts`) from the device's reported state directory, service manager and operating system, for the missing items only when the device reported its approvals, otherwise for all of them, which is safe because `allow` adds and keeps. For a service it is one line, without `--yes`, so the host operator sees the prompt (section 6):

```sh
sudo vectory allow --component kafka --network broker.example.net:9092
```

The deploy review says beside it: "It asks before it restarts the agent. Vector finishes in-flight events first (up to 60 s)." For a foreground agent it keeps today's three steps. For an agent too old for the restart it prints today's `service-stop`, `allow`, `service-start`.

## 6. The service sandbox follows the host's allowances

### What it enforces

On Linux under systemd, the operating system confines where the agent and Vector can write, and the confinement matches the policy:

| Mode | Vector can write to | Read-only to it |
| --- | --- | --- |
| Restricted | the state directory (managed assets and the agent's default data directory live there), the managed configuration directory, `/var/lib/vector`, the host's data directory, and each allowed file root | Everything else. Home directories are hidden unless an allowed root lies under one. |
| Full | wherever the service account's permissions allow | `/usr`, `/boot`, `/etc` (except the managed configuration directory) and home directories |

Restricted mode's checks are a configuration check, not a sandbox (`docs/user/security.md` says so). The sandbox makes the write half true at the kernel: a component the table models wrong, or a component ID that turns into a path (security finding 7), still can't write outside the allowed roots. It does not limit reads; the agent's checks do that. It does not separate Vector from the agent: both run in the same unit, as the same account, in the same mount namespace, so Vector can still write the agent's state.

Full mode keeps today's generated sandbox. Its contract is anything Vector can do as its service account; a strict sandbox would make its programs fail with read-only errors the agent can't predict. An operator who wants a tighter full mode adds a drop-in of their own, and theirs wins (below).

### The units

- **The base unit** is the strict, restricted one: `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=` the state directory, the managed configuration directory and `/var/lib/vector`, and the existing hardening (`NoNewPrivileges`, `PrivateTmp`, `UMask=0077`, `KillMode=mixed`, `TimeoutStopSec=330s`). One Go function writes it, for `vectory setup` and `service-install` and for the package. `packaging/systemd/vectory.service` is that function's output for the package's paths, with its comments; a Go test fails when they differ, and `VECTORY_UPDATE_GOLDEN=1` rewrites it, the convention of the agent's other golden files. `packaging/test_systemd_unit.py` keeps checking the properties.
- **The sandbox drop-in** is `/etc/systemd/system/vectory.service.d/10-vectory-sandbox.conf`, generated from the host's mode and allowances. It applies to the packaged unit and to the generated one alike. Restricted mode: `ReadWritePaths=` for the host's data directory and each file root; for a root under `/home`, `/root` or `/run/user`, `ProtectHome=tmpfs` with `BindPaths=` for that root, so other home directories stay hidden. Full mode: `ProtectSystem=full` and `ProtectHome=read-only`. Its header says Vectory writes it and where to put your own changes.
- **Operator drop-ins** are every other file in that directory, such as `override.conf` from `sudo systemctl edit vectory.service`. Vectory never writes, reads into the policy or removes them. systemd applies drop-ins in name order, so `override.conf` and any name sorting after `10-` win over Vectory's settings; the generated header says so. If `10-vectory-sandbox.conf` exists without Vectory's header, setup stops and names it.

Every value written to a unit is an absolute path checked again when the file is generated: no control characters (a newline would start a new directive, and `ExecStartPre=+…` runs as root), quoted as `unitArg` does, and refused instead of written when it fails. `settings.json` belongs to the service account, so a compromised Vector could edit it and wait for root to regenerate the sandbox; the check makes that a wider write set at worst, never a root command, and the command prints every path the sandbox gains before it applies them.

### Who regenerates it, and the restart

A sandbox takes effect when the service starts, and the agent reads its policy only when it starts. So the commands that change the policy apply both at the same checkpoint the stopped-agent rule already gives them:

- `vectory allow`, `vectory disallow`, and `vectory install` with `--capability-policy`, `--allow-full-vector-config` or `--vector-data-dir`.
- If the agent's service is running: on a terminal the command prints what changes and asks; with `--yes` it doesn't ask; otherwise it stops with the `--yes` form. Then it stops the service (Vector drains, up to the drain limit), commits the settings, writes the drop-in if it changed, runs `systemctl daemon-reload`, starts the service and waits for its first check-in, as `startService` in `setup.go` does. If anything fails after the stop, it starts the service again before reporting the failure.
- If the agent is stopped, it applies and says to start it. If the agent runs in the foreground, it asks the operator to stop it first, as today.
- `vectory setup` regenerates the base unit and the drop-in on every run and restarts a running service when either changed. Today an updated systemd unit restarts the service only for a new build, so a sandbox change would wait for the next restart.
- launchd and Windows get the same stop, apply and start, with no sandbox file.

### What the commands print

```text
This adds to what web-01 allows:
  component    kafka (connects to the brokers its cluster advertises)
  destination  broker.example.net:9092
The service sandbox doesn't change.
Applying it restarts vectory.service. Vector finishes in-flight events first (up to 60 s).
Restart vectory.service now? [y/N] y
Stopped vectory.service (Vector drained in 2.4 s).
Allowed component kafka; destination broker.example.net:9092.
Started vectory.service · first check-in 1.2 s later. The version this host refused is tried again.
This host allows: component kafka; destinations broker.example.net:9092, logs.example.net:443; files under /var/log/nginx.
```

When a file root is added, "The service sandbox doesn't change." becomes "The service sandbox changes: Vector may also write under /srv/spool." Without a terminal and without `--yes`: "vectory allow: the agent runs as vectory.service, and applying this restarts it. Run it again with --yes, or stop the service first." Nothing changes and the exit code is 1. "Already allowed; nothing changed." never restarts anything.

### Without root

With a registered service, the command checks before it changes anything that it runs as root, because it restarts the service and writes under `/etc/systemd/system`: "Changing what this host allows needs root: it restarts vectory.service and updates its sandbox. Run: sudo vectory allow …". An agent installed by an ordinary user in its own state directory, with no service, needs no root; there is no sandbox to write, and the command says so.

### Diagnosing a read-only path

- **Before an apply** (Linux and macOS), the agent checks each path the configuration writes, from `Needs`: the effective data directory, component `data_dir` settings, file sink base directories and listening sockets' directories. It calls `access(W_OK)` on the path or its nearest existing parent, inside the service's own mount namespace, so the answer is the sandbox's. A read-only path refuses the attempt with `SANDBOX_READ_ONLY`, naming the path, the component and the fix. Nothing is activated, and the version is not held back, because the fix happens outside the pipeline.
- **While running**, the agent classifies Vector's `Read-only file system (os error 30)` the same way, and reports the paths it finds read-only in the heartbeat's capability report.
- **`vectory doctor`** adds a Sandbox check: it reads the effective settings of the loaded unit (`systemctl show` for `ProtectSystem`, `ProtectHome`, `ReadWritePaths` and `DropInPaths`), compares them with the drop-in the current policy would generate, and lists operator drop-ins. It reports "out of date: run sudo vectory setup", a missing write path with its fix, and a file root inside the service's private `/tmp`, whose files other programs never see.
- **The device page** shows the reported problem: "Vector can't write to /srv/logs, which sink out_file uses. The service keeps it read-only. On the host: sudo vectory allow --file-root /srv/logs" (or `sudo vectory setup` when the root is already allowed, or, in full mode, a drop-in with `ReadWritePaths=/srv/logs`).

### launchd and Windows

There is no equivalent sandbox to generate. launchd offers none for a daemon that this design can rely on. Windows' write-restricted service SID could approximate one but is unmeasured (below). The allow, disallow and restart behavior is the same; `doctor` and the device page say "No operating-system sandbox on macOS: the service account's permissions are the only limit on where Vector writes" (Windows likewise). The docs claim exactly that: on Linux with systemd the sandbox matches the allowances; elsewhere the agent's checks and the service account's permissions are the limits.

## 7. Wire and storage

Every change is additive. The [plan](../internal/CAPABILITY-IMPLEMENTATION-PLAN.md#wire-and-storage-changes) lists the exact fields; in short:

- **Manifest `features`** gains `capabilities`. The agent sends the new heartbeat field only after a verified manifest lists it (`addHeartbeatFeatures` in `heartbeat_features.go`).
- **Heartbeat `capabilities`:** the agent's table identity, the approved components and capabilities, the allowed destinations, listeners and file roots (bounded, with `truncated`), the sandbox kind and the paths found read-only, and whether `allow` can restart the service.
- **Preview** gains `host_requirements`; **Device** gains a read-only `capabilities` projection; the audit log gains `device.capabilities`.
- **Settings** (`settings.json`, `install --capability-policy`): `allowed_components`, `allowed_capabilities`, and `unix:` destinations.
- **Storage:** migration `0150_device_capability_reports.sql` keeps the report in its own row, written only when it changes, so the hot device row doesn't grow.

## 8. Old agents and old servers

- **Old agent, new server.** It reports no table, so the server applies today's rule to it and the review says it can't approve components. It never receives anything it doesn't understand.
- **New agent, old server.** No `capabilities` feature, so no report. The agent enforces its own, wider table; the old server's blockers are stricter than needed, never looser.
- **New settings, older agent** (a downgrade): it ignores `allowed_components` and `allowed_capabilities` and is stricter.
- **Older dashboards** print `vectory allow` without `--component`; those commands keep working.

## Alternatives considered and rejected

- **Named device-wide tiers** ("contained", "connected", "host access") that a host picks as a whole. Coarse: approving Kafka would also approve the Docker socket. A tier per component, approved per type, is as easy to read and grants only what a pipeline uses.
- **Per-component approval for every component, built-in ones included.** Restricted devices running `http` or `syslog` today would break, and approving a component whose every resource is already approved one by one adds a step and no safety.
- **Letting the server send a capability profile in the manifest.** It would let a compromised server widen what a device allows. Rejected by the specification's own rule.
- **One checker shared by all three languages** (WebAssembly, or the server answering for the agent). The agent must decide alone, offline, in Go; the server must explain without the agent. Three checkers over one table with shared golden fixtures keep them equal.
- **Allowing templates only after a host approval.** Vector 0.58 confines them where they could choose a resource, and the agent checks the static part. An approval would add a step without adding a check.
- **Live approvals without restarting the agent** (a request file the running agent picks up, as `vectory retry` queues one). Vector keeps running only for policy that doesn't touch the sandbox, the stopped-agent checkpoint is the reviewed property, and approvals are rare. Deferred, not rejected.
- **A strict sandbox for full mode too.** It contradicts full mode's contract and breaks its programs unpredictably. Operators who want it add their own drop-in.
- **Rewriting the whole unit on every policy change.** A drop-in keeps the packaged unit untouched, survives package upgrades, and leaves the operator's own drop-ins alone.

## Consequences

- **New restricted capabilities without new host reach.** The default device runs 78 components, 13 general global settings, confined templates and in-memory tables, and still reaches nothing outside Vector.
- **Three behaviors tighten.** Restricted devices refuse ambient AWS credentials on `http`, `loki` and `elasticsearch` until the host grants `instance-credentials`; Unix-socket destinations need an exact allowance; and a file root can no longer cover the agent's state or the managed configuration, which holds resolved device secrets. A version that relied on any of them is refused at its next apply; last-known-good keeps running. The release note says so.
- **A Vector upgrade needs a table review.** The completeness check fails on new resource-like fields until someone classifies them; the native probe fails if confinement or Lua behavior changes.
- **The generated unit becomes strict in restricted mode.** Hosts get it when `vectory setup` runs again after the upgrade; `vectory doctor` reports an out-of-date sandbox until then. Packaged hosts already run the strict unit, and the package runs no install scripts (`packaging/nfpm.yaml`), so their drop-in appears at the first `vectory allow` or `vectory setup` after the upgrade; until then they behave as today.
- **Docs that change:** `docs/user/security.md` (the restricted-mode tables become the tiers, generated from the table), `cli.md` (`allow`, `disallow`, `capabilities`, `--yes`), `agents.md`, `installation.md` (what the systemd service can write), `troubleshooting.md` and [ADR 0005](0005-restricted-mode-by-default.md)'s allowlist sentence.

## What stays unbuilt until proven

- **A network sandbox.** systemd's `IPAddressAllow=` from resolved destinations would need resolution at generation time and breaks when DNS changes. Allowances remain a configuration check for the network, and the docs keep saying so.
- **Read-only file roots** (`--read-root`), which would let the sandbox keep a source's folder read-only. Today a root means read and write.
- **Windows' write-restricted service SID** as a sandbox, until a native Windows test shows the agent, Vector and its sinks still work under it.
- **A root-owned policy file** that the service account can't edit. The state directory belongs to that account, so a root-owned `settings.json` in it could still be replaced; the policy would have to move.
- **Approvals scoped to destinations** ("kafka, but only this cluster"). Discovery makes the scope unenforceable from configuration.
- **Built-in status for each component** until its profile is reviewed into the table, field by field. The plan orders the reviews by demand.

## Open risks

- **Approved destinations are trusted.** An approved HTTP destination can redirect; an approved Kafka bootstrap server decides which brokers the client meets. The reach statement of each approval says what it trusts.
- **The table is only as good as its review.** A misclassified field is a hole in restricted mode. The completeness check and the golden fixtures catch drift and disagreement, not a wrong judgement; the independent review must.
- **Vector's confinement is new.** The agent's own static-part rules are the backstop, and the native probe pins the behavior to 0.58.
- **The sandbox and the agent share a namespace.** A compromised Vector can write the agent's state, including `settings.json`, and can influence the next sandbox that root generates. Root's command shows every added path first; nothing removes the risk short of separate accounts.
- **Not measured:** `ProtectHome=tmpfs` with `BindPaths=` on the oldest systemd a supported distribution ships; `access(W_OK)` inside the service's namespace on every filesystem type; launchd's restart timing under `vectory allow --yes`.

## Appendix A: Measurements

Measured on 2026-10-02 with the pinned build, `vector 0.58.0 (x86_64-unknown-linux-gnu 2bcad9b 2026-08-26 13:37:07.557544670)`, on Linux 6.18 x86-64, with a scrubbed environment (`PATH` only). Each case was a minimal pipeline with a `demo_logs` source. The scripts were small Python files and are not kept; the plan's native probe reproduces them.

### Templates at validation

With `vector validate --no-environment`. The 25 sinks with `ConfinementConfig` in the schema: amqp, aws_cloudwatch_logs, aws_s3, axiom, azure_blob, clickhouse, doris, elasticsearch, file, gcp_cloud_storage, gcp_stackdriver_logs, greptimedb_logs, http, humio_logs, humio_metrics, kafka, loki, mqtt, nats, prometheus_remote_write, pulsar, redis, splunk_hec_logs, splunk_hec_metrics, webhdfs.

| Case | Result |
| --- | --- |
| `file` path `<dir>/{{ host }}.log`; path `<dir>/%Y-%m-%d.log`; `base_dir` with path `{{ host }}.log` (`<dir>` an absolute directory) | Valid |
| `file` path `{{ host }}.log` | Refused: "no literal directory prefix to derive a base directory from" |
| `file` path `/{{ host }}.log` | Refused: the prefix "normalizes to a filesystem root" |
| `http` uri `https://{{ host }}/ingest`; `https://{{ user }}@collector.example.com/x` | Refused: "no static authority (host)" |
| `http` uri `https://collector.example.com{{ suffix }}/x`; `https://collector.example.com:{{ port }}/x` | Refused: a template "inside the authority (host) component" |
| `http` uri `https://collector.example.com/x?t={{ tenant }}` | Refused: templates mixed with `?` or `#` "cannot be confined" |
| `http` uri `https://collector.example.com/{{ host }}` | Valid |
| Header `X-Tenant: {{ tenant }}`, Elasticsearch index `{{ service }}`, Kafka topic `{{ topic }}`, Loki `tenant_id`, S3 `key_prefix` `{{ host }}/` | Refused: "no literal string prefix to derive a confinement base from" |
| The same with a literal prefix (`t-`, `logs-`, `logs/`) | Valid |
| Loki label value `{{ host }}` | Valid (label values aren't confined) |
| `dangerously_allow_unconfined_template_resolution: true` with path `{{ host }}.log` | Valid: confinement is off |
| `socket` sink address `{{ host }}:9000`; `vector` sink address `{{ host }}:6000` | Valid as a literal; these fields aren't templates |

### Templates at run time

A `file` sink with path `<base>/{{ dest }}.log`, one event each, Vector run until the source ended: `dest = "../escaped"` and `"sub/../../escaped2"` were dropped with `ERROR Rendered path is outside the configured base directory; dropping event.` (`error_type: confinement_failed`) and no file was written outside the base; an absolute `dest` was written inside the base (`<base>/tmp/…`); `dest = "inside"` was written as `<base>/inside.log`.

### Lua

A `lua` transform (version 2) whose process hook called `os.execute("touch …")` and `io.open(…, "w")` created both files; `os` and `io` were both present.

### Environment references

An `http` sink with `uri: https://collector.example.com/${NOPE}` validated without `--dangerously-allow-env-var-interpolation`: the reference stays literal.

### What validation loads

With `--no-environment`, a `file` table at a missing CSV, an `mmdb` table at a missing file and `tls.ca_file` at a missing file all validated. A plain `vector validate` refused the missing CSV (`Enrichment Table "t": No such file or directory`), refused a malformed MaxMind file (`invalid database: could not find MaxMind DB metadata in file`), and accepted a well-formed CSV.

### Ambient AWS credentials

An `elasticsearch` sink with `auth: {strategy: aws}` and `aws: {region: us-east-1}` validated. Read from `walkIn` and `component` in `policy.go`, restricted mode accepts it: neither `strategy`, `aws` nor `region` is refused, and the AWS credential chain then reaches instance metadata, which no allowance names. Not run against a real metadata service.

### Enrichment lookups

A `remap` calling `get_enrichment_table_record("undeclared", …)` failed validation (`error[E610]: function compilation error: error[E401] invalid enum variant`) when no table of that name was declared, and validated once a `memory` table of that name was.

### From the schema alone

Without a run, the schema shows that `librdkafka_options` on the Kafka source and sink is a free map passed to librdkafka, and that `tls.ca_file`, `crt_file` and `key_file` accept either a path or inline PEM.
