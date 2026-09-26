# Threat model and risk decisions

Scope: single-instance self-hosted control plane, browser administrators, reusable enrollment tokens, outbound agents, locally managed Vector. This is an implementation checklist; passing evidence belongs in ACCEPTANCE.md, not in this document.

Assets include control-plane signing/device-CA and MFA sealing keys, sessions, enrollment verifiers, agent identity keys, immutable reference templates, device-local secret files, rendered managed/recovery configurations, generation/revision counters, and group membership. Pipeline event payloads are not telemetry.

| Boundary / attacker | Required control | Failure behavior / acceptance probe |
| --- | --- | --- |
| Network attacker at bootstrap | HTTPS verified before sending token, independently provisioned server CA, TLS 1.3 | Wrong CA/hostname fails without token disclosure; no automatic CA fetch/trust |
| Reusable token thief | Random verifier-only tokens; expiry, revoke, usage/prefix limits; unmanaged enrollment | Valid token cannot select groups/production access; duplicate-name transaction admits one identity |
| Unauthenticated browser | Locally supplied one-time bootstrap secret; password hash; generic auth errors; rate/size bounds | No fleet/name enumeration or public default administrator |
| Cross-site request / stolen cookie | HttpOnly Secure SameSite=Strict session, CSRF token, role check on every mutation | Missing/mismatched CSRF and viewer mutation fail |
| Enrolled hostile device | Dedicated CA plus active certificate registration on every request | Spoofed certificate headers have no effect; revoked pooled connection cannot heartbeat/download |
| Manifest or artifact replay | Ed25519 exact bytes, device UUID, fresh request nonce, expiry, persisted generation/digest binding | Wrong recipient, reordered/same-generation changed content, bad digest/signature fail |
| Malicious pipeline author | Configuration treated as code; bounded local capability allowlist; no shell; immutable sole managed path | Exec, secret command providers, arbitrary roots/endpoints denied before validation/apply |
| Compromised local low-privilege process | Restrictive state ACL/permissions, path/reparse checks, fixed executable/service | Symlink/path escape rejected; identity inaccessible to unrelated users |
| Local credential file substitution | Typed field references only, operator bindings, pinned no-follow handles, owner/ACL/single-link checks, effective-policy revalidation | Symlink/hardlink/broad ACL rejected; secret values excluded from diagnostics, heartbeat and template exports |
| Crash / disk exhaustion | Journal, staged validation, flush + atomic replacement, retained last-known-good | Each boundary recovers a whole file; uncertain activation never becomes verified |
| Hostile telemetry / large fleet | Bounded request, metrics, queues, retention; sanitized diagnostics | Resource bounds and drop counters; no config/secrets in diagnostics |
| Backup theft / old restore | Backup contains required keys and consistent SQLite snapshot; restricted encrypted storage | Restore preserves trust but cannot lower agent generation floors |
| Supply-chain attacker | Lockfiles, checksum catalog, SBOM, provenance and real signing gates | Missing artifact omitted; unsigned development outputs explicitly labeled |

Consequential decisions:

1. Browser TLS terminates at a private reverse proxy. The HTTP API must not be host-exposed. Agent TLS terminates in Rust; no forwarded-header authentication is trusted. Enrollment is the only agent operation without a device certificate.
2. The server does not execute untrusted Vector configuration with production credentials. Structural checks may be available while real isolated validation is unavailable; results must preserve this distinction.
3. A compromised authorized operator can change pipelines within device-local policy. Enrollment does not establish hardware identity. Approving devices and privileged group membership remains a deployment-capable operation.
4. A compromised machine administrator can access its local keys and configuration; remote protocol checks cannot protect against that administrator. Agent control never offers arbitrary command execution.
5. Exact activation requires evidence for the specific applied configuration. File write, reload request, and a generic healthy old process are insufficient. Unknown verification remains visible and blocks canary success.
6. This version's release cannot claim OS, restart, MSI, signed repository, capacity, or isolated validation gates without measured evidence. Missing credentials and machines are recorded individually.
7. Secret references are restricted to known sink authentication fields. Rendered files necessarily hold plaintext for Vector and share its current OS principal; stronger isolation from a compromised Vector child remains a gate. Template/effective hashes identify revisions and do not conceal weak secrets against guessing.

Review actual implementation against every row. Outstanding defects must remain visible; this document is not security certification.
