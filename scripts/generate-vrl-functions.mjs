// VRL function reference for the pinned Vector release, used by the editor's
// VRL completion and hover help.
//
//   node scripts/generate-vrl-functions.mjs                 regenerate the dashboard file
//   node scripts/generate-vrl-functions.mjs --check         verify it is current
//   node scripts/generate-vrl-functions.mjs --refresh-upstream --vector <path>
//       download the exact vrl crate Vector 0.58.0 locks, verify its checksum,
//       read its generated function docs plus Vector's own functions at the
//       pinned commit, and keep only functions the pinned binary compiles.
//
// Nothing here is written by hand: every description, argument, type,
// failure reason and example comes from the pinned upstream sources.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import os from "node:os";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const vendored = path.join(root, "vector-catalog/vrl-functions.json");
const dashboard = path.join(root, "dashboard/src/generated/vrl-functions.json");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const vectorVersion = "0.58.0";
const vectorCommit = "2bcad9bbb84e201dcfd58c22b1f779290101b728";
// From Vector 0.58.0's Cargo.lock at the pinned commit.
const crate = {
  name: "vrl",
  version: "0.35.0",
  sha256: "f05019654027a91520b942bf7fdd387147bb2855244bdf020952e795f74dfca0",
};
const vectorFunctionSources = [
  "lib/vector-vrl/functions/src/get_secret.rs",
  "lib/vector-vrl/functions/src/remove_secret.rs",
  "lib/vector-vrl/functions/src/set_secret.rs",
  "lib/vector-vrl/functions/src/set_semantic_meaning.rs",
];
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const json = (value) => JSON.stringify(canonical(value), null, 2) + "\n";

async function fetchPinned(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`Pinned source fetch failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Minimal ustar reader: regular files only. */
function untar(buffer) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    if (type === "0" || type === "") files.set(prefix ? `${prefix}/${name}` : name, body);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const argument = (entry) => ({
  name: entry.name,
  description: entry.description,
  required: !!entry.required,
  type: entry.type,
  ...(entry.default !== undefined ? { default: String(entry.default) } : {}),
  ...(entry.enum ? { enum: Object.keys(entry.enum) } : {}),
});

function fromCrateDocs(doc) {
  return {
    name: doc.name,
    source: "vrl",
    category: doc.category,
    description: doc.description,
    arguments: (doc.arguments || []).map(argument),
    return: doc.return?.types || [],
    internal_failure_reasons: doc.internal_failure_reasons || [],
    notices: doc.notices || [],
    deprecated: !!doc.deprecated,
    pure: doc.pure !== false,
    examples: (doc.examples || []).slice(0, 3).map((example) => ({
      title: example.title,
      source: example.source,
      ...(example.return !== undefined ? { return: example.return } : {}),
      ...(example.raises !== undefined ? { raises: example.raises } : {}),
    })),
  };
}

/** Vector's own functions share the vrl `Function` shape; read the literal fields. */
function fromVectorSource(text) {
  const literal = (name) => {
    const match = new RegExp(
      `fn ${name}\\(&self\\)[^{]*\\{\\s*(?:indoc!\\s*\\{\\s*)?"((?:[^"\\\\]|\\\\.)*)"`,
      "s",
    ).exec(text);
    return match
      ? JSON.parse(`"${match[1].replace(/\n/g, "\\n")}"`).replace(/^\s+|\s+$/g, "").replace(/\n\s+/g, "\n")
      : undefined;
  };
  const kinds = {
    BYTES: "string",
    INTEGER: "integer",
    FLOAT: "float",
    BOOLEAN: "boolean",
    OBJECT: "object",
    ARRAY: "array",
    TIMESTAMP: "timestamp",
    REGEX: "regex",
    NULL: "null",
    ANY: "any",
  };
  const parameters = [
    ...text.matchAll(
      /Parameter::(required|optional)\(\s*"([^"]+)",\s*([^,]+),\s*"((?:[^"\\]|\\.)*)"/g,
    ),
  ].map(([, mode, name, kind, description]) => ({
    name,
    description: JSON.parse(`"${description}"`),
    required: mode === "required",
    type: [...kind.matchAll(/kind::([A-Z]+)/g)].map(([, k]) => kinds[k] || k.toLowerCase()),
  }));
  const category = /Category::(\w+)/.exec(text)?.[1];
  const name = literal("identifier");
  if (!name) throw Error("Vector function source has no identifier");
  const failures = /fn internal_failure_reasons[^[]*\[([^\]]*)\]/s.exec(text);
  const returnKind = /fn return_kind\(&self\)\s*->\s*u16\s*\{([^}]*)\}/s.exec(text)?.[1] || "";
  return {
    name,
    source: "vector",
    category: category || "Event",
    description: literal("usage") || literal("summary") || "",
    arguments: parameters,
    return: [...returnKind.matchAll(/kind::([A-Z]+)/g)].map(([, k]) => kinds[k] || k.toLowerCase()),
    internal_failure_reasons: failures
      ? [...failures[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, reason]) => JSON.parse(`"${reason}"`))
      : [],
    notices: [],
    deprecated: false,
    pure: false,
    examples: [
      ...text.matchAll(
        /title:\s*"((?:[^"\\]|\\.)*)",\s*source:\s*(?:r#"(.*?)"#|"((?:[^"\\]|\\.)*)")/gs,
      ),
    ]
      .slice(0, 3)
      .map(([, title, raw, quoted]) => ({
        title: JSON.parse(`"${title}"`),
        source: raw ?? JSON.parse(`"${quoted}"`),
      })),
  };
}

/** Keep only functions the pinned binary knows: undefined calls report E105. */
function availableIn(vector, names) {
  const dir = spawnSync("mktemp", ["-d"], { encoding: "utf8" }).stdout.trim() || os.tmpdir();
  const program = path.join(dir, "probe.vrl");
  const input = path.join(dir, "input.jsonl");
  const source = names.map((name, index) => `v${index} = ${name}()`).join("\n");
  return fs
    .writeFile(program, source)
    .then(() => fs.writeFile(input, "{}\n"))
    .then(() => {
      const run = spawnSync(vector, ["vrl", "--program", program, "--input", input], {
        encoding: "utf8",
        env: {},
      });
      const text = (run.stdout + run.stderr).replace(/\x1b\[[0-9;]*m/g, "");
      const missing = new Set();
      const blocks = text.split(/\n(?=error\[)/);
      for (const block of blocks) {
        if (!block.startsWith("error[E105]")) continue;
        const line = /┌─ :(\d+):/.exec(block)?.[1];
        if (line) missing.add(names[Number(line) - 1]);
      }
      if (!/error\[/.test(text)) throw Error("The Vector binary did not compile the probe program");
      return names.filter((name) => !missing.has(name));
    })
    .finally(() => fs.rm(dir, { recursive: true, force: true }));
}

async function refresh() {
  const vector = option("--vector");
  if (!vector) throw Error("Pass --vector <path to the pinned Vector binary>");
  const version = spawnSync(vector, ["--version"], { encoding: "utf8" }).stdout;
  if (!version.includes(vectorVersion)) throw Error(`Expected Vector ${vectorVersion}, got ${version}`);
  const archive = await fetchPinned(
    `https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate`,
  );
  if (sha256(archive) !== crate.sha256) throw Error("vrl crate checksum mismatch");
  const files = untar(zlib.gunzipSync(archive));
  const prefix = `${crate.name}-${crate.version}/docs/generated/`;
  const functions = [];
  for (const [name, body] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    functions.push(fromCrateDocs(JSON.parse(body.toString("utf8"))));
  }
  const sources = [];
  for (const relative of vectorFunctionSources) {
    const text = (
      await fetchPinned(`https://raw.githubusercontent.com/vectordotdev/vector/${vectorCommit}/${relative}`)
    ).toString("utf8");
    sources.push({ path: relative, sha256: sha256(text) });
    functions.push(fromVectorSource(text));
  }
  const available = new Set(await availableIn(vector, functions.map((f) => f.name)));
  const kept = functions
    .filter((f) => available.has(f.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const reference = {
    vector_version: vectorVersion,
    upstream_commit: vectorCommit,
    crate: { ...crate, docs: `${crate.name}-${crate.version}/docs/generated` },
    vector_function_sources: sources,
    verified_with_binary: version.trim(),
    excluded_not_in_binary: functions.filter((f) => !available.has(f.name)).map((f) => f.name),
    functions: kept,
  };
  await fs.writeFile(vendored, json(reference));
  console.log(`Vendored ${kept.length} VRL functions (${reference.excluded_not_in_binary.length} excluded).`);
}

const firstParagraph = (text) =>
  (text || "")
    .split(/\n\s*\n/)[0]
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
const summary = (text) => {
  const paragraph = firstParagraph(text);
  const sentence = /^(.+?[.!?])(\s|$)/.exec(paragraph)?.[1] || paragraph;
  return sentence.length > 180 ? sentence.slice(0, 177) + "…" : sentence;
};
const exampleValue = (example) => {
  if (example.raises !== undefined) return undefined;
  const value = typeof example.return === "string" ? JSON.stringify(example.return) : JSON.stringify(example.return);
  return value && value.length <= 160 ? value : undefined;
};

function compact(reference) {
  return {
    vector_version: reference.vector_version,
    source: `${reference.crate.name} ${reference.crate.version} generated docs and Vector ${reference.vector_version} functions`,
    functions: reference.functions.map((f) => {
      const example = f.examples.find((e) => e.source && e.source.length <= 160);
      const result = example ? exampleValue(example) : undefined;
      return {
        name: f.name,
        category: f.category,
        summary: summary(f.description),
        description: firstParagraph(f.description).slice(0, 600),
        arguments: f.arguments.map((a) => ({
          name: a.name,
          type: a.type.join(" | "),
          required: a.required,
          ...(a.default !== undefined ? { default: a.default } : {}),
          ...(a.enum ? { enum: a.enum.slice(0, 12) } : {}),
          description: summary(a.description),
        })),
        returns: f.return.join(" | "),
        fallible: f.internal_failure_reasons.length > 0,
        failure: f.internal_failure_reasons[0] ? summary(f.internal_failure_reasons[0]) : undefined,
        deprecated: f.deprecated || undefined,
        vector: f.source === "vector" || undefined,
        example: example ? { source: example.source, ...(result ? { result } : {}) } : undefined,
      };
    }),
  };
}

if (args.includes("--refresh-upstream")) await refresh();
const reference = JSON.parse(await fs.readFile(vendored, "utf8"));
const output = json(compact(reference));
if (args.includes("--check")) {
  const current = await fs.readFile(dashboard, "utf8").catch(() => "");
  if (current !== output) {
    console.error("dashboard/src/generated/vrl-functions.json is out of date. Run node scripts/generate-vrl-functions.mjs");
    process.exit(1);
  }
  console.log(`VRL function reference is current (${reference.functions.length} functions).`);
} else {
  await fs.writeFile(dashboard, output);
  console.log(`Wrote ${reference.functions.length} VRL functions for the dashboard.`);
}
