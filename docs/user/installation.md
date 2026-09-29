# Install an agent

An agent manages one explicitly adopted Vector 0.58.0 process and one JSON configuration on a device. Vector must already be installed. Start in [**Devices → Add device**](/#/enrollment) and copy the instructions for your OS; the commands below use example paths and server names.

## Prepare the host

Check the agent download's checksum through a trusted release channel. Development builds are unsigned. Review the download's native evidence; a cross-compiled binary is not proof of tested operation on that OS. Install Vector 0.58.0 and locate its absolute executable path.

In the wizard's **Install** step, choose the **Starting workload** and review the **Managed configuration file** path. This is the sole JSON document the agent will start. Installation does not discover the old service's arguments, copy its configuration or stop its supervisor.

Create separate dedicated locations for agent state, managed configuration and Vector data. Grant the intended agent identity the required access.

The managed configuration's directory becomes private. Do not use a directory containing unrelated configurations or secrets. State and managed paths must be absolute and have no symlink ancestors. On macOS, use concrete paths such as `/Library/Application Support/Vectory`; `/var` commonly resolves through a symlink.

Set your pipeline's `data_dir` to an existing writable device directory. On Windows, Vector's default `/var/lib/vector` normally does not exist. The browser does not create the directory for you.

### Keep an existing workload

Prepare the replacement configuration **while the old Vector instance is still running**:

1. Inventory its startup arguments, configuration files, configuration-directory contents and service settings. Back up that complete configuration and service definition outside the new managed directory.
2. Copy or combine the intended configuration into the wizard's managed JSON file. Convert YAML or TOML to JSON if needed; do not merely rename a file. Preserve all sources, transforms, destinations and global settings from the files the old instance used. The default managed path is a new location, not an automatically discovered copy of the old workload.
3. Check the selected [configuration mode](#/docs/installation#choose-configuration-capabilities), local permissions and dependencies. Preserve the intended `data_dir`; provision credentials, environment values, external VRL files and enrichment data under the account that will run the agent. Relative paths and old service-specific environment settings need particular review. In restricted mode, approve the required [local allowances](#/docs/installation#configure-restricted-allowances) before handing over.
4. Only when the managed file and dependencies are ready, stop and disable the old supervisor for this Vector instance. Then run the wizard's install, enroll and run commands under the intended account.

`install --adopt` records ownership and backs up the selected managed file if it exists. That backup does not include other old configuration files or the service definition. `run` checks local capability policy, validates the managed file with Vector and starts the owned process. If the file is missing, no Vector process starts; if startup fails, inspect the local error and correct the prepared configuration before continuing.

Confirm the existing workload's outputs after the handover. The device can run this adopted local configuration while its dashboard state is **Unmanaged**: no published version has been assigned yet. Enrollment alone is not a deployment.

### Start without a workload

Choose **Start without a workload** if this device should wait for its first pipeline. Keep Vector installed and select a new managed path that does not contain an existing configuration. The file may be absent; do not create an empty placeholder configuration.

Install, enroll and keep the agent running. With no managed file, it checks in without starting a Vector process. Once you explicitly [deploy a published version](#/docs/deployments#deploy-a-published-version), the agent can download, validate and activate that configuration. No pipeline or group is assigned automatically.

If the selected file already exists, `run` attempts to validate and start it. The wizard's choice changes the instructions, not agent behavior. Use **Keep an existing Vector workload** when you need to preserve one.

## Choose configuration capabilities

| Mode                          | Choose it when                                                                      | Local responsibility                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Restricted** — default      | Publishers should use the reviewed subset of components and resources.              | Approve file roots, exact destination host:port pairs and listener addresses.                       |
| **Full Vector configuration** | You need native providers, enrichment, external VRL files or other Vector features. | Explicitly trust publishers with Vector's process capabilities and provision its host dependencies. |

Full mode supports features available in the adopted Vector build. It cannot add a missing platform component, executable, credential, file or external service. It also enables native environment interpolation. Restricted allowances do not constrain full mode.

The dashboard displays the device's reported mode and checks it when planning deployment. It cannot enable full mode remotely. For field-specific dependencies, read the [resource guide](#/docs/resources#choose-the-right-reference).

## Install and enroll

### Save the enrollment token

After **Create enrollment token**, keep a private copy and choose **I've saved the token**. Closing that dialog keeps **Show token** available on the current page. Navigation asks you to save or deliberately **Discard token copy** first. Discarding, reloading or signing out removes that copy; the server cannot show the secret again. Discarding the copy leaves the request reminder and does not revoke the token.

If the response is interrupted, the wizard keeps a **Token requests** reminder for this account in this browser. Choose **Check request** to see the exact outcome. A token may have been created even when the browser timed out. Cancel the request before creating a replacement: cancellation revokes any token it created and prevents a late request from creating one. Existing devices stay connected. Only after **Request cancelled** is confirmed should you choose **Continue setup** and create another token.

These recovery controls require a server and dashboard that support token request correlation. The wizard does not send an untracked request to an older server. The reminder contains setup metadata, never the token secret. Do not clear browser storage to resolve an uncertain request; use its check and cancellation actions. See [interrupted token requests](#/docs/troubleshooting#a-token-request-is-interrupted) for failed cancellation or revocation.

### Run enrollment commands

Run installation and ordinary foreground operation under the intended account. Service registration may require separate administrative privileges and account permissions.

Linux example with full mode explicitly enabled:

```sh
vectory install --state-dir /var/lib/vectory-agent --vector-binary /usr/bin/vector --managed-config /etc/vectory-managed/vector.json --adopt --allow-full-vector-config
vectory enroll --state-dir /var/lib/vectory-agent --server https://vectory.example.com:8443 --ca-file /protected/server-ca.pem --id edge-01 --token-file /protected/enrollment-token.txt
vectory doctor --state-dir /var/lib/vectory-agent
vectory run --state-dir /var/lib/vectory-agent
```

Use the agent endpoint shown by **Add device**, which may differ from the dashboard address. Save the enrollment token in a private file at the path named by the command. The file must be regular, local and single-link. On Linux/macOS, its owner must be the enrolling account or root, with no group or other permissions (for example, mode `0600`). On Windows, its owner must be the enrolling account, SYSTEM or Administrators, and its access list must grant access only to those principals; alternate data streams are not accepted. A browser download may have broader access, so move it to a protected location and set its permissions before using `--token-file`. Alternatively, omit the token option for hidden interactive entry, or use `--token-stdin`. Avoid tokens in command history or service definitions.

Windows uses the same flags:

```powershell
vectory install --state-dir C:\ProgramData\Vectory --vector-binary 'C:\Program Files\Vector\bin\vector.exe' --managed-config C:\ProgramData\VectoryConfig\managed.json --adopt --allow-full-vector-config
vectory enroll --state-dir C:\ProgramData\Vectory --server https://vectory.example.com:8443 --ca-file C:\secure\server-ca.pem --id edge-01 --token-file C:\secure\enrollment-token.txt
vectory doctor --state-dir C:\ProgramData\Vectory
vectory run --state-dir C:\ProgramData\Vectory
```

Use `--ca-file PATH` when the device needs additional trust for the server certificate. The wizard explains both choices under **Server certificate trust** and puts that choice explicitly in the command.

### Trust the server certificate

The agent checks the server's HTTPS certificate before sending its enrollment token. A **certificate authority (CA)** is the issuer trusted to identify that server. The certificate is public; its private key must stay with the issuer.

- **Use system trust** when the device's operating system already trusts the agent listener's certificate, whether through a public CA or your organization's installed certificates. No extra file is needed; the generated command uses `--ca-file=` to explicitly select system trust.
- **Provide a certificate file** when the device needs a private CA certificate it does not already trust. The file adds trust for agent connections without changing the operating system's trust store.

If you manage the server yourself:

1. Find the certificate authority that issued the HTTPS certificate for the **agent listener**. This may differ from the certificate used for the dashboard. The server deployment selects the listener certificate through `VECTORY_TLS_CERT`, or `VECTORY_TLS_CERT_FILE` in the supplied Compose setup.
2. Obtain the public root or required CA chain in **PEM format** from that authority. If you used Vectory's development certificate script, use `ca.pem` in the script's output folder; its default is `.local/pki/ca.pem`. A deliberately self-signed listener can use its independently verified public certificate as the trust certificate.
3. Transfer the public certificate to the device through your trusted server access or provisioning tool. Compare its certificate fingerprint with the issuer's trusted copy. For example, `openssl x509 -in ca.pem -noout -fingerprint -sha256` displays the first certificate's fingerprint; a hash of the PEM file itself is a different value.
4. Save it at a stable full path the agent's account can read, such as `C:\ProgramData\VectoryTrust\server-ca.pem` on Windows or `/etc/vectory/trust/server-ca.pem` on Linux. These are example locations you create. Enter the **device's path**, not the server's path, in the wizard.

On Windows, use a local drive path rather than a UNC share or mapped network drive. A service account may not have access to a network mount when the agent reconnects.

Keep that file available for future connections and protect it from changes by untrusted users. The wizard does not upload, fetch or validate a certificate just because a path was entered. The separate `device-ca.pem` in server state is for enrolled device identities, not for trusting the HTTPS server. Copy only public certificates, never private key files.

Use the listener's correct hostname and port. A bare IP address must match the certificate's IP identity. Successful access in your browser does not establish trust on a different device; the agent always verifies its own connection.

On agents with enrollment preflight protection, omitting `--ca-file` preserves the saved trust path when retrying enrollment or recovery. Supply `--ca-file PATH` to deliberately repair that path, or the single argument `--ca-file=` to use system trust instead. A local refusal, such as an unreadable certificate or an already-enrolled identity, leaves the existing connection settings unchanged. See [enrollment troubleshooting](#/docs/troubleshooting#an-enrollment-command-fails) before retrying an interrupted request. Older development builds may share the same version label; use the verified artifact from your trusted release channel.

### Configure restricted allowances

A fresh restricted installation starts with no approved file roots, network destinations or listeners. If the workload needs any of them, prepare a protected policy file **on the device before running the install command**. In **Add device**, choose restricted mode and enter the file's device-local path under **Local allowance file**. The wizard adds `--capability-policy PATH` to the generated install command; it does not create, upload or verify the file. Leave the field empty for a new installation only if the workload needs no such allowances. On an existing agent, omitting the file preserves its current allowances. A local operator must approve the contents; the dashboard cannot grant or widen them.

Supply a protected local JSON file through `--capability-policy`. Save it as **UTF-8 without a byte-order mark (BOM)**, with unique property names and no comments or trailing document:

```json
{
  "allowed_file_roots": ["/var/lib/vectory-data", "/var/log/my-service"],
  "allowed_network_hosts": ["logs.example.net:443"],
  "allowed_listen_addresses": ["127.0.0.1:9598"]
}
```

These are example resources to replace with those you approve. Do not allow the agent state directory as a pipeline file root. The policy is a configuration boundary, not a complete OS sandbox; use host permissions and network controls where stronger isolation is needed.

On Windows, escape each backslash inside JSON strings. For example, a device-specific policy file could contain:

```json
{
  "allowed_file_roots": ["C:\\ProgramData\\VectoryData"],
  "allowed_network_hosts": ["logs.example.net:443"],
  "allowed_listen_addresses": ["127.0.0.1:9598"]
}
```

Use absolute file roots and exact `host:port` destinations and listeners. Valid Unicode resource names are supported. The file is an explicit replacement of all three allowance lists, so keep every resource the device still needs. An omitted list, `null` list or empty array supplies no entries for that list; `{}` removes all three. Saving allowances does not create the listed resource directories, grant operating-system permissions or enable full mode. For a rejected file, follow [capability-policy troubleshooting](#/docs/troubleshooting#a-capability-policy-file-is-rejected).

### Update a device's local allowances

When a restricted pipeline needs a new destination, file root or listener, a host operator must approve it locally. Stop the agent, edit the protected policy file, then run:

```sh
vectory install \
  --state-dir /var/lib/vectory-agent \
  --capability-policy /protected/capabilities.json
```

Check that the command succeeded before restarting through the same supervisor. This replaces all three allowance lists; it does not merge them with the previous file. Include every resource the device should still allow. An empty object removes all restricted allowances. Omitting `--capability-policy` preserves the existing lists.

The update retains enrollment, adopted paths, pause state, verified recovery files and generation counters. A changed policy permits another attempt at a previously rejected configuration; success still requires validation and verified activation. It does not resume a paused device. The full/restricted mode stays unchanged unless you separately supply `--allow-full-vector-config`. In full mode, these restricted allowances do not constrain Vector.

Before removing an allowance, prepare a compatible workload: the agent rechecks the existing managed configuration on startup and can refuse to start it when its resources are no longer allowed. The dashboard cannot grant local permissions or provision the referenced files and services.

## Verify the first connection

The **Add device** wizard watches for a new device identity with the name you entered. If you reopen the wizard after enrollment, use **Open existing device** to inspect that device instead of creating another token. A revoked identity needs the recovery flow on its device page. If the initial device check fails, use **Retry** before continuing.

Keep `vectory run` running, then open the device in [**Devices**](/#/devices). Confirm its name, reported mode and recent heartbeat. A newly enrolled device is unmanaged until explicitly assigned a version; enrollment does not join groups or deploy a pipeline.

On the host, inspect:

```sh
vectory status --state-dir /var/lib/vectory-agent --json
vectory doctor --state-dir /var/lib/vectory-agent
```

`status` reports local state. `doctor` checks local adoption/runtime settings, including the Vector binary, managed path and configured metrics. It does not test the server connection or establish credential validity. If the device stays offline, separately check the agent endpoint, certificate trust, clock, network and daemon errors.

After assigning a version, wait for **Applied** and check the reported version. **Downloaded** or **Validated** is not verified activation. See [apply states](#/docs/deployments#read-the-apply-states).

## Keep the agent running

The wizard offers **In this terminal** for setup and testing or **As an OS service** for unattended operation. The terminal command runs only while that terminal stays open. Closing it stops the agent and its supervised Vector process. `run --once` is diagnostic: it stops the owned Vector child when it exits. A control-plane outage does not stop an already running workload.

For an unattended device, install and enroll first, then choose **As an OS service** and copy the platform-specific commands from the wizard. On Linux with an existing unprivileged `vectory` account, for example:

```sh
sudo ./vectory service-install --state-dir '/var/lib/vectory-agent' --service-user 'vectory'
sudo ./vectory service-start
```

Linux's native service command requires systemd; if the host lacks it, run the agent under your existing supervisor. On macOS, the same flags register a launchd service using an existing unprivileged account. On Windows, use an elevated PowerShell and omit `--service-user`; the service uses `NT SERVICE\Vectory`:

```powershell
.\vectory.exe service-install --state-dir 'C:\ProgramData\Vectory'
.\vectory.exe service-start
```

Keep the agent executable at a stable path the service can reach before registration; the service records that path. Provision the service identity's access to Vector, state, managed configuration, data and required credentials. Unix registration updates ownership of the agent state and managed file, so inspect existing permissions and account dependencies first. Use the same supervisor for later restarts. The CLI also provides `service-stop` and `service-uninstall`; they target the fixed Vectory service and do not accept `--state-dir` as a selector. Lifecycle commands accept flags only and reject unexpected positional arguments before changing local state. Use `vectory help` to inspect options.

Service registration is not proof that the service started, that Vector is running or that a configuration applied. Check local service status, a fresh device heartbeat and the reported apply state. If either service command fails, inspect that host's service-manager diagnostics and preserve the current workload instead of assuming enrollment completed deployment.

Service installation, reboot, upgrade and recovery remain platform acceptance checks. Verify them on your actual hosts before relying on unattended operation; native Windows foreground evidence does not establish systemd, launchd or SCM behavior everywhere.

## Update local agent settings

Local settings include the metrics URL, approved secret-file bindings, restricted resource allowances and full/restricted mode. They belong to the host operator; changing a dashboard policy does not grant them.

1. Plan a maintenance window, then stop the agent through its existing supervisor. This also stops its supervised Vector process. A configuration-sync pause alone does not release the agent's operation lock.
2. Use the installed agent's absolute state directory and an account authorized to maintain it. Keep the existing service identity and its access to the state, managed configuration and local resources. Follow the specific procedure for [metrics](#/docs/telemetry#enable-real-metrics), [secret bindings](#/docs/resources#keep-credentials-on-the-device), [restricted allowances](#/docs/installation#update-a-devices-local-allowances) or [configuration mode](#/docs/installation#change-an-existing-devices-mode).
3. Check each command's result before restarting. A successful settings update preserves unrelated settings and existing access permissions. Repeating the same values leaves the settings file unchanged. It does not deploy a pipeline, grant access to a referenced resource or prove that the service can use it. Combined `install` options are validated together before settings are saved: an invalid metrics URL, policy or secret binding rejects the request without applying the other options.
4. Restart through the same supervisor. Check fresh device reports and the affected behavior: successive metrics samples, a successful configuration attempt or the expected mode. Local and remote pause settings remain in effect.

If the agent reports that another operation is running, wait for the existing process to stop; do not delete the lock file. If it cannot preserve access permissions, keep the existing files and have the host administrator check the intended maintenance and service accounts. Do not remove access controls, delete state or re-enroll to force a local settings update. See [local settings troubleshooting](#/docs/troubleshooting#a-local-settings-update-is-refused).

Omit options you want to preserve. A supplied policy file replaces all three allowance lists; it cannot enable full mode. Use `--allow-full-vector-config` or `--allow-full-vector-config=false` to deliberately choose mode. A supplied secret map replaces all bindings, and `{}` removes them all. Policy and binding files must be JSON objects with unique keys. An explicitly empty path or metrics URL is rejected. To deliberately remove the local scrape URL, use `configure-metrics --clear-metrics-url` or `install --clear-metrics-url`; do not combine it with `--metrics-url`. See [changing or removing a metrics endpoint](#/docs/telemetry#change-or-remove-a-metrics-endpoint) for examples and the difference from disabling collection remotely.

This validation behavior requires an agent build containing the combined-options fix. Older development builds can save an earlier option before rejecting a later one; a shared version label alone does not establish which build is installed. Verify the artifact through your trusted release channel. Even with the fix, a later disk or permission failure can leave settings saved while the separate retry-state update fails; the error identifies that outcome.

## Upgrade an existing agent

Open the device in [**Devices**](/#/devices), then choose **Upgrade agent** beneath its reported agent version. The guide offers the release catalog's download for that device's exact OS and architecture. **Available download** does not mean a newer build or a verified upgrade: development builds can reuse the same version label, and the dashboard does not receive the running executable's checksum. Check the artifact identity and release notes through your trusted release channel.

An agent upgrade is a host operation. It does not upgrade Vector, change configuration mode or restore revoked device access. Plan a maintenance window: stopping the agent also stops its supervised Vector workload.

1. Download the intended agent to a separate staging directory. Compare its SHA-256 checksum with a trusted release inventory before executing it. For signed releases, verify the signature with the independently established signing key. Do not replace the live executable yet.
2. Record the existing executable path, absolute state directory, managed configuration path, Vector data directory and service account. Keep the existing service definition and environment. Stop the agent through its current supervisor; wait for both the agent and its owned Vector process to exit.
3. Make a protected, consistent backup of the stopped agent's state, managed configuration, local credentials and Vector data. These files can contain private keys and resolved credentials. Retain the previous executable separately. An older executable is not a guarantee that newer state can be downgraded.
4. Replace only the agent executable at the path already used by the supervisor. Preserve its ownership, execution permissions and service-account access. Keep the state directory, managed configuration, adopted Vector executable and local secret files in place. Do not re-enroll, purge state, reset counters or register a second service.
5. With the new executable, inspect local state and diagnostics under the same account and with the same absolute state path. For example:

   ```sh
   /opt/vectory/vectory status --state-dir /var/lib/vectory-agent --json
   /opt/vectory/vectory doctor --state-dir /var/lib/vectory-agent
   ```

   On Windows, use the existing paths, for example:

   ```powershell
   & 'C:\Program Files\Vectory\vectory.exe' status --state-dir C:\ProgramData\Vectory --json
   & 'C:\Program Files\Vectory\vectory.exe' doctor --state-dir C:\ProgramData\Vectory
   ```

6. Restart through the existing service or continuous `run` command. Confirm the same device identity, a fresh heartbeat, the expected configuration mode and workload, and the reported pipeline generation. `doctor` checks local setup; it does not verify the server connection. Downloading a binary or seeing a version label does not establish activation.

Local and remote pause settings remain in effect. Resume only the pause you intentionally set for maintenance. A previously rejected candidate may remain suppressed after the upgrade; after addressing its cause, use the documented stopped-agent `vectory retry --state-dir PATH` procedure to request a fresh attempt. Do not clear state to force it.

If startup fails, keep the agent stopped and inspect local diagnostics. Follow that release's recovery or downgrade procedure before reverting its executable or data. Restoring an older state backup can roll back security and generation counters; do not do it as a routine upgrade shortcut. Native service, reboot and platform qualification remain separate from foreground upgrade checks.

## Replace the adopted Vector binary

Use this procedure when a host operator deliberately replaces the Vector executable or moves it to a new path. The agent pins the executable's SHA-256 and refuses changed bytes until they are explicitly approved. Repeating `install --adopt` does not approve a replacement. This release still requires **Vector 0.58.0**; replacing the executable does not enable another Vector version.

Confirm that `vectory help` lists `re-adopt`. If it does not, first [upgrade the agent](#/docs/installation#upgrade-an-existing-agent) to a verified package that includes the command. A reused development version label alone does not establish support.

1. Obtain the replacement through your trusted release channel. Verify the package or signature, then establish the exact SHA-256 of the verified **executable**, not its archive. Uppercase and lowercase hexadecimal are accepted. A checksum calculated from an unexplained replacement is not a trust decision.
2. Stop the existing agent supervisor and wait for its owned Vector process to exit. Record the existing paths and service identity, retain the previously approved executable, and make a protected backup of the stopped state and workload. Use the same state directory throughout.
3. Install the verified executable, retaining the service account's access. Run approval under the intended service identity and environment, or with equivalent provisioned resource permissions. An administrator's successful validation does not prove that the service account can run the workload:

   ```sh
   approved_vector_sha256='REPLACE_WITH_TRUSTED_EXECUTABLE_SHA256'
   vectory re-adopt --state-dir /var/lib/vectory-agent --expected-sha256 "$approved_vector_sha256"
   ```

   Windows uses the same command:

   ```powershell
   $approvedVectorSha256 = 'REPLACE_WITH_TRUSTED_EXECUTABLE_SHA256'
   vectory re-adopt --state-dir C:\ProgramData\Vectory --expected-sha256 $approvedVectorSha256
   ```

   The default is the existing Vector path. If you deliberately moved the executable, also pass `--vector-binary` with its new absolute path. Keep the managed configuration path unchanged. Add `--json` to inspect the approved path, digest, version and which existing configurations were validated.

4. Inspect `doctor` and `status`, then restart through the existing supervisor. Confirm fresh device reports and actual workload health. Approval validates the replacement; it does not start Vector or verify event delivery.

The command holds the agent's operation lock, checks the expected digest before executing the candidate, and validates the managed configuration and any last verified configuration with the existing capability policy. Native validation can access host resources or providers, so use the intended environment and resource permissions. A never-started installation with no managed file or recovery configuration can approve the binary, but explicitly reports that no existing workload was validated.

Only the adopted binary path and digest change in settings. Existing identity, credentials, configuration mode, local allowances, secret bindings, managed content, recovery files, generation counters, pause settings and failed-attempt suppression remain intact. Settings ownership and access permissions are preserved. If a prior candidate remains suppressed after its cause is fixed, run the separate stopped-agent `vectory retry --state-dir PATH` command before restarting. Re-adoption does not resume a paused device.

If validation fails, correct the reported host dependency or restore the previously approved executable before restarting. An unfinished apply or identity-recovery journal must complete using the previously approved binary first; preserve that journal. Do not hand-edit the stored digest, delete recovery state, re-enroll or reset counters to bypass a refusal. The command coordinates with agent operations; separately stop package managers or other supervisors that could replace or run the executable during maintenance.

## Change an existing device's mode

Stop the agent and retain its state directory. To enable full mode locally:

```sh
vectory install --state-dir /var/lib/vectory-agent --allow-full-vector-config
```

Restart afterward. Existing adoption paths, identity, generation counters and local pause remain intact; no re-enrollment is needed. Omitting the flag preserves the existing mode. Use `--allow-full-vector-config=false` to return to restricted mode, after preparing a restricted-compatible workload. Otherwise the current full-mode configuration can fail startup policy.

## Local maintenance and recovery

Pause reconciliation before editing the managed file:

```sh
vectory pause --state-dir /var/lib/vectory-agent
```

The running workload continues. Work already committing may finish before the pause is acknowledged. When maintenance is complete:

```sh
vectory resume --state-dir /var/lib/vectory-agent
```

Resume clears only local pause. If remote pause is also set, it still applies. Once authorized sync resumes, local edits may be replaced by the assigned configuration. A dashboard resume cannot clear a host-owned pause.

## Recover a device identity

Use identity recovery when existing credentials cannot be renewed or are lost. A pipeline failure or an offline device alone does not require a replacement identity; first [diagnose the connection](#/docs/troubleshooting#a-device-is-offline-or-never-connects).

1. As an administrator, open the device, expand **Device recovery**, and choose **Authorize device recovery**. Review the machine name and replacement effects before creating a token.
2. Save the one-time token privately. It expires in one hour. **Copy token** and **Download token file** keep the dialog open; **I've saved the token** removes its in-page copy and browser reminder. Closing the dialog keeps **Show token** available on the same page. Reloading, leaving or signing out erases that copy; the server cannot retrieve it.
3. On that device, stop the installed agent and run the following command with the existing state directory. Enter the token at the hidden prompt:

```sh
vectory recover-enrollment --state-dir /var/lib/vectory-agent
```

4. Restart the installed agent. Find the replacement identity in **Devices**, restore its groups and assign its pipeline deliberately. Check a fresh heartbeat and the actual applied configuration. Delete the private token file after recovery finishes.

Creating a token does not disconnect the device. Using it revokes the old identity and creates a new device UUID; local workload files are retained, while groups and pipeline assignments must be restored. Stopping the agent also stops its supervised Vector process, so schedule the recovery accordingly.

If token creation is interrupted before the token reaches the host, use **Check request** on that same device page. It reads the exact authorization request. If the secret is unavailable, cancel the request, wait for **Recovery request cancelled**, then choose **Continue** before creating another token. A timeout or a result saying no token exists yet does not prove that the original request cannot arrive later. See [interrupted recovery authorization](#/docs/troubleshooting#a-device-recovery-request-is-interrupted).

**Discard token copy** clears only the in-page secret and retains its request reminder. It does not revoke the token. Reminders contain no secret and stay scoped to the same account, device and browser profile. The flow requires a server with recovery-request support; an older server receives no new untracked creation request.

If someone already started recovery on the host, inspect that outcome before cancelling or issuing another token. The agent retains the original token identity and pending recovery files. Cancellation can prevent an unfinished recovery from completing; it does not undo a completed replacement or restore the old identity. Do not substitute a new token, delete pending files or reset generation counters to bypass a refusal.

