# Install the server

Run the Vectory developer preview with Docker Compose on one Linux host: the server, a TLS proxy and a sandboxed Vector validator. Plan on 30 minutes, most of it the first image build.

## Before you start

| You need | Notes |
| --- | --- |
| A Linux host with Docker Engine and Compose v2 | Local, durable disk. SQLite does not support network filesystems. |
| A DNS name, such as `vectory.example.com` | Browsers and devices both use it. |
| A TLS certificate and private key for that name | PEM files. Devices must trust the issuer; a private CA works. |
| Open inbound ports 443 and 8443 | See [Open the ports](#open-the-ports). |

> [!NOTE]
> Images are not published yet, so the first start builds them from source. Allow 10–20 minutes and internet access for the build.

## 1. Store the certificate and a bootstrap secret

The containers run as UID/GID **10001**. Give that group read access to the files, and nobody else:

```sh
sudo install -d -m 0750 -g 10001 /etc/vectory
sudo install -m 0440 -g 10001 fullchain.pem /etc/vectory/server.pem
sudo install -m 0440 -g 10001 privkey.pem /etc/vectory/server-key.pem
sudo sh -c 'umask 337 && openssl rand -hex 32 > /etc/vectory/bootstrap'
sudo chgrp 10001 /etc/vectory/bootstrap
```

> [!IMPORTANT]
> **Private CA?**
> Append your CA's public certificate so devices can pin it: `cat fullchain.pem ca.pem | sudo install -m 0440 -g 10001 /dev/stdin /etc/vectory/server.pem`. **Add device** then shows the CA fingerprint devices will trust.

The bootstrap secret creates the first administrator, once. It is not an enrollment token and it cannot sign anyone in after setup.

## 2. Configure

```sh
git clone https://github.com/416rehman/Vectory.git
cd Vectory
git checkout v0.1.0
cd deploy
cp .env.example .env
```

Edit `.env`:

```ini
VECTORY_HOSTNAME=vectory.example.com
VECTORY_TLS_CERT_FILE=/etc/vectory/server.pem
VECTORY_TLS_KEY_FILE=/etc/vectory/server-key.pem
VECTORY_BOOTSTRAP_SECRET_FILE=/etc/vectory/bootstrap
```

The other settings have safe defaults. Every variable is listed in [Server configuration](server-config.md).

## 3. Start

Run Compose from the `deploy` folder so it picks up `compose.yaml` and `.env` automatically:

```sh
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 300
docker compose ps
```

`--wait` returns once every service is healthy, and fails if one is not. You should see `server`, `proxy` and `validator` running and reported as healthy; the proxy is healthy once a request through it reaches the server. Compose starts the server only after the validator's health check passes and the proxy only after the server's, so the first start can take a little longer. If a service is not running or healthy, read the logs:

```sh
docker compose logs --tail 100 server proxy validator
```

The server image includes the agent for every supported platform, so **Add device** works immediately.

## 4. Create the first administrator

Open `https://vectory.example.com`. Paste the contents of `/etc/vectory/bootstrap`, then choose your name, email and password (12 characters or more). There are no default accounts and no public sign-up.

Then retire the secret so a leaked copy is worthless:

```sh
sudo sh -c 'umask 337 && openssl rand -hex 32 > /etc/vectory/bootstrap'
sudo chgrp 10001 /etc/vectory/bootstrap
docker compose restart server
```

Next, [set up an authenticator](administer.md#set-up-an-authenticator) for your account.

## Open the ports

| Port | From | Purpose |
| --- | --- | --- |
| 443 | Browsers | Dashboard, API and Help center, through the TLS 1.3 proxy |
| 8443 | Devices | Agent enrollment and check-ins (TLS 1.3, mutual TLS after enrollment) |

Everything else stays on Compose's internal networks. The validator has no route out at all. To listen on one interface only, set `VECTORY_BIND_IP` in `.env`. [Ports and network](ports.md) covers firewalls and proxies.

## What runs where

| Container | Runs as | Isolation |
| --- | --- | --- |
| `proxy` (Caddy) | UID 10001 | Read-only filesystem, only `NET_BIND_SERVICE`, no admin API. Serves TLS 1.3 only and never forwards `/agent/` paths. |
| `server` | UID 10001 | Read-only filesystem, no capabilities. Keeps all state in the `data` volume. |
| `validator` | UID 10002 | Internal network with no internet route, no host ports, no secrets, read-only filesystem, 512 MiB memory, 1 CPU and 64 processes. |

> [!IMPORTANT]
> **Publishing stops if the validator is down**
> The server refuses to publish until the validator is reachable again. It never skips the check. Restore the `validator` container rather than retrying.

The `data` volume holds the database and the server's keys, and they belong together. [Back up the complete state](administer.md#back-up-the-complete-state) before any upgrade.

## Next steps

- [Connect a device](installation.md).
- [Invite your team](administer.md#create-workspace-accounts).
- [Back up the server](administer.md#back-up-the-complete-state) and [plan upgrades](administer.md#upgrade-the-server).
