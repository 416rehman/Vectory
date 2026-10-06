# Glossary

The terms you'll meet in Vectory, in plain language. Each links to the page where you use it.

## Pipeline and components

| Term | Meaning |
| --- | --- |
| **Pipeline** | A Vector configuration: how events are collected, changed and delivered. [Build one](pipelines.md#add-and-connect-components). |
| **Source** | Receives or generates events, such as a file reader or an HTTP receiver. |
| **Transform** | Changes, filters, combines or routes events. |
| **Sink** | Sends events to a destination, such as an HTTP service or a storage system. Also called a destination. |
| **Input / output** | Connection points between components. A component with named outputs, such as `route`, sends different events to each. [Input patterns](pipelines.md#input-patterns) can match several outputs. |
| **VRL** | Vector Remap Language, used to inspect and change events. [Write VRL](pipelines.md#vrl) and [test it](resources.md#test-transformations). |
| **Enrichment table** | Lookup data a transform can query, such as a hostname-to-owner CSV. [Add one](resources.md#enrich-events-with-local-data). |
| **Schema** | The allowed fields, types and limits of a component. Passing schema checks doesn't prove the device can run it. |

## Configuration values

| Term | Example | Meaning |
| --- | --- | --- |
| **String** | `"edge-01"` | Text, even when it looks like a number. |
| **Number / integer** | `1.5` / `10` | A number, or a whole number. Check its unit and limits. |
| **Boolean** | `false` | True or false. `false` is a value, not "unset". |
| **Enum** | `"json"` | One value from a fixed set. The choice can reveal more settings. |
| **Object** | `{"codec": "json"}` | A group of named settings. |
| **Map** | `{"X-Team": "platform"}` | An object whose names you choose. |
| **List** | `["normalize", "routes.errors"]` | An ordered collection. |
| **Variant** | Syslog over TCP or a Unix socket | Alternative forms of a setting, each with its own fields. |
| **Default** | | What Vector does when you leave a setting out. It isn't written into your pipeline. |

## Omitted null and empty values

**Omitted** means the setting is absent. **Null** means it is present with the value `null`, which only some settings allow. **Empty** depends on the type: `""`, `[]` and `{}` are different values. See [Omitted null and empty values](pipelines.md#omitted-null-and-empty-values).

## Event templates

An **event template**, such as `{{ hostname }}`, reads a value from each event. An **environment variable**, such as `${HOSTNAME}`, reads Vector's environment. A **secret reference** reads a credential. [Compare them](resources.md#choose-the-right-reference).

## Changes and deployment

| Term | Meaning |
| --- | --- |
| **Draft** | The editable copy of a pipeline. Each save creates a new **revision**. |
| **Version** | An immutable snapshot you publish from a draft. Devices only run versions. |
| **Deployment** | One version, or one set of agent settings, assigned to devices with a rollout plan. |
| **Assignment** | What a deployment asks a device to run. The highest-priority assignment wins. |
| **Priority** | Decides between assignments for the same device. Different pipelines at the same winning priority conflict. |
| **Generation** | A counter that increases with every change a device is asked to make. Devices refuse lower generations. |
| **Canary** | The first few devices in a rollout, watched before the rest. |
| **Fixed or following targets** | A deployment either keeps the devices chosen when it started, or also includes future members of its groups. |
| **Applied** | The agent saw Vector start with the version and keep running. A download or written file alone isn't applied. |
| **Rolled back** | The version failed, so the agent restored the last working configuration. |
| **Held on previous version** | The newest version failed on a device that still runs the one before it and delivers on it. Not failed: nothing is broken on the host. |
| **Canary size** | How many devices a canary releases first. You choose which ones when you review. |
| **Drift** | The device's configuration file no longer matches what it should run. The agent restores it, unless sync is paused. |

See [Deploy and roll back](deployments.md) for the workflow and [Read the apply states](deployments.md#read-the-apply-states) for every state.

## Devices, permissions and credentials

| Term | Meaning |
| --- | --- |
| **Device** | A host that runs Vector and the Vectory agent. |
| **Agent** | The `vectory` program on a device. It connects out to the server and manages one Vector process. |
| **Adoption** | Giving the agent ownership of one Vector binary and one configuration file, as an explicit choice on the host. |
| **Enrollment** | Connecting a device to the server with a one-time token. It never assigns a pipeline. |
| **Enrollment token** | A secret that lets hosts enroll, limited by uses, expiry and name prefix. It can't sign in to the dashboard. |
| **Mutual TLS** | Both sides prove who they are with certificates: the device checks the server, and the server checks the device. |
| **CA** | A certificate authority: the issuer a device trusts to identify your server. |
| **Restricted / full mode** | A choice made on each device. Restricted allows a reviewed set of components and approved resources; full allows everything Vector can do. [Choose one](installation.md#choose-restricted-or-full-mode). |
| **Allowances** | The files, destinations and listeners a restricted device approves locally. |
| **Agent settings** | Check-in interval, configuration sync and metrics collection, deployed to devices. They can't change a device's mode or allowances. |
| **Local pause** | A pause set on the host with `vectory pause`. Only the host can clear it. |
| **Device secret** | A `vectory-secret:NAME` reference in a credential field. The agent fills it from a private file bound on the device with `configure-secrets`. [Use one](resources.md#keep-credentials-on-the-device). |
| **Secret provider** | A Vector backend that looks up credentials by name. Full mode only. |
| **Agent update** | Replacing the agent on a host from the dashboard, in a rollout. A host takes it only if it agreed to updates and a key it pinned signed the build. [Agent updates](agent-updates.md). |
| **Consent (to updates)** | A host's choice about agent updates: **Automatic**, **Ask on the host** or **Off**. It is made once, in the command run on the host, and kept in a file only root can write. |
| **Release key** | The key that signs agent builds. A host pins its fingerprint and installs only builds that a pinned key signed. **This server signs** or **A key kept offline** says who holds the private half. |
| **Fingerprint / short ID** | The SHA-256 of a key's bytes, in lower-case hexadecimal. Its first 16 characters are the short ID the dashboard and `vectory update status` show. |
| **Pinning** | A host's trust in a release key, written when it agrees to updates. Pinning a key trusts its holder with root on that host. |
| **Custody** | Who holds the release key's private half: the server, or you offline. Fixed while updates are on. |
| **Rollover** | A statement, signed by the old release key, that names its successor. Hosts that pin the old key follow it when they are offered a release the new key signed. |
| **Release** | One agent build from this server's catalog, with a counter, an expiry and the signature hosts check. |
| **Release counter** | A number that only goes up. A host never tries a release at or below the highest counter it already tried. |
| **Update rollout** | Sending a release to a chosen set of devices: a canary first, then batches. Separate from a [deployment](deployments.md) of a pipeline. |
| **Revocation** | Permanently blocking a device identity. |
| **Identity recovery** | Replacing a lost device identity with a new one, authorized by an administrator. |
| **CSRF token** | A per-session value every change through the API must include, so other sites can't act as you. [API](api.md). |

## Digests and telemetry

| Term | Meaning |
| --- | --- |
| **SHA-256 / digest** | A fingerprint of exact bytes. Changing one byte changes it. It isn't encryption. |
| **Template digest** | Fingerprint of the published version. |
| **Effective digest** | Fingerprint of the configuration a device actually wrote, after filling in local secrets. |
| **Secret revision** | A local counter that increases each time the agent renders new secret values. |
| **Counter** | A total that grows while Vector runs, such as errors. A restart resets it. |
| **Rate** | How fast a counter grows, such as events per second. |
| **Gauge** | A current value, such as buffered bytes. |
| **Missing sample** | No value was reported. It isn't zero. |

## Export formats

**JSON Lines (JSONL):** a text file with one complete JSON object per line, so tools can read it record by record. Audit exports use it: a first line describing the export, one line per event, and a final line confirming the file is complete. See [Review and export audit events](administer.md#review-and-export-audit-events).
