# What's new

Vectory 0.1 is a developer preview. The whole loop works today against real Vector 0.58.0: build, publish, canary, apply and roll back.

## Highlights

- **Visual pipeline editor** for all 128 component types of Vector 0.58.0, with typed settings, a code view (YAML, TOML or JSON), import and export of one or several selected files, VRL and pipeline tests, and immutable history with diffs.
- **Checked publishing.** Publication checks the pipeline structure and uses a sandboxed Vector where safe. Configuration providers and other device-only checks run on each device before it applies the version.
- **Controlled rollouts.** Target devices and groups with a preview, set priorities, release as a canary or on a schedule, pause, cancel and roll back.
- **Agent updates.** Roll out a signed agent build from the dashboard to hosts that agreed to it, a canary first, and each host takes a failed build back by itself. A host is visited once, to agree.
- **Outbound-only agents.** Mutual TLS, per-device signed configurations, protection against rollback to older versions, and automatic restore of the last working configuration.
- **Host-owned safety.** Restricted and full modes, local allowances, and credentials that stay on the device.
- **Operations.** Device metrics, issues, and an exportable audit log.
- **Accounts.** Roles, two-factor sign-in with recovery codes, and administrator-issued reset links.
- **This Help center**, bundled with your server, searchable offline and available as Markdown.

## The details

- **Agent updates.** Turn them on in **Settings → Agent updates** and choose who holds the release key: this server, or a key you keep offline and sign with `vectory release`. **Add device** and **Upgrade agent** gain a step where a host agrees, once, to **Automatic (recommended)**, **Ask on the host** or **Off**, and to the key it pins. Then **Devices → Agent updates** shows the fleet's versions, prepares and signs releases, reviews exactly who will and won't update, and runs a rollout with a canary, batches, a watch period and a failure threshold. A host installs a build only if a key it pinned signed it, refuses a release it already tried while its update step remains installed, and takes the new build back if it doesn't check in healthy within five minutes, on Linux, macOS and Windows alike. **Stop all updates** ends every rollout at once. See [Agent updates](agent-updates.md).
- **Check on devices before you deploy.** The deploy review can ask the devices it would reach to validate the version on their own hosts first, without applying anything. Each answers **Passes here**, **Needs a fix** (with the step and setting) or names the device secret it hasn't bound, with the command to bind it. Results are advice: Deploy never waits for them. See [Check on devices](deployments.md#check-on-devices).
- **A live graph you can inspect.** Rates sit on labels and connections route around the steps, so nothing runs behind a card. **Fit** frames the topology; zoom in or choose **Show as table** to read details in a large pipeline. **Live** is on when a device runs the pipeline. See [Add and connect components](pipelines.md#add-and-connect-components).
- **From a problem to its fix.** **Fix in pipeline** opens the step and setting a failure names. Issue cards lead with **Roll back**, **Fix in pipeline**, **Open rollout** or **Open device**. Deploying a pipeline that already runs starts from the devices that run it. The command palette pauses, cancels and rolls back rollouts, deploys and duplicates pipelines, and shows a device's issues, through the same reviews as the pages. See [Work with issues](telemetry.md#work-with-issues) and [Deploy a published version](deployments.md#deploy-a-published-version).
- **Quick with thousands of devices.** Devices, group editing, the deploy dialog and the command palette read a page at a time and search on the server, and the Overview reads counts instead of a row per device. Select every device a search finds, across pages. See [Find devices](telemetry.md#find-devices).
- **What runs where.** The Overview's **Running now** lists each pipeline version devices run, on how many devices and in which groups, with events in and out per second and what it is doing now, such as a canary that is measuring delivery. See [Read the Overview](telemetry.md#read-the-overview).
- **One-command device install.** On Linux and macOS, **Add device** gives you one command that downloads the agent from your server, checks its SHA-256, pins your server's certificate and starts the service. Windows uses the same `vectory setup` from PowerShell. Agents ship inside the server image, so there's no release step.
- **Readable agent CLI.** `vectory setup`, `--help` for every command, a human-readable `status`, `doctor` checks that test the connection to your server, and `vectory logs`.
- **Real reasons for failures.** Issues and device pages show redacted summaries of Vector's own messages. Vector gets a data directory automatically when a pipeline doesn't set one.
- **Alerts where you work.** Slack, webhook and email notifications for new issues, failed rollouts and offline devices, with quiet hours and a delivery log. See [Alerts and notifications](notifications.md).
- **Install commands that verify what they download.** **Add device** gives you a command that never skips certificate checks: for a private CA it carries the CA certificate and verifies against it, and **Advanced** lets you use a CA file on the host or the host's own trusted certificates instead. On Windows the download is checked with `Get-FileHash`. `vectory allow` widens what a restricted host allows, on that host. See [Connect a device](installation.md).
- **Enrollment tokens with a scope.** A token can list the device names it may enroll (each once) and give the devices it enrolls labels such as `site=berlin`. Labels describe a device; they never add it to a group or a deployment. The token list shows the scope, and **Recent enrollment attempts** says why a refused device was refused.
- **Rotating the device certificate authority.** `vectory-admin rotate-device-ca` keeps devices working while they move to a new authority, and `retire-device-ca` refuses until none is left on the old one. See [Rotate the device certificate authority](administer.md#rotate-the-device-certificate-authority).
- **Tests gate publishing.** The publish review runs a pipeline's tests and says how they went. While one isn't passing the button reads **Publish anyway**, and the server refuses a publish over failing tests unless it's acknowledged. See [Tests gate publishing](resources.md#test-transformations).
- **Canaries you can steer and watch.** Choose which devices go first, see what they deliver against the minutes before their release, read one line on what the canary gate waits for, and release the next stage early when the canary is healthy. See [Choose a rollout](deployments.md#choose-a-rollout).
- **What a device was offered.** A device's page shows the exact configuration it was offered with its own values applied, what changed since the previous offer, and whether its agent reports that file. See [Read what a device was offered](deployments.md#read-what-a-device-was-offered).
- **Held on previous version.** A device whose newest version failed but which still runs and delivers on its previous one is amber, not red. See [Read a device's health](deployments.md#read-a-devices-health).
- **Deployments in seconds.** A connected device picks up a new version within seconds instead of at its next check-in. The agent still opens every connection itself. See [Turn off wake-ups](agents.md#turn-off-wake-ups) for networks that cut idle connections.
- **Shipping is the default.** Deploying a new version of a pipeline replaces the older one on those devices. Each deployment has a live rollout page.
- **Device secrets in supported credential fields.** API keys, passwords and tokens can stay on each device as `vectory-secret:NAME` in supported fields, with the binding command one click away and each device's bound names on its page. Headers and URLs refuse device-secret references in this preview; see [Keep credentials on the device](resources.md#keep-credentials-on-the-device) and [Known limits](#known-limits).
- **Faster pipeline building.** A template gallery, one-click **Add monitoring**, a VRL editor with autocomplete and sample tests, and a publish review that shows exactly what changed.
- **A calmer, faster workspace.** A command palette (**Ctrl K** / **⌘ K**) and a first-run checklist on the Overview.
- **Smoother accounts.** A guided first run, invite links, and a way back in when an administrator is locked out.
- **A reorganized Help center** with a quickstart, a security model, and references for the agent CLI, server configuration and ports.

## Known limits

- Images and packages aren't published yet; the server builds from source.
- Agent downloads carry SHA-256 checksums but aren't signed.
- A host takes agent updates only after someone ran a command on it that agreed to them. Hosts that haven't, agents that predate updates and platforms a release doesn't carry are upgraded on the host, one command per device; see [Upgrade many devices](agents.md#upgrade-many-devices).
- Agent updates have no major track: a host takes patch releases, or minor releases too, and a new major version is an upgrade by hand. Who holds the release key is fixed while updates are on.
- Turning agent updates off or uninstalling their step removes the host's record of releases it tried. If updates are turned on again, it can try a previously rolled-back release if the server offers it. A build older than the one running is still refused.
- On Linux, the service installed by `vectory setup` has a less restrictive filesystem sandbox than the packaged service. Review the device's file permissions and local allowances before approving a pipeline that reads or writes host files.
- A file root that includes `/run` or `/var/run` can expose local service sockets if a future restricted component can connect to them. Current restricted components cannot; avoid granting those roots.
- Restricted mode accepts a reviewed subset of Vector components and settings. A pipeline outside that subset needs full mode, which gives its author broad access to the host through Vector. Graduated host-approved capabilities are planned for a later release.
- Files that Vector reads, such as CA bundles, TLS keys, enrichment tables and Lua files, must be provisioned on each host; Vectory does not deliver them with a pipeline version in this preview.
- Device secrets cannot fill headers or URLs in this preview. A full-mode device may use a native Vector secret backend or a managed environment reference where Vector supports one; restricted devices have no equivalent for those fields. Do not put the plaintext value in a pipeline draft.
- An agent service behind a proxy that requires sign-in has no supported protected credential setup in this preview. Arrange an unauthenticated route or a direct connection; do not put proxy passwords in a service environment. The Windows service also has no per-service proxy setting. See [proxy troubleshooting](troubleshooting.md#a-proxy-is-in-the-way).
- Rendered configurations and their per-device generation records have no retention limit. Repeated deployments with device-specific values can grow the server database; monitor disk space and leave room for backups.
- Creating or inviting an Administrator does not require password re-entry. Someone with a stolen Administrator session could add another Administrator; recent authentication for sensitive actions is planned for the next release.
- Vector warnings and errors can echo event data. The agent redacts device-known secrets and suspicious tokens before sending bounded summaries to the server, but arbitrary event-derived text or native-provider values unknown to the agent can remain. Treat device diagnostics and issue notifications as sensitive.
- **Check on devices** never activates a candidate, but full-mode Vector validation can run native providers and `exec` secret backends with host-side effects. Run a check only when you trust the pipeline author to validate on those hosts.
- Reboot tests and a test of an upgrade from an earlier release aren't done on any platform, and the service tests, which include an agent update through a rollout, run on Ubuntu 24.04, macOS 15 and Windows Server 2025 only. See [Compatibility](compatibility.md).
- On a restricted host, **Check on devices** reports one finding at a time (a missing secret first, then each allowance the host hasn't approved), so run it again after each fix.
- Agent settings and groups can't be deleted or archived yet.
- A deployment needs at least one device when you create it. A group with no devices can't be chosen yet, even with **Also include future group members**; add a device to the group first.
- A destination that refuses events can raise up to three issues, and three notifications, for one cause (the destination can't deliver, the component is dropping events, the pipeline stopped delivering). They resolve together once delivery recovers.
- A canary that stopped because a device wasn't delivering stays stopped after the destination recovers. Its deployment offers **Roll back or remove**, not a way to release the remaining devices.
- The API uses session cookies; API tokens are planned.
- One server per installation.

The full list of changes is in the repository's `CHANGELOG.md`.
