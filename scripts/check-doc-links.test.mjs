// node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  anchorsOf,
  checkLinks,
  extractLinks,
  githubSlug,
  inScope,
  listMarkdownFiles,
  stripCode,
} from "./check-doc-links.mjs";

function repository(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vectory-doc-links-"));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test("the scope is the records, not the Help center or the apps", () => {
  for (const file of [
    "README.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "docs/ROADMAP.md",
    "docs/internal/HANDOFF.md",
    "agent/README.md",
    "server/README.md",
    "packaging/README.md",
    "deploy/NOTES.md",
    "tests/security/archive/README.md",
  ])
    assert.equal(inScope(file), true, file);
  for (const file of [
    "docs/user/installation.md",
    "dashboard/README.md",
    "help-center/home.md",
    "docs/evidence/browser-tests.json",
    "docs/product-specification.txt",
  ])
    assert.equal(inScope(file), false, file);
});

test("code, fenced blocks and comments are not links, and line numbers survive", () => {
  const source = [
    "See [a](a.md).",
    "```sh",
    "echo [b](b.md)",
    "```",
    "Run `[c](c.md)` here, then [d](d.md).",
    "<!-- [e](e.md)",
    "[f](f.md) -->",
    "~~~",
    "[g](g.md)",
    "~~~",
    "[h](h.md)",
  ].join("\n");
  assert.equal(stripCode(source).split("\n").length, 11);
  assert.deepEqual(extractLinks(source), [
    { target: "a.md", line: 1 },
    { target: "d.md", line: 5 },
    { target: "h.md", line: 11 },
  ]);
});

test("every link form is found: inline, image, angle brackets, titles, references and HTML", () => {
  const source = [
    '[text](docs/a.md "Title") and ![alt](img/b.png)',
    "[spaced](<docs/with space.md>) and [parens](docs/f(1).md)",
    "[ref]: docs/ref.md",
    '<img src="docs/c.png" alt=""> <source srcset="docs/d.png 1x, docs/e.png 2x">',
    '<a href="#local">x</a> [external](https://vector.dev/docs/)',
  ].join("\n");
  assert.deepEqual(
    extractLinks(source).map((link) => link.target),
    [
      "docs/a.md",
      "img/b.png",
      "docs/with space.md",
      "docs/f(1).md",
      "docs/ref.md",
      "docs/c.png",
      "docs/d.png",
      "docs/e.png",
      "#local",
      "https://vector.dev/docs/",
    ],
  );
});

test("heading anchors follow GitHub: lower case, punctuation dropped, spaces to hyphens, repeats numbered", () => {
  assert.equal(githubSlug("Tested on"), "tested-on");
  assert.equal(githubSlug("What's new in 0.1?"), "whats-new-in-01");
  assert.equal(githubSlug("Hello — world"), "hello--world");
  assert.equal(
    githubSlug("snake_case and kebab-case"),
    "snake_case-and-kebab-case",
  );
  assert.equal(githubSlug("Überblick"), "überblick");
  const anchors = anchorsOf(
    [
      "# Title",
      "## The `vectory setup` command",
      "## [Linked](x.md) heading ##",
      "## Repeat",
      "## Repeat",
      "## Repeat",
      "```",
      "## Not a heading",
      "```",
      '<a id="explicit-anchor"></a>',
      'Write `<a id="code-only">` to add one.',
    ].join("\n"),
  );
  assert.deepEqual([...anchors].sort(), [
    "explicit-anchor",
    "linked-heading",
    "repeat",
    "repeat-1",
    "repeat-2",
    "the-vectory-setup-command",
    "title",
  ]);
});

test("missing files, missing sections and escapes are reported with their lines", () => {
  const root = repository({
    "README.md": [
      "# Readme",
      "## Get started",
      "[ok](docs/guide.md) [dir](docs/) [top](#get-started) [page top](#)",
      "[gone](docs/evidence/run.json)",
      "[section](docs/guide.md#install) [bad section](docs/guide.md#nope)",
      "[local](#nowhere)",
      "[escape](../outside.md) [web](https://example.com/x.md) [mail](mailto:a@b.c)",
      "[encoded](docs/two%20words.md) [rooted](/docs/guide.md?plain=1#install)",
      "`[in code](missing.md)`",
      "![image](docs/missing.png)",
    ].join("\n"),
    "docs/guide.md": "# Guide\n\n## Install\n",
    "docs/two words.md": "# Two\n",
  });
  const problems = checkLinks(root, ["README.md"]).map(
    ({ line, target, reason }) => `${line} ${target}: ${reason}`,
  );
  assert.deepEqual(problems, [
    "4 docs/evidence/run.json: no such file in the repository",
    '5 docs/guide.md#nope: no heading or id "#nope" in docs/guide.md',
    '6 #nowhere: no heading or id "#nowhere" in this file',
    "7 ../outside.md: the path leaves the repository",
    "10 docs/missing.png: no such file in the repository",
  ]);
});

test("the default file list covers the scope and skips build output", () => {
  const root = repository({
    "README.md": "# R\n",
    "CONTRIBUTING.md": "# C\n",
    "docs/internal/A.md": "# A\n",
    "docs/user/help.md": "[dead](nowhere.md)\n",
    "agent/README.md": "# Agent\n",
    "tests/security/README.md": "# Tests\n",
    "tests/node_modules/pkg/README.md": "[dead](x.md)\n",
    "dashboard/README.md": "[dead](x.md)\n",
  });
  assert.deepEqual(listMarkdownFiles(root), [
    "README.md",
    "agent/README.md",
    "docs/internal/A.md",
    "tests/security/README.md",
  ]);
  assert.deepEqual(checkLinks(root), []);
});

test("the command fails with file:line output and passes on a clean tree", () => {
  const script = fs.readFileSync(
    path.join(import.meta.dirname, "check-doc-links.mjs"),
  );
  const root = repository({
    "scripts/check-doc-links.mjs": script,
    "README.md": "# R\n\n[evidence](docs/evidence/missing.json)\n",
  });
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-doc-links.mjs")],
      {
        encoding: "utf8",
      },
    );
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(
    failed.stderr,
    /README\.md:3: docs\/evidence\/missing\.json: no such file in the repository/,
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# R\n\nEvidence: `docs/evidence/missing.json` (not committed).\n",
  );
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /Checked 1 Markdown files/);
});
