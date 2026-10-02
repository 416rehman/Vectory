#!/usr/bin/env node
// Fails when a bash step of a workflow does not parse. A comment with an
// apostrophe inside a single-quoted `sh -c '...'` block ends the quote and
// runs the rest of the script in the wrong shell; only a run on a hosted runner
// would show it. PowerShell and cmd steps are skipped: GitHub parses them.
//   node scripts/check-workflow-scripts.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const indentOf = (line) => line.length - line.trimStart().length;
const blank = (line) => line.trim() === "";

/** The line ranges of the jobs under the top-level `jobs:`. */
function jobRanges(lines) {
  const first = lines.indexOf("jobs:");
  if (first < 0) return [];
  const ranges = [];
  for (let n = first + 1; n < lines.length; n++) {
    if (/^[^\s#]/.test(lines[n])) break;
    const id = /^ {2}([\w-]+):\s*$/.exec(lines[n]);
    if (id) ranges.push({ id: id[1], from: n, to: lines.length });
    if (id && ranges.length > 1) ranges.at(-2).to = n;
  }
  return ranges;
}

/** The `run:` scripts of one workflow, with the shell each step uses. */
export function runScripts(text, file = "workflow") {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (const job of jobRanges(lines)) {
    const stepsAt = lines.findIndex(
      (line, n) => n > job.from && n < job.to && /^ {4}steps:\s*$/.test(line),
    );
    if (stepsAt < 0) continue;
    const header = lines.slice(job.from, stepsAt);
    let jobShell = header.some((line) => /^\s+runs-on:\s*windows/i.test(line))
      ? "pwsh"
      : "bash";
    for (const line of header) {
      const own = /^\s+shell:\s*(\S+)\s*$/.exec(line);
      if (own) jobShell = own[1];
    }
    // Each step starts at a dash at the indent of the first one.
    const dashes = [];
    let dash = -1;
    for (let n = stepsAt + 1; n < job.to; n++) {
      if (blank(lines[n]) || /^\s*#/.test(lines[n])) continue;
      if (dash < 0) dash = indentOf(lines[n]);
      if (indentOf(lines[n]) === dash && lines[n].trimStart().startsWith("- "))
        dashes.push(n);
    }
    dashes.forEach((from, k) => {
      const to = k + 1 < dashes.length ? dashes[k + 1] : job.to;
      const keyIndent = dash + 2;
      let shell = jobShell;
      let run = null;
      for (let n = from; n < to; n++) {
        const key = new RegExp(
          `^ {${keyIndent - 2}}- (\\w+):\\s*(.*)$|^ {${keyIndent}}(\\w+):\\s*(.*)$`,
        ).exec(lines[n]);
        const name = key && (key[1] ?? key[3]);
        const value = key && (key[2] ?? key[4]);
        if (name === "shell") shell = value.trim();
        if (name === "run") run = { n, value: value.trim() };
      }
      if (!run) return;
      let script = run.value;
      if (/^[|>][-+]?$/.test(script)) {
        const body = [];
        for (let n = run.n + 1; n < to; n++) {
          if (!blank(lines[n]) && indentOf(lines[n]) <= keyIndent) break;
          body.push(lines[n]);
        }
        const margin = Math.min(...body.filter((b) => !blank(b)).map(indentOf));
        script = body.map((b) => b.slice(margin)).join("\n");
      }
      found.push({ file, job: job.id, line: run.n + 1, shell, script });
    });
  }
  return found;
}

const isBash = (shell) => /^(bash|sh)\b/.test(shell);

/** Problems found in the bash scripts of one workflow's text. */
export function checkWorkflow(text, file = "workflow") {
  const problems = [];
  for (const step of runScripts(text, file)) {
    if (!isBash(step.shell)) continue;
    // GitHub expands expressions before the shell sees the script.
    const script = step.script.replace(/\$\{\{[\s\S]*?\}\}/g, "X");
    const result = spawnSync("bash", ["-n"], {
      input: script,
      encoding: "utf8",
    });
    if (result.status !== 0)
      problems.push(
        `${step.file}:${step.line} (job ${step.job}): ${result.stderr.trim().split("\n")[0]}`,
      );
  }
  return problems;
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const dir = path.join(root, ".github/workflows");
  const problems = [];
  let steps = 0;
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    steps += runScripts(text, file).filter((s) => isBash(s.shell)).length;
    problems.push(...checkWorkflow(text, file));
  }
  for (const problem of problems) console.error(problem);
  if (problems.length) return 1;
  console.log(`Every one of ${steps} bash steps in the workflows parses.`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = main();
