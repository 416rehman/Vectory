# ADR 0003: Throttle sign-in failures, not sign-ins

Accepted 2026-09-29. Revised 2026-09-29 after review: failures are reserved before the password check,
the failure ledger has its own bounded memory that never fails open, and IPv6 clients count per /64.
Revised again after review: the request limiter evicts instead of refusing when full, and
unauthenticated agent-listener keys have their own capped partition.

Revised a third time: a client's own budget is charged before the budget every client shares, part
of the shared sign-in budget is reserved for clients that have signed in, the second sign-in step has
the same two budgets, an account's second factor has one budget for both sign-in forms, and a client
is remembered only when a sign-in completes.

## Context

Sign-in used a fixed window of 8 attempts per email per 5 minutes that counted successful sign-ins, plus
an instance-wide cap of 50 attempts per minute. A team sharing an account locked itself out with the
correct password, anyone who knew an email could keep that account locked, and 51 requests a minute
blocked every sign-in on the instance.

The first failure-only version had two gaps. It checked the budget before hashing and recorded the
failure after, so parallel attempts all passed the check (about 6x the intended budget). Its failure
keys shared the anonymous limiter, which stopped recording new keys once full, so a flood of unknown
emails could switch the lockout off.

The two budgets that bound hashing were charged in the wrong order, and a refused call still counted.
One address sending more than the instance's budget kept it spent for every other address: 700 failed
sign-ins from one address made a valid sign-in from another answer `429`, and the same held for the
second sign-in step, password reset, invitations, enrollment and the installer. The combined
password-and-code form returned the failure reservation, and remembered the client, as soon as the
password was right, so a code could be guessed at the per-client rate with no account limit at all.

## Decision

- Coarse attempt guards remain only to bound password-hashing work. A client has 60 attempts a minute,
  charged first. The instance allows 600 a minute, charged only for the attempts a client's own budget
  let through, and a refused call is never counted, so one address cannot spend what the others need.
  100 of the 600 are reserved for clients that have completed a sign-in (to any account, within 30
  days); everyone else shares the other 500. The second step (`POST /login/mfa`) has the same two
  budgets.
- Lockout counts **failures** only: 10 per account per client in 15 minutes, and 100 per account
  across all clients in an hour.
- Each attempt reserves one failure against both budgets before the password is checked, in the same
  step that checks them. A correct password returns the reservation and clears that client's failures,
  so signing in never spends budget and parallel guesses never exceed it.
- A client that signed in to the account within 30 days bypasses the account-wide budget, so an
  attacker elsewhere cannot lock out the account's regular client. A sign-in counts as complete only
  when nothing is left to prove: after the password for an account without a second factor, and after
  the factor for one with it. A password alone neither returns its reservation nor makes the client
  known.
- A second factor has one budget per account, shared by both forms of sign-in: ten attempts in five
  minutes, right or wrong, from any address. A challenge also ends after five wrong codes. The combined
  password-and-code form, kept for existing clients, locks for the account after five wrong codes in
  five minutes and refuses every code, right or wrong, until the window ends. The lock is revealed only
  after the password is verified, so it discloses nothing to someone without it.
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
- The request limiter keeps three partitions of the same bounded ledger: sign-in, browser and account
  keys (32,768); unauthenticated keys outside sign-in, meaning the agent listener's installer, agent
  downloads and enrollment, and invitation previews (32,768); and authenticated devices (40,000). A full
  partition evicts the key whose window ends soonest, so a new key is always counted and never turned
  away. Each unauthenticated namespace has a global per-minute cap behind its per-address key, charged
  only for what the address's own budget let through. A flood from very many addresses can fill that
  partition with its own keys, and it never evicts a sign-in key. (The limiter first refused everyone
  after 4,096 keys, later after 32,768.) Password reset and invitation codes have a per-address budget
  of 30 a minute in front of their shared 300.

## Consequences

Legitimate users no longer lock themselves out. Distributed guessing remains bounded per account; an
attacker with many addresses can still delay sign-in from new clients for up to an hour, which is the
accepted trade-off for a self-hosted instance with Argon2id and MFA. An attempt that fails for a server
error after its reservation counts as a failure.

One address can no longer deny service to the others. An attacker with enough addresses (about ten, at
60 requests a minute each) can still spend the shared budget of enrollment, the installer, password
reset and invitations, which keep no reserve, and the sign-in budget for clients that have never signed
in. Clients that have signed in keep their reserved share. Someone who knows an account's password can
spend its second-factor budget, which pauses the account's second step for up to five minutes at a
time until an administrator resets the password. A password step whose second step never completes
keeps its reservation, so ten of them from one client in 15 minutes pause that client's sign-in to the
account.
