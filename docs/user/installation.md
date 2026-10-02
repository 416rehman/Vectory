# Connect a device

Install the Vectory agent on a host that runs Vector 0.58 (any patch release, such as 0.58.0 or 0.58.1). The agent connects out to your server, runs the pipelines you deploy and reports what Vector is doing. It takes about five minutes per host.

> [!TIP]
> **Fastest path**
> [**Devices → Add device**](/#/enrollment) builds the exact command for your server, operating system and token. This page explains what that command does and how to do each step by hand.

## Before you start

- **Vector 0.58.x** is installed on the host (`vector --version`). Vectory never installs or upgrades Vector. The official [packages and archives](https://vector.dev/download/) all work.
- **An enrollment token.** **Add device** creates one with the install command. It's shown once, works for one enrollment and expires after 1 hour. Change both under **Advanced**, where you can also list the device names it may enroll and labels for the devices it enrolls. **Start over**, next to **Copy token**, revokes it when you don't need it; one you leave unused is listed with **Revoke it** when you come back. Tokens from **Manage enrollment tokens** default to 24 hours and any number of devices.
- **Network:** the host can reach `https://<your-server>:8443`. The host needs no inbound ports.
- **Administrator rights** on the host (`sudo`, or an elevated PowerShell on Windows) to install the agent and register its service.

## Choose a starting workload

| Option | Choose it when | What happens |
| --- | --- | --- |
| **Start without a workload** (recommended) | The host should wait for its first pipeline. | Vector doesn't run until you deploy a version. |
| **Keep an existing workload** | Vector already ships data that must not stop. | You hand its configuration to the agent first, and setup copies the old files. |

### Start without a workload

The agent checks in and waits. Vector starts only after you [deploy a published version](deployments.md#deploy-a-published-version) to the device. Enrollment never assigns a pipeline or joins a group.

### Keep an existing workload

Prepare the handover while the old Vector is still running:

<!-- steps -->
1. In Vectory, open **Pipelines → Create pipeline**, then **Actions → Import configuration file** and choose the running config (YAML, TOML or JSON; combine several files into one first). Fix anything the import flags.
2. In **Code** view, choose **JSON**, then **Actions → Export configuration**.
3. Copy the exported file to the host as the agent's managed configuration, for example `/etc/vectory/managed/vector.json`. Provision everything it reads: files, credentials, `data_dir`, and in restricted mode the [allowances](#configure-restricted-allowances) it needs.
4. With the old Vector still running, run the install command from [Install and enroll](#install-and-enroll). Setup never takes over a running Vector: it records how it was started, copies every configuration file it loads and stops, telling you what to do next. If it names files the agent won't manage, see [Adopt a Vector that already runs](agents.md#adopt-a-vector-that-already-runs).
5. Stop and disable the old Vector service, then run the same command again to install and enroll the agent. Add `--adopt-existing` if setup asked for it.
6. Confirm your outputs still flow. The device shows no assignment until you deploy a version; its adopted configuration keeps running meanwhile.

> [!CAUTION]
> Don't convert the configuration with `vector convert-config`. In Vector 0.58 its JSON output expands every default and fails `vector validate`.

The agent backs up the managed file it adopts and, when the old Vector runs as setup starts, every configuration file that Vector loads (in `adoption-inventory` in the state directory). It doesn't copy the files those configurations refer to, such as certificates, lookup tables and secret files, or the old service definition, so keep your own backup of those.

## Choose restricted or full mode

| Mode | Pipelines can use | The host operator |
| --- | --- | --- |
| **Restricted** (default) | A reviewed set of components, plus only the files, destinations and listeners approved on the host. | Approves each file root, `host:port` destination and listener in a local allowance file. |
| **Full Vector** | Everything the host's Vector can do: every component, secret providers, environment variables, external VRL files and any file or network. | Trusts everyone who can publish pipelines with Vector's permissions on this host. |

> [!IMPORTANT]
> **Only the host can turn on full mode**
> Full mode is chosen with a local flag when you install the agent. The dashboard shows each device's mode and blocks deployments that need full mode on restricted devices, but it can never grant full mode or widen local allowances.

Restricted mode allows these components: `demo_logs`, `internal_metrics`, `file`, `http_server`, `syslog` and `opentelemetry` sources; `remap`, `filter`, `route`, `sample`, `reduce` and `log_to_metric` transforms; `console` (to stderr), `blackhole`, `http`, `loki`, `elasticsearch` and `prometheus_exporter` sinks. It also blocks environment variables, `{{ }}` templates, secret providers and anything that runs a program. [Security model](security.md#restricted-and-full-mode) has the complete rules.

## Install and enroll

<!-- tabs:os -->
#### Linux

On **Add device**, choose **Restricted** or **Full Vector**, then **Create install command**, and run the result on the host. With a private CA (the usual case) it looks like this:

```sh
printf '%s\n' '-----BEGIN CERTIFICATE-----
<your server's CA certificate, as Add device shows it>
-----END CERTIFICATE-----' > vectory-ca.pem &&
curl -fsSL --cacert vectory-ca.pem \
  -o vectory-install.sh \
  https://vectory.example.com:8443/agent/v1/install.sh &&
echo '<sha256 shown on Add device>  vectory-install.sh' \
  | sha256sum -c - &&
sudo sh vectory-install.sh \
  --mode restricted \
  --create-user
```

Every step checks what it receives, and nothing turns certificate verification off. The command saves your server's CA certificate (public, like its fingerprint) as `vectory-ca.pem`, and curl verifies the server against it. The SHA-256 from your dashboard then proves the installer is the one the page describes, and the installer checks the agent and pins the CA for setup. The command works in any POSIX shell: sh, dash, bash and zsh. With another choice under [**How the host checks this server**](#trust-the-server-certificate), curl uses that CA file or the host's own certificate store instead.

#### macOS

On **Add device**, choose **Restricted** or **Full Vector**, then **Create install command**, and run the result in Terminal. It is the Linux command with `shasum -a 256 -c -` in place of `sha256sum -c -`.

The installer finds Vector through your `PATH` and Homebrew, and adopts the real binary behind Homebrew's link.

#### Windows

On **Add device**, choose **Windows**, download `vectory.exe` from the page, and run the command it shows in an elevated PowerShell in the same folder. The command checks the file's SHA-256 before it runs setup. It makes no web request of its own, so there is no certificate check to skip; the agent then verifies the server itself, the way you chose. For configuration management, use the [manual steps](#install-manually).
<!-- /tabs -->

The installer and `vectory setup` then:

<!-- steps -->
1. Detect the operating system and CPU, download the matching agent from your server, and check it against the SHA-256 embedded in the installer. It installs to `/usr/local/bin/vectory` (or the **Agent install directory** under **Advanced**, `--install-dir DIR`) with mode `0755`, whatever your umask, and the service runs it from there.
2. Find Vector 0.58.x and adopt that exact binary. Its SHA-256 is recorded, and a changed binary is refused until you [approve it](agents.md#replace-the-vector-binary).
3. Install in the mode you chose on **Add device**.
4. Ask for the enrollment token (typing stays hidden) and enroll, checking the server the way you chose on **Add device** (the pinned CA unless you changed it). See [Trust the server certificate](#trust-the-server-certificate).
5. Register the agent as a service, start it and wait for its first check-in. If the service already runs an older agent, it is restarted on the new one. A host without a service manager, such as most containers, WSL and Alpine with OpenRC, has nothing to register: setup checks in once, prints `[!!] Service` with the exact command that starts the agent, and exits with code 3, because the agent isn't running yet. See [Keep the agent running](#keep-the-agent-running).

The token is never part of the URL, the command or the installer script. The command and the installer contain only public values: your server's address, its CA certificate and fingerprint, and the checksums.

If you type a device name on **Add device**, the command's token enrolls only that name: a copied command can't enroll a host under another one. The token list shows it as **Only** followed by the name. A token pasted short or mangled is refused on the host before anything is sent.

### Keep tokens out of shell history

| Method | Use it for |
| --- | --- |
| Hidden prompt (default) | Interactive setup. Nothing lands in history. |
| `--token-stdin` | Scripts: `vectory enroll ... --token-stdin < token.txt` |
| `--token-file PATH` | Configuration management. The file must be a regular, local file owned by you or root, with mode `0600` (on Windows, an access list limited to you, SYSTEM and Administrators). |

Avoid `--token VALUE`: other users can read it from the process list and your shell keeps it in history. A leaked token can enroll new devices until it expires, is used up or is revoked in **Add device**. It can never sign in to the dashboard.

## Install manually

Use these steps for air-gapped hosts, configuration management or Windows. Download the agent for the host's OS and CPU from **Add device** and check its SHA-256 against the value shown there.

<!-- tabs:os -->
#### Linux

```sh
sudo install -m 0755 vectory /usr/local/bin/vectory
sudo vectory install \
  --vector-binary /usr/bin/vector \
  --managed-config /etc/vectory/managed/vector.json \
  --adopt
sudo vectory enroll \
  --server https://vectory.example.com:8443 \
  --ca-file /etc/vectory/trust/server-ca.pem \
  --name web-01
sudo useradd --system --no-create-home --shell /usr/sbin/nologin vectory
sudo vectory service-install --service-user vectory
sudo vectory service-start
```

#### macOS

```sh
sudo install -m 0755 vectory /usr/local/bin/vectory
sudo vectory install \
  --vector-binary "$(realpath "$(which vector)")" \
  --managed-config "/Library/Application Support/Vectory/managed/vector.json" \
  --adopt
sudo vectory enroll \
  --server https://vectory.example.com:8443 \
  --ca-file "/Library/Application Support/VectoryTrust/server-ca.pem" \
  --name mac-01
sudo vectory service-install --service-user "$SERVICE_USER"
sudo vectory service-start
```

Set `SERVICE_USER` to an existing unprivileged account first; the service runs as that account. `realpath` resolves Homebrew's link, because the agent refuses symlinked paths.

#### Windows

```powershell
New-Item -ItemType Directory -Force 'C:\Program Files\Vectory' | Out-Null
Copy-Item .\vectory.exe 'C:\Program Files\Vectory\vectory.exe'
Set-Location 'C:\Program Files\Vectory'
.\vectory.exe install `
  --vector-binary 'C:\Program Files\Vector\bin\vector.exe' `
  --managed-config 'C:\ProgramData\Vectory\managed\vector.json' `
  --adopt
.\vectory.exe enroll `
  --server https://vectory.example.com:8443 `
  --ca-file 'C:\ProgramData\VectoryTrust\server-ca.pem' `
  --name win-01
.\vectory.exe service-install
.\vectory.exe service-start
```

The Windows service runs as the virtual account `NT SERVICE\Vectory`.
<!-- /tabs -->

- Add `--allow-full-vector-config` to `install` only when you have [chosen full mode](#choose-restricted-or-full-mode).
- Add `--capability-policy PATH` to `install` for [restricted allowances](#configure-restricted-allowances).
- Pass `--ca-sha256` with the fingerprint from **Add device** instead of `--ca-file` to pin the CA, or `--ca-file=` when the operating system already trusts your server's certificate. See [Trust the server certificate](#trust-the-server-certificate).
- Paths must be absolute and must not pass through a symlink. On macOS, avoid `/var` and `/tmp`, which are symlinks.

The agent makes the managed configuration's folder private. Don't point it at a folder that holds unrelated configuration or secrets.

## Trust the server certificate

The token proves the host may enroll; the certificate proves it is talking to your server. So the agent checks the server's certificate before it sends the enrollment token, and on every connection after that. No option in the commands, the installer or the agent turns the check off.

Choose how under **Advanced → How the host checks this server** on **Add device**. The commands carry exactly the matching option:

| Choice | Use it when | The commands get |
| --- | --- | --- |
| **Pin this server's CA** (the default for a private CA) | Typical self-hosting: the agent listener's certificate comes from your own CA. | `--ca-sha256` with the CA's fingerprint for setup. The install command writes the CA certificate to `vectory-ca.pem`, and curl checks the download against it. Nothing to copy first. |
| **A CA certificate file on the host** | Your team already distributes the CA. Put its certificate (PEM) on the host first. | `--ca-file PATH` for setup, and `curl --cacert PATH` for the download. |
| **The host's trusted certificates** (the default for a publicly trusted certificate) | A public certificate, or a private CA the host's trust store already contains. | `--ca-file=` (empty: the host's store) for setup; curl uses the same store. |

On a manual install, pass the same options to `vectory setup` or `vectory enroll`: `--ca-sha256 HEX`, `--ca-file PATH`, or `--ca-file=`. Leaving them out keeps the trust an existing installation already saved.

A pinned fingerprint is checked before anything is sent. The agent accepts the server only if its chain contains a certificate with exactly that fingerprint, then verifies the host name and validity with that certificate as the only trusted root. It saves the certificate, so later connections are ordinary verified TLS. It never trusts a certificate on first use and never falls back to an unverified connection.

Add device shows the whole fingerprint, in rows of eight pairs, with **Copy**. If setup finds a different certificate, it prints both fingerprints in full and marks the first byte that differs, so you can compare them with the page. Without a pin, if the host doesn't trust the server's CA, setup prints the fingerprint of the certificate it was sent in the same rows of eight pairs, to compare; use the command from **Add device** rather than pinning what the host was sent.

For `--ca-file`:

- Use the CA that issued the **agent listener's** certificate. It can differ from the dashboard's. Ask whoever runs the server for it; with the development PKI (`scripts/preview.sh`), it is `.local/pki/ca.pem` on the server.
- Copy only the public certificate, never a private key, over a channel you trust. Compare its fingerprint with **Add device** before you use it: `openssl x509 -in ca.pem -noout -fingerprint -sha256`.
- Store it at a stable, absolute path the agent's service account can read. The agent reads it again on every connection. On Windows, use a local drive, not a network share.
- The server's `device-ca.pem` signs device identities. It is not the certificate that proves the server's identity.

Opening the dashboard in your browser doesn't make the device trust the server; each device verifies its own connection.

## Configure restricted allowances

A new restricted installation can't read files, reach destinations or open listeners. List the ones your pipelines need in a JSON file, save it on the host, and pass it to `install` with `--capability-policy`:

```json
{
  "allowed_file_roots": ["/var/log/nginx", "/var/lib/vectory-data"],
  "allowed_network_hosts": ["logs.example.net:443"],
  "allowed_listen_addresses": ["0.0.0.0:1514"]
}
```

- File roots are absolute paths. Destinations and listeners are exact `host:port` pairs.
- The monitoring exporter that **Add monitoring** adds needs no entry. See [Enable real metrics](telemetry.md#enable-real-metrics).
- Save the file as UTF-8 without a byte-order mark, with no comments and no duplicate names. On Windows, double each backslash: `"C:\\ProgramData\\VectoryData"`.
- The file replaces all three lists. Keep every entry the device still needs; `{}` removes them all.
- Allowances don't create folders, grant operating-system permissions or turn on full mode.
- Never allow the agent's own state directory as a file root.

**Add device** can put the file's path into the generated command, but it never uploads or checks the file. Only someone with access to the host can approve these resources. To add one later and keep the rest, run `sudo vectory allow` with the agent stopped, for example `sudo vectory allow --network logs.example.net:443`. See [Update restricted allowances](agents.md#update-restricted-allowances).

> [!NOTE]
> Allowances limit what a pipeline can ask Vector to do. They are not an operating-system sandbox, so keep using host permissions and network controls where you need stronger isolation.

## Keep the agent running

The installer registers a service: systemd on Linux, launchd on macOS, and the Service Control Manager on Windows. The service starts at boot and restarts the agent if it stops.

To try the agent without a service, run it in the foreground with `sudo vectory run`. Ctrl-C stops the agent and the Vector process it manages, after Vector finishes its in-flight events. Closing the terminal does the same. Stopping or restarting the service drains Vector the same way.

### Hosts without a service manager

Containers, WSL and Alpine (OpenRC) usually have no systemd for the agent. There, setup still installs and enrolls the agent and checks in once, then stops and says so:

```text
[!!] Service      No supported service manager here (systemd isn't running in this container), so the agent stopped after its first check-in.
                  Keep it running with your own supervisor: /usr/local/bin/vectory run --state-dir /var/lib/vectory-agent
```

It exits with code 3, and **Add device** reads "*name* checked in once, but nothing keeps its agent running". Run that exact command under whatever keeps processes running on the host: the container's entrypoint, supervisord, or a service you write for OpenRC. The device shows as connected when it checks in again. Until then it goes offline after three check-in intervals.

`--service none` says you'll run the agent yourself: setup registers nothing, prints the same command, and exits with code 0. `--create-user` has no effect without a service, and setup says so: the agent runs as whoever starts it.

- The service records the agent's path when you register it, so keep the binary at a stable location.
- On Linux and macOS the service runs as an unprivileged account. Registration hands the state and managed-configuration folders to that account. Make sure it can also read your CA file and everything your pipelines use.
- A running Vector keeps working when the server is unreachable. Stopping the agent stops its Vector.
- On Linux the agent's own messages go to the journal: `journalctl -u vectory.service`. On macOS and Windows the service keeps no log of its own: `vectory status` shows the last check-in error, and `vectory logs` shows Vector's log.

Registering a service doesn't prove it started. [Verify the first connection](#verify-the-first-connection) next.

## Verify the first connection

Open [**Devices**](/#/devices). The host appears with its name, mode and a recent check-in. It has no pipeline yet.

On the host:

```sh
sudo vectory status
sudo vectory doctor
```

`status` shows the device's identity, server, last check-in and pipeline. `doctor` checks the local setup and the connection to your server, and prints a fix for each problem. If the device stays offline, see [A device is offline](troubleshooting.md#a-device-is-offline-or-never-connects).

## Next steps

- [Deploy your first pipeline](first-pipeline.md) to this device.
- [Run and maintain agents](agents.md): upgrades, local settings, identity recovery and removal.
