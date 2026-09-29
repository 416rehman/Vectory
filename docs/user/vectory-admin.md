# vectory-admin

`vectory-admin` is the offline maintenance tool for a Vectory server. Use it after restoring a backup, to rotate signing keys, and for break-glass account recovery.

## Usage

```text
vectory-admin --data-dir PATH <command> [flags]
```

- **Stop the server first.** `vectory-admin` takes the same exclusive lock on the data directory and refuses to run next to a live server.
- Run it as the server's operating-system account, against the server's data directory. The Compose image includes it at `/usr/local/bin/vectory-admin`; run it in a one-off container that mounts the same `data` volume as UID 10001.
- Commands that change data preview first. Add `--apply` to make the change. Every applied change is recorded in the audit log.

`vectory-admin --help` lists the commands.

## Commands

| Command | What it does |
| --- | --- |
| [`invalidate-restored-access`](#invalidate-restored-access) | After a restore, end every session and revoke reset links, recovery codes and enrollment tokens. |
| [`generation-recovery-state`](#generation-recovery-state) | Export each device's configuration counters for review after a restore. |
| [`recover-generations`](#recover-generations) | Raise configuration counters above what devices already accepted, from a reviewed report. |
| [`rotate-signing-key`](#rotate-signing-key) | Create a new manifest signing key. |
| [`prune-signing-keys`](#prune-signing-keys) | Delete old signing keys that no valid device credential still uses. |
| [`reset-password`](#reset-password) | Create a single-use password reset link for an account. |
| [`disable-mfa`](#disable-mfa) | Turn off two-factor sign-in for an account that lost its authenticator. |

## invalidate-restored-access

A restored backup brings back old sessions, reset links, recovery codes and tokens. This command removes them in one step.

```sh
vectory-admin --data-dir /var/lib/vectory invalidate-restored-access
vectory-admin --data-dir /var/lib/vectory invalidate-restored-access --apply
```

The first command shows counts only. With `--apply` it signs out every browser session, deletes all password reset links and two-factor recovery codes, and revokes all enrollment and device-recovery tokens. Passwords, roles, authenticators, devices and deployments stay as restored.

> [!WARNING]
> **Saved recovery codes stop working**
> After `--apply`, every account with two-factor sign-in needs its working authenticator. Make sure at least one administrator has theirs before you run it.

## generation-recovery-state

Export the devices and their counters as JSON, for review.

```sh
vectory-admin --data-dir /var/lib/vectory generation-recovery-state > report.json
```

The counters in the export are `null` on purpose, so an unreviewed report can't be applied. Fill them in as described next.

## recover-generations

Devices remember the highest configuration generation they accepted and refuse anything older. After restoring an older backup, raise the server's counters above theirs.

<!-- steps -->
1. For each device, read its counters on the host with `sudo vectory status --json`: `state.highest_generation`, `state.highest_policy_generation` and `state.secret_revision`.
2. In `report.json`, fill in `highest_generation`, `highest_policy_generation` and `highest_secret_revision` (from `secret_revision`) for each device. Leave nothing `null`.
3. Preview, then apply:

   ```sh
   vectory-admin --data-dir /var/lib/vectory recover-generations --report report.json
   vectory-admin --data-dir /var/lib/vectory recover-generations --report report.json --apply
   ```

4. Start the server and confirm fresh check-ins before you resume rollouts.

The report looks like this:

```json
{
  "devices": [{
    "device_id": "THE-EXISTING-DEVICE-UUID",
    "highest_generation": 42,
    "highest_policy_generation": 19,
    "highest_secret_revision": 7,
    "expected_version_id": "THE-REVIEWED-VERSION-ID-OR-NULL",
    "expected_sha256": "THE-REVIEWED-ARTIFACT-SHA256-OR-NULL",
    "expected_policy_sha256": "THE-EXPORTED-CANONICAL-POLICY-SHA256"
  }]
}
```

Use `null` for the version and artifact fields of a device with no pipeline. The whole operation stops if any device is unknown or revoked, appears twice, has a missing counter, or doesn't match the reviewed version and policy. `--apply` moves each counter one past the value you supplied, resets rollout evidence for those devices and records the change.

> [!CAUTION]
> Never lower or delete a device's counters to make it accept a configuration. If you can't read a device's counters, recover its identity instead: see [Recover a device identity](agents.md#recover-a-device-identity).

## rotate-signing-key

Create a new key for signing device manifests.

```sh
vectory-admin --data-dir /var/lib/vectory rotate-signing-key
```

New enrollments and renewed credentials use the new key. Existing devices keep their current key until their next certificate renewal, so keep `keys/signing-history/` with the database. Back up before you rotate.

## prune-signing-keys

Delete old signing keys that no unexpired, unrevoked credential still uses.

```sh
vectory-admin --data-dir /var/lib/vectory prune-signing-keys
```

At most four old keys are kept. Never delete a key by hand just because a newer one exists.

## reset-password

Create a single-use password reset link when no administrator can sign in:

```sh
vectory-admin --data-dir /var/lib/vectory reset-password \
  --email admin@example.com --url https://vectory.example.com
```

It prints a link and the bare code, valid for 1 hour. Start the server again, then send the link through a trusted channel. The person opens it, or chooses **Forgot password?** on the sign-in page and pastes the code. Two-factor sign-in stays on; if the authenticator is lost too, also run `disable-mfa`.

## disable-mfa

Turn off two-factor sign-in for an account whose authenticator and recovery codes are both lost.

```sh
vectory-admin --data-dir /var/lib/vectory disable-mfa --email admin@example.com
```

The person can then sign in with their password and set up a new authenticator. Their sessions are signed out, and the change is recorded in the audit log. On an account without two-factor sign-in, the command changes nothing and exits 1.
