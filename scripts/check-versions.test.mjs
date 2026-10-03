import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { problems, versions } from "./check-versions.mjs";

/** A repository tree with the same version in every place, or the given overrides. */
function tree(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "versions-"));
  const files = {
    "agent/internal/agent/types.go":
      'package agent\n\nconst Version = "0.1.0"\n',
    "server/Cargo.toml":
      '[package]\nname = "vectory-server"\nversion = "0.1.0"\n',
    "server/Cargo.lock":
      'name = "vectory-server"\nversion = "0.1.0"\ndependencies = []\n',
    "dashboard/package.json": '{"version":"0.1.0"}',
    "dashboard/package-lock.json": '{"version":"0.1.0"}',
    "help-center/package.json": '{"version":"0.1.0"}',
    "help-center/package-lock.json": '{"version":"0.1.0"}',
    "contracts/openapi.json": '{"info":{"version":"0.1.0"}}',
    "CHANGELOG.md": "# Changelog\n\n## 0.1.0 (developer preview)\n",
    ...overrides,
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test("a tree that says one version everywhere has no problems", () => {
  assert.deepEqual(problems(versions(tree())), []);
});

test("a part that still says a development version is named", () => {
  const found = versions(
    tree({ "help-center/package.json": '{"version":"0.1.0-dev"}' }),
  );
  assert.deepEqual(problems(found), [
    "help-center/package.json: 0.1.0-dev, but the agent says 0.1.0",
  ]);
});

test("the changelog's newest heading is the one that counts", () => {
  const changelog = "# Changelog\n\n## 0.2.0 (unreleased)\n\n## 0.1.0\n";
  assert.deepEqual(problems(versions(tree({ "CHANGELOG.md": changelog }))), [
    "CHANGELOG.md: 0.2.0, but the agent says 0.1.0",
  ]);
});

test("a missing file or a missing version is a problem, not a crash", () => {
  const root = tree();
  fs.rmSync(path.join(root, "contracts/openapi.json"));
  assert.deepEqual(problems(versions(root)), [
    "contracts/openapi.json: no version found",
  ]);
  const noConstant = versions(
    tree({ "agent/internal/agent/types.go": "package agent\n" }),
  );
  assert.deepEqual(problems(noConstant), [
    "agent/internal/agent/types.go: no `const Version` found",
  ]);
});

test("the Cargo lock entry of another crate is not read", () => {
  const lock =
    'name = "other"\nversion = "9.9.9"\n\nname = "vectory-server"\nversion = "0.1.0"\n';
  assert.deepEqual(problems(versions(tree({ "server/Cargo.lock": lock }))), []);
});
