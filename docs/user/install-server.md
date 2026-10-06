# Install the server

The full Vectory server installs from signed, prebuilt GHCR images. One guided command starts the dashboard, isolated Vector validator and HTTPS proxy. No compiler or language toolchain is needed.

## What you need

| Requirement | Details |
| --- | --- |
| Server | Linux x86-64 with Docker Engine and Compose v2 running, plus curl. |
| Address | A DNS name pointing to the server, for example `vectory.example.com`. |
| Network | TCP 80 and 443 reachable for automatic HTTPS; TCP 8443 reachable from managed devices. Devices connect out and need no inbound ports. |
| Storage | Local, durable disk. Run one server per data directory; do not put SQLite on a network filesystem. |

## Install

Run on your server:

```sh
curl -fsSL --proto '=https' https://vectory.ahmadz.ai/install.sh -o vectory-install.sh &&
bash vectory-install.sh
```

The downloaded installer is a readable shell script. It verifies the release's Sigstore bundle against Vectory's GitHub release workflow identity, checks the server kit before extracting it, and runs the guided starter. The starter verifies immutable server and validator image digests before pulling them from GHCR. Cosign runs in a pinned Docker container; no separate verifier installation is required.

Enter the hostname when asked. The default uses automatic HTTPS: Caddy obtains and renews the public dashboard certificate. A separate retained private CA protects agent connections, and its listener certificate renews automatically without disconnecting enrolled devices. **Add device** includes the correct agent trust in each install command. There is no CA file to distribute by hand.

Point the hostname's DNS record directly to your server and open the ports listed above. With Cloudflare DNS, select [DNS only](https://developers.cloudflare.com/dns/proxy-status/) for this server hostname so devices reach its mutual-TLS listener directly. A custom reverse proxy must keep port 8443 as TCP passthrough; ordinary HTTP proxying terminates the device connection's TLS.

## Create the first administrator

When the services are healthy, the starter prints your HTTPS URL and the setup secret. Open the URL, paste that secret and choose your name, email and password. There are no default accounts and no public sign-up.

The setup secret creates the first administrator once. It is not an enrollment token or a sign-in password. From the kit directory, `./start.sh setup-secret` retrieves it while setup is incomplete. After setup, [enable an authenticator](administer.md#set-up-an-authenticator), [connect a device](installation.md), and [deploy your first pipeline](first-pipeline.md).

## Use your own certificate

The kit also accepts an existing TLS certificate and private key for private networks or organizations that manage certificates centrally. Run `VECTORY_CERTIFICATE_MODE=custom ./start.sh` from a new kit directory, then provide the full-chain PEM and key PEM at absolute paths when asked. The starter checks the hostname, validity and matching key before installing them.

For a private issuer, include its public CA certificate after the server certificate in the chain. Keep the CA private key separate. Browsers must trust that issuer, and **Add device** carries the public agent CA and its fingerprint in the command. [Certificate trust](installation.md#trust-the-server-certificate) explains the advanced choices.

## Stop, resume and check

Run from the kit directory:

```sh
./start.sh status
./start.sh stop
./start.sh
```

Stopping retains the database and certificate volumes. Resuming uses the same workspace and trust. The kit's `.env` records the selected hostname and immutable image references; retain it with your backups.

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

On a connected Linux x86-64 Docker host, verify and extract the server kit from the [release page](https://github.com/416rehman/Vectory/releases/tag/v0.2.0), then run from that kit:

```sh
./prepare-offline.sh /absolute/path/vectory-offline
```

Preparation verifies the actual release and creates a source-free kit with authenticated Vectory image archives, the pinned Cosign and Caddy images, and the independently verified Sigstore trust cache. It does not start a manager. Transfer the **entire output directory**, including `.cache`, over your trusted channel. On the offline host, run from the transferred directory:

```sh
VECTORY_OFFLINE=true VECTORY_CERTIFICATE_MODE=custom ./start.sh
```

Supply your HTTPS certificate and matching private key when asked. The loader verifies signatures, archive checksums and immutable local image identities; Compose disables network pulls. A checksum inventory alone cannot establish independent trust in Sigstore's root.

After installation, the dashboard, documentation, fonts and search need no outside requests. Agent downloads come from your server. Vector's own files, credentials and binaries must be available on each managed host.

## Keep the installation healthy

- [Back up and restore the server](administer.md).
- [Upgrade the server](administer.md#upgrade-the-server) using a verified new kit and the same retained state.
- Review [compatibility](compatibility.md), [security](security.md) and [operational limits](whats-new.md#known-limits) for the workload you plan to run.
