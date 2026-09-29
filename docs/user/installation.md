# Connect a device

Install the Vectory agent on a host that runs Vector 0.58.0. The agent connects out to your server, runs the pipelines you deploy and reports what Vector is doing. It takes about five minutes per host.

> [!TIP]
> **Fastest path**
> [**Devices → Add device**](/#/enrollment) builds the exact command for your server, operating system and token. This page explains what that command does and how to do each step by hand.

## Before you start

- **Vector 0.58.0** is installed on the host (`vector --version`). Vectory never installs or upgrades Vector. The official [packages and archives](https://vector.dev/download/) all work.
- **An enrollment token.** **Add device** creates one with the install command. It's shown once, works for one enrollment and expires after 1 hour. Change both under **Advanced**. Tokens from **Manage enrollment tokens** default to 24 hours and any number of devices.
- **Network:** the host can reach `https://<your-server>:8443`. The host needs no inbound ports.
- **Administrator rights** on the host (`sudo`, or an elevated PowerShell on Windows) to install the agent and register its service.

## Choose a starting workload

| Option | Choose it when | What happens |
| --- | --- | --- |
| **Start without a workload** (recommended) | The host should wait for its first pipeline. | Vector doesn't run until you deploy a version. |
| **Keep an existing workload** | Vector already ships data that must not stop. | You hand its configuration to the agent first. |

### Start without a workload

The agent checks in and waits. Vector starts only after you [deploy a published version](deployments.md#deploy-a-published-version) to the device. Enrollment never assigns a pipeline or joins a group.

### Keep an existing workload

Prepare the handover while the old Vector is still running:

<!-- steps -->
1. In Vectory, open **Pipelines → Create pipeline**, then **Actions → Import configuration file** and choose the running config (YAML, TOML or JSON; combine several files into one first). Fix anything the import flags.
2. In **Code** view, choose **JSON**, then **Actions → Export configuration**.
3. Copy the exported file to the host as the agent's managed configuration, for example `/etc/vectory/managed/vector.json`. Provision everything it reads: files, credentials, `data_dir`, and in restricted mode the [allowances](#configure-restricted-allowances) it needs.
4. Stop and disable the old Vector service, then install and enroll the agent as below.
5. Confirm your outputs still flow. The device shows no assignment until you deploy a version; its adopted configuration keeps running meanwhile.

> [!CAUTION]
> Don't convert the configuration with `vector convert-config`. In Vector 0.58 its JSON output expands every default and fails `vector validate`.

The agent backs up the managed file it adopts. It doesn't copy other configuration files or the old service definition, so keep your own backup of those.

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

On **Add device**, choose **Restricted** or **Full Vector**, then **Create install command**, and run the result on the host. It looks like this:

```sh
curl -fsSLk https://vectory.example.com:8443/agent/v1/install.sh -o vectory-install.sh
echo '<sha256 shown on Add device>  vectory-install.sh' | sha256sum -c - &&
  sudo sh vectory-install.sh --mode restricted --create-user
```

`-k` only skips the download's TLS check. The SHA-256 from your dashboard proves the installer is genuine, and the installer then checks the agent and pins your server's CA.

#### macOS

On **Add device**, choose **Restricted** or **Full Vector**, then **Create install command**, and run the result in Terminal. It looks like this:

```sh
curl -fsSLk https://vectory.example.com:8443/agent/v1/install.sh -o vectory-install.sh
echo '<sha256 shown on Add device>  vectory-install.sh' | shasum -a 256 -c - &&
  sudo sh vectory-install.sh --mode restricted --create-user
```

`-k` only skips the download's TLS check. The SHA-256 from your dashboard proves the installer is genuine. The installer finds Vector through your `PATH` and Homebrew, and adopts the real binary behind Homebrew's link.

#### Windows

Use the [manual steps](#install-manually) in an elevated PowerShell.
<!-- /tabs -->

The installer and `vectory setup` then:

<!-- steps -->
1. Detect the operating system and CPU, download the matching agent from your server, and check it against the SHA-256 embedded in the installer. It installs to `/usr/local/bin/vectory`.
2. Find Vector 0.58.0 and adopt that exact binary. Its SHA-256 is recorded, and a changed binary is refused until you [approve it](agents.md#replace-the-vector-binary).
3. Install in the mode you chose on **Add device**.
4. Ask for the enrollment token (typing stays hidden) and enroll, trusting only the certificate pinned in the command. See [Trust the server certificate](#trust-the-server-certificate).
5. Register the agent as a service, start it and wait for its first check-in.

The token is never part of the URL or the installer script. The installer contains only public values: your server's address, its certificate fingerprint and the agents' checksums.

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
- Omit `--ca-file` when the operating system already trusts your server's certificate.
- Paths must be absolute and must not pass through a symlink. On macOS, avoid `/var` and `/tmp`, which are symlinks.

The agent makes the managed configuration's folder private. Don't point it at a folder that holds unrelated configuration or secrets.

## Trust the server certificate

The agent checks the server's certificate before it sends the enrollment token, and on every connection after that. There is no option to skip the check.

| Your server's certificate | What to do |
| --- | --- |
| Issued by a public CA, or a CA the host already trusts | Nothing. The host's trust store is used. |
| Issued by a private CA (typical for self-hosting) | Use the command from **Add device**. It pins the CA by its SHA-256 fingerprint (`--ca-sha256`), so there is no file to copy. |
| Private CA, manual install | Copy the CA's public certificate (PEM) to the host and pass `--ca-file PATH`. |

A pinned fingerprint is checked before anything is sent. The agent accepts the server only if its chain contains a certificate with exactly that fingerprint, then verifies the host name and validity with that certificate as the only trusted root. It saves the certificate, so later connections are ordinary verified TLS. It never trusts a certificate on first use and never falls back to an unverified connection.

Add device shows the start and end of the fingerprint; hover over it to see it in full.

For `--ca-file`:

- Use the CA that issued the **agent listener's** certificate. It can differ from the dashboard's.
- Copy only the public certificate, never a private key. Compare fingerprints before you use it: `openssl x509 -in ca.pem -noout -fingerprint -sha256`.
- Store it at a stable, absolute path the agent's service account can read. The agent reads it again on every connection. On Windows, use a local drive, not a network share.
- The server's `device-ca.pem` signs device identities. It is not the certificate that proves the server's identity.

Opening the dashboard in your browser doesn't make the device trust the server; each device verifies its own connection.

## Configure restricted allowances

A new restricted installation can't read files, reach destinations or open listeners. List the ones your pipelines need in a JSON file, save it on the host, and pass it to `install` with `--capability-policy`:

```json
{
  "allowed_file_roots": ["/var/log/nginx", "/var/lib/vectory-data"],
  "allowed_network_hosts": ["logs.example.net:443"],
  "allowed_listen_addresses": ["127.0.0.1:9598"]
}
```

- File roots are absolute paths. Destinations and listeners are exact `host:port` pairs.
- Save the file as UTF-8 without a byte-order mark, with no comments and no duplicate names. On Windows, double each backslash: `"C:\\ProgramData\\VectoryData"`.
- The file replaces all three lists. Keep every entry the device still needs; `{}` removes them all.
- Allowances don't create folders, grant operating-system permissions or turn on full mode.
- Never allow the agent's own state directory as a file root.

**Add device** can put the file's path into the generated command, but it never uploads or checks the file. Only someone with access to the host can approve these resources. To change them later, see [Change local settings](agents.md#change-local-settings).

> [!NOTE]
> Allowances limit what a pipeline can ask Vector to do. They are not an operating-system sandbox, so keep using host permissions and network controls where you need stronger isolation.

## Keep the agent running

The installer registers a service: systemd on Linux, launchd on macOS, and the Service Control Manager on Windows. The service starts at boot and restarts the agent if it stops.

To try the agent without a service, run it in the foreground with `sudo vectory run`. Ctrl-C stops the agent and the Vector process it manages.

- The service records the agent's path when you register it, so keep the binary at a stable location.
- On Linux and macOS the service runs as an unprivileged account. Registration hands the state and managed-configuration folders to that account. Make sure it can also read your CA file and everything your pipelines use.
- A running Vector keeps working when the server is unreachable. Stopping the agent stops its Vector.

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
