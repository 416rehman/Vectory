# Capability fixtures

Golden fixtures for restricted mode's needs. Each file is one configuration and what a restricted device needs to run it, read from the capability table (`vector-catalog/capabilities.json`, expanded by `scripts/generate-capability-table.mjs` into `dashboard/src/generated/capability-table.json` and its Go and Rust copies). The agent, the server and the dashboard each run every fixture through their own needs function and must produce exactly the file's `needs`, so the three checkers agree, not only their copies of the table.

`node scripts/check-capability-fixtures.mjs` checks every file: its shape, that `needs` follows from the table by the rules below (it carries a reference reading of this document, used only for that), and, when the pinned Vector is at hand, that `vector validate --no-environment` agrees with the file's `vector` field.

## A fixture

```json
{
  "description": "One sentence: the case it pins.",
  "host": { "state_dir": "/var/lib/vectory-agent", "managed_config_dir": "/etc/vectory/managed" },
  "assets": [{ "name": "geo-country", "sha256": "<64 lowercase hex>", "kind": "mmdb" }],
  "vector": "valid",
  "vector_error": "text Vector's refusal contains",
  "config": { "sources": {}, "sinks": {} },
  "needs": {
    "refused": [],
    "full_mode": [{ "code": "UNSUPPORTED_LOCAL_CAPABILITY", "at": "/sources/run" }],
    "components": ["kafka"],
    "capabilities": ["instance-credentials"],
    "network": ["broker.example.net:9092", "unix:/run/app.sock"],
    "listeners": ["0.0.0.0:514"],
    "file_roots": ["/var/log/app"],
    "writes": ["/var/lib/vector"],
    "assets": [{ "name": "geo-country", "sha256": "<hex>", "kind": "mmdb", "at": "/enrichment_tables/geo/path" }]
  }
}
```

- `config` is the configuration as the server renders it for one device: Vector's JSON shape, variables applied, `vectory-secret:` and `vectory-asset:` references unresolved. Component IDs are plain; the component ID check (`INVALID_COMPONENT_ID`) runs before needs in every mode and isn't repeated here.
- `host` is optional: the device's own directories, as the agent knows them and the device reports them. The managed assets directory is `<state_dir>/assets`. Without `host`, the overlap rule below is skipped.
- `assets` is optional: the asset list of the signed manifest (ADR 0013), naming each pinned asset's kind.
- `vector` is `valid` (Vector 0.58.0 accepts the configuration), `invalid` (it refuses it; `vector_error` is part of its message) or `skip` (not checked; `vector_error` then says why, such as a platform the pinned Linux build lacks).
- `needs` has all nine categories, even when empty.

## The needs

| Category | Holds | Order |
| --- | --- | --- |
| `refused` | `{code, at}`: what no mode allows | by `at`, then `code` |
| `full_mode` | `{code, at}`: what only full mode allows | by `at`, then `code` |
| `components` | component types to approve with `vectory allow --component` | sorted |
| `capabilities` | `instance-credentials`, `managed-ca` | sorted |
| `network` | destinations: `host:port`, or `unix:` and an absolute path | sorted |
| `listeners` | listen addresses, as written | sorted |
| `file_roots` | the narrowest root each file access needs | sorted |
| `writes` | paths Vector writes, for the service sandbox's check | sorted |
| `assets` | `{name, sha256, kind, at}` of each valid asset reference | by `at` |

`at` is an RFC 6901 JSON Pointer into `config`, such as `/sinks/out/tls/verify_certificate`. It may point at a field that is absent: a required resource or a refused default. Lists hold no duplicates; strings sort by byte order.

## How needs follow from the table

### Scopes

Each component (`/sources/ID`, `/transforms/ID`, `/sinks/ID`) is the scope `SECTION/TYPE`. Each other top-level key is `global/KEY`, and each enrichment table (`/enrichment_tables/NAME`) is `enrichment_tables/TYPE`.

- A component without a string `type`, or with a type, key or table type the table doesn't list, adds `full_mode` `UNSUPPORTED_LOCAL_CAPABILITY` at its pointer.
- A `full` scope adds `full_mode` with the scope's `code` at its pointer (`LOCAL_API_DENIED` for `/api`). Nothing inside it is examined, except asset references.
- An `approval` component adds its type to `components`. Approval names the type, so `--component kafka` covers the source and the sink.
- `builtin` and `approval` scopes are examined field by field, as below.

### Rules

A rule path walks the scope's value: `.` into an object's key, `[]` into every item of a list, `*` into every value of an object. Global settings start at the configuration's root (`data_dir`, `proxy.http`); components and tables start at their own object. A rule matches every value it reaches, and none when the path is absent.

A rule or credential with `when` applies only when, for each listed field (a plain path), the value there exists and equals one of the listed values.

A value is present when it exists and is neither `null` nor `false`.

| Class | What it adds |
| --- | --- |
| `resource` | Each matched value is a resource of the rule's `kind` (below). With `required`, a rule that matches nothing adds its kind's code at the rule's path up to its first list or map step: `endpoints[]` points at `/endpoints`. |
| `refused` | A present value adds `full_mode` with the rule's code. |
| `constrained` | The value, or `default` when the field is absent, is checked: with `allowed`, a value not listed adds `full_mode` with the rule's code; with `refused_values`, a listed value does. |
| `options` | Each key of the matched object not in `allowed_keys` adds `full_mode` with the rule's code at that key's pointer. |
| `template` | Nothing: the value may hold a template. |
| `ambient` | A present value adds the rule's `capability`. |
| `data` | Nothing. |

A value that starts with `vectory-secret:` (a device secret, which stands only at credential fields) or `vectory-asset:` (below) is never read as a resource.

### Resources

A resource that can't be approved adds `full_mode` with its kind's code at the value's pointer: `NETWORK_DESTINATION_DENIED` for `url`, `host_port`, `host_port_list` and `unix_connect`; `LISTENER_DENIED` for `listen`; `FILE_ACCESS_DENIED` for `file`, `glob`, `dir` and `unix_listen`. A value that isn't a string can't be approved.

**Destinations.** A `url` starts with `SCHEME://`, the scheme one of the rule's `schemes` (`http` and `https` unless it lists others), compared in lower case. A `unix` URL is `unix://` and an absolute path, and adds `unix:` and that path, cleaned (below). Otherwise the authority runs to the first `/`, `?` or `#`, and must be a host and an optional port, nothing else: no credentials (`@`), escapes (`%`), backslashes, white space or control characters. The host is a bracketed IPv6 literal (`[::1]`) or ASCII letters, digits, `.`, `-` and `_`; it is lower-cased. The port is 1 to 65535 in decimal, written without leading zeros in the destination; without one, `http` means 80 and `https` 443, and any other scheme can't be approved. `host_port` is the same host and a required port, with no scheme. `host_port_list` is a comma-separated list of them, each trimmed of spaces; an empty item can't be approved. Each adds `host:port` to `network`.

**Listeners.** A `listen` value is added to `listeners` as written; an empty one can't be approved. The first `prometheus_exporter` sink, by ID, whose `address` is a loopback IP literal with a port (an IPv4 address in 127.0.0.0/8, or `[::1]`) and whose `inputs` name only `internal_metrics` sources, adds no listener: Vectory's monitoring exporter needs no allowance.

**Paths.** A `file`, `glob`, `dir`, `unix_listen` or `unix_connect` value must be absolute, without a `..` segment or a control character. It is cleaned: repeated `/` collapse, `.` segments and a trailing `/` go. The root it needs is the cleaned path; for a `glob`, the cleaned path up to the last `/` before its first `*`, `?` or `[`. A `unix_connect` path adds `unix:` and the path to `network` instead. A root that is `/`, or, with `host`, that equals, lies inside or contains `state_dir` or `managed_config_dir`, can't be approved; other roots go to `file_roots`, and to `writes` too when the rule says `writes`.

**Templates.** A resource rule with `template` accepts a template (`{{`) and checks its static part. In a `url`, the template must start after the authority; one that starts in the scheme or authority adds `full_mode` `TEMPLATE_RESOURCE_DENIED`, and the destination comes from the literal part. In a `file` rule with `base_dir`, a present sibling at that path decides alone: it is examined as its own rule, and the path adds nothing, because Vector confines every rendered path to it. Without it, the root is the cleaned literal prefix up to the last `/` before the first `{{` or `%`, or the cleaned path when there is neither; a value with `{{` whose literal prefix is relative or only `/` adds `TEMPLATE_RESOURCE_DENIED`.

### Strings

Every string value of an examined scope is checked against the table's `string_rules` in order, except under `/tests`, whose sample events are data. `contains` is a substring; `pattern` is a regular expression, unanchored, in syntax Go, Rust and JavaScript read alike. A rule with `except: template_fields` skips values matched by a `template` rule or a resource rule with `template`. The first rule that matches adds `full_mode` with its code at the value's pointer, and the value is read no further.

Every string value of an examined scope, `/tests` included, is then searched for a call of a function in `vrl_functions.refused`: the name, not preceded by a letter, digit, `_` or `.`, then optional white space, an optional `!` and `(`. A call adds `full_mode` `DYNAMIC_CAPABILITY_DENIED` at the value's pointer. A value adds at most one item with that code.

### Credentials

For each credential of an examined scope whose `when` holds, let the credential be the object at its path, or an empty object when it is absent. With its shape:

- each key of `refused_keys` that is present adds `full_mode` with that refusal's code at the key's pointer;
- with `kind_field`: a value listed in `refused_kinds` adds `full_mode` at the kind field's pointer, and one listed in `ambient_kinds` adds the shape's capability;
- without `kind_field`: the shape's capability is added when no `explicit` key is present, or when any `ambient_keys` key is.

### Assets

Any string value of the configuration that starts with `vectory-asset:` is an asset reference, in every scope and tier. It is valid when it is exactly `vectory-asset:NAME@sha256:HEX`, the fixture's `assets` list holds that name with that digest, and it stands at a field of `asset_fields` for its scope whose kind is the listed one. A valid reference adds `{name, sha256, kind, at}` to `assets` and, in an examined scope, the field's capability; it is no file to approve. Any other reference adds `refused` `ASSET_REFERENCE_REFUSED` at its pointer.

## What the fixtures don't cover

- Windows paths: drive letters, UNC paths and case-insensitive comparison. The fixtures use POSIX paths.
- Symbolic links inside an allowed root, which the agent checks on the host.
- Whether a destination or a file exists. Vector checks that on the device.

## Adding a fixture

Name the file after the case (`kafka-passthrough-kinit.json`), keep its configuration minimal and complete enough for Vector to load, and run `node scripts/check-capability-fixtures.mjs`. When the reference reading disagrees with your expectation, one of them is wrong: fix the table, this document or the fixture before the three needs functions follow.
