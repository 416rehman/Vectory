# Alerts and notifications

Get a message in Slack, any webhook receiver or email when an issue opens, a rollout fails or a device goes offline. Administrators set up channels in [**Settings → Notifications**](/#/notifications).

## Before you start

| You need | Why |
| --- | --- |
| The Administrator role | Channels, the delivery log and threshold changes are for administrators. Everyone can read the detection thresholds. |
| A receiver | A Slack incoming webhook, an HTTPS endpoint of your own, or an SMTP server that speaks TLS. |
| `VECTORY_PUBLIC_URL` (optional) | Messages get an **Open in Vectory** link. See [Server configuration](server-config.md). |

Messages carry names and states: the device, pipeline, deployment and the issue's message. They never carry event contents.

## Add a Slack channel

<!-- steps -->
1. In Slack, create an app with an incoming webhook for the channel you want, and copy its URL. It starts with `https://hooks.slack.com/services/`.
2. In Vectory, open [**Settings → Notifications**](/#/notifications) and choose **Add channel**.
3. Enter a **Name**, keep **Webhook** and paste the URL into **Webhook URL**.
4. Under **What to send**, keep the events you want. The **Preview** on the right shows the message with example names.
5. Choose **Add channel**, then **Send test** on its row.

You should see a toast such as "Test delivered to On-call Slack: answered 200 in 142 ms", and a message marked as a test in Slack. The channel's status turns **Delivering**.

## Add a webhook channel

Any HTTPS endpoint that accepts a JSON `POST` works, such as your own service or an automation that reads the `event` object. A service that expects its own format, such as PagerDuty's Events API, needs a small relay in between. Add the channel like a Slack channel, then set the optional fields:

- **Signing secret (optional):** at least 16 characters. Each message gets an `X-Vectory-Signature` header your receiver can check.
- **Header (optional)** and **Header value:** a header sent with every message, such as `Authorization` with `Bearer <token>`. Vectory sets `Host`, `Content-Type`, `User-Agent` and the `X-Vectory-` headers itself.

Put credentials in the header, never in the URL: a URL with a user name or password is refused. A receiver must answer with a `2xx` status. Vectory doesn't follow redirects, so use the final URL.

### The webhook payload

Every message is one JSON object. Slack reads `text` and `blocks`; other receivers read `event`. Slack renders `text` with its own markup, so Vectory escapes `&`, `<` and `>` in it, as in the blocks; `event.headline` keeps the words as written.

```json
{
  "text": "Issue on edge-fra-01: http-out can't deliver events",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Issue on edge-fra-01: http-out can't deliver events*\nThe http sink http-out is failing about 12 requests a minute (connection refused)."
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Pipeline: Edge logs v12 · Device: edge-fra-01 · Error · Vectory" }
      ]
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Open in Vectory" },
          "url": "https://vectory.example.com/#/issues?device=6f1c2a4e-8b7d-4c3a-9e5f-0a1b2c3d4e5f"
        }
      ]
    }
  ],
  "event": {
    "schema": "vectory.notification.v1",
    "id": "9b2f0c4e8d1a7b3c5e6f7a8b9c0d1e2f",
    "type": "issue.opened",
    "severity": "error",
    "recovery": false,
    "occurred_at": "2026-09-29T08:15:02Z",
    "headline": "Issue on edge-fra-01: http-out can't deliver events",
    "message": "The http sink http-out is failing about 12 requests a minute (connection refused).",
    "device": { "id": "6f1c2a4e-8b7d-4c3a-9e5f-0a1b2c3d4e5f", "name": "edge-fra-01" },
    "pipeline": { "id": "2d4f6a8c-1b3d-4e5f-8a9b-0c1d2e3f4a5b", "name": "Edge logs", "version_number": 12 },
    "deployment": null,
    "issue": { "id": "7a9c1e3f-5b7d-4f1a-8c2e-4a6b8c0d2e4f", "code": "DATA_PLANE_SINK_ERRORS", "resolved_reason": null },
    "test": false,
    "instance": "Vectory",
    "url": "https://vectory.example.com/#/issues?device=6f1c2a4e-8b7d-4c3a-9e5f-0a1b2c3d4e5f"
  }
}
```

| Field | Holds |
| --- | --- |
| `event.id` | The same for every attempt and every channel that sends this event. Use it to drop duplicates. |
| `event.type` | `issue.opened`, `issue.resolved`, `rollout.failed`, `rollout.rolled_back`, `canary.paused`, `device.offline`, `device.recovered`, `test` or `digest`. |
| `event.severity` | `error` or `warning`; `info` for a test. |
| `event.recovery` | `true` for `issue.resolved` and `device.recovered`. |
| `event.device`, `event.pipeline`, `event.deployment`, `event.issue` | What the event is about, or `null`. |
| `event.test` | `true` only for a message sent with **Send test**. |
| `event.url` | The page in Vectory, or `null` without `VECTORY_PUBLIC_URL`. |
| `event.count`, `event.items` | Only on a `digest`: how many messages it stands for, and the first of them. |

Each request also carries `X-Vectory-Event` (the event type) and `X-Vectory-Delivery`, which stays the same across retries of one message.

### Verify the signature

With a signing secret, the header reads `X-Vectory-Signature: t=1790669702,v1=5f2b…`. `v1` is the hex HMAC-SHA256 of the timestamp, a period and the raw request body, keyed with the secret. Reject a message whose signature doesn't match or whose timestamp is more than five minutes old:

```python
import hashlib
import hmac
import time

def verify(secret: str, header: str, body: bytes) -> bool:
    parts = dict(item.split("=", 1) for item in header.split(","))
    timestamp = parts["t"]
    if abs(time.time() - int(timestamp)) > 300:
        return False
    signed = timestamp.encode() + b"." + body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
```

Check the raw bytes you received, before any JSON parsing.

## Add an email channel

Email goes out as plain text through your own SMTP server.

<!-- steps -->
1. Choose **Add channel**, then **Email**.
2. Enter the **SMTP server** and **Port**, and choose **Security**: **STARTTLS (usually port 587)** or **TLS (usually port 465)**.
3. If the server needs a login, enter the **User name (optional)** and **Password**.
4. Enter **From**, such as `Vectory <alerts@example.com>`, and up to 10 addresses in **To**, separated by commas.
5. Choose **Add channel**, then **Send test**.

STARTTLS is required, never optional: a server that doesn't offer it fails the test instead of receiving mail in the clear. **None: a relay on this server only** sends unencrypted mail only to `localhost`, and only with **Allow private network addresses** on.

## Choose what each channel sends

Each channel has its own events and filters, so one channel can page on-call for errors while another collects everything.

| Event | Sent when |
| --- | --- |
| **Issue opened** | A device reports a problem, or a resolved one comes back. |
| **Issue resolved** | The device verified a configuration since the failure, or delivery is healthy again. Issues closed because a newer version replaced the old one send nothing. |
| **Rollout failed** | A rollout stopped: too many devices failed, a canary stopped delivering, or its scheduled start was blocked. |
| **Rollout rolled back** | Someone rolled a deployment back. |
| **Canary paused** | A canary waits because devices that applied it stopped delivering events. |
| **Device offline** | A device missed three check-ins and has been silent for the minutes you choose (15 by default, 5 to 1,440). |
| **Device back online** | A device you were told about checks in twice again. |

A new channel starts with every event except **Rollout rolled back** and **Canary paused**. Turn them on for the channels that should send them.

- **Severity:** **Errors only** sends issues with error severity and failed rollouts. Everything else is a warning.
- **Pipelines** and **Groups:** send only events about these. A rollout matches the groups it targets and the groups of its devices.

Each event goes out once per channel. A device that drops out again before its second check-in stays in the same outage, so it doesn't send a second **Device offline**. A new channel sends events from the moment you save it; it doesn't announce devices that were already offline.

## Quiet hours

Turn on **Hold messages overnight** and set **From**, **Until** and the **Time zone**. Quiet hours can cross midnight, such as 22:00 to 07:00. Messages that arrive in that window wait, then go out as one summary when it ends.

With **Let errors through** (on by default), error issues and failed rollouts arrive at once. Warnings and recoveries wait for the summary.

## Send a test

**Send test** on a channel's row (or in its dialog on a phone) sends one message marked as a test, now. The toast shows what the receiver did: its status code and time, or the error. A test is never retried and never counted as delivered unless the receiver accepted it. Each channel can send six tests a minute.

## Private networks and blocked addresses

Vectory is a server sending requests to an address an administrator typed, so it checks where each request goes.

| Address | Examples | Vectory sends there |
| --- | --- | --- |
| Public | `hooks.slack.com` | Yes, over HTTPS. |
| Private and loopback | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `127.0.0.0/8`, `fc00::/7`, `::1` | Only with **Allow private network addresses** on for that channel. Plain `http://` is allowed only here. |
| Link-local and cloud metadata | `169.254.0.0/16` (including `169.254.169.254`), `fe80::/10`, `fd00:ec2::/32`, `100.100.100.200`, `168.63.129.16` (Azure's platform address) | Never. |
| Multicast, reserved and documentation ranges | `224.0.0.0/4`, `0.0.0.0/8`, `240.0.0.0/4`, `192.0.2.0/24`, `2001:db8::/32` | Never. |

- Vectory resolves the host name, checks every address, and connects only to an address it checked. A DNS answer that changes to a private address later is refused at connect time.
- IPv6 forms that carry an IPv4 address (IPv4-mapped, NAT64 and 6to4) are judged by the IPv4 address inside. Teredo addresses are refused.
- A connection gets 5 seconds, and the whole request 10 seconds. Vectory reads at most 4 KiB of the answer.

To send to a receiver on your own network, edit the channel and turn on **Allow private network addresses**. The change is recorded in the [audit log](/#/audit). Cloud metadata and link-local addresses stay blocked either way.

> [!IMPORTANT]
> **Secrets are write-only**
> After you save them, the webhook URL, signing secret, header value and SMTP password are encrypted at rest and never shown again: the dialog says **Saved** and offers **Replace**. They never appear in API answers, the audit log, the delivery log or server logs. Only the webhook's host is shown.

## How delivery works

Messages are sent in the background. A slow or unreachable receiver never slows check-ins, rollouts or the dashboard.

| Situation | What happens |
| --- | --- |
| The receiver answers `2xx` | **Delivered**. |
| No connection, no answer in time, a TLS failure, `408`, `425`, `429` or `5xx` | **Retrying**: again after 1 minute, 5 minutes and 30 minutes. If the fourth attempt fails, **Gave up**. |
| Any other `4xx`, a redirect or a refused address | **Failed** at once. A retry wouldn't change it. |
| More than 30 messages in a minute | The rest wait and go out as one summary, such as "12 more notifications, summarised to avoid flooding this channel". |
| 500 messages already waiting | New ones join one summary, "… more notifications while this channel was behind". |

A message is sent at least once. If the server restarts during a send, the receiver may get it twice: drop duplicates by `event.id`. Turning a channel off drops the messages still waiting for it.

## Read the delivery log

[**Settings → Notifications → Delivery log**](/#/notifications?view=delivery) lists every attempt, tests included, newest first: the channel, the message, the attempt (**Test**, or **1 of 4** to **4 of 4**) and the result with the receiver's status code and time. Filter by **Delivered**, **Retrying**, **Failed** or **Gave up**, or by channel.

Errors are cut at 500 characters, with secrets and the URL's path replaced by `«redacted»`. Attempts are kept for 30 days.

## Tune detection thresholds

[**Settings → Notifications → Detection**](/#/notifications?view=detection) holds the numbers that decide when a device's metrics open a delivery issue and when a canary may release its next wave. See [Delivery health](telemetry.md#delivery-health) for how the checks work.

| Setting | Default | Allowed | Means |
| --- | --- | --- | --- |
| **Failing destination** | 1 failed request a minute | 1 to 10,000 | A sink failing at least this often counts as failing. |
| **Dropped events** | 1 event a minute | 1 to 100,000 | A component dropping at least this many events a minute because of errors counts as losing events. |
| **Full buffer** | 95% | 55 to 100 | A buffer this full counts as full. |
| **Stalled pipeline** | 3 checks in a row | 2 to 20 | A stall opens when this many checks find events arriving and none delivered. |
| **Canary measurement** | 3 checks per device | 1 to 20 | A canary waits for this many checks of each device's delivery before its next wave. |

Changes apply from each device's next check and are recorded in the audit log. **Reset to defaults** puts back the values above; at the defaults, detection behaves exactly as described in [Delivery health](telemetry.md#delivery-health). Raising a threshold means problems are reported later, so change one number at a time and watch the result.

## Troubleshoot a failing channel

A channel reads **Failing** when its last attempt failed; the reason is under its status and in the delivery log.

| The error says | Do this |
| --- | --- |
| "… resolves to 10.0.0.5, a private address. Turn on Allow private network addresses to send there." | The host name points into your network. Turn on **Allow private network addresses** if that's intended. |
| "… which Vectory never contacts." | The address is link-local, cloud metadata or reserved. Use the receiver's real, routable address. |
| "The receiver answered 404 Not Found" or "403 Forbidden" | The URL or credential is wrong or was revoked. For Slack, create a new incoming webhook and **Replace** the URL. |
| "… a redirect. Vectory doesn't follow redirects; use the final URL." | Replace the URL with the one the redirect points to, usually `https://` instead of `http://`. |
| "Couldn't resolve …", "Connection refused by …", "Timed out connecting to …" or "… didn't answer within 10 s" | Check the receiver is up, its name resolves from this server, and your firewall lets this server reach it. Retries continue on their own. |
| "TLS handshake with … failed" | The receiver needs a certificate from a public certificate authority, valid for its host name. Vectory doesn't trust private certificate authorities for notifications. |
| **Needs secrets** | The channel's saved secrets can't be read with this server's keys, for example after restoring onto a different key. Edit the channel and enter them again. |

After fixing it, choose **Send test**. The channel returns to **Delivering** with the next delivered message.

## Next steps

- [Work with issues](telemetry.md#work-with-issues) that messages link to.
- [Follow a rollout](deployments.md#follow-a-rollout) when one fails or pauses.
- [Review and export audit events](administer.md#review-and-export-audit-events) for every channel change.
