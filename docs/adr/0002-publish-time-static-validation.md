# ADR 0002: Compile-check every publishable configuration

Accepted 2026-09-29.

## Context

The isolated worker runs `vector validate --no-environment`. Earlier, any device-local path anywhere in a
configuration (`data_dir`, a file source's globs, TLS files, or even a component *named* `file`) deferred
all native validation to devices. VRL compile errors and fallible route conditions therefore published
cleanly and then failed on every device.

With `--no-environment`, Vector 0.58 compiles transforms (VRL, route and filter conditions) but does not
build sources, sinks or health checks. We confirmed with the pinned binary that nonexistent `data_dir`,
file globs, TLS certificate/key/CA paths and Unix socket paths all pass, while a remap `file:` program
fails because transforms are built.

## Decision

- The worker compile-checks every configuration whose only device dependency is local paths outside
  transforms. Results are reported as `static_checked`, `deferred: true`, `vector_validated: false`:
  structure and VRL are verified; the device still validates its environment before activation.
- Transforms that load code from disk (remap `file`/`files`, Lua) keep the full deferral.
- Environment interpolation, `SECRET[...]` references, configuration providers and enrichment data stay
  deferred, because they change the loaded bytes or execute device resources.
- Component IDs and route names are labels, not configuration fields, and never trigger deferral.
- `/vrl/test` returns the bounded, ANSI-free VRL compiler or runtime message (`diagnostic`). The program
  and sample are the caller's own synthetic input, so the message discloses nothing new.

## Consequences

Most real pipelines now get a native compile check at publish time. A device can still reject a version
for environmental reasons (missing directories, credentials, ports), which device diagnostics report.
