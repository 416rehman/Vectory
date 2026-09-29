# Manage agents

Check, change, upgrade, recover and remove the Vectory agent on a device. These are host tasks: run the commands on the device, as an administrator of that host.

Commands that change local settings need the agent stopped. Stopping the agent also stops the Vector process it manages, so plan a short maintenance window. Every procedure below keeps the device's identity, its generation counters and any pause you set.

## Check an agent

```sh
sudo vectory status           # identity, server, last check-in, pipeline and next step
sudo vectory doctor           # local setup and server connection, with a fix for each problem
sudo vectory logs --follow    # Vector's own log (never your events)
```

Add `--json` to `status` or `doctor` for scripts. Both only read: they never change settings, retry state or counters.

The dashboard shows the same device from the server's side. A recent check-in proves the agent is connected. **Applied** proves which version Vector runs.

## Change local settings

Local settings belong to the host: allowances, mode, the metrics endpoint, secret bindings and wake-ups. The dashboard can't change them.

<!-- steps -->
1. Stop the agent through its service: `sudo vectory service-stop`.
2. Run the command for the setting you're changing (below). Check that it reports success.
3. Start the agent again: `sudo vectory service-start`.
4. Check the result on the device page: a fresh check-in, and the expected mode, metrics or pipeline status.

Options you leave out keep their current values. A command that rejects its input changes nothing.

> [!WARNING]
> **Don't force a settings change**
> If a command reports that another operation is running, wait for that process to exit. Don't delete `agent.lock`, loosen file permissions, re-enroll or delete state to push a change through.

### Update restricted allowances

Edit the protected allowance file, then pass it to `install`:

```sh
sudo vectory install --capability-policy /etc/vectory/allowances.json
```

The file replaces all three lists, so keep every entry the device still needs. `{}` removes them all. The format is in [Configure restricted allowances](installation.md#configure-restricted-allowances).

Before you remove an allowance, deploy a pipeline that no longer needs it. At startup, the agent refuses a configuration whose resources are no longer allowed.

A changed allowance file lets the device try a version it rejected earlier. It doesn't resume a paused device or turn on full mode.

### Switch between restricted and full mode

```sh
sudo vectory install --allow-full-vector-config         # full mode
sudo vectory install --allow-full-vector-config=false   # back to restricted
```

Before you return to restricted mode, deploy a pipeline that fits restricted mode and the device's allowances. Otherwise the current configuration can fail the local check at startup. No re-enrollment is needed either way.

### Set the metrics endpoint or secret bindings

- Metrics: [Enable real metrics](telemetry.md#enable-real-metrics) uses `vectory configure-metrics`.
- Secrets: [Keep credentials on the device](resources.md#keep-credentials-on-the-device) uses `vectory configure-secrets`.

### Turn off wake-ups

Between check-ins, the agent keeps one request open to the server, so a deployment reaches the device within seconds. The agent opens it like every other connection; nothing on the device listens. On a network that cuts idle connections, the agent quietly falls back to its schedule. To keep a device on its schedule only, turn wake-ups off:

```sh
sudo vectory install --no-wake         # check in on schedule only
sudo vectory install --no-wake=false   # wake-ups back on
```

`vectory setup --no-wake` saves the same setting. While a deployment waits for a device, the dashboard says **connected, usually a few seconds** only when that device's agent holds the request; otherwise it says the version applies at the next check-in.

## Pause configuration sync

Pause the agent before you edit its managed configuration by hand. Pausing works while the agent runs. Vector keeps running; the agent stops applying new versions until you resume.

```sh
sudo vectory pause
sudo vectory resume
```

A local pause belongs to the host: the dashboard can't clear it. Resuming clears only the local pause; a pause set in agent settings from the dashboard still applies. Once sync resumes, the agent replaces manual edits with the assigned version.

## Retry a rejected version

The agent doesn't retry a version that failed, so a broken version can't restart Vector in a loop. After you fix the cause on the host, allow one more attempt:

```sh
sudo vectory service-stop
sudo vectory retry
sudo vectory service-start
```

From the dashboard, **Retry application** on the device does the same for the version it shows. Deploying a corrected version also works.

## Upgrade the agent

An agent upgrade replaces one file. It doesn't change Vector, the device's mode or its identity.

On Linux and macOS, the quickest upgrade is to run the command from **Add device** again on the device. The installer replaces the agent, and setup restarts the service on the new build and waits for its first check-in. It prints, for example, `vectory.service upgraded 0.1.0 → 0.2.0 · first check-in 1.2 s after restart`. To upgrade by hand instead:

<!-- steps -->
1. On the device page, choose **Upgrade agent** and download the agent for the device's OS and CPU. Check its SHA-256 against the value shown.
2. Stop the agent: `sudo vectory service-stop`.
3. Back up the state directory, the managed configuration and the current agent binary. The state holds the device's private key, so keep the backup private.
4. Replace the binary at the same path, keeping its owner and permissions: `sudo install -m 0755 vectory /usr/local/bin/vectory`.
5. Start the agent and check it: `sudo vectory service-start`, then `sudo vectory --version` and `sudo vectory status`.

On the device page, confirm the same device identity, a fresh check-in and the expected pipeline.

> [!CAUTION]
> Don't re-enroll, purge state or reset counters as part of an upgrade. To go back, restore the previous binary. Restoring an older state backup can roll back security counters, so treat it as a last resort.

## Replace the Vector binary

The agent pins the SHA-256 of the Vector binary it adopted and refuses a changed binary. After you upgrade or move Vector on purpose, approve the new binary:

<!-- steps -->
1. Get the new Vector 0.58.x binary from a trusted source and note the SHA-256 of the executable itself (not of its archive): `sha256sum /usr/bin/vector`.
2. Stop the agent: `sudo vectory service-stop`.
3. Approve it:

   ```sh
   sudo vectory re-adopt --expected-sha256 THE_SHA256
   ```

   If Vector moved, add `--vector-binary NEW_PATH`.
4. Start the agent: `sudo vectory service-start`.

`re-adopt` checks the SHA-256 before running the binary, then validates the current configuration with it. It changes only the approved binary. If validation fails, fix the reported problem or put the previous binary back.

If you didn't replace Vector yourself, don't approve the change. Find out why the file changed first.

## Recover a device identity

Use recovery when a device's credentials are lost or can no longer renew. It creates a new device identity; the old one is revoked. An offline device or a failed pipeline doesn't need recovery: see [A device is offline](troubleshooting.md#a-device-is-offline-or-never-connects) first.

<!-- steps -->
1. **In the dashboard** (Administrator): open the device, expand **Device recovery** and choose **Authorize device recovery**. The one-time token expires in one hour. Creating it doesn't disconnect the device.
2. Save the token: **Copy token** or **Download token file**.
3. **On the device:** stop the agent, run recovery with the existing state directory, and paste the token when asked:

   ```sh
   sudo vectory service-stop
   sudo vectory recover-enrollment
   sudo vectory service-start
   ```

4. **In the dashboard:** find the new device identity, add it back to its groups and deploy its pipeline. Recovery keeps the files on the host but not groups or assignments.

Delete any downloaded token file afterwards. If creating the token was interrupted, see [If a request is interrupted](interrupted-requests.md).

## Remove the agent

<!-- steps -->
1. Stop and unregister the service:

   ```sh
   sudo vectory service-stop
   sudo vectory service-uninstall
   ```

2. In the dashboard, open the device and choose **Revoke device identity…** under **Device access**. The host can't revoke its own identity offline.
3. Delete the agent's state, including its private key:

   ```sh
   sudo vectory uninstall --purge --state-dir /var/lib/vectory-agent
   ```

`--purge` needs the exact state directory. It leaves Vector and the managed configuration in place; delete them yourself if you no longer need them. If the purge is interrupted, run the same command again.

To keep the agent but drop its identity, run `sudo vectory unenroll` instead. It deletes the local credentials; still revoke the device in the dashboard.
