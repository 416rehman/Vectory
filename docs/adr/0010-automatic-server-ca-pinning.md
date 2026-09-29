# ADR 0010: Add device pins the server's CA automatically instead of offering a trust choice

Proposed 2026-09-29. This records what Add device does at commit `a469266` (since `c925c68` and `0e63604`, both 2026-09-29). It departs from the specification, so it needs an owner decision: accept it and amend the specification, or restore the explicit choice described below.

## Context

The specification (section 4, line 72) asks Add device to explain certificate trust as a choice between system trust and a public CA file, to include the reviewed CA path only when that is chosen, and to generate `--ca-file=` for an explicit system-trust choice. It also asks (line 110) that the agent verify the server before sending a token, through the system trust store or a private CA or fingerprint obtained through a separately trusted channel, and never trust an unknown CA downloaded from the enrollment endpoint.

Until `c925c68`, Add device offered that choice. Operators had to find the server's CA file, copy it to each host and type its path correctly.

## Decision

- When the agent listener's certificate is not publicly trusted, Add device generates `--ca-sha256` with the SHA-256 of the CA that the listener presents (`trustFor` in `dashboard/src/enrollmentCommands.ts`). When it is publicly trusted, the command uses system trust and passes no trust option. It never generates `--ca-file`.
- The fingerprint reaches the operator on the signed-in dashboard page, over the dashboard's own HTTPS connection: that is the separately trusted channel. The page shows the full fingerprint for comparison.
- The agent (`agent/internal/agent/pin.go`) accepts the server only if its presented chain verifies against the pinned CA as the only root, including the host name and validity period, before it sends a token. It then keeps that CA in its state directory as the trust for later connections.
- The agent still accepts `--ca-file PATH`, and `--ca-file=` for system trust, for operators who type the command themselves.

## Consequences

- Enrollment needs no file copied to the host, and a mistyped path can no longer break it.
- The generated commands no longer offer the choice or the `--ca-file=` form the specification describes, and the historical acceptance records described the old choice until 2026-09-29.
- The installer download is a separate step: for a private CA the generated `curl` command skips certificate verification (`-k`) and relies on the SHA-256 shown on the page. That violates the specification's no-insecure-fallback rule; replacing it is tracked separately.

## The option to restore the choice

Add device could offer three explicit choices, each producing its exact flag: pin the presented CA (`--ca-sha256`, the default for a private CA), system trust (`--ca-file=`) and a CA file on the device (`--ca-file PATH`), disabled while a token is being created. A browser test would then assert the flag each choice produces. Which way to go is an owner decision; this record does not make it.
