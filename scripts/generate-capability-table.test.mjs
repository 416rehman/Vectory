// node --test scripts/generate-capability-table.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  DOCS_BEGIN,
  DOCS_END,
  OUTPUTS,
  buildTable,
  loadInputs,
  outputs,
  renderDocs,
} from "./generate-capability-table.mjs";

const root = path.resolve(import.meta.dirname, "..");
const inputs = loadInputs();
// A fresh, independent copy of the inputs for each test that changes them.
const copy = () => structuredClone(inputs);
const problemsOf = (changed) => buildTable(changed).problems;

test("the reviewed table is complete against the pinned schema", () => {
  assert.deepEqual(problemsOf(inputs), []);
});

test("the generated copies and the security page's lists are current", () => {
  const { table } = buildTable(inputs);
  for (const [file, text] of outputs(table))
    assert.equal(
      fs.readFileSync(path.join(root, file), "utf8"),
      text,
      `${file} is stale: run node scripts/generate-capability-table.mjs`,
    );
});

test("a new *_file field in a reviewed component fails, naming the component and the field", () => {
  const changed = copy();
  changed.schema.definitions["vectory::components::sinks::kafka"].allOf.push({
    properties: { cert_bundle_file: { type: "string" } },
  });
  const problems = problemsOf(changed);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(
    problems[0],
    /components\.sinks\.kafka: field cert_bundle_file looks like a resource/,
  );
});

test("a new path-typed field fails even when its name looks harmless", () => {
  const changed = copy();
  changed.schema.definitions[
    "vectory::components::sources::demo_logs"
  ].allOf.push({
    properties: { spool: { $ref: "#/definitions/stdlib::PathBuf" } },
  });
  assert.deepEqual(problemsOf(changed), [
    "components.sources.demo_logs: field spool looks like a resource (stdlib::PathBuf) and has no rule",
  ]);
});

test("a resource word inside a new field's name is enough to fail", () => {
  const changed = copy();
  changed.schema.definitions[
    "vectory::components::sources::demo_logs"
  ].allOf.push({
    properties: {
      endpoint_override: { type: "string" },
      relay_socket_name: { type: "string" },
      seed_host_key: { type: "string" },
      spool_path_prefix: { type: "string" },
    },
  });
  assert.deepEqual(problemsOf(changed), [
    "components.sources.demo_logs: field endpoint_override looks like a resource (its name) and has no rule",
    "components.sources.demo_logs: field relay_socket_name looks like a resource (its name) and has no rule",
    "components.sources.demo_logs: field spool_path_prefix looks like a resource (its name) and has no rule",
  ]);
});

test("a new template field in a reviewed component fails until it is classified", () => {
  const changed = copy();
  changed.schema.definitions["vectory::components::sinks::http"].allOf.push({
    properties: { tag: { $ref: "#/definitions/vector::template::Template" } },
  });
  assert.deepEqual(problemsOf(changed), [
    "components.sinks.http: field tag looks like a resource (a template) and has no rule",
  ]);
});

test("a new resource field of a shared type fails once, at the type", () => {
  const changed = copy();
  changed.schema.definitions[
    "vector_core::tls::settings::TlsConfig"
  ].properties.crl_file = { type: "string" };
  const problems = problemsOf(changed);
  assert.ok(
    problems.includes(
      "shared_types.vector_core::tls::settings::TlsConfig: field crl_file looks like a resource and has no rule",
    ),
    problems.join("\n"),
  );
});

test("a new resource-like field inside a credential fails where reviewed components use it", () => {
  const changed = copy();
  const aws =
    changed.schema.definitions["vector::aws::auth::AwsAuthentication"];
  aws.anyOf.at(-1).properties.web_identity_token_file = { type: "string" };
  const problems = problemsOf(changed);
  assert.ok(
    problems.includes(
      "components.sinks.http: field auth.auth.web_identity_token_file looks like a resource (its name) and has no rule",
    ),
    problems.join("\n"),
  );
  assert.ok(
    problems.includes(
      "components.sinks.aws_s3: field auth.web_identity_token_file looks like a resource (its name) and has no rule",
    ),
    problems.join("\n"),
  );
});

test("a field of an unreviewed component needs no rule: the component already needs full mode", () => {
  const changed = copy();
  changed.schema.definitions["vectory::components::sinks::socket"].allOf.push({
    properties: { cert_bundle_file: { type: "string" } },
  });
  assert.deepEqual(problemsOf(changed), []);
});

test("a component the pinned catalog adds fails until it has a tier", () => {
  const changed = copy();
  const kafka = changed.catalog.components.find(
    (c) => c.kind === "sinks" && c.type === "kafka",
  );
  changed.catalog.components.push({ ...kafka, type: "kafka_v2" });
  assert.deepEqual(problemsOf(changed), [
    "components.sinks.kafka_v2: unclassified; give it a tier (new components start as full)",
  ]);
});

test("a rule for a field the schema lacks fails, so a typo can't leave a hole", () => {
  const changed = copy();
  changed.source.components.sinks.kafka.fields.bootstrap_server = {
    class: "resource",
    kind: "host_port_list",
  };
  assert.deepEqual(problemsOf(changed), [
    'components.sinks.kafka: no field "bootstrap_server" in the pinned schema',
  ]);
});

test("a schema digest the table wasn't reviewed against fails", () => {
  const changed = copy();
  changed.catalog.schema_sha256 = "0".repeat(64);
  assert.match(
    problemsOf(changed).join("\n"),
    /was reviewed against schema 7e5f/,
  );
});

test("an unreviewed scope can't leave full mode, and promoting one asks for its fields", () => {
  const changed = copy();
  changed.source.components.sinks.socket.tier = "builtin";
  assert.deepEqual(problemsOf(changed), [
    "components.sinks.socket: an unreviewed scope stays full",
    "components.sinks.socket: field address looks like a resource (its name) and has no rule",
    "components.sinks.socket: field path looks like a resource (stdlib::PathBuf) and has no rule",
  ]);
});

test("promoting a component whose credential is flattened into it asks for that credential's shape", () => {
  const changed = copy();
  changed.source.components.sinks.gcp_pubsub = {
    tier: "approval",
    reach: "sends to Pub/Sub",
    review: "trial",
  };
  assert.deepEqual(problemsOf(changed), [
    "components.sinks.gcp_pubsub: the scope itself uses vector::gcp::GcpAuthConfig, which has no shared classification",
    "components.sinks.gcp_pubsub: field credentials_path looks like a resource (its name) and has no rule",
  ]);
  changed.source.components.sinks.gcp_pubsub.credentials = {
    "": { shape: "gcp" },
  };
  assert.deepEqual(problemsOf(changed), []);
});

test("a component restricted mode runs today stays built in", () => {
  const changed = copy();
  changed.source.components.sinks.http.tier = "approval";
  assert.deepEqual(problemsOf(changed), [
    "current_restricted_mode: sinks/http runs in restricted mode today, so the table must keep it built in",
  ]);
});

test("a malformed rule is named", () => {
  const changed = copy();
  changed.source.components.sinks.kafka.fields.topic = {
    class: "resource",
    kind: "socket",
  };
  const problems = problemsOf(changed);
  assert.ok(
    problems.some((p) =>
      p.startsWith(
        "components.sinks.kafka.fields.topic: a resource needs a kind",
      ),
    ),
    problems.join("\n"),
  );
});

test("a refused VRL function must also be one only a device evaluates", () => {
  const changed = copy();
  changed.source.vrl_functions.refused.push("parse_json");
  assert.deepEqual(problemsOf(changed), [
    "vrl_functions: parse_json is refused but not listed as device only",
  ]);
});

test("shared types expand where a reviewed component uses them, with conditions rebased", () => {
  const { table } = buildTable(inputs);
  const http = table.components.find((c) => c.scope === "sinks/http");
  assert.equal(
    http.rules["tls.ca_file"].from,
    "vector_core::tls::settings::TlsConfig",
  );
  assert.equal(http.rules["tls.ca_file"].asset_capability, "managed-ca");
  assert.equal(http.rules["healthcheck_uri"].kind, "url");
  assert.deepEqual(http.credentials, [
    { path: "auth.auth", shape: "aws", when: { "auth.strategy": ["aws"] } },
  ]);
});

test("asset fields cover every component, whatever its tier", () => {
  const { table } = buildTable(inputs);
  const fields = table.asset_fields.map(
    (f) => `${f.scope} ${f.path} ${f.kind}`,
  );
  assert.ok(
    fields.includes("sinks/splunk_hec_logs tls.ca_file pem_certificates"),
  );
  assert.ok(fields.includes("enrichment_tables/file file.path csv"));
  assert.ok(fields.includes("enrichment_tables/geoip path mmdb"));
});

test("the security page's lists are rendered between their markers", () => {
  const { table } = buildTable(inputs);
  const page = `before\n${DOCS_BEGIN}\nstale\n${DOCS_END}\nafter\n`;
  const rendered = renderDocs(page, table);
  assert.match(
    rendered,
    /^before\n<!-- generated .*-->\n\| Kind \| Allowed \|/,
  );
  assert.match(
    rendered,
    /\| Sinks \| `console` \(to stderr only\), `blackhole`/,
  );
  assert.match(rendered, /-->\nafter\n$/);
  assert.throws(
    () => renderDocs("no markers", table),
    new RegExp(OUTPUTS.docs),
  );
});
