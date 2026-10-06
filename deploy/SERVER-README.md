# Run the Vectory server

The guided installer starts the full manager, dashboard, TLS proxy and isolated Vector validator on a Linux x86-64 Docker host. You need Docker Engine with Compose v2, curl, a public DNS name pointing to this host and inbound TCP ports 80, 443 and 8443. No source checkout, language toolchain or separately installed Cosign is needed.

```sh
curl -fsSL --proto '=https' https://vectory.ahmadz.ai/install.sh -o vectory-install.sh
bash vectory-install.sh
```

Enter your server DNS name. The installer verifies the exact release's Sigstore checksum bundle using a pinned Cosign container before extracting the server kit. The kit authenticates immutable GHCR image references and their Cosign signatures before starting them. A missing or invalid signature stops installation.

Open the printed HTTPS address, paste the private setup secret and create your first administrator. Select **Add device** to get the verified platform download and setup command for a host that already runs a supported Vector installation.

## Certificates

The default setup uses Caddy's automatic public HTTPS certificates for the dashboard. Caddy retains its account and certificate data and renews certificates automatically. DNS and ports 80/443 must remain reachable for ACME validation. The separate agent HTTPS listener uses a retained private issuer. The authenticated Add device flow pins its public certificate; users do not need to locate or upload a CA file. The certificate sidecar renews the 90-day listener certificate before its last 30 days, keeping the same private issuer and leaf key. The manager validates replacements before using them for new connections. Its private issuer lasts ten years and then requires a reviewed trust rotation.

For private networks or existing certificates, keep the manually supplied PEM option:

```sh
VECTORY_TLS_CERT_FILE=/absolute/server-fullchain.pem \
VECTORY_TLS_KEY_FILE=/absolute/server-key.pem ./start.sh
```

Supply the DNS name and listen address when asked. This mode validates the key, hostname and certificate dates and retains the pair privately. You own renewal of supplied certificates; valid replacements are reloaded by the manager, and the TLS proxy must be restarted after renewal. Include a private issuing CA's public certificate after the leaf in a full-chain file. Never distribute any CA private key.

## Retained state

```sh
cd vectory
./start.sh status
./start.sh stop
./start.sh
```

Stop and resume preserve the database, issuer, leaf key and setup secret. Protect Docker access and back up `vectory_data`, `vectory_secrets`, `vectory_caddy_data` and `vectory_caddy_config`, together with the installation directory's `.env`. A separate project can use `VECTORY_SERVER_PROJECT` consistently on every command. Do not recreate private trust to repair a browser certificate or lost `.env`; restore the original state from your backup.

For a first installation without internet access, run `./prepare-offline.sh /absolute/path/vectory-offline` from the verified kit on a connected Linux x86-64 Docker host. Preparation authenticates the real release, downloads its signed image archives and retains the pinned verifier, HTTPS proxy and independently verified Sigstore trust root. It does not start a manager. Transfer the complete output directory through a trusted channel. On the offline host, run `VECTORY_OFFLINE=true VECTORY_CERTIFICATE_MODE=custom ./start.sh` and supply your HTTPS certificate pair. The loader verifies the signed archive checksums and exact local image identities, and Compose refuses network pulls.

After a verified online start, `VECTORY_OFFLINE=true ./start.sh` also reuses the retained verification cache and exact local image identities. Retain `.cache` and all Docker images. Public ACME renewal still needs internet access; private/offline networks should use the supplied-certificate mode. `VECTORY_RELEASE_DIR=/absolute/release-folder` can provide signed release inventory files without public downloads; it never bypasses signature verification. A checksum copy alone does not establish Sigstore root trust.

All containers run without root and with read-only root filesystems. The validator has no internet route. The native agent listener and the proxy are separate trust boundaries; HTTP accepts only the proxy and loopback. No download or file write is device activation: the enrolled agent must validate and run the pipeline before reporting **Applied**.

Sigstore authentication is separate from Windows Authenticode or Apple Developer ID/notarization. Consult the release's `RELEASE.json`, vulnerability reports and [tested platform coverage](https://vectory.ahmadz.ai/help/compatibility/) before rollout. Release signing does not make a workload or operating system universally safe.
