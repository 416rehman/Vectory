# ADR 0009: Which addresses the server may send notifications to

Proposed 2026-09-29. This records the outbound policy merged in commit `23e616b` (implemented in `6bf9749`) as it stands at `a469266`; no one has reviewed or accepted it yet.

## Context

Notification channels are the one place where the control plane opens connections to an address an administrator typed: webhook URLs and SMTP relays. Such a feature can be abused for server-side request forgery against cloud metadata services, the server's own loopback services or internal networks. The specification's network rule (section 1, line 29) concerns devices: notifications go to operator-configured receivers, never to devices.

## Decision

- Every attempt resolves the host itself, checks every resolved address and connects only to an address it just checked, so a DNS answer that changes between saving and sending is judged at connect time (`server/src/outbound.rs`).
- Public addresses are allowed. Private addresses (RFC 1918, carrier-grade NAT, unique local IPv6 and this server's loopback) need an explicit, audited per-channel switch. Link-local, multicast, unspecified, reserved and cloud metadata addresses are never contacted.
- HTTPS is required unless the address is private. Redirects are never followed, credentials never travel in a URL, and at most 4 KiB of a response is read. Connecting may take 5 seconds and a whole attempt 10 seconds.
- Email uses SMTP over STARTTLS or TLS. Unencrypted SMTP goes only to a relay on the server's own host, with the private switch on.
- Channel secrets (webhook URLs, signing secrets, header values and SMTP passwords) are write-only: encrypted at rest and never returned, logged or audited.

## Consequences

- Receivers on a private network, such as an internal Slack proxy or mail relay, need the switch, which the audit log records.
- Tests cover the refusals before any connection is made (`server/tests/notifications.rs` `every_blocked_address_is_refused_before_connecting`, `private_receivers_need_the_explicit_allow`).
- The policy is enforced at the network layer of this server only. An allowed receiver that forwards what it receives is outside it.
