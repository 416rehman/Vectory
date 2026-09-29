# Quickstart

Run Vectory on one Linux or macOS machine, connect that same machine as a device, and deploy a first pipeline. It takes about 15 minutes, most of it first-time compilation.

> [!NOTE]
> **A local trial, not a production install**
> The preview listens only on 127.0.0.1 and trusts a short-lived test certificate authority. To run Vectory for real, see [Install the server](install-server.md).

## Before you start

| You need | Check with |
| --- | --- |
| Linux (x86-64 or Arm64) or macOS on Apple silicon | `uname -sm` |
| Git and curl | `git --version` |
| Node.js 22.12 or newer | `node --version` |
| Rust 1.94 or newer | `cargo --version` |
| Go 1.26 (an older Go fetches 1.26 automatically) | `go version` |

## 1. Build Vectory

```sh
git clone https://github.com/416rehman/Vectory.git
cd Vectory
(cd help-center && npm ci)
(cd dashboard && npm ci && npm run build)
(cd server && cargo build --bins)
```

The dashboard build also builds this Help center. The server build takes a few minutes the first time.

## 2. Download Vector 0.58.0

Vectory manages Vector; it never installs it for you. Download the official release and check its SHA-256 before you run it:

<!-- tabs:platform -->
#### Linux x86-64

```sh
BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
V=vector-0.58.0-x86_64-unknown-linux-gnu.tar.gz
curl -fsSLO "$BASE/$V"
curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | sha256sum -c -
mkdir -p .local/tools && tar -xzf "$V" -C .local/tools
```

#### Linux Arm64

```sh
BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
V=vector-0.58.0-aarch64-unknown-linux-gnu.tar.gz
curl -fsSLO "$BASE/$V"
curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | sha256sum -c -
mkdir -p .local/tools && tar -xzf "$V" -C .local/tools
```

#### macOS

```sh
BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
V=vector-0.58.0-arm64-apple-darwin.tar.gz
curl -fsSLO "$BASE/$V"
curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | shasum -a 256 -c -
mkdir -p .local/tools && tar -xzf "$V" -C .local/tools
```
<!-- /tabs -->

You should see the archive name followed by `OK`. Anything else means the download is not the official release: delete it and try again.

## 3. Start the server

```sh
scripts/preview.sh
```

```text
Preview running at http://127.0.0.1:8080 (agent TLS https://localhost:8443).
Bootstrap secret: /home/you/Vectory/.local/preview/bootstrap.secret
```

The first start also creates a test certificate authority in `.local/pki/`. The preview uses the Vector binary you downloaded to check pipelines, just like a real server's validator.

Open **http://127.0.0.1:8080**. Paste the bootstrap secret (`cat .local/preview/bootstrap.secret`), then choose your name, email and password. That account is the workspace's first administrator.

## 4. Connect this machine

<!-- verify-after-merge: Add device offers OS tabs and one copyable install command that works against the preview (bundled agents, CA pin, hidden token prompt) -->
<!-- steps -->
1. In the dashboard, open [**Devices → Add device**](/#/enrollment).
2. Choose your operating system and copy the command.
3. Run it in a terminal on this machine. It downloads the agent from your server, checks its SHA-256, and connects using the server's pinned certificate. Paste the enrollment token when asked; typing stays hidden.

<!-- verify-after-merge: the Add device page shows the new device and its first check-in live -->
Keep the page open. Within a few seconds your machine appears as a new device and reports its first check-in.

> [!TIP]
> Enrolling never deploys anything. A new device waits, without starting Vector, until you give it a pipeline.

## 5. Deploy your first pipeline

<!-- verify-after-merge: the create dialog still offers "Try a synthetic example" (it may move into the templates gallery) -->
<!-- steps -->
1. Open [**Pipelines**](/#/configurations) and choose **Create pipeline**. Pick **Try a synthetic example**, name it, and choose **Create pipeline**. The example generates demo logs, tags them with VRL and prints them to the console. It reads no files and sends nothing anywhere.
2. Choose **Review & publish**, then **Publish version**.
3. Choose **Choose devices**, select your machine, then **Review deployment** and **Deploy to devices**.
4. Open your device. Its pipeline status moves through the rollout and ends at **Applied**.

**Applied** means the agent watched Vector start with the new version and keep running. The step-by-step version of this, with what each screen means, is [Deploy your first pipeline](first-pipeline.md).

## Try a whole fleet instead

On a fresh checkout, one command builds everything and starts a demo fleet: the preview plus real agents running real Vector with synthetic `demo_logs` events.

```sh
node scripts/demo.mjs --agents 4
```

It downloads and verifies Vector 0.58.0, creates an administrator (`operator@vectory.local`, password in `.local/preview/credentials.json`), enrolls the agents, groups them and deploys two example pipelines. Run it before you create your own account in step 3; it signs in with the account it creates. Choose between 1 and 12 agents.

## Clean up

```sh
node scripts/demo.mjs --stop   # if you started the demo fleet
scripts/preview.sh stop
```

<!-- verify-after-merge: default agent state directory and service commands after W1's path unification; setup may also offer a single uninstall step -->
To remove the agent from this machine, stop and unregister its service, then delete its state:

```sh
sudo vectory service-stop
sudo vectory service-uninstall
sudo vectory uninstall --purge --state-dir /var/lib/vectory
```

State, logs and the test certificate authority stay in `.local/` until you delete that folder.

## Next steps

- [Build a real pipeline](pipelines.md) from your own sources and destinations.
- [Roll out with a canary](deployments.md#choose-a-rollout) instead of all at once.
- [Install the server](install-server.md) on a host your devices can reach.
