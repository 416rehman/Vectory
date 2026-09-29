# Security model

What Vectory guarantees, who has to trust whom, and where the limits are. Read this before you connect production hosts.

## The guarantees

- **Devices only connect out.** The agent opens every connection, over TLS 1.3. Nothing on a device listens for Vectory, and there is no option to skip certificate checks.
- **Devices prove who they are.** Each device has its own key and certificate. Every request after enrollment uses mutual TLS, and a revoked device is refused at once.
- **Devices only run what they can verify.** A configuration is an immutable, published version. It arrives in a manifest signed for that one device, and the agent refuses anything older than what it has already accepted.
- **The host decides what a pipeline may touch.** Restricted mode, files, destinations and listeners are local choices. The server can't widen them.
- **Credentials stay on the host.** Pipelines reference secrets by name. The values live in local files the server never sees.
- **Your events stay yours.** Events flow from Vector to your destinations. Vectory receives only status and the bounded metrics you enable.
- **Every change is authorized and recorded.** The server checks each permission itself and writes an audit event for every change.

## Trust boundaries

| Party | Trusted to | Enforced by |
| --- | --- | --- |
| **Administrators** | Manage people, recover device identities and run server maintenance. | Server-side role checks; password plus optional two-factor sign-in. |
| **Operators** | Publish and deploy to devices, and manage enrollment tokens and device access. | Server-side role checks. Every deployment is previewed and audited. |
| **Pipeline publishers** | Run the components each device allows. In full mode, act with Vector's permissions on that host. | The device's local mode and allowances. |
| **Host operators** | Choose restricted or full mode, approve resources and provide credentials. | Local files and flags that only someone on the host can change. |
| **The Vectory server** | Tell devices which signed version to run. | Signed manifests, generation checks and local policy on each device. |

A person who can publish pipelines to a full-mode device can make that host's Vector do anything Vector can do. Choose full mode only where you trust everyone with the Operator role.

## Restricted and full mode

Each device runs in one mode, chosen on the host when the agent is installed.

**Restricted** (the default) accepts only:

| Kind | Allowed |
| --- | --- |
| Sources | `demo_logs`, `internal_metrics`, `file`, `http_server`, `syslog`, `opentelemetry` |
| Transforms | `remap`, `filter`, `route`, `sample`, `reduce`, `log_to_metric` |
| Sinks | `console` (to stderr only), `blackhole`, `http`, `loki`, `elasticsearch`, `prometheus_exporter` |
| Global settings | `data_dir`, a loopback-only `api`, `acknowledgements`, `healthchecks`, `timezone` |

Within those components, restricted mode also:

- allows only the file roots, `host:port` destinations and listener addresses listed in the device's [allowance file](installation.md#configure-restricted-allowances);
- requires explicit destinations and listeners, so a component can't fall back to a default address;
- refuses environment variables (`$NAME`, `${NAME}`), `{{ }}` templates and other substitutions anywhere in the pipeline;
- refuses secret providers, enrichment tables, external VRL files and any setting that runs a program;
- refuses VRL that calls a function reaching outside the event: `get_env_var`, `get_secret`, `set_secret`, `remove_secret`, `dns_lookup`, `reverse_dns`, `http_request`, `get_enrichment_table_record`, `find_enrichment_table_records`, and the functions that read a file (`validate_json_schema`, `parse_proto`, `encode_proto`). Only a call counts: a metric named `http_requests_total` or an event value `"http_request"` is data;
- refuses to turn off TLS certificate or host name verification.

**Full Vector** mode accepts anything the host's Vector build supports. Only the host can enable it, with `vectory install --allow-full-vector-config`; the dashboard shows the mode and blocks deployments that need full mode on restricted devices. Allowances don't apply in full mode.

> [!NOTE]
> Allowances limit what a pipeline asks Vector to do. They are not an operating-system sandbox. Use host permissions, a dedicated service account and network controls where you need stronger isolation.

## How a device proves who it is

1. **Enrollment.** The agent creates its private key on the host and sends a certificate request with a one-time enrollment token. It verifies the server's certificate before sending the token. The server issues a client certificate valid for 30 days and ignores every other field the request asks for.
2. **Every check-in** uses mutual TLS with that certificate. Enrollment tokens can't authenticate check-ins, downloads or the dashboard.
3. **Renewal** happens automatically, over the same authenticated channel, in the certificate's last day.
4. **Revocation** in the dashboard blocks the identity's certificates immediately. It also removes the device from its groups and from deployments that follow group membership. It doesn't stop Vector on the host.
5. **Recovery** replaces a lost identity. It needs an administrator's one-time authorization and a person on the host, and it creates a new device identity. See [Recover a device identity](agents.md#recover-a-device-identity).

Enrollment tokens can be limited by use count, expiry and device-name prefix. A token can't take over a name that belongs to an existing device.

## How a version reaches a device

1. **Checked before publishing.** The sandboxed validator runs `vector validate` on the pipeline. If the validator is unavailable, publishing stops; it never skips the check.
2. **Immutable once published.** A version never changes. Rolling back deploys an older version as a new, higher generation.
3. **Signed for one device.** Each check-in returns a manifest signed with the server's Ed25519 key. It names the device, echoes a fresh random value the agent sent, and expires after five minutes, so it can't be replayed elsewhere or later.
4. **Never older.** The agent remembers the highest generation it has accepted and refuses anything older, even from a restored server backup.
5. **Fetched by digest.** The agent downloads the version by its SHA-256 and checks the bytes. The server only serves the version currently released to that device.
6. **Checked again on the host.** The agent applies the device's mode and allowances, then runs Vector's own validation in the host environment.
7. **Applied safely.** The agent records each step, starts Vector with the new configuration and watches it stay up. If it fails, the agent restores the last working configuration.
8. **Pinned Vector.** The agent records the SHA-256 of the Vector binary it adopted and refuses to run a changed binary until someone on the host [approves the new one](agents.md#replace-the-vector-binary).

## Credentials and data

- **Local secret bindings.** A reference such as `vectory-secret:API_TOKEN` is resolved by the agent from a private local file. The value is written only into the device's managed configuration, which the agent keeps private. See [Keep credentials on the device](resources.md#keep-credentials-on-the-device).
- **Native Vector secrets and environment variables** (full mode only) are resolved by Vector on the host. The server never sees their values.
- **Events** never pass through Vectory. Operational metrics come only from a Prometheus exporter in your own pipeline, are bounded in size, and never include event contents.
- **The validator** receives the pipeline you check, runs as its own user with no network route and no secrets, and returns only bounded results.

> [!WARNING]
> **Protect device files and backups**
> A device's managed configuration and recovery copies contain resolved secret values. So do backups of the agent's state. Keep them readable only by the agent's account and your administrators.

## The dashboard and API

- **Accounts** are local. Passwords (12 to 256 bytes) are stored as Argon2 hashes. Two-factor secrets are encrypted at rest.
- **Sessions** last 12 hours in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie. Every change also needs a per-session CSRF token.
- **Sign-in attempts** are rate-limited. Repeated failures for an account pause further attempts, and the error says when to try again.
- **Permissions** are enforced by the server on every request. Hiding a button is only a convenience.
- **Browser protection:** a strict Content Security Policy with no inline scripts, no framing, and no requests to other sites. The dashboard, fonts, API reference and this Help center are all served by your server.
- **Audit log:** every change records who did it, when and the result. You can export it as JSON Lines with a SHA-256 of the file.

## Limits to know

- **Full mode trusts publishers** with the host permissions of Vector.
- **The server is a high-value system.** Whoever controls it can deploy any configuration each device's local policy allows. Restrict access to it and to its backups.
- **Backups restore old decisions.** Restoring an old backup brings back old accounts, roles and device access. Follow [Restore a backup](administer.md#restore-a-backup) before reconnecting anyone.
- **Releases aren't signed yet.** Agent downloads carry SHA-256 checksums. Check them against the values shown in **Add device**.

The detailed threat model is in the source repository at `docs/security/THREAT-MODEL.md`. To report a vulnerability, follow the repository's `SECURITY.md`.
