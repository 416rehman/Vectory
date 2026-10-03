#!/usr/bin/env node
// Writes the shared agent-release test vectors, the bounds and members of the
// heartbeat report, and the normative examples of the update formats, from
// fixed seeds, with nothing but Node's own crypto.
//
//   node contracts/fixtures/agent-release/generate.mjs           write them
//   node contracts/fixtures/agent-release/generate.mjs --check   fail when a
//       file on disk differs from what this script writes, when
//       contracts/CONTRACT.md does not quote an example as written or leaves
//       out a code, or when an example breaks the generated schemas
//
// Neither the Rust server nor the Go agent produced these files. rules.mjs is a
// third implementation of the rules in the "Agent updates" section of
// contracts/CONTRACT.md, and cases.mjs states the answer of every case next to
// its inputs and stops when the rules compute another one, so a case cannot
// say something the rules do not.
//
// Every key here is a published test key. Never pin one on a real host.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  KEYS,
  KEY_NAMES,
  bundles,
  cases,
  keyLines,
  reportMembers,
} from "./cases.mjs";
import { buildExamples } from "./examples.mjs";
import { AGENT_CODES, REPORT_BOUNDS } from "./rules.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const contractRoot = path.resolve(here, "../..");
const contractPath = path.join(contractRoot, "CONTRACT.md");

const lines = (items, indent = "    ") =>
  `[\n${items.map((item) => `${indent}${JSON.stringify(item)}`).join(",\n")}\n  ]`;

function vectorsText() {
  const keys = KEY_NAMES.map((name) => ({
    name,
    seed_hex: KEYS[name].seed.toString("hex"),
    public_key_line: KEYS[name].line,
    fingerprint: KEYS[name].fingerprint,
  }));
  return `${[
    "{",
    '  "schema": "vectory.agent-release-vectors.v1",',
    `  "about": ${JSON.stringify(
      "Shared test vectors for verifying an offered agent release, the public keys a server publishes, and the key lines a host pins. Every key is a published test key. See README.md.",
    )},`,
    `  "keys": ${lines(keys)},`,
    `  "key_lines": ${lines(keyLines)},`,
    `  "bundles": ${lines(bundles)},`,
    `  "cases": ${lines(cases)}`,
    "}",
  ].join("\n")}\n`;
}

function reportText() {
  return `${[
    "{",
    `  "description": ${JSON.stringify(
      "The bounds of the heartbeat member agent_update, and members the server accepts or refuses (a refused member makes the whole heartbeat a 400 that changes nothing). The server's parser test and the agent's report test read this one file, so a bound changed on one side shows up on the other. A member holds the keys of the member and nothing else; null counts as absent for an optional member. See the heartbeat member of the Agent updates section of contracts/CONTRACT.md.",
    )},`,
    `  "bounds": ${JSON.stringify(REPORT_BOUNDS)},`,
    `  "members": ${lines(reportMembers, "    ")}`,
    "}",
  ].join("\n")}\n`;
}

// Each file is written with one final line feed, and the contract quotes it
// without, except the two files a signature covers byte for byte (the release
// manifest and the rollover statement): they are written exactly as signed, so
// a host that is handed the example verifies it.
const SIGNED_BYTES = new Set(["release.json", "rollover.json"]);
function outputs() {
  const files = new Map([
    ["vectors.json", vectorsText()],
    ["report.json", reportText()],
  ]);
  for (const [name, content] of Object.entries(buildExamples()))
    files.set(
      `examples/${name}`,
      SIGNED_BYTES.has(name) ? content : `${content}\n`,
    );
  return files;
}

// The schema each example must satisfy in protocol.schema.json.
const EXAMPLE_SCHEMAS = {
  "release.json": "ReleaseManifest",
  "release.json.sig": "ReleaseSignatures",
  "rollover.json": "KeyRollover",
  "rollover-envelope.json": "KeyRolloverEnvelope",
  "rollovers.json": "UpdateRollovers",
  "release-keys.json": "ReleaseKeyBundle",
  "policy.json": "UpdatePolicy",
  "request.json": "UpdateRequest",
  "health.json": "UpdateHealth",
  "counters.json": "UpdateCounters",
  "installed.json": "UpdateInstalled",
  "status.json": "UpdateStatus",
  "journal.json": "UpdateJournal",
  "manifest-member.json": "AgentUpdateOffer",
  "heartbeat-member.json": "AgentUpdateReport",
};

// Fenced blocks of the contract, each as its text without the final line.
function contractBlocks(contract) {
  const blocks = new Set();
  for (const match of contract.matchAll(/```[a-z]*\n([\s\S]*?)\n```/g))
    blocks.add(match[1]);
  return blocks;
}

function contractProblems(files) {
  const contract = fs.readFileSync(contractPath, "utf8");
  const blocks = contractBlocks(contract);
  const problems = [];
  for (const [name, content] of files)
    if (name.startsWith("examples/") && !blocks.has(content.trimEnd()))
      problems.push(
        `contracts/CONTRACT.md has no code block that is exactly ${name}`,
      );
  const used = new Set(AGENT_CODES);
  for (const entry of cases) if (entry.expect.code) used.add(entry.expect.code);
  for (const code of used)
    if (!contract.includes(`\`${code}\``))
      problems.push(`contracts/CONTRACT.md does not name the code ${code}`);
  return problems;
}

// Validates the examples, and the report members the server accepts, against
// the generated schemas. Ajv comes from the dashboard's dependencies, which the
// CI job installs; without them the check says so and skips this part.
function schemaProblems(files) {
  let Ajv;
  let addFormats;
  try {
    const require = createRequire(
      path.join(contractRoot, "../dashboard/package.json"),
    );
    Ajv = require("ajv/dist/2020").default;
    addFormats = require("ajv-formats");
  } catch {
    console.log(
      "Skipped the schema check of the examples: run npm ci in dashboard to enable it.",
    );
    return [];
  }
  const schemaFile = path.join(contractRoot, "protocol.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const check = (name, value) => {
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
    if (!validate) return [`protocol.schema.json has no ${name}`];
    return validate(value)
      ? []
      : [`${name}: ${JSON.stringify(validate.errors)}`];
  };
  const problems = [];
  for (const [name, content] of files) {
    if (!name.startsWith("examples/")) continue;
    const schemaName = EXAMPLE_SCHEMAS[name.slice("examples/".length)];
    if (!schemaName) continue;
    for (const problem of check(schemaName, JSON.parse(content)))
      problems.push(`${name} against ${problem}`);
  }
  for (const entry of reportMembers)
    if (entry.accepted)
      for (const problem of check("AgentUpdateReport", entry.member))
        problems.push(`report member "${entry.name}" against ${problem}`);
  return problems;
}

function main() {
  const files = outputs();
  if (process.argv.includes("--check")) {
    const problems = [];
    for (const [name, content] of files) {
      const file = path.join(here, name);
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content)
        problems.push(
          `contracts/fixtures/agent-release/${name} is not what generate.mjs writes`,
        );
    }
    problems.push(...contractProblems(files), ...schemaProblems(files));
    for (const problem of problems) console.error(problem);
    if (problems.length) {
      console.error(
        "Run node contracts/fixtures/agent-release/generate.mjs and commit the result, and quote the examples in contracts/CONTRACT.md as written.",
      );
      return 1;
    }
    console.log(
      `agent-release fixtures are current: ${cases.length} cases, ${keyLines.length} key lines, ${bundles.length} bundles, ${reportMembers.length} report members, ${files.size - 2} examples.`,
    );
    return 0;
  }
  const expected = new Set(files.keys());
  const examples = path.join(here, "examples");
  if (fs.existsSync(examples))
    for (const stale of fs.readdirSync(examples))
      if (!expected.has(`examples/${stale}`))
        fs.rmSync(path.join(examples, stale));
  for (const [name, content] of files) {
    const file = path.join(here, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  console.log(
    `Wrote ${cases.length} cases, ${keyLines.length} key lines, ${bundles.length} bundles, ${reportMembers.length} report members and ${files.size - 2} examples.`,
  );
  return 0;
}

process.exitCode = main();
