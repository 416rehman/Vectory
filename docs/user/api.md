# API reference

The interactive reference is generated from this release's actual OpenAPI contract and rendered locally with [Scalar](https://scalar.com/). Its search, schemas and examples are available without a third-party CDN. Use it when integrating with Vectory programmatically. For platform tasks, start with the [help center](/help/).

## Dashboard requests

The dashboard API lives at `/api/v1`. Sign in to this Vectory instance first. The interactive reference uses the same-origin session cookie and obtains the session's `X-CSRF-Token` for mutations. Requests run as your current user and can change real data. The server's normal role checks still apply.

The reference does not store credentials in local storage or send requests through a hosted proxy. Request execution is limited to this instance's dashboard API; editing a server URL cannot forward your cookie or CSRF token elsewhere.

For your own client, send email and password to `POST /api/v1/login`. An account with MFA receives `{mfa_required:true,challenge_token,expires_at}` without a session. Complete that challenge with `POST /api/v1/login/mfa`, passing `challenge_token` and either `totp_code` or `recovery_code`. Keep the returned session cookie in a protected cookie store, and use the returned `csrf_token` as `X-CSRF-Token` on mutations. `GET /api/v1/session` returns the current user and token. Do not use an agent enrollment token as a dashboard API credential.

Changing your password with `POST /api/v1/account/password` rotates the session cookie and CSRF token. Retain both values from the successful response before making another mutation; other sessions are revoked. The browser dashboard refreshes other tabs belonging to the same account without reloading their drafts.

Public `POST /api/v1/password-reset` consumes an administrator-issued code and revokes existing sessions. It does not sign the person in or change MFA. Sign in normally afterward. Use the [account administration guide](#/docs/administer#help-someone-reset-a-forgotten-password) for the complete platform workflow.

## Agent requests

The `/agent/v1` protocol runs on the separately configured HTTPS agent listener, commonly port 8443. Enrollment verifies the server and exchanges a local CSR for device credentials; heartbeats, renewal and artifact downloads use registered mTLS identity.

The **Agent protocol** reference is read-only in the browser. Browser session cookies do not provide a device certificate or agent-listener trust. Use the agent CLI for enrollment and normal device operation rather than copying its private credentials into a web client.

## Errors and safe retries

Errors have an `error` object with a code and safe message. `401` means authentication is required; `403` means the action is forbidden or a mutation lacks valid CSRF; `409` means a conflict or stale revision needs review; `429` means rate limiting. Do not blindly retry a mutation after an uncertain response. Re-read the affected resource or use the operation's documented idempotency mechanism.

An incorrect current password or authenticator code during an authenticated account change returns `403` with `WRONG_PASSWORD` or `INVALID_MFA_CODE`. These errors do not end an otherwise valid session. Invalid login or password-reset credentials return `401`.

During login verification, `401 INVALID_MFA_CODE` means the code was rejected; the same challenge can be retried. `401 MFA_CHALLENGE_EXPIRED` means a new email-and-password sign-in is required. Challenges expire after five minutes and allow five code attempts. Completing one, starting another sign-in for the same account, or changing account credentials invalidates the previous challenge.

Draft updates include the expected revision. Deployment confirmation includes the reviewed device IDs. Those checks prevent one editor or a changing target set from silently overwriting another decision.
