# Local preview from source

Run Vectory on one Linux or macOS machine, connect that same machine as a device, and deploy a first pipeline. It takes about 15 minutes, most of it first-time compilation.

> [!NOTE]
> **A local trial, not a production install**
> The preview listens only on 127.0.0.1 and trusts a short-lived test certificate authority. To self-host the developer preview, see [Install the server](../user/install-server.md).

## Before you start

| Check | You need |
| --- | --- |
| `uname -sm` | Linux (x86-64 or Arm64), or macOS on Apple silicon |
| `git --version` | Git and curl |
| `node --version` | Node.js 22.12 or newer |
| `cargo --version` | Rust 1.94 or newer |
| `go version` | Go 1.26 (an older Go fetches 1.26 automatically) |
| `python3 --version` | Python 3.11 or newer, to build the agent downloads served by the preview |

Use a test host with no existing Vectory agent or running Vector workload. Step 4 checks the paths and account the trial would create before it installs the agent.

## 1. Build Vectory

```sh
git clone https://github.com/416rehman/Vectory.git
cd Vectory
git checkout v0.1.1
```

```sh
(cd help-center && npm ci)
(cd dashboard && npm ci && npm run build)
(cd server && cargo build --bins)
```

The dashboard build also builds this Help center. The server build takes a few minutes the first time.

## 2. Download Vector 0.58.0

Vectory manages Vector; it never installs it for you. Download the official release and check its SHA-256. The preview uses this verified copy; the device setup uses an existing Vector 0.58.x on your `PATH`, or installs this copy if none exists.

<!-- tabs:platform -->
#### Linux x86-64

```sh
(
  set -e
  BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
  V=vector-0.58.0-x86_64-unknown-linux-gnu.tar.gz
  curl -fsSLO "$BASE/$V"
  curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | sha256sum -c -
  mkdir -p .local/tools && tar -xzf "$V" -C .local/tools && rm "$V"
)
```

#### Linux Arm64

```sh
(
  set -e
  BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
  V=vector-0.58.0-aarch64-unknown-linux-gnu.tar.gz
  curl -fsSLO "$BASE/$V"
  curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | sha256sum -c -
  mkdir -p .local/tools && tar -xzf "$V" -C .local/tools && rm "$V"
)
```

#### macOS

```sh
(
  set -e
  BASE=https://github.com/vectordotdev/vector/releases/download/v0.58.0
  V=vector-0.58.0-arm64-apple-darwin.tar.gz
  curl -fsSLO "$BASE/$V"
  curl -fsSL "$BASE/vector-0.58.0-SHA256SUMS" | grep " $V\$" | shasum -a 256 -c -
  mkdir -p .local/tools && tar -xzf "$V" -C .local/tools && rm "$V"
)
```
<!-- /tabs -->

You should see the archive name followed by `OK`. Anything else means the download is not the official release: delete it and try again.

If Vector is not already on your `PATH`, put the verified copy at `/usr/local/bin/vector`. The marker records its checksum, so cleanup can remove it only if it is still the file this trial installed:

```sh
(
  set -e
  set -- .local/tools/vector-*/bin/vector
  if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Expected exactly one verified Vector executable under .local/tools." >&2
    exit 1
  fi
  verified_vector=$1
  if command -v vector >/dev/null 2>&1 &&
     vector --version | grep -q '^vector 0[.]58[.]'; then
    echo "Using existing Vector at $(command -v vector); it will be left in place."
    vector --version
  elif command -v vector >/dev/null 2>&1; then
    echo "The Vector on PATH is not 0.58.x; it will be left in place."
    alternate_dir=/usr/local/lib/vectory-quickstart
    alternate=$alternate_dir/vector
    if [ -e "$alternate_dir" ] || [ -L "$alternate_dir" ]; then
      echo "$alternate_dir already exists. Review it before continuing." >&2
      exit 1
    fi
    sudo install -d -m 0755 "$alternate_dir"
    sudo install -m 0755 "$verified_vector" "$alternate"
    if [ "$(uname -s)" = Darwin ]; then
      shasum -a 256 "$alternate" > .local/quickstart-vector-alternate.sha256
    else
      sha256sum "$alternate" > .local/quickstart-vector-alternate.sha256
    fi
    echo "In step 4, set Advanced → Vector binary to $alternate"
    "$alternate" --version
  else
    if [ -e /usr/local/bin/vector ] || [ -L /usr/local/bin/vector ]; then
      echo "/usr/local/bin/vector already exists. Review it before continuing." >&2
      exit 1
    fi
    sudo mkdir -p /usr/local/bin
    sudo install -m 0755 "$verified_vector" /usr/local/bin/vector
    if [ "$(uname -s)" = Darwin ]; then
      shasum -a 256 /usr/local/bin/vector > .local/quickstart-vector.sha256
    else
      sha256sum /usr/local/bin/vector > .local/quickstart-vector.sha256
    fi
    vector --version
  fi
)
```

You should see `vector 0.58.x`. If an older Vector is already on your `PATH`, leave it there and set **Advanced → Vector binary** in step 4 to the verified path printed above.

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

Before installing the agent, run this check from the repository checkout. It records that the Vectory paths and service account were absent; cleanup requires that marker. An existing **stopped** Vector 0.58.x executable is fine and will be left alone.

```sh
(
  case "$(uname -s)" in
    Linux)
      set -- /usr/local/bin/vectory /var/lib/vectory-agent \
        /etc/vectory/managed /etc/vectory/updates \
        /var/lib/vectory-update \
        /etc/systemd/system/vectory.service \
        /etc/systemd/system/vectory-update.service \
        /etc/systemd/system/vectory-update.timer
      service_account=vectory
      ;;
    Darwin)
      set -- /usr/local/bin/vectory \
        "/Library/Application Support/Vectory/agent" \
        "/Library/Application Support/Vectory/managed" \
        "/Library/Application Support/Vectory/updates" \
        "/Library/Application Support/Vectory/update-state" \
        /Library/LaunchDaemons/io.vectory.agent.plist \
        /Library/LaunchDaemons/io.vectory.agent.stop.json \
        /Library/LaunchDaemons/io.vectory.update.plist
      service_account=_vectory
      if dscl . -read /Groups/_vectory >/dev/null 2>&1; then
        echo "The _vectory group already exists. Use a clean test host instead." >&2
        exit 1
      fi
      ;;
    *) echo "This quickstart supports Linux and macOS only." >&2; exit 1 ;;
  esac
  for path do
    if [ -e "$path" ] || [ -L "$path" ]; then
      echo "Already exists: $path. Use a clean test host instead." >&2
      exit 1
    fi
  done
  if id "$service_account" >/dev/null 2>&1 ||
     { [ "$service_account" = vectory ] && grep -q '^vectory:' /etc/group; } ||
     pgrep -x vector >/dev/null 2>&1; then
    echo "A Vectory account/group or running Vector exists; use a clean test host." >&2
    exit 1
  fi
  if [ -e .local/quickstart-agent-preflight ] || [ -L .local/quickstart-agent-preflight ]; then
    echo "This checkout has a quickstart marker; finish cleanup first." >&2
    exit 1
  fi
  : > .local/quickstart-agent-preflight
)
```

Stop here if the check reports anything. If a trial stops before the agent is installed, remove its marker only after confirming it created no agent files or service.

<!-- steps -->
1. In the dashboard, open [**Devices → Add device**](/#/enrollment).
2. Choose your operating system and **Restricted**, then **Create install command** and copy it.
3. Run it in a terminal on this machine. It downloads the agent from your server, checks its SHA-256, and connects using the server's pinned certificate. Setup finds a compatible Vector on your `PATH` or the copy this trial installed at `/usr/local/bin/vector`. If the block in step 2 printed a verified path because an older Vector is on your `PATH`, set **Advanced → Vector binary** to that path before creating the command.
4. When setup asks for the enrollment token, choose **Copy token** on the same page and paste it. Typing stays hidden.

Keep the tab open until setup asks for the token: the token is shown only on this page. Within a few seconds of pasting it, your machine appears as a new device and reports its first check-in.

If setup says no service manager keeps the agent running, use the run command it prints and keep that terminal open through step 5.

> [!TIP]
> Enrolling never deploys anything. A new device waits, without starting Vector, until you give it a pipeline.

## 5. Deploy your first pipeline

<!-- steps -->
1. Open [**Pipelines**](/#/configurations) and choose **Create pipeline**. Pick **Try a synthetic example**, name it, and choose **Create pipeline**. The example generates demo logs and tags them with VRL, and exports Vector's own metrics on the device's loopback address so Vectory can measure delivery. It reads no files and sends nothing anywhere.
2. Choose **Review & publish**, then **Publish version**.
3. Select **Choose devices** and your machine, then **Review deployment** and **Deploy to devices**.
4. Open your device. Its pipeline status moves through the rollout and ends at **Applied**.

**Applied** means the agent verified Vector runs the new version. The step-by-step version of this, with what each screen means, is [Deploy your first pipeline](../user/first-pipeline.md).

## Try a whole fleet instead

After step 1, one command starts a demo fleet: the preview plus real agents running real Vector with synthetic `demo_logs` events.

```sh
node scripts/demo.mjs --agents 4
```

It downloads and verifies Vector 0.58.0, creates an administrator (`operator@vectory.local`, password in `.local/preview/credentials.json`), enrolls the agents, groups them and deploys two example pipelines. Run it before you create your own account in step 3; it signs in with the account it creates. Choose between 1 and 12 agents.

## Clean up

While the preview server is still running, revoke this trial's device in the dashboard: open it and choose **Revoke device identity…** under **Device access** (the host can't revoke its own identity). If you ran the agent in a foreground terminal because there was no service manager, press Ctrl-C there and wait for the agent to exit before purging its state. Then run the block for your host from the repository checkout. It requires the clean-host marker created in step 4; if the marker is missing, stop and inspect the paths rather than deleting an existing installation. If setup registered a service, the block stops and unregisters it before purging the agent's state.

<!-- tabs:platform -->
#### Linux

```sh
(
  set -e
  if [ ! -f .local/quickstart-agent-preflight ]; then
    echo "No clean-host marker; refusing to remove an agent." >&2
    exit 1
  fi
  if [ -e /etc/systemd/system/vectory.service ]; then
    sudo /usr/local/bin/vectory service-stop
    sudo /usr/local/bin/vectory service-uninstall
  fi
  sudo /usr/local/bin/vectory uninstall --purge --state-dir /var/lib/vectory-agent
  sudo rm -f /usr/local/bin/vectory /etc/vectory/managed/vector.json
  sudo rmdir /etc/vectory/managed 2>/dev/null || true
  sudo rm -f /etc/vectory/updates/policy.json /etc/vectory/updates/policy.lock \
    /etc/vectory/updates/lifecycle.lock
  sudo rmdir /etc/vectory/updates 2>/dev/null || true
  if id vectory >/dev/null 2>&1; then
    if command -v userdel >/dev/null 2>&1; then
      sudo userdel vectory
    else
      sudo deluser vectory
    fi
  fi
  if grep -q '^vectory:' /etc/group; then
    if command -v groupdel >/dev/null 2>&1; then
      sudo groupdel vectory
    else
      sudo delgroup vectory
    fi
  fi
  rm .local/quickstart-agent-preflight
)
```

#### macOS

```sh
(
  set -e
  if [ ! -f .local/quickstart-agent-preflight ]; then
    echo "No clean-host marker; refusing to remove an agent." >&2
    exit 1
  fi
  if [ -e /Library/LaunchDaemons/io.vectory.agent.plist ]; then
    sudo /usr/local/bin/vectory service-stop
    sudo /usr/local/bin/vectory service-uninstall
  fi
  sudo /usr/local/bin/vectory uninstall --purge \
    --state-dir "/Library/Application Support/Vectory/agent"
  sudo rm -f /usr/local/bin/vectory "/Library/Application Support/Vectory/managed/vector.json"
  sudo rmdir "/Library/Application Support/Vectory/managed" 2>/dev/null || true
  sudo rm -f "/Library/Application Support/Vectory/updates/policy.json" \
    "/Library/Application Support/Vectory/updates/policy.lock" \
    "/Library/Application Support/Vectory/updates/lifecycle.lock"
  sudo rmdir "/Library/Application Support/Vectory/updates" 2>/dev/null || true
  service_account=_vectory
  if id "$service_account" >/dev/null 2>&1; then
    sudo dscl . -delete "/Users/$service_account"
  fi
  if dscl . -read "/Groups/$service_account" >/dev/null 2>&1; then
    sudo dscl . -delete "/Groups/$service_account"
  fi
  rm .local/quickstart-agent-preflight
)
```
<!-- /tabs -->

Remove the Vector executable only if this trial installed it and its checksum still matches. An existing Vector, or one changed since installation, stays in place:

```sh
(
  set -e
  for location in default alternate; do
    case "$location" in
      default)
        marker=.local/quickstart-vector.sha256
        target=/usr/local/bin/vector
        ;;
      alternate)
        marker=.local/quickstart-vector-alternate.sha256
        target=/usr/local/lib/vectory-quickstart/vector
        ;;
    esac
    if [ -f "$marker" ]; then
      if [ ! -e "$target" ] && [ ! -L "$target" ]; then
        rm "$marker"
        if [ "$location" = alternate ]; then
          sudo rmdir /usr/local/lib/vectory-quickstart 2>/dev/null || true
        fi
      elif [ -L "$target" ]; then
        echo "$target is now a link; leave it in place and inspect it." >&2
      elif { [ "$(uname -s)" = Darwin ] && shasum -a 256 -c "$marker" >/dev/null; } ||
           { [ "$(uname -s)" = Linux ] && sha256sum -c "$marker" >/dev/null; }; then
        sudo rm "$target"
        rm "$marker"
        if [ "$location" = alternate ]; then
          sudo rmdir /usr/local/lib/vectory-quickstart 2>/dev/null || true
        fi
      else
        echo "$target changed since this trial installed it; leave it in place and inspect it." >&2
      fi
    fi
  done
)
```

Once device access is revoked and the host cleanup is finished, stop the local preview:

```sh
node scripts/demo.mjs --stop   # if you started the demo fleet
scripts/preview.sh stop
```

State, logs and the test certificate authority stay in `.local/` until you delete that folder. Delete it only if this checkout was made for the trial and holds nothing else you need.

## Next steps

- [Build a real pipeline](../user/pipelines.md) from your own sources and destinations.
- [Roll out with a canary](../user/deployments.md#choose-a-rollout) instead of all at once.
- [Install the server](../user/install-server.md) on a host your devices can reach.
