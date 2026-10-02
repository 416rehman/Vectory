# Security model

What Vectory guarantees, who has to trust whom, and where the limits are. Read this before you connect production hosts.

## The guarantees

- **Devices only connect out.** The agent opens every connection, over TLS 1.3. Nothing on a device listens for Vectory. No option skips certificate checks: not in the agent, the installer, or the install command, which checks its download against your server's CA. To hear about changes within seconds, the agent keeps one of its own requests open; the answer only tells it to check in.
- **Devices prove who they are.** Each device has its own key and certificate. Every request after enrollment uses mutual TLS, and a revoked device is refused at once.
- **Devices only run what they can verify.** A configuration is an immutable, published version. It arrives in a manifest signed for that one device, and the agent refuses anything older than what it has already accepted.
- **The host decides what a pipeline may touch.** Restricted mode, files, destinations and listeners are local choices. The server can't widen them. The one exception is a loopback-only exporter of Vector's own metrics, described under [Restricted and full mode](#restricted-and-full-mode).
- **Credentials stay on the host.** Pipelines reference secrets by name. The values live in local files the server never sees.
- **Your events stay yours.** Events flow from Vector to your destinations. Vectory receives only status and the bounded metrics you enable.
- **Changes are authorized and recorded.** The server checks each permission itself and writes an audit event for each change it accepts.

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
| Global settings | `data_dir`, `acknowledgements`, `healthchecks`, `timezone` |

Within those components, restricted mode also:

- allows only the file roots, `host:port` destinations and listener addresses listed in the device's [allowance file](installation.md#configure-restricted-allowances). One listener is exempt: the monitoring exporter, a `prometheus_exporter` on a loopback IP literal whose inputs are all `internal_metrics` sources (what **Add monitoring** adds). It exposes only Vector's own metrics, to this host. Only one such exporter per pipeline is exempt;
- requires explicit destinations and listeners, so a component can't fall back to a default address;
- refuses environment variables (`$NAME`, `${NAME}`), `{{ }}` templates and other substitutions anywhere in the pipeline;
- refuses secret providers, enrichment tables, external VRL files and any setting that runs a program;
- refuses an `api` block. Vector's local API has no authentication, so any local user could read live events through it. A pipeline that opens it needs a full-mode device;
- refuses VRL that calls a function reaching outside the event: `get_env_var`, `get_secret`, `set_secret`, `remove_secret`, `dns_lookup`, `reverse_dns`, `http_request`, `get_enrichment_table_record`, `find_enrichment_table_records`, and the functions that read a file (`validate_json_schema`, `parse_proto`, `encode_proto`). Only a call counts: a metric named `http_requests_total` or an event value `"http_request"` is data;
- refuses to turn off TLS certificate or host name verification.

**Full Vector** mode accepts anything the host's Vector build supports. Only the host can enable it, with `vectory install --allow-full-vector-config`; the dashboard shows the mode and blocks deployments that need full mode on restricted devices. Allowances don't apply in full mode.

**Both modes** refuse a component ID that could be a path: one with a `/`, a `\` or a control character, or one that starts with a drive letter and a colon (like `C:`). Vector uses an ID as a directory name under its `data_dir` for disk buffers and checkpoints, so an ID such as `/tmp/x` would make it create files outside the agent's state directory. The agent refuses such a version before Vector sees it and reports `INVALID_COMPONENT_ID`, naming the component. A restricted device refuses an `api` block the same way and reports `LOCAL_API_DENIED`: no allowance covers it, so the version needs a full-mode device. Both findings, and what to do about them, are in [A pipeline is rejected or rolled back](troubleshooting.md#a-pipeline-is-rejected-or-rolled-back).

> [!NOTE]
> Allowances limit what a pipeline asks Vector to do. They are not an operating-system sandbox. Use host permissions, a dedicated service account and network controls where you need stronger isolation.

## How a device proves who it is

1. **Enrollment.** The agent creates its private key on the host and sends a certificate request with a one-time enrollment token. It verifies the server's certificate before sending the token. The server issues a client certificate valid for 30 days and ignores every other field the request asks for.
2. **Every check-in** uses mutual TLS with that certificate. Enrollment tokens can't authenticate check-ins, downloads or the dashboard.
3. **Renewal** happens automatically, over the same authenticated channel, in the certificate's last day. After the server's device certificate authority is [rotated](administer.md#rotate-the-device-certificate-authority), renewal moves each device to the new one; until the old one is retired, certificates from both are accepted.
4. **Revocation** in the dashboard blocks the identity's certificates immediately. It also removes the device from its groups and from deployments that follow group membership. It doesn't stop Vector on the host.
5. **Recovery** replaces a lost identity. It needs an administrator's one-time authorization and a person on the host, and it creates a new device identity. See [Recover a device identity](agents.md#recover-a-device-identity).

Enrollment tokens can be limited by use count, expiry and device-name prefix, and to a list of up to 500 device names, each of which can enroll once. A token can't take over a name that belongs to an existing device.

A token can also give the devices it enrolls up to 8 labels, such as `site=berlin`. Labels describe a device. They never add it to a group, target it with a deployment or give it secrets: every new device starts unmanaged until someone deploys to it. Someone who steals a token can enroll a device only within the token's limits, and that device receives nothing until an operator targets it. Revoke a token you no longer need in **Add device**.

## How a version reaches a device

1. **Checked before publishing.** The isolated validator runs `vector validate` on the pipeline. Checks that need the device, such as local files, wait for step 6. If the validator is unavailable, publishing stops; it never skips the check.
2. **Immutable once published.** A version never changes. Rolling back deploys an older version as a new, higher generation.
3. **Announced, never pushed.** When a device's version, settings or access change, the server answers the agent's open request with `{"changed":true}`. The answer is unsigned and carries nothing else: the agent checks in as usual, so a forged answer can cause at most an early check-in.
4. **Signed for one device.** Each check-in returns a manifest signed with the server's Ed25519 key. It names the device, echoes a fresh random value the agent sent, and expires after five minutes, so it can't be replayed elsewhere or later.
5. **Never older.** The agent remembers the highest generation it has accepted and refuses anything older, even from a restored server backup.
6. **Fetched by digest.** The agent downloads the version by its SHA-256 and checks the bytes. The server only serves the version currently released to that device.
7. **Checked again on the host.** The agent applies the device's mode and allowances, then runs Vector's own validation in the host environment.
8. **Applied safely.** The agent records each step, starts Vector with the new configuration and watches it stay up. If it fails, the agent restores the last working configuration.
9. **Pinned Vector.** The agent records the SHA-256 of the Vector binary it adopted and refuses to run a changed binary until someone on the host [approves the new one](agents.md#replace-the-vector-binary).

## Credentials and data

- **Device secrets.** A reference such as `vectory-secret:API_TOKEN` is resolved by the agent from a private local file, in any credential field. Plain text in a credential field is refused at save and publish. The agent substitutes only at the credential fields of its own built-in table, never where the server asks, so a pipeline can't move a secret into a URL, header or program. It reports bound names at check-in, never values or paths. The value is written only into the device's managed configuration, which the agent keeps private. See [Keep credentials on the device](resources.md#keep-credentials-on-the-device).
- **Native Vector secrets and environment variables** (full mode only) are resolved by Vector on the host. The server never sees their values.
- **Events** never pass through Vectory. Operational metrics come only from a Prometheus exporter in your own pipeline, are bounded in size, and never include event contents.
- **The validator** receives the pipeline you check, runs as its own user with no network route and no secrets, and returns only bounded results.
- **Notification channels** keep their webhook URLs, signing secrets, header values and SMTP passwords write-only: encrypted at rest, never returned by the API, never written to the audit log or server logs. The server sends notifications only to public addresses, unless an administrator allows private ones for a channel, and never to link-local or cloud metadata addresses. See [Alerts and notifications](notifications.md#private-networks-and-blocked-addresses).

> [!WARNING]
> **Protect device files and backups**
> A device's managed configuration and recovery copies contain resolved secret values. So do backups of the agent's state. Keep them readable only by the agent's account and your administrators.

## The dashboard and API

- **Accounts** are local. Passwords (12 to 256 bytes) are stored as Argon2 hashes. Two-factor secrets are encrypted at rest.
- **Sessions** last 12 hours in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie. Every change also needs a per-session CSRF token.
- **Sign-in attempts** are rate-limited. Repeated failures for an account pause further attempts, and the error says when to try again. Authenticator codes have their own limit: five wrong codes end a sign-in, and ten attempts in five minutes pause the account's second step, whichever addresses they come from. One address can't use up the limits other people need, and an address that has signed in before keeps a reserved share during a flood.
- **Permissions** are enforced by the server on every request. Hiding a button is only a convenience.
- **Browser protection:** a strict Content Security Policy with no inline scripts, no framing, and no requests to other sites. The dashboard, fonts, API reference and this Help center are all served by your server.
- **Audit log:** each change the server accepts records who made it, when and the result. You can export it as JSON Lines with a SHA-256 of the file.

## Limits to know

- **Full mode trusts publishers** with the host permissions of Vector.
- **The server is a high-value system.** Whoever controls it can deploy any configuration each device's local policy allows. Restrict access to it and to its backups.
- **A certificate authority isn't an identity.** A device must present a certificate the server issued and still has on record, so the device CA's key alone can't impersonate a device.
- **Backups restore old decisions.** Restoring an old backup brings back old accounts, roles and device access. Follow [Restore a backup](administer.md#restore-a-backup) before reconnecting anyone.
- **Releases aren't signed yet.** Agent downloads carry SHA-256 checksums. Check them against the values shown in **Add device**.

The detailed threat model is in the source repository at `docs/security/THREAT-MODEL.md`. To report a vulnerability, follow the repository's `SECURITY.md`.
