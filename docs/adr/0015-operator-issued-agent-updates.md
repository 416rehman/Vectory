# ADR 0015: The operator issues agent updates, each host opts in, and the agent verifies, stages and can undo them

Proposed 2026-10-02. Nothing described here is built. Version 0.1 upgrades an agent on its host, one device at a time ([Upgrade the agent](../user/agents.md#upgrade-the-agent)); this records how an operator could instead update many devices from the dashboard without weakening what restricted mode promises.

## Verdict

**Build it after signed releases exist, and not before.** Without a signature that the host can check on its own, an update channel makes the server an authority over code that runs on every host, and a compromised or mistaken server would take them all. With one, the server stays a distributor: it can offer a build, never authorize one.

1. **The host opts in, locally.** A host that has not run `vectory allow --agent-updates` (the setting lives in `settings.json`, written only by local commands like every other allowance) never fetches or installs an agent. The default is off, as with full mode.
2. **A separate release key authorizes a build.** The server's manifest key stays what it is today: it signs pipelines and policy for devices that already trust the server. An agent build is accepted only with a signature from a release key whose public half the host pinned when it opted in. The server holds no private release key.
3. **The agent opens every connection.** The server announces an update inside the next signed manifest (an additive field naming the version, each platform's SHA-256 and size, the signature and a release counter); the agent downloads the file from its own server over its pinned mutual-TLS channel. The wake-up channel still carries nothing.
4. **Install is staged and reversible.** The new file is verified (signature, SHA-256, the platform and architecture it names, `--version`), placed beside the running agent, swapped in by a privileged helper, and the previous file is kept. If the new build has not completed a check-in and reported its build within a bounded time, the helper puts the previous file back and restarts it. The failure appears as an audit event and an issue on the device.
5. **Updates roll out like pipelines.** An operator picks devices or groups, a canary comes first, batches follow, and the rollout can pause or cancel. A device reports one of: updating, updated, rolled back, or refused (and why: updates are off on this host, the build is older than the one running, the signature did not verify).

## Why the service account cannot do it alone

On Linux and macOS the agent runs as an unprivileged account and its executable belongs to root on a read-only part of the service's filesystem, by design. An agent that could replace its own executable could be made to run anything the next time it starts. Updates therefore need a small privileged component whose only job is to install a staged file that verifies against the host's pinned release key: a root-owned unit that starts when a staged file appears (systemd path unit, launchd watch path) and, on Windows, the service's own helper stopping the service, replacing the file and starting it again. That component is the security-critical part of this feature and gets its own review.

## What stays manual

- Turning updates on for a host, and pinning the release key (a local command).
- Replacing Vector: the agent keeps pinning the SHA-256 of the Vector it adopted, and approving a new one stays a local act.
- Going back past a release: the agent refuses a build older than the one it runs unless the host operator says so locally.

## Threats the design has to answer

| Threat | Answer |
| --- | --- |
| A compromised server offers a malicious build | The build must carry a release-key signature the server cannot make. |
| An old signed build is replayed to downgrade | The release counter only goes up; a lower one is refused. |
| A wrong-platform or truncated file | The descriptor names platform, architecture, size and SHA-256; the agent checks each before staging. |
| The new build crashes or cannot reach the server | The helper restores the previous file when no check-in arrives in time. |
| Power loss in the middle of the swap | The swap is an atomic rename; the previous file is kept until the new build has checked in. |
| An update storm | Rollouts go in batches behind a canary, and a device installs at most one update at a time. |
| A staged file changed after it was verified | The helper verifies the file at its final path, immediately before the swap. |
| A restricted host gains power it did not grant | Updates are off by default and only a local command turns them on; a restricted host stays restricted after an update. |

## Order of work

1. **Signed releases and a local verified update.** A release key, a signature on every build and on the catalog, and `vectory update --from FILE`, which verifies a build against the pinned key and swaps it with rollback. This also makes the manual upgrade safer and needs no server change.
2. **One device, on request.** The opt-in, the manifest field, the download, the privileged helper and the rollback, started by an operator for a single device from its page.
3. **Rollouts.** Targets, canary, batches, pause and cancel, and a fleet view of which devices run an older build.

Each step ships with native tests on every platform the agent supports, including a build that fails to start and a swap interrupted halfway.
