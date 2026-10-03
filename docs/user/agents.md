# Manage agents

Check, change, upgrade, recover and remove the Vectory agent on a device. These are host tasks: run the commands on the device, as an administrator of that host.

Commands that change local settings need the agent stopped. Stopping the agent also stops the Vector process it manages, so plan a short maintenance window. Every procedure below keeps the device's identity, its generation counters and any pause you set.

## Check an agent

```sh
sudo vectory status           # identity, server, pipeline and version, check-in schedule, next step
sudo vectory doctor           # local setup and server connection, with a fix for each problem
sudo vectory logs --follow    # Vector's own log, and anything your pipelines log()
```

Add `--json` to `status` or `doctor` for scripts. Both only read: they never change settings, retry state or counters.

The dashboard shows the same device from the server's side. A recent check-in proves the agent is connected. **Applied** proves which version Vector runs.

`status` names the pipeline and version number the device runs, when its next check-in is due (`overdue by 2 min` means the agent isn't getting through), and whether it waits for wake-ups. [`vectory status`](cli.md#status) lists every row.

### What Check on devices does on the host

**Check on devices** in a deploy review asks each target device to check the version on its own host. The agent downloads it, fills in the device's [secrets](resources.md#keep-credentials-on-the-device), applies this host's restricted-mode allowances and lets Vector validate it. It runs the version's tests only when you ask. Nothing is applied.

- **Where it works.** In `validation-staging`, a private folder (mode `0700`) inside the state directory, never the managed directory. The agent deletes its copy when the check ends, and at its next start if it was stopped in the middle.
- **What it never touches.** The managed file, the recovery journal, the last good configuration, the generations and the desired version stay as they were. It doesn't start, reload or signal Vector. A data directory it has to create so that Vector can validate is removed again.
- **When it waits.** An apply that is under way goes first, and the check follows at the next check-in. A paused or drifted agent still checks. A check expires ten minutes after it was asked for, and an expired one is ignored.
- **What leaves the host.** The result: whether the version passes, up to 20 findings in the words a failed apply uses, each test's name and whether it passed, and the names of device secrets this host hasn't bound. Never a secret's value or file, Vector's raw output or your events.

A check is advisory. It doesn't change what the dashboard lets you deploy.

### Compare the managed file with what was offered

The device page's **Effective configuration** shows the text Vectory offered and the digest the agent last reported for its managed file. To check the file on the host yourself, print its digest two ways:

```sh
sudo vectory status --json     # "actual_sha256" is the digest of the managed file
sha256sum /etc/vectory/managed/vector.json
```

Both print the same SHA-256. On macOS use `shasum -a 256`; on Windows, `Get-FileHash`. When the file is the offered text, the digest equals **Offered** under **Digests**. `"drift": true` in the status output means the file no longer matches the last configuration the agent verified.

A pipeline that reads [device secrets](resources.md#keep-credentials-on-the-device) is written with the host's own values, so its digest never equals the offered one. [How Vectory compares them](deployments.md#how-vectory-compares-them) says what the device page checks instead.

## Change local settings

Local settings belong to the host: allowances, mode, the metrics endpoint, secret bindings and wake-ups. The dashboard can't change them.

<!-- steps -->
1. Stop the agent through its service: `sudo vectory service-stop`.
2. Run the command for the setting you're changing (below). Check that it reports success.
3. Start the agent again: `sudo vectory service-start`.
4. Check the result on the device page: a fresh check-in, and the expected mode, metrics or pipeline status.

Options you leave out keep their current values. A command that rejects its input changes nothing.

If the agent is running, a command that needs it stopped says so and names it: for example, `The agent service is running (vectory.service, pid 812), and this command needs the agent stopped.` It also says how to stop it: `service-stop` for the service, or Ctrl-C where `vectory run` runs.

> [!WARNING]
> **Don't force a settings change**
> If a command reports that another operation is running, wait for that process to exit. Don't delete `agent.lock`, loosen file permissions, re-enroll or delete state to push a change through.

### Update restricted allowances

To let restricted pipelines reach a destination, open a listener or use files under a directory, add it with `vectory allow`. It keeps everything the host already allows:

```sh
sudo vectory allow --network logs.example.net:443
sudo vectory allow --listener 0.0.0.0:514 --file-root /var/log/nginx
```

Each flag can be repeated. `allow` refuses a file root that would give pipelines the agent's own files, such as `/` or a directory that holds the state directory, and changes nothing: see [A file root is refused](troubleshooting.md#a-file-root-is-refused). Otherwise it prints what it added and everything the host allows now, and notes the change in `vectory logs`. When a restricted device refuses a version, its fix on the device page and in `vectory status` gives the exact `vectory allow` command, and the deploy review writes one for each host.

To replace the lists instead (for example, to remove an entry), edit the protected allowance file and pass it to `install`:

```sh
sudo vectory install --capability-policy /etc/vectory/allowances.json
```

The file replaces all three lists, so keep every entry the device still needs. `{}` removes them all. `install` prints what the host allows afterwards. The format is in [Configure restricted allowances](installation.md#configure-restricted-allowances).

Before you remove an allowance, deploy a pipeline that no longer needs it. At startup, the agent refuses a configuration whose resources are no longer allowed.

No allowance covers Vector's `api` block, which has no authentication. A restricted device refuses a pipeline that sets it, and at startup refuses a configuration that already has one. Deploy a version without the block, or [switch the device to full mode](#switch-between-restricted-and-full-mode). An AWS credentials file and AWS credentials the host supplies are refused the same way, at an apply and at startup: deploy a version that gives the sink explicit keys as device secrets.

A changed allowance lets the device try a version it rejected earlier. It doesn't resume a paused device or turn on full mode.

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

<!-- verify-after-merge: that `vectory pause` also stops agent updates on the host, from the agent's update step -->
While the host is paused, it also takes no agent update: it keeps its [update choices](agent-updates.md#what-a-host-agrees-to) and reports that it is paused. `sudo vectory update pause` pauses only updates.

## Retry a rejected version

The agent doesn't retry a version that failed, so a broken version can't restart Vector in a loop. After you fix the cause on the host, allow one more attempt:

```sh
sudo vectory retry
```

While the agent runs, `retry` queues the request and the agent tries the failed version again within a few seconds: `Retry queued. The running agent (pid 812) tries the failed version again within a few seconds`. With the agent stopped, it tries at its next start.

From the dashboard, **Retry application** on the device does the same for the version it shows. Deploying a corrected version also works.

## Upgrade the agent

An agent upgrade replaces one file. It doesn't change Vector, the device's mode or its identity.

To update many devices from the dashboard instead, with a canary and a rollback on each host, turn on [agent updates](agent-updates.md). A host takes them only after it agreed to them in the command you ran on it, and it installs only a build that a key it pinned signed. The steps below are the way to upgrade a host that hasn't agreed, one that can't take an update, and any host on a platform a release doesn't carry.

On Linux and macOS, choose **Upgrade agent** on the device page. If the device already runs this server's build, it says so, for example `edge-01 already runs this build (SHA-256 975c1a33…0e9d19)`. Otherwise it shows one command to run on the device: the **Add device** installer, with no token. The installer checks and replaces the agent, and setup restarts the service on the new build and waits for its first check-in. It prints, for example, `vectory.service upgraded 0.1.0 → 0.2.0 · first check-in 1.2 s after restart`.

The command passes `--state-dir` when the device keeps its state elsewhere, and `--service none` when nothing keeps its agent running. Without a service, setup says to stop `vectory run` and start it again on the new build. If the agent is installed outside `/usr/local/bin`, add `--install-dir` with its directory.

A host keeps the address it enrolled with. If the command names another address, setup stops before it changes anything and prints the address the host is enrolled with. If it's the same server, run the command again with `--server` set to that address. Moving a host to another server is a separate step: run `vectory unenroll`, revoke the old device in the dashboard, then run setup again.

To upgrade by hand instead (on Windows, the only way), open **By hand** in the same dialog:

<!-- steps -->
1. On the device page, choose **Upgrade agent** and download the agent for the device's OS and CPU. Check its SHA-256 against the value shown.
2. Stop the agent: `sudo vectory service-stop`.
3. Back up the state directory, the managed configuration and the current agent binary. The state holds the device's private key, so keep the backup private.
4. Replace the binary at the same path, keeping its owner and permissions: `sudo install -m 0755 vectory /usr/local/bin/vectory`.
5. Start the agent and check it: `sudo vectory service-start`, then `sudo vectory --version` and `sudo vectory status`.

On the device page, confirm the same device identity, a fresh check-in and the expected pipeline.

> [!CAUTION]
> Don't re-enroll, purge state or reset counters as part of an upgrade. To go back, restore the previous binary. Restoring an older state backup can roll back security counters, so treat it as a last resort.

### Upgrade many devices

Unless a host agreed to [agent updates](agent-updates.md), Vectory doesn't send it an agent update: each host replaces its own agent. To upgrade a fleet without logging in to every host by hand, run the same command from your own tooling:

<!-- steps -->
1. On a Linux or macOS device's page, choose **Upgrade agent** and copy the command. It holds no token or secret: it names this server's address, its installer's SHA-256 and, for a private certificate authority, that authority's certificate.
2. Save it as `upgrade-agent.sh` and run it on each host as an account that can use `sudo` without a password (the command calls `sudo` itself), for example over SSH: `for host in edge-01 edge-02; do ssh "$host" sh -s < upgrade-agent.sh || echo "not upgraded: $host"; done`.
3. Check the result on the **Devices** page. Each device reports its agent version at its next check-in, and a device that already runs this server's build says so in its **Upgrade agent** dialog.

A device that keeps its state outside the default directory, or has no service, gets `--state-dir` or `--service none` in its own command, so copy the command of one device of each kind. Copy it again after you upgrade the server: it carries the installer's checksum, which changes with the server's build. Upgrade a few hosts first and look at them before the rest. On Windows, follow the by-hand steps above with your own deployment tooling.

With agent updates on, this is also how a host agrees to them: the command's **Agent updates** step carries the choice, and running it once is the only visit that host needs. See [A host that was installed without consent](agent-updates.md#a-host-that-was-installed-without-consent).

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

A version deployed while the binary was changed failed without Vector running it (the finding `VECTOR_BINARY_UNAVAILABLE`) and waits for a retry. After the agent runs again, choose **Retry application** on the device page or run `sudo vectory retry`.

If you didn't replace Vector yourself, don't approve the change. Find out why the file changed first.

## Adopt a Vector that already runs

Setup never takes over a Vector that is running. It records how that Vector was started, keeps a copy of every configuration file it loads, and stops, so nothing changes until you choose. Run the setup command while the old Vector still runs, then run it again once you've stopped it.

<!-- steps -->
1. Run the command from **Add device** with the old Vector still running. Setup waits 6 seconds, in case it's a short test run, then prints what it found (shown wrapped here; setup prints it on one line):

   ```text
   [i]  Inventory    Vector started with: /usr/bin/vector --config-dir /etc/vector/conf.d;
                     configuration files: /etc/vector/conf.d/10-sources.yaml (sha256 2f69f4e8c932…),
                     /etc/vector/conf.d/20-sinks.yaml (sha256 9668a900538f…), backed up to
                     /var/lib/vectory-agent/adoption-inventory/20260930T101500Z.
   ```

2. Read what it says next. A Vector that loads one plain file needs only the [usual handover](installation.md#keep-an-existing-workload). Anything else stops setup with the files named ([below](#when-setup-stops-for-a-running-vector)).
3. Stop the old Vector, for example `sudo systemctl disable --now vector.service`, and run the same command again. Add `--adopt-existing` if setup told you to.

Setup changes nothing of the old Vector: not its process, its files or its service. Its only writes are the copies below.

### What setup records

| Item | Where setup reads it |
| --- | --- |
| How Vector started | The running process: `/proc` on Linux, the kernel's process arguments on macOS, the process parameters on Windows. Also the service's own definition: the systemd `ExecStart`, the launchd job, the Windows service's `ImagePath`. |
| The files it loads | `--config`, `--config-dir`, `--config-toml`, `--config-json` and `--config-yaml`, the `VECTOR_CONFIG*` variables for the options you left out, globs and comma lists, and the files of a directory as Vector reads them. With none of these, Vector's default path. |
| What each file pulls in | `include` keys, a `provider`, secret backends and `SECRET[...]` references, and environment variables the file reads. Setup reads these and expands none of them. |
| A copy of each file | In `adoption-inventory` in the state directory, with its SHA-256. |

The copies sit in one folder per inventory, named by its UTC time, with an `inventory.json` that lists every file with its checksum. Only the account that ran setup can read them (mode `0700`; on Windows, an ACL for that account and SYSTEM), because they can hold the credentials the originals hold. Running setup again over an unchanged Vector keeps the same folder.

`vectory setup --json` prints the same inventory under `adoption`. `uninstall --purge` deletes the copies with the rest of the state, so move them elsewhere first if you still need them.

### When setup stops for a running Vector

Setup stops when the Vector's topology depends on more than the one JSON file the agent manages. It names each finding:

| Setup found | What it says | What to do |
| --- | --- | --- |
| Several files, a directory or a glob | `Vector loads 2 configuration files: /etc/vector/conf.d/10-sources.yaml, /etc/vector/conf.d/20-sinks.yaml.` | Merge them into one JSON file, or [adopt them as they are](#adopt-what-vector-loads-as-it-is). |
| A file that includes others | `/etc/vector/vector.yaml names other files with include (extra.yaml). Vector 0.58 doesn't read includes, so something else assembles this configuration, and the agent doesn't.` | Merge what that tool assembles into one JSON file, or adopt it as it is. |
| A provider | `/etc/vector/vector.yaml fetches more configuration from a provider (http), which the agent doesn't manage.` | Save what the provider serves into the JSON file, or adopt it as it is. |
| Configuration chosen by an environment variable | `Its configuration is chosen by the VECTOR_CONFIG_DIR environment variable of vector.service, which the agent doesn't pass to the Vector it starts.` | Merge the files it names, or adopt them as they are. |
| A process setup can't read | `How Vector (pid 812) was started couldn't be read, so the configuration it loads is unknown.` or `The environment of Vector (pid 812) couldn't be read, so configuration chosen through VECTOR_CONFIG or VECTOR_CONFIG_DIR can't be ruled out.` | Run setup with `sudo` (an elevated shell on Windows). |
| A path setup can't follow | `vector.yaml (-c) is relative, and the working directory of the process is unknown.` or `… uses **, a recursive wildcard that setup doesn't expand.` | Run setup with `sudo`. List the files of a `**` wildcard one by one, or adopt it as it is. |
| A file it can't copy | `/etc/vector/vector.yaml can't be read: permission denied.` or `… is larger than an inventory keeps (8 MiB a file, 64 MiB in all).` | Run setup with `sudo`. Copy an oversized file yourself, then adopt. |

The fix in the message says the same in one line: merge what it loads into one JSON file at the managed path, or adopt it as it is, and either way stop the old Vector and run the command again with `--adopt-existing`.

Setup notes these and goes on: a secret backend (the agent keeps credentials in [device secrets](resources.md#keep-credentials-on-the-device)), environment variables a file reads (the agent starts Vector without the old process's environment), a file that doesn't exist, and a file without a `.toml`, `.yaml` or `.json` extension, which Vector reads as TOML.

### Adopt what Vector loads as it is

`--adopt-existing` says the agent manages only its one JSON file. The other files stay where they are, and stay backed up, but no Vector the agent starts reads them, so whatever they configured stops when the old Vector stops.

- Stop the old Vector first. Setup won't take over a running one, with or without the flag.
- Run the same command again with `--adopt-existing`. Setup remembers what it recorded, so it doesn't need the old Vector to be running.
- Without the flag, setup stops again and names the files, even if you merged them into the managed file: it can't see what a merge left out.
- The flag can't be combined with `--keep-existing-vector`, which leaves the old Vector running beside the agent.

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

If the server refuses the token because it expired, was revoked or was mistyped, run the command again with a new one. If the connection dropped after the command sent its request, run it again with the same token: it finishes the request it started, and a different token is refused until it does.

The old identity stays in **Devices → Status → Revoked**, in rollout results and in the audit log, under the name the device had and with a **Retired identity** badge. Its record keeps its history; the new identity has the name now.

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

## What the agent survives

Each row is a failure the agent is tested against on Linux, macOS and Windows. The tests are in `agent/internal/agent`; run one by name with `go test -run NAME`.

| Failure | What the agent does | Test |
| --- | --- | --- |
| The process is killed, or the power fails, at any step of an apply | The next start restores the last verified configuration. A managed file is never half written, and the last working copy is never lost. The interrupted version waits for a retry. | `TestKillAtEveryApplyBoundaryRecoversDeterministically` kills a real agent process at each of the seven stages and restarts it. |
| The disk is full | Nothing is half written and the running configuration is untouched. The device page and `vectory status` say which disk is full and how to fix it, and the next check-in after space returns applies the same version with no manual step. | `TestDiskFullAtEveryWriteOfAnApply` and `TestRestartAfterAFullDiskRecoversACompleteConfiguration` |
| A download is cut off, cut short or altered | Nothing is applied and the partial file is removed. The diagnostic says what happened, and the agent tries again at its next check-in, never in a loop. | `TestInterruptedOrAlteredDownloadActivatesNothing` and `TestCheckInRetryIsBounded` |
| `vector validate` doesn't finish in time | The version is rejected as unverified, never treated as valid. The validating process is killed and Vector keeps running the old configuration. | `TestValidationTimeoutRejectsTheVersionAndKeepsTheOldConfiguration`, and with a real Vector `TestNativeValidationTimeoutKillsVectorAndKeepsTheOldConfiguration` |
| An outbound proxy is in the way | Enrollment and check-ins go through an HTTP proxy with `CONNECT`, with the server pin intact. A proxy that refuses, asks for a sign-in or inspects TLS fails with a message that names the proxy. | `TestEnrollmentAndCheckInGoThroughAConnectProxy`, `TestProxyThatRefusesOrNeedsSignInIsNamed` and `TestProxyThatInspectsTLSFailsThePin` |

A kill leaves the files the agent had already synced exactly as a power cut does. What no test can show is a disk that acknowledges a sync it didn't perform.

Access is kept too. On Linux and macOS, local maintenance (`allow`, `install`, `configure-metrics`, `configure-secrets`, `re-adopt`) replaces the agent settings and the state file and keeps their owner, group, mode (`0600` or `0640`) and extended attributes: `TestMaintenanceKeepsOwnerGroupModeAndAttributesOfWhatItReplaces`. What the agent writes as it runs is private to the writing account, whatever it replaces: `TestAtomicWriteNeverLoosensAccess`. A file the service account owns stays its own when root replaces it: `TestRootReplacementKeepsTheServiceAccountsOwnership`. A setup or upgrade run as root leaves every file and folder the agent keeps in its state directory private (`0600` and `0700`), so the Vector process's group can read none of them: `TestSetupAndUpgradeLeaveOnlyPrivateFiles`.
