# Changelog

All notable changes to Vectory. The project is a developer preview and has no public release yet.

## 0.1.0-dev (unreleased)

The first self-hosted Vectory: a Rust and SQLite control plane, a React dashboard, an outbound-only Go agent, and a bundled Help center. See [What's new](docs/user/whats-new.md) for a tour.

### Highlights

- Visual pipeline editor for the 128 component types of Vector 0.58.0, with YAML, TOML and JSON import and export, VRL and pipeline tests, and immutable history with diffs.
- Publishing checked by a sandboxed Vector validator that fails closed.
- Deployments to devices and groups with previews, priorities, canaries, schedules, pause, cancel and rollback.
- Outbound-only agents with mutual TLS, per-device signed manifests, protection against older configurations, drift repair and automatic restore of the last working configuration.
- Restricted and full modes, local allowances and device-local secret bindings, all controlled on the host.
- Device metrics, issues, and an exportable audit log.
- Roles, two-factor sign-in with recovery codes, and administrator-issued reset codes.
- A Help center bundled with the server, searchable offline, with every page available as Markdown and an `llms.txt` index.

### Fixed during development

Agents built before these fixes behave differently. Rebuild agents from this revision.

- **Enrollment preflight:** an unreadable CA file or invalid local option is rejected before connection settings are saved or an enrollment request is created. Earlier builds could save the connection settings first.
- **Combined `install` options** are validated together before anything is saved. Earlier builds could save one option and then reject the next.
- **Secret-binding maps** are parsed strictly: `null`, lists, duplicate names and trailing content are rejected. Earlier builds could treat `null` as "remove all bindings" or keep the last duplicate silently.
- **Capability-policy files** with malformed UTF-8 or unpaired Unicode escapes are rejected instead of being repaired with replacement characters.
- **Metrics endpoint:** `vectory configure-metrics` and `--clear-metrics-url` were added. Earlier builds could only set a URL with `install --metrics-url`.
- **Replaced Vector binaries** can be approved with `vectory re-adopt --expected-sha256`. Earlier builds had no approval path.

### Documentation

- The Help center was reorganized around tasks: a quickstart, installing the server, connecting a device and deploying a first pipeline come first, followed by a security model and references for the agent CLI, server configuration, `vectory-admin` and ports.
- Repository copies of the guides became short pointers into the Help center, and internal evidence moved to `docs/internal/`.
