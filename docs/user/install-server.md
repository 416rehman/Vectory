# Install the server

The full Vectory server installs from signed, prebuilt artifacts. Choose Docker on Linux, Windows or macOS, or the native Linux kit without Docker. One guided command starts the dashboard, isolated Vector validator and HTTPS proxy. No compiler or language toolchain is needed.

## What you need

| Requirement | Details |
| --- | --- |
| Computer | Linux with Docker Engine and Compose, Windows/macOS with Docker Desktop, or Linux x86-64 with systemd 252 or later and cgroup v2 for native installation. Docker uses Linux x86-64 images; Apple silicon requires amd64 emulation. |
| Address | A DNS name pointing to the server, for example `vectory.example.com`. |
| Network | TCP 80 and 443 reachable for automatic HTTPS; TCP 8443 reachable from managed devices. Devices connect out and need no inbound ports. |
| Storage | Local, durable disk. Run one server per data directory; do not put SQLite on a network filesystem. |

## Install

On Linux, run:

```sh
curl -fsSL --proto '=https' https://vectory.ahmadz.ai/install.sh -o vectory-install.sh &&
bash vectory-install.sh
```

On macOS, run in Terminal:

```sh
curl -fsSL --proto '=https' https://vectory.ahmadz.ai/install-desktop.sh -o vectory-install.sh &&
bash vectory-install.sh
```

On Windows, run in PowerShell:

```powershell
curl.exe -fsSL --proto '=https' https://vectory.ahmadz.ai/install.ps1 -o vectory-install.ps1
if ($LASTEXITCODE -eq 0) {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\vectory-install.ps1
} else {
  throw 'Installer download failed'
}
```

Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) or [Docker Desktop for macOS](https://docs.docker.com/desktop/setup/install/mac-install/) first, and wait for its engine to start. On Windows, select Linux containers. On Apple silicon, configure [amd64 emulation](https://docs.docker.com/desktop/settings-and-maintenance/settings/) and confirm the installer prompt. This runs the prebuilt x86-64 images; it does not claim a native Arm image. Docker Desktop forwards the published ports to your computer, so its host firewall and router must permit the connections.

The downloaded installer is readable source delivered over HTTPS. It is separate from the signed release archive. It verifies the release's Sigstore bundle against Vectory's GitHub release workflow identity, checks the server kit before extracting it, and verifies immutable server and validator image digests before using their original Compose templates. Cosign runs in a pinned Docker container; no separate verifier installation is required. Windows uses a process-only script-policy setting, with no saved policy change.

Enter the hostname when asked. The default uses automatic HTTPS: Caddy obtains and renews the public dashboard certificate. A separate retained private CA protects agent connections, and its listener certificate renews automatically without disconnecting enrolled devices. **Add device** includes the correct agent trust in each install command. There is no CA file to distribute by hand.

Point the hostname's DNS record directly to your server and open the ports listed above. With Cloudflare DNS, select [DNS only](https://developers.cloudflare.com/dns/proxy-status/) for this server hostname so devices reach its mutual-TLS listener directly. A custom reverse proxy must keep port 8443 as TCP passthrough; ordinary HTTP proxying terminates the device connection's TLS.

## Install without Docker on Linux

Use an x86-64 Linux host booted with systemd 252 or later and unified cgroup v2. The native kit targets Ubuntu 24.04; [compatibility](compatibility.md) records the systems tested for each installer. It includes the prebuilt server, dashboard, Help center, agents, isolated validator, Vector and Caddy. The server and validator carry their own runtime libraries; you do not compile them or supply a customer Rust or Go environment.

Run:

```sh
curl -fsSL --proto '=https' \
  https://vectory.ahmadz.ai/install-native.sh -o vectory-install-native.sh &&
sudo bash vectory-install-native.sh
```

Enter the server's DNS name and optionally an email for certificate notices. The HTTPS bootstrap downloads an official prebuilt Cosign verifier at an independently pinned SHA-256, authenticates the exact GitHub release workflow identity, checks the native kit's signed digest and safe file inventory, then starts the verified installer. It does not execute a downloaded kit's own verifier before independent authentication.

Caddy obtains and renews public dashboard HTTPS. Separate private certificate material protects the native agent listener. The validator is a separate unprivileged systemd service with its own filesystem, no internet access and bounded resources. The manager reaches it through a private Unix socket. Devices still validate the installed Vector and their host-specific configuration before applying a version.

The setup output provides your dashboard URL and one-time administrator secret. Manage the retained instance with:

```sh
sudo /opt/vectory-server/0.2.1/start.sh status
sudo /opt/vectory-server/0.2.1/start.sh setup-secret
sudo /opt/vectory-server/0.2.1/start.sh stop
sudo /opt/vectory-server/0.2.1/start.sh start
```

Payloads live under `/opt/vectory-server/<version>`, configuration and release proof under `/etc/vectory-server`, and complete database, identity and certificate state under `/var/lib/vectory-server`. Stop services before backing up both retained directories, preserving ownership and private permissions. Restore the complete reviewed instance; copying the database alone does not restore device trust.

For offline administrator recovery or diagnostics that change the database, stop the server first and use `/opt/vectory-server/0.2.1/admin.sh` with the command described in [server administration](administer.md). The wrapper runs the retained executable with its bundled libraries as the server account and refuses an active server. Do not run the native `vectory-admin` binary directly against your host's libraries.

For local evaluation without public certificate issuance, pass `--tls-mode local` and a hostname when running the bootstrap. Caddy creates a private issuer and leaves your host trust store unchanged. Explicitly trust its public issuer through your trusted channel before using the browser. Public fleet installation should use automatic public HTTPS or an organization-managed trust arrangement.

## Create the first administrator

When the services are healthy, the starter prints your HTTPS URL and the setup secret. Open the URL, paste that secret and choose your name, email and password. There are no default accounts and no public sign-up.

The setup secret creates the first administrator once. It is not an enrollment token or a sign-in password. From the Linux Docker kit directory, `./start.sh setup-secret` retrieves it while setup is incomplete. The guided bootstrap creates that directory at `./vectory`; enter it first with `cd vectory`. After setup, [enable an authenticator](administer.md#set-up-an-authenticator), [connect a device](installation.md), and [deploy your first pipeline](first-pipeline.md).

On macOS, use `bash vectory-install.sh setup-secret` from the directory containing your downloaded installer. On Windows, use `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\vectory-install.ps1 -Action setup-secret` there. These bootstrap scripts manage the default `vectory` subdirectory; retain it and the script for later operations.

## Configure the desktop installation

The default is one instance called `vectory`, listening on all network interfaces. Choose a separate project and installation directory when running more than one instance. Every instance also needs nonconflicting ports; the provided automatic-HTTPS template uses 80, 443 and 8443.

| Choice | Windows option | macOS environment setting |
| --- | --- | --- |
| Kit directory | `-Directory <absolute-path>` | `VECTORY_INSTALL_DIRECTORY=<absolute-path>` |
| Instance name | `-Project <name>` | `VECTORY_SERVER_PROJECT=<name>` |
| DNS name | `-Hostname vectory.example.com` | `VECTORY_HOSTNAME=vectory.example.com` |
| Listen address | `-BindIp <IPv4-address>` | `VECTORY_BIND_IP=<IPv4-address>` |
| Deliberate amd64 emulation | `-AllowAmd64Emulation` | `VECTORY_ALLOW_AMD64_EMULATION=true` |
| Existing certificate pair | `-CertificateMode custom -CertificateFile <absolute-path> -KeyFile <absolute-path>` | `VECTORY_CERTIFICATE_MODE=custom VECTORY_TLS_CERT_FILE=<absolute-path> VECTORY_TLS_KEY_FILE=<absolute-path>` |

A project name uses up to 40 lowercase letters, digits or hyphens. The kit retains that name, hostname and listen address in `.env` so a later start cannot silently replace the certificate identity or select different volumes. Use the same installation directory for start, stop and status. Retained `.env` settings such as `VECTORY_MAX_AGENT_CONNECTIONS`, `VECTORY_TELEMETRY_RETENTION_DAYS` and `VECTORY_PUBLIC_AGENT_DOWNLOADS` remain configurable. Signed image references are controlled by the verified release and cannot be replaced through inherited environment values.

Docker Desktop must stay running. Quitting it, sleeping the computer or deleting its named volumes interrupts the installation. For an always-on fleet manager, use a dedicated computer with durable local Docker storage and tested backups.

## Use your own certificate

The starter also accepts an existing TLS certificate and private key for private networks or organizations that manage certificates centrally. On Linux with Docker, choose custom mode before the first start:

```sh
curl -fsSL --proto '=https' https://vectory.ahmadz.ai/install.sh -o vectory-install.sh &&
VECTORY_CERTIFICATE_MODE=custom bash vectory-install.sh
```

Provide the full-chain PEM and key PEM at absolute paths when asked. If you verified and extracted the kit manually, run `VECTORY_CERTIFICATE_MODE=custom ./start.sh` inside it. On macOS, run `VECTORY_CERTIFICATE_MODE=custom bash vectory-install.sh`. On Windows, pass `-CertificateMode custom` to the downloaded installer. You can provide the file paths as the options listed above or enter them when asked.

The starter checks the hostname, validity and matching key inside the verified server image before committing the pair to its private certificate volume. A retry after interrupted setup retains the validated identity. A normal restart keeps existing trust and refuses replacement-file arguments; it does not reset the server's identity or add anything to your computer's trust store. Custom certificates are renewed by you, while automatic mode renews its retained certificates itself.

For a private issuer, include its public CA certificate after the server certificate in the chain. Keep the CA private key separate. Browsers must trust that issuer, and **Add device** carries the public agent CA and its fingerprint in the command. [Certificate trust](installation.md#trust-the-server-certificate) explains the advanced choices.

## Stop, resume and check

Run from the kit directory:

```sh
./start.sh status
./start.sh stop
./start.sh
```

Stopping retains the database and certificate volumes. Resuming uses the same workspace and trust. The kit's `.env` records the selected hostname and immutable image references; retain it with your backups.

On macOS, use `bash vectory-install.sh status`, `bash vectory-install.sh stop` and `bash vectory-install.sh`. On Windows, use the downloaded PowerShell installer with `-Action status`, `-Action stop` or `-Action start`. Run from the original download directory, or supply your chosen kit directory. The `start.sh` inside the unchanged signed kit is the Linux starter; it is not the desktop entry point.

For diagnostics:

```sh
docker compose logs --tail 100 server proxy validator
```

The starter waits for the validator, server and proxy health checks. If native validation is unavailable, publishing stops; the server does not silently skip it.

## What runs

| Service | Purpose |
| --- | --- |
| `proxy` | Caddy serves the dashboard over HTTPS. Automatic mode renews its public certificate; custom mode uses your supplied pair. It does not forward `/agent/` routes. |
| `server` | Dashboard, API, bundled Help center, SQLite state and the native mutual-TLS agent listener on 8443. |
| `validator` | Vector 0.58.0 validation on an internal network, with no internet route, published host ports or production secrets. |
| Certificate maintenance | Automatic mode retains the private agent issuer and renews its listener certificate before expiry. Custom mode leaves renewal of supplied certificates to you. |

The server and validator run as separate unprivileged users with read-only filesystems, dropped capabilities and bounded resources. Every supported agent download is already inside the server image; you do not build or fetch agents separately.

## Offline installation

The prepared offline path uses the Linux x86-64 Docker starter. On a connected Docker host, verify and extract the server kit from the [release page](https://github.com/416rehman/Vectory/releases/tag/v0.2.1), then run from that kit:

```sh
./prepare-offline.sh /absolute/path/vectory-offline
```

Preparation verifies the actual release and creates a source-free kit with authenticated Vectory image archives, the pinned Cosign and Caddy images, and the independently verified Sigstore trust cache. It does not start a manager. Transfer the **entire output directory**, including `.cache`, over your trusted channel. On the offline host, run from the transferred directory:

```sh
VECTORY_OFFLINE=true VECTORY_CERTIFICATE_MODE=custom ./start.sh
```

Supply your HTTPS certificate and matching private key when asked. The loader verifies signatures, archive checksums and immutable local image identities; Compose disables network pulls. A checksum inventory alone cannot establish independent trust in Sigstore's root.

After installation, the dashboard, documentation, fonts and search need no outside requests. Agent downloads come from your server. Vector's own files, credentials and binaries must be available on each managed host.

The desktop bootstrap's signature checks and image pulls use the internet on start. The native bootstrap also authenticates its first install online. Neither replaces the prepared Linux Docker offline workflow described above. Their running dashboards and bundled documentation do not depend on an outside CDN.

## Keep the installation healthy

- [Back up and restore the server](administer.md).
- [Upgrade the server](administer.md#upgrade-the-server) using a verified new kit and the same retained state.
- Review [compatibility](compatibility.md), [security](security.md) and [operational limits](whats-new.md#known-limits) for the workload you plan to run.
