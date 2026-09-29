import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "dashboard/package.json"));
const { build } = require("esbuild");
const generated = JSON.parse(
  await fs.readFile(
    path.join(root, "dashboard/src/generated/vector-catalog.json"),
    "utf8",
  ),
);
const schemaBytes = await fs.readFile(
  path.join(root, "dashboard/src/generated/vector-schema.json"),
);
assert.equal(
  createHash("sha256").update(schemaBytes).digest("hex"),
  generated.schema_sha256,
  "catalog schema digest",
);
const bundled = await build({
  entryPoints: [path.join(root, "dashboard/src/catalog.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "es2022",
});
const { catalog, starter } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const compiledPolicy = await fs.readFile(
  path.join(root, "agent/internal/agent/policy.go"),
  "utf8",
);
const supportedBlock = compiledPolicy
  .split("var supported =")[1]
  ?.split("var environmentVariable")[0];
assert.ok(supportedBlock, "agent support table must be present");
const allowed = [
  ...supportedBlock.matchAll(/"(sources|transforms|sinks)":\s*\{([^}]+)\}/g),
]
  .flatMap((section) =>
    [...section[2].matchAll(/"([^"]+)":\s*true/g)].map(
      (type) => section[1] + "/" + type[1],
    ),
  )
  .sort();
assert.deepEqual(
  generated.components
    .filter((item) => item.device_capability === "allowed")
    .map((item) => item.kind + "/" + item.type)
    .sort(),
  allowed,
  "catalog cannot promise component types absent from the agent",
);
assert.equal(
  new Set(catalog.map((item) => item.kind + "/" + item.type)).size,
  catalog.length,
  "kind/type identities must be unique",
);
assert.deepEqual(
  catalog.map((item) => item.kind + "/" + item.type).sort(),
  generated.components.map((item) => item.kind + "/" + item.type).sort(),
  "picker must include every generated component type",
);
const vector =
  process.env.VECTORY_VECTOR_BIN ||
  path.join(root, ".local/tools/vector-0.58.0/bin/vector.exe");
const version = spawnSync(vector, ["--version"], {
  encoding: "utf8",
  timeout: 10000,
  windowsHide: true,
});
assert.equal(version.status, 0, "pinned Vector executable must run");
assert.match(
  version.stdout,
  /vector 0\.58\.0\b/,
  "catalog fixtures require the pinned Vector version",
);
// These explicit synthetic resource values are fixture inputs, never defaults
// inserted into a user's ordinary pipeline or contacted by this validation.
const fixtureInputs = {
  file: { include: ["/var/log/app/*.log"] },
  http: { uri: "https://logs.example.com" },
  elasticsearch: { endpoints: ["https://elasticsearch.example.com:9200"] },
  loki: { endpoint: "https://loki.example.com" },
};
const results = [];
await fs.mkdir(path.join(root, "vector-catalog/fixtures"), { recursive: true });
for (const item of catalog.filter((item) => item.curated)) {
  const config = structuredClone(starter);
  const component = {
    type: item.type,
    ...item.defaults,
    ...fixtureInputs[item.type],
  };
  if (item.kind === "sources") {
    config.sources = { sample: component };
    config.transforms.enrich.inputs = [
      item.type === "opentelemetry" ? "sample.logs" : "sample",
    ];
  } else if (item.kind === "transforms") {
    config.transforms = { process: { ...component, inputs: ["demo"] } };
    config.sinks.output.inputs = [
      item.type === "route" ? "process.errors" : "process",
    ];
  } else {
    config.sinks = { output: { ...component, inputs: ["enrich"] } };
  }
  const filename = path.join(
    root,
    "vector-catalog/fixtures",
    item.type + ".json",
  );
  await fs.writeFile(filename, JSON.stringify(config, null, 2) + "\n");
  const result = spawnSync(
    vector,
    [
      "validate",
      "--no-environment",
      "--skip-healthchecks",
      "--config-json",
      filename,
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536, windowsHide: true },
  );
  results.push({
    fixture_set: "curated",
    kind: item.kind,
    component: item.type,
    valid: result.status === 0,
    validation:
      "Curated fixture only: pinned Windows Vector syntax/topology; no endpoint health or environment checks",
    diagnostics:
      result.status === 0
        ? undefined
        : String(result.error || result.stdout + result.stderr).replaceAll(
            root,
            "<workspace>",
          ),
  });
}
const expandedFixtures = [
  {
    kind: "sources",
    component: "kafka",
    config: {
      sources: {
        events: {
          type: "kafka",
          bootstrap_servers: "127.0.0.1:19092",
          group_id: "vectory-schema-fixture",
          topics: ["vectory-browser-fixture"],
          decoding: { codec: "json" },
        },
      },
      sinks: {
        output: {
          type: "console",
          inputs: ["events"],
          target: "stderr",
          encoding: { codec: "json" },
        },
      },
    },
  },
  {
    kind: "sinks",
    component: "aws_s3",
    config: {
      sources: { events: { type: "demo_logs", format: "json" } },
      sinks: {
        output: {
          type: "aws_s3",
          inputs: ["events"],
          bucket: "vectory-browser-fixture",
          region: "us-east-1",
          encoding: { codec: "json" },
        },
      },
    },
  },
  {
    kind: "sources",
    component: "internal_metrics",
    also_components: ["sinks/prometheus_exporter"],
    config: {
      sources: { metrics: { type: "internal_metrics" } },
      sinks: {
        output: {
          type: "prometheus_exporter",
          inputs: ["metrics"],
          address: "127.0.0.1:19091",
        },
      },
    },
  },
];
for (const fixture of expandedFixtures) {
  const filename = path.join(
    root,
    "vector-catalog/fixtures",
    fixture.component + ".json",
  );
  await fs.writeFile(filename, JSON.stringify(fixture.config, null, 2) + "\n");
  const result = spawnSync(
    vector,
    [
      "validate",
      "--no-environment",
      "--skip-healthchecks",
      "--config-json",
      filename,
    ],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536, windowsHide: true },
  );
  results.push({
    fixture_set: "expanded",
    kind: fixture.kind,
    component: fixture.component,
    also_components: fixture.also_components,
    valid: result.status === 0,
    validation:
      "Representative generated-type fixture only: pinned Windows Vector syntax/topology; no endpoint health or environment checks",
    diagnostics:
      result.status === 0
        ? undefined
        : String(result.error || result.stdout + result.stderr).replaceAll(
            root,
            "<workspace>",
          ),
  });
}
const tested = new Set(
  results
    .filter((result) => result.valid)
    .flatMap((result) => [
      result.kind + "/" + result.component,
      ...(result.also_components || []),
    ]),
);
await fs.writeFile(
  path.join(root, "vector-catalog/catalog.json"),
  JSON.stringify(
    {
      version: 2,
      vector_version: generated.vector_version,
      upstream_commit: generated.upstream_commit,
      schema_sha256: generated.schema_sha256,
      source:
        "Pinned experimental Vector-generated JSON Schema plus upstream platform metadata. Type editing coverage is separate from tested fixtures and local agent support.",
      coverage_note: generated.coverage_note,
      components: catalog.map((component) => ({
        kind: component.kind,
        type: component.type,
        label: component.label,
        schema_ref: component.schema_ref,
        docs_url: component.docs_url,
        platforms: component.platforms,
        device_capability: component.device_capability,
        form: component.curated
          ? "curated fields and schema options"
          : "schema-driven fields and raw JSON",
        native_fixture_tested: tested.has(
          component.kind + "/" + component.type,
        ),
        fields: component.fields.map((field) => field.key),
      })),
    },
    null,
    2,
  ) + "\n",
);
await fs.writeFile(
  path.join(root, "docs/evidence/vector-catalog.json"),
  JSON.stringify(
    {
      vector_version: generated.vector_version,
      schema_sha256: generated.schema_sha256,
      catalog_components: catalog.length,
      agent_supported_types: allowed.length,
      curated_fixture_count: results.filter(
        (result) => result.fixture_set === "curated",
      ).length,
      expanded_fixture_count: results.filter(
        (result) => result.fixture_set === "expanded",
      ).length,
      native_fixture_tested_component_types: tested.size,
      untested_components: catalog.length - tested.size,
      limits:
        "Fixture results do not certify the remaining component types, platform availability, external endpoint integration, or agent activation. Device-local capability policy is unchanged.",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      components: catalog.length,
      agent_supported_types: allowed.length,
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => !result.valid)) process.exitCode = 1;
