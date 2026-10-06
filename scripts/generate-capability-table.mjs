// The capability table: what restricted mode allows of each component type,
// global setting and enrichment table of the pinned Vector, by tier (builtin,
// approval, full), with the fields that name resources, the fields it refuses,
// the fields that may hold templates and the credential shapes that reach the
// host's own cloud identity. One reviewed source is written three times:
//
//   vector-catalog/capabilities.json                  the reviewed source
//   agent/internal/agent/capability_table_generated.go the agent decides with its own copy
//   server/src/capability_table.rs                     the server explains deploy needs
//   dashboard/src/generated/capability-table.json      the editor and the deploy review
//
// It also writes restricted mode's lists into docs/user/security.md. Shared
// schema types (TLS, proxy, credentials) are classified once in the source and
// expanded here to every path where a reviewed component uses them.
//
//   node scripts/generate-capability-table.mjs          regenerate
//   node scripts/generate-capability-table.mjs --check  fail when an output is
//                                                       stale or the table is
//                                                       incomplete (CI)
//
// Completeness is checked against the pinned schema on every run: every
// component has a tier, and every field of a built-in or approval component
// that looks like a resource, by name or by schema type, is classified. A new
// Vector release that adds such a field fails until someone reviews it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SECTIONS = ["sources", "transforms", "sinks"];
export const TIERS = ["builtin", "approval", "full"];
export const RESOURCE_KINDS = [
  "url",
  "host_port",
  "host_port_list",
  "listen",
  "file",
  "glob",
  "dir",
  "unix_listen",
  "unix_connect",
];
export const CLASSES = [
  "resource",
  "refused",
  "constrained",
  "options",
  "template",
  "ambient",
  "data",
];
export const CAPABILITIES = ["instance-credentials", "managed-ca"];
export const ASSET_KINDS = ["csv", "mmdb", "pem_certificates"];
// Rules whose class covers every field below them.
const COVERING = new Set(["refused", "options", "data", "ambient"]);

// Field names that look like a resource: a path, an address, a program or a
// passthrough map. A match in a built-in or approval component needs a rule.
// "path" counts anywhere in a name, and the words for an address or a program
// count anywhere between underscores ("endpoint_override", "url_template");
// the other words count as the whole name or its last word, because "host_key"
// and "file_key" name event fields.
const RESOURCE_NAME = new RegExp(
  [
    "path",
    "(?:^|_)(?:endpoints?|uris?|urls?|address(?:es)?|sockets?|commands?|cmd|exec|programs?|scripts?)(?:_|$)",
    "^(?:dir|dirs|directory|directories|host|hosts|hostname|hostnames|server|servers|include|exclude|args|bootstrap_servers|connection_string|dsn|assume_role|imds|profile|credentials)$",
    "_(?:file|files|dir|dirs|directory|directories|host|hosts|server|servers|options|args|location)$",
  ].join("|"),
);
// Schema types that hold a resource.
const RESOURCE_TYPES = new Set([
  "stdlib::PathBuf",
  "std::path::PathBuf",
  "stdlib::SocketAddr",
  "vector::sources::util::net::SocketListenAddr",
  "vector::sinks::util::uri::UriSerde",
  "vector::sinks::util::uri::HttpEndpoint",
]);
// Schema types that must be classified as a whole wherever a reviewed
// component uses them: TLS files and verification, proxies, credentials and
// regional endpoints.
const REVIEWED_TYPES = new Set([
  "vector_core::tls::settings::TlsConfig",
  "vector_core::tls::settings::TlsEnableableConfig",
  "vector_core::tls::settings::TlsSourceConfig",
  "vector_core::config::proxy::ProxyConfig",
  "vector::aws::auth::AwsAuthentication",
  "vector::aws::auth::ImdsAuthentication",
  "vector::aws::region::RegionOrEndpoint",
  "vector::gcp::GcpAuthConfig",
  "vector::sinks::azure_common::config::AzureAuthentication",
  "vector::http::Auth",
]);
const TEMPLATE_TYPES = new Set([
  "vector::template::Template",
  "vector::template::UnconfinedTemplate",
  "vector::template::UnsignedIntTemplate",
]);

const root = path.resolve(import.meta.dirname, "..");
const SOURCE = "vector-catalog/capabilities.json";
const SCHEMA = "dashboard/src/generated/vector-schema.json";
const CATALOG = "dashboard/src/generated/vector-catalog.json";
const GENERATOR = "scripts/generate-capability-table.mjs";
export const OUTPUTS = {
  go: "agent/internal/agent/capability_table_generated.go",
  rust: "server/src/capability_table.rs",
  json: "dashboard/src/generated/capability-table.json",
  docs: "docs/user/security.md",
};

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const unwrap = (ref) => {
  let name = ref.replace(/^#\/definitions\//, "");
  for (;;) {
    const inner = /^core::option::Option<(.*)>$/.exec(name);
    if (!inner) return name;
    name = inner[1];
  }
};
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const segments = (fieldPath) => (fieldPath ? fieldPath.split(".") : []);
const join = (base, rel) => (!base ? rel : !rel ? base : `${base}.${rel}`);
const nameOf = (fieldPath) =>
  (segments(fieldPath).at(-1) || "").replace(/(?:\[\])+$/, "");
// Every path above fieldPath, nearest first: a.b[].c -> a.b[], a.b, a.
function ancestors(fieldPath) {
  const out = [];
  let rest = fieldPath;
  for (;;) {
    const cut = Math.max(
      rest.lastIndexOf("."),
      rest.endsWith("[]") ? rest.length - 2 : -1,
    );
    if (cut <= 0) break;
    rest = rest.slice(0, cut);
    out.push(rest);
  }
  return out;
}

/**
 * Every field path of a schema node, with the schema types it resolves through
 * and whether Vector reads it as a template. A path uses "." between fields,
 * "[]" for list items and "*" for map values, like the device-secret table.
 */
export function fieldsOf(schema, node) {
  const fields = new Map();
  const resolve = (ref) =>
    ref
      .slice(2)
      .split("/")
      .reduce(
        (at, key) => at?.[key.replaceAll("~1", "/").replaceAll("~0", "~")],
        schema,
      );
  const entry = (fieldPath) => {
    if (!fields.has(fieldPath))
      fields.set(fieldPath, { types: new Set(), template: false });
    return fields.get(fieldPath);
  };
  function visit(value, fieldPath, refs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const here = entry(fieldPath);
    if (value._metadata?.["docs::templateable"] === true) here.template = true;
    if (typeof value.$ref === "string") {
      const name = unwrap(value.$ref);
      here.types.add(name);
      if (TEMPLATE_TYPES.has(name)) here.template = true;
      if (!refs.includes(value.$ref))
        visit(resolve(value.$ref), fieldPath, [...refs, value.$ref]);
    }
    for (const key of ["allOf", "oneOf", "anyOf"])
      for (const branch of value[key] || []) visit(branch, fieldPath, refs);
    for (const key of ["then", "else"]) visit(value[key], fieldPath, refs);
    for (const [key, child] of Object.entries(value.properties || {})) {
      if (/[.[\]*]/.test(key))
        throw Error(`Field name cannot be expressed as a path: ${key}`);
      visit(child, join(fieldPath, key), refs);
    }
    for (const child of Object.values(value.patternProperties || {}))
      visit(child, join(fieldPath, "*"), refs);
    if (
      value.additionalProperties &&
      typeof value.additionalProperties === "object"
    )
      visit(value.additionalProperties, join(fieldPath, "*"), refs);
    for (const child of [
      ...(Array.isArray(value.items) ? value.items : [value.items]),
      ...(value.prefixItems || []),
    ])
      visit(child, `${fieldPath}[]`, refs);
  }
  visit(node, "", []);
  return fields;
}

const RULE_KEYS = new Set([
  "class",
  "kind",
  "schemes",
  "template",
  "base_dir",
  "writes",
  "required",
  "when",
  "default",
  "allowed",
  "refused_values",
  "allowed_keys",
  "asset",
  "asset_capability",
  "capability",
  "code",
  "reason",
  "review",
]);

/** Structural problems in one rule of the source, as readable sentences. */
function ruleProblems(where, rule, codes) {
  const problems = [];
  const bad = (text) => problems.push(`${where}: ${text}`);
  if (!rule || typeof rule !== "object" || Array.isArray(rule))
    return [`${where}: a rule must be an object`];
  for (const key of Object.keys(rule))
    if (!RULE_KEYS.has(key)) bad(`unknown key "${key}"`);
  if (!CLASSES.includes(rule.class))
    bad(`class must be one of ${CLASSES.join(", ")}`);
  if (rule.class === "resource" && !RESOURCE_KINDS.includes(rule.kind))
    bad(`a resource needs a kind: ${RESOURCE_KINDS.join(", ")}`);
  if (rule.class !== "resource")
    for (const key of [
      "kind",
      "schemes",
      "template",
      "base_dir",
      "writes",
      "required",
    ])
      if (key in rule) bad(`"${key}" belongs only to resources`);
  if (rule.schemes && rule.kind !== "url")
    bad(`"schemes" belongs only to url resources`);
  if (["refused", "constrained", "options"].includes(rule.class)) {
    if (!codes.includes(rule.code)) bad(`needs a refusal code from "codes"`);
    if (typeof rule.reason !== "string" || !rule.reason) bad("needs a reason");
  } else if ("code" in rule)
    bad(`"code" belongs to refusals; a resource's code comes from its kind`);
  if (
    rule.class === "constrained" &&
    !Array.isArray(rule.allowed) === !Array.isArray(rule.refused_values)
  )
    bad(`a constrained field lists either "allowed" or "refused_values"`);
  if (rule.class !== "constrained")
    for (const key of ["allowed", "refused_values", "default"])
      if (key in rule) bad(`"${key}" belongs only to constrained fields`);
  if ((rule.class === "options") !== Array.isArray(rule.allowed_keys))
    bad(`"allowed_keys" belongs to, and is required by, options`);
  if (rule.class === "ambient" && !CAPABILITIES.includes(rule.capability))
    bad(`an ambient field names its capability`);
  if (rule.class !== "ambient" && "capability" in rule)
    bad(`"capability" belongs to ambient fields`);
  if (rule.asset && !ASSET_KINDS.includes(rule.asset))
    bad(`asset must be one of ${ASSET_KINDS.join(", ")}`);
  if (rule.asset_capability && !CAPABILITIES.includes(rule.asset_capability))
    bad(`asset_capability must be one of ${CAPABILITIES.join(", ")}`);
  if (rule.asset_capability && !rule.asset) bad(`asset_capability needs asset`);
  if (rule.when) {
    if (
      typeof rule.when !== "object" ||
      Array.isArray(rule.when) ||
      !Object.keys(rule.when).length
    )
      bad(`"when" maps a field path to the values it must hold`);
    else
      for (const [field, values] of Object.entries(rule.when))
        if (!Array.isArray(values) || !values.length)
          bad(`when.${field} must be a non-empty list`);
  }
  return problems;
}

function checkKeys(where, value, keys, problems) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${where}: must be an object`);
    return false;
  }
  for (const key of Object.keys(value))
    if (!keys.includes(key)) problems.push(`${where}: unknown key "${key}"`);
  return true;
}

/**
 * Expands the reviewed source against the pinned schema and catalog. Returns
 * the table every output is rendered from, and every problem: a structural
 * mistake in the source, a rule for a field the schema lacks, an unclassified
 * component, or a resource-like field of a built-in or approval component
 * that no rule covers.
 */
export function buildTable({ source, schema, catalog }) {
  const problems = [];
  checkKeys(
    "capabilities.json",
    source,
    [
      "about",
      "vector_version",
      "schema_sha256",
      "tiers",
      "capabilities",
      "resource_kinds",
      "codes",
      "string_rules",
      "credential_shapes",
      "shared_types",
      "components",
      "global_settings",
      "enrichment_tables",
      "vrl_functions",
      "asset_kinds",
      "current_restricted_mode",
    ],
    problems,
  );
  if (source.vector_version !== catalog.vector_version)
    problems.push(
      `capabilities.json is for Vector ${source.vector_version}; the catalog is ${catalog.vector_version}`,
    );
  if (source.schema_sha256 !== catalog.schema_sha256)
    problems.push(
      `capabilities.json was reviewed against schema ${source.schema_sha256}; the pinned schema is ${catalog.schema_sha256}. Review the changes, then update schema_sha256.`,
    );
  const codes = Object.keys(source.codes || {});
  for (const key of TIERS)
    if (typeof source.tiers?.[key] !== "string")
      problems.push(`tiers.${key}: describe the tier`);
  for (const key of CAPABILITIES)
    if (typeof source.capabilities?.[key] !== "string")
      problems.push(`capabilities.${key}: describe the capability`);
  for (const key of RESOURCE_KINDS)
    if (typeof source.resource_kinds?.[key] !== "string")
      problems.push(`resource_kinds.${key}: describe the kind`);
  for (const key of ASSET_KINDS)
    if (typeof source.asset_kinds?.[key] !== "string")
      problems.push(`asset_kinds.${key}: describe the kind`);
  for (const [i, rule] of (source.string_rules || []).entries()) {
    checkKeys(
      `string_rules[${i}]`,
      rule,
      ["contains", "pattern", "except", "code", "reason"],
      problems,
    );
    if (!("contains" in rule) === !("pattern" in rule))
      problems.push(`string_rules[${i}]: one of contains or pattern`);
    if ("except" in rule && rule.except !== "template_fields")
      problems.push(`string_rules[${i}]: except can only be template_fields`);
    if (!codes.includes(rule.code))
      problems.push(`string_rules[${i}]: unknown code ${rule.code}`);
  }

  // Shared types: their own fields, checked once.
  const shared = new Map();
  for (const [type, entry] of Object.entries(source.shared_types || {})) {
    if (
      !checkKeys(
        `shared_types.${type}`,
        entry,
        ["review", "fields", "credentials"],
        problems,
      )
    )
      continue;
    const definition = schema.definitions[type];
    if (!definition) {
      problems.push(`shared_types.${type}: the pinned schema has no such type`);
      continue;
    }
    const fields = fieldsOf(schema, { $ref: `#/definitions/${type}` });
    for (const [rel, rule] of Object.entries(entry.fields || {})) {
      problems.push(
        ...ruleProblems(
          `shared_types.${type}.${rel || "(itself)"}`,
          rule,
          codes,
        ),
      );
      if (!fields.has(rel))
        problems.push(
          `shared_types.${type}: no field "${rel}" in the pinned schema`,
        );
    }
    for (const [rel, location] of Object.entries(entry.credentials || {})) {
      checkKeys(
        `shared_types.${type}.credentials.${rel}`,
        location,
        ["shape", "when"],
        problems,
      );
      if (!fields.has(rel))
        problems.push(
          `shared_types.${type}.credentials: no field "${rel}" in the pinned schema`,
        );
      if (!source.credential_shapes?.[location.shape])
        problems.push(
          `shared_types.${type}.credentials.${rel}: unknown shape ${location.shape}`,
        );
    }
    shared.set(type, {
      rules: entry.fields || {},
      credentials: entry.credentials || {},
      fields,
    });
  }
  for (const [type, { fields }] of shared) {
    const { rules, credentials } = expandShared(fields, shared);
    for (const [fieldPath, info] of fields) {
      if (!fieldPath || !needsRule(fieldPath, info)) continue;
      if (
        !covered(
          fieldPath,
          rules,
          credentials,
          info,
          shared,
          source.credential_shapes,
        )
      )
        problems.push(
          `shared_types.${type}: field ${fieldPath} looks like a resource and has no rule`,
        );
    }
  }

  // Credential shapes.
  for (const [name, shape] of Object.entries(source.credential_shapes || {})) {
    checkKeys(
      `credential_shapes.${name}`,
      shape,
      [
        "capability",
        "explicit",
        "ambient_keys",
        "refused_keys",
        "kind_field",
        "ambient_kinds",
        "refused_kinds",
        "review",
      ],
      problems,
    );
    if (!CAPABILITIES.includes(shape.capability))
      problems.push(`credential_shapes.${name}: unknown capability`);
    for (const [key, rule] of Object.entries(shape.refused_keys || {}))
      problems.push(
        ...ruleProblems(
          `credential_shapes.${name}.refused_keys.${key}`,
          rule,
          codes,
        ),
      );
    for (const [kind, rule] of Object.entries(shape.refused_kinds || {}))
      problems.push(
        ...ruleProblems(
          `credential_shapes.${name}.refused_kinds.${kind}`,
          rule,
          codes,
        ),
      );
  }

  const scopes = [];
  const known = new Set(catalog.components.map((c) => `${c.kind}/${c.type}`));
  for (const section of SECTIONS)
    for (const type of Object.keys(source.components?.[section] || {}))
      if (!known.has(`${section}/${type}`))
        problems.push(
          `components.${section}.${type}: not a component of Vector ${catalog.vector_version}`,
        );
  for (const component of catalog.components) {
    const profile = source.components?.[component.kind]?.[component.type];
    const where = `components.${component.kind}.${component.type}`;
    if (!profile) {
      problems.push(
        `${where}: unclassified; give it a tier (new components start as full)`,
      );
      continue;
    }
    scopes.push(
      expandScope({
        where,
        scope: `${component.kind}/${component.type}`,
        profile,
        node: { $ref: component.schema_ref },
        schema,
        shared,
        source,
        codes,
        problems,
      }),
    );
  }

  // Global settings: every root key of the schema.
  const rootKeys = new Set();
  for (const part of schema.allOf || [])
    for (const key of Object.keys(part.properties || {})) rootKeys.add(key);
  for (const key of SECTIONS) rootKeys.delete(key);
  const globals = [];
  for (const key of [...rootKeys].sort()) {
    const setting = source.global_settings?.[key];
    if (!setting) {
      problems.push(`global_settings.${key}: unclassified`);
      continue;
    }
    // A setting's rules name full paths from the root: "data_dir", "proxy.http".
    // Enrichment tables are classified by type below, not as one setting.
    const node =
      key === "enrichment_tables"
        ? {}
        : {
            allOf: (schema.allOf || [])
              .filter((part) => part.properties?.[key])
              .map((part) => ({ properties: { [key]: part.properties[key] } })),
          };
    globals.push(
      expandScope({
        where: `global_settings.${key}`,
        scope: `global/${key}`,
        profile: setting,
        node,
        schema,
        shared,
        source,
        codes,
        problems,
      }),
    );
  }
  for (const key of Object.keys(source.global_settings || {}))
    if (!rootKeys.has(key))
      problems.push(
        `global_settings.${key}: not a global setting of the pinned schema`,
      );

  // Enrichment tables: every type of the schema.
  const tablesNode = schema.allOf?.find(
    (part) => part.properties?.enrichment_tables,
  )?.properties.enrichment_tables;
  const tableTypes = new Map();
  // Each table type is a branch {allOf: [{$ref: its config}, {type: const}]}.
  (function find(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(find);
    const tag = node.allOf
      ?.map((part) => part.properties?.type?.const)
      .find((t) => typeof t === "string");
    if (tag) return void tableTypes.set(tag, node);
    for (const value of Object.values(node)) find(value);
  })(tablesNode?.additionalProperties);
  const tables = [];
  for (const [type, node] of [...tableTypes].sort(([a], [b]) =>
    compare(a, b),
  )) {
    const profile = source.enrichment_tables?.[type];
    if (!profile) {
      problems.push(`enrichment_tables.${type}: unclassified`);
      continue;
    }
    tables.push(
      expandScope({
        where: `enrichment_tables.${type}`,
        scope: `enrichment_tables/${type}`,
        profile,
        node,
        schema,
        shared,
        source,
        codes,
        problems,
      }),
    );
  }
  for (const type of Object.keys(source.enrichment_tables || {}))
    if (!tableTypes.has(type))
      problems.push(
        `enrichment_tables.${type}: not an enrichment table type of the pinned schema`,
      );

  // Asset fields (ADR 0013): where a version may name a managed asset, for
  // every component and table type whatever its tier, since a full-mode
  // device substitutes assets too.
  const assetFields = [];
  const addAssets = (scope, rules) => {
    for (const [fieldPath, rule] of Object.entries(rules))
      if (rule.asset)
        assetFields.push({
          scope,
          path: fieldPath,
          kind: rule.asset,
          ...(rule.asset_capability
            ? { capability: rule.asset_capability }
            : {}),
        });
  };
  for (const component of catalog.components) {
    const fields = fieldsOf(schema, { $ref: component.schema_ref });
    const own =
      source.components?.[component.kind]?.[component.type]?.fields || {};
    addAssets(`${component.kind}/${component.type}`, {
      ...expandShared(fields, shared).rules,
      ...own,
    });
  }
  for (const type of tableTypes.keys())
    addAssets(
      `enrichment_tables/${type}`,
      source.enrichment_tables?.[type]?.fields || {},
    );
  assetFields.sort(
    (a, b) => compare(a.scope, b.scope) || compare(a.path, b.path),
  );

  // VRL functions.
  const vrl = source.vrl_functions || {};
  checkKeys(
    "vrl_functions",
    vrl,
    ["refused", "device_only", "review"],
    problems,
  );
  for (const name of vrl.refused || [])
    if (!(vrl.device_only || []).includes(name))
      problems.push(
        `vrl_functions: ${name} is refused but not listed as device only`,
      );

  // What restricted mode accepts until its readers switch to the tiers.
  const current = source.current_restricted_mode || {};
  checkKeys(
    "current_restricted_mode",
    current,
    ["review", "components", "notes", "global_settings"],
    problems,
  );
  for (const section of SECTIONS)
    for (const type of current.components?.[section] || []) {
      const scope = scopes.find((s) => s.scope === `${section}/${type}`);
      if (!scope)
        problems.push(
          `current_restricted_mode: ${section}/${type} is not a component`,
        );
      else if (scope.tier !== "builtin")
        problems.push(
          `current_restricted_mode: ${section}/${type} runs in restricted mode today, so the table must keep it built in`,
        );
    }
  for (const key of current.global_settings || []) {
    const setting = globals.find((g) => g.scope === `global/${key}`);
    if (!setting || setting.tier !== "builtin")
      problems.push(
        `current_restricted_mode: global setting ${key} must stay built in`,
      );
  }

  const table = {
    vector_version: source.vector_version,
    schema_sha256: source.schema_sha256,
    tiers: source.tiers,
    capabilities: source.capabilities,
    resource_kinds: source.resource_kinds,
    asset_kinds: source.asset_kinds,
    codes: source.codes,
    string_rules: source.string_rules || [],
    credential_shapes: Object.fromEntries(
      Object.entries(source.credential_shapes || {}).map(([name, shape]) => {
        const { review: _review, ...rest } = shape;
        return [name, rest];
      }),
    ),
    components: scopes,
    global_settings: globals,
    enrichment_tables: tables,
    asset_fields: assetFields,
    vrl_functions: {
      refused: [...(vrl.refused || [])].sort(),
      device_only: [...(vrl.device_only || [])].sort(),
    },
    current_restricted_mode: {
      components: current.components || {},
      notes: current.notes || {},
      global_settings: current.global_settings || [],
    },
  };
  table.id = `${table.vector_version}/${sha256(JSON.stringify(table)).slice(0, 16)}`;
  return { table, problems };
}

function needsRule(fieldPath, info) {
  if (RESOURCE_NAME.test(nameOf(fieldPath))) return true;
  if (info.template) return true;
  for (const type of info.types) if (RESOURCE_TYPES.has(type)) return true;
  return false;
}

// A field is covered by a rule at its path or at its list items ("include"
// by "include[]"), by a refused, options, data or ambient rule above it, by a
// credential location there or one of its shape's keys there, or by being of
// a shared type, which classifies its own fields. A credential covers only
// the keys its shape reads, so a new resource-like field inside a credential
// type still fails.
function covered(fieldPath, rules, credentials, info, shared, shapes) {
  for (
    let candidate = fieldPath, depth = 0;
    depth < 4;
    depth++, candidate += "[]"
  )
    if (Object.hasOwn(rules, candidate)) return true;
  if (
    credentials.some(
      ({ path: at, shape }) =>
        at === fieldPath ||
        shapeKeys(shapes?.[shape]).some((key) => join(at, key) === fieldPath),
    )
  )
    return true;
  if ([...info.types].some((type) => shared.has(type))) return true;
  return ancestors(fieldPath).some((above) =>
    COVERING.has(rules[above]?.class),
  );
}
const shapeKeys = (shape) =>
  shape
    ? [
        ...(shape.explicit || []),
        ...(shape.ambient_keys || []),
        ...Object.keys(shape.refused_keys || {}),
        ...(shape.kind_field ? [shape.kind_field] : []),
      ]
    : [];

// The rules and credential locations shared types place in a field tree,
// rebased onto the path where each type occurs.
function expandShared(fields, shared) {
  const rules = {};
  const origin = {};
  const locations = [];
  const credentials = [];
  const rebase = (base, when) =>
    when &&
    Object.fromEntries(
      Object.entries(when).map(([field, values]) => [
        join(base, field),
        values,
      ]),
    );
  for (const [fieldPath, info] of fields)
    for (const type of info.types) {
      const entry = shared.get(type);
      if (!entry) continue;
      for (const [rel, rule] of Object.entries(entry.rules)) {
        const target = join(fieldPath, rel);
        if (!fields.has(target)) continue;
        rules[target] = {
          ...rule,
          ...(rule.when ? { when: rebase(fieldPath, rule.when) } : {}),
          ...(rule.base_dir
            ? { base_dir: join(fieldPath, rule.base_dir) }
            : {}),
        };
        origin[target] = type;
      }
      for (const [rel, location] of Object.entries(entry.credentials)) {
        const target = join(fieldPath, rel);
        if (!fields.has(target) || locations.includes(target)) continue;
        locations.push(target);
        credentials.push({
          path: target,
          shape: location.shape,
          ...(location.when ? { when: rebase(fieldPath, location.when) } : {}),
        });
      }
    }
  return { rules, origin, locations, credentials };
}

/**
 * One scope (a component type, a global setting or an enrichment table type):
 * its tier and its rules with shared types expanded, after checking that each
 * rule names a field of the pinned schema and, for a scope restricted mode can
 * run, that every resource-like field has a rule.
 */
function expandScope({
  where,
  scope,
  profile,
  node,
  schema,
  shared,
  source,
  codes,
  problems,
}) {
  checkKeys(
    where,
    profile,
    ["tier", "code", "reach", "review", "target", "fields", "credentials"],
    problems,
  );
  if (!TIERS.includes(profile.tier))
    problems.push(`${where}: tier must be one of ${TIERS.join(", ")}`);
  if (typeof profile.review !== "string" || !profile.review)
    problems.push(`${where}: add a review note`);
  const reviewed = profile.review !== "not yet reviewed";
  if (reviewed && (typeof profile.reach !== "string" || !profile.reach))
    problems.push(`${where}: a reviewed scope says what it reaches`);
  if (!reviewed && profile.tier !== "full")
    problems.push(`${where}: an unreviewed scope stays full`);
  if (
    "code" in profile &&
    (profile.tier !== "full" || !codes.includes(profile.code))
  )
    problems.push(
      `${where}: a code names how a full-mode scope is refused, from "codes"`,
    );
  if ("target" in profile && (reviewed || !TIERS.includes(profile.target)))
    problems.push(`${where}: a target tier belongs to an unreviewed scope`);
  const result = {
    scope,
    tier: profile.tier,
    reviewed,
    reach: profile.reach || "",
    ...(profile.tier === "full"
      ? { code: profile.code || "UNSUPPORTED_LOCAL_CAPABILITY" }
      : {}),
    rules: {},
    credentials: [],
  };
  if (profile.tier === "full") {
    if (profile.fields || profile.credentials)
      problems.push(`${where}: a full-mode scope has no field rules`);
    return result;
  }
  const fields = fieldsOf(schema, node);
  // Shared types first; the scope's own rules win.
  const { rules, origin, locations, credentials } = expandShared(
    fields,
    shared,
  );
  result.credentials.push(...credentials);
  for (const [target, rule] of Object.entries(profile.fields || {})) {
    problems.push(...ruleProblems(`${where}.fields.${target}`, rule, codes));
    if (!fields.has(target))
      problems.push(`${where}: no field "${target}" in the pinned schema`);
    if ("default" in rule && /\[\]|\*/.test(target))
      problems.push(
        `${where}.fields.${target}: a default needs a plain path, without [] or *`,
      );
    rules[target] = rule;
    origin[target] = "";
    if (rule.base_dir && !fields.has(rule.base_dir))
      problems.push(
        `${where}.fields.${target}: base_dir names no field "${rule.base_dir}"`,
      );
    for (const field of Object.keys(rule.when || {}))
      if (!fields.has(field))
        problems.push(
          `${where}.fields.${target}: "when" names no field "${field}"`,
        );
  }
  for (const [target, location] of Object.entries(profile.credentials || {})) {
    checkKeys(
      `${where}.credentials.${target}`,
      location,
      ["shape", "when"],
      problems,
    );
    if (!fields.has(target))
      problems.push(
        `${where}.credentials: no field "${target}" in the pinned schema`,
      );
    if (!source.credential_shapes?.[location.shape])
      problems.push(
        `${where}.credentials.${target}: unknown shape ${location.shape}`,
      );
    for (const field of Object.keys(location.when || {}))
      if (!fields.has(field))
        problems.push(
          `${where}.credentials.${target}: "when" names no field "${field}"`,
        );
    if (locations.includes(target))
      problems.push(
        `${where}.credentials.${target}: a shared type already places a credential here`,
      );
    locations.push(target);
    result.credentials.push({
      path: target,
      shape: location.shape,
      ...(location.when ? { when: location.when } : {}),
    });
  }
  // Completeness: resource-like fields, templates and reviewed types. A
  // reviewed type without a shared classification (a credential, say) needs a
  // rule or a credential location of its own, also where it is flattened into
  // the scope itself, as Google's credentials are.
  for (const [fieldPath, info] of fields) {
    if (/^(?:graph|inputs|type)(?:$|[.[])/.test(fieldPath)) continue;
    if (
      fieldPath &&
      needsRule(fieldPath, info) &&
      !covered(
        fieldPath,
        rules,
        result.credentials,
        info,
        shared,
        source.credential_shapes,
      )
    ) {
      const why =
        [...info.types].find((t) => RESOURCE_TYPES.has(t)) ||
        (info.template ? "a template" : "its name");
      problems.push(
        `${where}: field ${fieldPath} looks like a resource (${why}) and has no rule`,
      );
    }
    const explicit =
      Object.hasOwn(rules, fieldPath) ||
      locations.includes(fieldPath) ||
      ancestors(fieldPath).some(
        (above) =>
          COVERING.has(rules[above]?.class) || locations.includes(above),
      );
    for (const type of info.types)
      if (REVIEWED_TYPES.has(type) && !shared.has(type) && !explicit)
        problems.push(
          `${where}: ${fieldPath ? `field ${fieldPath}` : "the scope itself"} uses ${type}, which has no shared classification`,
        );
  }
  for (const target of Object.keys(rules).sort()) {
    const { review: _review, ...rule } = rules[target];
    result.rules[target] = origin[target]
      ? { ...rule, from: origin[target] }
      : rule;
  }
  result.credentials.sort((a, b) => compare(a.path, b.path));
  return result;
}

// Rendering. Values that can be a string or a boolean (a default, an allowed
// value, a condition) travel as their JSON encoding in Go and Rust.
const json = (value) => JSON.stringify(value);
const allScopes = (table) => [
  ...table.components,
  ...table.global_settings,
  ...table.enrichment_tables,
];
function flatRules(table) {
  const rows = [];
  for (const scope of allScopes(table))
    for (const [fieldPath, rule] of Object.entries(scope.rules))
      rows.push({ scope: scope.scope, path: fieldPath, ...rule });
  return rows;
}
const flatCredentials = (table) =>
  allScopes(table).flatMap((scope) =>
    scope.credentials.map((credential) => ({
      scope: scope.scope,
      ...credential,
    })),
  );
const conditions = (when) =>
  Object.entries(when || {})
    .sort(([a], [b]) => compare(a, b))
    .map(([field, values]) => ({ field, values: values.map(json) }));
const refusals = (map) =>
  Object.entries(map || {})
    .sort(([a], [b]) => compare(a, b))
    .map(([name, rule]) => ({ name, code: rule.code, reason: rule.reason }));
const shapes = (table) =>
  Object.entries(table.credential_shapes).sort(([a], [b]) => compare(a, b));

export function renderGo(table) {
  const q = (value) => JSON.stringify(value ?? "");
  const list = (values) =>
    values?.length ? `[]string{${values.map(q).join(", ")}}` : "nil";
  const cond = (when) => {
    const items = conditions(when);
    return items.length
      ? `[]capabilityCondition{${items.map((c) => `{${q(c.field)}, ${list(c.values)}}`).join(", ")}}`
      : "nil";
  };
  const refused = (map) => {
    const items = refusals(map);
    return items.length
      ? `[]capabilityRefusal{${items.map((r) => `{${q(r.name)}, ${q(r.code)}, ${q(r.reason)}}`).join(", ")}}`
      : "nil";
  };
  const fields = (r) =>
    [
      `Scope: ${q(r.scope)}`,
      `Path: ${q(r.path)}`,
      `Class: ${q(r.class)}`,
      r.kind && `Kind: ${q(r.kind)}`,
      r.schemes && `Schemes: ${list(r.schemes)}`,
      r.template && "Template: true",
      r.base_dir && `BaseDir: ${q(r.base_dir)}`,
      r.writes && "Writes: true",
      r.required && "Required: true",
      r.when && `When: ${cond(r.when)}`,
      "default" in r && `Default: ${q(json(r.default))}`,
      r.allowed && `Allowed: ${list(r.allowed.map(json))}`,
      r.refused_values && `RefusedValues: ${list(r.refused_values.map(json))}`,
      r.allowed_keys && `AllowedKeys: ${list(r.allowed_keys)}`,
      r.asset && `Asset: ${q(r.asset)}`,
      r.asset_capability && `AssetCapability: ${q(r.asset_capability)}`,
      r.capability && `Capability: ${q(r.capability)}`,
      r.code && `Code: ${q(r.code)}`,
      r.reason && `Reason: ${q(r.reason)}`,
      r.from && `From: ${q(r.from)}`,
    ]
      .filter(Boolean)
      .join(", ");
  return `// Code generated by ${GENERATOR} from ${SOURCE}; DO NOT EDIT.

package agent

// Regenerate with \`node ${GENERATOR}\`. CI runs it with
// --check, which also fails when a field of the pinned schema that looks like
// a resource has no rule. Nothing reads this table yet: restricted mode is
// still decided by CapabilityPolicy.Check.

// The Vector release this table was reviewed against, the digest of its
// generated schema, and the table's identity (the release and a digest of the
// table's contents).
const (
	capabilityTableID       = ${q(table.id)}
	capabilityVectorVersion = ${q(table.vector_version)}
	capabilitySchemaSHA256  = ${q(table.schema_sha256)}
)

// capabilityScope is a component type ("sources/kafka"), a global setting
// ("global/data_dir") or an enrichment table type ("enrichment_tables/file").
// Tier is "builtin", "approval" or "full"; an unreviewed scope is full. Code
// is how restricted mode refuses a full scope.
type capabilityScope struct {
	Scope    string
	Tier     string
	Reviewed bool
	Reach    string
	Code     string
}

// capabilityCondition holds when the field at Field, relative to the scope,
// has one of Values, each a JSON encoding.
type capabilityCondition struct {
	Field  string
	Values []string
}

// capabilityRule classifies one field of a scope. Path uses "." between
// fields, "[]" for list items and "*" for map values. Class is "resource"
// (Kind names it), "refused", "constrained" (Allowed or RefusedValues, JSON
// encodings), "options" (a passthrough map where only AllowedKeys pass),
// "template" (a template that names no resource), "ambient" (it reaches the
// host's own cloud identity: Capability) or "data". From names the shared
// schema type the rule came from.
type capabilityRule struct {
	Scope           string
	Path            string
	Class           string
	Kind            string
	Schemes         []string
	Template        bool
	BaseDir         string
	Writes          bool
	Required        bool
	When            []capabilityCondition
	Default         string
	Allowed         []string
	RefusedValues   []string
	AllowedKeys     []string
	Asset           string
	AssetCapability string
	Capability      string
	Code            string
	Reason          string
	From            string
}

// capabilityCredential is where a scope holds a credential of a shape in
// capabilityCredentialShapes, and when it applies.
type capabilityCredential struct {
	Scope string
	Path  string
	Shape string
	When  []capabilityCondition
}

// capabilityRefusal refuses a credential key, or a value of a credential's
// kind field, with a code and a reason.
type capabilityRefusal struct {
	Name   string
	Code   string
	Reason string
}

// capabilityCredentialShape says when a credential reaches the host's own
// cloud identity, which needs Capability: without any Explicit key, with any
// AmbientKeys key, or with KindField set to one of AmbientKinds. RefusedKeys
// and RefusedKinds need full mode.
type capabilityCredentialShape struct {
	Name         string
	Capability   string
	Explicit     []string
	AmbientKeys  []string
	RefusedKeys  []capabilityRefusal
	KindField    string
	AmbientKinds []string
	RefusedKinds []capabilityRefusal
}

// capabilityStringRule refuses a string anywhere in a restricted pipeline that
// contains Contains or matches Pattern (a regular expression), except at
// template fields when ExceptTemplateFields is set.
type capabilityStringRule struct {
	Contains             string
	Pattern              string
	ExceptTemplateFields bool
	Code                 string
	Reason               string
}

// capabilityAssetField is a field where a version may name a managed asset of
// Kind (ADR 0013), in every mode; Capability is what restricted mode also
// needs for it.
type capabilityAssetField struct {
	Scope      string
	Path       string
	Kind       string
	Capability string
}

var capabilityScopes = [...]capabilityScope{
${allScopes(table)
  .map(
    (s) =>
      `\t{${q(s.scope)}, ${q(s.tier)}, ${s.reviewed}, ${q(s.reach)}, ${q(s.code)}},`,
  )
  .join("\n")}
}

var capabilityRules = [...]capabilityRule{
${flatRules(table)
  .map((r) => `\t{${fields(r)}},`)
  .join("\n")}
}

var capabilityCredentials = [...]capabilityCredential{
${flatCredentials(table)
  .map(
    (c) => `\t{${q(c.scope)}, ${q(c.path)}, ${q(c.shape)}, ${cond(c.when)}},`,
  )
  .join("\n")}
}

var capabilityCredentialShapes = [...]capabilityCredentialShape{
${shapes(table)
  .map(
    ([name, s]) =>
      `\t{Name: ${q(name)}, Capability: ${q(s.capability)}, Explicit: ${list(s.explicit)}, AmbientKeys: ${list(s.ambient_keys)}, RefusedKeys: ${refused(s.refused_keys)}` +
      (s.kind_field
        ? `, KindField: ${q(s.kind_field)}, AmbientKinds: ${list(s.ambient_kinds)}, RefusedKinds: ${refused(s.refused_kinds)}`
        : "") +
      "},",
  )
  .join("\n")}
}

var capabilityStringRules = [...]capabilityStringRule{
${table.string_rules
  .map(
    (r) =>
      `\t{${q(r.contains)}, ${q(r.pattern)}, ${r.except === "template_fields"}, ${q(r.code)}, ${q(r.reason)}},`,
  )
  .join("\n")}
}

var capabilityAssetFields = [...]capabilityAssetField{
${table.asset_fields.map((a) => `\t{${q(a.scope)}, ${q(a.path)}, ${q(a.kind)}, ${q(a.capability)}},`).join("\n")}
}

// capabilityRefusedVRL lists the VRL functions restricted mode refuses, and
// capabilityDeviceVRL those only a device can evaluate.
var (
	capabilityRefusedVRL = ${list(table.vrl_functions.refused)}
	capabilityDeviceVRL  = ${list(table.vrl_functions.device_only)}
)
`;
}

export function renderRust(table) {
  const q = (value) => JSON.stringify(value ?? "");
  const list = (values) => `&[${(values || []).map(q).join(", ")}]`;
  const cond = (when) =>
    `&[${conditions(when)
      .map(
        (c) => `Condition { field: ${q(c.field)}, values: ${list(c.values)} }`,
      )
      .join(", ")}]`;
  const refused = (map) =>
    `&[${refusals(map)
      .map(
        (r) =>
          `Refusal { name: ${q(r.name)}, code: ${q(r.code)}, reason: ${q(r.reason)} }`,
      )
      .join(", ")}]`;
  const rule = (r) =>
    `    Rule { scope: ${q(r.scope)}, path: ${q(r.path)}, class: ${q(r.class)}, kind: ${q(r.kind)}, schemes: ${list(r.schemes)}, template: ${!!r.template}, base_dir: ${q(r.base_dir)}, writes: ${!!r.writes}, required: ${!!r.required}, when: ${cond(r.when)}, default: ${q("default" in r ? json(r.default) : "")}, allowed: ${list(r.allowed?.map(json))}, refused_values: ${list(r.refused_values?.map(json))}, allowed_keys: ${list(r.allowed_keys)}, asset: ${q(r.asset)}, asset_capability: ${q(r.asset_capability)}, capability: ${q(r.capability)}, code: ${q(r.code)}, reason: ${q(r.reason)}, from: ${q(r.from)} },`;
  return `//! The capability table of the pinned Vector: tiers, resource fields,
//! refused fields, template fields, credential shapes and asset fields.
//!
//! Generated by ${GENERATOR} from ${SOURCE};
//! do not edit. Regenerate with \`node ${GENERATOR}\`; CI runs it with
//! \`--check\`. Nothing reads it yet: \`requires_full_mode\` in \`rollout.rs\` still
//! decides deployments. Empty strings and slices mean "not set".

/// The table's identity: the Vector release and a digest of its contents.
pub const TABLE_ID: &str = ${q(table.id)};
/// The Vector release the table was reviewed against.
pub const VECTOR_VERSION: &str = ${q(table.vector_version)};
/// Digest of the generated schema the table was reviewed against.
pub const SCHEMA_SHA256: &str = ${q(table.schema_sha256)};

/// A component type (\`sources/kafka\`), a global setting (\`global/data_dir\`)
/// or an enrichment table type (\`enrichment_tables/file\`). \`tier\` is
/// \`builtin\`, \`approval\` or \`full\`; an unreviewed scope is full. \`code\` is
/// how restricted mode refuses a full scope.
pub struct Scope {
    pub scope: &'static str,
    pub tier: &'static str,
    pub reviewed: bool,
    pub reach: &'static str,
    pub code: &'static str,
}

/// Holds when the field at \`field\`, relative to the scope, has one of
/// \`values\`, each a JSON encoding.
pub struct Condition {
    pub field: &'static str,
    pub values: &'static [&'static str],
}

/// One field of a scope. \`path\` uses \`.\` between fields, \`[]\` for list items
/// and \`*\` for map values. \`class\` is \`resource\` (\`kind\` names it),
/// \`refused\`, \`constrained\` (\`allowed\` or \`refused_values\`, JSON encodings),
/// \`options\` (a passthrough map where only \`allowed_keys\` pass), \`template\`
/// (a template that names no resource), \`ambient\` (it reaches the host's own
/// cloud identity: \`capability\`) or \`data\`. \`from\` names the shared schema
/// type the rule came from.
pub struct Rule {
    pub scope: &'static str,
    pub path: &'static str,
    pub class: &'static str,
    pub kind: &'static str,
    pub schemes: &'static [&'static str],
    pub template: bool,
    pub base_dir: &'static str,
    pub writes: bool,
    pub required: bool,
    pub when: &'static [Condition],
    pub default: &'static str,
    pub allowed: &'static [&'static str],
    pub refused_values: &'static [&'static str],
    pub allowed_keys: &'static [&'static str],
    pub asset: &'static str,
    pub asset_capability: &'static str,
    pub capability: &'static str,
    pub code: &'static str,
    pub reason: &'static str,
    pub from: &'static str,
}

/// Where a scope holds a credential of a shape in \`CREDENTIAL_SHAPES\`.
pub struct Credential {
    pub scope: &'static str,
    pub path: &'static str,
    pub shape: &'static str,
    pub when: &'static [Condition],
}

/// Refuses a credential key, or a value of a credential's kind field.
pub struct Refusal {
    pub name: &'static str,
    pub code: &'static str,
    pub reason: &'static str,
}

/// When a credential reaches the host's own cloud identity, which needs
/// \`capability\`: without any \`explicit\` key, with any \`ambient_keys\` key,
/// or with \`kind_field\` set to one of \`ambient_kinds\`. \`refused_keys\` and
/// \`refused_kinds\` need full mode.
pub struct CredentialShape {
    pub name: &'static str,
    pub capability: &'static str,
    pub explicit: &'static [&'static str],
    pub ambient_keys: &'static [&'static str],
    pub refused_keys: &'static [Refusal],
    pub kind_field: &'static str,
    pub ambient_kinds: &'static [&'static str],
    pub refused_kinds: &'static [Refusal],
}

/// Refuses a string anywhere in a restricted pipeline that contains
/// \`contains\` or matches \`pattern\` (a regular expression), except at
/// template fields when \`except_template_fields\` is set.
pub struct StringRule {
    pub contains: &'static str,
    pub pattern: &'static str,
    pub except_template_fields: bool,
    pub code: &'static str,
    pub reason: &'static str,
}

/// A field where a version may name a managed asset of \`kind\` (ADR 0013), in
/// every mode; \`capability\` is what restricted mode also needs for it.
pub struct AssetField {
    pub scope: &'static str,
    pub path: &'static str,
    pub kind: &'static str,
    pub capability: &'static str,
}

#[rustfmt::skip]
pub const SCOPES: &[Scope] = &[
${allScopes(table)
  .map(
    (s) =>
      `    Scope { scope: ${q(s.scope)}, tier: ${q(s.tier)}, reviewed: ${s.reviewed}, reach: ${q(s.reach)}, code: ${q(s.code)} },`,
  )
  .join("\n")}
];

#[rustfmt::skip]
pub const RULES: &[Rule] = &[
${flatRules(table).map(rule).join("\n")}
];

#[rustfmt::skip]
pub const CREDENTIALS: &[Credential] = &[
${flatCredentials(table)
  .map(
    (c) =>
      `    Credential { scope: ${q(c.scope)}, path: ${q(c.path)}, shape: ${q(c.shape)}, when: ${cond(c.when)} },`,
  )
  .join("\n")}
];

#[rustfmt::skip]
pub const CREDENTIAL_SHAPES: &[CredentialShape] = &[
${shapes(table)
  .map(
    ([name, s]) =>
      `    CredentialShape { name: ${q(name)}, capability: ${q(s.capability)}, explicit: ${list(s.explicit)}, ambient_keys: ${list(s.ambient_keys)}, refused_keys: ${refused(s.refused_keys)}, kind_field: ${q(s.kind_field)}, ambient_kinds: ${list(s.ambient_kinds)}, refused_kinds: ${refused(s.refused_kinds)} },`,
  )
  .join("\n")}
];

#[rustfmt::skip]
pub const STRING_RULES: &[StringRule] = &[
${table.string_rules
  .map(
    (r) =>
      `    StringRule { contains: ${q(r.contains)}, pattern: ${q(r.pattern)}, except_template_fields: ${r.except === "template_fields"}, code: ${q(r.code)}, reason: ${q(r.reason)} },`,
  )
  .join("\n")}
];

#[rustfmt::skip]
pub const ASSET_FIELDS: &[AssetField] = &[
${table.asset_fields
  .map(
    (a) =>
      `    AssetField { scope: ${q(a.scope)}, path: ${q(a.path)}, kind: ${q(a.kind)}, capability: ${q(a.capability)} },`,
  )
  .join("\n")}
];

/// VRL functions restricted mode refuses.
#[rustfmt::skip]
pub const REFUSED_VRL_FUNCTIONS: &[&str] = ${list(table.vrl_functions.refused)};
/// VRL functions only a device can evaluate.
#[rustfmt::skip]
pub const DEVICE_VRL_FUNCTIONS: &[&str] = ${list(table.vrl_functions.device_only)};
`;
}

export function renderJson(table) {
  return (
    JSON.stringify(
      {
        generated_by: `${GENERATOR} from ${SOURCE}`,
        id: table.id,
        path_syntax:
          'Fields are joined with ".", "[]" marks list items and "*" marks map values.',
        ...Object.fromEntries(
          Object.entries(table).filter(([key]) => key !== "id"),
        ),
      },
      null,
      2,
    ) + "\n"
  );
}

// docs/user/security.md lists restricted mode's components between these
// markers. The help center's tests check the list against the JSON copy.
export const DOCS_BEGIN =
  "<!-- generated by scripts/generate-capability-table.mjs: restricted-mode lists -->";
export const DOCS_END = "<!-- end of generated restricted-mode lists -->";
export function renderDocs(text, table) {
  const current = table.current_restricted_mode;
  const items = (section) =>
    current.components[section]
      .map(
        (type) =>
          `\`${type}\`${current.notes[`${section}/${type}`] ? ` (${current.notes[`${section}/${type}`]})` : ""}`,
      )
      .join(", ");
  const block = [
    DOCS_BEGIN,
    "| Kind | Allowed |",
    "| --- | --- |",
    `| Sources | ${items("sources")} |`,
    `| Transforms | ${items("transforms")} |`,
    `| Sinks | ${items("sinks")} |`,
    `| Global settings | ${current.global_settings.map((key) => `\`${key}\``).join(", ")} |`,
    DOCS_END,
  ].join("\n");
  const begin = text.indexOf(DOCS_BEGIN);
  const end = text.indexOf(DOCS_END);
  if (begin < 0 || end < begin)
    throw Error(
      `${OUTPUTS.docs}: the restricted-mode lists need their generated-block markers`,
    );
  return text.slice(0, begin) + block + text.slice(end + DOCS_END.length);
}

export function loadInputs(base = root) {
  const read = (file) =>
    JSON.parse(fs.readFileSync(path.join(base, file), "utf8"));
  return { source: read(SOURCE), schema: read(SCHEMA), catalog: read(CATALOG) };
}

export function outputs(table, base = root) {
  const docs = fs.readFileSync(path.join(base, OUTPUTS.docs), "utf8");
  return [
    [OUTPUTS.go, renderGo(table)],
    [OUTPUTS.rust, renderRust(table)],
    [OUTPUTS.json, renderJson(table)],
    [OUTPUTS.docs, renderDocs(docs, table)],
  ];
}

async function main() {
  const check = process.argv.includes("--check");
  const { table, problems } = buildTable(loadInputs());
  if (problems.length) {
    console.error(
      `The capability table is incomplete or wrong (${SOURCE}):\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
    process.exit(1);
  }
  const stale = [];
  for (const [file, text] of outputs(table)) {
    const target = path.join(root, file);
    if (check) {
      if (
        (fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null) !==
        text
      )
        stale.push(file);
    } else fs.writeFileSync(target, text);
  }
  if (stale.length) {
    console.error(
      `Stale capability table outputs: ${stale.join(", ")}. Run node ${GENERATOR}`,
    );
    process.exit(1);
  }
  const counts = Object.fromEntries(
    TIERS.map((tier) => [
      tier,
      table.components.filter((c) => c.tier === tier).length,
    ]),
  );
  console.log(
    `${check ? "The capability table is complete and current" : "Wrote the capability table"} (${table.id}): ${counts.builtin} components built in, ${counts.approval} need host approval, ${counts.full} need full mode.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
