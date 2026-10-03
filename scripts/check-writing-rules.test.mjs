// node --test scripts/check-writing-rules.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  RULE_IDS,
  allowlistProblems,
  check,
  isGenerated,
  isSkippedPath,
  pathMatches,
  scanText,
} from "./check-writing-rules.mjs";

const rulesIn = (text, options) =>
  scanText(text, options).map((hit) => hit.rule);

test("plan steps are numbered as steps, not as work packages", () => {
  assert.deepEqual(rulesIn("Steps 3 and 6 of the plan."), []);
  assert.deepEqual(rulesIn("The change from WP3 and WP11."), [
    "work-package-id",
    "work-package-id",
  ]);
  assert.deepEqual(rulesIn("WP3g needs the probe."), ["work-package-id"]);
  assert.deepEqual(rulesIn("Work package 0 ships first."), ["work-package"]);
  assert.deepEqual(rulesIn("The work-packages table."), ["work-package"]);
});

test("workstream words and codes are process vocabulary", () => {
  assert.deepEqual(rulesIn("The release workstream owns it."), ["workstream"]);
  assert.deepEqual(rulesIn("Owned by the backend agent."), ["workstream"]);
  assert.deepEqual(rulesIn("W3 and W7 finished."), [
    "workstream-id",
    "workstream-id",
  ]);
  assert.deepEqual(rulesIn("W3C, W8 and a#W1 and W1-2 are not codes."), []);
});

test("round and finding ids and review rounds are flagged", () => {
  assert.deepEqual(rulesIn("Fixed in R12 and R7a."), ["round-id", "round-id"]);
  assert.deepEqual(rulesIn("A pipeline named r15-demo and a device r2-edge."), [
    "round-id",
    "round-id",
  ]);
  assert.deepEqual(
    rulesIn("The arm64-linux, cr2-x and r-demo names are fine."),
    [],
  );
  assert.deepEqual(rulesIn("The R2D2 droid, R-1 and ARM64 are not ids."), []);
  assert.deepEqual(rulesIn("Round-2 operator review P1-3 found it."), [
    "review-round",
    "finding-id",
  ]);
  assert.deepEqual(rulesIn("The second independent review found P0-1."), [
    "review-round",
    "finding-id",
  ]);
  assert.deepEqual(rulesIn("One review round later."), ["review-round"]);
  assert.deepEqual(rulesIn("A round trip, round-trips and Math.round."), []);
  assert.deepEqual(rulesIn("An independent review of the product."), []);
  assert.deepEqual(rulesIn("P-256 and P4-1 are not finding ids."), []);
});

test("who said it is not a reason", () => {
  assert.deepEqual(rulesIn("The critics said so."), ["reviewers-said"]);
  assert.deepEqual(rulesIn("A reviewer found a bug."), ["reviewers-said"]);
  assert.deepEqual(rulesIn("The reviewer role may approve a request."), []);
  assert.deepEqual(rulesIn("Critical errors are logged."), []);
});

test("the lead is a role, the lead paragraph is a page's first paragraph", () => {
  assert.deepEqual(rulesIn("Ask the lead first."), ["the-lead"]);
  assert.deepEqual(rulesIn("The lead's merge."), ["the-lead"]);
  assert.deepEqual(rulesIn("A lead's call."), ["the-lead"]);
  assert.deepEqual(rulesIn("Every page has a lead paragraph."), []);
  assert.deepEqual(rulesIn("The lead paragraph is plain text."), []);
});

test("a worker is flagged as a person, never as a process", () => {
  assert.deepEqual(rulesIn("Another worker may use the port."), ["worker"]);
  assert.deepEqual(rulesIn("Each worker owns a branch."), ["worker"]);
  assert.deepEqual(rulesIn("The worker's branch and the worker report."), [
    "worker",
    "worker",
  ]);
  assert.deepEqual(rulesIn("The isolated worker runs Vector."), []);
  assert.deepEqual(
    rulesIn("Pagefind's web worker, a service worker, workers: 1."),
    [],
  );
  assert.deepEqual(rulesIn("worker.abort(); State(worker)"), []);
});

test("a wave is a rollout stage unless it counts rounds of work", () => {
  assert.deepEqual(rulesIn("The canary releases its next wave."), []);
  assert.deepEqual(
    rulesIn("A released wave and the first wave of devices."),
    [],
  );
  assert.deepEqual(rulesIn("Wave 2 of the work."), ["wave"]);
  assert.deepEqual(rulesIn("The review wave and a wave of workers."), [
    "wave",
    "wave",
  ]);
  assert.deepEqual(rulesIn("End-of-wave housekeeping."), ["wave"]);
});

test("a brief is instructions, not an adjective", () => {
  assert.deepEqual(rulesIn("As the brief says."), ["brief"]);
  assert.deepEqual(rulesIn("The worker brief and SCRUB-BRIEF."), [
    "worker",
    "brief",
    "brief",
  ]);
  assert.deepEqual(rulesIn("It runs briefly, after a brief pause."), []);
  assert.deepEqual(rulesIn("The brief summary of the page."), []);
  assert.deepEqual(rulesIn("A ledger admits `brief-3`."), []);
});

test("hand-off is flagged as a word, not inside names and identifiers", () => {
  assert.deepEqual(rulesIn("Read the handoff before starting."), ["handoff"]);
  assert.deepEqual(rulesIn("The earlier hand-off note."), ["handoff"]);
  assert.deepEqual(rulesIn("See docs/internal/HANDOFF.md."), []);
  assert.deepEqual(rulesIn("node tests/target-handoff-browser.mjs"), []);
  assert.deepEqual(
    rulesIn("VECTORY_TARGET_HANDOFF_OUTPUT and window.handoffVeto"),
    [],
  );
});

test("session links and session ids are private", () => {
  assert.deepEqual(rulesIn("Session: session_01AbCdEfGhIjKlMnOp"), [
    "session-link",
  ]);
  assert.deepEqual(
    rulesIn(
      "See https://chat.example.com/c/0123abcd-4567-89ef for the thread.",
    ),
    ["session-link"],
  );
  assert.deepEqual(rulesIn("https://example.com/docs/session-cookies"), []);
  assert.deepEqual(rulesIn("The session_id column and a session_timeout."), []);
});

test("home directories name a person; placeholder accounts do not", () => {
  const found = scanText(
    "cd /home/jane/src && ls /Users/jane/Library C:\\Users\\jane\\Documents C:\\\\Users\\\\jane\\\\x /mnt/c/Users/jane/x",
  );
  assert.equal(found.length, 5);
  assert.ok(found.every((hit) => hit.rule === "home-directory"));
  assert.deepEqual(
    rulesIn("/home/$USER/x, /home/<name>/x, ~/x, %USERPROFILE%"),
    [],
  );
  const accounts = new Set(["you", "runner"]);
  assert.deepEqual(
    rulesIn(
      "/home/you/Vectory and /home/runner and C:\\Users\\RUNNER~1\\AppData",
      {
        accounts,
      },
    ),
    [],
  );
  assert.deepEqual(rulesIn("/home/YOU/x", { accounts }), []);
  assert.deepEqual(rulesIn("/home/jane/x", { accounts }), ["home-directory"]);
});

test("hits carry the line and the text that matched", () => {
  const [hit] = scanText("fine\nfine\nstill the lead's call\n");
  assert.equal(hit.line, 3);
  assert.equal(hit.rule, "the-lead");
  assert.equal(hit.match, "the lead");
  assert.match(hit.why, /area/);
});

test("lock files, generated files, vendored data and binaries are not scanned", () => {
  for (const file of [
    "dashboard/package-lock.json",
    "server/Cargo.lock",
    "agent/go.sum",
    "contracts/openapi.json",
    "contracts/protocol.schema.json",
    "vector-catalog/catalog.json",
    "vector-catalog/upstream/src/sinks/mod.rs",
    "dashboard/src/generated/vector-schema.json",
    "agent/internal/agent/capability_table_generated.go",
    "dashboard/node_modules/x/readme.md",
    "docs/screenshots/product-overview.png",
    "dashboard/public/fonts/a.woff2",
  ])
    assert.equal(isSkippedPath(file), true, file);
  for (const file of [
    "contracts/CONTRACT.md",
    "contracts/generate.mjs",
    "docs/evidence/capacity.json",
    "server/src/main.rs",
    "dashboard/src/assets/component-icons/docker.svg",
  ])
    assert.equal(isSkippedPath(file), false, file);
  assert.equal(
    isGenerated("// Code generated by x.mjs; DO NOT EDIT.\npackage a\n"),
    true,
  );
  assert.equal(
    isGenerated("//! Generated by scripts/g.mjs; do not edit.\n"),
    true,
  );
  assert.equal(isGenerated("package a\n\n// the lead\n"), false);
});

test("allowlist paths: a file, a directory, a glob", () => {
  assert.equal(pathMatches("AGENTS.md", "AGENTS.md"), true);
  assert.equal(pathMatches("AGENTS.md", "docs/AGENTS.md"), false);
  assert.equal(pathMatches("docs/internal/", "docs/internal/CI.md"), true);
  assert.equal(pathMatches("docs/internal/", "docs/user/ci.md"), false);
  assert.equal(
    pathMatches(
      "dashboard/tests/*-browser.mjs",
      "dashboard/tests/a-browser.mjs",
    ),
    true,
  );
  assert.equal(
    pathMatches(
      "dashboard/tests/*-browser.mjs",
      "dashboard/tests/x/a-browser.mjs",
    ),
    false,
  );
  assert.equal(pathMatches("server/**/*.rs", "server/tests/a.rs"), true);
});

test("the allowlist excuses exactly what it names, and says what it did not use", () => {
  const files = [
    { path: "a.md", text: "Ask the lead.\n" },
    { path: "b.md", text: "Ask the lead.\nAnd read WP3.\n" },
    { path: "c.md", text: "Ask the lead.\n" },
    { path: "docs/d.md", text: "Wave 2 and the isolated worker.\n" },
  ];
  const allow = {
    entries: [
      { paths: ["a.md"], reason: "Quotes the ownership model verbatim." },
      {
        paths: ["b.md"],
        rules: ["the-lead"],
        reason: "Quotes the ownership model verbatim.",
      },
      {
        paths: ["docs/"],
        rules: ["wave"],
        match: "Wave 2",
        reason: "A rollout stage, named in a table.",
      },
      { paths: ["never.md"], reason: "Excuses nothing, so it is reported." },
    ],
  };
  const { violations, unused } = check(files, allow);
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line} ${v.rule}`),
    ["b.md:2 work-package-id", "c.md:1 the-lead"],
  );
  assert.deepEqual(unused, [{ index: 3, paths: ["never.md"] }]);
});

test("a match narrows an entry to lines that contain it", () => {
  const files = [
    { path: "x.md", text: "Wave 2 of the plan.\nWave 3 of the plan.\n" },
  ];
  const allow = {
    entries: [
      {
        paths: ["x.md"],
        match: "Wave 2",
        reason: "A rollout stage in an example table.",
      },
    ],
  };
  assert.deepEqual(
    check(files, allow).violations.map((v) => v.line),
    [2],
  );
});

test("skipped and generated files never produce a violation", () => {
  const files = [
    { path: "package-lock.json", text: "WP3 the lead" },
    { path: "x_generated.go", text: "WP3 the lead" },
    { path: "y.rs", text: "//! Generated by a script; do not edit.\nWP3\n" },
  ];
  assert.deepEqual(check(files).violations, []);
});

test("an allowlist needs reasons, paths and known rules", () => {
  assert.deepEqual(allowlistProblems({ entries: [] }), []);
  assert.deepEqual(allowlistProblems({}), ["entries must be an array"]);
  assert.deepEqual(
    allowlistProblems({
      entries: [
        { paths: ["a.md"] },
        { paths: [], reason: "A reason that is long enough." },
        {
          paths: ["a.md"],
          rules: ["nope"],
          reason: "A reason that is long enough.",
        },
        { paths: ["a.md"], rules: [], reason: "A reason that is long enough." },
        { paths: ["a.md"], match: "", reason: "A reason that is long enough." },
      ],
      accounts: [{ name: "" }, { name: "x", reason: "short" }],
    }),
    [
      "entries[0]: a reason of at least a sentence is required",
      "entries[1]: paths must list at least one path",
      'entries[2]: unknown rule "nope"',
      "entries[3]: rules must list at least one rule",
      "entries[4]: match must be a non-empty string",
      "accounts[0]: a name is required",
      "accounts[0]: a reason of at least a sentence is required",
      "accounts[1]: a reason of at least a sentence is required",
    ],
  );
});

test("the repository's allowlist is well formed and names real rules", () => {
  const file = path.join(import.meta.dirname, "writing-rules-allow.json");
  const allow = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(allowlistProblems(allow), []);
  for (const entry of allow.entries)
    for (const rule of entry.rules ?? [])
      assert.ok(RULE_IDS.includes(rule), rule);
});

test("accounts named in the allowlist excuse only their own home directory", () => {
  const files = [
    {
      path: "docs/a.md",
      text: "Open /home/you/Vectory and /home/jane/Vectory.\n",
    },
  ];
  const allow = {
    accounts: [{ name: "You", reason: "The placeholder in the sample paths." }],
    entries: [],
  };
  const { violations } = check(files, allow);
  assert.deepEqual(
    violations.map((v) => v.match),
    ["/home/jane"],
  );
});
