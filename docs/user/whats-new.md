# What's new

Vectory 0.1 is a developer preview. The whole loop works today against real Vector 0.58.0: build, publish, canary, apply and roll back.

## In this update

- **Quick with thousands of devices.** Devices, group editing, the deploy dialog and the command palette read a page at a time and search on the server, and the Overview reads counts instead of a row per device. Select every device a search finds, across pages. See [Find devices](telemetry.md#find-devices).
- **What runs where.** The Overview's **Running now** lists each pipeline version devices run, on how many devices and in which groups, with events in and out per second and what it is doing now, such as a canary that is measuring delivery. See [Read the Overview](telemetry.md#read-the-overview).
- **One-command device install.** On Linux and macOS, **Add device** gives you one command that downloads the agent from your server, checks its SHA-256, pins your server's certificate and starts the service. Windows uses the same `vectory setup` from PowerShell. Agents ship inside the server image, so there's no release step.
- **Readable agent CLI.** `vectory setup`, `--help` for every command, a human-readable `status`, `doctor` checks that test the connection to your server, and `vectory logs`.
- **Real reasons for failures.** Issues and device pages show Vector's own message, with secrets removed. Vector gets a data directory automatically when a pipeline doesn't set one.
- **Alerts where you work.** Slack, webhook and email notifications for new issues, failed rollouts and offline devices, with quiet hours and a delivery log. See [Alerts and notifications](notifications.md).
- **Shipping is the default.** Deploying a new version of a pipeline replaces the older one on those devices. Each deployment has a live rollout page.
- **Device secrets in every credential field.** API keys, passwords and tokens stay on each device as `vectory-secret:NAME`, with the binding command one click away and each device's bound names on its page. See [Keep credentials on the device](resources.md#keep-credentials-on-the-device).
- **Faster pipeline building.** A template gallery, one-click **Add monitoring**, a VRL editor with autocomplete and sample tests, and a publish review that shows exactly what changed.
- **A calmer, faster workspace.** A command palette (**Ctrl K** / **⌘ K**) and a first-run checklist on the Overview.
- **Smoother accounts.** A guided first run, invite links, and a way back in when an administrator is locked out.
- **A reorganized Help center** with a quickstart, a security model, and references for the agent CLI, server configuration and ports.

## In Vectory 0.1

- **Visual pipeline editor** for all 128 component types of Vector 0.58.0, with typed settings, a code view (YAML, TOML or JSON), import and export, VRL and pipeline tests, and immutable history with diffs.
- **Safe publishing.** Every version is checked by a sandboxed Vector before it can be published.
- **Controlled rollouts.** Target devices and groups with a preview, set priorities, release as a canary or on a schedule, pause, cancel and roll back.
- **Outbound-only agents.** Mutual TLS, per-device signed configurations, protection against rollback to older versions, and automatic restore of the last working configuration.
- **Host-owned safety.** Restricted and full modes, local allowances, and credentials that stay on the device.
- **Operations.** Device metrics, issues, and an exportable audit log.
- **Accounts.** Roles, two-factor sign-in with recovery codes, and administrator-issued reset links.
- **This Help center**, bundled with your server, searchable offline and available as Markdown.

## Known limits

- Images and packages aren't published yet; the server builds from source.
- Agent downloads carry SHA-256 checksums but aren't signed.
- Service, reboot and upgrade tests are still to come on some platforms. See [Compatibility](compatibility.md).
- The API uses session cookies; API tokens are planned.
- One server per installation.

The full list of changes is in the repository's `CHANGELOG.md`.
