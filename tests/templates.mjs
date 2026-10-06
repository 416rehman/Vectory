// Every pipeline template passes the pinned Vector's own validation and the
// editor's local checks, and "Add monitoring" never collides with a step.
//   VECTORY_VECTOR_BIN=<vector 0.58.0> node tests/templates.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "dashboard/package.json"));
const { build } = require("esbuild");
const bundled = await build({
  stdin: {
    contents: [
      'export { pipelineTemplates, withMonitoring, MONITORING_SINK } from "./pipelineTemplates";',
      'export { diagnoseConfiguration } from "./configurationSource";',
    ].join("\n"),
    resolveDir: path.join(root, "dashboard/src"),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "es2022",
  logLevel: "silent",
  // Bundled CommonJS dependencies (yaml) require Node built-ins.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
// The bundle carries the pinned schema, so it loads from a file.
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "vectory-templates-"),
);
const bundle = path.join(directory, "templates.mjs");
await fs.writeFile(bundle, bundled.outputFiles[0].text);
const {
  pipelineTemplates,
  withMonitoring,
  MONITORING_SINK,
  diagnoseConfiguration,
} = await import(pathToFileURL(bundle).href);

const vector =
  process.env.VECTORY_VECTOR_BIN ||
  path.join(root, ".local/tools/vector-x86_64-unknown-linux-gnu/bin/vector");
const version = spawnSync(vector, ["--version"], {
  encoding: "utf8",
  timeout: 10000,
});
assert.equal(version.status, 0, `pinned Vector must run: ${vector}`);
assert.match(
  version.stdout,
  /vector 0\.58\.0\b/,
  "templates require Vector 0.58.0",
);

function validate(config, name) {
  const file = path.join(directory, `${name}.json`);
  return fs
    .writeFile(file, JSON.stringify(config, null, 2))
    .then(() =>
      spawnSync(
        vector,
        [
          "validate",
          "--no-environment",
          "--skip-healthchecks",
          "--config-json",
          file,
        ],
        { encoding: "utf8", timeout: 20000, maxBuffer: 1 << 20 },
      ),
    );
}

const results = [];
try {
  assert.equal(pipelineTemplates.length, 8, "eight templates");
  assert.equal(
    new Set(pipelineTemplates.map((template) => template.id)).size,
    pipelineTemplates.length,
    "template ids are unique",
  );
  for (const template of pipelineTemplates) {
    assert.ok(template.title && template.summary, `${template.id}: copy`);
    assert.ok(template.needs.length > 0, `${template.id}: You'll need list`);
    const local = diagnoseConfiguration(template.config).diagnostics.filter(
      (item) => item.severity === "error",
    );
    assert.deepEqual(local, [], `${template.id}: no local errors`);
    // The synthetic example already ships the monitoring pair.
    const withPair = withMonitoring(template.config);
    assert.equal(
      withPair === null,
      template.id === "synthetic-demo",
      `${template.id}: Add monitoring applies exactly once`,
    );
    for (const config of [template.config, withPair].filter(Boolean)) {
      const monitored = config !== template.config;
      const result = await validate(
        config,
        template.id + (monitored ? "-monitoring" : ""),
      );
      results.push({
        template: template.id,
        monitored,
        valid: result.status === 0,
      });
      assert.equal(
        result.status,
        0,
        `${template.id}${monitored ? " with monitoring" : ""} must pass vector validate:\n${result.stdout}${result.stderr}`,
      );
    }
  }
  // Monitoring is added once, beside steps that already use its names.
  const crowded = {
    sources: {
      vectory_internal_metrics: { type: "host_metrics" },
    },
    sinks: {
      vectory_metrics_exporter: {
        type: "prometheus_exporter",
        inputs: ["vectory_internal_metrics"],
        address: "127.0.0.1:9598",
      },
    },
  };
  const monitored = withMonitoring(crowded);
  assert.deepEqual(Object.keys(monitored.sources), [
    "vectory_internal_metrics",
    "vectory_internal_metrics_2",
  ]);
  assert.deepEqual(monitored.sinks[`${MONITORING_SINK}_2`], {
    type: "prometheus_exporter",
    inputs: ["vectory_internal_metrics_2"],
    address: "127.0.0.1:9599",
  });
  assert.equal(withMonitoring(monitored), null, "monitoring is added once");
  const result = await validate(monitored, "crowded-monitoring");
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  console.log(
    `Validated ${results.length} template configurations with ${version.stdout.trim()}.`,
  );
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
