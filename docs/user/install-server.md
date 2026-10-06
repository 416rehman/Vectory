# Install the server

Run the Vectory developer preview on a Linux x86-64 host with the prebuilt server kit. Its guided start command downloads verified images, checks your certificate, creates the setup secret and starts the server, TLS proxy and isolated Vector validator. No Git, compiler or language toolchain is required.

For a local trial without DNS or certificates, use the [quickstart](quickstart.md) instead.

## Before you start

| You need | Why |
| --- | --- |
| Linux x86-64 with Docker Engine running and Compose v2 | Runs the prebuilt containers. |
| A DNS name pointing at this host | Browsers and devices use it to reach Vectory. |
| A TLS certificate full-chain PEM and its private-key PEM for that name | Protects browser and agent connections. Use readable regular files at absolute paths. |
| Ports 443 and 8443 reachable by the appropriate clients | 443 serves the dashboard; 8443 serves enrollment and mutual-TLS agent traffic. |
| Local, durable disk | SQLite state must not live on a network filesystem. |

If you already have a certificate for this server name, use its full chain and private key. If your organization uses a private certificate authority, obtain its public CA certificate through your trusted administrative channel and append it after the server certificate in the full chain. Keep the CA's private key elsewhere. Browsers and devices need to trust that issuer; Vectory's device identity CA is a different authority and is not the file to distribute here. [Certificate trust](installation.md#trust-the-server-certificate) explains each choice.

The server kit is an **unsigned developer preview**. Review [platform coverage](compatibility.md) before installing it.

## 1. Download and extract

Download **[vectory-0.1.1-server-linux-amd64.tar.gz](https://github.com/416rehman/Vectory/releases/download/v0.1.1/vectory-0.1.1-server-linux-amd64.tar.gz)** from the [0.1.1 release](https://github.com/416rehman/Vectory/releases/tag/v0.1.1).

```sh
curl -fsSL --proto '=https' \
  https://github.com/416rehman/Vectory/releases/download/v0.1.1/SHA256SUMS \
  -o release-SHA256SUMS &&
grep -E '^[0-9a-f]{64}  vectory-0[.]1[.]1-server-linux-amd64[.]tar[.]gz$' \
  release-SHA256SUMS | sha256sum --check --strict - &&
tar -xzf vectory-0.1.1-server-linux-amd64.tar.gz &&
cd vectory-0.1.1-server-linux-amd64 &&
./start.sh
```

The script asks for your server DNS name, certificate file, private-key file and the address to listen on. `0.0.0.0` listens on every interface; choose a specific IPv4 address to limit the listener. It verifies that the key matches the certificate, the certificate names your chosen host and it is valid now. It does not install browser trust or establish whether you obtained the CA through a trusted channel.

You should see the archive name followed by **OK** before startup continues. The starter verifies every kit file and both downloaded images against their SHA-256 inventories before use. The first start downloads the Vectory images plus the pinned TLS proxy image. The server image includes the dashboard, Help center and every supported agent download. You do not compile or fetch agents separately.

The script copies your certificate and key into the private `vectory_secrets` Docker volume and generates the bootstrap secret there. It writes the selected hostname, bind address and image tags to `.env`. Keep that file with your backups. `.env.example` lists optional settings; [Server configuration](server-config.md) covers the complete reference.

## 2. Create the first administrator

When all services are healthy, the script prints `https://<your-server-name>` and the setup secret. Open that URL and paste the secret, then choose your administrator name, email and password of 12 characters or more. There are no default accounts and no public sign-up.

The setup secret works only once, to create the first administrator. It is neither an enrollment token nor a sign-in password. Retrieve it while the server is running with `./start.sh setup-secret` if needed. After setup, [enable an authenticator](administer.md#set-up-an-authenticator).

Then [connect a device](installation.md), [deploy your first pipeline](first-pipeline.md), and [invite your team](administer.md#create-workspace-accounts).

## Stop, resume and check

```sh
./start.sh status
./start.sh stop
./start.sh
```

Stopping retains the database and certificate volume. Resuming checks the retained certificate and uses the same workspace; it never replaces trust automatically. For service diagnostics, run:

```sh
docker compose logs --tail 100 server proxy validator
```

The start command waits for the validator, server and proxy health checks. The proxy is healthy only when a request through it reaches the server. If the validator is down, publishing stops until it is restored; the server never skips that check.

## What runs where

| Container | Purpose and isolation |
| --- | --- |
| `proxy` | Serves the dashboard over TLS 1.3 on port 443. Runs as UID 10001 with a read-only filesystem, only `NET_BIND_SERVICE`, no admin API, and no forwarded `/agent/` paths. |
| `server` | Stores state and serves agents on port 8443. Runs as UID 10001 with a read-only filesystem and no capabilities. Its HTTP listener accepts only the proxy and its own loopback. |
| `validator` | Validates configurations with Vector 0.58.0. Runs as UID 10002 on an internal network with no internet route, no host ports, no secrets and bounded resources. |

The `vectory_data` volume holds the database and server identity keys. The `vectory_secrets` volume holds the supplied TLS pair and setup secret. Back up both, and retain `.env` and the kit's configuration. [Back up the complete state](administer.md#back-up-the-complete-state) before any upgrade. Docker access itself permits reading these files, so protect it as administrator access.

## Certificate maintenance and advanced setup

The starter refuses an expired or mismatched retained certificate. To replace it, stop the server and proxy, update `server_cert` and `server_key` inside the `vectory_secrets` volume from a trusted matching pair, verify the full chain and hostname, then start again. A CA change also needs a device trust plan; never silently discard a CA that enrolled devices pin. [Ports and network](ports.md) covers firewalls and proxies.

For an unattended first start, provide `VECTORY_HOSTNAME`, `VECTORY_TLS_CERT_FILE`, `VECTORY_TLS_KEY_FILE` and `VECTORY_BIND_IP` as environment variables. Use `VECTORY_SERVER_PROJECT` consistently for a separate instance. To use an offline release mirror, set `VECTORY_PREVIEW_RELEASE_DIR` to a directory holding both image archives and the release `SHA256SUMS`, and pre-load the pinned proxy image.

Developers who need to change or build the images can use the [contributor setup](https://github.com/416rehman/Vectory/blob/main/docs/dev/SOURCE-QUICKSTART.md) and the source Compose file under `deploy/`. Ordinary installation uses the prebuilt kit above.
