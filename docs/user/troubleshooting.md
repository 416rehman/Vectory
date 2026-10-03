# Troubleshooting

Find your symptom, check the likely causes in order, and fix the first one that matches. Start from the device page: its connection, last check-in and pipeline status narrow most problems down.

## A device is offline or never connects

<!-- steps -->
1. **Is the agent running?** On the device, `sudo vectory status`. It shows the last check-in and when the next is due: `overdue by 2 min` means the agent runs but isn't getting through. If the service is stopped, `sudo vectory service-start`. Don't start a second agent by hand: only one can use the state directory.
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
| Can't reach the server, or the certificate isn't trusted | Fix the address or trust as in [A device is offline](#a-device-is-offline-or-never-connects), then run the same command again. Without a pin, setup prints the fingerprint of the certificate it was sent in rows of eight pairs: compare it with **Add device**, then copy the command from there. Never pin what the host was sent. |
| `The server's certificates don't match the pinned CA`, with `expected` and `received` fingerprints and the first byte that differs | Compare both with the fingerprint on **Add device** and copy the command again. If it still doesn't match, this address may lead to a different server: don't continue. |
| Unreadable or invalid CA file | Copy the correct public PEM to a stable path the agent can read, then retry with `--ca-file PATH`. |
| `that isn't a whole enrollment token` | The pasted token isn't 64 characters, so it was never sent. Copy it again with **Copy token** on **Add device**. |
| `ENROLLMENT_FAILED` (401) | The server refused the token or name. Ask an administrator to check the token's expiry, uses, name prefix and revocation in **Add device**. A token can't take over a name that belongs to another device. |
| Already enrolled | The device already has an identity. Look it up in **Devices**. Re-enroll only through [identity recovery](agents.md#recover-a-device-identity). |
| Interrupted | Run the same command again with the same server, name and token. The agent reuses its pending request, so nothing is created twice. |
| The service account can't run Vector or the agent | Setup names the folder or file that blocks it, such as a private `/root`. Install Vector system-wide (https://vector.dev/download/) or pass `--vector-binary` with a path the account can read. Keep the agent at mode `0755`. |

For security, the server never tells a device why it refused. Administrators see the reason in **Add device** (under **Recent enrollment attempts**) and in the audit log:

| Reason | **Add device** says | Fix |
| --- | --- | --- |
| `TOKEN_UNKNOWN` | the token wasn't recognized | Check that the whole token was pasted, then run the command again. |
| `TOKEN_EXPIRED` | the token expired | Create a new command and run it again. |
| `TOKEN_REVOKED` | the token was revoked | Create a new command and run it again. |
| `TOKEN_EXHAUSTED` | the token was already used | Create a new command for this device. |
| `NAME_TAKEN` | that name belongs to an existing device | Run the command again with another `--name`, or authorize recovery from the existing device's page to replace it. |
| `NAME_PREFIX_MISMATCH` | the token only allows other device names | Use a name the token allows, or create a new command without a name restriction. |
| `DEVICE_NAME_MISMATCH` | the command was made for another device name | Run it with the `--name` it was made for, or create a new command for this name. A command made for a typed name enrolls only that name. |
| `RECOVERY_NAME_MISMATCH` | this recovery token is for another device name | Use the recovered device's exact name. |
| `RECOVERY_TARGET_MISSING` | the device being recovered no longer exists | Create a new command to add it as a new device. |
| `REQUEST_MISMATCH` | a different key reused an earlier request | Run setup again from the same state directory, or start over with a new command. |
| `DEVICE_REVOKED` | the device this request enrolled was revoked | Create a new command to add the host again. |
| `MALFORMED` | the request was incomplete or used an unsupported agent | Use the agent from this server's install command. |

A refusal that repeats for the same token and reason is recorded once a minute, so a host that keeps retrying doesn't fill the audit log.

A device that enrolled but "checked in once, but nothing keeps its agent running" has no service manager: start the agent with the command setup printed, as in [A device is offline](#a-device-is-offline-or-never-connects).

## Setup stops because Vector is already running

Setup never takes over a running Vector. It records how that Vector was started, copies the configuration files it loads and stops. The only thing it has written is the copies, in `adoption-inventory` in the state directory. For a Vector that loads one plain file, it says:

```text
[i]  Inventory    Vector started with: /usr/bin/vector --config /etc/vector/vector.yaml; configuration files:
                  /etc/vector/vector.yaml (sha256 2f69f4e8c932…), backed up to
                  /var/lib/vectory-agent/adoption-inventory/20260930T101500Z.
[!!] Existing     Vector is already running here: vector.service (pid 812). Setup won't take it over.
                  To hand its workload to Vectory, save its configuration as JSON at
                  /etc/vectory/managed/vector.json, stop it (for example: sudo systemctl disable --now
                  vector.service), then run this command again. To leave it running untouched beside
                  Vectory, add --keep-existing-vector. Its configuration is backed up in
                  /var/lib/vectory-agent/adoption-inventory/20260930T101500Z.
```

When the Vector loads more than that one file, the second message names what it found and the two ways forward:

```text
[!!] Existing     Vector is already running here: vector.service (pid 812). Setup won't take it over, and
                  the agent manages exactly one JSON file, so adopting it would drop what these load:
                  Vector loads 2 configuration files: /etc/vector/conf.d/10-sources.yaml,
                  /etc/vector/conf.d/20-sinks.yaml.
                  Merge what it loads into one JSON file at /etc/vectory/managed/vector.json (the Help
                  center's Connect a device page, under Keep an existing workload, shows how), or adopt it
                  as it is: the agent then manages only /etc/vectory/managed/vector.json; what it loads
                  stays where it is (backed up in
                  /var/lib/vectory-agent/adoption-inventory/20260930T101500Z) and no Vector started by
                  Vectory reads it. Either way, stop it (for example: sudo systemctl disable --now
                  vector.service), then run this command again with --adopt-existing.
```

| Message | Fix |
| --- | --- |
| `Setup won't take it over.` with `To hand its workload to Vectory…` | Save its configuration as JSON at the managed path, stop it and run the command again. Add `--keep-existing-vector` only to leave it running beside the agent. |
| `…so adopting it would drop what these load:` and the files or findings | Merge what it loads into one JSON file, or adopt it as it is. Either way, stop it and run the command again with `--adopt-existing`. Every finding is explained in [When setup stops for a running Vector](agents.md#when-setup-stops-for-a-running-vector). |
| `You chose to adopt it as it is (--adopt-existing): stop it…` | The flag is noted, and setup still won't take over a Vector that runs. Stop it and run the same command again. |
| `A Vector that ran here (recorded 2026-09-30 10:15 UTC) loaded configuration the agent doesn't manage:` | The old Vector has stopped, and setup remembers what it loaded. Run the command again with `--adopt-existing`. Merging the files first doesn't replace this: setup can't see what a merge left out. |
| `The record of an earlier inventory (…) can't be read` | Keep the folder and check the copies in it. Run the command again with `--adopt-existing` once you're sure nothing is lost. |
| `Nothing was copied: State directory contains unrelated files…` | Setup won't write copies into a folder that isn't a Vectory state directory. Choose an empty `--state-dir`, or copy the files yourself before you change them. |
| `Nothing was copied:` with `permission denied` | Run setup with `sudo` (an elevated shell on Windows), or copy the files yourself. |
| `--adopt-existing hands the workload of a running Vector to Vectory, and --keep-existing-vector…` | Pass only one of them. |

[Adopt a Vector that already runs](agents.md#adopt-a-vector-that-already-runs) has the whole procedure.

## A proxy is in the way

The agent honors `HTTPS_PROXY` and `NO_PROXY`, and tunnels through an HTTP proxy with `CONNECT`, so TLS and the device's certificate stay end to end and the server pin still applies. See [ports](ports.md). When the proxy is the problem, the message names it:

| Message | Fix |
| --- | --- |
| `Can't reach the proxy at proxy.example.net:3128.` | Check `HTTPS_PROXY`, or add the server to `NO_PROXY` if it should be reached directly. |
| `The proxy at proxy.example.net:3128 couldn't connect to vectory.example.com:8443.` or `…refused to connect… (Forbidden)` | Allow this server in the proxy, or add it to `NO_PROXY`. |
| `The proxy at proxy.example.net:3128 requires a user name and password.` | Set `HTTPS_PROXY` to `http://USER:PASSWORD@proxy.example.net:3128` where the agent runs, or ask the proxy's administrator to allow this server without a sign-in. The password is never printed. |
| `The proxy at proxy.example.net:3128 did not accept the user name and password in HTTPS_PROXY.` | Check them, and percent-encode characters such as `@` and `:` in the password. |
| A TLS error that adds `This connection goes through the proxy at … (HTTPS_PROXY). A proxy that inspects TLS presents a certificate of its own, and the agent doesn't accept it` | Ask the proxy's administrator to let this server through uninspected, or add it to `NO_PROXY`. Never trust the proxy's certificate in place of the server's. |

Where the agent runs as a systemd service, set the variable with `sudo systemctl edit vectory.service`, adding `Environment=HTTPS_PROXY=…` under `[Service]`, then restart it.

## A pipeline is rejected or rolled back

Open the device and read its issue: it names the stage and the reason.

| Issue code | What happened | Fix |
| --- | --- | --- |
| `VALIDATION_FAILED` | Vector rejected the configuration on the device, its tests failed, or `vector validate` didn't finish in time (the finding `VECTOR_TIMEOUT`: the version is never treated as valid). | Read the reason, fix the pipeline, publish and deploy again. Check host dependencies: files, credentials, environment. |
| `CAPABILITY_DENIED` | The pipeline needs something the device's mode or allowances don't permit. The device page reads **Apply failed because this host's restricted mode doesn't allow it** (**local policy** on a full-mode device), and the reason names the component and the exact destination, listener or path, for example `Sink "out" (http) sends to 127.0.0.1:9`. Some findings read differently, because no allowance can lift them: an `api` block is never allowed in restricted mode (**Apply failed because restricted mode refuses an api block**, `LOCAL_API_DENIED`), nor is an AWS credentials file (`CREDENTIALS_FILE_DENIED`), AWS credentials the host supplies (`AMBIENT_CREDENTIALS_DENIED`) or a VRL call that passes a file to `parse_groks` or `parse_etld` (`DYNAMIC_CAPABILITY_DENIED`, which says the step reads a file with that function and names its argument), and a component ID that is a path is refused in both modes (**Apply failed because a component ID names a path**, `INVALID_COMPONENT_ID`). The deployment's failure reasons and the issue say the same. | Have the host operator run the command the fix names, with the agent stopped, such as `vectory allow --network 127.0.0.1:9`, or switch the device to full mode. The dashboard can't grant it. For those findings: remove the `api` block, the credentials file or the file argument of the VRL call, give an AWS sink explicit access keys as device secrets, or deploy to a full-mode device, and rename a component whose ID is a path along with the inputs that name it. `vectory status` on the device shows the same problem and fix, and the deploy review writes the commands for each host. |
| `SECRET_RESOLUTION_FAILED` | A `vectory-secret:` reference has no binding, its file can't be read or its value was refused, or it sits in a field that can't hold a secret. The diagnostic names the step, the field and the secret. | Bind the name, or fix the secret file's permissions, then start the agent: its next check-in applies the version. The device page's **Device secrets** card shows which names are bound. See [Keep credentials on the device](resources.md#keep-credentials-on-the-device). |
| `APPLY_ROLLED_BACK` | Vector didn't start or stay up with the new version, so the agent restored the last working configuration. | Check host resources, ports and destinations, then retry or deploy a fix. |
| `ACTIVATION_FAILED`, `PROCESS_EXITED`, `PROCESS_STOPPED` | Vector didn't start, or stopped. | Check the service and host resources, then restart the agent. |
| `WRITE_FAILED`, `PATH_UNSAFE` | The agent couldn't write its files safely. A full disk is named (the finding `DISK_FULL`): nothing was half written, and the running configuration is untouched. | Check disk space, ownership and permissions, and remove symlinks from the paths. After a full disk, free space and wait: the next check-in applies the same version. |
| `INCOMPATIBLE` | The version was built for a different Vector minor version than the device runs. Patch releases of the same minor (0.58.0, 0.58.1) are interchangeable, so a patch difference never causes this. `vectory status` names both versions. | Install Vector 0.58.x and [approve it](agents.md#replace-the-vector-binary). |
| `ADOPTION_REQUIRED` | The agent hasn't adopted a Vector binary yet. | Run `vectory install ... --adopt` on the device. |
| `DOWNLOAD_FAILED`, `DIGEST_MISMATCH` | The device couldn't fetch the version, the download was cut off or too large, or the bytes didn't match the signed size and digest. Nothing was applied and the partial file was removed. | Check connectivity; the agent retries on its own at its next check-in. The finding says which case it was. |
| `ROLLBACK_UNAVAILABLE` | The device's first version didn't start, so there was nothing earlier to go back to. Vector is stopped and nothing runs; the device page reads **Nothing running: Vector stopped after v1 failed to start.** | Fix the problem the issue names, such as a listener on port 514, then deploy a corrected version or choose **Retry application**. Nothing on the host needs recovering. |
| `ROLLBACK_FAILED`, `RECOVERY_INVALID` | The new version failed and the last working configuration couldn't be restored. | Needs someone on the host. Keep the state directory intact and deploy a version that works. |
| `MANIFEST_EXPIRED` | The approval expired before the switch. | Nothing: the agent waits for its next check-in. |

The issue, the device page and `sudo vectory status --json` (under `configuration_attempt.error.diagnostics`) show Vector's own message, with secret values removed. For the most common findings, the agent adds a fix:

| Finding | Fix the product prints |
| --- | --- |
| `DATA_DIR_MISSING` | Remove data_dir from the pipeline to use the device's own data directory, or create this directory on the device. See [Vector says the data directory doesn't exist](#vector-says-the-data-directory-doesnt-exist). |
| `DATA_DIR_NOT_WRITABLE` | Give the Vector service account write access, or remove data_dir from the pipeline to use the device's own data directory. |
| `ADDRESS_IN_USE` | Stop the other process, or change this component's address. |
| `PRIVILEGED_PORT` | Use a port from 1024 up, such as 1514, and point senders there. Or allow it: sudo systemctl edit vectory.service, add [Service] AmbientCapabilities=CAP_NET_BIND_SERVICE, then restart. See [A listener on a port below 1024 doesn't start](#a-listener-on-a-port-below-1024-doesnt-start). |
| `PERMISSION_DENIED` | Give the Vector service account access to the path, or change the path. |
| `FILE_NOT_FOUND` | Check that the path exists on the device. |
| `ENV_VAR_MISSING` | Set it in the Vector service's environment on the device, or remove the reference from the pipeline. |
| `LOCAL_API_DENIED` | Remove the api block, or deploy to a full-mode device. Vector's local API has no authentication, so no host allowance can permit it. See [Restricted and full mode](security.md#restricted-and-full-mode). |
| `CREDENTIALS_FILE_DENIED` | A sink sets `credentials_file` under `auth`, and a credentials file can name a program that Vector runs, so restricted mode refuses it. Remove it and give the sink its access keys as device secrets, or deploy to a full-mode device. See [Restricted and full mode](security.md#restricted-and-full-mode). |
| `AMBIENT_CREDENTIALS_DENIED` | A sink uses `auth.strategy: aws` without explicit keys, so it would sign with this host's own AWS identity. Give it `access_key_id` and `secret_access_key` as device secrets, with no `assume_role`, `imds` or `profile`, or deploy to a full-mode device. The message names where the keys go: `auth` for `elasticsearch`, `auth.auth` for `http`, `loki` and `prometheus_exporter`. |
| `INVALID_COMPONENT_ID` | Rename the component and the inputs that name it. An ID can't contain a slash, a backslash or a control character, or start with a drive letter and a colon (like `C:`), because Vector uses it as a directory name in its data directory. Devices in both modes refuse it. |
| `DISK_FULL` | Free some space on that disk. The agent applies this version at its next check-in; there is nothing else to do. |
| `DOWNLOAD_INTERRUPTED` | Nothing was applied. The agent tries again at its next check-in. If it keeps happening, look for a proxy or firewall that cuts long responses. |
| `DOWNLOAD_TOO_LARGE` | Nothing was applied. Publish a smaller version. |
| `ARTIFACT_MISMATCH` | Nothing was applied. The agent tries again at its next check-in. If it keeps failing, something between the server and this device may be altering downloads. |
| `VECTOR_TIMEOUT` | Vector kept running the previous configuration. A destination whose health check never answers is the usual cause: check them from this device, then choose Retry application. |

The device page's **Recent Vector errors** shows what Vector logged since it last started or reloaded a configuration, so errors of a version it no longer runs don't appear there.

A device doesn't retry a failed version by itself, so a bad version can't restart Vector in a loop. After fixing the cause, use **Retry application** on the device, deploy a corrected version, or run `vectory retry` on the host (while the agent runs, the retry is queued and taken within seconds). Never delete state, edit counters or re-enroll to force a retry.

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

## A pipeline can't write a file: read-only file system

A file sink, a disk buffer or a `data_dir` in a read-only part of the file system fails. Vector logs it, and `sudo vectory logs` shows it:

```text
Unable to open the file. path=/srv/logs/out-2026-10-02.log error=Read-only file system (os error 30)
```

Which parts are read-only depends on the unit that runs the agent:

| Unit | Read-only to the agent and Vector |
| --- | --- |
| Registered by `vectory setup` or `vectory service-install` | `/usr`, `/boot`, `/etc` and home directories, except the state and managed configuration directories. |
| Packaged (`/usr/lib/systemd/system/vectory.service`) | The whole file system, and home directories are hidden, except `/var/lib/vectory-agent`, `/etc/vectory/managed` and `/var/lib/vector`. |

Add the folder to the service. Run `sudo systemctl edit vectory.service`, add the lines below, then `sudo systemctl restart vectory.service`. This applies to full mode and to a restricted-mode file root from `vectory allow --file-root`. See [What the systemd service can write](installation.md#what-the-systemd-service-can-write).

```ini
[Service]
ReadWritePaths=/srv/logs
```

## Validation says deferred or unavailable

- **Deferred:** part of the check needs the device, such as a local file, a device secret, an environment variable or a provider. The device runs that check before applying. Deferred is not a pass.
- **Unavailable:** the server got no usable answer from its validator, so publishing is blocked until it's back. It never skips the check. An administrator can read the cause in the server log: `docker compose logs server | grep "isolated validator"` prints a warning with a `reason`, such as `the server could not connect to it`, `it did not answer within 8 seconds`, `it answered HTTP 503` or `it speaks another protocol, or runs another Vector, than this server expects`. Then check the `validator` container.
- **Structural only:** you're on a development preview without a validator. Production servers can't run that way.

## A credential is refused when you save or publish

Credentials stay on the devices, so a credential field holds a secret name, never the value. The message names the step and the field:

| Message | Fix |
| --- | --- |
| Plaintext credentials cannot be stored in the field | Replace the value with a device secret name, then bind it on each device with `vectory configure-secrets`. |
| Only credential fields can hold a device secret | Move the reference out of the URL, header, path or program, into the step's credential field, such as `auth.token`. |
| The field must be exactly `vectory-secret:NAME` | Remove any text around the reference, and start the name with a letter. |

See [Keep credentials on the device](resources.md#keep-credentials-on-the-device).

## A device check fails or doesn't answer

[**Check on devices**](deployments.md#check-on-devices) asks each target device to check a version on its own host. A check never changes the device, so nothing needs undoing. Each row says one of these things:

| Row says | What happened | Fix |
| --- | --- | --- |
| **Needs a secret**: Secret `API_KEY` isn't bound on this device (finding `SECRET_BINDING_MISSING`) | The version names a device secret, and this host has no file bound to it. | Run the commands on the row on that host, with the agent stopped (**Copy** takes them), then check again. See [Keep credentials on the device](resources.md#keep-credentials-on-the-device). |
| **Needs a fix** with `SECRET_FILE_UNREADABLE` | The secret is bound, but its file is missing, empty or readable by other accounts. | Run `vectory configure-secrets` on the host. It prints the exact fix. |
| **Needs a fix** with `CAPABILITY_DENIED` | The host's restricted mode doesn't allow a destination, listener or path the version uses. | Have the host operator run the `vectory allow` command the finding names, or [switch the host to full mode](agents.md#switch-between-restricted-and-full-mode). |
| **Needs a fix** with `VECTOR_TIMEOUT` | Vector didn't finish validating, so the version isn't treated as valid. | A destination whose health check never answers is the usual cause. Check them from this device, then check again. |
| **Needs a fix** with another Vector finding | Vector rejected the configuration on this host, or a test failed. | Read the first finding on the row: it names the step and the field, and often the fix. The [findings above](#a-pipeline-is-rejected-or-rolled-back) explain the common ones. |
| **Needs a fix** with `ADOPTION_REQUIRED` | The agent hasn't adopted a Vector binary, so it can't check. | Run `vectory setup`, or `vectory install ... --adopt`, on the host. |
| **Needs a fix** with `DISK_FULL` or `CHECK_UNAVAILABLE` | The agent couldn't stage the version on this host. | Free space on the disk the finding names, or run `vectory doctor` on the host, then check again. |
| **Needs a fix** with `DOWNLOAD_INTERRUPTED`, `DOWNLOAD_TOO_LARGE` or `ARTIFACT_MISMATCH` | The device couldn't fetch the version, or what it got wasn't what was signed. | Check connectivity, then check again. A version above the agent's size limit needs a smaller one. |
| **Needs a fix** with `CHECK_EXPIRED` | The server stopped offering the version to this device: the check ran out, or a newer check for this device replaced it. | Check again. Only the newest check for a device counts. |
| **Offline: not checked** | The device hasn't checked in for three of its own intervals, so it wasn't asked. | Start its agent or restore its network, then choose **Retry**. See [A device is offline or never connects](#a-device-is-offline-or-never-connects). |
| **No answer in time** | It didn't answer within 10 minutes (its agent stopped, it can't reach the server, or an apply on it ran long), or a newer check for the same device replaced this one. | Check that its agent runs and checks in, then choose **Retry**. |
| **Older agent: can't check** | The agent never announced that it can check versions. | Choose **Upgrade agent** on its device page, then **Retry**. See [Upgrade the agent](agents.md#upgrade-the-agent). |
| **These results are for the previous selection** | You changed the devices or their values after the check. | Choose **Check on devices** again. |
| **Checks are limited to a few a minute. Try again in 40 s.** | Six checks a minute are allowed for each person. | Wait for the time the button names. |
| **Too many checks are waiting for devices to answer.** | The server holds candidates for devices that haven't answered yet, up to a limit. | Try again in a few minutes. |
| **These results are no longer available.** | Vectory keeps results for 24 hours, and only the person who asked, or an administrator, can read them. | Choose **Check on devices** again. |
| **Your role can't run a check.** | Checks need the Operator or Administrator role. | Ask an operator or administrator. |
| **Vectory didn't answer, so the check may not have started.** | The request or its answer was lost on the way. | Try again. A newer check for a device replaces an older one. |

A check passing is the device's own report that validation found no error. It isn't evidence that the version is applied or healthy: only **Applied** says that.

## A deployment is pending, paused or conflicting

| Status | Check |
| --- | --- |
| Offline target | The device needs to reconnect before it can apply anything. |
| Applies on its next check-in | Its agent isn't waiting for changes: an older agent, wake-ups turned off on the host (`--no-wake`) or on the server (`VECTORY_AGENT_WAKE_LIMIT=0`), or a network that cuts idle connections. It still applies at its next check-in. |
| Scheduled | The start time, and whether the schedule was missed. |
| Canary waiting | **Canary gate** names what it is waiting for, for example "Waiting for edge-nyc-02 to apply" or "Measuring delivery on edge-nyc-02 (2 of 3 samples)". Each canary device must report **Applied** with a fresh check-in for the whole observation period. If the canary has applied and is delivering, **Release next stage now** goes ahead without waiting. |
| Held on previous version | The newest version failed on this device, but it still runs its previous version and delivers on it. Fix the pipeline and deploy again, or roll the rollout back. The device page has the failure. |
| Sync paused | Whether the pause was set on the rollout, in agent settings or on the host (`vectory resume` clears only a host pause). |
| Not sure what the device runs | The device page's **Effective configuration** says whether the file its agent reports is what Vectory offered and, when it isn't, which earlier offer it is. See [Read what a device was offered](deployments.md#read-what-a-device-was-offered). |
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

A canary rollout checks this before it releases more devices. While Vectory takes its first measurements the gate reads **Measuring delivery on** the device, with how many samples it has; a canary that isn't delivering counts as a failure against the rollout's failure threshold, and the rollout page shows why. A device without metrics is judged on its apply state alone.

These checks need metrics: see [Enable real metrics](telemetry.md#enable-real-metrics). Without them the device page reads **Delivery health: not measured**, and only a sink that fails requests shows up, from Vector's own log: the same sink issue opens after two check-ins, its message ending "measured from Vector's log (no metrics)". On the host, `sudo vectory status` shows the failing sink under **Vector** and what to check next. A filter or route that drops events on purpose never counts as a delivery problem.

## The adopted Vector binary changed

The agent refuses to run a Vector binary whose SHA-256 changed since adoption. If you replaced Vector on purpose, [approve the new binary](agents.md#replace-the-vector-binary). If you didn't, find out why before doing anything else, and restore a trusted binary.

## A command on the device is refused

Stop the agent before changing local settings. A command that needs it stopped names what holds the state directory and how to stop it:

| Message | Fix |
| --- | --- |
| `The agent service is running (vectory.service, pid 812), and this command needs the agent stopped.` | `sudo vectory service-stop`, run the command again, then `sudo vectory service-start`. |
| `The agent is running (vectory run, pid 812), and this command needs it stopped.` | Stop it with Ctrl-C where it runs (or `sudo kill 812`), run the command again, then start the agent again. |
| `Another vectory command is using /var/lib/vectory-agent (vectory install, pid 812).` | Wait for it to finish, then run the command again. |
| `There is no Vectory service to stop` | The host has no systemd, so the agent runs as `vectory run`: stop it with Ctrl-C where it runs. `vectory status` shows its pid. |

`pause`, `resume` and `retry` work while the agent runs. Don't delete `agent.lock` or start a second agent. A command that rejects its input changes nothing, so fix the input and run it again.

### A local settings update is refused

- **Can't preserve access:** the command couldn't keep the existing owner or permissions. Keep the files and ask the host administrator to check the service account's access. Don't make files world-readable to get past it.
- **Settings saved but retry state not updated:** the new settings are in effect. Check `vectory status`, fix the reported write problem, and run `vectory retry` only if you want another attempt.

### A capability-policy file is rejected

The file must be one JSON object, saved as UTF-8 without a byte-order mark, with the three lists `allowed_file_roots`, `allowed_network_hosts` and `allowed_listen_addresses` and nothing else. Use absolute file roots, exact `host:port` pairs, unique names and no comments. On Windows, double each backslash. The file is refused, not repaired, if its encoding is broken. See the [allowance format](installation.md#configure-restricted-allowances).

### A file root is refused

`vectory allow`, `install --capability-policy` and `setup` refuse a file root that would give pipelines the agent's own files, and change nothing. The message names the root and what it overlaps, for example `File root /var/lib contains the agent's state directory, /var/lib/vectory-agent.`

A root can't be:

- `/`, the root of a drive (`C:\`) or the root of a network share (`\\server\share`);
- the agent's state directory, the managed configuration directory, or a directory that holds or lies inside either;
- a file bound to a device secret, or a directory that holds it.

Allow the directory that holds the files your pipelines need instead, such as `/var/log/app`. If a secret file is in the way, move it out of the directory you want to allow, then bind it again with `vectory configure-secrets`. A root allowed before this check existed stays until you replace the lists with `install --capability-policy`, which checks every root in the file.

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
- **Code rejected:** check that your phone's clock is right, or choose **Use a recovery code**. If the code step expires, start again with your email and password.
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
