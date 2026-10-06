# Vector configuration catalog

The catalog targets **Vector 0.58.0** and contains **128 entries: 48 sources, 18 transforms and 62 sinks**. It covers all 126 component pages in the supplied reference list, plus two deprecated aliases. The picker is searchable; it is not limited to the 13 components with curated starter defaults.

## Schema and provenance

`scripts/generate-vector-catalog.mjs` generates the dashboard catalog and schema from the exact pinned Vector binary and version-matched upstream metadata. Native schema definitions retain types, required fields, descriptions, defaults, constraints, discriminators and references. Unix-only components and Unix branches omitted by the Windows generator use explicit projections of the corresponding pinned CUE files. Vendored source files, hashes, the upstream revision and MPL-2.0 notices live in `upstream/` and the generated metadata. Run the generator with `--check` to verify deterministic output.

The shared field model and renderer live in `dashboard/src/pipelineSchema.ts`, `PipelineSchemaFields.tsx` and `SchemaValueEditor.tsx`. They handle nested objects, ordered lists, typed maps, optional values, null, enums, discriminated choices, string/object alternatives, conditional requirements and semantic text types. Units and constraints come from metadata. Pending invalid inputs stay local; imported unknown properties remain preserved. JSON, YAML and TOML remain available for complete configuration editing. Comments and source formatting normalize on export.

Global configuration uses the same field system: API/TLS settings, schemas, health checks, acknowledgements, enrichment tables, native secret backends, configuration providers and native pipeline tests. Memory enrichment tables can create an input sink and a separately named export source; those actual roles are shown in the graph. Named route, OpenTelemetry, Datadog, dropped-remap and expired-memory outputs are represented individually.

## How types become controls

The generator captures a versioned schema; the field model resolves references, compositions and the applicable branches for the current value. The renderer consumes that model in both component settings and pipeline settings. Adding a known schema field therefore uses the same controls without a new component-specific form.

| Schema or semantic type | Editing behavior |
| --- | --- |
| String | Text input, with path, template, URL, regex, VRL or secret-reference behavior derived from metadata. Template strings remain literal. |
| Number / integer | Local numeric draft, bounds and unit display; invalid or unsafe whole numbers cannot enter persistence. Changing display units retains native storage units. |
| Boolean / enum | Explicit choices preserve false, zero, and the distinction between a numeric enum and a string enum. |
| Optional / nullable | Missing, null and empty remain distinct. Adding a field does not silently materialize unrelated defaults. Sole-shape nullable fields use compact null actions. |
| Object | Named nested fields, required values first, searchable optional fields, and preserved unknown imported properties. |
| Array | Typed rows with insert, reorder, duplicate and remove. Pending row input follows its row during reordering. |
| Map | User-named entries with typed values, key rename and duplicate; key constraints apply when present. |
| Tagged or untagged alternatives | Explicit shape selection with cached edits per alternative. Ambiguous imports stay intact until a choice is made. |
| Conditional fields | Applicable `if`/`then`/`else` and dependencies inform the field model; documentation-only requirements remain visible as guidance. |
| Unresolved or arbitrary data | Structured value editing and an explicit JSON escape, preserving unknown values for native validation. |

Draft text and configuration values are separate. A partially typed number, invalid JSON or uncommitted key rename remains visible and pending; validation and navigation cannot silently treat an older configuration value as that edit. Schema checks guide editing. Native Vector remains the authority for platform, provider, VRL, filesystem and endpoint behavior.

## Coverage evidence

`scripts/audit-vector-reference.mjs` reads the supplied reference URLs, normalizes duplicates, retrieves the official pages and compares configuration paths with every schema branch. `docs/evidence/vector-reference-audit.json` records page and field-path coverage. This is structural coverage, not proof that every remote service has been integrated or every field combination deployed.

`tests/security/schema-fixtures.mjs` exercises schema edge cases independently. Dashboard model, graph and browser tests verify editing and round trips. `node tests/catalog.mjs` runs actual pinned Vector syntax/topology validation for 16 complete configurations spanning 17 distinct component types, including Kafka, S3 and internal metrics. The remaining component types have schema/catalog coverage but have not all been exercised against native external integrations. Fixture validation skips remote health checks and environment checks; device activation retains local native validation.

## Capability table

`capabilities.json` is the reviewed source of what restricted mode allows of each component type, global setting and enrichment table: a tier (built in, host approval, full mode), what it reaches, and its resource, refused and template fields, credential shapes and managed-asset fields, with shared schema types classified once ([ADR 0012](../docs/adr/0012-graduated-capability-tiers.md)). `node scripts/generate-capability-table.mjs` writes the agent's, the server's and the dashboard's copies and the restricted-mode lists in `docs/user/security.md`; with `--check` it also fails when a component has no tier or a resource-like field of a built-in or approval component has no rule, so a Vector upgrade that adds such a field waits for a review. The golden fixtures in `fixtures/capabilities/` pin the needs each configuration has, for the agent, the server and the dashboard alike; [their README](fixtures/capabilities/README.md) says how needs follow from the table. Nothing reads the table yet: until then its `current_restricted_mode` section equals what restricted mode accepts, and `tests/security/test_capability_lists.py` holds it there.

## Device capabilities

Restricted devices accept the reviewed component subset and locally permitted resources. A host operator can explicitly enable **full Vector mode** using the installation workflow. That local grant permits all components supported by the adopted Vector build, native globals, providers, environment references and exec within the process's OS permissions. The dashboard reports the mode and reviews eligible targets; it cannot remotely grant it.

Restricted mode also refuses a VRL call that passes a file to `parse_groks` (`alias_sources`) or `parse_etld` (`psl`), because Vector opens that file when it compiles the program. The server, the agent and the dashboard each scan for such a call. `fixtures/vrl-file-arguments.json` holds the programs all three must judge alike, and `tests/security/test_vrl_function_lists.py` keeps their tables and bounds equal.

The IDs a device reports (a component's ID and a route's output name, in a heartbeat's log groups and diagnostics) follow one rule on the server and in the agent, because a heartbeat the server refuses keeps the device off the control plane. `fixtures/component-ids.json` holds the IDs both must judge alike, and `fixtures/report-bounds.json` the bounds on a heartbeat's diagnostics and log groups with records whose size is measured the way the server measures it. The server's tests (`validation.rs`, `configuration_attempt.rs`, `device.rs`) and the agent's (`component_ids_test.go`, `report_bounds_test.go`) read both files.

A custom component definition can be added in the picker or imported. Vectory preserves its fields, but the corresponding component must already exist in the target's Vector build. Adding JSON does not compile or install a new Vector plugin. See the bundled [installation](../docs/user/installation.md), [pipeline](../docs/user/pipelines.md) and [resources](../docs/user/resources.md) guides.

The [official Vector reference](https://vector.dev/docs/reference/configuration/) governs native semantics. Platform-specific types and device resources may defer server native validation to the target. Deferred validation is explicit; it never claims that Vector ran successfully on the server.
