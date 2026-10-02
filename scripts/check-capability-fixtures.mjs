// Checks the capability fixtures in vector-catalog/fixtures/capabilities:
// each file's shape, that its expected needs follow from the capability table
// by the rules of that directory's README.md, and, with the pinned Vector at
// hand, that `vector validate --no-environment` agrees with its `vector` field.
//
//   node scripts/check-capability-fixtures.mjs                 skip Vector when absent
//   node scripts/check-capability-fixtures.mjs --require-vector fail when absent (CI)
//
// The pinned binary comes from VECTOR_TEST_BINARY, VECTORY_TEST_VECTOR or
// .local/tools/vector-x86_64-unknown-linux-gnu/bin/vector. The needs function
// here is the README read as code, used only to keep the fixtures consistent
// with the table; the agent, the server and the dashboard each have their own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
export const FIXTURES = "vector-catalog/fixtures/capabilities";
const TABLE = "dashboard/src/generated/capability-table.json";
export const CATEGORIES = [
  "refused",
  "full_mode",
  "components",
  "capabilities",
  "network",
  "listeners",
  "file_roots",
  "writes",
  "assets",
];
const SECTIONS = ["sources", "transforms", "sinks"];
const KIND_CODES = {
  url: "NETWORK_DESTINATION_DENIED",
  host_port: "NETWORK_DESTINATION_DENIED",
  host_port_list: "NETWORK_DESTINATION_DENIED",
  unix_connect: "NETWORK_DESTINATION_DENIED",
  listen: "LISTENER_DENIED",
  file: "FILE_ACCESS_DENIED",
  glob: "FILE_ACCESS_DENIED",
  dir: "FILE_ACCESS_DENIED",
  unix_listen: "FILE_ACCESS_DENIED",
};

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const present = (value) =>
  value !== undefined && value !== null && value !== false;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byte = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const pointer = (segments) =>
  segments
    .map((s) => "/" + String(s).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("");

/** Every value a rule path reaches in value, with its pointer segments. */
function lookup(value, rulePath, base) {
  let found = [{ value, segments: base }];
  for (const part of rulePath ? rulePath.split(".") : []) {
    const [, key, lists] = /^(.*?)((?:\[\])*)$/.exec(part);
    const next = [];
    for (const at of found) {
      if (!isObject(at.value)) continue;
      if (key === "*")
        for (const child of Object.keys(at.value))
          next.push({
            value: at.value[child],
            segments: [...at.segments, child],
          });
      else if (Object.hasOwn(at.value, key))
        next.push({ value: at.value[key], segments: [...at.segments, key] });
    }
    found = next;
    for (let i = 0; i < lists.length / 2; i++)
      found = found.flatMap((at) =>
        Array.isArray(at.value)
          ? at.value.map((item, index) => ({
              value: item,
              segments: [...at.segments, index],
            }))
          : [],
      );
  }
  return found;
}
// The pointer of a rule path that matched nothing: cut before the first [] or * segment.
function missingPointer(rulePath, base) {
  const segments = [...base];
  for (const part of rulePath.split(".")) {
    if (part === "*" || part.startsWith("*")) break;
    if (part.endsWith("[]")) {
      segments.push(part.replace(/(?:\[\])+$/, ""));
      break;
    }
    segments.push(part);
  }
  return pointer(segments);
}
const valueAt = (value, field) =>
  field
    .split(".")
    .reduce(
      (at, key) =>
        isObject(at) && Object.hasOwn(at, key) ? at[key] : undefined,
      value,
    );
const holds = (value, when) =>
  Object.entries(when || {}).every(([field, values]) => {
    const at = valueAt(value, field);
    return at !== undefined && values.some((candidate) => same(candidate, at));
  });

const cleanPath = (text) => {
  if (
    typeof text !== "string" ||
    !text.startsWith("/") ||
    /[\x00-\x1f\x7f]/.test(text)
  )
    return null;
  const parts = [];
  for (const segment of text.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    parts.push(segment);
  }
  return "/" + parts.join("/");
};
const inside = (child, parent) =>
  child === parent || child.startsWith(parent === "/" ? "/" : parent + "/");

function hostPort(text, defaultPort) {
  let host, port;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0 || !/^\[[0-9A-Fa-f:.]+\]$/.test(text.slice(0, close + 1)))
      return null;
    host = text.slice(0, close + 1);
    const rest = text.slice(close + 1);
    if (rest && !rest.startsWith(":")) return null;
    port = rest ? rest.slice(1) : undefined;
  } else {
    const parts = text.split(":");
    if (parts.length > 2) return null;
    [host, port] = parts;
    if (!/^[A-Za-z0-9._-]+$/.test(host)) return null;
  }
  if (port === undefined) port = defaultPort;
  if (
    port === undefined ||
    !/^[0-9]{1,5}$/.test(port) ||
    +port < 1 ||
    +port > 65535
  )
    return null;
  return `${host.toLowerCase()}:${+port}`;
}

/** The README's "How needs follow from the table", as code. */
export function needs(table, { config, host, assets = [] }) {
  const out = Object.fromEntries(CATEGORIES.map((key) => [key, []]));
  const add = (category, item) => out[category].push(item);
  const scopes = new Map(
    [
      ...table.components,
      ...table.global_settings,
      ...table.enrichment_tables,
    ].map((s) => [s.scope, s]),
  );
  const assetFields = table.asset_fields;
  const protectedDirs = host
    ? [host.state_dir, host.managed_config_dir].map(cleanPath).filter(Boolean)
    : [];
  const refusedVRL = table.vrl_functions.refused.map(
    (name) => new RegExp(`(?:^|[^A-Za-z0-9_.])${name}\\s*(?:!\\s*)?\\(`),
  );

  // Every scope of the configuration: [scope name, value, pointer segments].
  const parts = [];
  for (const [key, value] of Object.entries(config)) {
    if (SECTIONS.includes(key)) {
      for (const [id, component] of Object.entries(
        isObject(value) ? value : {},
      ))
        parts.push([
          typeof component?.type === "string"
            ? `${key}/${component.type}`
            : null,
          component,
          [key, id],
          key,
        ]);
    } else if (key === "enrichment_tables") {
      parts.push(["global/enrichment_tables", value, [key]]);
      for (const [name, entry] of Object.entries(isObject(value) ? value : {}))
        parts.push([
          typeof entry?.type === "string"
            ? `enrichment_tables/${entry.type}`
            : null,
          entry,
          [key, name],
        ]);
    } else parts.push([`global/${key}`, config, [], key]);
  }

  // Asset references, in every scope and tier.
  const references = new Set();
  const assetFieldsOf = (name, value, base) => {
    const at = new Map();
    for (const field of assetFields.filter((f) => f.scope === name))
      for (const found of lookup(value, field.path, base))
        at.set(pointer(found.segments), field);
    return at;
  };
  const scopePointer = (base, globalKey) =>
    pointer(base.length ? base : [globalKey]);
  const examined = new Set();
  for (const [name, , base, globalKey] of parts) {
    const scope = name && scopes.get(name);
    if (scope && scope.tier !== "full")
      examined.add(scopePointer(base, globalKey));
  }
  for (const [name, value, base, globalKey] of parts) {
    if (name === "global/enrichment_tables") continue;
    const fields = name ? assetFieldsOf(name, value, base) : new Map();
    const start =
      globalKey && !SECTIONS.includes(globalKey)
        ? [{ value: value[globalKey], segments: [globalKey] }]
        : [{ value, segments: base }];
    const inExamined = examined.has(scopePointer(base, globalKey));
    (function walk(node, segments) {
      if (typeof node === "string") {
        if (!node.startsWith("vectory-asset:")) return;
        const at = pointer(segments);
        references.add(at);
        const match =
          /^vectory-asset:([A-Za-z][A-Za-z0-9_.-]{0,63})@sha256:([0-9a-f]{64})$/.exec(
            node,
          );
        const listed =
          match &&
          assets.find((a) => a.name === match[1] && a.sha256 === match[2]);
        const field = fields.get(at);
        if (!listed || !field || field.kind !== listed.kind)
          return add("refused", { code: "ASSET_REFERENCE_REFUSED", at });
        add("assets", {
          name: listed.name,
          sha256: listed.sha256,
          kind: listed.kind,
          at,
        });
        if (field.capability && inExamined)
          add("capabilities", field.capability);
      } else if (Array.isArray(node))
        node.forEach((item, index) => walk(item, [...segments, index]));
      else if (isObject(node))
        for (const [key, child] of Object.entries(node))
          walk(child, [...segments, key]);
    })(start[0].value, start[0].segments);
  }

  // The monitoring exporter needs no listener allowance.
  const sources = isObject(config.sources) ? config.sources : {};
  const exporter = Object.keys(isObject(config.sinks) ? config.sinks : {})
    .sort(byte)
    .find((id) => {
      const sink = config.sinks[id];
      return (
        sink?.type === "prometheus_exporter" &&
        typeof sink.address === "string" &&
        /^(?:127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}|\[::1\]):(\d{1,5})$/.test(
          sink.address,
        ) &&
        +sink.address.split(":").at(-1) >= 1 &&
        +sink.address.split(":").at(-1) <= 65535 &&
        Array.isArray(sink.inputs) &&
        sink.inputs.length > 0 &&
        sink.inputs.every(
          (input) => sources[input]?.type === "internal_metrics",
        )
      );
    });

  for (const [name, value, base, globalKey] of parts) {
    const at = pointer(base.length ? base : [globalKey]);
    if (name === "global/enrichment_tables") {
      const scope = scopes.get(name);
      if (scope.tier === "full") add("full_mode", { code: scope.code, at });
      continue;
    }
    const scope = name && scopes.get(name);
    if (!scope) {
      add("full_mode", { code: "UNSUPPORTED_LOCAL_CAPABILITY", at });
      continue;
    }
    if (scope.tier === "full") {
      add("full_mode", { code: scope.code, at });
      continue;
    }
    if (scope.tier === "approval" && SECTIONS.includes(base[0]))
      add("components", name.split("/")[1]);
    const root = globalKey && !SECTIONS.includes(globalKey) ? [] : base;
    examineScope({
      scope,
      value,
      root,
      globalKey,
      add,
      protectedDirs,
      refusedVRL,
      references,
      table,
      exporter: base[0] === "sinks" && base[1] === exporter,
    });
  }

  // Sort and drop duplicates.
  const unique = (list, key) => [
    ...new Map(list.map((item) => [key(item), item])).values(),
  ];
  for (const category of ["refused", "full_mode"])
    out[category] = unique(out[category], (i) => `${i.at}\u0000${i.code}`).sort(
      (a, b) => byte(a.at, b.at) || byte(a.code, b.code),
    );
  out.assets = unique(out.assets, (i) => i.at).sort((a, b) => byte(a.at, b.at));
  for (const category of [
    "components",
    "capabilities",
    "network",
    "listeners",
    "file_roots",
    "writes",
  ])
    out[category] = [...new Set(out[category])].sort(byte);
  return out;
}

function examineScope({
  scope,
  value,
  root,
  globalKey,
  add,
  protectedDirs,
  refusedVRL,
  references,
  table,
  exporter,
}) {
  // A global setting's rules start at the configuration's root, but only
  // reach into its own key.
  const scopeValue =
    globalKey && root.length === 0 ? { [globalKey]: value[globalKey] } : value;
  const rules = Object.entries(scope.rules);
  const templateFields = new Set();
  for (const [rulePath, rule] of rules)
    if (
      rule.class === "template" ||
      (rule.class === "resource" && rule.template)
    )
      for (const found of lookup(scopeValue, rulePath, root))
        templateFields.add(pointer(found.segments));

  // Strings: the table's string rules (not under /tests), then refused VRL.
  const stopped = new Set();
  (function walk(node, segments) {
    if (typeof node === "string") {
      const at = pointer(segments);
      const underTests = segments[0] === "tests" && globalKey === "tests";
      if (!underTests)
        for (const rule of table.string_rules) {
          if (rule.except === "template_fields" && templateFields.has(at))
            continue;
          if (
            rule.contains
              ? node.includes(rule.contains)
              : new RegExp(rule.pattern).test(node)
          ) {
            add("full_mode", { code: rule.code, at });
            stopped.add(at);
            break;
          }
        }
      if (refusedVRL.some((call) => call.test(node))) {
        add("full_mode", { code: "DYNAMIC_CAPABILITY_DENIED", at });
        stopped.add(at);
      }
    } else if (Array.isArray(node))
      node.forEach((item, index) => walk(item, [...segments, index]));
    else if (isObject(node))
      for (const [key, child] of Object.entries(node))
        walk(child, [...segments, key]);
  })(
    globalKey && root.length === 0 ? value[globalKey] : value,
    globalKey && root.length === 0 ? [globalKey] : root,
  );

  const pathRoot = (text, at, code, rule) => {
    const cleaned = cleanPath(text);
    if (cleaned === null) return add("full_mode", { code, at });
    let rootPath = cleaned;
    if (rule.kind === "glob") {
      const wildcard = cleaned.search(/[*?[]/);
      if (wildcard >= 0)
        rootPath = cleaned.slice(0, cleaned.lastIndexOf("/", wildcard)) || "/";
    }
    return claim(rootPath, at, code, rule);
  };
  const claim = (rootPath, at, code, rule) => {
    if (
      rootPath === "/" ||
      protectedDirs.some(
        (dir) => inside(rootPath, dir) || inside(dir, rootPath),
      )
    )
      return add("full_mode", { code, at });
    add("file_roots", rootPath);
    if (rule.writes) add("writes", rootPath);
  };

  for (const [rulePath, rule] of rules) {
    if (!holds(scopeValue, rule.when)) continue;
    const found = lookup(scopeValue, rulePath, root);
    if (rule.class === "resource") {
      const code = KIND_CODES[rule.kind];
      if (!found.length) {
        if (rule.required)
          add("full_mode", { code, at: missingPointer(rulePath, root) });
        continue;
      }
      if (
        rule.base_dir &&
        found.length &&
        present(valueAt(scopeValue, rule.base_dir))
      )
        continue;
      for (const { value: text, segments } of found) {
        const at = pointer(segments);
        if (stopped.has(at) || references.has(at)) continue;
        if (typeof text === "string" && text.startsWith("vectory-secret:"))
          continue;
        if (rulePath === "address" && exporter) continue;
        if (typeof text !== "string" || text === "") {
          add("full_mode", { code, at });
          continue;
        }
        resource(rule, text, at, code, { add, pathRoot, claim });
      }
    } else if (rule.class === "refused") {
      for (const { value: v, segments } of found)
        if (present(v))
          add("full_mode", { code: rule.code, at: pointer(segments) });
    } else if (rule.class === "constrained") {
      const values = found.length
        ? found
        : "default" in rule
          ? [{ value: rule.default, segments: null }]
          : [];
      for (const { value: v, segments } of values) {
        const listed = (rule.allowed || rule.refused_values).some((candidate) =>
          same(candidate, v),
        );
        if (rule.allowed ? !listed : listed)
          add("full_mode", {
            code: rule.code,
            at: segments ? pointer(segments) : missingPointer(rulePath, root),
          });
      }
    } else if (rule.class === "options") {
      for (const { value: map, segments } of found)
        if (isObject(map))
          for (const key of Object.keys(map))
            if (!rule.allowed_keys.includes(key))
              add("full_mode", {
                code: rule.code,
                at: pointer([...segments, key]),
              });
    } else if (rule.class === "ambient") {
      if (found.some(({ value: v }) => present(v)))
        add("capabilities", rule.capability);
    }
  }

  for (const credential of scope.credentials) {
    if (!holds(scopeValue, credential.when)) continue;
    const shape = table.credential_shapes[credential.shape];
    const [found] = lookup(scopeValue, credential.path, root);
    const object = isObject(found?.value) ? found.value : {};
    const segments = found
      ? found.segments
      : [...root, ...credential.path.split(".")];
    for (const [key, refusal] of Object.entries(shape.refused_keys || {}))
      if (present(object[key]))
        add("full_mode", {
          code: refusal.code,
          at: pointer([...segments, key]),
        });
    if (shape.kind_field) {
      const kind = object[shape.kind_field];
      if (Object.hasOwn(shape.refused_kinds || {}, kind))
        add("full_mode", {
          code: shape.refused_kinds[kind].code,
          at: pointer([...segments, shape.kind_field]),
        });
      if ((shape.ambient_kinds || []).includes(kind))
        add("capabilities", shape.capability);
    } else if (
      !shape.explicit.some((key) => present(object[key])) ||
      shape.ambient_keys.some((key) => present(object[key]))
    )
      add("capabilities", shape.capability);
  }
}

function resource(rule, text, at, code, { add, pathRoot, claim }) {
  const kind = rule.kind;
  if (kind === "listen") return add("listeners", text);
  if (["file", "glob", "dir", "unix_listen"].includes(kind)) {
    if (rule.template && /\{\{|%/.test(text)) {
      if (!text.startsWith("/"))
        return add("full_mode", {
          code: text.includes("{{") ? "TEMPLATE_RESOURCE_DENIED" : code,
          at,
        });
      const first = text.search(/\{\{|%/);
      const prefix = text.slice(0, first);
      const literal = cleanPath(
        prefix.slice(0, prefix.lastIndexOf("/")) || "/",
      );
      if (
        /(?:^|\/)\.\.(?:\/|$)/.test(text) ||
        /[\x00-\x1f\x7f]/.test(text) ||
        literal === null
      )
        return add("full_mode", { code, at });
      if (literal === "/" && text.includes("{{"))
        return add("full_mode", { code: "TEMPLATE_RESOURCE_DENIED", at });
      return claim(literal, at, code, rule);
    }
    return pathRoot(text, at, code, rule);
  }
  if (kind === "unix_connect") {
    const cleaned = cleanPath(text);
    return cleaned === null
      ? add("full_mode", { code, at })
      : add("network", "unix:" + cleaned);
  }
  if (kind === "host_port") {
    const destination = hostPort(text);
    return destination
      ? add("network", destination)
      : add("full_mode", { code, at });
  }
  if (kind === "host_port_list") {
    const items = text.split(",").map((item) => item.trim());
    const destinations = items.map((item) => hostPort(item));
    if (destinations.some((d) => !d)) return add("full_mode", { code, at });
    return destinations.forEach((d) => add("network", d));
  }
  // url
  const schemes = rule.schemes || ["http", "https"];
  const separator = text.indexOf("://");
  const authorityStart = separator < 0 ? -1 : separator + 3;
  const rest = authorityStart < 0 ? "" : text.slice(authorityStart);
  const authorityEnd =
    authorityStart < 0
      ? text.length
      : authorityStart +
        (rest.search(/[/?#]/) < 0 ? rest.length : rest.search(/[/?#]/));
  const template = rule.template ? text.indexOf("{{") : -1;
  if (template >= 0 && template < authorityEnd)
    return add("full_mode", { code: "TEMPLATE_RESOURCE_DENIED", at });
  if (separator < 0) return add("full_mode", { code, at });
  const scheme = text.slice(0, separator).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || !schemes.includes(scheme))
    return add("full_mode", { code, at });
  if (scheme === "unix") {
    const cleaned = cleanPath(rest);
    return cleaned === null
      ? add("full_mode", { code, at })
      : add("network", "unix:" + cleaned);
  }
  const authority = text.slice(authorityStart, authorityEnd);
  if (!authority || /[@%]/.test(authority))
    return add("full_mode", { code, at });
  const destination = hostPort(authority, { http: "80", https: "443" }[scheme]);
  return destination
    ? add("network", destination)
    : add("full_mode", { code, at });
}

/** Problems with one fixture's shape. */
export function shapeProblems(fixture, codes) {
  const problems = [];
  const keys = [
    "description",
    "host",
    "assets",
    "vector",
    "vector_error",
    "config",
    "needs",
  ];
  if (!isObject(fixture)) return ["must be an object"];
  for (const key of Object.keys(fixture))
    if (!keys.includes(key)) problems.push(`unknown key "${key}"`);
  if (typeof fixture.description !== "string" || !fixture.description)
    problems.push("needs a description");
  if (!["valid", "invalid", "skip"].includes(fixture.vector))
    problems.push('vector must be "valid", "invalid" or "skip"');
  if (fixture.vector === "skip" && !fixture.vector_error)
    problems.push("a skipped fixture says why in vector_error");
  if (fixture.vector === "valid" && "vector_error" in fixture)
    problems.push("a valid fixture has no vector_error");
  if (!isObject(fixture.config)) problems.push("config must be an object");
  if (
    "host" in fixture &&
    !(
      isObject(fixture.host) &&
      cleanPath(fixture.host.state_dir) &&
      cleanPath(fixture.host.managed_config_dir)
    )
  )
    problems.push(
      "host names state_dir and managed_config_dir as absolute paths",
    );
  if (
    "assets" in fixture &&
    !(
      Array.isArray(fixture.assets) &&
      fixture.assets.every(
        (a) =>
          isObject(a) && a.name && /^[0-9a-f]{64}$/.test(a.sha256) && a.kind,
      )
    )
  )
    problems.push("assets lists {name, sha256, kind}");
  if (!isObject(fixture.needs)) return [...problems, "needs must be an object"];
  for (const category of CATEGORIES)
    if (!Array.isArray(fixture.needs[category]))
      problems.push(`needs.${category} must be a list, even when empty`);
  for (const key of Object.keys(fixture.needs))
    if (!CATEGORIES.includes(key))
      problems.push(`needs has an unknown category "${key}"`);
  for (const category of ["refused", "full_mode"])
    for (const item of fixture.needs[category] || [])
      if (
        !isObject(item) ||
        !codes.includes(item.code) ||
        typeof item.at !== "string" ||
        !item.at.startsWith("/")
      )
        problems.push(
          `needs.${category}: each item is {code, at} with a code from the table and a JSON Pointer`,
        );
  return problems;
}

export function loadFixtures(base = root) {
  const dir = path.join(base, FIXTURES);
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      fixture: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")),
    }));
}

export function vectorBinary(base = root) {
  for (const candidate of [
    process.env.VECTOR_TEST_BINARY,
    process.env.VECTORY_TEST_VECTOR,
    path.join(base, ".local/tools/vector-x86_64-unknown-linux-gnu/bin/vector"),
  ])
    if (candidate && fs.existsSync(candidate)) return candidate;
  return null;
}

/** Runs `vector validate --no-environment` on a fixture's configuration. */
export function validate(binary, config) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vectory-capability-fixture-"),
  );
  try {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify(config));
    const result = spawnSync(
      binary,
      ["validate", "--no-environment", "--config-json", file],
      {
        encoding: "utf8",
        timeout: 60000,
        env: { PATH: process.env.PATH || "/usr/bin:/bin" },
      },
    );
    return {
      ok: result.status === 0,
      output: `${result.stdout || ""}${result.stderr || ""}${result.error || ""}`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const requireVector = process.argv.includes("--require-vector");
  const table = JSON.parse(fs.readFileSync(path.join(root, TABLE), "utf8"));
  const codes = Object.keys(table.codes);
  const binary = vectorBinary();
  if (requireVector && !binary) {
    console.error(
      "The pinned Vector is required: set VECTOR_TEST_BINARY to Vector 0.58.0.",
    );
    process.exit(1);
  }
  if (binary) {
    const version =
      spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout || "";
    if (!/^vector 0\.58\.0\b/.test(version)) {
      console.error(`${binary} is not Vector 0.58.0: ${version.trim()}`);
      process.exit(1);
    }
  }
  const problems = [];
  let validated = 0;
  const fixtures = loadFixtures();
  for (const { file, fixture } of fixtures) {
    const report = (text) => problems.push(`${FIXTURES}/${file}: ${text}`);
    const shape = shapeProblems(fixture, codes);
    shape.forEach(report);
    if (shape.length) continue;
    const actual = needs(table, fixture);
    for (const category of CATEGORIES)
      if (!same(actual[category], fixture.needs[category]))
        report(
          `needs.${category} is ${JSON.stringify(fixture.needs[category])}; the table gives ${JSON.stringify(actual[category])}`,
        );
    if (binary && fixture.vector !== "skip") {
      const { ok, output } = validate(binary, fixture.config);
      validated++;
      if (fixture.vector === "valid" && !ok)
        report(
          `Vector refuses it: ${output.trim().split("\n").slice(-3).join(" | ")}`,
        );
      if (fixture.vector === "invalid" && ok)
        report("Vector accepts it, but the fixture says it is invalid");
      if (
        fixture.vector === "invalid" &&
        !ok &&
        fixture.vector_error &&
        !output.includes(fixture.vector_error)
      )
        report(
          `Vector refuses it, but not with "${fixture.vector_error}": ${output.trim().split("\n").slice(-3).join(" | ")}`,
        );
    }
  }
  if (fixtures.length < 1) problems.push(`${FIXTURES}: no fixtures`);
  if (problems.length) {
    console.error(
      `Capability fixtures disagree with the table or with Vector:\n${problems.map((p) => `  ${p}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log(
    `${fixtures.length} capability fixtures follow from the table${binary ? `; Vector ${validated === 1 ? "checked 1" : `checked ${validated}`}` : "; Vector not found, so their configurations weren't validated (set VECTOR_TEST_BINARY)"}.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main();
