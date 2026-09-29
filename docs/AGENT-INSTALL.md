# Install the Vectory agent

The full guide is **Connect a device** in your Vectory server's Help center, at `https://<your-server>/help/installation/`, and in the source repository at [docs/user/installation.md](user/installation.md).

The fastest path is **Devices → Add device** in your dashboard: it builds one command for your server, operating system and token.

## Manual install on Linux

You need Vector 0.58.0 on the host, an enrollment token from **Add device**, and outbound access to your server on port 8443.

<!-- verify-after-merge: default managed-configuration path after W1 unifies paths (CLI, setup, packaged unit) -->
```sh
sudo install -m 0755 vectory /usr/local/bin/vectory
sudo vectory install \
  --vector-binary /usr/bin/vector \
  --managed-config /etc/vectory/managed/vector.json \
  --adopt
sudo vectory enroll --server https://vectory.example.com:8443 --id web-01
sudo useradd --system --no-create-home --shell /usr/sbin/nologin vectory
sudo vectory service-install --service-user vectory
sudo vectory service-start
```

`enroll` asks for the token with hidden input. If your server's certificate comes from a private CA, add `--ca-file PATH` with the CA's public certificate.

## Before you start, know that

- The agent adopts an installed Vector 0.58.0 and never installs or upgrades it.
- New installs use restricted mode. Only the host can enable full mode, with `--allow-full-vector-config`.
- Enrolling never deploys a pipeline. Deploy one from the dashboard.
- The agent only connects out, over TLS 1.3, and never skips certificate checks.

Agent commands: `vectory --help`, or **Agent CLI** in the Help center.
