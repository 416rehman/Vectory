# Compatibility and evidence

Initial protocol/catalog target: Vector **0.58.0**, Go **1.26.x** (release automation pins a patch). A build target is not a supported native target. Until the native acceptance suite runs, all untested rows below are release gates.

| Agent build target | Runtime baseline | Vector 0.58 distribution | Native acceptance |
| --- | --- | --- | --- |
| Linux amd64 (`GOAMD64=v1`, CGO disabled) | Go baseline kernel 3.2+; actual Vector/distribution may require newer | GNU and musl upstream archives | Pending oldest/current distro, systemd and supervisor tests |
| Linux arm64 (CGO disabled) | Go baseline does not prove architecture-specific kernel or Vector minimum | GNU and musl upstream archives | Pending physical/native arm64 tests |
| macOS arm64 | Go 1.26: macOS 12+; actual Vector minimum must be validated | Upstream arm64 archive | Pending native install, launchd, upgrade, reboot, apply |
| macOS amd64 | Go 1.26: macOS 12+ | **No current upstream distribution** | Build-only; not supported for pinned Vector 0.58 |
| Windows amd64 | Go: Windows 10 / Server 2016+; actual Vector minimum must be validated | Upstream ZIP and MSI | Current Windows development checks recorded in ACCEPTANCE.md; service/reboot and oldest OS gate pending |
| Windows arm64 / Linux armv7 | Not a release target | Separate distribution compatibility required | No native claim |

Do not retain an obsolete toolchain to advertise obsolete OS support. Foreground/supervisor operation is independent of systemd availability. The agent does not require a shell, Python, Node, a compiler, or Docker for normal operation. Inspection of Linux ELF artifacts for interpreter/dynamic dependencies is a release gate even with `CGO_ENABLED=0`.

Vector observability changed from GraphQL to **gRPC in 0.55.0**. `/graphql` and `/playground` were removed, while `/health` remained. The API does not authenticate clients; keep it loopback/private. Health proves process availability, not the digest of the active pipeline. No pipeline event sampling or tap is enabled by Vectory by default.

Verified official references (2026-09-26): [Go minimums](https://go.dev/wiki/MinimumRequirements), [Vector 0.58 release](https://vector.dev/releases/0.58.0/), [gRPC migration](https://vector.dev/highlights/2026-04-20-0-55-0-upgrade-guide/), [Intel Mac discontinuation](https://vector.dev/highlights/2025-11-04-0-51-0-upgrade-guide/), [API trust boundary](https://vector.dev/docs/reference/api/), [reload mechanisms](https://vector.dev/docs/administration/management/).
