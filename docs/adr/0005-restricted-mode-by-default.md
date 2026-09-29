# ADR 0005: Every device starts in restricted mode; only the host can grant full mode

Proposed 2026-09-29. This records the capability model as implemented at commit `a469266` (the local policy since `2f18fb7`, the `setup --mode` flag since `0e63604`); no one has reviewed or accepted it yet.

## Context

A Vector configuration is privileged: the `exec` source runs programs, secret backends can run commands, and file sources and network sinks can read and send data. The specification (section 10, line 239) requires a local capability policy that disables command execution by default and that an ordinary dashboard deployment cannot widen. Some pipelines legitimately need more than a safe subset.

## Decision

- A device's mode lives in its local capability policy (`agent/internal/agent/policy.go`). The zero value is restricted.
- Restricted mode accepts an allowlist of components (six sources, six transforms and six sinks, listed in `docs/user/security.md`), a few global settings, and only the file roots, destinations and listeners that the host operator approved. It refuses environment interpolation, secret providers, enrichment tables, external VRL files, anything that runs a program, and VRL functions that reach outside the event.
- Only someone on the host grants full mode: `vectory install --allow-full-vector-config` or `vectory setup --mode full`. Full mode accepts anything the host's Vector build supports, with Vector's operating-system permissions.
- The server reads a device's mode from its own report. A missing mode means restricted, an unknown one is rejected, and agent settings from the server cannot carry a mode (`server/src/device.rs`, `server/tests/control_plane.rs` `configuration_mode_is_local_report_not_remote_policy`).
- Add device shows both modes with neither selected, so the operator makes the choice.

## Consequences

- A new device can run the starters, but common production sinks outside the allowlist, such as S3, need full mode. The dashboard names the refused component and resource, and the deploy dialog generates the allowances file for the host.
- Anyone who can publish to a full-mode device can make that host's Vector do anything Vector can do. The Security model says so.
- Allowances are configuration checks, not an operating-system sandbox; host permissions and network controls still matter.
