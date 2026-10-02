// node --test scripts/check-workflow-scripts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkWorkflow, runScripts } from "./check-workflow-scripts.mjs";

const workflow = (steps, header = "    runs-on: ubuntu-24.04") =>
  `name: t\non: push\njobs:\n  one:\n${header}\n    steps:\n${steps}\n  two:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo two\n`;

test("an apostrophe in a comment inside a single-quoted script is found", () => {
  const text = workflow(
    [
      "      - name: Install",
      "        run: |",
      "          docker run --rm image sh -euxc '",
      "            # The slim image's configuration leaves files out.",
      "            dpkg-deb -c /packages/*.deb",
      "          '",
    ].join("\n"),
  );
  const problems = checkWorkflow(text, "t.yml");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^t\.yml:\d+ \(job one\)/);
});

test("the same script without the apostrophe parses", () => {
  const text = workflow(
    [
      "      - name: Install",
      "        run: |",
      "          docker run --rm image sh -euxc '",
      "            # The slim image leaves files out.",
      "            dpkg-deb -c /packages/*.deb",
      "          '",
    ].join("\n"),
  );
  assert.deepEqual(checkWorkflow(text, "t.yml"), []);
});

test("expressions are not shell, and a single-line run is read", () => {
  const text = workflow(
    [
      "      - run: echo ${{ matrix.os }}",
      '      - run: test "${{ github.ref }}" = x',
    ].join("\n"),
  );
  assert.deepEqual(checkWorkflow(text, "t.yml"), []);
  assert.equal(runScripts(text, "t.yml").length, 3);
});

test("PowerShell steps and Windows jobs are skipped", () => {
  const broken = "          if (";
  const own = workflow(
    ["      - shell: pwsh", "        run: |", broken].join("\n"),
  );
  assert.deepEqual(checkWorkflow(own, "t.yml"), []);
  const windows = workflow(
    ["      - run: |", broken].join("\n"),
    "    runs-on: windows-2025",
  );
  assert.deepEqual(checkWorkflow(windows, "t.yml"), []);
  const declared = workflow(
    ["      - run: |", broken].join("\n"),
    "    runs-on: windows-2025\n    defaults:\n      run:\n        shell: pwsh",
  );
  assert.deepEqual(checkWorkflow(declared, "t.yml"), []);
});

test("bash declared on a Windows step is checked", () => {
  const text = workflow(
    [
      "      - shell: bash",
      "        run: |",
      "          echo 'unterminated",
    ].join("\n"),
    "    runs-on: windows-2025",
  );
  assert.equal(checkWorkflow(text, "t.yml").length, 1);
});

test("grep -q at the end of a pipeline under pipefail is found", () => {
  const text = workflow(
    [
      "      - run: |",
      "          set -euo pipefail",
      "          dpkg-deb -c x.deb | grep -q usr/bin/vectory",
    ].join("\n"),
  );
  const problems = checkWorkflow(text, "t.yml");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /grep -q at the end of a pipeline under pipefail/);
  const counted = workflow(
    [
      "      - run: |",
      "          set -euo pipefail",
      '          [ "$(dpkg-deb -c x.deb | grep -c usr/bin/vectory)" -ge 1 ]',
      "      - run: ls | grep -q x",
    ].join("\n"),
  );
  assert.deepEqual(checkWorkflow(counted, "t.yml"), []);
});

test("every bash step of the repository's workflows parses", () => {
  const dir = path.resolve(import.meta.dirname, "../.github/workflows");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".yml")))
    assert.deepEqual(
      checkWorkflow(fs.readFileSync(path.join(dir, file), "utf8"), file),
      [],
      file,
    );
});
