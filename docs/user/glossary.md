# Terms & concepts

Use this page when a setting or status is unfamiliar. The linked guides show the corresponding task and how to verify its result.

## Pipeline and components

| Term                    | Meaning                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pipeline**            | A Vector configuration describing how events are collected, transformed and delivered. [Build one](#/docs/pipelines#add-and-connect-components).                |
| **Source**              | Receives or generates events, such as a file reader or HTTP receiver.                                                                                           |
| **Transform**           | Changes, filters, combines or routes events.                                                                                                                    |
| **Sink**                | Sends events to a destination, such as an HTTP service or storage system.                                                                                       |
| **DAG**                 | Directed acyclic graph: connections have direction and cannot loop back through their own upstream path.                                                        |
| **Input / output port** | Event-flow connection points. Named outputs distinguish routes or rejected events. [Input patterns](#/docs/pipelines#input-patterns) can match several outputs. |
| **VRL**                 | Vector Remap Language, used to inspect and transform events. [Edit VRL](#/docs/pipelines#vrl) and [test assertions](#/docs/resources#test-transformations).     |
| **Schema**              | A description of field types, constraints and alternatives. Passing schema checks does not prove native runtime or device-resource validity.                    |
| **Enrichment table**    | Reference data used by transforms, such as a hostname-to-owner CSV. [Add a table](#/docs/resources#enrich-events-with-local-data).                              |

## Configuration values

| Term                  | Example                                       | Meaning in the editor                                                   |
| --------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| **String**            | `"edge-01"`                                   | Text. A numeric-looking string is still text.                           |
| **Number / integer**  | `1.5` / `10`                                  | A numeric value / a whole number. Read its units and bounds.            |
| **Boolean**           | `false`                                       | An explicit true/false value. False is not missing.                     |
| **Enum**              | `"json"`                                      | One value from a fixed set; the choice may reveal more settings.        |
| **Object**            | `{"codec":"json"}`                            | A group of named settings with their own field types.                   |
| **Map**               | `{"X-Team":"platform"}`                       | An object whose names you supply. Each value still has a required type. |
| **Array / list**      | `["normalize", "routes.errors"]`              | An ordered collection. Preserve its rows and item types.                |
| **Variant**           | Syslog TCP versus Unix mode                   | Alternative configuration forms with different legal settings.          |
| **Conditional field** | A Unix socket path when Unix mode is selected | A field relevant or required because of another value.                  |

A **required-one-of rule** asks you to supply an alternative, such as remap `source`, `file` or `files`; it need not be a selectable mode. A **default** is Vector's behavior when an optional setting is omitted, not necessarily a value written to your document. See [detailed settings](#/docs/pipelines#work-with-detailed-settings).

## Omitted null and empty values

**Omitted** means the key is absent. **Null** means the key has the explicit value `null`, permitted only by some fields. **Empty** depends on type: `""`, `[]` and `{}` are different values and may have different validity rules.

Use **Remove field** for omission and **Set to null** for explicit null. A newly opened input or partial numeric entry is a pending edit, not a valid completed setting. See [editing examples](#/docs/pipelines#omitted-null-and-empty-values).

## Event templates

An **event template**, such as `{{ hostname }}`, reads event data where a component supports templates. An **environment reference**, such as `${HOSTNAME}`, reads the Vector process environment. A **secret reference** reads a configured credential mechanism. [Compare the four reference mechanisms](#/docs/resources#choose-the-right-reference).

## Changes and deployment

| Term                              | Meaning                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Draft / revision**              | Editable pipeline content and its saved revision. Saving does not deploy it.                                                                         |
| **Version**                       | An immutable published snapshot. A deployment refers to this snapshot.                                                                               |
| **Assignment / desired state**    | The configuration or policy selected for a device from active deployments.                                                                           |
| **Generation**                    | A monotonically increasing desired-state counter. A deliberate rollback uses a newer generation.                                                     |
| **Snapshot targets**              | Exact device identities frozen when the deployment is created.                                                                                       |
| **Persistent targets**            | Devices selected by ongoing membership rules, including eligible new group members.                                                                  |
| **Canary**                        | A small first release observed before later batches.                                                                                                 |
| **Priority**                      | Ordering between competing assignments. Different payloads at equal winning priority conflict.                                                       |
| **Applied / verified activation** | The agent observed its owned Vector process starting and staying alive with the expected managed file. Download or file write alone is insufficient. |
| **Drift**                         | The managed file differs from the verified desired content. Authorized sync repairs it unless paused.                                                |
| **Last verified configuration**   | A protected recovery copy previously observed running. An arbitrary manual edit is not automatically a recovery point.                               |

See [deploy and roll back](#/docs/deployments#deploy-a-published-version) for the workflow and [apply states](#/docs/deployments#read-the-apply-states) for interpreting progress.

## Devices, permissions and credentials

| Term                       | Meaning                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adoption**               | A host operator explicitly gives the agent ownership of a fixed Vector binary, process and sole managed configuration.                                   |
| **Enrollment**             | An enrollment token and local certificate request establish device identity. A new device has no automatic pipeline assignment.                          |
| **mTLS**                   | Mutual TLS: the server verifies the device certificate and the device verifies the server certificate. Enrollment tokens do not authenticate heartbeats. |
| **CA**                     | Certificate authority used to establish trusted identities. Obtain a private CA through a trusted channel.                                               |
| **Restricted / full mode** | A local capability choice. Full mode trusts publishers with the adopted Vector process's host permissions.                                               |
| **Agent policy**           | Assigned heartbeat, sync-pause and telemetry settings. It cannot enable local full mode or broaden local resource permissions.                           |
| **Local pause**            | A durable host-owned maintenance marker; remote resume cannot clear it.                                                                                  |
| **Secret provider**        | A native Vector backend that obtains values by reference.                                                                                                |
| **Vectory local binding**  | A narrower protected file binding for supported sink authentication fields.                                                                              |
| **CSRF token**             | A per-session value required on dashboard API mutations to prevent unwanted cross-site requests. [API guide](#/docs/api).                                |

Follow [installation](#/docs/installation#install-and-enroll) to establish trust and [secret setup](#/docs/resources#keep-credentials-on-the-device) to keep values on the host.

## Digests and telemetry

**SHA-256 / digest:** a fingerprint of exact bytes, not encryption. A template digest identifies the published reference configuration. An effective digest identifies the managed file after Vectory local credential substitution. Neither attests to current values inside external native providers.

**Secret revision:** a local increasing counter for rendered credential attempts. A failed attempt does not become the last verified applied revision.

**Counter:** a total that usually increases during one process lifetime, such as errors. **Rate:** change in a counter over elapsed time, such as events per second. **Gauge:** a measured current value, such as buffer bytes. Process restarts can reset counters.

**Missing sample:** no usable measurement was reported. It is not a zero. A last-known sample remains historical when a device is offline. See [metric interpretation](#/docs/telemetry#interpret-the-numbers).

## Export formats

**JSONL / JSON Lines:** a text file with one complete JSON object per line. A tool can read its records one at a time without loading the whole file into memory. Vectory's audit export includes metadata, event records and a completion record. See [review and export audit events](#/docs/administer#review-and-export-audit-events).
