// node --test scripts/check-capability-fixtures.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CATEGORIES,
  loadFixtures,
  needs,
  pointer,
  shapeProblems,
} from "./check-capability-fixtures.mjs";

const root = path.resolve(import.meta.dirname, "..");
const table = JSON.parse(
  fs.readFileSync(
    path.join(root, "dashboard/src/generated/capability-table.json"),
    "utf8",
  ),
);
const codes = Object.keys(table.codes);

test("every fixture has its shape and follows from the table", () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 100, "expected the golden fixtures");
  for (const { file, fixture } of fixtures) {
    assert.deepEqual(shapeProblems(fixture, codes), [], file);
    assert.deepEqual(needs(table, fixture), fixture.needs, file);
  }
});

test("the fixtures cover every needs category and every refusal code they can produce", () => {
  const fixtures = loadFixtures().map(({ fixture }) => fixture);
  for (const category of CATEGORIES)
    assert.ok(
      fixtures.some((f) => f.needs[category].length),
      `no fixture shows ${category}`,
    );
  const seen = new Set(
    fixtures.flatMap((f) =>
      [...f.needs.full_mode, ...f.needs.refused].map((item) => item.code),
    ),
  );
  assert.deepEqual(
    codes.filter((code) => !seen.has(code)),
    [],
  );
});

test("a fixture without every category, or with an unknown key, is reported", () => {
  const problems = shapeProblems(
    {
      description: "x",
      vector: "valid",
      config: {},
      needs: { refused: [] },
      extra: 1,
    },
    codes,
  );
  assert.ok(problems.includes('unknown key "extra"'));
  assert.ok(
    problems.includes("needs.full_mode must be a list, even when empty"),
  );
  assert.deepEqual(
    shapeProblems(
      { description: "x", vector: "skip", config: {}, needs: {} },
      codes,
    ).includes("a skipped fixture says why in vector_error"),
    true,
  );
});

test("pointers escape ~ and / as RFC 6901 says", () => {
  assert.equal(pointer(["sinks", "a/b", "c~d", 0]), "/sinks/a~1b/c~0d/0");
});

// A table with one built-in sink whose rules use every kind and rule class,
// including those no reviewed field uses yet.
const synthetic = {
  ...table,
  components: [
    {
      scope: "sinks/probe",
      tier: "builtin",
      reviewed: true,
      reach: "probes",
      rules: {
        address: { class: "resource", kind: "host_port" },
        servers: { class: "resource", kind: "host_port_list" },
        socket: { class: "resource", kind: "unix_connect" },
        uri: { class: "resource", kind: "url" },
        relay: { class: "resource", kind: "url", schemes: ["tcp", "unix"] },
        endpoints: { class: "resource", kind: "url", required: true },
        "targets[]": { class: "resource", kind: "url", template: true },
        patterns: { class: "resource", kind: "glob" },
        mode: {
          class: "constrained",
          allowed: ["a"],
          default: "b",
          code: "UNSUPPORTED_LOCAL_CAPABILITY",
          reason: "x",
        },
      },
      credentials: [
        { path: "auth", shape: "azure", when: { strategy: ["azure"] } },
      ],
    },
  ],
  global_settings: [],
  enrichment_tables: [],
  asset_fields: [],
};
const raw = (fields) =>
  needs(synthetic, { config: { sinks: { p: { type: "probe", ...fields } } } });
// The probe writes out its required endpoint and an allowed mode unless a test overrides them.
const probe = (fields) =>
  raw({ endpoints: "https://e.example", mode: "a", ...fields });

test("host:port destinations: brackets, lower case, a required port, no leading zeros", () => {
  assert.deepEqual(probe({ address: "[2001:DB8::1]:0080" }).network, [
    "[2001:db8::1]:80",
    "e.example:443",
  ]);
  assert.deepEqual(probe({ address: "Broker.Example.NET:9092" }).network, [
    "broker.example.net:9092",
    "e.example:443",
  ]);
  for (const bad of [
    "broker.example.net",
    "broker.example.net:0",
    "broker.example.net:65536",
    "2001:db8::1:9092",
    "user@broker:9092",
    "bro ker:9092",
  ])
    assert.deepEqual(
      probe({ address: bad }).full_mode,
      [{ code: "NETWORK_DESTINATION_DENIED", at: "/sinks/p/address" }],
      bad,
    );
  assert.deepEqual(probe({ servers: "a.example:1, b.example:2" }).network, [
    "a.example:1",
    "b.example:2",
    "e.example:443",
  ]);
  assert.deepEqual(probe({ servers: "a.example:1,,b.example:2" }).full_mode, [
    { code: "NETWORK_DESTINATION_DENIED", at: "/sinks/p/servers" },
  ]);
});

test("Unix sockets a component connects to are destinations by their cleaned path", () => {
  assert.deepEqual(probe({ socket: "//run//app/./ingest.sock" }).network, [
    "e.example:443",
    "unix:/run/app/ingest.sock",
  ]);
  assert.deepEqual(probe({ relay: "unix:///run/relay.sock" }).network, [
    "e.example:443",
    "unix:/run/relay.sock",
  ]);
  for (const [field, bad] of [
    ["socket", "run/app.sock"],
    ["socket", "/run/../etc/app.sock"],
    ["relay", "unix://run/relay.sock"],
  ])
    assert.deepEqual(
      probe({ [field]: bad }).full_mode,
      [{ code: "NETWORK_DESTINATION_DENIED", at: `/sinks/p/${field}` }],
      bad,
    );
  assert.deepEqual(probe({ socket: "/run/app.sock" }).file_roots, []);
});

test("URLs: schemes, default ports and what an authority may hold", () => {
  assert.deepEqual(probe({ uri: "HTTPS://Logs.Example.net" }).network, [
    "e.example:443",
    "logs.example.net:443",
  ]);
  assert.deepEqual(probe({ relay: "tcp://relay.example:7000" }).network, [
    "e.example:443",
    "relay.example:7000",
  ]);
  for (const bad of ["tcp://relay.example"])
    assert.equal(
      probe({ relay: bad }).full_mode[0].code,
      "NETWORK_DESTINATION_DENIED",
      bad,
    );
  for (const bad of [
    "https://user@logs.example",
    "https://lo%67s.example/",
    "https://logs.example\\@other/",
    "https://logs .example/",
    "https:///x",
    "logs.example:443",
    "ftp://logs.example/",
  ])
    assert.deepEqual(
      probe({ uri: bad }).full_mode,
      [{ code: "NETWORK_DESTINATION_DENIED", at: "/sinks/p/uri" }],
      bad,
    );
  assert.deepEqual(
    probe({ uri: "https://logs.example/a@b/%2F?q=1#f" }).network,
    ["e.example:443", "logs.example:443"],
  );
});

test("a required resource names where it belongs when it is missing", () => {
  assert.deepEqual(raw({}).full_mode, [
    { code: "NETWORK_DESTINATION_DENIED", at: "/sinks/p/endpoints" },
    { code: "UNSUPPORTED_LOCAL_CAPABILITY", at: "/sinks/p/mode" },
  ]);
});

test("templates in a URL list: the literal authority decides", () => {
  const result = probe({
    targets: [
      "https://t.example/{{ path }}",
      "https://{{ host }}/x",
      "https://t.example:{{ port }}/",
    ],
  });
  assert.deepEqual(result.network, ["e.example:443", "t.example:443"]);
  assert.deepEqual(result.full_mode, [
    { code: "TEMPLATE_RESOURCE_DENIED", at: "/sinks/p/targets/1" },
    { code: "TEMPLATE_RESOURCE_DENIED", at: "/sinks/p/targets/2" },
  ]);
});

test("a glob's root is the directory before its first wildcard", () => {
  const roots = (pattern) => probe({ patterns: pattern }).file_roots;
  assert.deepEqual(roots("/var/log/app/*.log"), ["/var/log/app"]);
  assert.deepEqual(roots("/var/log/app?/x.log"), ["/var/log"]);
  assert.deepEqual(roots("/var/log/[ab]/x.log"), ["/var/log"]);
  assert.deepEqual(roots("/var/log/app/x.log"), ["/var/log/app/x.log"]);
});

test("a kind-tagged credential: refused kinds need full mode, ambient kinds the capability", () => {
  const base = { strategy: "azure" };
  assert.deepEqual(
    probe({ ...base, auth: { azure_credential_kind: "managed_identity" } })
      .capabilities,
    ["instance-credentials"],
  );
  assert.deepEqual(
    probe({
      ...base,
      auth: { azure_credential_kind: "client_secret_credential" },
    }).capabilities,
    [],
  );
  assert.deepEqual(
    probe({ ...base, auth: { azure_credential_kind: "azure_cli" } }).full_mode,
    [
      {
        code: "UNSUPPORTED_LOCAL_CAPABILITY",
        at: "/sinks/p/auth/azure_credential_kind",
      },
    ],
  );
  assert.deepEqual(
    probe({
      ...base,
      strategy: "other",
      auth: { azure_credential_kind: "azure_cli" },
    }).full_mode,
    [],
  );
});
