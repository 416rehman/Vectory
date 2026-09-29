# Compatibility and release evidence

This help center describes the Vectory development release targeting **Vector 0.58.0**. Install Vector separately; the agent adopts a fixed local executable and does not install or upgrade it. Match both the operating system and CPU architecture when choosing an agent download.

## Choose a platform

| Device target                | Vector 0.58.0 distribution             | Current Vectory evidence                                                                                                                                                              |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows amd64                | Upstream ZIP and MSI                   | Native development tests cover configuration application, recovery and full-mode features. Service installation, reboot, upgrade and oldest-supported-Windows acceptance remain open. |
| Linux amd64                  | Upstream GNU and musl archives         | Agent cross-build exists. Native distribution, service and supervisor acceptance remain open.                                                                                         |
| Linux arm64                  | Upstream GNU and musl archives         | Agent cross-build exists. Native arm64 acceptance remains open.                                                                                                                       |
| macOS arm64                  | Upstream archive                       | Agent cross-build exists. Native installation, launchd, reboot, upgrade and apply acceptance remain open.                                                                             |
| macOS amd64 / Intel Mac      | No upstream Vector 0.58.0 distribution | Agent build-only artifact; not a supported combination for this pinned Vector release.                                                                                                |
| Windows arm64 or Linux armv7 | Not a Vectory release target           | No native compatibility claim.                                                                                                                                                        |

A downloadable binary is not proof of native platform support. Download checksum/size checks establish which bytes were served, not installation or activation. Current downloads are unsigned development artifacts. Native acceptance from an earlier artifact does not automatically transfer to a newer checksum.

The development work includes native Windows testing, not a complete oldest/current OS matrix. Do not treat the Go compiler's minimum OS requirements as the minimum for Vector or the complete managed workload. The release's `docs/COMPATIBILITY.md` and `docs/ACCEPTANCE.md` retain the detailed evidence and remaining release gates.

## Check component and host requirements

The editor catalog includes 128 production component types from the pinned reference. Its presence in the editor does not mean a particular Vector build includes it. For example, Unix socket modes and journald need an appropriate Unix build; Windows Event Log needs Windows. A Windows validation worker cannot establish Linux runtime support.

Restricted mode permits a reviewed subset of components and locally authorized resources. Full mode is an explicit host-operator grant to use the adopted Vector process's available features and permissions. It does not install platform components, create credentials, provision files or make unavailable services reachable. See [installation modes](#/docs/installation) and [device resources](#/docs/resources).

Native checks involving local paths, providers or platform-specific sources can be deferred to the device. The UI reports this boundary; it does not turn a structural check into native validation. Actual configuration validity and activation still depend on the target device.

## Server, browser and offline use

The supplied server deployment targets one Linux Docker host with Compose and durable local storage. Its configuration has been checked; container execution and isolation still require verification on a Docker-capable host. Use [Administer Vectory](#/docs/administer) for the setup and recovery procedures.

Browser checks use Chromium on a Windows development host, including narrow mobile-sized layouts. Those checks do not certify every browser or physical mobile device. The configuration editor rejects integers outside JavaScript's exact safe range rather than silently rounding them; use a lossless native configuration workflow for such values.

The built help center is served with Vectory and can be read without a third-party documentation service. It follows the installed release. External Vector links require internet access and may describe a newer release; compare them with the pinned version before changing a configuration. An offline installation needs its server images, build dependencies, Vector binaries and agent artifacts prepared in advance.

## Reference sources

- [Vector 0.58.0 release](https://vector.dev/releases/0.58.0/)
- [Vector Intel Mac distribution change](https://vector.dev/highlights/2025-11-04-0-51-0-upgrade-guide/)
- [Vector configuration reference](https://vector.dev/docs/reference/configuration/)

These external references describe Vector. Vectory's own test evidence determines what has been exercised through this agent and control plane.
