// Cheap, deterministic checks for docs/dev/WRITING.md. Each failure names the
// file, line and rule so it can be fixed without reading this test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot, helpRoot, topics } from "./prepare.mjs";
import { articleContent } from "./markdown.mjs";

const banned = [
  [/older development builds?/i, "fix history belongs in CHANGELOG.md"],
  [/\b(?:this )?windows workspace\b/i, "internal workspace language"],
  [/\b(?:shared|reused) (?:development )?version label/i, "version-label caveats belong in CHANGELOG.md"],
  [/\brequires? an agent (?:build|artifact|package) containing\b/i, "fix-version caveats belong in CHANGELOG.md"],
  [/\bagent polic(?:y|ies)\b/i, 'say "agent settings"'],
  [/\bclick here\b/i, "link text should say where it goes"],
  [/\bacceptance evidence\b|\bqualification\b/i, "internal release-evidence language"],
];
const shells = new Set(["sh", "bash", "shell", "zsh", "console", "powershell", "pwsh", "ps1"]);

async function sources() {
  const pointers = ["QUICKSTART", "AGENT-INSTALL", "TROUBLESHOOTING", "COMPATIBILITY", "BACKUP-RESTORE", "ROADMAP"];
  const dev = (await fs.readdir(path.join(repoRoot, "docs/dev"))).filter((file) => file.endsWith(".md"));
  return [
    ...topics.map((topic) => ({ file: `docs/user/${topic}.md`, help: true })),
    { file: path.relative(repoRoot, path.join(helpRoot, "home.md")) },
    { file: "README.md" },
    { file: "CONTRIBUTING.md" },
    ...pointers.map((name) => ({ file: `docs/${name}.md`, pointer: true })),
    ...dev.map((name) => ({ file: `docs/dev/${name}` })),
  ];
}

// Lines outside fenced code, with 1-based numbers; fences reported separately.
function scan(text) {
  const prose = [], blocks = [];
  let fence = null;
  text.split("\n").forEach((line, index) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)/);
    if (fence) {
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !line.trim().slice(marker[1].length)) {
        blocks.push(fence);
        fence = null;
      } else fence.lines.push({ line, number: index + 1 });
      return;
    }
    if (marker) fence = { marker: marker[1], language: marker[2].toLowerCase(), lines: [] };
    else prose.push({ line, number: index + 1 });
  });
  return { prose, blocks };
}

function cells(row) {
  return row.trim().replace(/^\||\|$/g, "").replace(/`[^`]*`/g, "code").split(/(?<!\\)\|/).length;
}

test("docs follow the writing rules", async () => {
  const problems = [];
  for (const { file, help, pointer } of await sources()) {
    const text = await fs.readFile(path.join(repoRoot, file), "utf8");
    const { prose, blocks } = scan(text);
    const report = (number, message) => problems.push(`${file}:${number}: ${message}`);
    for (const { line, number } of prose) {
      // Inline code quotes things; it is exempt from the wording rules.
      const words = line.replace(/`[^`]*`/g, "code");
      for (const [pattern, why] of banned) if (pattern.test(words)) report(number, `"${words.match(pattern)[0]}": ${why}`);
      if (/<https?:\/\//.test(words)) report(number, "angle-bracket autolink; write [text](url)");
      if (/<!--\s*verify-after-merge(?!:\s*\S)/.test(line)) report(number, "verify-after-merge needs a description of what to check");
      if (help && /#\/docs\//.test(line)) report(number, "link help pages as page.md#section");
    }
    for (const block of blocks) {
      if (!shells.has(block.language)) continue;
      for (const { line, number } of block.lines) {
        if (line.length > 100) report(number, `${line.length}-character line in a ${block.language} block; break it with a line continuation`);
        if (/^\s*\$ /.test(line)) report(number, "don't prefix commands with $");
      }
    }
    // Table rows must match their header's column count.
    let header = null;
    for (const { line, number } of prose) {
      if (!/^\s*\|/.test(line)) {
        header = null;
        continue;
      }
      if (header === null) header = cells(line);
      else if (!/^\s*\|[\s:|-]+\|\s*$/.test(line) && cells(line) !== header) report(number, `table row has ${cells(line)} cells; the header has ${header}`);
    }
    if (pointer && text.split("\n").length > 40) report(1, "repository pointers stay under 40 lines; the content lives in docs/user");
    if (!help) continue;
    const lines = text.split("\n");
    if (!/^# \S/.test(lines[0])) report(1, "a page starts with its H1");
    if (lines.slice(1).some((line, index) => /^# /.test(line) && prose.some((p) => p.number === index + 2))) report(1, "only one H1 per page");
    const first = lines.slice(1).find((line) => line.trim());
    if (!first || /^(?:#|>|\||```|~~~|[-*+] |\d+\. |<)/.test(first.trim())) report(1, "the H1 is followed by a one- or two-sentence lead paragraph");
    // Headings become anchors; tab labels (#### inside a tabs block) don't.
    const headings = new Set();
    let tabs = false;
    for (const { line, number } of prose) {
      if (/^<!--\s*tabs(?::[a-z0-9-]+)?\s*-->/.test(line)) tabs = true;
      else if (/^<!--\s*\/tabs\s*-->/.test(line)) tabs = false;
      const heading = line.match(/^(#{2,4}) (.+)$/);
      if (!heading || (tabs && heading[1] === "####")) continue;
      const key = heading[2].trim().toLowerCase();
      if (headings.has(key)) report(number, `duplicate heading "${heading[2].trim()}" makes an ambiguous anchor`);
      headings.add(key);
    }
    try {
      articleContent(text, path.basename(file, ".md"));
    } catch (error) {
      report(1, `does not render: ${error.message}`);
    }
  }
  assert.deepEqual(problems, [], `Fix these docs problems (see docs/dev/WRITING.md):\n${problems.join("\n")}`);
});

test("the lint catches what it promises to catch", () => {
  const { prose, blocks } = scan("Older development builds may differ.\n```sh\n$ " + "x".repeat(120) + "\n```\n");
  assert.equal(prose[0].line, "Older development builds may differ.");
  assert.ok(banned.some(([pattern]) => pattern.test(prose[0].line)));
  assert.equal(blocks[0].language, "sh");
  assert.ok(blocks[0].lines[0].line.length > 100);
  assert.equal(cells("| `a | b` | c |"), 2);
  assert.equal(cells("| a \\| b | c |"), 2);
});
