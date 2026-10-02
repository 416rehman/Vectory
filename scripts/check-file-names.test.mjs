// node --test scripts/check-file-names.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { caseCollisions } from "./check-file-names.mjs";

test("a component and a model that differ only in case collide", () => {
  const problems = caseCollisions([
    "dashboard/src/PublishReview.tsx",
    "dashboard/src/publishReview.ts",
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /import names differ only in letter case/);
});

test("the same file name in another case collides", () => {
  assert.equal(caseCollisions(["docs/Readme.md", "docs/README.md"]).length, 1);
});

test("a test, a style sheet or another directory does not", () => {
  assert.deepEqual(
    caseCollisions([
      "dashboard/src/Editor.tsx",
      "dashboard/src/editor.css",
      "dashboard/src/editor.test.ts",
      "dashboard/src/EditorModel.ts",
      "other/editor.ts",
      "dashboard/src/Foo.ts",
      "dashboard/src/Foo.tsx",
    ]),
    [],
  );
});
