# Server configuration

Every environment variable that `vectory-server`, the validator, Docker Compose and the local preview read. The [prebuilt server kit](install-server.md) creates its `.env` through guided setup. For a manual source deployment, use `deploy/.env` and the Compose settings below.

## Compose settings

The prebuilt [server kit](install-server.md) writes `.env` during guided setup and uses image-only Compose. On the first start, it reads your hostname, TLS file paths and bind address, copies the TLS pair into its private Docker volume, and generates the setup secret there. Later starts use the retained files and image settings.

The table below describes the equivalent manual Compose settings. The contributor source Compose file, `deploy/compose.yaml`, reads them from `deploy/.env`; ordinary installation uses the prebuilt kit.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_HOSTNAME` | Required | DNS name for the dashboard and agents, for example `vectory.example.com`. |
| `VECTORY_TLS_CERT_FILE` | Required | Host path of the TLS certificate chain (PEM). The proxy and the agent listener both serve it. |
| `VECTORY_TLS_KEY_FILE` | Required | Host path of the certificate's private key. |
| `VECTORY_BOOTSTRAP_SECRET_FILE` | Required | Host path of the bootstrap secret file. Compose mounts it for the server. |
| `VECTORY_SERVER_PROJECT` | `vectory` | Compose project and private volume prefix for the prebuilt server kit. Keep the same value when stopping or resuming an instance. |
| `VECTORY_BIND_IP` | `0.0.0.0` | Host address that ports 443 and 8443 listen on. |
| `VECTORY_RELEASES_DIRECTORY` | `./releases` | Host folder mounted read-only as the server's agent download mirror. |
| `VECTORY_MAX_AGENT_CONNECTIONS` | `16384` | Passed to the server; see below. |
| `VECTORY_TELEMETRY_RETENTION_DAYS` | `7` | Passed to the server; see below. |

Compose sets the server's own variables (TLS paths, validator URL, data directory, and the proxy as the only peer the HTTP listener accepts) for you. Keep the four required files readable by UID/GID 10001 only.

### Starter-managed values

The prebuilt kits verify their image downloads and write these values themselves. They are not settings to enter during guided setup or edit in the generated files.

| Variable | Written to | Meaning |
| --- | --- | --- |
| `VECTORY_SERVER_IMAGE` | Server kit `.env` | Verified server image selected for this release. |
| `VECTORY_VALIDATOR_IMAGE` | Server kit `.env` | Verified validator image selected for this release. |
| `VECTORY_SETUP_PROJECT` | Temporary server kit `.setup.env` | Project recorded while first setup completes, so an interrupted setup resumes with the same volumes. The starter removes the journal after setup. |
| `VECTORY_PREVIEW_SERVER_IMAGE` | Preview kit `.preview.env` | Verified server image selected for the local preview. |
| `VECTORY_PREVIEW_VALIDATOR_IMAGE` | Preview kit `.preview.env` | Verified validator image selected for the local preview. |

## Server settings

`vectory-server` reads these at startup. Change them, then restart the server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_DATA_DIR` | `./data` | State directory: the SQLite database, keys and exports. Keep it on local disk and back it up as one unit. The Compose image uses `/var/lib/vectory`. |
| `VECTORY_BOOTSTRAP_SECRET_FILE` | None | File holding the bootstrap secret (24 characters or more). Needed only until the first administrator exists. |
| `VECTORY_BOOTSTRAP_SECRET` | None | The bootstrap secret itself. Used only when `VECTORY_BOOTSTRAP_SECRET_FILE` is unset; prefer the file. |
| `VECTORY_HTTP_ADDR` | `127.0.0.1:8080` | Plain-HTTP listener for the dashboard, API and Help center. Put a TLS proxy in front of it and let only the proxy connect (`VECTORY_HTTP_ALLOWED_PEERS`). In production, an address that isn't loopback logs a warning at startup unless the allowed peers are set. |
| `VECTORY_HTTP_ALLOWED_PEERS` | None | Who may connect to the HTTP listener: comma-separated IP addresses, ranges such as `10.0.0.0/24` and host names such as `proxy`. A connection from anyone else is closed at once, before it sends a byte, and logged at most once a minute. Loopback is always allowed, so a health check inside the container works. Names are looked up at startup, every 30 seconds and soon after a connection is refused. A failed lookup keeps the last addresses, and a name with none yet allows nobody. Compose sets it to `proxy`, the bundled proxy's service name. If your own proxy connects to the server directly, add its address or name in `deploy/compose.yaml`. Unset or empty allows every peer. |
| `VECTORY_HTTP_HEADER_TIMEOUT_SECONDS` | `15` | Seconds a client has to send a request's start line and headers, counted from when it connects or from its last response. A connection that sends nothing or stalls, and one that sits idle between requests, is closed after this long. From 1 to 120. |
| `VECTORY_HTTP_BODY_TIMEOUT_SECONDS` | `30` | Seconds a request body has to arrive in full once its headers have, however steadily it trickles. A slower body is cut off and the request fails. Raise it only for clients on very slow links. From 1 to 300. |
| `VECTORY_MAX_HTTP_CONNECTIONS` | `4096` | Most dashboard and API connections served at once, from 64 to 65,536. A connection beyond the limit is closed at once, and the ones already served are not disturbed. A resource limit, not a supported number of users. |
| `VECTORY_AGENT_ADDR` | `0.0.0.0:8443` | TLS listener for agents. |
| `VECTORY_TLS_CERT` | None | Certificate chain (PEM) for the agent listener. Required unless `VECTORY_DEVELOPMENT=true`. |
| `VECTORY_TLS_KEY` | None | Private key for `VECTORY_TLS_CERT`. |
| `VECTORY_VALIDATION_URL` | None | URL of the isolated validator, for example `http://validator:8081`. Required unless `VECTORY_DEVELOPMENT=true`. |
| `VECTORY_DASHBOARD_DIR` | `../dashboard/dist` | Built dashboard and Help center to serve. |
| `VECTORY_INSTANCE_NAME` | `Vectory` | Name shown in the dashboard. |
| `VECTORY_COOKIE_SECURE` | `true` | Marks the session cookie `Secure`. `false` is allowed only with `VECTORY_DEVELOPMENT=true`. |
| `VECTORY_TRUST_PROXY_HEADERS` | `false` | Take the client address from the last `X-Forwarded-For` hop, for sign-in limits and the audit log. Turn it on only when the HTTP listener is reachable solely through a proxy you control; `VECTORY_HTTP_ALLOWED_PEERS` enforces that. |
| `VECTORY_MAX_AGENT_CONNECTIONS` | `16384` | Most agent connections accepted at once, from 64 to 65,536. Any other value stops the server at startup with a message that names the variable, the value and the range. TLS handshakes in progress are limited to an eighth of it (128 to 4,096), and a connection that doesn't send its TLS hello within three seconds is closed. A resource limit, not a supported fleet size. |
| `VECTORY_AGENT_WAKE_LIMIT` | `20000` | Most agents that can wait for changes at once, from 0 to 100,000. A waiting agent gets a deployment within seconds instead of at its next check-in; beyond the limit, agents check in on schedule. Each waiting agent keeps its one connection open, which counts toward `VECTORY_MAX_AGENT_CONNECTIONS`. `0` turns wake-ups off. |
| `VECTORY_TELEMETRY_RETENTION_DAYS` | `7` | Days of device metrics history to keep, from 1 to 30. Any other value stops the server at startup with a message that names the variable, the value and the range. The audit log is kept separately and never pruned. See [Storage and limits](telemetry.md#storage-and-limits). |
| `VECTORY_SCHEDULE_LATE_START_SECONDS` | `3600` | How late a scheduled deployment may still start, in seconds, from 60 to 604800 (7 days). If the server was down at the scheduled time, a schedule it finds within this window starts once; a later one is marked **Schedule missed** and needs a new deployment. The server refuses to start with any other value. |
| `VECTORY_PREVIOUS_DEVICE_CA` | None | The older manual way to replace the device CA: a PEM file (up to 64 KiB) whose certificates the agent listener also trusts for as long as the variable is set. [`vectory-admin rotate-device-ca`](vectory-admin.md#rotate-device-ca) replaces it, tracks which devices still need the old CA and retires it. The server logs a warning while this is set. |
| `VECTORY_DEVELOPMENT` | `false` | Local development only. Allows running without TLS, the validator or secure cookies, and then requires loopback listeners. |

For the three HTTP listener limits (`VECTORY_HTTP_HEADER_TIMEOUT_SECONDS`, `VECTORY_HTTP_BODY_TIMEOUT_SECONDS` and `VECTORY_MAX_HTTP_CONNECTIONS`), a number outside the range is brought into it. A value that isn't a whole number stops the server at startup with a message that names the variable, and so does an allowed peer that isn't an address, a range or a host name.

`RUST_LOG` controls log detail, for example `RUST_LOG=vectory_server=debug`. The default is `vectory_server=info,tower_http=warn`. Adding `vectory_server::sqlite=debug` logs one line a minute about the database: how many writes ran, the share of the minute the single writer was busy (`busy_percent`), how long writes waited for it, and the size of the write-ahead log (`wal_bytes`).

### Agent downloads

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_BUNDLED_RELEASES_DIR` | Set by the image | Agent downloads built into the server image. |
| `VECTORY_RELEASES_DIR` | `<data dir>/releases` | Optional mirror of agent downloads with a `catalog.json`. An entry here overrides the bundled one for the same OS and CPU. |
| `VECTORY_PUBLIC_AGENT_URL` | The agent listener | Agent URL that **Add device** puts in install commands, for when devices reach the server through another name or port. |
| `VECTORY_PUBLIC_AGENT_DOWNLOADS` | `true` | Serve the installer and agent downloads on the agent listener. Set `false` to require manual downloads. |
| `VECTORY_AGENT_RELEASE_STORAGE_BYTES` | `2147483648` (2 GiB) | Space for the releases that [agent updates](agent-updates.md) prepare. Preparing a release that would pass it is refused with `RELEASE_STORAGE_FULL`: withdraw releases you no longer need, or raise it. Up to 20 releases that aren't withdrawn can exist, whatever the space. |
| `VECTORY_PUBLIC_URL` | `http://<this host>:<web port>` | The dashboard address people use (`https://` or `http://`). The installer prints a link to the new device there, the startup banner shows it, and, when you set it, notifications link back to it. |

> [!IMPORTANT]
> **A production server refuses to start without its safety settings**
> Without `VECTORY_DEVELOPMENT=true`, the server requires `VECTORY_TLS_CERT`, `VECTORY_TLS_KEY` and `VECTORY_VALIDATION_URL`, and secure cookies. It never falls back to a weaker mode.

## Validator settings

The validator container (`vector-validator`) reads these.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_VALIDATOR_ISOLATED` | None | Must be `true`, or the validator refuses to start. Set it only where the validator runs isolated: no production files or secrets, no network route out, limited memory and processes. |
| `VECTORY_VECTOR_BINARY` | `/usr/local/bin/vector` | The Vector 0.58.0 binary that checks pipelines. The image uses `/usr/bin/vector`. |
| `VECTORY_VALIDATOR_ADDR` | `0.0.0.0:8081` | Listener for requests from the server. Keep it on an internal network. |

## Local preview settings

The prebuilt [preview kit](quickstart.md) needs Docker Compose and verifies its image downloads before starting. Its settings are:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_PREVIEW_PROJECT` | `vectory-preview` | Docker Compose project and private volume prefix. Use the same value when stopping or resuming. |
| `VECTORY_PREVIEW_WEB_PORT` | `8080` | Dashboard port on 127.0.0.1. |
| `VECTORY_PREVIEW_AGENT_PORT` | `8443` | TLS agent listener port on 127.0.0.1. |
| `VECTORY_PREVIEW_VALIDATOR_PORT` | `18081` | Isolated validator's loopback host port. |
| `VECTORY_PREVIEW_RELEASE_DIR` | None | Optional offline directory containing the two image archives and their release `SHA256SUMS`. |

### Source development preview

Contributors can use `scripts/preview.sh` and the [source quickstart](https://github.com/416rehman/Vectory/blob/main/docs/dev/SOURCE-QUICKSTART.md). These source-build settings do not apply to the prebuilt kit:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_PREVIEW_DIR` | `.local/preview` | State, logs and the bootstrap secret for the preview. |
| `VECTORY_PREVIEW_WEB_PORT` | `8080` | Dashboard port on 127.0.0.1. |
| `VECTORY_PREVIEW_AGENT_PORT` | `8443` | Agent listener port on 127.0.0.1. |
| `VECTORY_PREVIEW_VALIDATOR_PORT` | `8081` | Validator port on 127.0.0.1. |
| `VECTORY_PREVIEW_VECTOR` | First `.local/tools/*/bin/vector` | Vector binary for the preview's validator. Without one, checks are structural only. |
| `VECTORY_PREVIEW_AGENT_TARGETS` | Every supported platform | Space-separated `os/arch` list of bundled agents to build, for example `linux/amd64 darwin/arm64`, for a faster first start. |

The preview also honors `VECTORY_RELEASES_DIR` and `VECTORY_INSTANCE_NAME`. `node scripts/demo.mjs` uses the same preview variables, plus `VECTORY_DEMO_DIR` (default `.local/demo`) for its agents and `VECTORY_DEMO_METRICS_PORT` (default `19600`), the first loopback port its agents' metrics exporters use.

`VECTORY_UPDATE_GOLDEN` is read only by the server's own tests: set to `1`, it rewrites the golden file of the release tests. It has no effect on a running server.

`VECTORY_REQUEST_FIXTURES` is read only by the server's own tests, which then print query plans prefixed with `VECTORY_REQUEST_PLAN`. It has no effect on a running server.
