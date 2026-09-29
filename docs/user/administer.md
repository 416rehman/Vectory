# Administer Vectory

Run your Vectory server: manage people and sign-in security, back up and restore, upgrade, and keep an eye on the instance. To install a server, see [Install the server](install-server.md).

## Create workspace accounts

Open [**Settings → People & security**](/#/users) and choose **Add person**.

- **Invite link** (recommended): Vectory creates a single-use link that expires after 24 hours. Send it through a channel you trust. The person chooses their own password and is offered two-factor sign-in.
- **Set a password now:** choose a password of 12 characters or more and share it privately. Vectory doesn't send email.

Pick the role the person's work needs:

| Role | Can do |
| --- | --- |
| **Viewer** | View devices, pipelines, deployments and activity; export the audit log. |
| **Editor** | Viewer access, plus create, edit, check and organize pipeline drafts. Cannot publish or deploy. |
| **Operator** | Viewer access, plus publish and deploy, and manage schedules, groups, agent settings, enrollment tokens and device access. Cannot edit drafts. |
| **Administrator** | Everything, including managing people and recovering device identities. |

Editor and Operator are separate jobs, not levels. Someone who both builds and ships pipelines needs Administrator.

## Change access or offboard a person

In **People & security**, find the person and choose **Edit access**. You can change their name, role or whether they can sign in. Confirm with your own password and choose **Save access**.

- Changing someone's role or turning off their access signs them out everywhere and cancels their unused reset links. Changing only their name doesn't.
- Their pipelines, deployments and history stay.
- At least one active administrator must remain. Promote someone else first.
- Changing your own role signs you out.

Offboarding someone from Vectory doesn't revoke credentials they hold elsewhere, such as device access or secrets on hosts. Review those separately.

## Change your password or close other sessions

In **People & security**, under your account:

- **Change password** keeps this browser signed in and signs out every other session. It also cancels unused reset links you created for others.
- **Sign out other sessions** keeps this browser signed in and ends the rest, without changing your password.

The sessions list shows where you're signed in. Sign out any session you don't recognize, then change your password.

## Help someone reset a forgotten password

<!-- steps -->
1. In **People & security**, open the person's actions and choose **Reset password**. Confirm with your own password and choose **Create reset link**.
2. Send the link privately. It works once, for 15 minutes, and replaces any earlier link.
3. The person opens it, chooses a new password and signs in. Two-factor sign-in stays on.

A reset link changes only the password. Disabled accounts can't use reset links. If no administrator can sign in at all, use [`vectory-admin reset-password`](vectory-admin.md#reset-password) on the stopped server.

## Set up an authenticator

<!-- steps -->
1. In **People & security**, choose **Set up authenticator** and confirm your password.
2. Scan the QR code with your authenticator app, or expand **Can't scan the code?** and choose **Copy setup key**. The QR code is generated in your browser, without any outside service.
3. Enter the app's current six-digit code and choose **Enable two-factor authentication**. The setup expires after 10 minutes.
4. Save the eight single-use recovery codes somewhere safe, outside Vectory. They can't be shown again.

From then on, sign-in asks for your password, then a code from the app. If you don't have the app, choose **Use a recovery code instead**.

> [!IMPORTANT]
> **Keep recovery codes somewhere else**
> If you lose both your authenticator and your recovery codes, another administrator must reset two-factor sign-in for you. Keep the server's and your phone's clocks accurate.

To replace a lost authenticator, sign in with a recovery code, choose **Disable authenticator** (it asks for your password and a second unused recovery code), then set up the new one. Turning two-factor sign-in on or off signs out your other sessions.

An administrator can choose **Reset two-factor** for a person who lost both, confirmed with the administrator's password. If no administrator can sign in, use [`vectory-admin disable-mfa`](vectory-admin.md#disable-mfa) on the stopped server.

## Back up the complete state

The data volume holds the database and the server's keys, and they only work together. Back them up together with the supplied tool, which uses SQLite's backup API and checks integrity. Copying a running database file can miss recent changes.

With Compose, from the `deploy` folder:

```sh
docker compose exec server python3 /app/operations/backup.py backup \
  --state /var/lib/vectory --out /var/lib/vectory/backup-2026-09-29
docker compose cp server:/var/lib/vectory/backup-2026-09-29 /srv/backups/
```

Use a new folder name for each backup.

- Keep backups encrypted and access-restricted, off the server: they contain the server's private keys.
- Back up your TLS files, `deploy/.env` and any agent download mirror separately.
- Avoid rotating signing keys or upgrading while a backup runs. For the strongest guarantee, stop the server first.
- The backup's manifest lists file hashes. It detects damage; it isn't a signature.

## Restore a backup

Restore into a new, empty folder while the server is stopped, and keep the current state untouched:

```sh
python3 deploy/backup.py restore \
  --from /srv/backups/backup-2026-09-29 --out /srv/restored-vectory
```

The tool checks the manifest, hashes and database integrity. Give the restored folder to the server's account (UID/GID 10001 in Compose) with private permissions, including the whole `keys/` folder and `mfa-sealing.key`.

An old backup also restores old decisions: accounts that were disabled, old roles and passwords, revoked devices, used codes and tokens. Before anyone reconnects:

<!-- steps -->
1. Confirm an administrator can sign in to the restored state, with a working authenticator if they use one.
2. With the server stopped, end old sessions and revoke old codes and tokens: [`vectory-admin invalidate-restored-access`](vectory-admin.md#invalidate-restored-access), first without and then with `--apply`.
3. Start the server on an isolated network. Re-apply every access change made since the backup: offboarding, roles, passwords and device revocations.
4. If devices accepted newer configurations than the backup knows, [raise the generation counters](vectory-admin.md#recover-generations) before resuming rollouts.
5. Reconnect people and devices, and confirm fresh check-ins.

> [!CAUTION]
> Never delete a device's state, lower its counters or re-enroll it to make it accept an older server. Devices refuse older configurations on purpose.

## Upgrade the server

<!-- steps -->
1. [Back up](#back-up-the-complete-state) and test restoring the backup.
2. Note the current image digests and keep a copy of `deploy/.env`.
3. Try the new version against a copy of the restored state first. Confirm the database migrated, people can sign in and representative devices check in.
4. Upgrade production: update the source, then `docker compose up -d --build` from `deploy`.

The first start after an upgrade migrates the database before the server answers. Some upgrades build an index over stored telemetry, so that start can take a while when the telemetry table is large. Let it finish.

If a migration fails, nothing from it is kept: the database stays at the previous migration, and the server stops with a message that names the failed migration, its cause and where the database stands. Fix the cause and start again, or restore the pre-upgrade backup.

Migrations only move forward. An older server refuses a database that a newer one migrated, so going back to a previous version means restoring its backup: if an upgrade fails, stop and restore the pre-upgrade backup into a new volume with the previous image.

## Rotate the signing key

Devices check manifests with the server's signing key. To rotate it, back up, stop the server and run [`vectory-admin rotate-signing-key`](vectory-admin.md#rotate-signing-key). Devices move to the new key at their next certificate renewal.

## Rotate the device certificate authority

The server's device certificate authority (CA), `keys/device-ca.pem`, signs every device's certificate. It's valid for 10 years. Rotate it before it expires, or when your policy asks for a new one. Devices keep working throughout.

<!-- steps -->
1. [Back up](#back-up-the-complete-state), then stop the server.
2. Run [`vectory-admin rotate-device-ca`](vectory-admin.md#rotate-device-ca). It prints the new and previous CA fingerprints and how many devices hold certificates from the previous CA.
3. Start the server. Certificates from either CA are accepted. New devices, and devices that renew, get certificates from the new CA.
4. Watch **Settings → General → Device certificates** until no device uses the previous CA. Devices renew in their certificate's last day, so this takes up to 30 days; a device that renewed keeps its old certificate as a fallback for another 24 hours. To stop waiting for a device that won't come back, revoke it on its device page.
5. Stop the server and run [`vectory-admin retire-device-ca`](vectory-admin.md#retire-device-ca). It checks, and names any device still on the previous CA. When it says **Ready**, run it again with `--apply`, then start the server.

After retirement the server refuses certificates from the previous CA. A device that missed the move needs [identity recovery](agents.md#recover-a-device-identity).

The CA key alone can't impersonate a device: every request also needs a certificate the server issued and still has on record. If you suspect the CA key leaked, rotate, then revoke any device you don't recognize.

## Monitor the instance

- **Disk:** watch free space and the database's growth.
- **Database load:** with `RUST_LOG=vectory_server=info,vectory_server::sqlite=debug`, the server logs once a minute how busy its single database writer was (`busy_percent`) and how long writes waited. A share that stays high means check-ins are queuing for the writer. See [Server settings](server-config.md#server-settings).
- **Backups:** track the age of your last good backup.
- **Logs:** `docker compose logs --tail 100 server proxy validator`.
- **Metrics history** is kept for [`VECTORY_TELEMETRY_RETENTION_DAYS`](server-config.md#server-settings) (7 days by default, up to 30). The audit log is kept separately and never pruned.
- **Connections:** `VECTORY_MAX_AGENT_CONNECTIONS` (16,384 by default) limits concurrent agent connections. It protects the server; it isn't a supported fleet size.

A 70-second load test on 2026-09-26 reached 10,000 simulated devices without errors. It measured check-ins only, with a debug build on a shared development host: no rollouts, downloads or real agents. There is no supported fleet size yet, so test with your own fleet before relying on large numbers.

## Review and export audit events

[**Activity → Audit log**](/#/audit) records who changed what, and when: pipelines, deployments, devices, settings and access. Every role can read and export it.

- Search, then filter the **Event**, **Result** and **Time** columns. Dates cover whole days in UTC.
- Select an event for its details, including the reason and request ID when recorded. **Event link** copies a link to it.
- Names show each person's and resource's current name; the recorded ID is what the event refers to.

To export:

<!-- steps -->
1. Choose **Export results** and check **Included events**.
2. Choose **Prepare export**. Vectory takes a consistent snapshot; later events aren't included.
3. When **File ready** appears, check the event count and size, then choose **Download JSONL**.

The file has one JSON object per line: snapshot details, the events and a completion record. **File verification** shows the file's SHA-256, so you can check you have all of it. An export holds up to 100,000 events or 128 MiB and must finish within two minutes; narrow the dates if you hit a limit. Prepared files expire after 10 minutes and download only in the session that created them.
