# Quickstart

Try Vectory on a Linux x86-64 machine with Docker. The preview kit downloads verified prebuilt images, starts the dashboard and its Vector validator, and gives you the setup secret. You do not need Git, Rust, Go, Node.js, a DNS name or a TLS certificate.

## 1. Download the preview kit

You need **Docker Engine running with Compose v2**, plus curl and sha256sum. Use a local Linux x86-64 host with free ports 8080 and 8443. The isolated validator does not publish a host port.

Download **[vectory-0.1.1-preview-linux-amd64.tar.gz](https://github.com/416rehman/Vectory/releases/download/v0.1.1/vectory-0.1.1-preview-linux-amd64.tar.gz)** from the [0.1.1 release](https://github.com/416rehman/Vectory/releases/tag/v0.1.1). In the directory containing your download, verify it against the release inventory before extracting or starting it:

```sh
curl -fsSL --proto '=https' \
  https://github.com/416rehman/Vectory/releases/download/v0.1.1/SHA256SUMS \
  -o release-SHA256SUMS &&
grep -E '^[0-9a-f]{64}  vectory-0[.]1[.]1-preview-linux-amd64[.]tar[.]gz$' \
  release-SHA256SUMS | sha256sum --check --strict - &&
tar -xzf vectory-0.1.1-preview-linux-amd64.tar.gz &&
cd vectory-0.1.1-preview-linux-amd64 &&
./start.sh
```

You should see the archive name followed by **OK** before startup continues. The first start downloads the prebuilt server and Vector validator. The kit checks its own files, verifies both image downloads against the release SHA-256 inventory, creates private local certificates, and waits for the server and validator to be healthy. Later starts reuse your verified downloads and workspace.

> [!NOTE]
> **Unsigned developer preview**
> Review [platform coverage](compatibility.md) before installing. The local trial listens only on this Linux host and uses a test CA that expires after seven days. For a lasting self-hosted installation, use the prebuilt [server kit](install-server.md).

## 2. Open your workspace

Open **http://127.0.0.1:8080**. Paste the setup secret printed at the end of the start command, then choose your administrator name, email and password. There are no default accounts.

If you need the secret again, run:

```sh
./start.sh setup-secret
```

Your dashboard, API reference and Help center are now running. Create a pipeline with **Try a synthetic example** to explore the editor immediately. To run that pipeline, connect a device next.

## 3. Connect this machine

The agent adopts an existing **Vector 0.58.x** installation. If Vector is missing, install it from the [official Vector downloads](https://vector.dev/download/) before continuing. Vectory does not install or upgrade Vector for you, and enrollment never deploys a workload by itself.

1. Open **Devices → Add device** and choose Linux.
2. Select **Restricted** mode for this synthetic trial.
3. For server certificate trust, select **Pin this server's CA**. The generated command verifies the HTTPS download with the preview's public CA certificate. The verified installer pins that CA's fingerprint during agent setup and saves the trusted certificate inside the agent's state directory; you do not need to copy a CA file or enter a file path.
4. Generate the install command and run it on this host. It verifies the downloaded agent and prompts for the one-time token; copy the token from the same dashboard page when asked.
5. Keep the page open until the host appears and reports its first check-in.

The generated command explains the host paths and service it installs. Use a test host without an existing Vectory agent or a running Vector workload. The [device guide](installation.md) covers enrollment and platform-specific checks.

## 4. Deploy your first pipeline

1. In **Pipelines**, create a pipeline with **Try a synthetic example**.
2. Choose **Review & publish**, then **Publish version**.
3. Select **Choose devices**, pick this machine and deploy.
4. Open the device. Wait for **Applied**: the agent verified that Vector runs the selected version.

The example generates synthetic log events, tags them and discards them. It reads no files and sends no events outside this host. [Deploy your first pipeline](first-pipeline.md) walks through each screen.

## Stop and resume

```sh
./start.sh stop
./start.sh
```

Stop retains your workspace and local certificate trust. `./start.sh status` shows the containers. Keep both Docker volumes, `vectory-preview_data` and `vectory-preview_pki`; deleting one while retaining the other loses part of the preview state. The private setup secret is also exported to `setup-secret.txt`; protect that file.

When finished with the agent, revoke the trial device in Vectory before uninstalling it with the [device guide](agents.md#remove-the-agent). Stopping the server does not stop an enrolled host's running Vector workload.

If a port is already in use, choose unused ports:

```sh
VECTORY_PREVIEW_WEB_PORT=18080 VECTORY_PREVIEW_AGENT_PORT=18443 ./start.sh
```

Use those same values when resuming. The kit's README explains other ports, retained certificates, multiple independent trials and offline image downloads. Developers who want to build or run a synthetic fleet from source can use [the contributor quickstart](https://github.com/416rehman/Vectory/blob/main/docs/dev/SOURCE-QUICKSTART.md).
