# ADR 0003: Throttle sign-in failures, not sign-ins

Accepted 2026-09-29. Revised 2026-09-29 after review: failures are reserved before the password check,
the failure ledger has its own bounded memory that never fails open, and IPv6 clients count per /64.

## Context

Sign-in used a fixed window of 8 attempts per email per 5 minutes that counted successful sign-ins, plus
an instance-wide cap of 50 attempts per minute. A team sharing an account locked itself out with the
correct password, anyone who knew an email could keep that account locked, and 51 requests a minute
blocked every sign-in on the instance.

The first failure-only version had two gaps. It checked the budget before hashing and recorded the
failure after, so parallel attempts all passed the check (about 6x the intended budget). Its failure
keys shared the anonymous limiter, which stopped recording new keys once full, so a flood of unknown
emails could switch the lockout off.

## Decision

- Coarse attempt guards remain only to bound password-hashing work: 600 per minute per instance and 60 per
  minute per client.
- Lockout counts **failures** only: 10 per account per client in 15 minutes, and 100 per account
  across all clients in an hour.
- Each attempt reserves one failure against both budgets before the password is checked, in the same
  step that checks them. A correct password returns the reservation and clears that client's failures,
  so signing in never spends budget and parallel guesses never exceed it.
- A client that signed in to the account within 30 days bypasses the account-wide budget, so an
  attacker elsewhere cannot lock out the account's regular client.
- Failure counts, known clients and throttle-audit markers live in their own ledger of up to 65,536
  entries. When it is full it evicts the entry that expires soonest; it never declines to record a
  failure and never turns a sign-in away. At the 600-per-minute cap about 45,000 failure entries can be
  live, so nothing live is evicted in practice.
- The client is the TCP peer, or the last `X-Forwarded-For` hop when `VECTORY_TRUST_PROXY_HEADERS=true`.
  Enable that only when the HTTP listener is reachable solely through a trusted reverse proxy, as in the
  Compose deployment. Throttles count IPv6 clients per /64 prefix, since one host usually holds a whole
  /64; IPv4 and IPv4-mapped addresses count individually. Audit records keep the full address.
- Throttled responses use `SIGNIN_THROTTLED` with the real remaining wait in `Retry-After` and a humane
  message that points to an administrator reset.
- The anonymous request limiter tracks up to 32,768 keys (it previously refused everyone after 4,096).

## Consequences

Legitimate users no longer lock themselves out. Distributed guessing remains bounded per account; an
attacker with many addresses can still delay sign-in from new clients for up to an hour, which is the
accepted trade-off for a self-hosted instance with Argon2id and MFA. An attempt that fails for a server
error after its reservation counts as a failure.
