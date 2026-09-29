# Server configuration

Every environment variable that `vectory-server`, the validator, Docker Compose and the local preview read. With Compose, set them in `deploy/.env`; most installations only need the four in [Install the server](install-server.md#2-configure).

## Compose settings

`deploy/compose.yaml` reads these from `deploy/.env` and passes the right values to each container.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_HOSTNAME` | Required | DNS name for the dashboard and agents, for example `vectory.example.com`. |
| `VECTORY_TLS_CERT_FILE` | Required | Host path of the TLS certificate chain (PEM). The proxy and the agent listener both serve it. |
| `VECTORY_TLS_KEY_FILE` | Required | Host path of the certificate's private key. |
| `VECTORY_BOOTSTRAP_SECRET_FILE` | Required | Host path of the bootstrap secret file. Compose mounts it for the server. |
| `VECTORY_BIND_IP` | `0.0.0.0` | Host address that ports 443 and 8443 listen on. |
| `VECTORY_RELEASES_DIRECTORY` | `./releases` | Host folder mounted read-only as the server's agent download mirror. |
| `VECTORY_MAX_AGENT_CONNECTIONS` | `16384` | Passed to the server; see below. |
| `VECTORY_TELEMETRY_RETENTION_DAYS` | `7` | Passed to the server; see below. |

Compose sets the server's own variables (TLS paths, validator URL, data directory) for you. Keep the four required files readable by UID/GID 10001 only.

## Server settings

`vectory-server` reads these at startup. Change them, then restart the server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_DATA_DIR` | `./data` | State directory: the SQLite database, keys and exports. Keep it on local disk and back it up as one unit. The Compose image uses `/var/lib/vectory`. |
| `VECTORY_BOOTSTRAP_SECRET_FILE` | None | File holding the bootstrap secret (24 characters or more). Needed only until the first administrator exists. |
| `VECTORY_BOOTSTRAP_SECRET` | None | The bootstrap secret itself. Used only when `VECTORY_BOOTSTRAP_SECRET_FILE` is unset; prefer the file. |
| `VECTORY_HTTP_ADDR` | `127.0.0.1:8080` | Plain-HTTP listener for the dashboard, API and Help center. Put a TLS proxy in front of it. |
| `VECTORY_AGENT_ADDR` | `0.0.0.0:8443` | TLS listener for agents. |
| `VECTORY_TLS_CERT` | None | Certificate chain (PEM) for the agent listener. Required unless `VECTORY_DEVELOPMENT=true`. |
| `VECTORY_TLS_KEY` | None | Private key for `VECTORY_TLS_CERT`. |
| `VECTORY_VALIDATION_URL` | None | URL of the isolated validator, for example `http://validator:8081`. Required unless `VECTORY_DEVELOPMENT=true`. |
| `VECTORY_DASHBOARD_DIR` | `../dashboard/dist` | Built dashboard and Help center to serve. |
| `VECTORY_INSTANCE_NAME` | `Vectory` | Name shown in the dashboard. |
| `VECTORY_COOKIE_SECURE` | `true` | Marks the session cookie `Secure`. `false` is allowed only with `VECTORY_DEVELOPMENT=true`. |
| `VECTORY_TRUST_PROXY_HEADERS` | `false` | Take the client address from the last `X-Forwarded-For` hop, for sign-in limits and the audit log. Turn it on only when the HTTP listener is reachable solely through a proxy you control. |
| `VECTORY_MAX_AGENT_CONNECTIONS` | `16384` | Most agent connections accepted at once, from 64 to 65,536. A resource limit, not a supported fleet size. |
| `VECTORY_TELEMETRY_RETENTION_DAYS` | `7` | Days of device metrics history to keep, from 1 to 30. The audit log is kept separately and never pruned. |
| `VECTORY_PREVIOUS_DEVICE_CA` | None | PEM file (up to 64 KiB) with a previous device CA, so devices can still renew while you move to a replacement device CA. |
| `VECTORY_DEVELOPMENT` | `false` | Local development only. Allows running without TLS, the validator or secure cookies, and then requires loopback listeners. |

`RUST_LOG` controls log detail, for example `RUST_LOG=vectory_server=debug`. The default is `vectory_server=info,tower_http=warn`.

### Agent downloads

<!-- verify-after-merge: bundled agent downloads, the public agent URL and the public install endpoints (W1) -->
| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_BUNDLED_RELEASES_DIR` | Set by the image | Agent downloads built into the server image. |
| `VECTORY_RELEASES_DIR` | `<data dir>/releases` | Optional mirror of agent downloads with a `catalog.json`. An entry here overrides the bundled one for the same OS and CPU. |
| `VECTORY_PUBLIC_AGENT_URL` | The agent listener | Agent URL that **Add device** puts in install commands, for when devices reach the server through another name or port. |
| `VECTORY_PUBLIC_AGENT_DOWNLOADS` | `true` | Serve the installer and agent downloads on the agent listener. Set `false` to require manual downloads. |

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

`scripts/preview.sh` runs a loopback server for development and trials. See the [Quickstart](quickstart.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `VECTORY_PREVIEW_DIR` | `.local/preview` | State, logs and the bootstrap secret for the preview. |
| `VECTORY_PREVIEW_WEB_PORT` | `8080` | Dashboard port on 127.0.0.1. |
| `VECTORY_PREVIEW_AGENT_PORT` | `8443` | Agent listener port on 127.0.0.1. |
| `VECTORY_PREVIEW_VALIDATOR_PORT` | `8081` | Validator port on 127.0.0.1. |
| `VECTORY_PREVIEW_VECTOR` | First `.local/tools/*/bin/vector` | Vector binary for the preview's validator. Without one, checks are structural only. |

The preview also honors `VECTORY_RELEASES_DIR` and `VECTORY_INSTANCE_NAME`. `node scripts/demo.mjs` uses the same preview variables, plus `VECTORY_DEMO_DIR` (default `.local/demo`) for its agents and `VECTORY_DEMO_METRICS_PORT` (default `19600`), the first loopback port its agents' metrics exporters use.

`VECTORY_REQUEST_FIXTURES` is read only by the server's own tests, which then print query plans prefixed with `VECTORY_REQUEST_PLAN`. It has no effect on a running server.
