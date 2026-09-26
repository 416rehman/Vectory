# Security policy

Vectory is pre-release software. No version currently carries a production security-support promise. Before a public release, maintainers must publish a supported-version schedule, a private reporting destination and response targets. Until a verified private channel exists, do not post exploitable details or real secrets in public issues; contact the repository owner through an independently verified channel.

Reports should include affected revision, sanitized reproduction, expected versus observed behavior, and potential impact. Never include customer event payloads, keys, passwords or tokens. The [threat model](docs/THREAT-MODEL.md) and [acceptance report](docs/ACCEPTANCE.md) describe controls and gaps. Configuration authors can request powerful Vector behavior; device-local policy and OS isolation remain necessary trust boundaries.

This independent project is not a Datadog product and is not endorsed by Datadog or Vector maintainers. Report upstream Vector vulnerabilities through Vector's official security policy.
