import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."),
  require = createRequire(path.join(root, "dashboard/package.json"));
const ts = require("typescript");
const source = await fs.readFile(
  path.join(root, "dashboard/src/catalog.ts"),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
});
const { catalog, starter } = await import(
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64")
);
const vector =
  process.env.VECTORY_VECTOR_BIN ||
  path.join(root, ".local/tools/vector-0.58.0/bin/vector.exe");
const results = [];
await fs.mkdir(path.join(root, "vector-catalog/fixtures"), { recursive: true });
for (const item of catalog) {
  const config = structuredClone(starter);
  if (item.kind === "sources") {
    config.sources = { sample: { type: item.type, ...item.defaults } };
    config.transforms.enrich.inputs = [
      item.type === "opentelemetry" ? "sample.logs" : "sample",
    ];
  } else if (item.kind === "transforms") {
    config.transforms = {
      process: { type: item.type, inputs: ["demo"], ...item.defaults },
    };
    config.sinks.output.inputs = [
      item.type === "route" ? "process.errors" : "process",
    ];
  } else
    config.sinks = {
      output: { type: item.type, inputs: ["enrich"], ...item.defaults },
    };
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
    component: item.type,
    valid: result.status === 0,
    validation:
      "Vector 0.58.0 syntax/topology only; external endpoints are not contacted",
    diagnostics:
      result.status === 0
        ? undefined
        : (result.stdout + result.stderr).replaceAll(root, "<workspace>"),
  });
}
await fs.writeFile(
  path.join(root, "vector-catalog/catalog.json"),
  JSON.stringify(
    {
      version: 1,
      vector_version: "0.58.0",
      source:
        "Hand-curated forms checked against pinned Vector; no complete official machine-readable schema is assumed.",
      components: catalog.map((c) => ({
        type: c.type,
        kind: c.kind,
        coverage: "curated form plus lossless raw JSON",
        fields: c.fields.map((f) => f.key),
      })),
    },
    null,
    2,
  ) + "\n",
);
await fs.writeFile(
  path.join(root, "docs/evidence/vector-catalog.json"),
  JSON.stringify({ vector_version: "0.58.0", results }, null, 2) + "\n",
);
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => !r.valid)) process.exitCode = 1;
