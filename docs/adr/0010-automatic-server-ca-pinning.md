# ADR 0010: Add device pins the server's CA automatically instead of offering a trust choice

Accepted 2026-09-29, with the explicit choice restored (below). Proposed earlier the same day to record what Add device did at commit `a469266` (since `c925c68` and `0e63604`, both 2026-09-29), which departed from the specification.

## Context

The specification (section 4, line 72) asks Add device to explain certificate trust as a choice between system trust and a public CA file, to include the reviewed CA path only when that is chosen, and to generate `--ca-file=` for an explicit system-trust choice. It also asks (line 110) that the agent verify the server before sending a token, through the system trust store or a private CA or fingerprint obtained through a separately trusted channel, and never trust an unknown CA downloaded from the enrollment endpoint.

Until `c925c68`, Add device offered that choice. Operators had to find the server's CA file, copy it to each host and type its path correctly.

## Decision

- When the agent listener's certificate is not publicly trusted, Add device generates `--ca-sha256` with the SHA-256 of the CA that the listener presents, by default. When it is publicly trusted, the default is the host's trusted certificates.
- The fingerprint reaches the operator on the signed-in dashboard page, over the dashboard's own HTTPS connection: that is the separately trusted channel. The page shows the full fingerprint for comparison.
- The agent (`agent/internal/agent/pin.go`) accepts the server only if its presented chain verifies against the pinned CA as the only root, including the host name and validity period, before it sends a token. It then keeps that CA in its state directory as the trust for later connections.
- **The explicit choice is restored**, under **Advanced → How the host checks this server**, in plain words: pin this server's CA (`--ca-sha256`, the default for a private CA), a CA certificate file on the host (`--ca-file PATH`) and the host's trusted certificates (`--ca-file=`, the default for a publicly trusted certificate). A publicly trusted server offers only the last two. Each choice produces exactly its flag, for setup and for the installer, and `enrollment-connection-browser.mjs` asserts the flag each choice produces.
- **The installer download is verified too.** For the pinned choice the command writes the CA certificate the page shows (public, like its fingerprint) to `vectory-ca.pem` and runs `curl --cacert vectory-ca.pem`; for a CA file, `curl --cacert PATH`; for the host's store, plain `curl`. No generated command, and nothing in the installer, uses `-k`, `--insecure` or `--no-check-certificate` (unit and server tests assert it). curl's `--pinnedpubkey` was tested and can't replace the CA check: curl still refuses an unknown CA unless `-k` turns verification off, so the command carries the CA certificate instead.

## Why restore the choice

Restoring it costs the default flow nothing: the pin stays the default, the page still needs nothing copied to the host, and the choice sits under **Advanced**. It gives back what the specification asks for (line 72: system trust, a public CA file, `--ca-file=`) to operators who distribute their own CA or use a public certificate, and it is honest about which flag the command carries. Pinning remains within line 110, since the fingerprint comes from the authenticated dashboard.

## Consequences

- Enrollment needs no file copied to the host by default, and a mistyped path can't break the default flow.
- The generated commands carry the CA certificate for the download; the command stays one paste in any POSIX shell (sh, dash, bash and zsh).
- The historical acceptance records described the old choice until 2026-09-29; the current behavior is described in `docs/user/installation.md` (Trust the server certificate).
- The specification needs no amendment for this decision; its author may still choose to name the pinned default in section 4.
