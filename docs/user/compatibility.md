# Compatibility

Which platforms, Vector versions and browsers Vectory supports today, what each needs at a minimum, and what has been tested on each. This release targets **Vector 0.58**: devices accept any 0.58.x release, the automated tests use 0.58.0, and the validator on your server runs 0.58.0.

## Devices

Vectory manages an installed Vector; it never installs or upgrades it. Match both the operating system and the CPU when you download the agent.

| Device | Vector 0.58.0 downloads | Status |
| --- | --- | --- |
| **Linux x86-64** | `.deb`, `.rpm`, GNU and musl archives | Agent tests with real Vector 0.58.0 run on every change. The full loop (install, enroll, deploy, apply and metrics) works end to end in the local demo fleet. Service, reboot and upgrade tests on each distribution are still to come. |
| **Linux Arm64** | `.deb`, `.rpm`, GNU and musl archives | The agent builds for it. Not yet tested on Arm64 hardware. |
| **macOS on Apple silicon** | Archive | Apply and rollback are tested on every change on macOS 15 with real Vector 0.58.0. Install, launchd and upgrade are not yet tested on a Mac. |
| **Windows x86-64** | MSI and ZIP | Apply, recovery, local secrets, metrics and full-mode features are tested on every change on Windows Server 2025. Service, reboot and upgrade tests are still to come. |
| macOS on Intel | None | Not supported: Vector 0.58.0 has no Intel Mac build. |
| Windows Arm64, 32-bit Arm Linux | Not an agent target | Not supported. |

"The agent builds for it" means we ship a binary but haven't yet proven it on that platform. Use those platforms for trials first.

## Minimums

What each part needs, where that is established. "Not yet established" means nothing proves a lower bound yet, so start with the versions under [Tested on](#tested-on).

| Requirement | Minimum | Where it comes from |
| --- | --- | --- |
| macOS | macOS 12 | The agent declares macOS 12.0 as its minimum; Go 1.26.8 sets it. Only macOS 15 is tested. |
| Linux kernel | Not yet established | The agent binary declares none. Go 1.26's published minimum plus a test on an older kernel would establish it. |
| Linux C library | None | The agent is a static binary with no dynamic loader or shared libraries. |
| Windows | Not yet established | Go 1.26's published minimum plus a test on an older Windows would establish it. Only Windows Server 2025 is tested. |
| x86-64 CPU | x86-64-v1 | Agents are built with `GOAMD64=v1`, the baseline instruction set. |
| Arm64 CPU | ARMv8.0 | Agents use Go's default, `GOARM64=v8.0`. |
| Vector on a device | 0.58.0 | Any 0.58.x release is accepted; pre-releases are refused. Vector's own OS requirements aren't recorded here yet: check the [Vector 0.58.0 release notes](https://vector.dev/releases/0.58.0/). |
| Server host | Not yet established | Docker Compose on one Linux host. CI starts the stack on a clean Ubuntu 24.04 runner with the Docker Engine and Compose plugin that runner provides; older versions aren't tested. |
| Browser | Not yet established | Only Chromium is tested (see [Browsers](#browsers)). |
| Build the agent from source | Go 1.26.0 | Declared in `agent/go.mod`; builds and tests use Go 1.26.8. |
| Build the server from source | Rust 1.88 | Declared as `rust-version` in `server/Cargo.toml`; builds and tests use Rust 1.94.0. |
| Build the dashboard from source | Not yet established | No `engines` field is declared; builds and tests use Node 22. |

## Tested on

Every change runs the same automated checks on GitHub-hosted runners. They prove what this table lists, and nothing more.

| Runner | Versions | What passes | Not covered |
| --- | --- | --- | --- |
| Ubuntu 24.04 | Vector 0.58.0, Go 1.26.8, Rust 1.94.0, Node 22, Chromium from Playwright 1.63.0 | Server, dashboard and agent unit tests. The agent's native tests with real Vector: validate, apply, reload, drift repair, rollback, metrics, device secrets and full mode. The server's validator tests with real Vector. An adversarial TLS and protocol suite against a running server. Browser checks of the dashboard and this Help center. Both container images build. | Installing under systemd, reboot, upgrade, starting Compose, Linux on Arm64 |
| Windows Server 2025 | Vector 0.58.0, Go 1.26.8 | The agent's unit and native tests with real Vector. Windows restarts Vector instead of reloading it. | The Windows service, the MSI, reboot, upgrade |
| macOS 15 on Apple silicon | Vector 0.58.0, Go 1.26.8 | The agent's unit and native tests with real Vector, including reload and rollback. | The package, launchd, reboot, upgrade |

Nothing tests the oldest versions of an operating system yet.

## Components

The editor knows all 128 production component types of Vector 0.58.0. Whether a device can run one also depends on:

- **Its platform.** For example, `journald` needs Linux and `windows_event_log` needs Windows.
- **Its Vector build**, which must include the component.
- **Its mode.** Restricted devices accept [a reviewed subset](security.md#restricted-and-full-mode).

Checks that need the device itself, such as local files, run on the device before it applies a version. See [Validate, test, publish](pipelines.md#validate-test-publish).

## Server

- **Docker Compose on one Linux host**, with local disk. The images build from source; published images are planned.
- CI follows the install guide on a clean runner: it builds both images, starts the stack, waits until every service is healthy, creates the first administrator, enrolls a device with the Add device installer and checks that the validator can't reach the network. A customer's host, a public certificate and your network aren't covered, so try it on a staging host first.
- One server per data directory. SQLite doesn't support network filesystems or active-active replicas.

## Browsers

The dashboard and this Help center are tested with Chromium on desktop and phone-sized screens, in light and dark themes, with automated accessibility checks. Recent Firefox and Safari aren't tested yet.

## Offline use

The dashboard, API reference, fonts and this Help center, including search, are served by your server with no outside requests. Building the images and downloading Vector need internet access. Links to [vector.dev](https://vector.dev/docs/) need internet access and may describe a newer Vector than 0.58.0.

## References

- [Vector 0.58.0 release notes](https://vector.dev/releases/0.58.0/)
- [Vector configuration reference](https://vector.dev/docs/reference/configuration/)
- [Intel Mac support ended in Vector 0.51](https://vector.dev/highlights/2025-11-04-0-51-0-upgrade-guide/)
- [Go minimum requirements](https://go.dev/wiki/MinimumRequirements)
