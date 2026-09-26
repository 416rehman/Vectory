# Vector component catalog

Catalog version 1 targets **Vector 0.58.0**. The 13 curated forms and their defaults live in `dashboard/src/catalog.ts`. `catalog.json` and fixtures are generated from that source by `node tests/catalog.mjs`. This is a curated catalog, not a claim of a complete official machine-readable Vector schema.

Use the [official Vector documentation](https://vector.dev/docs/) and the [reference map](../docs/VECTOR-REFERENCES.md) for component options, configuration semantics and VRL behavior. Confirm changes against the pinned Vector executable before extending the catalog.

The fixtures pass the actual pinned Windows Vector binary's syntax/topology validation. Network destination health checks and environment checks are deliberately excluded from this fixture-only check; the agent runs full local validation before activation. HTTP, Elasticsearch and Loki need locally approved destinations; file/listener settings need corresponding local permissions. Demo → remap → console has additionally been activated by the real native agent.

The graph supports named route, OpenTelemetry and dropped-remap outputs; rejects cycles, missing inputs and known incompatible event types; preserves generic fields semantically in YAML/TOML/JSON; and keeps layout outside the artifact digest. Imported components without curated forms remain opaque, editable nodes. They still require server and local agent capability validation; text import does not make unsupported capabilities deployable. Unknown-format comments and layout normalize on export.

Source and sink network integration tests against external production services are not performed here. S3 is intentionally not advertised because the current local agent capability policy does not support it.
