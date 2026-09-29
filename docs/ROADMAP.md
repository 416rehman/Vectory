# Roadmap

Where Vectory is heading. Order reflects priority, not promised dates. To discuss an item, open an issue.

## Now: 0.1 developer preview

The full loop (build, publish, canary, apply and roll back) runs against real Vector 0.58.0 agents in the local demo on Linux. See [What's new](user/whats-new.md).

Shipped from earlier versions of this list: starter pipelines such as syslog to Loki and files to Amazon S3, live events per second on the pipeline canvas, and canary gates that also check delivery, such as sink errors and full buffers.

## Next

- **Published images and packages.** Pull-and-run server images, and agent packages for apt, rpm, Homebrew and MSI, so trying Vectory takes one `docker compose up`.
- **Signed releases.** Signed checksums for every download, verified by the server before it offers an agent.
- **API tokens.** Scoped, revocable tokens for automation, instead of session cookies.
- **Guided adoption.** `vectory adopt` hands a running Vector to the agent with a plan, validation and automatic rollback.
- **Container and Kubernetes devices.** An agent image that manages Vector in the same container, and a Helm chart.

## Later

- Single sign-on with OIDC.
- Configuration drift and version reports across the fleet.

## Before 1.0

These gates must pass before Vectory calls itself production-ready:

- Service, reboot and upgrade tests on every supported operating system, including the oldest supported versions.
- Privileged account and access-control checks on each platform.
- Container start and validator isolation tested on a clean host. CI builds both images but doesn't start them.
- Reproducible builds from independent builders, signed packages and an approved distribution namespace.
- Key rotation and disaster-recovery drills.
- Sustained load with real agents on dedicated hosts, and outage and fault exercises.
- Hardening: a separate account for Vector processes, process-level telemetry, and macOS helper cleanup after forced termination.
