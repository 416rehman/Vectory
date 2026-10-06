# Independent Vector reference and type-system review

> **Historical record of 2026-09-28.** The evidence files it names were not committed. They are named below in backticks instead of linked, so you can see what each passage claimed. Current evidence: the CI workflow `checks` for the commit under test (its steps run `tests/security/schema-fixtures.mjs` and `tests/security/schema-review.mjs`) and `docs/internal/REQUIREMENTS.md`.

Reviewed against the pinned Vector **0.58.0** configuration schema and the official Vector reference URLs. This is an executed coverage inventory and representative compatibility review, not a claim that every configuration or integration has run successfully.

## Reference coverage

[`reference-urls.json`](../../vector-catalog/reference-urls.json) preserves the 139 listed URLs and 138 normalized unique URLs. The bounded four-request audit retrieved all 138 official pages successfully. The list includes the configuration overview, all component pages, global options, pipeline components, TLS, API configuration, tests, event schema, template syntax, and secrets. It covers 126 distinct component pages. All 126 occur in the pinned 128-entry catalog; the two additional entries are deprecated aliases, `sources/http` and `sinks/greptimedb`.

The pinned schema contains 493 definitions and 6,145 schema nodes. All 128 component schemas compile with AJV's draft-2019 implementation. Formats are intentionally not treated as proof of native Vector semantics. The audit records platform metadata and native-versus-projected provenance for each component, and URL status, title, content hash and retrieval time for every page. Raw HTML is cached under ignored `.local/vector-reference-cache`.

The script also extracts **6,788 field headers** from the Configuration sections of the 126 component pages and compares their normalized paths with every branch of the pinned schema. All 6,788 paths now match. Another 169 field headers from global options, secrets, schema, API and pipeline-components pages match the root schema. Array item paths and the site's wildcard anchor formatting are normalized explicitly. These are structural path matches, not equality proofs for field semantics, defaults or every conditional branch. Explanatory pages such as TLS and unit tests use narrative examples rather than the field-badge markup and are not counted as zero-feature schemas.

This comparison initially identified nine missing fields across five shared component types: Unix socket branches of the socket, syslog, fluent and statsd sources and the statsd sink. Six mode branches were restored from the same pinned upstream commit's CUE metadata. Their provenance remains distinct from native Windows generation, and Unix runtime activation is untested.

Reproduce with `node scripts/audit-vector-reference.mjs --refresh`; `--offline` reads the existing private cache. The script writes its report to `docs/evidence/vector-reference-audit.json`; that report was not committed.

## Actual field shapes

| Shape                                                    | Observed schema nodes | Consequence for controls                                                                                             |
| -------------------------------------------------------- | --------------------: | -------------------------------------------------------------------------------------------------------------------- |
| `required`                                               |                   753 | Presence is distinct from truthiness; `false`, zero, empty strings and explicit null must follow the field's schema. |
| Nullable forms                                           |                   639 | Preserve omission, explicit null and actual values separately.                                                       |
| Null defaults                                            |                   186 | Showing the default must not silently write it into a draft.                                                         |
| `oneOf` / `anyOf` / `allOf`                              |        256 / 73 / 539 | Support scalar/object alternatives, tagged choices, flattened object fields and imported ambiguous values.           |
| `if` / `then`                                            |                 6 / 6 | The current occurrences are in explicitly projected Unix component schemas.                                          |
| Typed / unrestricted additional-property maps            |                48 / 1 | Keys and value types both matter; map entries need independent rename, duplicate and remove operations.              |
| Closed objects                                           |                   609 | Preserve imported data until the user explicitly changes it; avoid silently inventing or dropping keys.              |
| Unit metadata                                            |                   239 | Numeric seconds, milliseconds and byte counts remain numbers. Display conversion must preserve stored units.         |
| Templateable metadata                                    |                    13 | Event templates differ from environment expansion and native secret references.                                      |
| Required-one-of / required-when / relevant-when metadata |           12 / 8 / 16 | These are documentation metadata, beyond ordinary JSON Schema keyword enforcement.                                   |
| Unsafe integers inside defaults                          |                    65 | Do not copy rounded large integer defaults into editable configuration values.                                       |

No `propertyNames` or `patternProperties` occurrences were found in this pinned schema. Synthetic key-pattern tests exercise generic renderer support separately; they are not evidence that such restrictions occur in these Vector definitions. Native functions may impose constraints absent from the schema.

The [template reference](https://vector.dev/docs/reference/configuration/template-syntax/) describes event-driven strings; the [secrets reference](https://vector.dev/docs/reference/configuration/secrets/) describes native secret providers. Controls retain these strings literally. The [HTTP sink reference](https://vector.dev/docs/reference/configuration/sinks/http/) includes template-capable endpoints and headers. A generic URL input must not turn these into static URL-only fields.

## Executed independent probes

`tests/security/schema-fixtures.mjs` executes **34 exact upstream schema probes** and lossless JSON round trips. They cover nullable integers, tagged and shorthand conditions, string/object compression, mixed numeric/string enums, disk/memory buffers, typed header maps, arbitrary nested test-event values, fractional seconds, nullable TLS, sensitive token arrays and Unix conditional requirements. Every validation probe verifies that validation did not mutate the original value.

With `VECTORY_TEST_VECTOR` pointing to the pinned binary, three additional native configurations are validated: the local timezone, a memory enrichment table exporting a generated source, and a relative VRL source file. All passed on native Windows Vector 0.58.0. Results: `docs/evidence/schema-fixtures.json`.

Three upstream schema inconsistencies are deliberately recorded as expected failures rather than hidden:

- The timezone definition contains both `const: "local"` and unconstrained string branches in `oneOf`. AJV rejects `"local"` as ambiguous, while actual Vector accepts it. Schema-only rejection would create a false blocker.
- HTTP request retry/rate defaults contain integers beyond JavaScript's safe range, while the corresponding maximum is capped at `9007199254740991`. The parsed default object fails its own schema. Showing a default and explicitly materializing it are different actions.
- The generated `stdlib::PathBuf` pattern rejects a relative `relative.vrl` file, while actual Vector accepts that file when it exists in the working directory. The model defers that specific upstream path pattern to native validation while retaining ordinary custom-schema pattern enforcement.

The review also found and corrected a server topology gap. The [pipeline components reference](https://vector.dev/docs/reference/configuration/pipeline-components/) permits a memory enrichment table to expose `source_config.source_key`. The validator now recognizes that exact declared source and its conditional `expired` output. It still rejects undeclared references, output collisions, memory-table sink IDs used as outputs, and disabled named outputs. Pinned native parity now covers **25 output/topology cases**, including nine memory-table cases. Vector still requires ordinary top-level source and sink sections, as confirmed by negative native cases.

The [Splunk HEC source reference](https://vector.dev/docs/reference/configuration/sources/splunk_hec/) describes a nullable credential list. Schema string typing alone does not protect configuration history. Server tests now reject plaintext `valid_tokens` and `access_keys` on creation, draft update and graph copies, while allowing native references. An API integration test publishes reference-only values and verifies the synthetic plaintext never enters any persisted record.

Six validator regressions cover the projected Unix transport branches in the socket, syslog, fluent and statsd sources and statsd sink. Each valid branch contains a device-local path and is deferred before Windows Vector execution; pipeline tests are explicitly reported as unexecuted. A transport mode without its required path does not obtain that deferral. This checks the validation boundary, not Unix activation.

The separate renderer report (`docs/evidence/schema-controls-browser.json`) records **21 actual React browser scenarios**. These include complete Syslog and Socket forms, shared fields that stay current across mode changes, cached branch-specific values, pending nullable numbers that preserve the stored null until valid input, and cancellation of those drafts. Complete Remap and Sample forms distinguish the native required-one-of constraint from genuine format alternatives. HTTP source authentication is available in the schema controls; curated labels and starter fields no longer impose requirements that conflict with valid native alternatives.

## Boundaries

The generated schema describes native configuration shapes; it does not prove platform availability, correct credentials, external endpoint access, file permissions, VRL execution, native providers, or successful activation. Context-dependent checks remain deferred to the actual device, where the agent validates the complete configuration and configured tests before replacing its running configuration. Full Vector mode is an explicit local grant; server-authored configuration cannot turn a restricted device into a full-mode device.

The live [schema reference](https://vector.dev/docs/reference/configuration/schema/) concerns Vector's event schema settings. It is distinct from the experimental configuration JSON Schema used to construct these controls. Neither is a universal integration test.

The browser now rejects non-finite numbers and integers outside the exact JavaScript range, −9,007,199,254,740,991 through 9,007,199,254,740,991, when reading API/configuration data or serializing requests. Larger native integer values are an unsupported browser-editing case. They are not rounded or converted to strings. Omitted native defaults can remain omitted even when their documented numeric default exceeds that boundary.

A closing review confirmed that memory export-source name collisions are checked before committing or retargeting references, preventing an intermediate collision from redirecting unrelated edges. Inspector navigation/destructive actions guard pending field drafts, and pipeline checking rejects unapplied changes. A focused integrated browser regression verifies that collision-then-rename preserves the original input. The complete product-browser suite runs in CI ([CI.md](CI.md)).

Independent actual React/Chromium interaction checks passed **13/13**, recorded in `docs/evidence/schema-review.json` and reproduced with `node tests/security/schema-review.mjs`. They cover sensitive arrays, partial numeric drafts, fractional display units, numeric/string enum identity, event-template URLs, map rename/duplicate, pending edits during reorder and rename, nullable value restoration, HTTP authentication branch caching and pending-plaintext guards, arbitrary map keys without prototype mutation, synthetic key constraints, and read-only controls. This harness uses isolated synthetic state and does not mock activation or modify an ordinary fleet. The URL inventory, schema compilation and representative field probes are not complete UI interaction coverage.
