# Quickstart

Run the full Vectory server, connect a host, and deploy your first pipeline. Installation uses prebuilt containers and agents. You do not need Git, Rust, Go, Node.js or a compiler.

## 1. Start your server

You need a **Linux x86-64 server with Docker Engine and Compose v2 running**, curl, and a DNS name pointing to it. Allow inbound TCP **80 and 443** for HTTPS and **8443** from the devices you manage. Use local, durable storage.

Run this on that server:

```sh
curl -fsSL --proto '=https' https://vectory.ahmadz.ai/install.sh -o vectory-install.sh &&
bash vectory-install.sh
```

Enter your hostname when asked, for example `vectory.example.com`. The installer verifies the release signature, downloads the server kit, verifies the signed GHCR image digests, and starts Vectory. Docker also runs the signature verifier, so you do not install Cosign separately.

Caddy obtains and renews the dashboard's HTTPS certificate automatically. Vectory creates and renews a separate certificate for agent connections. You do not need to find or copy CA files. The first start prints your dashboard URL and a one-time setup secret.

If your server cannot receive public certificate requests, use the [custom certificate option](install-server.md#use-your-own-certificate). The [server guide](install-server.md) also covers offline installation and backups.

## 2. Create your administrator

Open the printed HTTPS URL. Paste the setup secret and choose your administrator name, email and password. There are no default accounts.

To see the secret again before setup finishes, run this inside the installed kit directory:

```sh
./start.sh setup-secret
```

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

If you only want to create or visualize a Vector configuration, try the [standalone designer](https://vectory.ahmadz.ai/designer/). It runs in your browser without an account or server installation.
