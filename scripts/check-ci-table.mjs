#!/usr/bin/env node
// Fails when docs/internal/CI.md and the workflows disagree about which jobs
// exist. Each "## <workflow>.yml" section of CI.md holds a table whose first
// column names the jobs of that workflow in backticks.
//   node scripts/check-ci-table.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = ".github/workflows";
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// Job ids are the two-space-indented keys under the top-level `jobs:`.
function jobsOf(text) {
  const lines = text.split(/\r?\n/);
  const ids = [];
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    if (/^[^\s#]/.test(line)) break;
    const key = /^ {2}([\w-]+):\s*$/.exec(line);
    if (key) ids.push(key[1]);
  }
  return ids;
}

function documented(text) {
  const sections = new Map();
  let jobs = null;
  for (const line of text.split(/\r?\n/)) {
    const row = /^\|\s*`([\w-]+)`/.exec(line);
    if (line.startsWith("## ")) {
      const name = line.slice(3).trim();
      jobs = /\.ya?ml$/.test(name) ? [] : null;
      if (jobs) sections.set(name, jobs);
    } else if (jobs && row) jobs.push(row[1]);
  }
  return sections;
}

const doc = documented(read("docs/internal/CI.md"));
const workflows = fs.readdirSync(path.join(root, dir));
const problems = [];
for (const file of workflows.filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const jobs = jobsOf(read(`${dir}/${file}`));
  const listed = doc.get(file);
  if (!listed) {
    problems.push(`CI.md has no "## ${file}" section`);
    continue;
  }
  for (const job of jobs.filter((j) => !listed.includes(j)))
    problems.push(`${file}: job ${job} is not in CI.md`);
  for (const job of listed.filter((j) => !jobs.includes(j)))
    problems.push(`CI.md lists ${job}, which ${file} does not have`);
}
for (const file of doc.keys())
  if (!workflows.includes(file)) problems.push(`CI.md: ${file} does not exist`);
for (const problem of problems) console.error(problem);
if (problems.length) process.exit(1);
console.log(`docs/internal/CI.md lists every job of ${doc.size} workflows.`);
