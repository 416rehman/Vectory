import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Offline, deterministic catalog generation from the pinned release's captured
// schema and source files. Capturing another executable is an explicit operation.
const root = path.resolve(import.meta.dirname, ".."),
  upstream = path.join(root, "vector-catalog/upstream"),
  generated = path.join(root, "dashboard/src/generated"),
  version = "0.58.0",
  commit = "2bcad9bbb84e201dcfd58c22b1f779290101b728",
  kinds = ["sources", "transforms", "sinks"],
  args = process.argv.slice(2),
  sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex"),
  canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value,
  json = (value) => JSON.stringify(canonical(value), null, 2) + "\n",
  readJSON = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const localTypes = {
  sources: [
    "demo_logs",
    "internal_metrics",
    "file",
    "http_server",
    "syslog",
    "opentelemetry",
  ],
  transforms: ["remap", "filter", "route", "sample", "reduce", "log_to_metric"],
  sinks: [
    "console",
    "blackhole",
    "http",
    "loki",
    "elasticsearch",
    "prometheus_exporter",
  ],
};
const excluded = new Set(["unit_test", "unit_test_stream"]);
const unixBranchComponents = [
  ["sources", "socket", "vector::sources::socket::SocketConfig"],
  ["sources", "syslog", "vector::sources::syslog::SyslogConfig"],
  ["sources", "fluent", "vector::sources::fluent::FluentConfig"],
  ["sources", "statsd", "vector::sources::statsd::StatsdConfig"],
  ["sinks", "statsd", "vector::sinks::statsd::config::StatsdSinkConfig"],
];
const sourcePaths = [
  "LICENSE",
  "src/sources/mod.rs",
  "src/transforms/mod.rs",
  "src/sinks/mod.rs",
  "src/sources/dnstap/mod.rs",
  "src/sources/file_descriptors/file_descriptor.rs",
  "src/sources/journald.rs",
  "src/sources/http_server.rs",
  "src/sinks/greptimedb/metrics/config.rs",
  ...["dnstap", "file_descriptor", "journald"].flatMap((type) => [
    `website/cue/reference/components/sources/${type}.cue`,
    `website/cue/reference/components/sources/generated/${type}.cue`,
  ]),
  ...unixBranchComponents.flatMap(([kind, type]) => [
    `website/cue/reference/components/${kind}/${type}.cue`,
    `website/cue/reference/components/${kind}/generated/${type}.cue`,
  ]),
];
await fs.mkdir(upstream, { recursive: true });
await fs.mkdir(generated, { recursive: true });
if (args.includes("--refresh-upstream")) {
  async function fetchPinned(url) {
    const response = await fetch(url);
    if (!response.ok)
      throw Error(`Pinned source fetch failed: ${response.status} ${url}`);
    return response.text();
  }
  // Four bounded concurrent downloads; every URL names the immutable commit.
  for (let start = 0; start < sourcePaths.length; start += 4) {
    await Promise.all(
      sourcePaths.slice(start, start + 4).map(async (relative) => {
        const text = await fetchPinned(
            `https://raw.githubusercontent.com/vectordotdev/vector/${commit}/${relative}`,
          ),
          file = path.join(upstream, relative);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text);
      }),
    );
  }
  const source = `https://api.github.com/repos/vectordotdev/vector/git/trees/${commit}?recursive=1`,
    tree = JSON.parse(await fetchPinned(source));
  if (tree.sha !== commit || tree.truncated)
    throw Error("Incomplete or mismatched pinned upstream tree");
  const entries = tree.tree.flatMap((entry) => {
    const match =
      /^website\/cue\/reference\/components\/(sources|transforms|sinks)\/generated\/([^/]+)\.cue$/.exec(
        entry.path,
      );
    return match
      ? [
          {
            kind: match[1],
            type: match[2],
            path: entry.path,
            git_blob_sha: entry.sha,
          },
        ]
      : [];
  });
  entries.sort(
    (a, b) =>
      kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
  );
  await fs.writeFile(
    path.join(upstream, "official-component-inventory.json"),
    json({ upstream_commit: commit, source, components: entries }),
  );
}
if (args.includes("--capture")) {
  const index = args.indexOf("--vector"),
    executable = index >= 0 && args[index + 1];
  if (!executable)
    throw Error(
      "--capture requires --vector PATH to the verified Vector 0.58.0 executable",
    );
  const run = (argv) =>
    execFileSync(executable, argv, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  const release = run(["--version"]).trim();
  if (!/^vector 0\.58\.0(?:\s|$)/.test(release))
    throw Error("Refusing a different Vector version: " + release);
  if (!release.includes("x86_64-pc-windows-msvc 2bcad9b"))
    throw Error(
      "This capture profile requires the pinned Windows x64 release; other profiles need explicit platform coverage review",
    );
  if (
    sha256(await fs.readFile(executable)) !==
    "019c41f4ae28543dd8e275a631f4d7b67a6aed3e3fba4c0ed37c4bdf054ac3a6"
  )
    throw Error(
      "Executable digest differs from the independently verified official release",
    );
  const schema = JSON.parse(run(["generate-schema"]));
  const inventory = JSON.parse(run(["list", "--format", "json"]));
  await fs.writeFile(
    path.join(upstream, "vector-schema-0.58.0.json"),
    json(schema),
  );
  await fs.writeFile(
    path.join(upstream, "vector-list-0.58.0.json"),
    json(inventory),
  );
  await fs.writeFile(
    path.join(upstream, "capture.json"),
    json({
      vector_version: version,
      release,
      platform: process.platform,
      architecture: process.arch,
      executable_sha256: sha256(await fs.readFile(executable)),
      schema_command: ["vector", "generate-schema"],
      inventory_command: ["vector", "list", "--format", "json"],
      upstream_commit: commit,
    }),
  );
}
const schemaFile = path.join(upstream, "vector-schema-0.58.0.json"),
  schemaBytes = await fs.readFile(schemaFile),
  schema = JSON.parse(schemaBytes),
  inventory = await readJSON(path.join(upstream, "vector-list-0.58.0.json")),
  capture = await readJSON(path.join(upstream, "capture.json"));
if (capture.vector_version !== version || capture.upstream_commit !== commit)
  throw Error("Captured source version does not match generator pin");
const components = [],
  duplicates = [];
for (const kind of kinds) {
  const definition = `vector::${kind}::${kind[0].toUpperCase()}${kind.slice(1)}`,
    variants = schema.definitions[definition]?.oneOf,
    singular = kind.slice(0, -1),
    outerKey = Object.keys(schema.definitions).find((key) =>
      key.startsWith(
        `vector::config::${singular}::${singular[0].toUpperCase()}${singular.slice(1)}Outer`,
      ),
    ),
    common = schema.definitions[outerKey]?.allOf?.filter(
      (entry) => entry.$ref !== `#/definitions/${definition}`,
    );
  if (!variants?.length || !common?.length)
    throw Error("Unsupported upstream schema shape: " + kind);
  const seen = new Set(),
    normalizedVariants = [];
  for (const variant of variants) {
    const type = variant.allOf
      ?.map((entry) => entry.properties?.type?.const)
      .find(Boolean);
    if (!type)
      throw Error("Upstream component lacks a type discriminator: " + kind);
    if (excluded.has(type)) continue;
    if (seen.has(type)) {
      duplicates.push({ kind, type });
      continue;
    }
    seen.add(type);
    normalizedVariants.push(variant);
    const schemaKey = `vectory::components::${kind}::${type}`;
    schema.definitions[schemaKey] = {
      description: variant.description,
      allOf: [...common, variant],
      unevaluatedProperties: false,
    };
    const locallyAllowed = localTypes[kind].includes(type),
      configRef = variant.allOf.find((entry) => entry.$ref)?.$ref,
      configMetadata =
        schema.definitions[configRef?.replace("#/definitions/", "")]?._metadata,
      deprecated = !!configMetadata?.deprecated,
      alias = {
        "sources/http": "http_server",
        "sinks/greptimedb": "greptimedb_metrics",
      }[`${kind}/${type}`];
    components.push({
      kind,
      type,
      label: variant._metadata?.["docs::human_name"] || type,
      description: variant.description || "",
      schema_ref: `#/definitions/${schemaKey}`,
      docs_url: `https://vector.dev/docs/reference/configuration/${kind}/${type}/`,
      source_url: `https://github.com/vectordotdev/vector/tree/${commit}/src/${kind}`,
      device_capability: locallyAllowed ? "allowed" : "requires_review",
      locallyAllowed,
      coverage: "native-generated-schema",
      ...(deprecated
        ? {
            deprecated: true,
            deprecation_message:
              typeof configMetadata.deprecated === "string"
                ? configMetadata.deprecated
                : "Deprecated compatibility alias.",
          }
        : {}),
      ...(alias
        ? {
            alias_of: alias,
            docs_url: `https://vector.dev/docs/reference/configuration/${kind}/${alias}/`,
          }
        : {}),
      platforms: type === "windows_event_log" ? ["windows"] : [],
      platform_coverage: {
        windows: "schema-generated",
        linux: "not-run",
        macos: "not-run",
      },
    });
  }
  const expected = [
    ...new Set(inventory[kind].filter((type) => !excluded.has(type))),
  ].sort();
  if (JSON.stringify([...seen].sort()) !== JSON.stringify(expected))
    throw Error("Schema and executable inventory disagree: " + kind);
  schema.definitions[definition].oneOf = normalizedVariants;
}

// Additional Unix-only components are captured separately from the same pinned
// upstream source, and have explicit coverage metadata. Never silently infer
// that a component is locally authorized from its presence in this catalog.
// The three generated CUE documents are concrete metadata, not arbitrary CUE
// programs. This intentionally limited parser rejects expressions/references.
// It supports strings (including multiline), primitive values, objects, arrays,
// and CUE's nested field shorthand. New syntax requires an explicit review.
function parseConcreteCue(text) {
  text = text.replace(/^package metadata\s*/, "");
  const tokens = [];
  let offset = 0;
  while (offset < text.length) {
    const rest = text.slice(offset);
    const whitespace = /^(?:\s+|\/\/[^\n]*(?:\n|$))/.exec(rest);
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    if (rest.startsWith('"""')) {
      const end = text.indexOf('"""', offset + 3);
      if (end < 0) throw Error("Unterminated CUE multiline string");
      const lines = text
        .slice(offset + 3, end)
        .replace(/^\r?\n/, "")
        .replace(/\r?\n[\t ]*$/, "")
        .split(/\r?\n/);
      const indent = Math.min(
        ...lines
          .filter((line) => line.trim())
          .map((line) => /^\s*/.exec(line)[0].length),
      );
      const value = lines
        .map((line) =>
          line.slice(Math.min(indent, /^\s*/.exec(line)[0].length)),
        )
        .join("\n")
        .replace(
          /\\(["\\nrt])/g,
          (_, escape) =>
            ({ '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t" })[escape],
        );
      if (value.includes("\\("))
        throw Error("CUE interpolation is not supported in vendored metadata");
      tokens.push({ kind: "value", value });
      offset = end + 3;
      continue;
    }
    if (rest[0] === '"') {
      const literal = /^"(?:\\.|[^"\\])*"/.exec(rest)?.[0];
      if (!literal) throw Error("Invalid CUE string");
      tokens.push({ kind: "value", value: JSON.parse(literal) });
      offset += literal.length;
      continue;
    }
    if ("{}[]:,".includes(rest[0])) {
      tokens.push({ kind: rest[0] });
      offset++;
      continue;
    }
    const atom =
      /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z_0-9]*)/.exec(
        rest,
      )?.[0];
    if (!atom) throw Error("Unsupported CUE syntax at: " + rest.slice(0, 40));
    tokens.push({ kind: "atom", value: atom });
    offset += atom.length;
  }
  let at = 0;
  const consume = (kind) => {
    const token = tokens[at++];
    if (token?.kind !== kind) throw Error("Expected CUE " + kind);
    return token;
  };
  function field() {
    const key = tokens[at++];
    if (
      !key ||
      !["value", "atom"].includes(key.kind) ||
      typeof key.value !== "string"
    )
      throw Error("Invalid CUE field");
    consume(":");
    return [key.value, value()];
  }
  function object(end) {
    const result = {};
    while (at < tokens.length && tokens[at].kind !== end) {
      if (tokens[at].kind === ",") {
        at++;
        continue;
      }
      const [key, item] = field();
      if (Object.hasOwn(result, key))
        throw Error("Duplicate CUE metadata field " + key);
      result[key] = item;
    }
    if (end) consume(end);
    return result;
  }
  function value() {
    if (tokens[at]?.kind === "{") {
      at++;
      return object("}");
    }
    if (tokens[at]?.kind === "[") {
      at++;
      const list = [];
      while (tokens[at]?.kind !== "]") {
        list.push(value());
        if (tokens[at]?.kind === ",") at++;
      }
      consume("]");
      return list;
    }
    if (tokens[at + 1]?.kind === ":") {
      const [key, item] = field();
      return { [key]: item };
    }
    const token = tokens[at++];
    if (token?.kind === "value") return token.value;
    if (token?.kind === "atom") {
      if (["true", "false", "null"].includes(token.value))
        return JSON.parse(token.value);
      if (/^-?\d/.test(token.value)) return Number(token.value);
    }
    throw Error("Unsupported CUE metadata value " + token?.value);
  }
  return object();
}
function projectOption(option) {
  const types = Object.entries(option.type || {});
  if (types.length !== 1) throw Error("Expected one concrete CUE option type");
  const [type, constraints] = types[0],
    typeMap = {
      bool: "boolean",
      string: "string",
      ascii_char: "string",
      uint: "integer",
      int: "integer",
      float: "number",
      object: "object",
      array: "array",
    };
  if (!typeMap[type]) throw Error("Unsupported CUE option type: " + type);
  const out = { type: typeMap[type] };
  if (type === "uint") out.minimum = 0;
  if (type === "ascii_char")
    Object.assign(out, {
      minLength: 1,
      maxLength: 1,
      pattern: "^[\\u0000-\\u007f]$",
    });
  if (option.description) out.description = option.description;
  if (constraints.unit) out._metadata = { "docs::type_unit": constraints.unit };
  if (option.deprecated) out.deprecated = true;
  if (option.deprecated_message)
    out["x-vectory-deprecation-message"] = option.deprecated_message;
  if (option.relevant_when)
    out["x-vectory-relevant-when"] = option.relevant_when;
  if (Object.hasOwn(constraints, "default") && constraints.default !== null)
    out.default = constraints.default;
  if (constraints.examples) out.examples = constraints.examples;
  if (constraints.enum) out.enum = Object.keys(constraints.enum);
  if (type === "array") out.items = projectOption(constraints.items);
  if (type === "object")
    Object.assign(out, projectOptions(constraints.options || {}));
  return out;
}
function projectOptions(options) {
  const properties = {},
    required = [],
    conditional = [];
  let additionalProperties = false;
  for (const [key, option] of Object.entries(options)) {
    if (key === "*") {
      additionalProperties = projectOption(option);
      continue;
    }
    properties[key] = projectOption(option);
    if (option.required && !option.relevant_when) required.push(key);
    if (option.required && option.relevant_when) {
      const match = /^([A-Za-z_][A-Za-z_0-9]*) = "([^"]+)"$/.exec(
        option.relevant_when,
      );
      if (match)
        conditional.push({
          if: {
            required: [match[1]],
            properties: { [match[1]]: { const: match[2] } },
          },
          then: { required: [key] },
        });
    }
  }
  return {
    type: "object",
    properties,
    additionalProperties,
    ...(required.length ? { required } : {}),
    ...(conditional.length ? { allOf: conditional } : {}),
  };
}
for (const [type, label, description, platforms] of [
  [
    "dnstap",
    "Dnstap",
    "Collect DNS telemetry from a dnstap socket.",
    ["linux", "macos"],
  ],
  [
    "file_descriptor",
    "File descriptor",
    "Collect logs from an existing file descriptor.",
    ["linux", "macos"],
  ],
  [
    "journald",
    "Journald",
    "Collect logs from the systemd journal using journalctl.",
    ["linux"],
  ],
]) {
  const relative = `website/cue/reference/components/sources/generated/${type}.cue`,
    cue = await fs.readFile(path.join(upstream, relative), "utf8"),
    projected = projectOptions(
      parseConcreteCue(cue).generated.components.sources[type].configuration,
    ),
    key = `vectory::components::sources::${type}`;
  // This optional hidden field is absent from public CUE docs but present in
  // each pinned Rust struct. Keep it explicit rather than claiming a closed
  // schema cannot accept it. Runtime serde validation remains authoritative.
  projected.properties.log_namespace = {
    type: ["boolean", "null"],
    description: "Override the global log namespace setting.",
    _metadata: { "docs::hidden": true },
  };
  projected.properties.type = { const: type, type: "string" };
  projected.required = [...new Set(["type", ...(projected.required || [])])];
  // SourceOuter common fields are independent of the platform implementation.
  for (const common of schema.definitions[
    "vector::config::source::SourceOuter"
  ].allOf.filter((entry) => entry.properties))
    Object.assign(projected.properties, common.properties);
  schema.definitions[key] = projected;
  schema.definitions["vector::sources::Sources"].oneOf.push({
    $ref: `#/definitions/${key}`,
  });
  components.push({
    kind: "sources",
    type,
    label,
    description,
    schema_ref: `#/definitions/${key}`,
    locallyAllowed: false,
    device_capability: "requires_review",
    coverage: "pinned-cue-projection",
    coverage_note:
      "Public fields projected from pinned generated CUE; hidden log_namespace added from Rust. This is editor metadata, not a complete runtime validation schema. Native target validation is required.",
    platforms,
    platform_coverage: {
      windows: "not-compiled",
      linux: "source-reviewed-not-run",
      macos:
        type === "journald"
          ? "requires-systemd-journalctl"
          : "source-reviewed-not-run",
    },
    source_url: `https://github.com/vectordotdev/vector/blob/${commit}/${relative}`,
    source_sha256: sha256(cue),
    docs_url: `https://vector.dev/docs/reference/configuration/sources/${type}/`,
  });
}

// The Windows executable omits Unix variants of otherwise cross-platform
// components. Add only modes/fields present in the same commit's generated CUE;
// retain native definitions for common nested codecs and TLS metadata.
const supplementalBranches = [];
for (const [kind, type, definition] of unixBranchComponents) {
  const relative = `website/cue/reference/components/${kind}/generated/${type}.cue`,
    cue = await fs.readFile(path.join(upstream, relative), "utf8"),
    options =
      parseConcreteCue(cue).generated.components[kind][type].configuration,
    config = schema.definitions[definition];
  if (!config)
    throw Error("Missing native definition for Unix supplement: " + definition);
  const compositions = [];
  function visit(value) {
    compositions.push(value);
    for (const key of ["allOf", "oneOf", "anyOf"])
      for (const branch of value[key] || []) visit(branch);
  }
  visit(config);
  const unions = compositions.filter(
    (entry) =>
      entry.oneOf && entry._metadata?.["docs::enum_tag_field"] === "mode",
  );
  if (unions.length !== 1)
    throw Error("Ambiguous native socket mode union: " + definition);
  const union = unions[0],
    fields = Object.assign(
      {},
      ...compositions.map((entry) => entry.properties || {}),
    ),
    modes = Object.keys(options.mode.type.string.enum).filter((mode) =>
      mode.startsWith("unix"),
    );
  if (!modes.length) throw Error("Pinned CUE has no Unix modes: " + relative);
  for (const mode of modes) {
    const properties = {},
      required = ["mode"];
    for (const [name, option] of Object.entries(options)) {
      if (name === "mode") continue;
      if (option.relevant_when) {
        const terms = option.relevant_when.split(" or ");
        if (terms.some((term) => !/^mode = "[a-z_]+"$/.test(term)))
          throw Error(
            "Unreviewed Unix mode condition: " + option.relevant_when,
          );
        if (!terms.includes(`mode = "${mode}"`)) continue;
      }
      properties[name] = fields[name] || projectOption(option);
      if (option.required) required.push(name);
    }
    if (fields.log_namespace) properties.log_namespace = fields.log_namespace;
    properties.mode = {
      const: mode,
      type: "string",
      description: options.mode.type.string.enum[mode],
    };
    union.oneOf.push({
      type: "object",
      properties,
      required,
      description: options.mode.type.string.enum[mode],
      _metadata: {
        "docs::human_name":
          mode === "unix" ? "Unix socket" : mode.replace("unix_", "Unix "),
        logical_name: mode,
      },
      "x-vectory-platforms": ["linux", "macos"],
      "x-vectory-coverage": "pinned-cue-projection",
    });
    supplementalBranches.push({
      kind,
      type,
      mode,
      fields: Object.keys(properties).sort(),
      source: relative,
      source_sha256: sha256(cue),
    });
  }
  const component = components.find(
    (entry) => entry.kind === kind && entry.type === type,
  );
  component.coverage = "native-generated-schema-with-pinned-unix-branches";
  component.coverage_note =
    "Windows-generated common fields and modes, with Unix socket branches projected from pinned generated CUE. Unix activation has not been run; the target Vector runtime remains authoritative.";
  component.supplemental_source_url = `https://github.com/vectordotdev/vector/blob/${commit}/${relative}`;
  component.supplemental_source_sha256 = sha256(cue);
  component.platform_coverage.linux = "unix-branches-source-reviewed-not-run";
  component.platform_coverage.macos = "unix-branches-source-reviewed-not-run";
}

// Credentials. Vector types a credential as SensitiveString, directly or through
// its Option wrapper, and marks that definition `_metadata.sensitive`. Every
// field whose type resolves to it carries the same mark here, so the editor
// renders a secret reference picker. A few credentials are plain strings in the
// pinned schema; they are named below by definition and reviewed with each
// Vector upgrade. scripts/generate-secret-fields.mjs turns the resulting paths
// into the agent's and the server's field tables.
const sensitiveRef =
    "#/definitions/vector_common::sensitive_string::SensitiveString",
  optionalSensitiveRef =
    "#/definitions/core::option::Option<vector_common::sensitive_string::SensitiveString>";
const reviewedCredentials = [
  // [definition, JSON pointer inside it, why it is a credential]
  [
    "vector_core::tls::settings::TlsConfig",
    "/properties/key_pass",
    "passphrase of the TLS private key",
  ],
  [
    "vector::common::mqtt::MqttCommonConfig",
    "/properties/password",
    "MQTT password",
  ],
  [
    "vector::sources::okta::client::OktaConfig",
    "/properties/token",
    "Okta API token",
  ],
  [
    "vector::sinks::prometheus::remote_write::config::RemoteWriteConfig",
    "/allOf/0/properties/auth/oneOf/1/oneOf/0/properties/password",
    "basic authentication password",
  ],
  [
    "vector::sinks::redis::config::RedisSinkConfig",
    "/allOf/0/properties/sentinel_connect/oneOf/1/properties/connections/oneOf/1/properties/password",
    "Redis Sentinel connection password",
  ],
  // Basic authentication user names. Vectory has always accepted a local
  // secret in `auth.user` and refused plain text there.
  ["vector::http::Auth", "/oneOf/0/properties/user", "basic authentication user"],
  [
    "vector::sinks::elasticsearch::config::ElasticsearchConfig",
    "/allOf/0/properties/auth/oneOf/1/oneOf/0/properties/user",
    "basic authentication user",
  ],
  [
    "vector::sinks::prometheus::remote_write::config::RemoteWriteConfig",
    "/allOf/0/properties/auth/oneOf/1/oneOf/0/properties/user",
    "basic authentication user",
  ],
  [
    "vector::common::http::server_auth::HttpServerAuthConfig",
    "/oneOf/0/properties/username",
    "basic authentication user",
  ],
];
const stringTyped = (node) =>
  node?.type === "string" ||
  (Array.isArray(node?.type) &&
    node.type.includes("string") &&
    node.type.every((type) => type === "string" || type === "null"));
const markSensitive = (node) =>
  (node._metadata = { ...node._metadata, sensitive: true });
(function markCredentialReferences(value) {
  if (Array.isArray(value)) value.forEach(markCredentialReferences);
  else if (value && typeof value === "object") {
    if (value.$ref === sensitiveRef || value.$ref === optionalSensitiveRef)
      markSensitive(value);
    Object.values(value).forEach(markCredentialReferences);
  }
})(schema.definitions);
for (const [definition, pointer, why] of reviewedCredentials) {
  const node = pointer
    .slice(1)
    .split("/")
    .reduce((at, key) => at?.[key], schema.definitions[definition]);
  if (!stringTyped(node) || node.$ref || node.properties || node.items)
    throw Error(
      `Reviewed credential is no longer a plain string field (${why}): ${definition}${pointer}`,
    );
  if (node._metadata?.sensitive)
    throw Error(
      `Vector now marks this credential itself; drop the review entry: ${definition}${pointer}`,
    );
  markSensitive(node);
}
// Sensitive leaf paths of one component: `a.b` for fields, `[]` for list items
// and `*` for map values. Alternatives (oneOf/anyOf) contribute their union.
function sensitivePaths(root) {
  const found = new Set();
  const join = (path, key) => {
    if (/[.[\]*]/.test(key))
      throw Error("Field name cannot be expressed as a path: " + key);
    return path ? `${path}.${key}` : key;
  };
  const mapValue = (path) => (path ? `${path}.*` : "*");
  function visit(node, path, refs) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (node.$ref === sensitiveRef) {
      found.add(path);
      return;
    }
    if (
      node._metadata?.sensitive === true &&
      stringTyped(node) &&
      !node.properties &&
      !node.items
    ) {
      found.add(path);
      return;
    }
    if (typeof node.$ref === "string" && !refs.includes(node.$ref)) {
      const target = node.$ref
        .slice(2)
        .split("/")
        .reduce(
          (at, key) => at?.[key.replaceAll("~1", "/").replaceAll("~0", "~")],
          schema,
        );
      visit(target, path, [...refs, node.$ref]);
    }
    for (const key of ["allOf", "oneOf", "anyOf"])
      for (const branch of node[key] || []) visit(branch, path, refs);
    for (const key of ["then", "else"]) visit(node[key], path, refs);
    for (const [key, child] of Object.entries(node.properties || {}))
      visit(child, join(path, key), refs);
    for (const child of Object.values(node.patternProperties || {}))
      visit(child, mapValue(path), refs);
    if (node.additionalProperties && typeof node.additionalProperties === "object")
      visit(node.additionalProperties, mapValue(path), refs);
    for (const child of [
      ...(Array.isArray(node.items) ? node.items : [node.items]),
      ...(node.prefixItems || []),
    ])
      visit(child, `${path}[]`, refs);
  }
  visit(root, "", []);
  if (found.has("")) throw Error("A component cannot itself be a credential");
  return [...found].sort();
}
for (const component of components) {
  const fields = sensitivePaths({ $ref: component.schema_ref });
  if (fields.length) component.sensitive_fields = fields;
}

components.sort(
  (a, b) =>
    kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
    (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
);
const official = await readJSON(
  path.join(upstream, "official-component-inventory.json"),
);
if (official.upstream_commit !== commit)
  throw Error("Official inventory is from a different revision");
const tuples = (entries) =>
  entries
    .filter((entry) => !excluded.has(entry.type))
    .map((entry) => `${entry.kind}/${entry.type}`)
    .sort();
if (
  JSON.stringify(tuples(components)) !==
  JSON.stringify(tuples(official.components))
)
  throw Error(
    "Catalog does not cover the complete pinned official production component inventory",
  );
function verifyReferences(value) {
  if (!value || typeof value !== "object") return;
  if (value.$ref) {
    if (!value.$ref.startsWith("#/"))
      throw Error("Unexpected nonlocal schema reference: " + value.$ref);
    const resolved = value.$ref
      .slice(2)
      .split("/")
      .reduce(
        (node, segment) =>
          node?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
        schema,
      );
    if (resolved === undefined)
      throw Error("Unresolved schema reference: " + value.$ref);
  }
  Object.values(value).forEach(verifyReferences);
}
verifyReferences(schema);
schema.$comment =
  "Derived from Vector 0.58.0 (MPL-2.0); see vector-catalog/upstream/LICENSE and provenance.json. Native enums omit test-only/duplicate registrations, and include explicitly marked Unix CUE projections. Vector runtime validation remains authoritative.";
const schemaOutput = json(schema),
  catalog = {
    vector_version: version,
    upstream_commit: commit,
    schema_sha256: sha256(schemaOutput),
    captured_schema_sha256: sha256(schemaBytes),
    schema_standard: schema.$schema,
    experimental_upstream_schema: true,
    exclusions: [...excluded],
    duplicate_registrations: duplicates,
    coverage_note:
      "Component availability depends on the target Vector build. Empty platforms means no platform restriction recorded, not platform certification. Generated schemas guide editing; actual target Vector validation and local agent policy decide activation.",
    components,
  };
const provenance = {
  vector_version: version,
  upstream_commit: commit,
  upstream_repository: "https://github.com/vectordotdev/vector",
  upstream_license: "MPL-2.0",
  license_file: "LICENSE",
  capture,
  experimental_upstream_schema: true,
  captured_schema_sha256: sha256(schemaBytes),
  generated_schema_sha256: sha256(schemaOutput),
  generated_catalog_sha256: sha256(json(catalog)),
  generator_sha256: sha256(
    await fs.readFile(path.join(root, "scripts/generate-vector-catalog.mjs")),
  ),
  inventory_verification:
    "Exact kind/type set equals the pinned official generated CUE inventory after excluding unit_test and unit_test_stream.",
  native_components: components.filter((entry) =>
    entry.coverage.startsWith("native-generated-schema"),
  ).length,
  supplemental_branches: supplementalBranches,
  supplemental_components: components
    .filter((entry) => entry.coverage === "pinned-cue-projection")
    .map((entry) => entry.type),
  transformations: [
    "Remove duplicate windows_event_log registration from generated enum",
    "Exclude internal unit test component registrations",
    "Add per-component schemas including common outer fields",
    "Project three Unix generated CUE metadata documents with explicit coverage limitations",
    "Restore six Unix socket mode branches in five cross-platform components from pinned generated CUE",
    "Mark credential fields with _metadata.sensitive: every field whose type resolves to SensitiveString, plus the reviewed plain-string credentials, and list each component's sensitive_fields",
  ],
  reviewed_credentials: reviewedCredentials.map(
    ([definition, pointer, reason]) => ({ definition, pointer, reason }),
  ),
  source_files: await Promise.all(
    [
      ...sourcePaths,
      "official-component-inventory.json",
      "vector-list-0.58.0.json",
    ].map(async (relative) => ({
      path: relative,
      sha256: sha256(await fs.readFile(path.join(upstream, relative))),
      ...(sourcePaths.includes(relative)
        ? {
            url: `https://raw.githubusercontent.com/vectordotdev/vector/${commit}/${relative}`,
          }
        : {}),
    })),
  ),
};
async function emit(file, value) {
  if (args.includes("--check")) {
    if ((await fs.readFile(file, "utf8")) !== value)
      throw Error("Generated file is stale: " + file);
  } else await fs.writeFile(file, value);
}
await emit(path.join(generated, "vector-schema.json"), schemaOutput);
await emit(path.join(generated, "vector-catalog.json"), json(catalog));
await emit(path.join(upstream, "provenance.json"), json(provenance));
console.log(
  json({
    vector_version: version,
    counts: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        components.filter((entry) => entry.kind === kind).length,
      ]),
    ),
    total: components.length,
    schema_sha256: catalog.schema_sha256,
  }),
);
