# Troubleshoot a problem

Start with the device's connection state, last heartbeat and pipeline status. A connected agent does not prove that its desired pipeline is running. A past **Applied** result on an offline device is historical evidence.

Use the same state directory and operating-system identity as the installed agent in all host commands below. Replace `/var/lib/vectory-agent` with your actual path; Windows paths are supported by the same options.

## A page is blank or cannot load

If a page's files fail to load, Vectory keeps the surrounding navigation available and shows **This page couldn’t load**. A download that has not finished after 30 seconds shows **This page is taking too long**. This can happen after a connection interruption or when an older browser tab requests files from a previous dashboard version.

1. Check your connection to the dashboard. You can use the navigation to open another page while the affected page is unavailable.
2. Choose **Reload page** when you are ready. Reload is deliberate: Vectory does not refresh the workspace or resend an interrupted action automatically. A request to keep work still open cancels the reload.
3. If the problem remains, ask the instance administrator to check that the dashboard's HTML and asset files belong to the same complete build. Repeated reloads cannot repair missing files on the server.

**This page stopped working** means a rendering error interrupted an already loaded page. Unsaved changes on that page may no longer be available; reload reopens saved data. If an action was interrupted, review its request status or current saved state before trying it again.

If the entire window is blank, the dashboard may have failed before it could show recovery controls. Use your browser's reload action and open this installation's `/help/` address directly for the static Help center. The in-page recovery view cannot handle failure of the dashboard's initial entry files. See [Open your workspace](#/docs/getting-started#open-your-workspace) for connection and sign-in recovery.

## A device is offline or never connects

1. Confirm that the agent is running under its intended service account. Starting an additional foreground agent against the same state directory fails the single-instance lock. Use the existing supervisor's logs rather than launching a competing process.
2. Inspect the local installation and last known state:

```sh
vectory doctor --state-dir /var/lib/vectory-agent
vectory status --state-dir /var/lib/vectory-agent
```

`doctor` checks the adopted binary digest before running its fixed Vector version probe, then checks the managed path and configured mode. It reports whether a metrics endpoint is configured. It does **not** test server connectivity or prove credentials are currently accepted. `status` reports local pause, drift and the persisted apply state; compare that with the dashboard's last heartbeat. Both commands include read-only `diagnostics` with a next action and local checks of the cached desired configuration. Add `--json` for machine-readable output.

3. Read the existing agent process or service log for connection errors. Verify the configured HTTPS origin, DNS/firewall reachability and certificate hostname. Agents normally use port **8443**, while the browser uses **443**. Check the host clock. If the device needs a private CA certificate, follow [Trust the server certificate](#/docs/installation#trust-the-server-certificate), including the steps for administrators who run the server themselves. Keep certificate verification enabled.
4. For a new enrollment failure, ask an administrator to check token expiry, use count, name scope and revocation in [**Devices → Add device**](/#/enrollment). A reusable token cannot take over an existing device name.
5. If an existing identity can no longer renew, ask an administrator to authorize recovery from the device page. Follow the supplied recovery command while the daemon is stopped, retaining the existing state directory. The replacement identity starts without inherited groups or assignments; restore those deliberately.

After fixing the cause, confirm that the heartbeat timestamp advances and inspect the desired/applied pipeline separately. Losing control-plane connectivity does not stop an already running Vector workload. Stopping the agent does stop its supervised Vector process, so schedule restarts accordingly.

If its owned Vector process exits, the running agent attempts to restore the established workload even during a control-plane outage, after unassignment, or while a newer pipeline remains rejected. Repeated startup failures use an increasing delay of up to five minutes. Local or remote configuration-sync pause prevents this automatic restart; inspect the host before deliberately resuming. An explicit agent startup retains its existing behavior of starting the adopted workload while sync is paused.

Recovery can wait for an in-flight network request or native check to finish. Restoring the established process does not mark a rejected pipeline successful or advance its verified generation. Check fresh device reports and actual event delivery after recovery.

## A token request is interrupted

An interrupted browser response does not prove that token creation or revocation failed. For token creation, **Add device** retains a nonsecret request reminder in this browser, scoped to the account that started it.

1. Open **Check request**, then **Check status**. This reads the exact request; it never creates another token or retrieves its secret.
2. If the secret is unavailable, choose **Cancel request** or **Revoke token and cancel**. Cancellation prevents late creation and revokes the token associated with that request. A result saying no token is recorded yet is not cancellation.
3. Wait for **Request cancelled**, then choose **Continue setup**. If cancellation itself times out, check status again. Keep the reminder until cancellation is confirmed.

For a token revoked from **Manage enrollment tokens**, an uncertain reply offers **Check current status**. A fresh read confirms whether that exact token is revoked. If it remains available, a separate confirmation lets you revoke it again. This revocation reminder lasts only on the current page; after leaving or reloading, review that token's status in the token list. Existing device identities stay connected in either workflow.

If browser storage is unavailable, restore it before creating a token so interrupted requests can be recovered. A damaged reminder with a usable request identity still offers lookup and cancellation. Keep using the same account and browser profile to find the reminder. A server upgrade may be needed if the dashboard cannot verify request-correlation support. See [saving a token](#/docs/installation#save-the-enrollment-token).

If a damaged reminder has no usable identity, **Review unreadable reminder** explains how to dismiss only that browser record. Review the token inventory and revoke unwanted tokens first. Dismissal does not cancel any server request, retrieve its secret or automatically create a replacement.

## A device recovery request is interrupted

The browser's authorization request and the host's `recover-enrollment` command are separate steps. First establish whether the token ever reached the host.

- **The token was never used on the host:** return to that device page with the same account and browser profile. Open **Device recovery → Check request**, then **Check status**. If the secret cannot be retrieved, choose **Cancel request** or **Revoke token and cancel**. Wait for **Recovery request cancelled** and choose **Continue** before creating another token. A negative lookup is not cancellation; an uncertain cancellation needs another status check.
- **Recovery has started on the host:** retain the pending recovery files and original token, and inspect the replacement identity in **Devices**. Retry an interrupted host command with its original inputs while that token remains eligible. If replacement credentials were already saved locally, the agent can finish that local transition without another enrollment request; server acceptance alone does not prove those credentials reached the host. Revoking a token can block an unfinished request; a new token cannot simply replace the one saved by a pending recovery. If the original token is expired or revoked, preserve local state for administrator review.
- **The token has already been used:** checking the request reports that fact. Inspect the replacement identity and its credentials before authorizing anything else. Cancelling the old authorization does not disconnect the replacement or bring back the retired identity.

Closing a token dialog only hides its in-page copy. **Show token** reopens it until you acknowledge, discard, leave, reload or end the session. An acknowledged or lost secret is never available from request lookup. **Discard token copy** does not revoke it.

If the browser reminder is damaged, **Review reminder** uses its exact request identity where available. A reminder without a usable identity can only be deliberately dismissed after reviewing unwanted recovery tokens under **Devices → Add device → Manage enrollment tokens**. Dismissal removes that browser record, not a server request or device identity. Storage must be available before starting a new authorization. See the [device identity recovery procedure](#/docs/installation#recover-a-device-identity).

## An enrollment command fails

Keep the existing state directory. Do not delete keys, `enrollment.json` or recovery files to make a retry appear fresh: the server may already have accepted a request whose response was interrupted.

- **Unreadable or invalid CA file:** follow [the server certificate guide](#/docs/installation#trust-the-server-certificate). Copy the correct public PEM to a stable location readable by the agent, then retry with `--ca-file PATH`. On agents with enrollment preflight protection, a missing or invalid CA is rejected before saving connection settings or creating a new enrollment request.
- **Already enrolled:** ordinary `enroll` preserves the existing identity and connection settings. Inspect the existing device in the dashboard. Use administrator-authorized `recover-enrollment` only when that identity actually needs replacement; do not re-enroll to fix a pipeline or heartbeat problem.
- **Invalid local options or empty token:** correct the reported input and retry. Use the same state directory, and supply the token through hidden interactive input, `--token-stdin` or a protected token file.
- **Interrupted request or server rejection:** retry the original server, machine name, state directory and token. Omit `--ca-file` to keep the saved trust path; supply a path to repair it deliberately, or `--ca-file=` to select system trust. Existing pending requests keep their key and request ID. A different server/name is refused instead of silently changing the pending identity.
- **Original token expired or revoked:** ask an instance administrator to inspect the device and enrollment-token status. A new token cannot simply replace the original token on a pending request. Preserve the local files for review; an uncertain enrollment is not permission to clear identity or generation state.

These local-preflight protections require an agent artifact containing the enrollment fix. Older development builds can save connection settings before returning an error. If an older attempt already pinned a wrong server/name, retain the pending files and inspect the situation before making changes; upgrading cannot prove that an earlier request was never sent. After a request has been prepared or sent, an error does not imply that every local write or server action was rolled back.

## The adopted Vector binary changed

`doctor` and the running agent refuse a Vector executable whose checksum no longer matches the locally adopted identity. First establish why the file changed. If the replacement was deliberate and independently verified, stop the agent and follow [Replace the adopted Vector binary](#/docs/installation#replace-the-adopted-vector-binary) to approve its exact checksum with `re-adopt`. If the change was unexpected, preserve the evidence and restore a trusted executable before resuming operation.

Re-adoption retains the current workload, identity, pauses and retry state. It validates the supported replacement against existing configurations but does not start or verify a workload. Repeating `install --adopt`, changing a dashboard assignment or retrying a pipeline does not approve changed executable bytes.

## A local settings update is refused

Stop the agent through its existing supervisor before changing local allowances, configuration mode, metrics or secret bindings. A sync pause keeps the agent running and does not release its operation lock. If the command reports another operation, wait for that process to exit; do not delete `agent.lock` or start another agent against the same state directory.

An invalid option in a combined `install` request rejects all requested settings changes before saving. Correct the reported URL, policy or binding and submit the complete intended request again. A fresh installation also checks these inputs before creating its state or adoption backup. Policy files only set allowances; choose full or restricted mode with the explicit mode flag. On older builds without this fix, inspect the saved settings before retrying because earlier options may already have been applied.

An access-preservation error means the maintenance account could not safely retain the installation's existing owner or permissions. Keep the files in place and ask the host administrator to inspect the intended service identity's access, including the state directory, settings and local resources. Do not replace protected files with broadly readable copies or remove ACLs to bypass the error. Use the [local settings procedure](#/docs/installation#update-local-agent-settings), then verify the service under its actual identity after restarting.

If the error says settings were saved but retry-state cleanup failed, the new mode or allowances may already be in effect. Keep the agent stopped, inspect `status` and `doctor`, and correct the reported local write failure. After reviewing the saved settings, use the separate `vectory retry --state-dir PATH` command if another attempt is intended. Repeating unchanged settings does not clear a suppressed attempt. Do not restore older state or reset counters to force it.

An incomplete fresh installation is different: settings may have been written before initial state creation failed. Keep the agent stopped and preserve its files and adoption backup for inspection. Repeating `install` refuses missing or unreadable state instead of reporting success or inventing replacement state. The `retry` command does not repair an incomplete installation.

If a previous agent build already removed a provisioned permission, this update cannot reconstruct that grant. Restore the intended access from your protected installation records rather than granting access to every local account. A command that succeeds under an administrator account does not establish service-account access or workload health.

## A secret-binding map is rejected

Pass the map with `configure-secrets --secret-files PATH` and the existing `--state-dir`. The map must be one JSON object, saved as UTF-8 without a byte-order mark (BOM), whose unique names point to absolute private credential-file paths. Do not put credential values in this map. Fix malformed JSON, duplicate names, `null`, lists, trailing content or invalid paths, then submit the complete intended map again. Use `{}` only when deliberately removing every binding.

An input rejection leaves existing bindings and retry state unchanged. Review the file error without removing access controls or making credential files public. Follow [the device-local binding procedure](#/docs/resources#keep-credentials-on-the-device), using the actual service identity and checking the command result before restarting.

This strict behavior requires an agent package containing the secret-binding input fix. Older development builds can interpret `null` as clearing bindings or silently choose the last duplicate name. If an older command already succeeded, review the saved bindings before resubmitting a corrected complete map; upgrading does not reconstruct removed entries. Verify the artifact through your trusted release channel because development builds may share a version label.

## A dashboard page keeps loading

Dashboard reads stop waiting after 30 seconds, including a stalled response body. Background refresh lets an existing read finish instead of repeatedly replacing it. A timeout does not mean records were deleted or a device stopped. Check your connection to the instance, then choose **Try again** or **Refresh**. Changing pages cancels the abandoned read; a late response cannot replace the new page's data.

## A pipeline is rejected or rolled back

Open the device's **Activity** and the deployment details. Use the reported failure stage to choose the next action:

| Reported problem                                     | Next action                                                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restricted capability or unsupported component       | Compare the pipeline with the device's reported configuration mode. Have the host operator review local allowances or explicitly choose full mode; a deployment cannot grant it remotely. |
| Missing local file, secret or environment value      | Provision the resource for the actual agent service account on every target. A value in your interactive shell or on the Vectory server does not supply it to Vector.                     |
| Invalid Vector configuration or failing native tests | Correct the draft, check the relevant Vector field/platform requirements and run pipeline tests. Publish a corrected version and review its targets.                                      |
| Startup or sink health check failure                 | Check destination availability, permissions and port conflicts on the host. Preserve the verified running configuration while addressing the dependency.                                  |
| Rolled back                                          | The new activation failed and the agent restored its last verified configuration. Read the failure before retrying; the attempted version is not the active version.                      |
| Check required                                       | Current activation could not be verified. Inspect local status and the owned process before treating it as healthy.                                                                       |

After a rejected apply, the managed file may still be the last working configuration. Read `diagnostics.desired_configuration` to inspect the **desired** template instead: the agent checks its cached size and digest, resolves approved local secret-file bindings in memory and checks local capability allowances. A denied destination, listener or file root gets a specific category and corrective action. Missing or corrupt cache and unavailable secret bindings are reported separately. `capability_allowed` means only those local checks passed; it does not establish that Vector accepted or activated the version.

These diagnostics do not run native validation, pipeline tests, providers or environment interpolation, and do not change retry state, counters, pause or managed content. A successful `doctor` exit does not clear an apply failure. For native validation or test failures, inspect the desired published version and its host requirements under the actual service identity. General diagnostics deliberately avoid returning resolved credentials and raw provider output. Do not paste real secrets into a draft to make validation succeed. Use the [resource guide](#/docs/resources) to choose the appropriate reference mechanism.

An identical failed attempt may be suppressed to prevent repeated restarts. `diagnostics.retry_status` is `suppressed` when the current desired generation and effective content match the rejected attempt, `not_suppressed` when they do not, or `unknown` when the cache or secret bindings cannot be inspected. A rotated local secret can permit a new attempt; reading diagnostics does not consume a revision or request a retry. Once the cause is fixed, an authorized operator can use **Retry** where offered, deploy a corrected version, or have the host operator stop the agent, run `vectory retry --state-dir /var/lib/vectory-agent`, and restart it. Stopping the agent also stops its supervised Vector process. Do not delete state, edit accepted generation counters or re-enroll as a retry mechanism.

## Device controls change while a request is pending

The device page follows the latest assignment, pause and access state it has received. If those change while **Retry application** or **Check status** is waiting, the old response cannot update the new controls. A pause can disable Retry; revoked access or lost operating permission removes it. If a new assignment is eligible, you can review it and explicitly request a retry without waiting for the old reply.

Leaving the page or seeing a control disappear does not cancel a retry that reached the server. Return to the device and refresh its assignment and reported state. A retry request advances the desired generation; only subsequent device verification establishes that it applied. The dashboard never automatically resends the abandoned request. Follow [Retry a failed application](#/docs/telemetry#retry-a-failed-application) if another attempt is still needed.

An open agent-settings review closes if you lose operating permission, the device becomes unavailable, or its access is revoked. If access is restored, open a new review deliberately; the earlier dialog will not reopen on its own. Device identity recovery is a separate operation with its own [interruption procedure](#/docs/troubleshooting#a-device-recovery-request-is-interrupted).

## Validation says deferred or unavailable

**Deferred** means the server could not perform the native check without device-specific resources or platform features. Inspect those requirements and the target's configuration mode before deployment. The device must still run native validation and any configured tests before activation. Deferred is not a successful native test.

**Structural-only** without an isolated validator is a development-preview result, not a production validation mode. A production server requires the isolated Vector validator at startup. If its configured worker later becomes unreachable or fails, publication is blocked. An instance administrator should inspect the validator and server logs and restore that service; repeated publication attempts do not resolve an unavailable worker.

## A deployment is pending, paused or conflicting

Check [**Activity → Deployments**](/#/deployments) and the exact target preview:

- **Offline target:** it cannot acknowledge a new configuration until it reconnects.
- **Scheduled:** verify the intended start time and whether the schedule has been marked missed. Refresh or recreate it using the offered controls and review the target set again.
- **Canary waiting:** look for unverified, failed or stale initial devices. A canary needs continuously fresh successful observations before releasing more targets.
- **Sync paused:** distinguish rollout pause, remote agent sync pause and host-local pause. A host operator clears local pause with `vectory resume --state-dir /var/lib/vectory-agent`; remote resume cannot override it. Review any manual changes before resuming reconciliation.
- **Priority conflict:** different payloads at equal priority do not get an arbitrary winner. Review active assignments, choose a deliberate priority or preview unassigning an obsolete assignment.
- **Target set changed:** membership changed since preview. Refresh the preview, review the new concrete devices and confirm again.

Unassigning or canceling a deployment does not stop Vector. Another winning assignment may become effective; without one, the device retains its established workload. See [Deploy and roll back](#/docs/deployments).

## A device page shows mismatched details

If the dashboard says the returned details do not match the requested record, choose **Try again**. It has rejected a response belonging to a different device, pipeline or version. The affected details and their dependent controls stay hidden until a matching response arrives. You can also use **Back to devices** and reopen the intended device.

On a selected-device banner, **Try again** reloads the original selection; **Clear selection** removes that selection. A metrics mismatch is a read error, not evidence that the device has never reported metrics. Previously accepted measurements from the same device can still appear with their timestamps.

A mismatch does not mean your device was replaced, its access was revoked or its pipeline changed. Do not re-enroll it or repeat a deployment to resolve a page-loading error. If it persists, ask the instance administrator to inspect the application and any proxy or cache serving its API. Copy the intended page URL when reporting the problem, without including tokens or credentials. See [device assignments](#/docs/telemetry#understand-the-devices-assignments) for what the linked pipeline and settings records mean.

## A device revocation is unconfirmed

Open the original device's **Device access** section and choose **Check revocation**. The dashboard reads the status of that exact device identity; it does not send another revocation automatically. **Device access revoked** confirms the current state even when the original reply was lost.

If the identity is not revoked at the time of the check, an earlier request may still arrive. Review the device and deliberately confirm again only if revocation is still intended. Revocation is permanent for that identity, so a later repeated request is a no-op. A name can belong to a replacement identity; use **Device identity** to check the original UUID.

If the read fails, keep the reminder and use **Check status** again when the server is reachable. A server without device-access status support cannot complete this guarded flow; the instance administrator must use matching server and dashboard versions. Browser storage must be available before a new revocation can be sent. If a confirmed result's reminder cannot be cleared, access remains revoked; a later status check can clear that exact reminder.

Closing, navigating away or ending the session does not undo an already submitted request. The reminder contains no credentials and is scoped to this browser profile, account and device. It cannot recover a request after the browser's saved data has been erased; inspect the exact device's current access instead. See [device access and revocation](#/docs/telemetry#revoke-device-access) for the effect on groups, assignments and local workloads.

## An old issue stays open after device recovery

Issues resolve automatically after a fresh, verified apply report from the same device identity. Revoking a device or replacing its identity through recovery prevents further reports from the old identity, so its existing issues can remain open.

Open the issue's device link and check whether it belongs to the revoked or retired identity. Assess the replacement device separately using its new identity, latest heartbeat and applied version. An old open issue does not establish that the replacement failed, and retiring an identity is not evidence that its previous workload recovered.

An Operator or Admin can record that decision in [**Activity → Issues**](/#/issues):

1. Find the original device's issue. Review **Investigation details** and confirm its device ID.
2. Choose **Acknowledge issue**. This is available only for unresolved issues on revoked device identities.
3. Enter a reason, such as where the replacement was checked or why the device was retired, and confirm. Keep secrets and private diagnostic output out of the reason.

**Acknowledged** issues leave the open list and open count, but stay in history with the reason, actor and time. Acknowledgement does not verify recovery, reconnect a device, retry Vector or change an assignment. Choose **Acknowledged** or **All issues** in the **Status** column filter to find them again. **Reopen issue** records a new reason and returns an unresolved issue to the open list; it cannot undo verified resolution.

If the issue changes while a dialog is open, select **Review latest issue** and inspect its latest count, time and status. If its status is unchanged, you can confirm again after reviewing the new report. If another action already changed its status, close the dialog and find it under its current status; the confirmation will not switch from acknowledgement to reopening. A fresh failure report clears a previous acknowledgement and returns the issue to the open list. Issue actions are recorded in the [audit log](/#/audit).

## A capability-policy file is rejected

Use a protected local JSON object saved as UTF-8 without a byte-order mark (BOM). The three allowance fields are `allowed_file_roots`, `allowed_network_hosts` and `allowed_listen_addresses`. Use unique property names and supply each list as an array of strings. File roots must be absolute, and destinations and listeners need an exact `host:port`. On Windows, JSON paths need doubled backslashes, such as `C:\\ProgramData\\VectoryData`. See the [policy file examples](#/docs/installation#configure-restricted-allowances).

Malformed UTF-8 and unpaired Unicode escape sequences are refused instead of being silently replaced with a different resource name. Valid Unicode names, including a deliberate replacement-character name, remain supported. Reopen the original file with the correct encoding, verify the intended resource names and save valid UTF-8. Do not blindly replace characters or broaden an allowance to make the error disappear. A top-level `null`, array, duplicate property, unsupported field, wrong value type or trailing document is also rejected.

Keep the agent stopped while applying the corrected file through `install --capability-policy`. Check the command result before restarting; stopping the agent also stops its supervised Vector process. A refused input leaves current settings and retry state unchanged, including when other install options were supplied. A successful changed policy replaces all three lists and permits another attempt at a previously rejected configuration; it does not resume a paused device, grant full mode or prove activation. An empty object removes all restricted allowances. Follow the [allowance update procedure](#/docs/installation#update-a-devices-local-allowances) rather than editing installed state directly.

This strict encoding check requires an agent package containing the policy-input fix. Older development builds can report success after silently converting malformed bytes or an unpaired Unicode escape to a replacement character. If that happened, have the host operator review the installed allowance lists against the intended resource names, then supply a complete corrected policy through a verified package. Upgrading alone does not reconstruct the original names. Check the artifact through your trusted release channel; a reused development version label does not establish which parser is installed.

## A metrics endpoint update is refused

Stop the agent through its existing supervisor before changing its local settings; this also stops its supervised Vector process. Use the same absolute state directory as that installation. `configure-metrics` requires exactly one of `--metrics-url URL` or `--clear-metrics-url`. Supply the flag as well as its value: a URL passed as a positional argument is not accepted.

To set an endpoint, use `http://127.0.0.1:9598/metrics` with the actual loopback IP and port. Hostnames, non-loopback addresses, HTTPS, credentials, queries and other paths are rejected. An empty URL does not clear the setting. For deliberate removal, use `--clear-metrics-url` without a URL or `=false`. Invalid input leaves the saved endpoint and unrelated settings unchanged.

If the command or flag is unknown, inspect `vectory help` and use a verified agent package that includes the feature. Do not delete settings or re-enroll to work around an older command. If the operation lock or access-preservation check refuses the update, follow [local settings troubleshooting](#/docs/troubleshooting#a-local-settings-update-is-refused). Check the command result before restarting; saving a URL does not establish that the exporter is reachable. The [endpoint change and removal procedure](#/docs/telemetry#change-or-remove-a-metrics-endpoint) explains restart behavior, remote collection settings and retained history.

## Metrics are missing, or no events reach a destination

A dash means a measurement was not reported. For metrics, follow [Monitor devices](#/docs/telemetry): configure `internal_metrics` and a loopback `prometheus_exporter`, set the agent's metrics URL while stopped, and enable telemetry in the effective agent settings. Check that the service account can reach that endpoint. The first counter sample needs a later sample before a rate exists; old history is not a current measurement.

If metrics are present but destination data is missing, inspect the pipeline path. Confirm that the source is receiving events, conditions are not intentionally discarding them, and the sink's credentials, connectivity and downstream service are correct. Source throughput and **Applied** do not guarantee final delivery. Use synthetic inputs in VRL or pipeline tests to check transformations; Vectory does not capture your production events for inspection.

## You cannot sign in

### Loading or sign-in does not finish

The dashboard stops waiting for a connection, sign-in, verification or password-reset response after 30 seconds. **Retry connection** replaces a pending startup check; **Try again** retries a failed check. These actions only read connection and session status. An unavailable or unreadable session response is shown as a connection problem, not treated as a confirmed sign-out.

If you see **Sign-in result unknown**, select **Check sign-in status**. This reads the current browser session without resending credentials or a one-use code. A current enabled session for the email you entered opens the workspace. A different account is identified without switching you into it. If no current session is found, **Start a new sign-in** returns to the password step; use a fresh authenticator code or an unused recovery code when prompted. A missing session does not prove that the earlier request failed or cannot still finish.

If you see **Setup result unknown**, select **Check setup status**. If the instance is already initialized, **Go to sign in** opens ordinary sign-in. That status does not identify who created the first account. If setup is not visible, check again before using **Return to setup**: the previous request may still complete. If the status check fails, restore the connection and check again; setup is never resubmitted automatically.

If you see **Password reset result unknown**, use **Back to sign in** and try the new password you chose, with MFA if enabled. The reset may already have consumed its code. Do not resubmit that code; ask an administrator for a new one if sign-in still fails.

Closing a page or ending a wait does not undo a server-side account change, session cookie or consumed code. Passwords, setup secrets and verification codes are cleared from the uncertain form; they are not saved for automatic replay. [Open your workspace](#/docs/getting-started#open-your-workspace) explains normal sign-in.

### Credentials or account access are rejected

Confirm that you are opening the correct instance. After setup, the bootstrap secret cannot create another administrator. Enter your email and password first. If your account uses two-factor authentication, Vectory then asks for an authenticator code. Check the authenticator and server clocks. Choose **Use a recovery code instead** if you have an unused recovery code. If verification expires, sign in again with your email and password. Repeated attempts can be rate-limited; wait before retrying.

If you forgot your password, ask an administrator for a password reset code. Select **Reset password** on the sign-in page and enter the code with a new password. The code expires after 15 minutes, works once and becomes invalid when a newer code is issued. Vectory does not send reset email. After resetting, sign in normally with MFA if enabled; the reset does not replace an authenticator or restore a used recovery code.

An administrator can inspect the account's status under [**Settings → People & security**](/#/users) → **Workspace access**. A disabled account cannot sign in or use a reset code. Re-enabling it requires a fresh sign-in and, if needed, a newly issued reset code; old sessions and codes remain invalid.

If both the authenticator and all recovery codes are lost, there is no MFA-reset workflow. Preserve the database and matching key tree while investigating; deleting MFA keys or resetting initialization is not an account-recovery procedure. See [Administer Vectory](#/docs/administer).

After an administrator runs restored-access invalidation during disaster recovery, all older browser sessions, password reset codes and MFA recovery codes are intentionally invalid. Sign in with the reviewed account password and a working authenticator. Request a newly issued password reset code if needed; it still cannot bypass MFA. Restored account or device restrictions must be reconciled before normal access resumes.

## Sign-out is not confirmed

A missing or unreadable response does not prove sign-out failed. Select **Check sign-out status**; it only reads the current session. A rejected request also offers a status check before another attempt. Both the sign-out request and the status check stop waiting after 30 seconds, including a response that starts but never finishes.

- **This session is still active:** the last check matched the session you originally chose to end. **Retry sign out** sends a new request only when you choose it. The earlier request may still finish.
- **No active session found:** the last check found no signed-in session. **Go to sign in** asks again about any unsaved work before leaving. Declining keeps your local editor open; server actions require sign-in.
- **Your sign-in changed:** another sign-in or account change has replaced the context you reviewed. **Reload workspace** checks for unsaved changes and reads the current account. Review that workspace before starting a separate sign-out; the old request is not redirected to the newer session.

Use **Stop waiting**, the close button or Escape to leave a pending dialog. The account menu retains **Check sign-out status** while this workspace remains open. A late response to a closed dialog cannot take you away from new edits. Closing a wait does not cancel the server operation or prevent a delayed cookie update. If a check fails, restore the connection and check again; the dashboard does not silently repeat sign-out.

If you return to unsaved work, copy or preserve it before choosing **Go to sign in** or **Reload workspace**. Those actions still respect the editor's leave confirmation. Reloading the browser itself starts a fresh session check and does not retain the earlier in-memory review. [Sign out of your workspace](#/docs/getting-started#sign-out-of-your-workspace) describes the normal flow.

## An account change fails or signs you out

### Account creation is not confirmed

If **Create user** does not return a confirmed receipt, open **Review account creation** on the same People & security page. **Check request status** reads the exact request ID without sending the password again. **Created** identifies the account; if you no longer know its initial password, issue a password reset code from **Workspace access**. If the account's current details have changed since creation, the review does not select it automatically; inspect the refreshed workspace list before another action. **Not found** only means the request has not committed at the instant of the check. Select **Cancel this request** to fence any late arrival before starting another account creation. If the status or cancellation check fails, restore the connection and try that check again; do not submit a second account first.

**Stop waiting**, closing the dialog and Escape end only the browser wait. They do not reverse a completed server write. Submitted passwords are cleared immediately and never saved for replay. A changed sign-in or administrator role closes the old review; the same administrator can reopen its exact request after access is restored while this page remains mounted. Navigating away or reloading loses this page-local request ID, so resolve an uncertain request first. A server that cannot confirm request tracking does not receive the creation request.

### An administrator reset code is not confirmed

If **Create reset code** has no confirmed reply, open **Review reset request** on the same **People & security** page. **Check request status** reads only the exact request ID and whether its code is still active; it cannot display a lost code again. **Not found** does not rule out a late issue. Select **Cancel this request** and wait for a confirmed cancelled status before issuing another code. Cancellation revokes an unused code but cannot undo a password change if the person already used it. A failed status or cancellation check leaves the outcome unresolved; restore the connection and repeat the exact check instead of creating another code.

**Stop waiting**, the close button and Escape end only the browser wait. The administrator's submitted password is cleared. A received code can be hidden and reopened through **Show reset code** until it is marked shared, the page is left, or the sign-in changes. If the browser clock or account details change, verify the exact code status with the server before sharing. These codes and request IDs are held only on this page, never in browser storage. A server that cannot confirm request tracking does not receive a new code request.

### A password change or session sign-out is not confirmed

**Change password** and **Sign out other sessions** wait up to 30 seconds for the response, including its body. **Stop waiting**, the close button and Escape return to your account immediately. The server may still complete the request; closing cannot undo it or prevent a late session cookie from arriving. The dashboard clears all submitted password fields and ignores obsolete results.

For **Password change not confirmed**, choose **Go to sign in** and try the new password you chose, then complete two-factor verification if required. If that password does not work, try your previous password or ask an administrator for a reset code. A session check cannot prove which password is in use, so the dashboard does not turn a current session into a password-change success message or resend the password change.

For **Session sign-out not confirmed**, checking this browser’s session cannot tell you whether the others ended. **Review another sign-out** starts a separate review with an empty current-password field. Confirming it ends all other sessions present when the new request completes, including any created since your earlier attempt. Cancel returns to the unresolved review; it does not mark the first request successful.

**Back to account** keeps each action’s review available while this People & security page remains open. Reopening it or opening the other action does not send another request. Leaving the page or reloading clears these in-memory reviews; preserve the outcome information before leaving. No passwords or session credentials are saved in browser storage for recovery.

If the account or session changes, **Reload workspace** reads the current sign-in afresh. It does not confirm the earlier change. Both leaving for sign-in and reloading respect the workspace’s current navigation guard. A rejected confirmation password keeps the form available for a fresh entry when the same session is still valid. [Change your password or close other sessions](#/docs/administer#change-your-password-or-close-other-sessions) describes the normal procedure.

### An authenticator change is not confirmed

Setup, confirmation and disable requests stop waiting after 30 seconds, including a stalled response body. **Stop waiting** ends the browser wait; it does not cancel a server change. **Check current status** reads whether two-factor authentication is enabled now. It does not identify which request finished, show a pending setup key or retrieve recovery codes from an unread confirmation response. No change is resent automatically.

If setup was interrupted, start a new password-gated setup only after reviewing status. A new QR can invalidate an earlier one; if its code is rejected, check status and start again. If confirmation was interrupted and MFA is now enabled, keep the working authenticator. Its eight recovery codes cannot be retrieved from the unread response. To obtain new codes, deliberately disable MFA with that authenticator and set it up again. If disable was interrupted, do not blindly submit the same code again: another disable can revoke sessions created since the first attempt. Review the current setting before choosing a new action.

**Hide setup** keeps the QR in the current tab, and **Hide for now** keeps confirmed recovery codes there until you acknowledge them. Leaving or reloading discards that browser-only copy after a warning. A changed sign-in hides setup keys and recovery codes. [Set up an authenticator](#/docs/administer#set-up-an-authenticator) explains the normal path.

### Access changes and rejected requests

Sensitive account changes require your current password. A wrong confirmation password leaves the current session usable; correct it and retry. If the account changed since you opened its editor, select **Load latest details**, review the current role and access, then save again. Do not keep submitting an outdated dialog.

If **Edit access** does not return a readable result, use **Review access change** on the same page. **Stop waiting**, closing the review and pressing Escape end only the browser wait; the server may still commit the change. **Check request status** reads the exact request made from your administrator account. **Applied** confirms that request's committed details, which may differ from the person's access now if a later edit followed. **Not found** does not rule out a delayed request. **Cancel this request** blocks a not-yet-committed request; if the change already applied, it reports the result but does not roll it back. The original request is not resent automatically. A status error or a changed sign-in must not be treated as success or safe cancellation. Keep the displayed request ID and review available until the outcome is clear; leaving or reloading this page loses its in-memory review.

The last active administrator cannot be demoted or disabled. Give another active person the administrator role first. Changing your own role or access intentionally signs you out. If its response is lost, the revoked session cannot use administrator-only request status or cancellation. Sign in again only if the resulting account still permits it; if you no longer have administrator access, ask another administrator to inspect the account's current access. Their account cannot read your exact request record. A password change keeps its current browser session but signs out the others. **Sign out other sessions** keeps only the browser that requested it.

## Prepare a useful problem report

Record the instance and agent version, Vector version, OS/architecture, device ID, relevant timestamps and timezone, reported stage, deployment/version ID and any request ID shown. Include the steps that caused the issue and a minimal synthetic configuration when possible. Review local diagnostic output before sharing it: paths and identifiers may be sensitive even when credential values are omitted.

Do not attach enrollment/recovery tokens, private keys, cookies, authenticator secrets, secret-provider files or the rendered managed configuration containing credentials. Share the report through your organization's approved support channel; Vectory does not automatically upload a support bundle.
