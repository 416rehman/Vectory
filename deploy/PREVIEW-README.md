# Try Vectory locally

This local evaluation starter runs Vectory on **Linux x86-64** with Docker Engine and the Compose v2 plugin. It verifies the tagged release Sigstore checksum bundle and pulls the signed server and validator from GHCR by immutable digest. No Git, language toolchain, DNS name or TLS certificate is needed.

## Start

```sh
./start.sh
```

The first start authenticates and pulls the prebuilt server and Vector validator images. Later starts reuse verified downloads and your existing workspace. Retain `.cache`, the Sigstore verifier and all image digests. After a verified online start, use `VECTORY_OFFLINE=true ./start.sh` for an offline restart.

1. Open **http://127.0.0.1:8080**.
2. Paste the setup secret printed at the end of `./start.sh`, then create your administrator. Run `./start.sh setup-secret` if you need to see it again.
3. Select **Add device** to connect this Linux host and choose **Pin this server's CA**. The generated command verifies the HTTPS download with the preview's public CA certificate. The verified installer pins that CA's fingerprint during agent setup and keeps the trusted certificate inside the agent's state directory. No CA file path or manual copy is needed; enrollment still checks TLS and uses a one-time token.
4. Create a pipeline with **Try a synthetic example**, publish it, choose the device and deploy. **Applied** means the agent verified Vector is running that version.

The agent adopts an existing supported Vector installation; it does not install Vector. The [device guide](https://vectory.ahmadz.ai/help/installation/) explains this prerequisite and the generated install command. The validator is already included for server checks.

## Stop and resume

```sh
./start.sh stop
./start.sh
```

Stopping retains your workspace and device trust. `./start.sh status` shows the containers. The named Docker volumes `vectory-preview_data` and `vectory-preview_pki` hold the database and private certificates; retain both. The exported `setup-secret.txt` is private and is used only to create the first administrator.

This local evaluation listens only on this Linux host. Its test CA expires after seven days; it never installs a certificate into the host trust store, changes a host service, or silently replaces retained certificates. If it has expired, stop the preview, revoke enrolled trial devices if possible, and remove its two preview volumes only when you intend to start a fresh workspace. Existing trial devices must be enrolled against the new CA. For a lasting installation, follow [Install the server](https://vectory.ahmadz.ai/help/install-server/).

## Ports and multiple previews

If a port is in use, choose unused ports before starting:

```sh
VECTORY_PREVIEW_WEB_PORT=18080 VECTORY_PREVIEW_AGENT_PORT=18443 ./start.sh
```

Repeat those values when resuming. Only the web and agent ports are exposed locally; the Vector validator stays on its private internal network. For an independent workspace, set `VECTORY_PREVIEW_PROJECT` to a different name on every command, including stop. The project name controls its container and volume names.

## Download verification

The starter checks every bundle file before use and both image archives before Docker loads them. The release is unsigned: checksums detect corruption and bind files to the published inventory, but do not establish a separate publisher signing identity. Review the release and its known platform coverage before running it. The starter never executes a remote shell script.

For a first offline trial, run `./prepare-offline.sh /absolute/path/vectory-offline` from the verified kit on a connected Linux x86-64 Docker host. Transfer the entire resulting directory, including the independently verified Sigstore root and pinned verifier image, through a trusted channel. Then run `VECTORY_OFFLINE=true ./start.sh`. Signed archive checksums and exact immutable local image identities are checked before startup, with network pulls disabled. For later offline restarts, retain `.cache` and the Docker images. Preparation does not start a manager or activate a device.
