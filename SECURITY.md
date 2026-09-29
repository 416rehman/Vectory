# Security policy

Vectory is pre-release software. No version currently carries a production security-support promise. Before a public release, maintainers must publish a supported-version schedule and response targets.

## Report a vulnerability

Report vulnerabilities privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue or pull request for a vulnerability. If private reporting isn't available, contact a maintainer privately first and share details only once you have a private channel.

Reports should include affected revision, sanitized reproduction, expected versus observed behavior, and potential impact. Never include customer event payloads, keys, passwords or tokens. The [threat model](docs/security/THREAT-MODEL.md) and [acceptance report](docs/internal/ACCEPTANCE.md) describe controls and gaps. Configuration authors can request powerful Vector behavior; device-local policy and OS isolation remain necessary trust boundaries.

This independent project is not a Datadog product and is not endorsed by Datadog or Vector maintainers. Report upstream Vector vulnerabilities through Vector's official security policy.
