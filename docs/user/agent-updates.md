# Agent updates

A host is visited once for agent updates, when it is enrolled or first upgraded, and never again to update its agent. After that you roll out a signed build from the dashboard, a canary first, and a host installs it only if it agreed to updates and a key it pinned signed the build.

## How it works

A host never installs an agent build because the server said so. Four things decide, and the host checks each one itself:

| What | Who sets it | How the host uses it |
| --- | --- | --- |
| **Consent** | Someone on the host, once, through the **Add device** or **Upgrade agent** command. | A host with no consent, or with **Off**, never fetches a build. |
| **A pinned key** | You, by the fingerprint that command carries. | The host installs only a build signed by a key it pinned. |
| **A release counter** | The server numbers each release. | The host remembers the highest counter it tried, so it never tries a release twice and never goes back. |
| **A trial** | The host. | It keeps the old build, runs the new one for five minutes and takes it back if it doesn't check in healthy. |

The server's job is to offer a signed build, count what each device reports and stop when devices fail. With **A key kept offline** it can't sign a build at all.

> [!IMPORTANT]
> **Pinning a key trusts its holder with root on that host**
> A host that pins a key installs, as root, every build that key signs. Whoever holds the key can run software on every host that pins it. With **This server signs**, that is whoever administers the server or holds its backup. Choose who holds the key before you turn updates on, and keep an offline key off the server.

## Before you start

| You need | Why |
| --- | --- |
| The Administrator role and your password | Turning updates on or off and changing the release key ask for the password. |
| Hosts that were added with a choice about updates | A host agrees to updates when it is enrolled or first upgraded. See [What a host agrees to](#what-a-host-agrees-to). |
| A build in this server's catalog that devices don't run yet | **Devices → Agent updates** lists them under **Newer builds**. |
| For a key kept offline: a machine that holds the private key | You make the key and sign each release there with `vectory release`. See [Sign a release you keep offline](#sign-a-release-you-keep-offline). |

Agent updates are off until an administrator turns them on. While they're off, the dashboard shows nothing about them except this setting, no agent asks for an update and every other page works as before.

## Turn on agent updates

<!-- steps -->
1. Open [**Settings → Agent updates**](/#/agent-updates-settings) and choose **Turn on agent updates…**.
2. Under **Who holds the release key?**, choose **This server signs** or **A key kept offline**. Nothing is chosen for you. [Choose who holds the release key](#choose-who-holds-the-release-key) compares them.
3. For **A key kept offline**, paste the public key line into **Public key**. The dashboard computes the key's fingerprint from what you pasted and shows it, so you can compare it with what `vectory release keygen` printed.
4. Enter **Your password** and choose **Turn on agent updates**.

You should see **Agent updates are on**, the key's fingerprint under **Release key**, and a new tab, **Devices → Agent updates**.

Turning updates on changes nothing on any host. A host takes its first update only after it agreed to updates, and the first release is yours to prepare.

### Choose who holds the release key

| | **This server signs** | **A key kept offline** |
| --- | --- | --- |
| Where the private key is | On the server, sealed with the instance's own key. | On a machine you choose. The server holds the public half only. |
| Who can approve a build | Anyone who administers this server, or holds a backup of it. | Whoever holds the key file. |
| A prepared release | Signed at once, ready to roll out. | Waits for your signature: nothing is offered until you sign it. |
| Changing the key | **Rotate key…**: one step, and hosts follow by themselves. | **Upload rollover…**: you sign a statement with the old key. |

The choice is fixed while updates are on, because every host that pinned the key trusts that arrangement. To change it, turn updates off and on again with the other choice. That makes a new key. Hosts that pinned the old one take the new one only when you run their **Upgrade agent** command again, and **Settings → Agent updates** lists them under **Hosts that trust an older key**.

Choose **This server signs** to start quickly, on a server only a few people administer. Choose **A key kept offline** when no one with access to this server, or its backups, should be able to put software on your hosts.

## What a host agrees to

A host agrees to updates once, in the command you run on it. **Add device** and **Upgrade agent** show a step called **Agent updates** while updates are on. With updates off the step isn't there, and the command is the one you always had. Nothing is chosen for you:

| Choice | The host |
| --- | --- |
| **Automatic (recommended)** | Installs a new build when an update rollout reaches it, inside the window you set. |
| **Ask on the host** | Downloads and checks the build, then waits. Someone on the host runs `sudo vectory update apply` for each build. |
| **Off** | Updates only by hand. The command writes no key. |

**Ask on the host** is the one choice that needs a person on the host again. It isn't a visit to set anything up: it's the host's own decision, made each time, to install a build it already checked.

For **Automatic** and **Ask on the host** you also choose:

- **Which releases?** **Patch releases** (the default) takes new patch versions of the version it runs now. **Minor releases too** also takes new minor versions. A host never takes a new major version: upgrade to one by hand.
- **Update windows (optional).** When an update may start, one window per line, such as `Mon-Fri 02:00-04:00` or `Sat,Sun 01:00-03:00 UTC`. Times are the host's own unless `UTC` follows. A window decides when an install starts; a trial that began inside it can end after it. Empty means any time.
- **The key it pins.** The step shows it, for example `Pins key 3f9a1c0277de9b41 · kept offline`, so whoever runs the command sees what the host will trust. The command carries the key's full fingerprint, never a shortened one.

The command passes your choices to `vectory setup`. For example, **Automatic** with a window adds the last four lines below. Copy the real command from the dashboard: it carries your key's fingerprint, and nothing here is one to paste.

```sh
sudo sh "$dir/vectory-install.sh" \
  --mode restricted \
  --updates auto \
  --update-key-sha256 <64-hex-fingerprint> \
  --update-track patch \
  --update-window 'Mon-Fri 02:00-04:00'
```

The host's choices live in a file only root can write (SYSTEM and the Administrators on Windows): `/etc/vectory/updates/policy.json` on Linux, `/Library/Application Support/Vectory/updates/policy.json` on macOS and `%ProgramData%\Vectory\updates\policy.json` on Windows. Nothing the server sends can change them, and nothing changes them later unless someone runs a command on that host again. That command keeps what the host chose: with no update flag it changes nothing about updates, and to change one thing it carries only that thing, such as the key to pin or the releases to take. The host applies it to what it already agreed to, so a command never has to state the host's choices again. See [Change what a host agreed to](cli.md#change-what-a-host-agreed-to).

### A host that was installed without consent

A host you added before you turned updates on has agreed to nothing, and so has a host that reports no update information at all (its agent predates updates). It takes one more run of its **Upgrade agent** command, with a choice made there:

<!-- steps -->
1. On the device's page, choose **Upgrade agent**. Under **Agent updates**, choose **Automatic (recommended)**, **Ask on the host** or **Off**.
2. Run the command it shows on the host. Without a choice the command only upgrades the agent and changes nothing about updates.

A host that already takes updates shows **This device takes updates from the dashboard** in the same dialog, with **Roll out to this device**. Its **Upgrade agent** command carries no update choice: running it upgrades the agent and leaves what the host agreed to as it is. When something about updates needs fixing on that host, such as the key it pins or the releases it takes, the command carries only that fix.

<!-- verify-after-merge: that a Windows host takes updates in this release (windowsUpdatesInRelease is true in update_gate.go), and that the dashboard still writes no Upgrade agent command for Windows (upgradeCommand in dashboard/src/enrollmentCommands.ts returns none for it, and canOptIn in dashboard/src/AgentUpgrade.tsx follows updatesInRelease); if it now does, say so here -->
The dashboard writes the **Upgrade agent** command for Linux and macOS hosts. For a Windows host, **Add device** carries the choice about updates when you add it. A Windows host added before agrees with `setup`, run in an elevated PowerShell on the host with the flags of the command above, and the same command with one flag changes one thing it agreed to. See [Agent updates in setup](cli.md#agent-updates-in-setup).

### What a host needs to take an update

<!-- verify-after-merge: that a Mac takes updates in this release (the macos job of platforms.yml is green and macosUpdatesInRelease is true), and that setup's refusal for a Mac names the access list entry -->
<!-- verify-after-merge: that a Windows host takes updates in this release (the windows job of platforms.yml is green, agent-update.mjs phases included, and windowsUpdatesInRelease is true in update_gate.go), and that the Windows advice in the table below matches what the first run printed -->
Even with consent, a host takes an update only where it is safe to replace the agent. The dashboard shows what a host can't do, in words, on its page and in the review:

| The host says | What to do |
| --- | --- |
| **Installed by a package manager** (`PACKAGE_MANAGED`) | Update it with the package manager. |
| **No service keeps the agent running** (`NO_SERVICE`) | Run it under a service, then upgrade it with its **Upgrade agent** command. |
| **Install path others can write** (`UNTRUSTED_LOCATION`), **Install directory is read-only** (`READ_ONLY`) | Change who owns them or their permissions: only root may own and write the agent's directories and every directory above them. On a Mac, an access list entry that lets another account write, delete or add files counts too: `ls -led /usr/local/bin` shows the entries and `sudo chmod -N /usr/local/bin` removes them. Homebrew on an Intel Mac owns `/usr/local/bin`, so install the agent in another directory only root can write, with the installer's `--install-dir`. On Windows, only SYSTEM, the Administrators and TrustedInstaller may own or change the agent's directory, the agent and every directory above them: `icacls "C:\Program Files\Vectory"` shows who can, and the message names an account that holds a right to write, delete, add files or take ownership. Setup closes `%ProgramData%\Vectory`, where the update policy and the update step keep their files, to every other account. A folder in it that another account made is refused with that account's name: look at what it holds before you remove it, because that account could have changed it. |
| **Update step isn't running** (`HELPER_NOT_RUNNING`) | Run `sudo vectory doctor` on the host. It prints the fix. On Windows the step is the `VectoryUpdate` service: run `vectory doctor` in an elevated PowerShell, and `sc.exe query VectoryUpdate` shows whether it runs. |
| **Service definition is older than this release needs** (`SERVICE_DEFINITION_OUTDATED`) | Run the **Upgrade agent** command once. |
| **Not in this release** (`PLATFORM_NOT_IN_RELEASE`) | Update this host by hand. A release carries only the platforms in this server's catalog. An agent built without updates for its operating system says the same and refuses `setup --updates`. |

## Prepare a release

A release is a build from this server's catalog, with a counter, an expiry 180 days away and the signature hosts check.

<!-- steps -->
1. Open [**Devices → Agent updates**](/#/agent-updates). Under **Newer builds**, find the version and choose **Roll out agent 0.1.1** (an Administrator does this step).
2. Read what **Prepare agent 0.1.1** says and choose **Prepare release**.

With **This server signs**, the release is ready and the review opens. With **A key kept offline**, it appears under **Releases** as **Waiting for your signature**, and nothing is offered until you sign it.

Only a signed, unexpired release that isn't withdrawn can start a rollout. **Withdraw…** retires a release, with a reason. A withdrawn release can't come back: prepare it again for a new counter. You can keep 20 releases that aren't withdrawn, within the space `VECTORY_AGENT_RELEASE_STORAGE_BYTES` sets (2 GiB by default; see [Server configuration](server-config.md)).

### Sign a release you keep offline

You sign on the machine that holds the private key. The server never sees it.

<!-- steps -->
1. Once, make the key. `vectory release keygen` writes the private key to a file only you can read, prints the public key line and the fingerprint, and never replaces a file:

   ```sh
   vectory release keygen --out team.key --name team
   ```

   Keep `team.key` off the server and back it up somewhere you control. Paste the public key line when you [turn updates on](#turn-on-agent-updates).
2. On the waiting release, choose **Download release.json**. It is the exact file to sign: nothing re-writes its bytes.
3. Get `SHA256SUMS` for this version's builds from the project's release page, or from your own build of the same source. Don't take it from this server. The signer checks the manifest against that list, and a list from the server would only check the server against itself. From your own build:

   ```sh
   sha256sum vectory-0.1.1-linux-amd64 vectory-0.1.1-linux-arm64 > SHA256SUMS
   ```

4. Put `release.json` and `SHA256SUMS` beside the key and sign:

   ```sh
   vectory release sign --key team.key --checksums SHA256SUMS release.json
   ```

   It signs only when every build in `release.json` matches `SHA256SUMS`. It shows the version, counter, expiry and each platform, asks first and writes `release.json.sig`.
5. On the release, choose the file under **Signature file** and **Upload signature**. The page says which key the file holds a signature by before you send it. The server keeps the file only if it verifies against the current key.

You should see **Signature accepted** and the release turn **Ready**. Check a signature yourself first with `vectory release verify --key team.pub release.json`: it uses the same check every host does.

## Roll out an update

An update rollout is separate from a pipeline deployment. It has its own page and its own gates, and the two can't affect each other. It always starts with a canary and releases the rest in batches. There's no all-at-once.

<!-- steps -->
1. On a ready release, choose **Update devices…**, or choose **New update rollout** under **Update rollouts**. To update one device, choose **Roll out to this device** in its **Upgrade agent** dialog.
2. Choose the **Release**, then devices and groups. A group sends the update to the devices it holds when you start; a device that joins later isn't added.
3. Set the rollout: **Canary size** (default 1), **Then batches of** (default 10), **Watch each stage for** (default 300 seconds) and **Stop if more than** (default 0 failures: the first rollback or failure stops it). Add a **Name (optional)**.
4. Choose **Review**, read it ([Read the review](#read-the-review)), then choose **Start update rollout**.

Nothing starts until you choose **Start update rollout**, and the server checks that the review is still true when you do. If a device, the release or the key changed meanwhile, it starts nothing and asks you to review again. A rollout starts with every device **Pending** and releases its canary at once.

### Read the review

The review lists every device you chose exactly once:

- **Will update · N:** the devices that will take the build, with how each takes it (**Automatic** or **Ask on the host**) and when it can start. The canary is chosen for you, among devices that take updates by themselves, or by you with **Canary devices**. The canary's result is what its devices report, so name canary devices your team trusts.
- **Won't update · N:** each device that won't, grouped by the first reason that applies, with the fix. For a reason a command fixes, **Commands for the host** gives the **Upgrade agent** command for that host, with only the flag that fixes it: `--update-key-sha256` with this server's current key to re-pin, `--update-track minor` for the track. The host applies it to what it already agreed to and keeps the level, the windows and any pause as they are. For a host that has no consent to keep, you choose how it should take updates first.
- **Worth knowing:** devices that will update but may be slow: offline now, waiting for someone on the host, waiting for a window or paused on the host.

| Group | Means |
| --- | --- |
| **Updates are off on the host** (`UPDATES_OFF`) | Its consent is **Off**, or it never agreed. Run **Upgrade agent** with updates on, once. |
| **Agent too old, or no update report** (`AGENT_TOO_OLD`) | It predates updates and reports nothing about them. Run **Upgrade agent** once. |
| **Doesn't pin this release's key** (`KEY_NOT_PINNED`) | No key it pins reaches the release's signer. Run **Upgrade agent** with the current key. If a key that is no longer current signed the release, the review says so: a host follows keys forward only, so withdraw the release and prepare it again, and the current key signs it. |
| **Tried this release and rolled back** (`RELEASE_ALREADY_TRIED`) | It takes the next release, never this one again. |
| **Already tried a newer release** (`COUNTER_REPLAYED`) | This release's counter is at or below one the host tried. Prepare a new release. |
| **Outside the host's track** (`VERSION_NOT_ON_TRACK`) | It takes patch releases only. Run **Upgrade agent** with **Minor releases too**: the command carries only the track, and the host keeps its level and its windows. |
| **Already on this version** (`ALREADY_RUNNING`), **Runs a newer version** (`DOWNGRADE_REFUSED`) | Nothing to do. An update never goes backward. |
| **Frozen on a key fork** (`KEY_ROLLOVER_CONFLICT`) | It saw two successors of its key and accepts no update. Run **Upgrade agent** with the right key. See [If a key is stolen](#if-a-key-is-stolen). |
| **Installed by a package manager**, **No service keeps the agent running**, **Install path others can write**, **Install directory is read-only**, **Update step isn't running**, **Service definition is older than this release needs**, **Not in this release** | The host can't take an update. See [What a host needs to take an update](#what-a-host-needs-to-take-an-update). |
| **In another update rollout** (`IN_ANOTHER_UPDATE`) | A device has at most one unfinished update at a time. Wait for that rollout or cancel it. |

A device whose access was revoked can't be chosen for a rollout, and one revoked while a rollout runs is skipped.

### Watch a rollout

Open a rollout from **Devices → Agent updates**. The page shows how many devices updated, the stages and why devices rolled back or failed. A device counts as updated only when it checks in on the new build after the restart and its host reports it healthy. A download, a staged file or a swap never counts.

| State | Means |
| --- | --- |
| **Pending** | Waits for its stage to be released. |
| **Offered** | The offer reaches it at its next check-in. |
| **Downloading**, **Staged** | The agent is fetching and checking the build, or has it ready. |
| **Waiting for the host** | Staged on a host set to **Ask on the host**. Someone runs `sudo vectory update apply`. |
| **Waiting for its window** | Staged on an **Automatic** host with no window open. It installs when one opens. |
| **Applying**, **Trying the new build** | The host is swapping in the build, or watching it for five minutes. |
| **Updated** | The new build checked in after the restart and is healthy. |
| **Rolled back** | The host took the build back. It won't try this release again. |
| **Refused**, **Failed** | The host's own rules refused it, or the update failed. The page shows the agent's reason. |
| **Cancelled**, **Skipped** | It never started: the rollout ended first, the device never became ready, its access was revoked, its host dropped the offer (paused, turned updates off or took another release), or it stayed at **Offered**, **Downloading** or **Staged** for an hour. The page shows the host's reason when it gave one. |

Each stage waits until every device it released is done or waiting on its host, then watches them for the time you set. A device that falls back or goes silent restarts the watch, and a device whose pipeline stops delivering after the update counts as a failure. A device whose access was revoked, or that has been silent for longer than the watch lasts and three check-in intervals, is no longer watched: it doesn't hold the rollout back and doesn't count as failing. The canary also needs at least one **Updated** device that is still watched. A device silent for 30 minutes after it started applying becomes **Failed**.

When more devices roll back or fail than **Stop if more than** allows, the rollout stops. Devices already applying finish their trial. The rollout is **Completed** when no device is pending or waiting and every released one is done.

A device that waits for its host or its window keeps its offer, and offers come only from a rollout that is running, so the rollout stays **Active** until that device installs or you cancel the rollout. Later stages don't wait for it. You can't turn updates off while a rollout is active or paused, so cancel it first if nobody will approve the waiting hosts.

A rollout doesn't stay open for ever when nothing can move it:

- **A release expires.** Its rollouts end as **Cancelled**, as a withdrawal ends them. Devices already applying finish.
- **No progress for 24 hours.** A rollout that has devices it can't move on (none that can be released, a build that never changes state, an observation held by a device that stays on the old build) and made no progress for 24 hours ends as **Failed**, and says so. Unstarted offers are withdrawn and devices already applying finish. A change of any device, a stage released, a watch that starts or ends, or a resume counts as progress. Waiting for a person or a window is not stalled: that is by design, and you cancel the rollout when nobody will act.

### Pause, resume or cancel

On the rollout page, an Operator or Administrator can:

- **Pause:** stops releasing and withdraws every offer that hasn't started. Those devices return to **Pending** and their agents discard what they staged. Devices already applying finish.
- **Resume:** watches the current stage again from the start, then releases through the same gates.
- **Cancel rollout:** withdraws unstarted offers and ends the rollout. A cancelled or stopped rollout never resumes: review a new one for the rest.

## Stop all updates

**Stop all updates** is for the moment a build is wrong and you need every update to stop. It's on **Devices → Agent updates**, for Operators and Administrators. Give a reason; everyone sees it.

It cancels every update rollout, withdraws every offer and refuses new rollouts until an administrator chooses **Clear the stop** in **Settings → Agent updates**. Devices already trying a build finish. A device that already downloaded one may still start until its next check-in tells it of the stop, usually within a minute, and the update step looks for work every 30 seconds. A host that checks in less often takes longer. Clearing the stop resumes nothing: the rollouts it cancelled stay cancelled.

A server restored from a backup stops all updates too, as a local administrator, until an administrator has reviewed what the backup brought back. See [Restore a backup](administer.md#restore-a-backup).

## When a host rolls back

The host takes a build back when the new agent doesn't start, doesn't check in within five minutes, isn't healthy or is interrupted twice. It restores the previous build from a copy it kept, and reports the reason. The device shows **Rolled back** with that reason, and the dashboard opens an issue (**AGENT_UPDATE_ROLLED_BACK**) that appears in **Needs you** on the Overview. A host that had already started when you paused, cancelled or stopped the rollout, and then rolled back, is recorded the same way, once: the issue and the audit entry appear, and a paused rollout counts it toward its failure threshold.

**A rolled-back release is never tried again on that host.** The host remembers the release counter and the release, so even a new rollout can't make it try the same build twice. It takes the next release, which carries a higher counter. To retry, fix the cause, prepare a new release and roll it out.

Most rollbacks have one of these reasons:

| Reason | Means |
| --- | --- |
| **The new build couldn't start** (`START_FAILED`) | The new agent exited at once. |
| **The new build didn't check in within 5 minutes** (`NO_CHECK_IN`) | It started but couldn't reach the server. |
| **The new build started but wasn't healthy** (`UNHEALTHY`) | The service or Vector wasn't running as it was. |
| **The update was interrupted** (`INTERRUPTED`) | A crash or power loss stopped it more than once. |
| **The previous build isn't healthy either** (`ROLLBACK_UNHEALTHY`) | Run `sudo vectory update status` and `sudo vectory doctor` on the host. |

## Rotate or replace the release key

A key changes in one of two ways, and hosts follow either without a command. A statement signed by the old key names its successor. A host that pinned the old key follows it the next time it's offered a release the new key signed.

### Rotate a key the server holds

In **Settings → Agent updates**, choose **Rotate key…** and enter your password. The server makes a new key, signs a statement from the old key to it and retires the old one.

### Roll over a key you keep offline

<!-- steps -->
1. On the machine that holds the old key, make the new key, then the statement. `rollover` writes `rollover.json`:

   ```sh
   vectory release keygen --out team-next.key --name team-next
   vectory release rollover --key team.key --to team-next.pub
   ```

   Save the public key line `keygen` printed in `team-next.pub`.
2. In **Settings → Agent updates**, choose **Upload rollover…** and choose `rollover.json`. The page shows the new key's fingerprint, and the key it replaces.
3. Enter your password and choose **Upload rollover**.

The old key stays on record as retired, and **Hosts that trust an older key** lists the hosts that haven't followed yet. Custody doesn't change: a rollover moves an offline key to another offline key.

### Revoke a key

**Revoke key…** in **Key history** withdraws the releases only that key signed, ends the rollouts that offer them and removes the key and its statements from the key list hosts read. It can't be undone. Revoking the current key leaves updates on without a key: choose **Set a release key…** to start again. Nothing can be prepared until then.

### If a key is stolen

Revoking a key stops this server from offering anything it signed. It doesn't unpin the key on any host. A host trusts a key until someone runs its **Upgrade agent** command with another one. Do this:

<!-- steps -->
1. **Stop all updates**, so nothing signed by the stolen key goes out meanwhile.
2. Revoke the stolen key, then set a new one with **Set a release key…**.
3. Run each affected host's **Upgrade agent** command, which now pins the new key. It re-pins and changes nothing else: the host keeps its level, its track, its windows and any pause. **Settings → Agent updates** lists the hosts that pin the revoked key, and the review gives each one's command. This step stays manual, host by host.

A thief who holds the key before you roll it over can sign a statement of their own from it. A host that sees two successors of one key stops accepting updates and reports `KEY_ROLLOVER_CONFLICT`. **Settings → Agent updates** lists them as hosts frozen on a fork, and each one needs its **Upgrade agent** command with the key you trust.

## Update one host by hand

These are the host's own commands. They need `sudo` on Linux and macOS, and an elevated PowerShell on Windows.

```sh
sudo vectory update status
sudo vectory update apply
sudo vectory update pause
sudo vectory update resume
sudo vectory update off
```

- `status` shows the policy, the keys the host pins, what it is doing and the result of its last update.
- `apply` installs a build a host set to **Ask on the host** has staged. Before it does, it reads what the agent last reported and stops if the offer was withdrawn or the agent hasn't checked in for five minutes. That check is advice: the file it reads is written by the agent, so it can warn you but can't prove an offer is still good. `--force` applies anyway, after you confirm on a terminal.
- `pause` keeps the host's choices and stops every download and install until `resume`.
- `off` withdraws the host's consent: the policy says off, the build the agent staged is deleted and the update step is removed. The pinned key stays, so the **Upgrade agent** command with updates on turns them on again. It's refused while a build is being tried. Where the directory above the agent's state directory could be changed by another account, it deletes nothing and tells you the staged files are yours to delete; see [Agent CLI](cli.md#update-off).

Every verb but `status` needs root. See [Agent CLI](cli.md#update) for what each prints.

To change one thing a host agreed to, run `setup` on it with only that flag and no `--updates`: `--update-key-sha256` re-pins, `--update-track` changes the releases it takes, and `--update-window` replaces its windows. It keeps the rest, including a pause, and refuses a host that agreed to nothing. See [Change what a host agreed to](cli.md#change-what-a-host-agreed-to).

## Turn off agent updates

In **Settings → Agent updates**, choose **Turn off…** and enter your password. It's refused while an update rollout is running: cancel it, or choose **Stop all updates**, first. Hosts keep the consent they gave and the build they run. The key, who holds it and a stop are kept, so turning updates on again with the same key needs no re-pinning. While updates are off, Vectory doesn't read or keep what hosts report about updates, and it deletes what it had: each host reports again at its next check-in once you turn updates on. A device that was still finishing an update gets its waiting time again from the moment you turn them on, so it isn't failed for the time they were off.

## Limits

- **No major track.** A host takes patch releases, or minor releases too. A new major version needs an upgrade by hand.
- **Custody is fixed while updates are on.** To change who holds the key, turn updates off and on again. Hosts pinned to the old key then need their **Upgrade agent** command.
- **A release names only the platforms in this server's catalog.** A host whose platform isn't in it is listed as **Not in this release**: update it by hand. That is what macOS and Windows hosts do when their builds aren't in the release.
- **Updates only move forward.** A host never takes an older build. Going back is its own automatic rollback, or an upgrade by hand.
- **A rollout targets the devices the review found.** A device that joins a group afterwards isn't added, and a device is in at most one unfinished update rollout.
- **At most 200 update rollouts are active or paused at once.** The server reads every active one every two seconds, so the 201st is refused (`UPDATE_ROLLOUT_LIMIT`) until you cancel one or one finishes. A rollout takes up to 10,000 devices, so this is no limit on the fleet.
- **Expiry uses each host's clock.** A host whose clock is far behind accepts a release that has expired, and one far ahead refuses valid ones.
- **Vector isn't updated.** Agent updates replace the agent only. Replacing Vector stays a local act: [Replace the Vector binary](agents.md#replace-the-vector-binary).

## Who can do what

| Action | Roles |
| --- | --- |
| Read the settings, keys, releases, rollouts and each device's update state | Everyone who signs in |
| Turn updates on or off, rotate, roll over or revoke a key | Administrators, with their password |
| Prepare a release, upload its signature, withdraw it, clear a stop | Administrators |
| Review, start, pause, resume or cancel a rollout, and **Stop all updates** | Operators and Administrators |

Each change is recorded in the [audit log](administer.md#review-and-export-audit-events), and [notifications](notifications.md#choose-what-each-channel-sends) can tell you when a rollout stops, a device rolls back, updates are stopped or the key changes.

## Next

- [Alerts and notifications](notifications.md#choose-what-each-channel-sends): hear about rollbacks and stops.
- [Troubleshooting](troubleshooting.md#an-agent-update-doesnt-happen): when a device doesn't update.
- [Security model](security.md#agent-updates): what each side can and can't do.
- [Agent CLI](cli.md#update): the `vectory update` commands on a host, and the `vectory release` commands for keys and signatures.
