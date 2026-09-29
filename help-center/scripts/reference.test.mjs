// Drift guards: the reference pages must name everything the code defines.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./prepare.mjs";
import { agentInterface, environmentVariables, missing } from "./reference.mjs";

const page = (slug) => fs.readFile(path.join(repoRoot, "docs/user", slug + ".md"), "utf8");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("Server configuration documents every VECTORY_* variable the server, validator, Compose and preview read", async () => {
  const variables = await environmentVariables(repoRoot);
  assert.ok(variables.size >= 20, "expected to find the server's variables; did the source layout move?");
  const text = await page("server-config");
  const gaps = missing(variables, (name) => new RegExp(`\\b${name}\\b`).test(text), (name) => name);
  assert.deepEqual(gaps, [], `Add these variables to docs/user/server-config.md:\n${gaps.join("\n")}`);
});

test("Agent CLI documents every command and flag defined in agent/cmd/vectory", async () => {
  const { commands, flags } = await agentInterface(repoRoot);
  assert.ok(commands.has("install") && commands.has("enroll") && flags.has("state-dir"), "expected to find the agent's commands and flags; did the CLI source move?");
  const text = await page("cli");
  const gaps = [
    ...missing(commands, (name) => new RegExp(`\\bvectory ${escape(name)}(?![a-z0-9-])`).test(text), (name) => `vectory ${name}`),
    ...missing(flags, (name) => new RegExp(`--${escape(name)}(?![a-z0-9-])`).test(text), (name) => `--${name}`),
  ];
  assert.deepEqual(gaps, [], `Add these to docs/user/cli.md:\n${gaps.join("\n")}`);
});

test("the CLI parser finds commands in switch statements, comparisons and command tables", async () => {
  const root = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "vectory-cli-parse-"));
  try {
    await fs.mkdir(path.join(root, "agent/cmd/vectory"), { recursive: true });
    await fs.writeFile(path.join(root, "agent/cmd/vectory/main.go"), [
      'if command == "version" {}',
      'switch command {',
      'case "install":',
      '  switch f.Name {',
      '  case "vector-binary":',
      '  }',
      'case "service-start", "service-stop":',
      '}',
      'var commands = []spec{{name: "setup"}, {name: "logs"}}',
      'var aliases = map[string]string{"x": "y"}',
      'dir := fs.String("state-dir", "", "")',
      'fs.BoolVar(&follow, "follow", false, "")',
      'fs.Func("mode", "", parse)',
    ].join("\n"));
    await fs.writeFile(path.join(root, "agent/cmd/vectory/main_test.go"), 'switch command {\ncase "test-only":\n}\n');
    const { commands, flags } = await agentInterface(root);
    assert.deepEqual([...commands.keys()].sort(), ["install", "logs", "service-start", "service-stop", "setup", "version"]);
    assert.deepEqual([...flags.keys()].sort(), ["follow", "mode", "state-dir"]);
  } finally {
    assert.ok(path.basename(root).startsWith("vectory-cli-parse-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});
