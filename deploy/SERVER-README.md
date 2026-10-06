# Run the Vectory server

This kit runs the unsigned Vectory developer preview on Linux x86-64 using verified, prebuilt Docker images. No Git, language toolchain or source build is required.

You need Docker Engine with Compose v2, a DNS name pointing at this host, and a TLS certificate/full-chain PEM plus its private key for that name. The host must permit dashboard traffic on port 443 and agent traffic on port 8443. If you just want to try the product without DNS or certificates, download the separate local preview kit instead.

```sh
./start.sh
```

The script downloads the matching server and validator images from the GitHub release and checks their SHA-256 before loading them. It asks for your DNS name, readable certificate/key files at absolute paths, and the address to listen on. It verifies that the key matches the certificate, the certificate names the selected host, and the certificate is valid. It copies those files into a private Docker volume, generates the first-administrator setup secret there, writes `.env`, and waits for every service to be healthy.

The script prints your dashboard URL and setup secret. Create the administrator in that browser page, then select **Add device**. Devices must trust the certificate's issuing CA. For a private CA, include its public certificate after the server certificate in the full-chain file and retain a trusted public copy on each device; never distribute the CA's private key. The script checks the supplied pair and hostname, but does not establish your CA's trust for browsers or devices.

All containers use non-root accounts and read-only root filesystems. The validator runs on a network without an internet route; the dashboard HTTP listener accepts only its own loopback and the TLS proxy. The proxy image is pinned to a digest and Docker downloads it on the first start. The database and the certificate files remain in named volumes `vectory_data` and `vectory_secrets`; back up both and protect access to Docker itself.

```sh
./start.sh status
./start.sh stop
./start.sh
```

Stop and resume retain the database, certificate and setup secret. If first setup is interrupted before `.env` is complete, run `./start.sh` again: its nonsecret `.setup.env` journal finishes setup with the retained certificate. Retain that journal until setup succeeds. The starter refuses to overwrite existing certificate state if an established installation's `.env` was lost; restore that file from your backup. It does not rotate a certificate automatically; the [server guide](https://vectory.ahmadz.ai/help/install-server/) covers certificate maintenance and the remaining configuration options.

For an unattended first start, provide `VECTORY_HOSTNAME`, `VECTORY_TLS_CERT_FILE`, `VECTORY_TLS_KEY_FILE` and `VECTORY_BIND_IP` as environment variables. For a separate instance, use `VECTORY_SERVER_PROJECT` consistently on every command. After a successful start, retain `.cache` and the loaded images to restart offline; the starter rechecks the image archives against its retained release inventory. For an offline first start, use `VECTORY_PREVIEW_RELEASE_DIR=/absolute/path/to/release` with both image archives and their release `SHA256SUMS`; pre-load the pinned proxy image too.

This release is unsigned. Its checksums detect corruption and bind downloads to the published inventory; they do not establish a separate publisher signing identity. Review [platform coverage](https://vectory.ahmadz.ai/help/compatibility/) before relying on it. No download or file write is reported as a device activation: the enrolled agent must validate and run the pipeline before a device reports **Applied**.
