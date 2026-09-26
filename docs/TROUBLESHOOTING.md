# Troubleshooting

| Symptom | Check and next action |
| --- | --- |
| Dashboard certificate error | Correct server chain, SAN, clock and trusted CA. Do not bypass verification. |
| Bootstrap rejected | Read the independently provisioned secret privately; inspect `/api/v1/status` for initialized state. No public reset exists. |
| Agent cannot enroll | Port 8443 reachability, TLS trust/hostname, token expiry/use limit/name scope and unique name. Token failures intentionally avoid useful unauthenticated detail. |
| Agent enrolled but unmanaged | Enrollment does not assign pipelines. An authorized operator must explicitly target the device/group. |
| Artifact download rejected | Certificate may be revoked, or digest is not currently released to this device. Never retry using an enrollment token. |
| Verification unknown | File write/reload happened without evidence for exact active configuration. Inspect the adopted process and activation mechanism; do not treat health alone as success. |
| Drift after a manual edit | Reconciliation restores the assigned digest when sync is enabled. Use durable local pause before authorized manual maintenance. |
| Remote resume does not resume | Local emergency pause remains authoritative; clear it locally after reviewing safety. |
| Canary does not advance | Unknown/offline/failed targets cannot pass. Check exact verified generation, observation window, failure threshold and batch gate. |
| Old backup gives stale generation | Preserve agent state and follow BACKUP-RESTORE; agent anti-rollback is working. |
| Compose cannot read secrets | UID/GID 10001 needs read permission. Compose bind-backed secrets preserve host ownership/modes. Do not make keys world-readable. |
| SQLite busy or large WAL | Confirm one server, local disk, no long readers or filesystem stalls; inspect real latency/load before raising connection count. |
| No available downloads | Build/mirror verified artifacts and catalog into the local release directory. The product deliberately never advertises missing files. |
| Local secret rejected | Check exact supported auth-field reference, local name binding, actual service identity, private file owner/ACL, no links, UTF-8 and size limits. Never paste the secret into diagnostics. |
| Secret rotation failed at the same generation | A new effective attempt has a higher local revision; failure preserves the prior verified workload. Correct the protected local value and let the next authorized poll validate a different effective digest. |
| Missing CPU/RSS or component metric | Missing values mean unavailable. The Windows Vector exporter does not expose all process metrics; only observed allowlisted series are reported. |

Gather versions, timestamps, sanitized error codes and stage transitions. Do not attach tokens, credentials, private keys, raw pipeline secrets or customer event payloads to issue reports. Revocation and credential failures should leave the current last-known-good workload running.
