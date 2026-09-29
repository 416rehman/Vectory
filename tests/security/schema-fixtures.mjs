// Independent probes use exact pinned upstream definitions, not a second UI schema.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "dashboard/package.json"));
const Ajv = require("ajv/dist/2019").default;
const bytes = await fs.readFile(
  path.join(root, "dashboard/src/generated/vector-schema.json"),
);
const schema = JSON.parse(bytes);
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
  logger: false,
});
ajv.addSchema(schema, "vector-pinned");
const ref = (name, suffix = "") =>
  `#/definitions/${name.replaceAll("~", "~0").replaceAll("/", "~1")}${suffix}`;
const results = [];
function probe(name, schemaPath, value, expected) {
  const validate = ajv.getSchema(`vector-pinned${schemaPath}`);
  assert.ok(validate, schemaPath);
  const before = structuredClone(value);
  const accepted = validate(value);
  assert.equal(
    accepted,
    expected,
    `${name}: ${JSON.stringify(validate.errors)}`,
  );
  assert.deepEqual(
    value,
    before,
    `${name}: validation mutated the configuration`,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(value)),
    before,
    `${name}: JSON roundtrip changed the value`,
  );
  results.push({
    name,
    schema_path: schemaPath,
    expected_schema_valid: expected,
    passed: true,
  });
}
const nullable = ref(
  "codecs::decoding::framing::character_delimited::CharacterDelimitedDecoderOptions",
  "/properties/max_length",
);
probe("nullable integer preserves explicit null", nullable, null, true);
probe("nullable integer accepts zero", nullable, 0, true);
probe("nullable integer rejects fraction", nullable, 1.5, false);
probe("nullable integer rejects numeric string", nullable, "32", false);
const conditions = ref("vector::conditions::AnyCondition");
probe("condition shorthand string", conditions, ".status == 200", true);
probe(
  "condition tagged VRL object",
  conditions,
  { type: "vrl", source: ".status == 200" },
  true,
);
probe(
  "condition tagged Datadog object",
  conditions,
  { type: "datadog_search", source: "service:web" },
  true,
);
probe(
  "condition tagged object requires source",
  conditions,
  { type: "vrl" },
  false,
);
const compression = ref(
  "vector::sinks::util::buffer::compression::Compression",
);
probe("compression string form", compression, "gzip", true);
probe(
  "compression object form",
  compression,
  { algorithm: "gzip", level: 3 },
  true,
);
probe(
  "compression mixed enum named level",
  compression,
  { algorithm: "gzip", level: "best" },
  true,
);
probe(
  "compression rejects stringified numeric enum",
  compression,
  { algorithm: "gzip", level: "3" },
  false,
);
probe(
  "compression rejects unknown property",
  compression,
  { algorithm: "gzip", surprise: true },
  false,
);
const buffer = ref("vector_buffers::config::BufferType");
probe(
  "memory buffer count form",
  buffer,
  { type: "memory", max_events: 500 },
  true,
);
probe(
  "disk buffer bytes form",
  buffer,
  { type: "disk", max_size: 268435488 },
  true,
);
probe(
  "disk buffer rejects undersized bytes",
  buffer,
  { type: "disk", max_size: 1024 },
  false,
);
probe("disk buffer requires max size", buffer, { type: "disk" }, false);
const headers = ref(
  "vector::sinks::util::http::RequestConfig",
  "/allOf/0/properties/headers",
);
probe(
  "headers preserve template keys and values",
  headers,
  { "X-{{ tenant }}": "{{ timestamp }}", Accept: "application/json" },
  true,
);
probe("headers enforce string map values", headers, { "X-Retry": 3 }, false);
const logFields = ref("vector::config::TestInput", "/properties/log_fields");
probe(
  "test input arbitrary nested event object",
  logFields,
  {
    nested: { values: [1, false, null, { "a.b": "literal" }] },
    "": "empty key allowed upstream",
  },
  true,
);
probe("test input explicit null", logFields, null, true);
const duration = ref("serde_with::DurationFractionalSeconds");
probe("duration is numeric seconds", duration, 0.125, true);
probe("duration rejects unit suffix string", duration, "125ms", false);
const tls = ref("vector_core::tls::settings::TlsConfig");
probe(
  "TLS optional explicit nullable field",
  tls,
  { verify_certificate: null },
  true,
);
probe(
  "TLS rejects string boolean",
  tls,
  { verify_certificate: "false" },
  false,
);
const tokens = ref(
  "vector::sources::splunk_hec::SplunkConfig",
  "/properties/valid_tokens",
);
probe(
  "credential array native references retain literal strings",
  tokens,
  ["${SPLUNK_TOKEN}", "SECRET[local.token]"],
  true,
);
probe(
  "credential array rejects objects",
  tokens,
  [{ token: "${SPLUNK_TOKEN}" }],
  false,
);
// Upstream JSON Schema does not enforce Vectory's no-plaintext-history policy.
probe(
  "upstream credential schema alone accepts plaintext",
  tokens,
  ["explicit-synthetic-fixture"],
  true,
);
const dnstap = ref("vectory::components::sources::dnstap");
probe(
  "Unix projection TCP conditional address",
  dnstap,
  { type: "dnstap", mode: "tcp", address: "127.0.0.1:6000" },
  true,
);
probe(
  "Unix projection rejects missing conditional address",
  dnstap,
  { type: "dnstap", mode: "tcp" },
  false,
);
const timezone = ref("vrl::compiler::datetime::TimeZone");
probe("timezone named string", timezone, "America/Edmonton", true);
probe(
  "known upstream overlapping oneOf rejects native local timezone",
  timezone,
  "local",
  false,
);
const requestPath = ref(
  "vector::sinks::http::config::HttpSinkConfig",
  "/allOf/0/properties/request",
);
const requestDefault =
  schema.definitions["vector::sinks::http::config::HttpSinkConfig"].allOf[0]
    .properties.request.default;
assert.equal(Number.isSafeInteger(requestDefault.retry_attempts), false);
probe(
  "known upstream default exceeds its own safe integer maximum",
  requestPath,
  requestDefault,
  false,
);
probe(
  "known upstream PathBuf pattern rejects native relative file",
  ref("stdlib::PathBuf"),
  "relative.vrl",
  false,
);

const nativeFixtures = [
  {
    name: "native local timezone",
    config: {
      timezone: "local",
      sources: { seed: { type: "demo_logs", format: "json" } },
      sinks: { out: { type: "blackhole", inputs: ["seed"] } },
    },
  },
  {
    name: "memory enrichment implicit source",
    config: {
      sources: { seed: { type: "demo_logs", format: "json" } },
      enrichment_tables: {
        lookup: {
          type: "memory",
          inputs: ["seed"],
          source_config: { source_key: "memory_source", export_interval: 1 },
        },
      },
      sinks: { out: { type: "blackhole", inputs: ["memory_source"] } },
    },
  },
  {
    name: "native relative VRL source file",
    config: {
      sources: { seed: { type: "demo_logs", format: "json" } },
      transforms: {
        reviewed: { type: "remap", inputs: ["seed"], file: "relative.vrl" },
      },
      sinks: { out: { type: "blackhole", inputs: ["reviewed"] } },
    },
  },
];
const vector = process.env.VECTORY_TEST_VECTOR;
const native = [];
if (vector) {
  const scratch = path.join(root, ".local/schema-audit");
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(path.join(scratch, "relative.vrl"), ".reviewed = true\n");
  for (const [index, fixture] of nativeFixtures.entries()) {
    const file = path.join(scratch, `native-fixture-${index}.json`);
    await fs.writeFile(file, JSON.stringify(fixture.config));
    const result = spawnSync(vector, ["validate", "--no-environment", file], {
      cwd: scratch,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(
      result.status,
      0,
      `${fixture.name}: ${result.stdout} ${result.stderr}`,
    );
    native.push({
      name: fixture.name,
      passed: true,
      command: "vector validate --no-environment",
      config: fixture.config,
    });
  }
}
const report = {
  recorded_at: new Date().toISOString(),
  schema_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  schema_probes: results,
  native_probes: native,
  native_skipped: !vector,
  limitations: [
    "These are representative field-shape and lossless JSON probes, not every field, renderer interaction, platform, or external integration.",
    "AJV format checks are disabled because upstream formats include Vector-specific native types. Live endpoint, regex, VRL, timezone and resource validity still requires pinned native Vector.",
    "The three expected upstream schema inconsistencies are recorded explicitly; accepting the schema does not imply complete native validation.",
  ],
};
const output = path.resolve(
  process.env.VECTORY_SCHEMA_FIXTURES_EVIDENCE ||
    path.join(root, "docs/evidence/schema-fixtures.json"),
);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    schema_probes: results.length,
    native_probes: native.length,
    native_skipped: !vector,
  }),
);
