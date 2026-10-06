# Compatibility

Which platforms, Vector versions and browsers Vectory supports today, what each needs at a minimum, and what has been tested on each. This release targets **Vector 0.58**: devices accept any 0.58.x release, the automated tests use 0.58.0, and the validator on your server runs 0.58.0.

## Server installation choices

| Host and method | What runs | Requirements |
| --- | --- | --- |
| Linux with Docker | Signed prebuilt Linux x86-64 containers | Docker Engine, Compose and local Docker storage. |
| Windows with Docker Desktop | The same Linux x86-64 containers | A Windows version supported by Docker Desktop, its Linux container engine and PowerShell 5.1 or later. This is not a native Windows server executable. |
| Intel Mac with Docker Desktop | The same Linux x86-64 containers | Docker Desktop and macOS's system Bash. No Homebrew toolchain is required. |
| Apple silicon with Docker Desktop | Linux x86-64 containers under amd64 emulation | Explicit emulation consent and a Docker backend that executes amd64 images. No native Arm server image is supplied. |
| Native Linux without Docker | Prebuilt server, proxy and an isolated systemd validator | Linux x86-64 booted with systemd 252 or later, unified cgroup v2 and local storage. The kit carries its own executable runtime libraries; it targets Ubuntu 24.04. |

The desktop fixture tests check consent, platform selection, checksum and signature-refusal handling, certificate setup recovery, private file access and retained configuration. They do not stand in for running Docker Desktop on physical Apple hardware. Docker Desktop's own supported OS requirements still apply. A server installed on a sleeping or stopped desktop is unavailable until that computer and Docker resume.

## Devices

Vectory manages an installed Vector; it never installs or upgrades it. Match both the operating system and the CPU when you download the agent.

| Device | Vector 0.58.0 downloads | Status |
| --- | --- | --- |
| **Linux x86-64** | `.deb`, `.rpm`, GNU and musl archives | Agent tests with real Vector 0.58.0 run on every change. The full loop (install, enroll, deploy, apply and metrics) works end to end in the local demo fleet. A service test on Ubuntu 24.04 (systemd, the generated and the packaged unit) runs on demand, and so does an agent update through a rollout, with the update step as a systemd service of its own; reboot tests, an upgrade from an earlier release and other distributions are still to come. |
| **Linux Arm64** | `.deb`, `.rpm`, GNU and musl archives | The agent builds for it. Not yet tested on Arm64 hardware. |
| **macOS on Apple silicon** | Archive | Apply and rollback are tested on every change on macOS 15 with real Vector 0.58.0. A launchd test on macOS 15 runs on demand, and so does an agent update through a rollout, with the update step as a launch daemon of its own; an upgrade from an earlier release is not tested. |
| **Windows x86-64** | MSI and ZIP | Apply, recovery, local secrets, metrics and full-mode features are tested on every change on Windows Server 2025. A test of the Windows service runs on demand, and so does an agent update through a rollout, with the update step as a service of its own; reboot tests and an upgrade from an earlier release are still to come. |
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
| Browser | Not yet established | Chromium is tested on every change; Firefox and WebKit run four first-use flows on demand (see [Browsers](#browsers)). |

The prebuilt server images and local evaluation kit are Linux x86-64. Normal installation needs no Rust, Go, Node or compiler. The Docker Desktop bootstrap runs those same signed images and original Compose templates on Windows or macOS. Apple silicon uses explicit amd64 emulation; there is no native Arm server image. Toolchain versions below describe how CI builds and tests the release; contributors can find source-build requirements in [CONTRIBUTING.md](https://github.com/416rehman/Vectory/blob/main/CONTRIBUTING.md).

## Tested on

Every change runs the same automated checks on GitHub-hosted runners. They prove what this table lists, and nothing more.

| Runner | Versions | What passes | Not covered |
| --- | --- | --- | --- |
| Ubuntu 24.04 | Vector 0.58.0, Go 1.26.8, Rust 1.94.0, Node 22, Chromium from Playwright 1.63.0 | Server, dashboard and agent unit tests. The agent's native tests with real Vector: validate, apply, reload, drift repair, rollback, metrics, device secrets and full mode. The server's validator tests with real Vector. An adversarial TLS and protocol suite against a running server. Browser checks of the dashboard and this Help center. Both container images build. | Installing under systemd, reboot, upgrade, starting Compose, Linux on Arm64 |
| Windows Server 2025 | Vector 0.58.0, Go 1.26.8 | The agent's unit and native tests with real Vector. Windows restarts Vector instead of reloading it. | The Windows service, the MSI, reboot, upgrade |
| macOS 15 on Apple silicon | Vector 0.58.0, Go 1.26.8 | The agent's unit and native tests with real Vector, including reload and rollback. | The package, launchd, reboot, upgrade |

Nothing tests the oldest versions of an operating system yet.

### On demand

A second workflow, `platforms`, runs when someone starts it and when its own scripts change, not on every change. On a clean runner of each kind it runs the real server and the pinned Vector 0.58.0, and its results are kept as downloadable evidence.

| Runner | What it runs | Not covered |
| --- | --- | --- |
| Ubuntu 24.04 | Installs the agent as a systemd service for an unprivileged account with `vectory setup`, applies a pipeline through it, then restarts, kills and stops the service and removes it. Reads the unit's sandbox from inside the running service, for the unit setup registers and for the packaged unit. Then updates the agent from one build to the next through a rollout, with the update step as root under its own sandboxed unit; takes back a build that doesn't start and one that never checks in; and refuses what a hostile server offers. | Other distributions, reboot, an upgrade from an earlier release, installing the `.deb` or `.rpm`, SELinux and AppArmor, a power cut |
| Windows Server 2025 | Runs the server natively, then the agent in the foreground and as the Windows service: restart, kill, stop, start and removal. Then updates the agent through a rollout with the update step as a second service, `VectoryUpdate`; takes back a build that doesn't start and one that never checks in; recovers when the step is ended between the two renames of its swap; and refuses what a hostile server offers. | An administrator editing the managed file while the service runs, reboot, an upgrade from an earlier release, the MSI, a power cut |
| macOS 15 on Apple silicon | Runs `scripts/preview.sh` and the installer with macOS's own shell and tools, then the agent as a launch daemon: restart, kill, stop, start and removal. Then updates the agent through a rollout with the update step as a launch daemon of its own; takes back a build that doesn't start and one that never checks in; and refuses what a hostile server offers. | Reboot, an upgrade from an earlier release, the package, a power cut |
| Ubuntu 24.04 with Firefox and WebKit | Creates the first administrator, signs in, creates and publishes a pipeline and opens Devices, in each browser. | Everything else the Chromium checks cover |

## Components

The editor knows all 128 production component types of Vector 0.58.0. Whether a device can run one also depends on:

- **Its platform.** For example, `journald` needs Linux and `windows_event_log` needs Windows.
- **Its Vector build**, which must include the component.
- **Its mode.** Restricted devices accept [a reviewed subset](security.md#restricted-and-full-mode).

Checks that need the device itself, such as local files, run on the device before it applies a version. See [Validate, test, publish](pipelines.md#validate-test-publish).

## Server

- **Prebuilt Linux x86-64 images**, with Docker Engine or Docker Desktop, Compose and local Docker storage. Linux uses the signed starter directly. Windows uses the HTTPS-delivered PowerShell bootstrap; macOS uses the portable Bash bootstrap. Both authenticate the unchanged kit and image manifests before using its Compose templates. No compiler or source build is needed.
- **Apple silicon requires amd64 emulation**, explicitly selected in the bootstrap and every service's platform. This is not a native Arm server release.
- **The native Linux kit needs systemd and cgroup v2**. Its server and proxy are separate from the validator, which uses a private Unix socket and an independent filesystem and network sandbox. Installing it does not install or update Vector on your managed devices.
- On every change, CI builds the server stack from source on a clean Ubuntu 24.04 runner, starts it, waits for healthy services, creates the first administrator, enrolls a device with the Add device installer and checks validator isolation. Release gates also test the prebuilt kits, HTTPS and HTTP/2, certificate retention, and a manager upgrade from 0.1.1 with real validation and retained identity. A customer's public DNS, certificate issuance and network still need their own checks.
- One server per data directory. SQLite doesn't support network filesystems or active-active replicas.

## Browsers

The dashboard and this Help center are tested with Chromium on desktop and phone-sized screens, in light and dark themes, with automated accessibility checks. Firefox and WebKit run four first-use flows on demand, against a real server: creating the first administrator, signing in, creating and publishing a pipeline, and opening Devices. Every other check runs in Chromium only. Safari itself isn't tested (WebKit is its engine, not the browser), and neither are older versions of any browser.

## Offline use

The dashboard, API reference, fonts and this Help center, including search, are served by your server with no outside requests. Docker's first online start verifies and pulls images from GHCR. For a first offline installation, use the Linux Docker kit's [prepare-offline.sh](install-server.md#offline-installation) on a connected machine and transfer its complete kit, cache and verification material through your trusted channel. Its previously verified Linux starter can restart with `VECTORY_OFFLINE=true` and retained cache and images. The desktop bootstrap verifies signatures and pulls images online when starting; the native bootstrap needs online authentication for first installation. Public HTTPS renewal needs internet access; offline servers use custom certificates. Devices need an existing supported Vector installation, which can be supplied offline. Links to [vector.dev](https://vector.dev/docs/) may describe a newer Vector than 0.58.0.

## References

- [Vector 0.58.0 release notes](https://vector.dev/releases/0.58.0/)
- [Vector configuration reference](https://vector.dev/docs/reference/configuration/)
- [Intel Mac support ended in Vector 0.51](https://vector.dev/highlights/2025-11-04-0-51-0-upgrade-guide/)
- [Go minimum requirements](https://go.dev/wiki/MinimumRequirements)
