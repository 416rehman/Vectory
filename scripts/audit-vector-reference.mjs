// Independent reference/schema inventory. Live docs are not substituted for the pinned schema.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "dashboard/package.json"));
const Ajv = require("ajv/dist/2019").default;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const read = async (name) =>
  JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
const urls = await read("vector-catalog/reference-urls.json");
const catalog = await read("dashboard/src/generated/vector-catalog.json");
const schemaBytes = await fs.readFile(
  path.join(root, "dashboard/src/generated/vector-schema.json"),
);
const schema = JSON.parse(schemaBytes);
const cache = path.join(root, ".local/vector-reference-cache");
await fs.mkdir(cache, { recursive: true });
const refresh = process.argv.includes("--refresh");
const offline = process.argv.includes("--offline");
const pointer = (part) =>
  String(part).replaceAll("~", "~0").replaceAll("/", "~1");
const resolve = (ref) =>
  ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], schema);
function children(node, location) {
  const result = [];
  for (const key of [
    "properties",
    "definitions",
    "$defs",
    "patternProperties",
    "dependentSchemas",
  ]) {
    for (const [name, value] of Object.entries(node[key] || {}))
      result.push([value, `${location}/${key}/${pointer(name)}`]);
  }
  for (const key of [
    "items",
    "additionalItems",
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "contains",
    "not",
    "if",
    "then",
    "else",
  ]) {
    if (Array.isArray(node[key]))
      node[key].forEach((value, index) =>
        result.push([value, `${location}/${key}/${index}`]),
      );
    else if (node[key] !== undefined)
      result.push([node[key], `${location}/${key}`]);
  }
  for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"])
    (node[key] || []).forEach((value, index) =>
      result.push([value, `${location}/${key}/${index}`]),
    );
  return result;
}
const nodes = [];
function walk(node, location = "#") {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  nodes.push({ location, node });
  for (const [value, child] of children(node, location)) walk(value, child);
}
walk(schema);
const features = {};
function record(name, predicate) {
  const matching = nodes.filter(({ node }) => predicate(node));
  features[name] = {
    occurrences: matching.length,
    examples: matching
      .slice(0, 8)
      .map(({ location, node }) => ({
        schema_path: location,
        type: node.type,
        reference: node.$ref,
        default: node.default,
        metadata: node._metadata,
      })),
  };
}
for (const keyword of [
  "$ref",
  "required",
  "oneOf",
  "anyOf",
  "allOf",
  "if",
  "then",
  "else",
  "enum",
  "const",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "propertyNames",
  "patternProperties",
  "dependentRequired",
  "unevaluatedProperties",
])
  record(keyword, (node) => Object.hasOwn(node, keyword));
record(
  "nullable",
  (node) =>
    node.type === "null" ||
    (Array.isArray(node.type) && node.type.includes("null")) ||
    [...(node.anyOf || []), ...(node.oneOf || [])].some(
      (branch) => branch.type === "null" || branch.const === null,
    ),
);
record("nullable_default", (node) => node.default === null);
record(
  "typed_map",
  (node) =>
    node.additionalProperties &&
    typeof node.additionalProperties === "object" &&
    Object.keys(node.additionalProperties).length > 0,
);
record(
  "freeform_map",
  (node) =>
    node.additionalProperties === true ||
    (node.additionalProperties &&
      typeof node.additionalProperties === "object" &&
      Object.keys(node.additionalProperties).length === 0),
);
record(
  "closed_object",
  (node) =>
    node.additionalProperties === false || node.unevaluatedProperties === false,
);
record(
  "unsafe_javascript_integer_bound",
  (node) =>
    (node.type === "integer" || node.type?.includes?.("integer")) &&
    (node.maximum > Number.MAX_SAFE_INTEGER ||
      node.minimum < Number.MIN_SAFE_INTEGER),
);
function unsafeInteger(value) {
  if (typeof value === "number")
    return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (value && typeof value === "object")
    return Object.values(value).some(unsafeInteger);
  return false;
}
record(
  "unsafe_javascript_integer_default",
  (node) => Object.hasOwn(node, "default") && unsafeInteger(node.default),
);
for (const key of [
  "docs::type_unit",
  "docs::templateable",
  "docs::required_one_of",
  "docs::required_when",
  "docs::relevant_when",
  "docs::numeric_type",
  "docs::syntax_override",
  "docs::type_override",
])
  record(key, (node) => Object.hasOwn(node._metadata || {}, key));
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
  logger: false,
});
ajv.addSchema(schema, "vector-pinned");
const components = catalog.components.map((component) => {
  const visited = new Set();
  function reachable(node, location) {
    if (!node || typeof node !== "object" || visited.has(location)) return;
    visited.add(location);
    if (node.$ref?.startsWith("#/")) reachable(resolve(node.$ref), node.$ref);
    for (const [value, child] of children(node, location))
      reachable(value, child);
  }
  reachable(resolve(component.schema_ref), component.schema_ref);
  let compiled = false,
    error;
  try {
    compiled =
      typeof ajv.getSchema(`vector-pinned${component.schema_ref}`) ===
      "function";
  } catch (failure) {
    error = String(failure.message);
  }
  return {
    kind: component.kind,
    type: component.type,
    schema_ref: component.schema_ref,
    docs_url: component.docs_url,
    platforms: component.platforms,
    coverage: component.coverage,
    reachable_schema_nodes: visited.size,
    ajv_compiles: compiled,
    ...(error ? { error } : {}),
  };
});
async function page(url) {
  const key = hash(url),
    metaPath = path.join(cache, `${key}.json`),
    htmlPath = path.join(cache, `${key}.html`);
  if (!refresh) {
    try {
      const record = JSON.parse(await fs.readFile(metaPath, "utf8"));
      if (record.status === 200 || offline) return record;
    } catch {}
  }
  if (offline) return { url, status: null, error: "Not in local cache" };
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(25000),
      headers: {
        "User-Agent": "Vectory-reference-audit/0.1 (+https://vector.dev/docs/)",
      },
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const html = bytes.toString("utf8");
    const text = (value) =>
      value
        ?.replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const record = {
      url,
      final_url: response.url,
      status: response.status,
      content_type: response.headers.get("content-type"),
      fetched_at: new Date().toISOString(),
      bytes: bytes.length,
      sha256: hash(bytes),
      title: text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
      heading: text(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]),
    };
    await fs.writeFile(htmlPath, bytes);
    await fs.writeFile(metaPath, JSON.stringify(record, null, 2) + "\n");
    return record;
  } catch (failure) {
    return { url, status: null, error: String(failure.message) };
  }
}
const pages = new Array(urls.normalized_urls.length);
let cursor = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (cursor < pages.length) {
      const index = cursor++;
      pages[index] = await page(urls.normalized_urls[index]);
    }
  }),
);
const requestedComponents = urls.normalized_urls
  .map((url) => {
    const match = new URL(url).pathname.match(
      /configuration\/(sources|transforms|sinks)\/([^/]+)\/$/,
    );
    return match ? { kind: match[1], type: match[2], url } : null;
  })
  .filter(Boolean);
const missing = requestedComponents.filter(
  (wanted) =>
    !components.some(
      (component) =>
        component.kind === wanted.kind && component.type === wanted.type,
    ),
);
const extras = components
  .filter(
    (component) =>
      !requestedComponents.some(
        (wanted) =>
          wanted.kind === component.kind && wanted.type === component.type,
      ),
  )
  .map(({ kind, type }) => ({ kind, type }));
// Extract only field identifiers and type badges, never prose descriptions. A
// missing structural path is a review candidate, not proof of incompatibility.
const typeBadges = new Set([
  "string",
  "bool",
  "boolean",
  "uint",
  "int",
  "float",
  "number",
  "integer",
  "object",
  "array",
  "table",
  "timestamp",
  "regex",
  "template",
  "literal",
  "enum",
]);
function documentedFields(html) {
  const section = html.match(
    /<h2\b[^>]*\bid=(?:"configuration"|'configuration'|configuration)[\s>][\s\S]*?<\/h2>/,
  );
  if (section) {
    html = html.slice(section.index + section[0].length);
    const end = html.search(/<h2\b/);
    if (end >= 0) html = html.slice(0, end);
  }
  const fields = [];
  for (const match of html.matchAll(
    /<h[2-6]\b[^>]*\bid=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>[\s\S]*?<\/h[2-6]>/g,
  )) {
    const after = html.slice(
      match.index + match[0].length,
      match.index + match[0].length + 1800,
    );
    const header = after.split(/<div[^>]*\bprose\b/)[0];
    const labels = [...header.matchAll(/<span[^>]*>([^<>]+)<\/span>/g)].map(
      (item) => item[1].trim(),
    );
    if (!labels.includes("required") && !labels.includes("optional")) continue;
    fields.push({
      path: match[1] || match[2] || match[3],
      required_badge: labels.includes("required"),
      types: [
        ...new Set(
          labels.filter(
            (label) =>
              typeBadges.has(label) ||
              /^\[(?:string|object|uint|int|float|bool|timestamp)\]$/.test(
                label,
              ),
          ),
        ),
      ],
    });
  }
  return fields;
}
function schemaPaths(start) {
  const paths = new Set(),
    visited = new Set();
  function descend(node, prefix, depth = 0) {
    if (!node || typeof node !== "object" || depth > 24) return;
    if (node.$ref?.startsWith("#/")) {
      const key = `${prefix}|${node.$ref}`;
      if (!visited.has(key)) {
        visited.add(key);
        descend(resolve(node.$ref), prefix, depth + 1);
      }
    }
    for (const [name, child] of Object.entries(node.properties || {})) {
      const field = prefix ? `${prefix}.${name}` : name;
      paths.add(field);
      descend(child, field, depth + 1);
    }
    for (const branch of [
      ...(node.allOf || []),
      ...(node.oneOf || []),
      ...(node.anyOf || []),
      node.then,
      node.else,
    ].filter(Boolean))
      descend(branch, prefix, depth + 1);
    if (node.items && !Array.isArray(node.items)) {
      paths.add(`${prefix}.*`);
      descend(node.items, `${prefix}.*`, depth + 1);
    }
    if (
      node.additionalProperties &&
      typeof node.additionalProperties === "object"
    ) {
      paths.add(`${prefix}.*`);
      descend(node.additionalProperties, `${prefix}.*`, depth + 1);
    }
  }
  descend(start, "");
  return paths;
}
const liveFieldReviews = [];
const observedTypes = {};
const normalizeField = (value) =>
  value.replaceAll("[]", ".*").replaceAll("..", ".*.").replace(/\.$/, ".*");
for (const wanted of requestedComponents) {
  const component = components.find(
    (entry) => entry.kind === wanted.kind && entry.type === wanted.type,
  );
  let html;
  try {
    html = await fs.readFile(
      path.join(cache, `${hash(wanted.url)}.html`),
      "utf8",
    );
  } catch {
    continue;
  }
  const fields = documentedFields(html),
    known = component ? schemaPaths(resolve(component.schema_ref)) : new Set();
  const flattened = new Set(
    [...known].map((field) => field.replaceAll(".*.", ".")),
  );
  const unmatched = fields.filter(
    (field) =>
      !known.has(normalizeField(field.path)) &&
      !flattened.has(normalizeField(field.path)),
  );
  for (const field of fields)
    for (const type of field.types) {
      const record = (observedTypes[type] ||= { occurrences: 0, examples: [] });
      record.occurrences++;
      if (record.examples.length < 5)
        record.examples.push({ url: wanted.url, path: field.path });
    }
  liveFieldReviews.push({
    ...wanted,
    documented_field_headers: fields.length,
    matched_schema_paths: fields.length - unmatched.length,
    unmatched_review_candidates: unmatched,
  });
}
const globalPaths = schemaPaths(schema);
const globalFlattened = new Set(
  [...globalPaths].map((field) => field.replaceAll(".*.", ".")),
);
const supplemental = [];
for (const url of urls.normalized_urls.filter(
  (url) => !/\/(sources|transforms|sinks)(\/|$)/.test(new URL(url).pathname),
)) {
  let html;
  try {
    html = await fs.readFile(path.join(cache, `${hash(url)}.html`), "utf8");
  } catch {
    continue;
  }
  const fields = documentedFields(html);
  const tls = url.endsWith("/tls/");
  const known = tls
    ? new Set(
        [
          ...schemaPaths(
            schema.definitions["vector_core::tls::settings::TlsConfig"],
          ),
          ...schemaPaths(
            schema.definitions[
              "vector_core::tls::settings::TlsEnableableConfig"
            ],
          ),
        ].map((field) => `tls.${field}`),
      )
    : globalPaths;
  const flattened = tls ? known : globalFlattened;
  const unmatched = fields.filter(
    (field) =>
      !known.has(normalizeField(field.path)) &&
      !flattened.has(normalizeField(field.path)),
  );
  supplemental.push({
    url,
    documented_field_headers: fields.length,
    matched_schema_paths: fields.length - unmatched.length,
    unmatched_review_candidates: unmatched,
  });
}
const report = {
  generated_at: new Date().toISOString(),
  vector_version: catalog.vector_version,
  schema_sha256: hash(schemaBytes),
  scope:
    "Live official reference retrieval and pinned JSON Schema structure inventory. Compilation is not proof that every renderer interaction or native component works.",
  counts: {
    supplied_urls: urls.requested_urls.length,
    unique_urls: urls.normalized_urls.length,
    successful_pages: pages.filter((record) => record.status === 200).length,
    requested_component_pages: requestedComponents.length,
    catalog_components: components.length,
    schema_definitions: Object.keys(schema.definitions || {}).length,
    schema_nodes: nodes.length,
    component_schemas_compiled: components.filter(
      (component) => component.ajv_compiles,
    ).length,
  },
  missing_requested_components: missing,
  catalog_entries_without_requested_page: extras,
  features,
  components,
  pages,
  limitations: [
    "Live documentation can differ from pinned Vector 0.58.0; raw fetched pages are cached privately and represented here by URL, title, status and SHA-256.",
    "Schema metadata describes some requirements, units and templates that ordinary JSON Schema does not enforce.",
    "The upstream generated schema is experimental. Custom Vector validators, platform/build features, endpoints and device resources require actual native validation.",
    "No claim that every possible nested value, union branch, UI interaction or external integration has been executed.",
  ],
};
report.live_documentation_field_review = {
  method:
    "Extract field header IDs and required/optional/type badges only within the official component Configuration section; compare normalized paths against all pinned schema branches. Repeated/trailing dots represent wildcard keys in the site's anchor generation; array item segments may be flattened in documentation. Missing paths remain review candidates, not compatibility proof.",
  component_pages_reviewed: liveFieldReviews.length,
  field_headers: liveFieldReviews.reduce(
    (n, page) => n + page.documented_field_headers,
    0,
  ),
  matched_paths: liveFieldReviews.reduce(
    (n, page) => n + page.matched_schema_paths,
    0,
  ),
  observed_type_badges: observedTypes,
  pages: liveFieldReviews,
};
report.supplemental_reference_field_review = supplemental;
await fs.writeFile(
  path.join(root, "docs/evidence/vector-reference-audit.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      ...report.counts,
      component_field_headers:
        report.live_documentation_field_review.field_headers,
      matched_component_field_paths:
        report.live_documentation_field_review.matched_paths,
      missing_requested_components: missing,
      catalog_entries_without_requested_page: extras,
      failed_pages: pages.filter((record) => record.status !== 200),
    },
    null,
    2,
  ),
);
if (
  missing.length ||
  components.some((component) => !component.ajv_compiles) ||
  pages.some((record) => record.status !== 200) ||
  liveFieldReviews.some(
    (page) =>
      !page.documented_field_headers || page.unmatched_review_candidates.length,
  ) ||
  supplemental.some((page) => page.unmatched_review_candidates.length)
)
  process.exitCode = 1;
