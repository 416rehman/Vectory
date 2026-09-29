// node --test scripts/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkEvidence,
  checkRequirements,
  parseChecklist,
  specLines,
  specSections,
  splitRow,
  workflowJobs,
} from "./check-requirements.mjs";

const SPEC = [
  "# Spec",
  "",
  "Preamble sentence.",
  "",
  "## 1. First",
  "",
  "Must do one thing.",
  "",
  "## 2. Second",
  "",
  "Must do another thing.",
  "",
].join("\n");

const WORKFLOW = [
  "name: checks",
  "on: [push]",
  "jobs:",
  "  server:",
  "    runs-on: ubuntu-24.04",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: cargo test --locked",
  "      - name: Check the thing",
  "        run: |",
  "          node scripts/one.mjs",
  "          node scripts/two.mjs",
  "        working-directory: .",
  "  agent:",
  "    strategy:",
  "      matrix:",
  "        os: [ubuntu-24.04]",
  "    steps:",
  "      - run: go test ./...",
  "        working-directory: agent",
  "",
].join("\n");

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function repository(checklist, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vectory-requirements-"));
  const files = {
    "docs/product-specification.md": SPEC,
    ".github/workflows/ci.yml": WORKFLOW,
    "server/tests/one.rs": "fn lost_reply_is_retried() {}\n",
    "docs/internal/REQUIREMENTS.md": checklist,
    ...extra,
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const table = (rows) =>
  [
    "| Spec | Requirement | Status | Evidence | Gap |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");

function checklist(rows, header = `SHA-256 \`${sha(SPEC)}\``) {
  return `# Checklist\n\n${header}\n\n${table(rows)}\n`;
}

const passing = [
  "| L7 | One | Met | `server/tests/one.rs::lost_reply_is_retried`, `ci:server/cargo test` | — |",
  "| L11 | Another | Partial | `server/tests/one.rs`, `ci:agent/go test ./...` | Not all of it |",
];

test("sections come from the numbered level-two headings", () => {
  assert.deepEqual(specSections(SPEC), [
    { number: 1, title: "First", start: 5, end: 8 },
    { number: 2, title: "Second", start: 9, end: 12 },
  ]);
});

test("table rows split on pipes outside code spans", () => {
  assert.deepEqual(splitRow("| L7 | a `x | y` b | Met | `p` \\| q | — |"), [
    "L7",
    "a `x | y` b",
    "Met",
    "`p` | q",
    "—",
  ]);
});

test("line references accept single lines, ranges and lists, and nothing else", () => {
  assert.deepEqual(specLines("L13"), [13]);
  assert.deepEqual(specLines("L80-L86"), [80, 86]);
  assert.deepEqual(specLines("L80–86"), [80, 86]);
  assert.deepEqual(specLines("L319, L322"), [319, 322]);
  for (const bad of ["13", "L", "line 13", "L13 and L14", "§4"])
    assert.equal(specLines(bad), null, bad);
});

test("workflow jobs list their step names and commands, including block commands", () => {
  const jobs = workflowJobs(WORKFLOW);
  assert.deepEqual([...jobs.keys()], ["server", "agent"]);
  assert.ok(jobs.get("server").includes("cargo test --locked"));
  assert.ok(jobs.get("server").includes("Check the thing"));
  assert.ok(
    jobs.get("server").some((entry) => entry.includes("node scripts/two.mjs")),
  );
  assert.ok(jobs.get("agent").includes("go test ./..."));
});

test("evidence items: paths, path::Name, CI steps, and what is not evidence", () => {
  const root = repository(checklist(passing));
  const jobs = workflowJobs(WORKFLOW);
  const check = (item) => checkEvidence(item, root, jobs);
  assert.deepEqual(check("server/tests/one.rs"), { ok: true });
  assert.deepEqual(check("server/tests"), { ok: true });
  assert.deepEqual(check("server/tests/one.rs::lost_reply_is_retried"), {
    ok: true,
  });
  assert.deepEqual(check("server/tests/one.rs::fn lost_reply_is_retried()"), {
    ok: true,
  });
  assert.match(
    check("server/tests/one.rs::fn::lost_reply_is_retried").reason,
    /does not contain "fn::lost_reply_is_retried"/,
  );
  assert.deepEqual(check("ci:server/Check the thing"), { ok: true });
  assert.deepEqual(check("ci:server/node scripts/one.mjs"), { ok: true });
  assert.deepEqual(check("ci:agent"), { ok: true });
  assert.match(check("server/tests/two.rs").reason, /does not exist/);
  assert.match(
    check("server/tests/one.rs::missing_name").reason,
    /does not contain "missing_name"/,
  );
  assert.match(check("server/tests::x").reason, /not a file/);
  assert.match(check("ci:dashboard").reason, /no job "dashboard"/);
  assert.match(
    check("ci:server/npm test").reason,
    /no step named or running "npm test"/,
  );
  for (const other of [
    "--ca-file",
    "STALE_REVISION",
    "vectory setup",
    "/api/v1/releases",
    "timberio/vector:0.58.0",
  ])
    assert.equal(check(other), null, other);
});

test("a complete checklist passes", () => {
  const root = repository(checklist(passing));
  const { problems, rows } = checkRequirements(root);
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 2);
});

test("every failure the checklist must catch is reported with its line", () => {
  const root = repository(
    checklist([
      "| L7 | Covered | Met | — | none |",
      "| L7 | Word | Done | `server/tests/one.rs` | — |",
      "| L7 | Gone | Partial | `server/tests/gone.rs` | — |",
      "| L7 | Blank | Unverified | `server/tests/one.rs` | — |",
      "| L2 | Blank line | Met | `server/tests/one.rs` | — |",
      "| L99 | Past the end | Met | `server/tests/one.rs` | — |",
      "| 7 | No L | Met | `server/tests/one.rs` | — |",
      "| L7 | Too few cells | Met |",
      "| L7 | Planned | Missing | `server/tests/planned.rs` | Not built |",
    ]),
  );
  const messages = checkRequirements(root).problems.map(
    ({ line, message }) => `${line}: ${message}`,
  );
  assert.deepEqual(messages, [
    "14: a row needs 5 cells, found 3",
    "7: a Met row must name evidence: a path, a path::Name or a ci:job/step",
    '8: status "Done" must be one of Met, Partial, Missing, Unverified',
    "9: Partial row cites server/tests/gone.rs: server/tests/gone.rs does not exist",
    "11: L2 is not a line with text in docs/product-specification.md",
    "12: L99 is not a line with text in docs/product-specification.md",
    '13: "7" is not a spec line reference such as L13 or L80-L86',
    "1: spec section 2 (Second) has no row",
  ]);
});

test("a changed specification, a missing pin and wrong totals fail", () => {
  const changed = repository(
    checklist(passing, "SHA-256 `" + "0".repeat(64) + "`"),
  );
  assert.match(
    checkRequirements(changed).problems[0].message,
    /changed \(SHA-256 [0-9a-f]{64}\); re-check every line reference/,
  );
  const unpinned = repository(checklist(passing, "No pin here."));
  assert.match(
    checkRequirements(unpinned).problems[0].message,
    /record the specification's SHA-256/,
  );
  const totals = repository(
    checklist(
      passing,
      `SHA-256 \`${sha(SPEC)}\`\n\n**Totals:** 2 Met, 0 Partial, 0 Missing, 0 Unverified.`,
    ),
  );
  assert.deepEqual(
    checkRequirements(totals).problems.map((problem) => problem.message),
    ['the totals line must read "1 Met, 1 Partial, 0 Missing, 0 Unverified"'],
  );
});

test("only tables with the checklist header are read", () => {
  const { rows, problems } = parseChecklist(
    [
      "| Other | Table |",
      "| --- | --- |",
      "| x | y |",
      "",
      table(passing),
    ].join("\n"),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(problems, []);
});

test("the command exits non-zero with file:line output, and zero on a clean checklist", () => {
  const script = fs.readFileSync(
    path.join(import.meta.dirname, "check-requirements.mjs"),
  );
  const run = (root) =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-requirements.mjs")],
      { encoding: "utf8" },
    );
  const bad = repository(
    checklist(["| L7 | Gone | Met | `server/tests/gone.rs` | — |"]),
    {
      "scripts/check-requirements.mjs": script,
    },
  );
  const failed = run(bad);
  assert.equal(failed.status, 1);
  assert.match(
    failed.stderr,
    /REQUIREMENTS\.md:7: Met row cites server\/tests\/gone\.rs: server\/tests\/gone\.rs does not exist/,
  );
  assert.doesNotMatch(failed.stderr, /must name evidence/);
  const good = repository(checklist(passing), {
    "scripts/check-requirements.mjs": script,
  });
  const passed = run(good);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(
    passed.stdout,
    /Checked 2 requirement rows: 1 Met, 1 Partial, 0 Missing, 0 Unverified\./,
  );
});
