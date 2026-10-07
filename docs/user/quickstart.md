# Quickstart

Run the full Vectory server, connect a host, and deploy your first pipeline. Installation uses prebuilt containers or a prebuilt native Linux kit, plus prebuilt agents. You do not need Git, Rust, Go, Node.js or a compiler.

## 1. Start your server

Choose **Docker Engine with Compose on Linux**, **Docker Desktop on Windows or macOS**, or **native Linux without Docker**. The native kit requires an x86-64 host booted with systemd 252 or later and cgroup v2. Use a DNS name pointing to the computer. Allow inbound TCP **80 and 443** for HTTPS and **8443** from the devices you manage. Retain local, durable storage.

On **Linux with Docker**, start Docker Engine and Compose, then run:

```sh
curl -fsSL --proto '=https' https://vectory.ahmadz.ai/install.sh -o vectory-install.sh &&
bash vectory-install.sh
```

On **macOS**, run in Terminal:

```sh
curl -fsSL --proto '=https' https://vectory.ahmadz.ai/install-desktop.sh -o vectory-install.sh &&
bash vectory-install.sh
```

On **Windows**, run in PowerShell:

```powershell
curl.exe -fsSL --proto '=https' https://vectory.ahmadz.ai/install.ps1 -o vectory-install.ps1
if ($LASTEXITCODE -eq 0) {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\vectory-install.ps1
} else {
  throw 'Installer download failed'
}
```

On **Linux without Docker**, run:

```sh
curl -fsSL --proto '=https' \
  https://vectory.ahmadz.ai/install-native.sh -o vectory-install-native.sh &&
sudo bash vectory-install-native.sh
```

On Apple silicon, enable Docker Desktop's amd64 emulation and confirm the installer prompt. This release's server images are Linux x86-64, not native Arm images. The Windows command changes script policy only for that process. It does not change the computer's saved policy.

Enter your hostname when asked, for example `vectory.example.com`. The installer verifies the release signature and downloads the prebuilt server kit. Docker installations verify signed GHCR image identities and run Cosign in a pinned container. Native installation uses an independently pinned prebuilt verifier and starts the server, proxy and isolated validator as systemd services. Neither path requires a separate language toolchain or verifier installation.

Caddy obtains and renews the dashboard's HTTPS certificate automatically. Vectory creates and renews a separate certificate for agent connections. You do not need to find or copy CA files. The first start prints your dashboard URL and a one-time setup secret.

For a Docker installation that cannot receive public certificate requests, use the [custom certificate option](install-server.md#use-your-own-certificate). Native Linux evaluation can use `--tls-mode local`; [the native guide](install-server.md#install-without-docker-on-linux) explains its private issuer. The [server guide](install-server.md) also covers offline installation and backups.

## 2. Create your administrator

Open the printed HTTPS URL. Paste the setup secret and choose your administrator name, email and password. There are no default accounts.

To see the secret again before setup finishes on Linux with Docker, open the kit directory created by the bootstrap:

```sh
cd vectory
./start.sh setup-secret
```

On macOS, run `bash vectory-install.sh setup-secret` from the directory where you downloaded the installer. On Windows, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\vectory-install.ps1 -Action setup-secret` there. Keep the default `vectory` kit directory beside it, or pass the [chosen installation directory](install-server.md#configure-the-desktop-installation).

For native Linux, use `sudo /opt/vectory-server/0.2.1/start.sh setup-secret` instead. Native data and certificates live under `/var/lib/vectory-server`; its retained configuration and release proof live under `/etc/vectory-server`.

Your dashboard, searchable documentation and API reference are now running on your own server.

## 3. Connect a host

The host needs an existing **Vector 0.58.x** installation. Check with `vector --version`; if it is missing, use Vector's [prebuilt downloads](https://vector.dev/download/). Vectory does not compile, install or upgrade Vector.

1. Open **Devices → Add device** and choose Linux, macOS or Windows.
2. Name the device and choose its configuration mode. **Restricted** is suitable for the synthetic first pipeline. **Full Vector** gives pipeline authors the permissions Vector has on that host.
3. Create the install command, copy it, and run it on the host. Use Terminal on Linux or macOS, or **PowerShell as Administrator** on Windows.
4. Paste the enrollment token when the command asks for it. Keep the dashboard open until the device reports its first check-in.

The command downloads the correct prebuilt agent, verifies its checksum, checks your server's certificate and starts the service. It carries certificate trust automatically. Enrollment tokens are entered privately, rather than included in URLs or commands. Enrollment alone does not assign a pipeline or start a workload.

Use a host without an existing Vector workload for this first run. The [device guide](installation.md) explains how to preserve and hand over an existing workload.

## 4. Deploy a pipeline

1. Open **Pipelines → Create pipeline → Try a synthetic example**.
2. Choose **Review & publish → Publish version**.
3. Choose **Choose devices**, select your connected host and deploy.
4. Open the device and wait for **Applied**. This means the agent verified that Vector runs the selected version.

The example generates synthetic logs and discards them. It reads no host files and sends no events to an outside destination. [Your first pipeline](first-pipeline.md) explains each screen.

## Stop, resume and check

From the kit directory:

```sh
./start.sh status
./start.sh stop
./start.sh
```

Stopping retains your workspace and certificate trust. It does not stop Vector on enrolled hosts. Back up the database, retained certificate and identity volumes, and the kit's `.env`; see [Back up the server](administer.md#back-up-the-complete-state).

On macOS use `bash vectory-install.sh status`, `bash vectory-install.sh stop` and `bash vectory-install.sh` instead. On Windows use the downloaded installer with `-Action status`, `-Action stop` or `-Action start`. Docker Desktop must stay running; quitting it or sleeping the computer interrupts the server until Docker resumes.

For native Linux, use `sudo /opt/vectory-server/0.2.1/start.sh status`, `stop` or `start`. Back up its complete `/var/lib/vectory-server` and `/etc/vectory-server` directories while services are stopped, retaining file ownership and private permissions. See [native server installation](install-server.md#install-without-docker-on-linux).

If you only want to create or visualize a Vector configuration, try the [Vector config builder and visualizer](https://vectory.ahmadz.ai/designer/). It runs in your browser without an account or server installation.
