# API

Everything the dashboard does goes through the same HTTP API, so you can script it. The interactive reference is generated from this release's OpenAPI contract and runs against your server with your current session.

## Authenticate

The API uses the dashboard's session: sign in once, keep the cookie, and send the session's CSRF token with every change. There are no separate API keys yet.

<!-- steps -->
1. `POST /api/v1/login` with your email and password. The reply sets the `vectory_session` cookie and returns a `csrf_token`.
2. If your account uses two-factor sign-in, the reply is `{"mfa_required": true, "challenge_token": ...}` instead. Send the token with a current code to `POST /api/v1/login/mfa` as `challenge_token` and `totp_code` (or `recovery_code`).
3. Send the cookie with every request, and the header `X-CSRF-Token: <csrf_token>` with every change (`POST`, `PUT`, `DELETE`).

Requests run as you, with your role. Sessions last 12 hours.

## Automate with curl

This bash example signs in without putting the password in your history, lists devices, then signs out:

```sh
read -rs -p 'Password: ' VECTORY_PASSWORD && export VECTORY_PASSWORD
jq -n '{email: "you@example.com", password: env.VECTORY_PASSWORD}' \
  | curl -fsS -c cookies.txt -H 'Content-Type: application/json' -d @- \
      https://vectory.example.com/api/v1/login \
  | jq -r .csrf_token > csrf.txt
unset VECTORY_PASSWORD

curl -fsS -b cookies.txt https://vectory.example.com/api/v1/devices \
  | jq '.[] | {name, status, last_seen}'

curl -fsS -b cookies.txt -X POST \
  -H "X-CSRF-Token: $(cat csrf.txt)" \
  https://vectory.example.com/api/v1/logout
```

`cookies.txt` and `csrf.txt` let anyone who reads them act as you until the session ends. Keep them private and delete them when you're done.

## Read a large fleet

Let the server filter, sort and count, and read a page at a time. `GET /api/v1/devices` still returns every device, which gets slow with thousands of them.

| Request | Returns |
| --- | --- |
| `GET /api/v1/devices/inventory` | A page of devices (`page`, `page_size` up to 100, 50 by default) with `total` and counts per status. Filter with `q`, `status`, `view`, `group` and `version`; order with `sort` and `dir`. |
| `GET /api/v1/devices/inventory/ids` | The IDs of every matching device, up to 10,000, to select them all. |
| `GET /api/v1/devices/{id}` | One device. Add `include=groups` for its groups. |
| `GET /api/v1/groups?slim=1` | Groups with a `member_count` instead of every member's ID. |
| `GET /api/v1/groups/{id}/members` | A page of a group's members. Search it with `q`. |
| `GET /api/v1/overview?slim=1` | The Overview's numbers, without a row per device. |

`q` matches names, OS, architecture, pipelines, Vector and agent versions and group names as plain text. The inventory and member pages refuse an unknown or repeated parameter with `400` and name it (`Invalid query parameters: stauts isn't a parameter of this request`), so a typo never lists everything. They and the slim Overview can lag check-ins by up to two seconds; your own changes show at once.

```sh
curl -fsS -b cookies.txt \
  'https://vectory.example.com/api/v1/devices/inventory?status=failed&sort=last_seen' \
  | jq '.total, (.items[] | {name, status, last_seen})'
```

## Read what a device was offered

`GET /api/v1/devices/{id}/configuration` returns the exact text a device was offered, the values of its variables, and whether the file its agent reports is that text. Add `?generation=11` to read an earlier offer. `GET /api/v1/devices/{id}/configuration/diff?from=11&to=12` returns what changed between two offers, as hunks and as a unified diff cut at 2,000 lines. Every signed-in role can read both. They change nothing, and they refuse an unknown or repeated parameter with `400`. Reads are limited per account, to 240 a minute for the text and 60 for the comparison.

```sh
id=$(curl -fsS -b cookies.txt \
  'https://vectory.example.com/api/v1/devices/inventory?q=edge-nyc-01' | jq -r '.items[0].id')
curl -fsS -b cookies.txt "https://vectory.example.com/api/v1/devices/$id/configuration" \
  | jq -r '.running.matches, .content'
```

`running.matches` is `true` when the digest the agent last reported is the digest of `content`, `false` when it's another one and `null` when Vectory can't say. [How Vectory compares them](deployments.md#how-vectory-compares-them) has the rest.

## Check devices before you deploy

`POST /api/v1/deployments/preview` takes `device_validation: true` to ask the reviewed devices to validate the version on their own hosts. Nothing is deployed. The reply gains a `validation_id`, and `GET /api/v1/device-validations/{id}` reads the answers until its `state` is `complete`. Add `run_tests: true` to run the pipeline's own tests on each device too. Send the same body you would send to create the deployment, with `device_validation` added; `POST /api/v1/deployments` itself refuses the field.

```sh
id=$(curl -fsS -b cookies.txt -X POST -H "X-CSRF-Token: $(cat csrf.txt)" \
  -H 'Content-Type: application/json' -d @review.json \
  https://vectory.example.com/api/v1/deployments/preview | jq -r .validation_id)
curl -fsS -b cookies.txt "https://vectory.example.com/api/v1/device-validations/$id" \
  | jq '.state, (.devices[] | {name, state})'
```

Each device in the answer has one `state`:

| State | Meaning |
| --- | --- |
| `pending` | Asked, no answer yet. |
| `passed` | The device validated the version and found no error. |
| `failed` | It found at least one: read `diagnostics`, `tests` and `secrets_missing` (device-secret names it hasn't bound). |
| `offline` | It hadn't checked in for three of its own intervals, so it wasn't asked. |
| `expired` | No answer in ten minutes, a newer check for it replaced this one, or it was revoked. |
| `unsupported` | Its agent can't be checked, so it wasn't asked. |

A request checks the first 50 devices by name, fewer when their candidates together would be larger than 10 MiB, and sets `validation_truncated` when more were reviewed. You can make 6 requests a minute, and each device has one check at a time: a newer request replaces an older one that is still waiting. A `429` with a `Retry-After` header means you're over your six, or that the server is holding as many waiting candidates as it keeps (128 MiB): wait that long and ask again. Only the person who asked, or an administrator, can read a check; others get `404`. Answers are kept for 24 hours. A check is advisory: it changes no deployment, generation, setting or issue, and `passed` is the device's own report, not evidence that a version is applied.

## Use the interactive reference

[Open the interactive API reference](/api-reference.html). It lists every operation by area, with request and response schemas.

- **Dashboard API** operations can run right there, as you, against this server. They change real data.
- **Agent protocol** operations are read-only in the browser. Devices call them over the agent listener with their own certificates; use the `vectory` agent, not a browser session.

The reference sends requests only to this server. Your session cookie and CSRF token never leave it.

## Errors and safe retries

Errors return a JSON `error` object with a stable `code` and a readable `message`. Common ones are listed in [Troubleshooting](troubleshooting.md#error-messages).

| Status | Meaning |
| --- | --- |
| `401` | Not signed in, or the session ended. |
| `403` | Your role doesn't allow it (`Permission denied`), or the CSRF token is missing or wrong (`The X-CSRF-Token header is missing or wrong`). Both answer `FORBIDDEN`; the message says which. |
| `409` | Someone changed the resource first (`STALE_REVISION`), or the request conflicts with current state. Read the resource again before retrying. |
| `429` | Too many requests. Wait for the `Retry-After` time. |

Don't blindly repeat a change after a timeout: it may have succeeded. Operations that create things accept an optional `request_id`; repeating a request with the same ID returns the original result instead of making a second change, and never returns a secret twice. Saves include the revision you edited, and deployments include the devices you reviewed, so a stale request is refused instead of overwriting someone else's work.

## Agent requests

The `/agent/v1` protocol runs on the agent listener (port 8443) with mutual TLS. Enrollment exchanges a one-time token and a certificate request for a device certificate; check-ins, renewals and downloads then use that certificate. An enrollment token can't call the dashboard API, and a dashboard session can't call the agent protocol.
