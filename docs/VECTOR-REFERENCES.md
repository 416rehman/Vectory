# Official Vector references

[Vector's official documentation](https://vector.dev/docs/) is the technical reference for Vectory. Reviewed 2026-09-26. Use the following pages when implementing or extending the integration.

| Area | Official reference | Application in Vectory |
| --- | --- | --- |
| Configuration formats and topology | [Configuration](https://vector.dev/docs/reference/configuration/) and [pipeline components](https://vector.dev/docs/reference/configuration/pipeline-components/) | Canonical source/transform/sink model, upstream `inputs`, YAML/TOML/JSON import and export |
| Component options | [Sources](https://vector.dev/docs/reference/configuration/sources/), [transforms](https://vector.dev/docs/reference/configuration/transforms/) and [sinks](https://vector.dev/docs/reference/configuration/sinks/) | Generated component schemas and curated settings; editor help links to the selected component's page |
| Transform programs | [VRL](https://vector.dev/docs/reference/vrl/) | Remap programs, fallible-function error handling and synthetic sample testing |
| Validation | [Validating](https://vector.dev/docs/administration/validating/) | Actual Vector validation, with syntax/topology fixture checks distinguished from host environment and sink health checks |
| Process management | [Management](https://vector.dev/docs/administration/management/) | Supported lifecycle mechanisms, adopted instance ownership and activation verification |
| Operational metrics | [Monitoring](https://vector.dev/docs/administration/monitoring/), [internal metrics](https://vector.dev/docs/reference/configuration/sources/internal_metrics/) and [Prometheus exporter](https://vector.dev/docs/reference/configuration/sinks/prometheus_exporter/) | Explicitly configured local exporter, bounded metric collection and unavailable-value handling |
| Event schema | [Schema configuration](https://vector.dev/docs/reference/configuration/schema/) | Event fields, namespacing and schema validation; this page is not a complete machine-readable schema for all component options |

Vectory currently targets **Vector 0.58.0**. Live documentation may describe newer behavior; accept compatibility changes only after checking the pinned executable, release notes and relevant fixtures. The catalog combines generated upstream configuration schemas with curated forms; its exact coverage, provenance and executed validation are recorded in [the catalog guide](../vector-catalog/README.md). Documentation for a Vector capability does not by itself make that capability supported by Vectory's editor or permitted by the host's local policy.

This reference review does not replace native tests or expand the compatibility claims in [COMPATIBILITY.md](COMPATIBILITY.md). The dashboard's visual direction remains recorded in [DESIGN.md](DESIGN.md).
