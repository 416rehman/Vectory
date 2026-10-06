# Security policy

Vectory 0.1 is a developer preview. It carries no production security-support promise: run it where a defect in a control plane would not hurt you, and read the [known limits](docs/user/whats-new.md#known-limits) and the [open findings](docs/security/OPEN-FINDINGS.md) first.

The server can receive redacted Vector diagnostics containing event-derived text. A check on a full-mode device can run native providers and `exec` secret backends during validation. The [security model](docs/user/security.md) explains these limits and the host's trust boundary.

## Supported versions

| Version | Security fixes |
| --- | --- |
| 0.1.x (developer preview) | The latest 0.1 release only |
| Earlier development builds | None |

Response targets, best effort for a volunteer project: acknowledge a private report within 7 days, give a first assessment within 14 days, and fix or mitigate critical and high issues in the next patch release. Reporters who want credit get it in the changelog.

## Report a vulnerability

Report vulnerabilities privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue or pull request for a vulnerability. If private reporting isn't available, contact a maintainer privately first and share details only once you have a private channel.

Reports should include affected revision, sanitized reproduction, expected versus observed behavior, and potential impact. Never include customer event payloads, keys, passwords or tokens. The [threat model](docs/security/THREAT-MODEL.md) describes the controls and trust boundaries, and the [security review](docs/security/SECURITY-REVIEW.md) records what independent review found and each finding's current disposition. The [requirements checklist](docs/internal/REQUIREMENTS.md) shows which security requirements are tested, and how. Configuration authors can request powerful Vector behavior; device-local policy and OS isolation remain necessary trust boundaries.

This independent project is not a Datadog product and is not endorsed by Datadog or Vector maintainers. Report upstream Vector vulnerabilities through Vector's official security policy.
