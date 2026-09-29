# Administer Vectory

Use this guide when you operate the Vectory server or manage workspace accounts. To connect a workload host to an existing instance, use [Install an agent](#/docs/installation).

## Plan the installation

The supplied deployment runs one Vectory server, a TLS proxy and an isolated Vector validator on a Linux Docker host with Compose. Use durable local storage and a DNS name with an issued certificate. The dashboard uses HTTPS port 443; agents use a separate HTTPS listener on port 8443. Keep the internal HTTP and validation ports private.

The server database and keys belong together in the persistent `data` volume. Run one active server against that volume. Network filesystems and active-active replicas are not supported by this SQLite deployment.

Read [Compatibility and release evidence](#/docs/compatibility) before choosing a host or promising platform support. The Compose definition has been checked, but container build/start and isolation still need acceptance on a Docker-capable host. The instructions below describe the deployment procedure, not a completed production certification.

## Start a new server

Run these commands from the repository root. Replace example paths and the hostname with your own values.

1. Prepare the issued TLS certificate chain and private key in a protected host directory. Container UID/GID `10001` must be able to read them. On Linux, a root-owned directory with group `10001`, mode `0750`, and files mode `0440` is suitable.
2. Build the server image:

```sh
docker build -f deploy/Dockerfile -t vectory-local:development .
```

3. Create a random bootstrap secret in that protected directory. The following command writes it to a file without displaying it:

```sh
docker run --rm --entrypoint python3 vectory-local:development -c 'import secrets; print(secrets.token_hex(32))' > /protected/path/bootstrap
```

4. Give the bootstrap file the same restricted group and file permissions as the TLS files. Copy `deploy/.env.example` to `deploy/.env`. Set `VECTORY_HOSTNAME`, the absolute certificate/key/bootstrap paths, and `VECTORY_RELEASES_DIRECTORY`. An empty release directory is allowed; the download screen will have no available artifacts until you supply them.
5. Check the deployment and start it:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail 100 server proxy validator
```

6. Open `https://YOUR_HOSTNAME`. Use the bootstrap secret to create the first administrator. There is no default account or public signup. After setup, replace the mounted bootstrap file with a new random unused value and restart the server; the database retains the initialized state.

The first build needs dependency registries and container images. For an offline installation, prepare the images and dependency caches in advance. Once built, the dashboard and help pages are served by this instance; external reference links still need internet access.

The validator must remain isolated from production files, credentials and external networks. Do not run it directly under a production server account merely by setting its isolation environment flag. A configured but unavailable validator blocks publication. Configurations needing device resources may instead report native validation as deferred.

## Create workspace accounts

Open [**Settings → People & security**](/#/users) → **Add person**. Enter the person's name, email, initial password and role. The password must have at least 12 characters; share it through a protected channel. Account creation does not send an invitation email.

**Create user** sends one uniquely identified request after confirming that this server supports request tracking. If the response stalls, **Stop waiting** closes the dialog and **Review account creation** keeps that request available on this page. Check its exact status before trying to add the person again. **Not found** is only a current snapshot: choose **Cancel this request** to block a late creation before starting a new request. If it already created the account, find the person under **Workspace access**. The submitted password is cleared and cannot be recovered here; issue a password reset code if its value is unknown. See [account-creation recovery](#/docs/troubleshooting#account-creation-is-not-confirmed).

- **Viewer:** read devices, pipelines and activity.
- **Editor:** read the workspace and create, edit and validate pipeline drafts.
- **Operator:** read the workspace, publish and deploy pipelines, schedule changes and manage groups, agent settings, enrollment tokens and device access.
- **Administrator:** use all workspace controls, including enrollment, account administration and device recovery.

Editor and operator are separate roles, not successive permission levels. Choose the role needed for the person's work.

## Change access or offboard a person

In [**Settings → People & security**](/#/users), find the person under **Workspace access** and choose **Edit access**. An administrator can change the full name, role or workspace access; email addresses are not editable here. Review the person's identity and the proposed changes, enter your own current password, then select **Save access**. The password is cleared when you submit the change.

The change is sent as one uniquely identified request after the dashboard checks that the server can track it. If the response stalls, **Stop waiting** ends the browser wait but does not stop a change already received by the server. **Review access change** keeps the exact request available while this page remains open. **Check request status** can confirm the edit's committed result. **Not found** is only a snapshot; it does not prove a delayed request cannot still apply. **Cancel this request** fences a request that has not committed. If the edit already committed, cancellation reports that result and cannot undo the access change. Review the account's current details before making another change; a later edit by someone else may differ from this request's committed result. See [access-change recovery](#/docs/troubleshooting#access-changes-and-rejected-requests).

Changing the role or access state signs out that person's browser sessions and cancels unused password reset codes. Disabled accounts cannot sign in. Their account and existing history remain available; disabling a person does not delete their pipelines or stop agents. Re-enabling the account permits a new sign-in but does not restore old sessions or reset codes. Changing only a person's name keeps their sessions.

Demoting or disabling an administrator also revokes their unused reset codes issued for other people. The issuer-tracking upgrade invalidates older codes that could not be attributed to an administrator; issue a fresh code if someone was in the middle of a reset during that upgrade.

For offboarding, disable workspace access first, then separately review any device credentials, local secrets or infrastructure access that person controlled. Vectory account access does not revoke credentials held outside Vectory.

At least one administrator must remain active. Make another person an administrator before demoting or disabling the last one. If someone else changes the account while your dialog is open, use **Load latest details** and review the current values before trying again. Changing your own role or access signs you out when the change succeeds. If that response is lost, your revoked session cannot check the administrator-only request status. Sign in again if you still have access, or ask another administrator to verify the account's current access; they cannot claim your exact request status from their own account.

## Change your password or close other sessions

Under your account in [**People & security**](/#/users), choose **Change password**. Enter your current password and the new password twice. The new password must have at least 12 characters. A successful change keeps this browser signed in with a new session, signs out all other browsers and invalidates unused password reset codes for your account and codes you issued for others. MFA remains enabled if you already use it.

Choose **Sign out other sessions** when you want to keep this browser signed in while closing other Vectory sessions. Confirm with your current password. This action does not change your password or recall reset codes you previously issued. Change your password if someone else may know it; that also invalidates your unused issued reset codes.

Both actions stop waiting after 30 seconds. You can also use **Stop waiting**, the close button or Escape. Ending a wait does not cancel a change that reached the server. Password fields are cleared after submission and are never saved for replay.

If a password change is not confirmed, choose **Go to sign in** and try the new password you chose, with two-factor verification if enabled. If a session sign-out is not confirmed, **Review another sign-out** asks for your current password again and explicitly includes other sessions created since the earlier attempt. Neither action silently resubmits the earlier request. [Recover an interrupted account change](#/docs/troubleshooting#a-password-change-or-session-sign-out-is-not-confirmed) explains these outcomes.

## Help someone reset a forgotten password

1. As an administrator, find the active account under **Workspace access** and choose **Reset password**. Confirm with your own current password and select **Create reset code**.
2. Copy the displayed code and share it through a protected channel. It is shown once by the server, expires after 15 minutes and can be used once. **Hide for now** keeps this browser's copy on the page; **Show reset code** opens it again. Choose **I've shared the code** when finished. Creating another code replaces the previous one. Issuing a code does not yet change the person's password or sign out their sessions.
3. Ask the person to select **Reset password** on the Vectory sign-in page, enter the code and choose a new password. After the password is set, they must sign in normally. Successful reset signs out their existing sessions.

Reset codes cannot be used for disabled accounts. Re-enable access only after reviewing why it was disabled, then issue a fresh code. Vectory does not send password reset email. A password reset does not disable MFA, replace an authenticator or restore used recovery codes.

If issuing a code has no confirmed reply, choose **Review reset request** on this page. **Check request status** reads the exact request without revealing its code. **Not found** is only a snapshot and an in-flight issue may still complete. **Cancel this request** blocks that late issue or revokes its unused code before you start another. If a code was already used, cancellation cannot undo the password change. Closing the dialog or selecting **Stop waiting** only stops the browser wait; your password entry is cleared. Resolve the request before leaving the page, because its ID and any displayed code are held only in this browser tab. See [reset-code recovery](#/docs/troubleshooting#an-administrator-reset-code-is-not-confirmed).

If the person submitted a code and their own password-reset response was interrupted, ask them to return to sign-in and try the new password they chose before requesting another code. A timeout does not prove their reset failed; its one-use code may already be consumed.

## Set up an authenticator

1. In [**People & security**](/#/users), choose **Set up authenticator** under your account and confirm your current password.
2. In your authenticator app, add an account and scan the QR code. If the app is installed on the device you are using, **Open authenticator app** passes the setup to its registered app handler. If scanning or opening the app is unavailable, expand **Can’t scan the code?** and use **Copy setup key** to add a time-based account manually.
3. Enter the app’s current six-digit code and select **Enable two-factor authentication**. Scanning alone does not enable MFA. An incorrect code can be retried. If this QR no longer works, **Start a new setup** asks for your password and creates a different key. If Vectory cannot confirm the result, check the current status before starting again.
4. Save the eight single-use recovery codes somewhere private outside the Vectory server. You can hide and reopen the codes in this browser tab until you mark them saved. Once you leave or acknowledge them, the server cannot show the same codes again.
5. On a later sign-in, enter your email and password first. Vectory then asks for an authenticator code. If necessary, choose **Use a recovery code instead** with one unused recovery code, then **Verify and sign in**. You are signed in only after verification succeeds.

The QR code is generated inside your browser, without an external QR service. Treat it and the manual setup key as private. **Hide setup** closes the dialog but keeps its QR in this tab so you can continue. Reloading or leaving discards the browser's copy; Vectory warns before leaving. A pending server setup expires after ten minutes. A new setup can invalidate a previous QR, so confirm with the current authenticator code before relying on it.

If a setup, confirmation or disable request stops waiting, **Check current status** reads only whether an authenticator is enabled now. It cannot prove which request finished or recover an unread setup key or recovery codes. Vectory never resends the request automatically. A lost confirmation response can leave MFA enabled without retrievable recovery codes; keep your working authenticator, then deliberately disable and set it up again to obtain new codes. A lost disable response should not be blindly resent because another disable can revoke newer sessions. If your sign-in changes while codes or a setup key are visible, this tab hides them. [Recover an interrupted authenticator change](#/docs/troubleshooting#an-authenticator-change-is-not-confirmed) gives the steps for each result.

Keep the server and authenticator clocks accurate. Enabling or disabling MFA revokes other browser sessions. The instance bootstrap secret cannot bypass an existing account's MFA. An administrator-issued password reset code changes only the password. There is no MFA-reset workflow for a person who has lost both their authenticator and all recovery codes.

If you lost your authenticator but still have recovery codes, sign in with one unused code. In **People & security**, choose **Disable authenticator**, then **Use a recovery code instead**. Confirm your password and a different unused recovery code; the sign-in code has already been consumed. Once disabled, choose **Set up authenticator** to register its replacement and save the new recovery codes. Previously issued codes become invalid when the old authenticator is removed.

## Back up the complete state

Back up before upgrading, restoring or rotating signing keys. A copy of only the live `vectory.db` file can omit committed WAL data. The supplied `deploy/backup.py` uses SQLite's backup API, includes the complete key tree and optional artifact directory, and checks database integrity. Pause key rotation, migrations and external artifact writes during the snapshot; stop the server for a stronger maintenance boundary.

For a running Compose instance, replace `backup-UNIQUE` with a new name:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec server python3 /app/operations/backup.py backup --state /var/lib/vectory --out /var/lib/vectory/backup-UNIQUE
docker compose --env-file deploy/.env -f deploy/compose.yaml cp server:/var/lib/vectory/backup-UNIQUE /private/backups/
```

Keep an encrypted, access-restricted copy outside the server volume. Back up externally provisioned TLS material, Compose settings and release mirrors separately. The snapshot manifest contains file hashes; it is not a signed backup or encryption. Check destination permissions, particularly when copying to Windows.

## Restore or upgrade

Stop the server before restoring. Using the checked-out source and Python, restore to a new destination that does not already exist:

```sh
python3 deploy/backup.py restore --from /private/backups/backup-UNIQUE --out /private/restored-vectory
```

The restore tool checks the manifest, file hashes and database integrity. Keep the original state intact. Provision the restored state into a new volume or directory with the server identity's private permissions, including the complete `keys/` tree and `mfa-sealing.key`. Restore the matching TLS files. Keep dashboard and agent listeners isolated from ordinary users/devices until both access and generation recovery are reviewed.

An old backup also restores old passwords, roles, disabled-account state, device revocations and unused-code records. Before starting the restored server, confirm that an authorized administrator knows the restored password and has a working authenticator if MFA is enabled. Then preview and explicitly apply access invalidation as the server's operating-system identity:

```sh
vectory-admin --data-dir /private/restored-vectory invalidate-restored-access
vectory-admin --data-dir /private/restored-vectory invalidate-restored-access --apply
```

The first command shows counts without invalidating access. The second atomically signs out all browser sessions, deletes all password reset codes and MFA recovery codes, and revokes all enrollment/device-recovery tokens. It records an audit event and refuses to run against a live server. **Every saved MFA recovery code becomes unusable; a working authenticator remains required.** Passwords and MFA enrollment are preserved, so this is not an MFA-reset or account-recovery bypass.

Next, start one server in an isolated administrative network. Reconcile post-backup offboarding, roles, passwords, authenticator changes and device revocations using reviewed change records. The command cannot discover or repair that missing history and does not change devices, deployments or generation counters. Keep access isolated when those decisions cannot be established. After review, users with a working authenticator can disable and set up MFA again to obtain new recovery codes. Issue new enrollment tokens only when needed. Confirm login/MFA, rejected old sessions/codes, credential renewal, artifacts and deployment history before reconnecting ordinary users or devices.

An older backup can advertise generations below those already accepted by agents. Agents correctly reject that state. Keep rollouts paused; never delete agent state or lower counters to bypass the rejection. While the server is stopped, the supplied maintenance binary exports a report for review:

```sh
vectory-admin --data-dir /var/lib/vectory generation-recovery-state
vectory-admin --data-dir /var/lib/vectory recover-generations --report /protected/reviewed.json
vectory-admin --data-dir /var/lib/vectory recover-generations --report /protected/reviewed.json --apply
```

Save the first command's JSON as UTF-8. Fill its initially null counters from each known device's actual durable state: highest configuration generation, highest policy generation and highest secret attempt revision. Review the restored version, digest and policy before previewing and applying the report. If counters or identity cannot be recovered, use explicit device identity recovery and reassignment; do not guess. The full report format is documented in the source distribution's `server/README.md`.

For an upgrade, retain the previous image digest and Compose configuration, take a snapshot and test restoring it. Start the new image against a copy of that state first. Confirm migration, account access and representative device heartbeats before replacing production. If an upgrade fails, restore the complete pre-upgrade snapshot to a new volume with the previous image. Do not assume an older binary can read a migrated database.

## Monitor the instance

Watch available disk space, database growth, backup age and server/proxy/validator logs. `VECTORY_TELEMETRY_RETENTION_DAYS` defaults to seven and accepts 1–30 days. Security audit history is separate and is not automatically pruned. `VECTORY_MAX_AGENT_CONNECTIONS` is an admission bound, not a tested fleet-capacity promise.

Use [Troubleshoot a problem](#/docs/troubleshooting) for device and rollout symptoms. Keep the source distribution's `docs/BACKUP-RESTORE.md` with your operational runbook for signing-key rotation and recovery details.

## Review and export audit events

Open [**Activity → Audit log**](/#/audit) to review who changed a pipeline, deployed a version or changed access. All signed-in workspace roles can read and export this history. The list loads 12 events at a time; search and filters apply to the whole recorded history.

Use **Search activity** for event metadata. Column-header filters narrow **Event** to a group or action, **Result** to an outcome, and **Time** to a date range. When following an actor's activity, **By** shows that actor scope and lets you clear it. Select a sortable column title to change the order, then select it again to reverse it. Dates cover whole days in UTC, including both endpoints. Search does not inspect free-form reasons, credentials or raw diagnostic content. An empty result means no recorded events match the current filters.

Select an event to open **Event details**, including the recorded reason and request ID when available. **Event link** copies a direct link with the current filter context. People and resource names are current labels for their recorded IDs; they are not claims about the names in use when the event occurred. Older events may have fewer details.

For **Group updated**, **Previous group revision** and **Group revision** identify the version before and after the saved edit. Revision zero is a valid starting point for a group created before revision tracking. Older events show **Not recorded** where a value was not stored; Vectory does not infer it from the current group. Recorded revision values also appear in the event details of JSONL exports. These values identify a group edit, not device application of its assignments.

From a device's activity, **View device activity** opens audit history tied to that device identity. It does not infer earlier activity from the device's current group membership or name. Follow the event's device or target link when available; identifiers without a known destination remain plain text.

To export the matching events:

1. Choose **Export results** and review **Included events**. The export includes all matching pages.
2. Choose **Prepare export**. The server creates a consistent snapshot; events recorded afterward are excluded.
3. When **File ready** appears, review the exact event count, file size and expiry, then choose **Download JSONL**. Check your browser's downloads to confirm completion.

[JSONL](#/docs/glossary#export-formats) stores one JSON object per line. The file contains snapshot metadata, event records and a final completion record. **File verification** shows the SHA-256 digest of the complete file. Keep the complete file if you need to check its integrity.

Prepared files expire after ten minutes and require the same signed-in session that created them. Reopen **Export results** to find **Earlier prepared files**, each with its original filters. Use **Discard** to free an earlier file, or **Discard file** for the file currently shown; neither deletes audit events. Each export supports up to 100,000 events, 128 MiB and two minutes of preparation. If a limit is reached, narrow the date range and prepare again. Vectory reports an error instead of presenting a partial export as complete.

This is an on-demand export. It does not continuously forward audit events to another service.
