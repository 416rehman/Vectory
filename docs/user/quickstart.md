# Quickstart

Run Vectory on one Linux or macOS machine, connect that same machine as a device, and deploy a first pipeline. It takes about 15 minutes, most of it first-time compilation.

> [!NOTE]
> **A local trial, not a production install**
> The preview listens only on 127.0.0.1 and trusts a short-lived test certificate authority. To run Vectory for real, see [Install the server](install-server.md).

## Before you start

| Check | You need |
| --- | --- |
| `uname -sm` | Linux (x86-64 or Arm64), or macOS on Apple silicon |
| `git --version` | Git and curl |
| `node --version` | Node.js 22.12 or newer |
| `cargo --version` | Rust 1.94 or newer |
| `go version` | Go 1.26 (an older Go fetches 1.26 automatically) |
| `python3 --version` | Python 3.11 or newer, to build the agent downloads served by the preview |

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

Vectory manages Vector; it never installs it for you. Download the official release, check its SHA-256, and install it:

<!-- tabs:platform -->
#### Linux x86-64

```sh
BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
V=vector-0.58.0-x86_64-unknown-linux-gnu.tar.gz
curl -fsSLO "$BASE/$V"
curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | sha256sum -c -
mkdir -p .local/tools && tar -xzf "$V" -C .local/tools && rm "$V"
sudo install -m 0755 .local/tools/vector-*/bin/vector /usr/local/bin/vector
```

#### Linux Arm64

```sh
BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
V=vector-0.58.0-aarch64-unknown-linux-gnu.tar.gz
curl -fsSLO "$BASE/$V"
curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | sha256sum -c -
mkdir -p .local/tools && tar -xzf "$V" -C .local/tools && rm "$V"
sudo install -m 0755 .local/tools/vector-*/bin/vector /usr/local/bin/vector
```

#### macOS

```sh
BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
V=vector-0.58.0-arm64-apple-darwin.tar.gz
curl -fsSLO "$BASE/$V"
curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | shasum -a 256 -c -
mkdir -p .local/tools && tar -xzf "$V" -C .local/tools && rm "$V"
sudo mkdir -p /usr/local/bin
sudo install -m 0755 .local/tools/vector-*/bin/vector /usr/local/bin/vector
```
<!-- /tabs -->

You should see the archive name followed by `OK`. Anything else means the download is not the official release: delete it and try again.

The last line puts Vector in `/usr/local/bin`, where setup looks for it in step 4. Check it:

```sh
vector --version
```

You should see `vector 0.58.0`. To keep Vector somewhere else, add `--vector-binary /path/to/vector` to the command in step 4 instead.

## 3. Start the server

```sh
scripts/preview.sh
```

```text
Preview running at http://127.0.0.1:8080 (agent TLS https://127.0.0.1:8443).
Bootstrap secret: /home/you/Vectory/.local/preview/bootstrap.secret
Add a device from Devices > Add device. The server log (/home/you/Vectory/.local/preview/server.log) shows only the ends of the CA fingerprint; Add device shows all of it.
```

The server log prints the certificate authority's fingerprint as `3F:DD:...:10:E5`, only its first and last bytes, so it can't be pasted as a pin. **Add device** shows the whole fingerprint, and the install command it creates already carries it.

The first start also creates a test certificate authority in `.local/pki/` and builds the agent for every platform. That takes a few minutes; set `VECTORY_PREVIEW_AGENT_TARGETS="linux/amd64"` (or `darwin/arm64`) to build only yours. The preview uses the Vector you downloaded to check pipelines, just like a real server's validator.

Open **http://127.0.0.1:8080**. Paste the setup secret (the bootstrap secret: run `cat .local/preview/bootstrap.secret`), then choose your name, email and password. That account is the workspace's first administrator. **Vectory is ready** then offers **Add device**, which takes you to step 4.

## 4. Connect this machine

<!-- steps -->
1. In the dashboard, open [**Devices → Add device**](/#/enrollment).
2. Choose your operating system and **Restricted**, then **Create install command** and copy it.
3. Run it in a terminal on this machine. It downloads the agent from your server, checks its SHA-256, and connects using the server's pinned certificate. Setup finds Vector at `/usr/local/bin/vector`.
4. When setup asks for the enrollment token, choose **Copy token** on the same page and paste it. Typing stays hidden.

Keep the tab open until setup asks for the token: the token is shown only on this page. Within a few seconds of pasting it, your machine appears as a new device and reports its first check-in.

> [!TIP]
> Enrolling never deploys anything. A new device waits, without starting Vector, until you give it a pipeline.

## 5. Deploy your first pipeline

<!-- steps -->
1. Open [**Pipelines**](/#/configurations) and choose **Create pipeline**. Pick **Try a synthetic example**, name it, and choose **Create pipeline**. The example generates demo logs and tags them with VRL, and exports Vector's own metrics on the device's loopback address so Vectory can measure delivery. It reads no files and sends nothing anywhere.
2. Choose **Review & publish**, then **Publish version**.
3. Select **Choose devices** and your machine, then **Review deployment** and **Deploy to devices**.
4. Open your device. Its pipeline status moves through the rollout and ends at **Applied**.

**Applied** means the agent verified Vector runs the new version. The step-by-step version of this, with what each screen means, is [Deploy your first pipeline](first-pipeline.md).

## Try a whole fleet instead

After step 1, one command starts a demo fleet: the preview plus real agents running real Vector with synthetic `demo_logs` events.

```sh
node scripts/demo.mjs --agents 4
```

It downloads and verifies Vector 0.58.0, creates an administrator (`operator@vectory.local`, password in `.local/preview/credentials.json`), enrolls the agents, groups them and deploys two example pipelines. Run it before you create your own account in step 3; it signs in with the account it creates. Choose between 1 and 12 agents.

## Clean up

```sh
node scripts/demo.mjs --stop   # if you started the demo fleet
scripts/preview.sh stop
```

To remove the agent and Vector from this machine, first revoke the device in the dashboard: open it and choose **Revoke device identity…** under **Device access** (the host can't revoke its own identity). Then stop and unregister the agent's service:

```sh
sudo vectory service-stop
sudo vectory service-uninstall
```

Delete its state and the files installed for this trial. If setup created the default service account, remove that account too:

<!-- tabs:platform -->
#### Linux

```sh
sudo vectory uninstall --purge --state-dir /var/lib/vectory-agent
sudo rm -f /usr/local/bin/vectory /usr/local/bin/vector
sudo rm -rf /etc/vectory/managed
sudo userdel vectory
```

#### macOS

```sh
sudo vectory uninstall --purge --state-dir "/Library/Application Support/Vectory/agent"
sudo rm -f /usr/local/bin/vectory /usr/local/bin/vector
sudo rm -rf "/Library/Application Support/Vectory/managed"
service_account=_vectory
sudo dscl . -delete "/Users/$service_account"
sudo dscl . -delete "/Groups/$service_account"
```
<!-- /tabs -->

State, logs and the test certificate authority stay in `.local/` until you delete that folder.

## Next steps

- [Build a real pipeline](pipelines.md) from your own sources and destinations.
- [Roll out with a canary](deployments.md#choose-a-rollout) instead of all at once.
- [Install the server](install-server.md) on a host your devices can reach.
