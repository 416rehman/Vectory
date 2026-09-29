# ADR 0003: Throttle sign-in failures, not sign-ins

Accepted 2026-09-29.

## Context

Sign-in used a fixed window of 8 attempts per email per 5 minutes that counted successful sign-ins, plus
an instance-wide cap of 50 attempts per minute. A team sharing an account locked itself out with the
correct password, anyone who knew an email could keep that account locked, and 51 requests a minute
blocked every sign-in on the instance.

## Decision

- Coarse attempt guards remain only to bound password-hashing work: 600 per minute per instance and 60 per
  minute per client address.
- Lockout counts **failures** only: 10 per account per client address in 15 minutes, and 100 per account
  across all clients in an hour. A successful sign-in clears that client's failure count.
- A client address that signed in to the account within 30 days bypasses the account-wide budget, so an
  attacker elsewhere cannot lock out the account's regular client.
- The client address is the TCP peer, or the last `X-Forwarded-For` hop when
  `VECTORY_TRUST_PROXY_HEADERS=true`. Enable that only when the HTTP listener is reachable solely through
  a trusted reverse proxy, as in the Compose deployment.
- Throttled responses use `SIGNIN_THROTTLED` with the real remaining wait in `Retry-After` and a humane
  message that points to an administrator reset.
- The anonymous limiter tracks up to 32,768 keys (it previously refused everyone after 4,096).

## Consequences

Legitimate users no longer lock themselves out. Distributed guessing remains bounded per account; an
attacker with many addresses can still delay sign-in from new clients for up to an hour, which is the
accepted trade-off for a self-hosted instance with Argon2id and MFA.
