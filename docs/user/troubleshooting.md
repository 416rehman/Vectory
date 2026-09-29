# Troubleshooting

Find your symptom, check the likely causes in order, and fix the first one that matches. Start from the device page: its connection, last check-in and pipeline status narrow most problems down.

## A device is offline or never connects

<!-- steps -->
1. **Is the agent running?** On the device, `sudo vectory status`. If the service is stopped, `sudo vectory service-start`. Don't start a second agent by hand: only one can use the state directory.
2. **Does anything keep it running?** On a host without a service manager (most containers, WSL, Alpine with OpenRC), setup checks in once and stops: it prints `[!!] Service` with the command to run and exits with code 3, and **Add device** reads "checked in once, but nothing keeps its agent running". Start the agent with that command, such as `sudo /usr/local/bin/vectory run --state-dir /var/lib/vectory-agent`, under whatever keeps processes running there. See [Keep the agent running](installation.md#keep-the-agent-running).
3. **Can it reach the server?** Run `sudo vectory doctor`. It checks name resolution, the TLS connection, the certificate, the clock and the device's credentials, and prints a fix for each failure.
4. **Is the address right?** Agents use port **8443**; browsers use **443**. `--server` must be `https://` with the agent listener's name.
5. **Is the certificate trusted?** A private CA needs the pin from **Add device** or a `--ca-file`. See [Trust the server certificate](installation.md#trust-the-server-certificate). Never turn verification off.
6. **Is the clock right?** Certificates fail when the device's clock is far off.
7. **Was the device revoked or replaced?** A revoked identity can't reconnect. See [Recover a device identity](agents.md#recover-a-device-identity).

Once fixed, the device's check-in time updates within one check-in interval. A Vector that was already running keeps running while the server is unreachable.

If Vector itself stops, the agent restarts it with the last working configuration, backing off up to five minutes between attempts. It doesn't restart Vector while configuration sync is paused.

## Enrollment fails

Keep the state directory. Don't delete keys or `enrollment.json` to start over: the server may already have accepted the request.

| Message or situation | Fix |
| --- | --- |
| Can't reach the server, or the certificate isn't trusted | Fix the address or trust as in [A device is offline](#a-device-is-offline-or-never-connects), then run the same command again. |
| Unreadable or invalid CA file | Copy the correct public PEM to a stable path the agent can read, then retry with `--ca-file PATH`. |
| `ENROLLMENT_FAILED` (401) | The server refused the token or name. Ask an administrator to check the token's expiry, uses, name prefix and revocation in **Add device**. A token can't take over a name that belongs to another device. |
| Already enrolled | The device already has an identity. Look it up in **Devices**. Re-enroll only through [identity recovery](agents.md#recover-a-device-identity). |
| Interrupted | Run the same command again with the same server, name and token. The agent reuses its pending request, so nothing is created twice. |
| The service account can't run Vector or the agent | Setup names the folder or file that blocks it, such as a private `/root`. Install Vector system-wide (https://vector.dev/download/) or pass `--vector-binary` with a path the account can read. Keep the agent at mode `0755`. |

For security, the server never tells a device why it refused. Administrators see the reason in **Add device** and in the audit log.

## A pipeline is rejected or rolled back

Open the device and read its issue: it names the stage and the reason.

| Issue code | What happened | Fix |
| --- | --- | --- |
| `VALIDATION_FAILED` | Vector rejected the configuration on the device, or its tests failed. | Read the reason, fix the pipeline, publish and deploy again. Check host dependencies: files, credentials, environment. |
| `CAPABILITY_DENIED` | The pipeline needs something the device's mode or allowances don't permit. The reason names the component and the exact destination, listener or path, for example `Sink "out" (http) sends to 127.0.0.1:9`. | Have the host operator add the entry the fix names (such as `"127.0.0.1:9"` to `allowed_network_hosts`), or switch the device to full mode. The dashboard can't grant it. `vectory status` on the device shows the same problem and fix. |
| `SECRET_RESOLUTION_FAILED` | A `vectory-secret:` reference has no binding, its file can't be read or its value was refused, or it sits in a field that can't hold a secret. The diagnostic names the step, the field and the secret. | Bind the name, or fix the secret file's permissions, then start the agent: its next check-in applies the version. The device page's **Device secrets** card shows which names are bound. See [Keep credentials on the device](resources.md#keep-credentials-on-the-device). |
| `APPLY_ROLLED_BACK` | Vector didn't start or stay up with the new version, so the agent restored the last working configuration. | Check host resources, ports and destinations, then retry or deploy a fix. |
| `ACTIVATION_FAILED`, `PROCESS_EXITED`, `PROCESS_STOPPED` | Vector didn't start, or stopped. | Check the service and host resources, then restart the agent. |
| `WRITE_FAILED`, `PATH_UNSAFE` | The agent couldn't write its files safely. | Check disk space, ownership and permissions, and remove symlinks from the paths. |
| `INCOMPATIBLE` | The version was built for a different Vector minor version than the device runs. Patch releases of the same minor (0.58.0, 0.58.1) are interchangeable, so a patch difference never causes this. `vectory status` names both versions. | Install Vector 0.58.x and [approve it](agents.md#replace-the-vector-binary). |
| `ADOPTION_REQUIRED` | The agent hasn't adopted a Vector binary yet. | Run `vectory install ... --adopt` on the device. |
| `DOWNLOAD_FAILED`, `DIGEST_MISMATCH` | The device couldn't fetch the version, or the bytes didn't match. | Check connectivity; the agent retries on its own. |
| `ROLLBACK_UNAVAILABLE` | The device's first version didn't start, so there was nothing earlier to go back to. Vector is stopped and nothing runs; the device page reads **Nothing running: Vector stopped after v1 failed to start.** | Fix the problem the issue names, such as a listener on port 514, then deploy a corrected version or choose **Retry application**. Nothing on the host needs recovering. |
| `ROLLBACK_FAILED`, `RECOVERY_INVALID` | The new version failed and the last working configuration couldn't be restored. | Needs someone on the host. Keep the state directory intact and deploy a version that works. |
| `MANIFEST_EXPIRED` | The approval expired before the switch. | Nothing: the agent waits for its next check-in. |

The issue, the device page and `sudo vectory status --json` (under `configuration_attempt.error.diagnostics`) show Vector's own message, with secret values removed.

A device doesn't retry a failed version by itself, so a bad version can't restart Vector in a loop. After fixing the cause, use **Retry application** on the device, deploy a corrected version, or run `vectory retry` on the host with the agent stopped. Never delete state, edit counters or re-enroll to force a retry.

## Vector says the data directory doesn't exist

Vector refuses to start when its data directory is missing, with a message like:

```text
data_dir "/var/lib/vector/" does not exist
```

- If the pipeline sets **Data directory** in its general settings, create that folder on every device and give the agent's service account write access. On restricted devices, also allow it as a file root.
- If the pipeline leaves it empty, the agent gives Vector its own private data directory. Update the agent if you still see this message.

## A listener on a port below 1024 doesn't start

On Linux, ports below 1024 need a privilege the agent's service account doesn't have. A source that listens on one, such as syslog on 514, fails with `PRIVILEGED_PORT`:

```text
Vector can't listen on 0.0.0.0:514: ports below 1024 need a privilege the service account lacks.
```

- **Use a higher port.** Listen on 1514, for example, and point your senders there.
- **Or allow it on this host.** Run `sudo systemctl edit vectory.service`, add the lines below, then `sudo systemctl restart vectory.service`. Only this service gets the privilege.

  ```ini
  [Service]
  AmbientCapabilities=CAP_NET_BIND_SERVICE
  ```

On a restricted device, the address must also be in the host's allowed listeners. macOS and Windows have no privileged ports.

## Validation says deferred or unavailable

- **Deferred:** part of the check needs the device, such as a local file, a device secret, an environment variable or a provider. The device runs that check before applying. Deferred is not a pass.
- **Unavailable:** the server couldn't reach its validator, so publishing is blocked until it's back. It never skips the check. An administrator should check the `validator` container and the server log.
- **Structural only:** you're on a development preview without a validator. Production servers can't run that way.

## A credential is refused when you save or publish

Credentials stay on the devices, so a credential field holds a secret name, never the value. The message names the step and the field:

| Message | Fix |
| --- | --- |
| Plaintext credentials cannot be stored in the field | Replace the value with a device secret name, then bind it on each device with `vectory configure-secrets`. |
| Only credential fields can hold a device secret | Move the reference out of the URL, header, path or program, into the step's credential field, such as `auth.token`. |
| The field must be exactly `vectory-secret:NAME` | Remove any text around the reference, and start the name with a letter. |

See [Keep credentials on the device](resources.md#keep-credentials-on-the-device).

## A deployment is pending, paused or conflicting

| Status | Check |
| --- | --- |
| Offline target | The device needs to reconnect before it can apply anything. |
| Scheduled | The start time, and whether the schedule was missed. |
| Canary waiting | The canary devices: each must report **Applied** with a fresh check-in for the whole observation period. |
| Sync paused | Whether the pause was set on the rollout, in agent settings or on the host (`vectory resume` clears only a host pause). |
| Priority conflict | Two different pipelines at the same priority. Choose a higher priority, or remove the deployment you don't need. |
| Target set changed | Group membership changed since you reviewed. Review again and confirm. |

Removing or cancelling a deployment never stops Vector. See [Deploy and roll back](deployments.md).

## Metrics are missing, or no events reach a destination

**No metrics:** the pipeline needs a loopback Prometheus exporter fed by `internal_metrics` (**Add monitoring** adds one, and restricted devices run it without an allowance), and **Collect operational metrics** must be on. See [Enable real metrics](telemetry.md#enable-real-metrics). A rate needs two samples, and a dash means "not reported", not zero.

**No events at the destination:** **Applied** and throughput prove Vector runs and reads events; they don't prove delivery. When the device reports metrics, Vectory checks delivery for you: see [A pipeline applies but delivers nothing](#a-pipeline-applies-but-delivers-nothing). Check that the source receives events, that no condition discards them on purpose, and that the sink's address, credentials and destination are right. Test transforms with sample events in [pipeline tests](resources.md#test-transformations).

## A pipeline applies but delivers nothing

The device reads **Not delivering**: the version applied and Vector runs it, but its metrics show events aren't getting through. The device page names the component, the reason and the fix, and the issue appears in **Needs you** and [**Activity → Issues**](/#/issues).

| Issue | What Vectory measured | Likely cause |
| --- | --- | --- |
| **The pipeline stopped delivering** | Events keep arriving, but none have been delivered for three checks, and a sink is struggling. | A destination is down. Its buffer filled, so Vector paused every path that feeds it. |
| **_sink_ can't deliver events** | The sink failed at least one request a minute, two checks in a row. | Wrong address or credentials, the destination is down, or a firewall blocks it. |
| **_component_'s buffer is filling up** | A buffer is over 80% full and rising, or over 95% full. | The destination is slow, throttling or unreachable. |
| **_component_ is dropping events** | The component dropped events because of errors, at least one a minute. | A transform fails on some events, or a sink rejects them. |

<!-- steps -->
1. Open the device and read **Applied, but not delivering**. The Vector log line under the issue, such as `Connection refused`, usually names the cause.
2. Fix the destination, or the component's address, credentials or program. For a quick recovery, roll the pipeline back to its last working version.
3. Watch the device. The issue closes by itself after three clean checks (about three check-in intervals), and the device returns to **Applied**.

A canary rollout checks this before it releases more devices. While Vectory takes its first measurements the gate reads **Measuring delivery**; a canary that isn't delivering counts as a failure against the rollout's failure threshold, and the rollout page shows why. A device without metrics is judged on its apply state alone.

These checks need metrics: see [Enable real metrics](telemetry.md#enable-real-metrics). Without them the device page reads **Delivery health: not measured**, and only a sink that fails requests shows up, from Vector's own log: the same sink issue opens after two check-ins, its message ending "measured from Vector's log (no metrics)". On the host, `sudo vectory status` shows the failing sink under **Vector** and what to check next. A filter or route that drops events on purpose never counts as a delivery problem.

## The adopted Vector binary changed

The agent refuses to run a Vector binary whose SHA-256 changed since adoption. If you replaced Vector on purpose, [approve the new binary](agents.md#replace-the-vector-binary). If you didn't, find out why before doing anything else, and restore a trusted binary.

## A command on the device is refused

Stop the agent (`sudo vectory service-stop`) before changing local settings. If the command says another operation is running, wait for it to finish; don't delete `agent.lock` or start a second agent. A command that rejects its input changes nothing, so fix the input and run it again.

### A local settings update is refused

- **Can't preserve access:** the command couldn't keep the existing owner or permissions. Keep the files and ask the host administrator to check the service account's access. Don't make files world-readable to get past it.
- **Settings saved but retry state not updated:** the new settings are in effect. Check `vectory status`, fix the reported write problem, and run `vectory retry` only if you want another attempt.

### A capability-policy file is rejected

The file must be one JSON object, saved as UTF-8 without a byte-order mark, with the three lists `allowed_file_roots`, `allowed_network_hosts` and `allowed_listen_addresses` and nothing else. Use absolute file roots, exact `host:port` pairs, unique names and no comments. On Windows, double each backslash. The file is refused, not repaired, if its encoding is broken. See the [allowance format](installation.md#configure-restricted-allowances).

### A secret-binding map is rejected

The map must be one JSON object of names to absolute paths of private files, with unique names and no values. `{}` removes all bindings; `null`, lists and trailing content are refused. Pass it with `--secret-files PATH`.

### A metrics endpoint update is refused

`configure-metrics` needs exactly one of `--metrics-url URL` or `--clear-metrics-url`. The URL must be `http://` with a literal loopback IP, a port and a path, such as `http://127.0.0.1:9598/metrics`. Host names, HTTPS, credentials and query strings are refused.

## A page is blank or cannot load

- **This page couldn't load** or **This page is taking too long:** check your connection, then choose **Reload page**. The rest of the app keeps working meanwhile. Reloading is always your choice; interrupted actions are never resent.
- **This page stopped working:** a display error interrupted the page. Reloading shows your saved data; unsaved changes on that page may be lost.
- **The whole window is blank:** reload the browser tab. The Help center stays available at `/help/` on your server.

If a page keeps failing after reloads, ask your administrator to check that the server's dashboard files come from one complete build.

## A device page shows mismatched details

If a page says the details don't match the record you asked for, it has refused a reply meant for a different device or pipeline. Choose **Try again**. This is a loading problem: don't re-enroll the device or redeploy. If it keeps happening, ask your administrator to check any proxy or cache in front of the server.

## An old issue stays open after device recovery

Issues resolve when the same device identity next applies a version and confirms it. A revoked or replaced identity can't report again, so its old issues stay open.

<!-- steps -->
1. Open the issue's device link and confirm it's the old, revoked identity.
2. Check the replacement device separately: its check-ins and applied version.
3. In [**Activity → Issues**](/#/issues), choose **Acknowledge issue** and record why, for example where you checked the replacement.

Acknowledged issues leave the open list but stay in history with the reason, who acknowledged them and when. **Reopen issue** brings one back.

## You cannot sign in

### Loading or sign-in does not finish

The dashboard stops waiting after 30 seconds. Choose **Retry connection**, or **Check sign-in status** if you already submitted your password: it checks this browser's session without sending your password or code again. See [If a request is interrupted](interrupted-requests.md#accounts-and-sign-in).

### Credentials or account access are rejected

- **Wrong password:** after several failures, sign-in pauses for that account and the message says when to try again. Ask an administrator for a [reset link](administer.md#help-someone-reset-a-forgotten-password) if you forgot it.
- **Code rejected:** check that your phone's clock is right, or choose **Use a recovery code instead**. If the code step expires, start again with your email and password.
- **Account disabled:** an administrator must turn access back on under **People & security**.
- **After a restore:** old sessions and recovery codes no longer work. Sign in with your password and authenticator.

The bootstrap secret only creates the first administrator; it can't sign anyone in afterwards.

## Error messages

| Code | Meaning | What to do |
| --- | --- | --- |
| `UNAUTHENTICATED` (401) | Not signed in, or the session ended. | Sign in again. |
| `FORBIDDEN` (403) | Your role doesn't allow this, or the page is out of date. | Ask for the role you need, or reload. |
| `SIGNIN_THROTTLED`, `RATE_LIMITED` (429) | Too many attempts. | Wait for the time in the message. |
| `STALE_REVISION` (409) | Someone saved a newer version first. | Load the latest, review, then save again. |
| `ACTIVE_CANARY_OVERLAP` (409) | A running canary already covers some of these devices. | Wait for it to finish, or pause it deliberately. |
| `FULL_VECTOR_MODE_REQUIRED` | The version needs full mode on a restricted device. | Deploy to full-mode devices, or change the pipeline. |
| `VECTOR_VERSION_INCOMPATIBLE` | The device doesn't run Vector 0.58.x. | Install a 0.58 release on the device and approve it. |
| `DEVICE_SYNC_PAUSED` | The device's configuration sync is paused. | Resume sync before retrying. |
| `CAPACITY_BUSY` | The agent listener is at its connection limit. | Nothing: agents retry on their own. |
| `IDEMPOTENCY_CONFLICT` | A request ID was reused for a different request. | Start a new request. |

## Prepare a useful problem report

Include the Vectory and agent versions, the Vector version, the device's OS and CPU, the device ID, times with their time zone, the issue code and stage, the deployment or version ID, and any request ID shown. A minimal synthetic pipeline that reproduces the problem helps most.

Never include tokens, private keys, cookies, authenticator secrets, secret files or a device's rendered configuration. Vectory never uploads diagnostics by itself.
