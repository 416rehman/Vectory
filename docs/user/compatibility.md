# Compatibility

Which platforms, Vector versions and browsers Vectory supports today, and what has been tested on each. This release targets **Vector 0.58**: any 0.58.x patch release runs on a device, and the sandbox that validates pipelines on your server runs 0.58.0.

## Devices

Vectory manages an installed Vector; it never installs or upgrades it. Match both the operating system and the CPU when you download the agent.

| Device | Vector 0.58.0 downloads | Status |
| --- | --- | --- |
| **Linux x86-64** | `.deb`, `.rpm`, GNU and musl archives | Works end to end with real Vector 0.58.0: install, enroll, deploy, apply and metrics. Service, reboot and upgrade tests on each distribution are still to come. |
| **Linux Arm64** | `.deb`, `.rpm`, GNU and musl archives | The agent builds for it. Not yet tested on Arm64 hardware. |
| **macOS on Apple silicon** | Archive | The agent builds for it. Install, launchd and apply are not yet tested on a Mac. |
| **Windows x86-64** | MSI and ZIP | Apply, recovery, local secrets, metrics and full-mode features are tested. Service, reboot and upgrade tests are still to come. |
| macOS on Intel | None | Not supported: Vector 0.58.0 has no Intel Mac build. |
| Windows Arm64, 32-bit Arm Linux | Not an agent target | Not supported. |

"The agent builds for it" means we ship a binary but haven't yet proven it on that platform. Use those platforms for trials first.

## Components

The editor knows all 128 production component types of Vector 0.58.0. Whether a device can run one also depends on:

- **Its platform.** For example, `journald` needs Linux and `windows_event_log` needs Windows.
- **Its Vector build**, which must include the component.
- **Its mode.** Restricted devices accept [a reviewed subset](security.md#restricted-and-full-mode).

Checks that need the device itself, such as local files, run on the device before it applies a version. See [Validate, test, publish](pipelines.md#validate-test-publish).

## Server

- **Docker Compose on one Linux host**, with local disk. The images build from source; published images are planned.
- The Compose configuration is checked automatically. A full start on a clean host hasn't yet run in automated tests, so try it on a staging host first.
- One server per data directory. SQLite doesn't support network filesystems or active-active replicas.

## Browsers

The dashboard and this Help center are tested with Chromium on desktop and phone-sized screens, in light and dark themes, with automated accessibility checks. Recent Firefox and Safari aren't tested yet.

## Offline use

The dashboard, API reference, fonts and this Help center, including search, are served by your server with no outside requests. Building the images and downloading Vector need internet access. Links to [vector.dev](https://vector.dev/docs/) need internet access and may describe a newer Vector than 0.58.0.

## References

- [Vector 0.58.0 release notes](https://vector.dev/releases/0.58.0/)
- [Vector configuration reference](https://vector.dev/docs/reference/configuration/)
- [Intel Mac support ended in Vector 0.51](https://vector.dev/highlights/2025-11-04-0-51-0-upgrade-guide/)
