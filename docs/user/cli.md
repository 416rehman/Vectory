# Agent CLI

Every command and flag of `vectory`, the agent that runs on each device. For step-by-step tasks, see [Connect a device](installation.md) and [Manage agents](agents.md).

## Usage

```text
vectory <command> [flags]
```

- Flags take `--name value` or `--name=value`. Commands accept flags only, never extra arguments, with one exception: `release sign` and `release verify` take the `release.json` they work on, after the flags. Put the command first: `vectory status --json`, not `vectory --json status`.
- A few commands are groups of verbs, written `vectory <group> <verb> [flags]`. `vectory help release` lists a group's verbs and `vectory help release sign` shows one verb's flags.
- Commands that change the agent's files need administrator rights on the host (`sudo` on Linux and macOS).
- Exit codes: `0` success, `1` the operation failed, `2` invalid command or flags, `3` `setup` finished but something needs you (on a host without a service manager, nothing keeps the agent running), `78` the agent isn't installed or enrolled (the Linux service doesn't restart on this code), `130` `setup` was interrupted with Ctrl-C.

Run `vectory --help` for the command list, `vectory help <command>` for one command, and `vectory --version` for the version.

## Flags for every command

| Flag | Meaning |
| --- | --- |
| `--state-dir PATH` | The agent's private state: identity, settings and recovery copies. Defaults: `/var/lib/vectory-agent` on Linux, `/Library/Application Support/Vectory/agent` on macOS, `C:\ProgramData\Vectory\agent` on Windows. Must be absolute. |
| `--json` | Print machine-readable JSON instead of text. |

When the state directory isn't the default, every command the agent prints for you to run, in `status`, `doctor`, `pause` and the fix of a refused version, includes `--state-dir` with your directory. Copy it as printed.

The `release` verbs keep no agent state, so they take neither flag.

## Commands at a glance

| Command | What it does | Agent must be stopped |
| --- | --- | --- |
| [`setup`](#setup) | Install, enroll and start the agent in one step. | No |
| [`install`](#install) | Adopt a Vector binary and managed configuration, or change local settings. | Yes, when changing an existing install |
| [`enroll`](#enroll) | Connect this host to a Vectory server with a one-time token. | No |
| [`run`](#run) | Run the agent in the foreground. | No |
| [`status`](#status) | Show identity, server, pipeline and next step. | No |
| [`doctor`](#doctor) | Check local setup and the server connection. | No |
| [`logs`](#logs) | Show Vector's own log, not a stream of your events. | No |
| [`pause`, `resume`](#pause-and-resume) | Stop or restart applying new versions on this host. | No |
| [`retry`](#retry) | Allow one more attempt at a rejected version. | No: queued while it runs |
| [`allow`](#allow) | Add a destination, listener or file root that restricted pipelines may use. | Yes |
| [`configure-metrics`](#configure-metrics) | Set or clear the local metrics endpoint. | Yes |
| [`configure-secrets`](#configure-secrets) | Map `vectory-secret:NAME` references to local files. | Yes |
| [`re-adopt`](#re-adopt) | Approve a Vector binary you replaced on purpose. | Yes |
| [`recover-enrollment`](#recover-enrollment) | Replace a lost identity with an administrator's recovery token. | Yes |
| [`update`](#update) | Show where agent updates stand, apply a staged one, pause, resume or turn them off. | No |
| [`service-install`, `service-start`, `service-stop`, `service-uninstall`](#service-commands) | Manage the agent's operating-system service. | Varies |
| [`unenroll`](#unenroll) | Delete this host's credentials. | Yes |
| [`uninstall`](#uninstall) | Delete the agent's state with `--purge`. | Yes |
| [`release`](#release) | Make release keys, sign agent builds and check signatures. | No |
| [`version`, `help`](#version-and-help) | Print the version or usage. | No |

## setup

Install, enroll, register the service and wait for the first check-in, in one resumable step. The **Add device** installer runs it for you.

```sh
sudo vectory setup --server https://vectory.example.com:8443 --ca-sha256 <64-hex-fingerprint>
```

Copy the whole command from **Add device** rather than typing it: it carries your server's fingerprint.

| Flag | Meaning |
| --- | --- |
| `--server URL` | The agent listener, for example `https://vectory.example.com:8443`. |
| `--ca-sha256 HEX` | Trust only a server whose certificate chain includes this CA fingerprint. |
| `--ca-file PATH` | Trust the CA certificate (PEM) in this file instead. |
| `--name NAME` | Device name in the dashboard. Defaults to this host's name. |
| `--token-file PATH`, `--token-stdin` | Read the enrollment token from a protected file or standard input. Without either, `setup` asks for it with hidden input. |
| `--mode full` | Use full Vector mode. Restricted is the default. |
| `--capability-policy PATH` | Restricted-mode allowances. |
| `--vector-binary PATH` | The Vector binary to adopt. Found automatically when omitted. |
| `--managed-config PATH` | The one configuration file the agent manages. Defaults to the platform path above. |
| `--service auto` | Service manager to register with: `auto`, `systemd`, `launchd`, `windows` or `none`. `none` means you keep the agent running yourself. |
| `--service-user NAME`, `--create-user` | Account the service runs as, and whether to create it. |
| `--keep-existing-vector` | Continue even though another Vector is running. Setup leaves that Vector untouched. |
| `--adopt-existing` | Adopt the Vector that ran here as it is, although it loaded several files, a directory, includes or configuration chosen by an environment variable. The agent manages only its one JSON file; the others stay where they are, backed up. Can't be combined with `--keep-existing-vector`. |
| `--dry-run` | Check everything and show the plan without changing anything. |
| `--no-wake` | Check in on schedule only: turn wake-ups off (see [run](#run)). Saved as a local setting; `--no-wake=false` turns them back on. |
| `--updates LEVEL` | How this host takes [agent updates](agent-updates.md): `auto`, `ask` or `off`. `auto` and `ask` need `--update-key-sha256`. Leave it out to change nothing. See [Agent updates in setup](#agent-updates-in-setup). |
| `--update-key-sha256 HEX` | The fingerprint of the release key to pin, as **Add device** shows it: all 64 hexadecimal characters of the SHA-256 of the key's bytes, never a shortened form. Setup reads the keys from the server and pins the one whose fingerprint it computes to be this. Repeat the flag for up to 4 keys. Running setup again with other fingerprints re-pins: it replaces the pinned keys and keeps the host's counter floors. |
| `--update-track TRACK` | The releases this host takes: `patch` (the default) or `minor`. `major` isn't a track. |
| `--update-window SPEC` | When an update may start, such as `Mon-Fri 02:00-04:00` or `Sat,Sun 01:00-03:00 UTC`. Repeat the flag for up to 7 windows. Times are the host's own unless `UTC` follows. Without one, any time. |
| `--json` | Print the result as JSON for scripts. |

If the server's certificates don't match the pin, `setup` stops before sending anything and prints both fingerprints in full, one above the other, with the first byte that differs:

```text
[!!] Server       The server's certificates don't match the pinned CA:
                  expected 3F:DD:…:34:05:…
                  received 3F:DD:…:34:95:…  (first difference at byte 16)
```

Compare them with the fingerprint on **Add device** and copy the command again. If it still doesn't match, the address may lead to a different server; don't continue. Without a pin, if this host doesn't trust the server's CA, `setup` prints the certificate's fingerprint in the same rows of eight pairs as **Add device**, to compare. It never pins what it was sent.

`setup` never adopts a Vector that is already running. If it finds one, it waits 6 seconds and checks again, so a short test run (such as the server's validator on a shared host) doesn't count. If Vector still runs, setup records how it was started, copies every configuration file it loads into `adoption-inventory` in the state directory, prints the files with their SHA-256 (and returns them under `adoption` with `--json`), and stops. When that Vector loads several files, a directory, included files, a provider or configuration chosen by an environment variable, setup names them and how to merge or adopt them: see [Adopt a Vector that already runs](agents.md#adopt-a-vector-that-already-runs). `--keep-existing-vector` continues without touching the running Vector, and records and copies nothing.

Before it asks for the token, `setup` checks that the service account can run Vector and the agent. A Vector under a private home folder, such as `/root/.vector/bin/vector`, is refused with the folder that blocks it: install Vector system-wide or pass `--vector-binary`.

Run `setup` again after replacing the agent binary to upgrade: it restarts the service on the new build and waits for that build's first check-in, for example `vectory.service upgraded 0.1.0 → 0.2.0 · first check-in 1.2 s after restart`. Vector finishes its in-flight events before the old agent exits. On Windows, where a running agent can't be replaced, setup first checks that the service is registered for this agent, then stops it; if a later step fails, it starts the service again and says which build it runs.

An enrolled host keeps the address it enrolled with. If `--server` names another address, `setup` stops before it changes anything. It says which address the host is enrolled with and which one the command names, then what to run if it's the same server: the command again with `--server` set to the enrolled address. Moving the host to another server comes last: run [`unenroll`](#unenroll), revoke the old device in the dashboard, then run `setup` again.

Ctrl-C while `setup` waits for the first check-in stops only the wait: the service keeps running, and `setup` exits with code `130`.

Without a service manager (most containers, WSL, Alpine with OpenRC), `--service auto` has nothing to register. Setup checks in once with a full report, then prints `[!!] Service` with the reason and the exact command that keeps the agent running, such as `/usr/local/bin/vectory run --state-dir /var/lib/vectory-agent`, and exits with code `3`. With `--service none`, the same command is the plan, and setup exits with `0`. `--create-user` needs a service; without one, setup says it created no account. `--dry-run` shows the same **Service** row, and the agent path where the installer puts it.

Run again beside a running `vectory run`, setup says there is nothing to start. If that agent still runs an older build than the one just installed, it says so and how to restart it on the new one.

### Agent updates in setup

A host takes agent updates only when the command that installed or upgraded it says so, once. **Add device** and **Upgrade agent** write these flags for you while the team has agent updates on, and the dashboard can't change what a host consented to afterwards. Without `--updates`, `setup` touches none of it.

```sh
sudo vectory setup --server https://vectory.example.com:8443 --ca-sha256 <64-hex-fingerprint> \
  --updates auto --update-key-sha256 <64-hex-fingerprint> --update-window 'Mon-Fri 02:00-04:00'
```

| Flag | Meaning |
| --- | --- |
| `--updates LEVEL` | `auto` downloads and stages a build when an update rollout reaches the host, then applies it inside the window, if there is one. `ask` stages it and waits for someone on the host to run [`vectory update apply`](#update). `off` withdraws consent, deletes what the agent staged and removes the update step, and keeps the pinned keys. |
| `--update-key-sha256 HEX` | Required with `auto` or `ask`: the fingerprint of the release key to pin, 64 hexadecimal characters (groups separated by spaces, colons or dashes are fine). Repeat it for up to 4 keys. Giving it again replaces the pinned keys and ends a stop after a fork. |
| `--update-track TRACK` | `patch` (the default) takes releases with the same major and minor version as the agent that runs. `minor` takes newer minor releases too. `major` is refused: `This release offers patch and minor tracks. Upgrade to a new major version by hand.` |
| `--update-window SPEC` | When an update may start: `DAYS HH:MM-HH:MM`, optionally followed by `UTC` (otherwise the host's local time). `DAYS` is `daily`, a day (`Mon`), a range (`Mon-Fri`) or a list (`Sat,Sun`). A window that ends before it starts crosses midnight. Repeat it for up to 7 windows. |

Pinning a key lets whoever holds its private half run code as root on this host. Pin only a key you trust with that.

`setup` checks every update flag, and that updates can work on this host, before it changes anything. It stops with the reason and the fix, and no other effect, when:

- there is no service manager, or you passed `--service none`: the update step restarts the agent through its service manager;
- the agent is installed from a package, which the package manager owns;
- the operating system's updates are not in this release (`Hosts of this kind update by hand in this release.`);
- the install directory, the update policy's directory or the update step's directory can be changed by an account other than root (an Administrator on Windows);
- the server doesn't offer agent updates: `This server doesn't offer agent updates.` Turn them on in **Settings → Agent updates**, or leave out `--updates`.

`setup` finds the key to pin in the server's list of release keys, which it fetches over the connection it already verified, with no token and no client certificate. It computes the SHA-256 of each key itself and pins the one whose fingerprint is the value you passed. The list's own `fingerprint` member is never used for matching, and one that disagrees with its key makes the whole list invalid (`RELEASE_KEY_INVALID`) with nothing pinned. A fingerprint the server doesn't offer fails with the fingerprints it does, in the rows `--ca-sha256` uses, and nothing changes.

After the agent is installed and enrolled and before the service starts, `setup` writes the policy to a file only root can change (`/etc/vectory/updates/policy.json` on Linux, `/Library/Application Support/Vectory/updates/policy.json` on macOS, `%ProgramData%\Vectory\updates\policy.json` on Windows) and installs the update step. If that fails, the message says what was saved and what wasn't, and running the same command again resumes. A pause set with [`vectory update pause`](#update) survives running `setup` again.

```text
[ok] Updates      automatic · patch releases · Mon–Fri 02:00–04:00 · key 3f9a1c0277de9b41 (pinned)
```

`--dry-run` plans the step without asking the server for its keys: `Would turn on updates: automatic · patch releases · any time · key 3f9a1c0277de9b41.` With `--json`, `updates` holds `consent`, `track`, `windows` and `keys`.

## install

Adopt a Vector binary and the configuration file the agent will manage. Run it again on an existing install, with the agent stopped, to change local settings.

```sh
sudo vectory install \
  --vector-binary /usr/bin/vector \
  --managed-config /etc/vectory/managed/vector.json \
  --adopt
```

| Flag | Meaning |
| --- | --- |
| `--vector-binary PATH` | The installed Vector 0.58.x binary to adopt (any 0.58 patch release), pinned by its SHA-256. A symbolic link is resolved and the real file is adopted; after upgrading Vector, approve the new binary with `vectory re-adopt`. |
| `--managed-config PATH` | The single JSON configuration file the agent manages. Its folder becomes private. |
| `--adopt` | Confirms the adoption. Required for a new install. |
| `--capability-policy PATH` | Restricted-mode allowances. Replaces all three lists and prints what the host allows afterwards. To add one entry and keep the rest, use [`allow`](#allow). |
| `--allow-full-vector-config` | Turn on full Vector mode. Use `--allow-full-vector-config=false` to return to restricted. |
| `--metrics-url URL` | Loopback Prometheus endpoint to read metrics from, for example `http://127.0.0.1:9598/metrics`. |
| `--clear-metrics-url` | Remove the saved metrics endpoint. |
| `--secret-files PATH` | JSON map of secret names to absolute private files. Replaces all bindings. |
| `--vector-data-dir PATH` | Data directory for pipelines that don't set `data_dir`. Empty restores the automatic choice: the adopted configuration's `data_dir`, then `/var/lib/vector` if it exists and is writable (not on Windows), then `<state-dir>/vector-data`. The automatic choice is made once, at the first activation, and kept, so checkpoints and disk buffers never move. |
| `--graceful-shutdown-seconds N` | How long Vector may drain on stop or restart before it is killed, 5 to 300. Default 60. |
| `--no-wake` | Check in on schedule only: turn wake-ups off (see [run](#run)). `--no-wake=false` turns them back on. |

All options are checked together before anything is saved. Options you leave out keep their values.

## enroll

Connect this host to a server using a one-time enrollment token.

```sh
sudo vectory enroll --server https://vectory.example.com:8443 --name web-01
```

| Flag | Meaning |
| --- | --- |
| `--server URL` | The agent listener. HTTPS only, and the certificate is always verified. |
| `--name NAME` | Device name, unique in your fleet. |
| `--ca-file PATH` | The CA certificate (PEM) to trust. Omit it to use the system trust store, or to keep the trust saved by an earlier attempt; `--ca-file=` switches back to the system trust store. |
| `--ca-sha256 HEX` | Pin the server's CA by fingerprint. |
| `--token-stdin` | Read the token from standard input. |
| `--token-file PATH` | Read the token from a regular, local file that only you (or root) can read. |
| `--token VALUE` | Compatibility only. Other users can read it from the process list. |
| `--ip SERVER`, `--id NAME` | Compatibility aliases for `--server` and `--name`. |

Without a token flag, `enroll` asks for the token with hidden input. A token that isn't 64 characters of `0`-`9` and `a`-`f` (a short or mangled paste) is refused before anything is sent. The older form `vectory -ip SERVER -id NAME -token TOKEN` still works and means `enroll`.

A command made on **Add device** for a typed name enrolls only that name. With another `--name`, the server refuses it, and **Recent enrollment attempts** says the command was made for another device name.

If an enrollment is interrupted, run the same command again with the same server, name and token. The agent reuses its pending request, so the server can't enroll the device twice.

## run

Run the agent in the foreground. It starts Vector, applies versions and checks in until you stop it with Ctrl-C. Vector then finishes its in-flight events (up to `--graceful-shutdown-seconds`, 60 by default) before both exit.

```sh
sudo vectory run
```

Between check-ins, the agent keeps one request open to the server, so a new version or setting reaches it within seconds instead of at its next check-in. The agent opens that request itself, and the answer only tells it to check in now. If the request fails, for example on a network that cuts idle connections, the agent quietly keeps its schedule.

| Flag | Meaning |
| --- | --- |
| `--no-wake` | Check in on schedule only for this run, whatever the saved setting. |
| `--verbose` | Also log every check-in, not only what changed. |
| `--once` | (Testing) Check in and reconcile once, then stop. |

The agent logs what changes, once: the version it applied and whether Vector runs it, a refusal in the words of its diagnostic with the code, the reconnection after an outage, and how Vector stopped:

```text
Applied version b898b48f (generation 2); Vector runs it.
Reconnected to https://vectory.example.com:8443 after 1 min 12 s.
Stopping Vector: it finishes in-flight events for up to 60 s.
Vector stopped after 3.2 s.
```

When Vector doesn't finish in time, the last line is `Drain limit reached after 60 s; Vector was terminated before it finished its in-flight events.`

When an update rollout reaches a host that consented to agent updates, the agent says what it does with the offer, once for each step: it downloads the build, stages it for the update step, refuses it with the code the dashboard shows, or deletes what it staged because the server withdrew the offer.

```text
Downloading agent update 0.1.1 (14.5 MB).
Agent update 0.1.1 (14.5 MB) is staged. The update step applies it within a minute.
Agent update 0.1.2 was refused (KEY_NOT_PINNED): no key this host pins signed it.
```

A check-in that keeps failing for the same reason, such as a revoked device or a server that is down, is logged when it starts and again if the reason changes, not at every retry. `vectory status` says since when.

## status

Show the device's identity, server, last check-in, pipeline and the next step, and say what it runs, when it checks in next and whether it waits for wake-ups.

```sh
sudo vectory status
```

It reads local state only. **Pipeline** names the pipeline and version the server's signed manifest gave, with the version's short ID and generation. **Check-in** says when the next check-in is due. **Wake-ups** says whether the agent holds a request open between check-ins.

```text
Pipeline   Edge syslog processing · version 3 (3f2a9c1d, generation 12) · applied and verified
Check-in   next due in 48 s (every minute)
Wake-ups   on · a new version or setting reaches this device within seconds
```

- **Pipeline** shows the name and version number only when the server sends both. Otherwise it reads `Version 3f2a9c1d (generation 12) · applied and verified`.
- **Running** appears when the version that runs isn't the one **Pipeline** describes: after a rollback, or after the device was unassigned. `Edge syslog processing · version 3`.
- **Check-in** is the last successful check-in plus the interval of the device's agent settings: `next due in 48 s (every minute)`, or `overdue by 35 s (every minute)` when it has passed. The agent adds up to 20% of random spacing, so a few seconds late is normal. It shows only while the agent runs.
- **Wake-ups** reads `on`, `off · turned off on this host` ([turn them back on](agents.md#turn-off-wake-ups)), `off · this run was started with --no-wake`, `paused while check-ins fail`, or `not getting through` when the last request failed and the agent keeps its schedule. It is absent when the server doesn't hold wake-ups or the agent isn't running.

- **Updates** says what the host consented to for agent updates, or what needs attention first. It reads `off on this host` when the host never consented. See [`update`](#update).

```text
Updates    automatic · patch releases · Mon–Fri 02:00–04:00 (next in 6 h) · key 3f9a1c0277de9b41
Updates    staged 0.1.1, waiting for you: sudo vectory update apply
Updates    0.1.0 → 0.1.1 at 02:14 · first check-in 2.1 s after restart
Updates    rolled back from 0.1.1 at 02:19: it didn't check in within 5 minutes; this host won't try 0.1.1 again
Updates    off on this host
```

With `--json`, the keys `running_pipeline` (`name`, `version_number`, `version_id`, `generation`), `check_in` (`interval_seconds`, `last_at`, `next_due_at`, and `due_in_seconds` or `overdue_by_seconds`), `wake_ups` (`listening`, and `reason` when it isn't) and `updates` (the document [`update status --json`](#update-status) prints) are added. Each is present only when the agent has something true to say, and every key `status --json` always had is unchanged.

When Vector's own log shows a sink failing requests in the last minute, `status` says so under **Vector**, and **Next** says what to check instead of "Nothing to do":

```text
Vector     0.58.0 at /usr/bin/vector · adopted binary unchanged
           sink out: 27 errors in the last minute: Connection refused (127.0.0.1:8239) · see vectory logs
Next       Check that 127.0.0.1:8239 is reachable from this host.
```

After a device's first version fails to start, **Next** says that Vector isn't running because there is nothing earlier to go back to, and to deploy a corrected version or retry. It never asks for host recovery then.

**Next** gives the command that starts the agent with its full path (and `--state-dir` when it isn't the default), since an agent installed with `--install-dir` isn't on `PATH`. **Service** says `none · vectory run is running (pid 812), not as a service` for an agent started by hand. After the device is revoked, **Server** says the server no longer accepts this agent, instead of "not answering".

## doctor

Check the local setup and the connection to the server, and print a fix for each problem. It checks the adopted Vector binary, the managed configuration, the mode and metrics settings, then DNS, TLS, clock and credentials.

```sh
sudo vectory doctor
```

For a host that consented to agent updates it also checks that the update policy can be trusted, that the update step ran in the last two minutes, that the host can take a build (the step's own answer, such as `PACKAGE_MANAGED` or `READ_ONLY`, with the fix), that no pinned key is stopped by a fork, whether a build waits for someone on the host, and how the last update ended. A host that never consented gets one line saying so.

## logs

Show Vector's own log on this host: startup, reloads, and component warnings and errors. It never streams your events, but a pipeline that logs event fields (the VRL `log()` function) shows them here. The log lives in `<state-dir>/vector.log` and rotates at 10 MiB into one `.1` file. `logs` only reads files, so it works while the agent runs.

```sh
sudo vectory logs --follow
```

| Flag | Meaning |
| --- | --- |
| `--lines N` | How many recent lines to print, from 1 to 100000. Default 100. |
| `--follow`, `-f` | Keep printing new lines until you press Ctrl-C. |
| `--raw` | Print the log file's lines unchanged. They can hold terminal escape sequences from your events: save them to a file, or pipe them through `cat -v`. |
| `--json` | Print one JSON object per line: Vector's records as they are, and the agent's own notes with the same `timestamp`, `target` and `message` keys. |

Event text can hold control characters, and a terminal acts on them: it can change the window title, clear the screen or overwrite the start of a line to forge another. So `logs` shows each control character, line or paragraph separator and text-direction control as an escape, such as `\x1b` for ESC and `\x0a` for a newline. `--json` escapes them as `\u001b`, and a program that decodes the JSON and prints a value must remove them itself. Only `--raw` prints them unchanged.

The agent's notes include changes a host operator made, such as `Host operator allowed destination 127.0.0.1:8239 (vectory allow)`. A note reads `[vectory 2026-10-02T23:43:31Z] Host operator allowed …`, while Vector's own lines read `2026-10-02 23:43:29Z  INFO …`. With a `--state-dir` that holds no agent, `logs` says `No agent is installed at …` instead of waiting for a log.

## pause and resume

Stop applying new versions on this host, for example while you edit the managed configuration by hand. Vector keeps running. Works while the agent runs.

```sh
sudo vectory pause
sudo vectory resume
```

`resume` clears only the local pause; a pause set from the dashboard still applies.

## retry

Allow one more attempt at a version the agent rejected, after fixing the cause.

```sh
sudo vectory retry
```

While the agent runs, the request is queued and the agent tries the failed version again within a few seconds: `Retry queued. The running agent (pid 812) tries the failed version again within a few seconds`. With the agent stopped, it tries at its next start. When no version has failed on the host, it says `Nothing to retry` and changes nothing. **Retry application** on the device page does the same from the dashboard.

## allow

Add to this host's restricted-mode allowances and keep everything already allowed. Run it with the agent stopped; when the agent starts again, a version this host refused is tried again.

```sh
sudo vectory allow --network logs.example.net:443
sudo vectory allow --listener 0.0.0.0:514 --file-root /var/log/nginx
```

| Flag | Meaning |
| --- | --- |
| `--network HOST:PORT` | A destination pipelines may send to, exactly `host:port`. |
| `--listener ADDR:PORT` | An address pipelines may listen on. |
| `--file-root PATH` | An absolute directory pipelines may read and write under. Not `/` or a drive root, and not a directory that is, holds or lies inside the agent's state directory, the managed configuration or a bound secret file. |

Repeat a flag for more entries. `allow` prints what it added and everything the host allows now, and notes the change in `vectory logs`. With `--json`, `added` and `allowances` hold only the lists that have entries. Only a host operator can change allowances; the dashboard can't. To remove an entry, replace the lists with `install --capability-policy`.

## configure-metrics

Set or clear the loopback endpoint the agent reads Vector's metrics from. Run it with the agent stopped. Choose exactly one flag.

```sh
sudo vectory configure-metrics --metrics-url http://127.0.0.1:9598/metrics
sudo vectory configure-metrics --clear-metrics-url
```

| Flag | Meaning |
| --- | --- |
| `--metrics-url URL` | `http://` with a literal loopback IP, an explicit port and a path. |
| `--clear-metrics-url` | Remove the saved endpoint. The pipeline's exporter is unchanged. |

## configure-secrets

Map `vectory-secret:NAME` references to private files on this host. Run it with the agent stopped. Any credential field of a pipeline can reference a bound name.

```sh
sudo vectory configure-secrets --secret-files /etc/vectory/secret-bindings.json
```

| Flag | Meaning |
| --- | --- |
| `--secret-files PATH` | JSON object of names to absolute file paths. Replaces all bindings; `{}` removes them. |

At each check-in the agent reports the bound names, never the files or values, so the device page can show which ones a version still needs. See [Keep credentials on the device](resources.md#keep-credentials-on-the-device) for the file rules.

## re-adopt

Approve a replaced or moved Vector binary. Run it with the agent stopped.

```sh
sudo vectory re-adopt --expected-sha256 THE_SHA256
```

| Flag | Meaning |
| --- | --- |
| `--expected-sha256 HEX` | Required. The SHA-256 of the new executable, from a source you trust. |
| `--vector-binary PATH` | The new path, if Vector moved. Defaults to the current path. |

## recover-enrollment

Replace a lost or unrenewable identity using a recovery token from an administrator. It keeps the enrolled server and device name. Run it with the agent stopped.

```sh
sudo vectory recover-enrollment
```

| Flag | Meaning |
| --- | --- |
| `--token-file PATH`, `--token-stdin` | Read the recovery token from a private file or standard input. Without either, it asks with hidden input. |
| `--ca-file PATH` | The CA certificate (PEM) to trust. Omit it to keep the saved trust. |
| `--json` | Print the result as JSON. |

A request the server refused, or that never left this host, doesn't hold back the next token: run the command again with a new one. A request that may have reached the server does, because it may have issued the new identity: run the command again with the same token.

## update

The host's side of [agent updates](agent-updates.md): show where they stand on this host, and do the few things a person here can do about them. A host takes agent updates only when it consented to them, once, in [`setup`](#agent-updates-in-setup); the dashboard can't change that. Every verb but `status` needs root (an Administrator, from an elevated PowerShell, on Windows) and prints the exact command to run when it doesn't have it.

```sh
sudo vectory update status
sudo vectory update apply
sudo vectory update pause
sudo vectory update resume
sudo vectory update off
```

| Verb | What it does |
| --- | --- |
| [`status`](#update-status) | Shows the host's consent, the releases it takes, its windows, the keys it pins, what it is doing now and how its last update ended. |
| [`apply`](#update-apply) | Installs the build a host set to **Ask on the host** has staged. |
| [`pause`, `resume`](#update-pause-and-resume) | Keeps the host's choices and stops every download and install until `resume`. |
| [`off`](#update-off) | Withdraws consent: the staged build is deleted and the update step is removed. |

Each verb takes the flags every command takes, `--state-dir` and `--json`. The commands these verbs print for you to run include `--state-dir` when your directory isn't the default.

### update status

Read the policy, what the update step last wrote and what the agent staged, and print where updates stand. It changes nothing. On a default install the agent's state directory is private to its account, so run it with `sudo`.

```text
Updates      automatic · patch releases · Mon–Fri 02:00–04:00 (next in 6 h) · key 3f9a1c0277de9b41
Key          3f9a1c0277de9b41 · team · pinned 3 Oct 2026 12:30
Eligibility  this host can take updates
Update step  running · last ran 12 s ago · service definition 1
Staged       0.1.1 (14.5 MB) · offered 01:58
```

| Row | Says |
| --- | --- |
| **Updates** | The level (`automatic`, `ask on this host` or `off`), the track, the windows with whether one is open now or when the next one opens, and the pinned keys by short ID. A pause shows after it, with the command that lifts it. |
| **Key** | One row for each pinned key: its short ID, its name and when it was pinned. |
| **Eligibility** | Whether this host can take an update and, when it can't, why, with the code: `PACKAGE_MANAGED`, `NO_SERVICE`, `UNTRUSTED_LOCATION`, `READ_ONLY`, `HELPER_NOT_RUNNING`, `SERVICE_DEFINITION_OUTDATED` or `PLATFORM_NOT_IN_RELEASE`. |
| **Update step** | Whether the update step ran in the last two minutes (it runs every 30 seconds), and when. |
| **Stopped** | Two successors of a pinned key were seen (a fork), with their short IDs. The host takes no update until it is pinned again with `setup --update-key-sha256`. |
| **In progress** | A build being applied, tried (with when the trial ends) or taken back. |
| **Staged** | The build the agent staged for the update step, and when it was offered. |
| **Last result** | How the last update ended, such as `rolled back from 0.1.1 at 02:19: it didn't check in within 5 minutes; this host won't try 0.1.1 again`. |

With `--json`, `status` prints one document: `state_dir`, `consent`, `paused`, `local_pause`, `track`, `windows`, `window_open`, `next_window_at`, `keys` (each with `fingerprint`, `short_id`, `name` and `pinned_at`), `policy_problem`, `eligibility`, `step`, `staged`, `in_progress`, `last`, `rollover_conflict` and `line`, the text `vectory status` shows. Every member is present, `null` where nothing applies.

### update apply

For a host that asks first (`--updates ask`): apply the build the agent staged now, in the foreground, through the same update step, and print each step. It shows what the agent last reported about the offer before it starts.

| Flag | Meaning |
| --- | --- |
| `--force` | Apply although the agent's last report says the offer is gone or is more than 5 minutes old. It asks you to confirm on a terminal, and refuses without one. |

```text
Staged: 0.1.1 (14.5 MB), offered 5 Oct 01:58.
The agent reported 12 s ago (02:13) that the server offers 0.1.1.
  <each step the update step takes>
Updated: 0.1.0 → 0.1.1 at 02:14 · first check-in 2.1 s after restart.
The dashboard shows this device as updated once the server has seen the new build check in.
```

When the report says the server no longer offers the build (a paused or cancelled rollout, or **Stop all updates**) or is more than 5 minutes old, `apply` refuses, says what the report said and how old it is, and says to run it again with `--force` if you know the offer stands. Check **Devices → Agent updates** first. That check is advice: the report is a file the agent's account writes. Whatever you confirm, the update step verifies the signed release, the pinned keys and this host's policy again before it installs anything.

`apply` also refuses, with the reason, when updates are off, when the policy can't be used, when updates or `vectory pause` hold the host, when nothing is staged and when the staged build isn't complete. What it prints at the end is what the update step recorded: a build that was taken back says so and exits `1`.

### update pause and resume

`pause` keeps what the host consented to and stops every download and apply until you `resume`. It takes effect at the agent's next check-in, with no restart. A build the update step is already applying finishes. `vectory pause`, which holds back every change on the host, is separate, and `resume` says when it still holds updates back.

```text
Paused. The agent stops downloading and applying agent updates at its next check-in; no restart is needed. A build the update step is already applying finishes.
Resume with: sudo vectory update resume
```

```text
Resumed. At its next check-in the agent downloads and applies updates again, inside its window.
```

Both say `Nothing changed.` when the host is already in that state, and say so when updates are off.

### update off

Withdraw this host's consent: the policy says off, the build the agent staged is deleted and the update step is removed. The pinned keys stay, so the **Upgrade agent** command with `--updates` turns updates on again.

```text
Agent updates are off on this host: the policy says off, the staged build is deleted, the update step is removed.
The pinned key is kept. To turn updates on again, run the Upgrade agent command with --updates.
```

It refuses while the update step applies or tries a build, and says when that ends: `vectory: an update is being tried on this host; it ends by 02:19. Run the command again after that`.

A host's level, releases, windows and pinned keys change only when someone runs `setup` again on it: the **Upgrade agent** command carries them. Nothing the server sends changes them.

### The update step

`vectory update-helper [--state-dir PATH]` is one run of the privileged update step: it applies a staged build, watches the trial and takes a build back when it doesn't check in healthy. The service manager runs it every 30 seconds as root (a systemd timer on Linux, a launchd job on macOS, a Windows service), so you don't run it yourself. `vectory update status` shows when it last ran, and `vectory update apply` asks it to run now.

## Service commands

| Command | Meaning |
| --- | --- |
| `vectory service-install` | Register the agent as a service: systemd on Linux, launchd on macOS, the Service Control Manager on Windows. Needs administrator rights. |
| `vectory service-start` | Enable and start the service. |
| `vectory service-stop` | Stop the service and its Vector. |
| `vectory service-uninstall` | Remove the service registration. |

| Flag | Meaning |
| --- | --- |
| `--service-user NAME` | For `service-install` on Linux and macOS: an existing unprivileged account to run as. Windows always uses `NT SERVICE\Vectory`. |

The service is registered for the state directory you pass to `service-install`. The other service commands always act on that one service and reject `--state-dir`.

On a host without systemd, `service-stop` says there is no Vectory service to stop and how to stop an agent started with `vectory run` (Ctrl-C where it runs; `vectory status` shows its pid).

`vectory service` is the entry point the Windows service runs. You don't run it yourself.

## unenroll

Delete this host's credentials, keeping the installation. Also revoke the device in the dashboard: the host can't revoke its identity offline.

```sh
sudo vectory unenroll
```

On a host with no credentials it says so, and there is nothing to revoke.

## uninstall

Delete the agent's state directory. Stop and unregister the service first.

```sh
sudo vectory uninstall --purge --state-dir /var/lib/vectory-agent
```

| Flag | Meaning |
| --- | --- |
| `--purge` | Delete the state directory named by `--state-dir`, which is required. Vector and the managed configuration stay. |

Without `--purge`, `uninstall` changes nothing and reminds you to remove the service and binary. When the state directory doesn't exist, it says `Nothing to remove` and exits `0`, so you can run an interrupted purge again.

## release

Make a release key, sign an agent build with it, and check a signed release the way a host does. A team that keeps its release key offline runs these verbs on the machine that holds the key. They read and write files only: no network, no service and no administrator rights.

```sh
vectory release keygen --out team.key --name team
vectory release sign --key team.key --checksums SHA256SUMS release.json
vectory release verify --key team.pub release.json
vectory release rollover --key team.key --to team-next.pub
```

A host installs an agent build only when a key it pinned signed it. Whoever holds a pinned key can sign code that runs as root on those hosts, so keep the private key off the server and out of backups you don't control.

### release keygen

Create a release key. The private half goes in the file you name, which `keygen` creates closed to other accounts and never replaces. The public half is printed.

| Flag | Meaning |
| --- | --- |
| `--out FILE` | Required. The file for the private key. It must not exist, and a link in its place is refused. |
| `--name NAME` | The display name in the public key line, 1 to 64 printable ASCII characters without a quotation mark or a backslash, and not starting or ending with a space. Default `release-` and the first 8 characters of the fingerprint, the name a key the server makes gets, so a public key line doesn't say who holds the private key. |

```text
Wrote the private key to team.key, closed to other accounts.
Keep it off the server. Whoever holds it can sign builds that every host pinning this key installs as root.

Public key (give it to the server, and save it in a file such as team.pub):
vectory-release-key ed25519 3n1kX5uZnEN2wf+ZrjTlfd3sqUPQff1ANP0I/elZz7o= team

Fingerprint (hosts pin it; compare it with the one the dashboard shows):
05cc6c02 351af0cb 1be9877e 7cdcd326 c6831001 8746cb7b bbbf6beb 29392618
```

The public key line starts at the left edge, so what you copy is the line and nothing in front of it. A file that holds it with spaces before it is refused. The fingerprint is the SHA-256 of the key's 32 bytes, written in groups of eight characters. Its first 16 characters are the short ID that the dashboard and `vectory update status` print. An existing file, even one that is a symbolic link, is refused: `team.key already exists, and keygen never replaces a file.`

### release sign

Sign the exact bytes of a `release.json`, the file the server prepared for your key.

| Flag | Meaning |
| --- | --- |
| `--key FILE` | Required. The private key file `keygen` made. It must be a regular file with one name, owned by you or root and closed to other accounts. |
| `--checksums FILE` | Required. A `SHA256SUMS` file that you got without the server, from the project's release page or from your own build. |
| `--yes` | Sign without asking. Without a terminal, `sign` refuses unless you pass it. |
| `--out FILE` | Write the signatures here. The default is `release.json.sig` beside the manifest. |

`sign` signs only when every build in `release.json` appears unchanged in `SHA256SUMS`, as a line `<sha-256>  <file name>` (or `<sha-256> *<file name>`), so a signature never repeats only what the server said. It also refuses a manifest that breaks the format or has expired. Then it shows what the signature authorizes and asks:

```text
Agent 0.1.1 · counter 7 · expires 2027-04-01 12:00 UTC (in 180 days)
  Issued 2026-10-03 12:00 UTC · service definition 1
  For agents running 0.1.0 or newer
  linux/amd64    vectory-0.1.1-linux-amd64        15204352 bytes  sha256 4206fd2a4cefdeff…
  windows/amd64  vectory-0.1.1-windows-amd64.exe  15892480 bytes  sha256 25043433d22cf8f6…
Every file name and SHA-256 matches SHA256SUMS.
Sign this release with key 05cc6c02351af0cb? [y/N] y
Signed with key 05cc6c02351af0cb. Wrote release.json.sig (1 signature).
Next: upload release.json.sig to the release on Devices → Agent updates.
```

The service definition is the generation of the service unit or plist (on Windows, the service registration) that the build needs. A host whose service definition is older refuses the release with `SERVICE_DEFINITION_OUTDATED`, so check that it is what your hosts have (0.1 builds say `1`). The `For agents running` line appears when the release names the oldest agent that may take it.

When a build doesn't match, nothing is written and each difference is named:

```text
vectory: not signed: the builds in release.json don't match SHA256SUMS:
  vectory-0.1.1-linux-amd64: release.json says 4206fd2a4cefdeff00f444007d1346ec2ca0d60edf58c0392d5f15a0f275981f and SHA256SUMS says 0000000000000000000000000000000000000000000000000000000000000000
  SHA256SUMS has no line for vectory-0.1.1-windows-amd64.exe
```

An existing signature file keeps what it holds. `sign` adds a signature only for a key that isn't in the file yet, up to four. It says `already holds this signature` when the file has this key's signature of this manifest, and refuses a signature by the same key that isn't of this manifest, such as an older release's file. A file that isn't a signature file is never overwritten.

### release rollover

Hand a release key over to a new one without anyone logging in to the hosts that pin it. The old key signs a statement that names its successor, and a host that pins the old key follows the statement when it is offered a release the new key signed.

| Flag | Meaning |
| --- | --- |
| `--key FILE` | Required. The private key being replaced. |
| `--to FILE` | Required. A file that holds the new key's public key line. |
| `--out FILE` | Write the statement here. The default is `rollover.json`. The file must not exist. |

```text
Wrote rollover.json: key 05cc6c02351af0cb hands over to key 5f0681261c9f25fa (team-next).
New key fingerprint, to compare with the key you made: 5f068126 1c9f25fa e4e8a4e2 e6701582 cf20e228 f711848b b8bc9db7 190acadb
Upload it in Settings → Agent updates. Hosts that pin the old key follow it when they are offered a release the new key signed.
```

The file holds the statement and its signature, both in base64: `{"statement":"…","signature":"…"}`. A key can't replace itself, and the new key must be a valid key line. Compare the fingerprint it prints with the one `keygen` printed for the new key before you upload.

### release verify

Check a release the way a host does, with the one function every host uses: the signature, the format of the manifest and its expiry.

| Flag | Meaning |
| --- | --- |
| `--key FILE` | Required. A file that holds the public key line to verify with. |
| `--signatures FILE` | The signature file. The default is `release.json.sig` beside the manifest. |

```text
Valid: release.json is signed by key 05cc6c02351af0cb (team).
Agent 0.1.1 · counter 7 · expires 2027-04-01 12:00 UTC (in 180 days)
  Issued 2026-10-03 12:00 UTC · service definition 1
  For agents running 0.1.0 or newer
  linux/amd64    vectory-0.1.1-linux-amd64        15204352 bytes  sha256 4206fd2a4cefdeff…
  windows/amd64  vectory-0.1.1-windows-amd64.exe  15892480 bytes  sha256 25043433d22cf8f6…
This check has no counter floors or running version. A host also checks those, its track, its platform and its service definition.
```

When a host would refuse the release, `verify` exits `1` and prints the code the host reports:

```text
vectory: SIGNATURE_INVALID: the signature of the pinned key doesn't verify over release.json
```

| Code | Means |
| --- | --- |
| `RELEASE_KEY_INVALID` | The key file isn't a valid public key line: malformed, not the canonical encoding of a point on the curve, or a point of small order. |
| `SIGNATURE_INVALID` | The signature file isn't valid, or no signature in it verifies with the key. |
| `KEY_NOT_PINNED` | No signature in the file names this key. |
| `MANIFEST_INVALID` | `release.json` breaks a rule of its format: a duplicate or unknown member, a number such as `1e2` or `07`, a byte that isn't printable ASCII, a counter outside 1 to 2^53−1, a file name that doesn't match its platform, and so on. It also covers an `issued_at` more than 24 hours ahead of your clock. |
| `MANIFEST_EXPIRED` | The clock of the machine you run `verify` on is at or after `expires_at`. |

The exit codes are `0` when the release is valid, `1` when it isn't or a file can't be read, and `2` for a mistake in the command.

## version and help

```sh
vectory version
vectory help
```
