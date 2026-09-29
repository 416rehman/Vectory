# Agent CLI

Every command and flag of `vectory`, the agent that runs on each device. For step-by-step tasks, see [Connect a device](installation.md) and [Manage agents](agents.md).

## Usage

```text
vectory <command> [flags]
```

- Flags take `--name value` or `--name=value`. Commands accept flags only, never extra arguments.
- Commands that change the agent's files need administrator rights on the host (`sudo` on Linux and macOS).
- Exit codes: `0` success, `1` the operation failed, `2` invalid command or flags, `130` `setup` was interrupted with Ctrl-C.

Run `vectory --help` for the command list, `vectory help <command>` for one command, and `vectory --version` for the version.

## Flags for every command

| Flag | Meaning |
| --- | --- |
| `--state-dir PATH` | The agent's private state: identity, settings and recovery copies. Defaults: `/var/lib/vectory-agent` on Linux, `/Library/Application Support/Vectory/agent` on macOS, `C:\ProgramData\Vectory\agent` on Windows. Must be absolute. |
| `--json` | Print machine-readable JSON instead of text. |

## Commands at a glance

| Command | What it does | Agent must be stopped |
| --- | --- | --- |
| [`setup`](#setup) | Install, enroll and start the agent in one step. | No |
| [`install`](#install) | Adopt a Vector binary and managed configuration, or change local settings. | Yes, when changing an existing install |
| [`enroll`](#enroll) | Connect this host to a Vectory server with a one-time token. | No |
| [`run`](#run) | Run the agent in the foreground. | No |
| [`status`](#status) | Show identity, server, pipeline and next step. | No |
| [`doctor`](#doctor) | Check local setup and the server connection. | No |
| [`logs`](#logs) | Show Vector's own log (never your events). | No |
| [`pause`, `resume`](#pause-and-resume) | Stop or restart applying new versions on this host. | No |
| [`retry`](#retry) | Allow one more attempt at a rejected version. | Yes |
| [`configure-metrics`](#configure-metrics) | Set or clear the local metrics endpoint. | Yes |
| [`configure-secrets`](#configure-secrets) | Map `vectory-secret:NAME` references to local files. | Yes |
| [`re-adopt`](#re-adopt) | Approve a Vector binary you replaced on purpose. | Yes |
| [`recover-enrollment`](#recover-enrollment) | Replace a lost identity with an administrator's recovery token. | Yes |
| [`service-install`, `service-start`, `service-stop`, `service-uninstall`](#service-commands) | Manage the agent's operating-system service. | Varies |
| [`unenroll`](#unenroll) | Delete this host's credentials. | Yes |
| [`uninstall`](#uninstall) | Delete the agent's state with `--purge`. | Yes |
| [`version`, `help`](#version-and-help) | Print the version or usage. | No |

## setup

Install, enroll, register the service and wait for the first check-in, in one resumable step. The **Add device** installer runs it for you.

```sh
sudo vectory setup --server https://vectory.example.com:8443 --ca-sha256 FINGERPRINT
```

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
| `--service auto` | Service manager to register with: `auto`, `systemd`, `launchd`, `windows` or `none`. |
| `--service-user NAME`, `--create-user` | Account the service runs as, and whether to create it. |
| `--keep-existing-vector` | Continue even though another Vector is running. Setup leaves that Vector untouched. |
| `--dry-run` | Check everything and show the plan without changing anything. |
| `--json` | Print the result as JSON for scripts. |

`setup` never adopts a Vector that is already running. If it finds one, it stops and explains how to hand it over; `--keep-existing-vector` continues without touching it.

Before it asks for the token, `setup` checks that the service account can run Vector and the agent. A Vector under a private home folder, such as `/root/.vector/bin/vector`, is refused with the folder that blocks it: install Vector system-wide or pass `--vector-binary`.

Run `setup` again after replacing the agent binary to upgrade: it restarts the service on the new build and waits for that build's first check-in, for example `vectory.service upgraded 0.1.0 → 0.2.0 · first check-in 1.2 s after restart`. Vector finishes its in-flight events before the old agent exits. On Windows, where a running agent can't be replaced, setup first checks that the service is registered for this agent, then stops it; if a later step fails, it starts the service again and says which build it runs.

Ctrl-C while `setup` waits for the first check-in stops only the wait: the service keeps running, and `setup` exits with code `130`.

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
| `--capability-policy PATH` | Restricted-mode allowances. Replaces all three lists. |
| `--allow-full-vector-config` | Turn on full Vector mode. Use `--allow-full-vector-config=false` to return to restricted. |
| `--metrics-url URL` | Loopback Prometheus endpoint to read metrics from, for example `http://127.0.0.1:9598/metrics`. |
| `--clear-metrics-url` | Remove the saved metrics endpoint. |
| `--secret-files PATH` | JSON map of secret names to absolute private files. Replaces all bindings. |
| `--vector-data-dir PATH` | Data directory for pipelines that don't set `data_dir`. Empty restores the automatic choice: the adopted configuration's `data_dir`, then `/var/lib/vector` if it exists and is writable (not on Windows), then `<state-dir>/vector-data`. The automatic choice is made once, at the first activation, and kept, so checkpoints and disk buffers never move. |
| `--graceful-shutdown-seconds N` | How long Vector may drain on stop or restart before it is killed, 5 to 300. Default 60. |

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

Without a token flag, `enroll` asks for the token with hidden input. The older form `vectory -ip SERVER -id NAME -token TOKEN` still works and means `enroll`.

If an enrollment is interrupted, run the same command again with the same server, name and token. The agent reuses its pending request, so the server can't enroll the device twice.

## run

Run the agent in the foreground. It starts Vector, applies versions and checks in until you stop it with Ctrl-C. Vector then finishes its in-flight events (up to `--graceful-shutdown-seconds`, 60 by default) before both exit.

```sh
sudo vectory run
```

| Flag | Meaning |
| --- | --- |
| `--once` | (Testing) Check in and reconcile once, then stop. |

## status

Show the device's identity, server, last check-in, pipeline and the next step.

```sh
sudo vectory status
```

## doctor

Check the local setup and the connection to the server, and print a fix for each problem. It checks the adopted Vector binary, the managed configuration, the mode and metrics settings, then DNS, TLS, clock and credentials.

```sh
sudo vectory doctor
```

## logs

Show Vector's own log on this host: startup, reloads, and component warnings and errors. It never shows your events. The log lives in `<state-dir>/vector.log` and rotates at 10 MiB into one `.1` file. `logs` only reads files, so it works while the agent runs.

```sh
sudo vectory logs --follow
```

| Flag | Meaning |
| --- | --- |
| `--lines N` | How many recent lines to print. Default 100. |
| `--follow`, `-f` | Keep printing new lines until you press Ctrl-C. |
| `--raw` | Print the log file's lines unchanged. |
| `--json` | Print one JSON object per line: Vector's records as they are, and the agent's own notes with the same `timestamp`, `target` and `message` keys. |

## pause and resume

Stop applying new versions on this host, for example while you edit the managed configuration by hand. Vector keeps running. Works while the agent runs.

```sh
sudo vectory pause
sudo vectory resume
```

`resume` clears only the local pause; a pause set from the dashboard still applies.

## retry

Allow one more attempt at a version the agent rejected. Run it with the agent stopped, after fixing the cause.

```sh
sudo vectory retry
```

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

`vectory service` is the entry point the Windows service runs. You don't run it yourself.

## unenroll

Delete this host's credentials, keeping the installation. Also revoke the device in the dashboard: the host can't revoke its identity offline.

```sh
sudo vectory unenroll
```

## uninstall

Delete the agent's state directory. Stop and unregister the service first.

```sh
sudo vectory uninstall --purge --state-dir /var/lib/vectory-agent
```

| Flag | Meaning |
| --- | --- |
| `--purge` | Delete the state directory named by `--state-dir`, which is required. Vector and the managed configuration stay. |

Without `--purge`, `uninstall` changes nothing and reminds you to remove the service and binary.

## version and help

```sh
vectory version
vectory help
```
