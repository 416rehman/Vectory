#!/usr/bin/env node
// Keeps docs/internal/REQUIREMENTS.md, the requirements-to-tests checklist
// that docs/product-specification.md asks for, honest. It fails when:
//   - the specification changed since the checklist recorded its SHA-256
//     (so every line reference must be re-checked);
//   - a section of the specification has no row, or a row cites a line
//     that is blank or outside the specification;
//   - a status is not exactly Met, Partial, Missing or Unverified;
//   - a row that is not Missing names evidence that does not exist: a path,
//     a `path::Name` whose file does not contain Name, or a `ci:job/step`
//     that .github/workflows/ci.yml does not run;
//   - a Met row names no evidence at all.
//
//   node scripts/check-requirements.mjs    (CI)
//
// Dependency-free: CI runs it before any npm install.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATUSES = ["Met", "Partial", "Missing", "Unverified"];
export const COLUMNS = ["Spec", "Requirement", "Status", "Evidence", "Gap"];

/** Specification sections: [{ number, title, start, end }] (1-based lines). */
export function specSections(spec) {
  const lines = spec.split("\n");
  const sections = [];
  lines.forEach((line, index) => {
    const heading = /^## (\d+)\. (.+)$/.exec(line);
    if (heading)
      sections.push({
        number: Number(heading[1]),
        title: heading[2].trim(),
        start: index + 1,
      });
  });
  sections.forEach((section, index) => {
    section.end =
      index + 1 < sections.length
        ? sections[index + 1].start - 1
        : lines.length;
  });
  return sections;
}

/** Splits a Markdown table row into trimmed cells, keeping code spans whole. */
export function splitRow(line) {
  const cells = [];
  let current = "";
  let tick = 0;
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character === "\\" && body[index + 1] === "|") {
      current += "|";
      index++;
    } else if (character === "`") {
      let run = 1;
      while (body[index + run] === "`") run++;
      if (tick === 0) tick = run;
      else if (tick === run) tick = 0;
      current += "`".repeat(run);
      index += run - 1;
    } else if (character === "|" && tick === 0) {
      cells.push(current.trim());
      current = "";
    } else current += character;
  }
  cells.push(current.trim());
  return cells;
}

/** Requirement rows from every table whose header is COLUMNS. */
export function parseChecklist(markdown) {
  const rows = [];
  const problems = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim().startsWith("|")) continue;
    const header = splitRow(lines[index]);
    const table = header.join("|") === COLUMNS.join("|");
    let next = index + 1;
    while (next < lines.length && lines[next].trim().startsWith("|")) next++;
    if (table)
      for (let row = index + 2; row < next; row++) {
        const cells = splitRow(lines[row]);
        const line = row + 1;
        if (cells.length !== COLUMNS.length) {
          problems.push({
            line,
            message: `a row needs ${COLUMNS.length} cells, found ${cells.length}`,
          });
          continue;
        }
        const [spec, requirement, status, evidence, gap] = cells;
        rows.push({ line, spec, requirement, status, evidence, gap });
      }
    index = next - 1;
  }
  return { rows, problems };
}

/** Spec line numbers a cell cites: "L13", "L80-L86", "L319, L322". */
export function specLines(cell) {
  if (
    !/^L\d+(?:\s*[-–]\s*L?\d+)?(?:\s*,\s*L\d+(?:\s*[-–]\s*L?\d+)?)*$/.test(cell)
  )
    return null;
  const found = [];
  for (const part of cell.split(",")) {
    const [from, to] = part
      .split(/[-–]/)
      .map((value) => Number(value.trim().replace(/^L/, "")));
    found.push(from);
    if (to !== undefined) found.push(to);
  }
  return found;
}

/** Jobs of a workflow and the names and commands of their steps. */
export function workflowJobs(yaml) {
  const jobs = new Map();
  let inJobs = false;
  let job = null;
  let block = null;
  for (const raw of yaml.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    if (block) {
      if (raw.trim() === "" || indent > block.indent) {
        block.text.push(raw.trim());
        continue;
      }
      jobs.get(job).push(block.text.join("\n"));
      block = null;
    }
    if (/^jobs:\s*$/.test(raw)) {
      inJobs = true;
      continue;
    }
    if (indent === 0 && raw.trim()) inJobs = false;
    if (!inJobs) continue;
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(raw);
    if (key) {
      job = key[1];
      jobs.set(job, []);
      continue;
    }
    if (!job) continue;
    const field = /^(\s*)(?:- )?(name|run):\s*(.*)$/.exec(raw);
    if (!field) continue;
    const value = field[3].trim();
    if (field[2] === "run" && /^[|>][-+]?$/.test(value))
      block = {
        indent: indent + (raw.trimStart().startsWith("- ") ? 2 : 0),
        text: [],
      };
    else if (value) jobs.get(job).push(value.replace(/^["']|["']$/g, ""));
  }
  if (block) jobs.get(job).push(block.text.join("\n"));
  return jobs;
}

/**
 * Checks one backticked evidence item. Returns null when the item is not a
 * reference this checker understands (a flag, a code, a route), otherwise
 * { ok, reason }.
 */
export function checkEvidence(item, root, jobs) {
  if (item.startsWith("ci:")) {
    const reference = item.slice(3).trim();
    const slash = reference.indexOf("/");
    const job = slash === -1 ? reference : reference.slice(0, slash);
    const step = slash === -1 ? "" : reference.slice(slash + 1).trim();
    if (!jobs.has(job))
      return { ok: false, reason: `ci.yml has no job "${job}"` };
    if (step && !jobs.get(job).some((entry) => entry.includes(step)))
      return {
        ok: false,
        reason: `ci.yml job "${job}" has no step named or running "${step}"`,
      };
    return { ok: true };
  }
  if (/\s/.test(item) && !item.includes("::")) return null;
  const split = item.indexOf("::");
  const file = split === -1 ? item : item.slice(0, split);
  const symbol = split === -1 ? undefined : item.slice(split + 2);
  const top = file.split("/")[0];
  if (!top || top.startsWith("-") || !fs.existsSync(path.join(root, top)))
    return null;
  const target = path.join(root, file);
  if (!fs.existsSync(target))
    return { ok: false, reason: `${file} does not exist` };
  if (symbol !== undefined) {
    if (!fs.statSync(target).isFile())
      return {
        ok: false,
        reason: `${file} is not a file, so it cannot contain ${symbol}`,
      };
    if (!fs.readFileSync(target, "utf8").includes(symbol.trim()))
      return {
        ok: false,
        reason: `${file} does not contain "${symbol.trim()}"`,
      };
  }
  return { ok: true };
}

const codeSpans = (text) =>
  [...text.matchAll(/(`+)(.+?)\1/g)].map((match) => match[2].trim());

/** Every problem in the checklist, as [{ line, message }]. */
export function checkRequirements(root, options = {}) {
  const checklistPath = options.checklist ?? "docs/internal/REQUIREMENTS.md";
  const specPath = options.spec ?? "docs/product-specification.md";
  const workflowPath = options.workflow ?? ".github/workflows/ci.yml";
  const checklist = fs.readFileSync(path.join(root, checklistPath), "utf8");
  const spec = fs.readFileSync(path.join(root, specPath), "utf8");
  const jobs = workflowJobs(
    fs.readFileSync(path.join(root, workflowPath), "utf8"),
  );
  const specLineText = spec.split("\n");
  const problems = [];

  const pinned = /SHA-256 `([0-9a-f]{64})`/.exec(checklist);
  const actual = crypto.createHash("sha256").update(spec).digest("hex");
  if (!pinned)
    problems.push({
      line: 1,
      message: `record the specification's SHA-256 as SHA-256 \`${actual}\``,
    });
  else if (pinned[1] !== actual)
    problems.push({
      line: checklist.slice(0, pinned.index).split("\n").length,
      message: `${specPath} changed (SHA-256 ${actual}); re-check every line reference, then record the new hash`,
    });

  const { rows, problems: shape } = parseChecklist(checklist);
  problems.push(...shape);
  const sections = specSections(spec);
  const covered = new Set();
  for (const row of rows) {
    const lines = specLines(row.spec);
    if (!lines) {
      problems.push({
        line: row.line,
        message: `"${row.spec}" is not a spec line reference such as L13 or L80-L86`,
      });
    } else {
      for (const number of lines)
        if (
          number < 1 ||
          number > specLineText.length ||
          !specLineText[number - 1].trim()
        )
          problems.push({
            line: row.line,
            message: `L${number} is not a line with text in ${specPath}`,
          });
      const section = sections.find(
        (entry) => lines[0] >= entry.start && lines[0] <= entry.end,
      );
      if (section) covered.add(section.number);
    }
    if (!STATUSES.includes(row.status)) {
      problems.push({
        line: row.line,
        message: `status "${row.status}" must be one of ${STATUSES.join(", ")}`,
      });
      continue;
    }
    if (row.status === "Missing") continue;
    let verified = 0;
    let failed = 0;
    for (const item of codeSpans(row.evidence)) {
      const result = checkEvidence(item, root, jobs);
      if (!result) continue;
      if (result.ok) verified++;
      else {
        failed++;
        problems.push({
          line: row.line,
          message: `${row.status} row cites ${item}: ${result.reason}`,
        });
      }
    }
    if (row.status === "Met" && verified === 0 && failed === 0)
      problems.push({
        line: row.line,
        message:
          "a Met row must name evidence: a path, a path::Name or a ci:job/step",
      });
  }
  for (const section of sections)
    if (!covered.has(section.number))
      problems.push({
        line: 1,
        message: `spec section ${section.number} (${section.title}) has no row`,
      });
  if (!rows.length)
    problems.push({ line: 1, message: "no requirement rows found" });
  const totals =
    /\*\*Totals:\*\* (\d+) Met, (\d+) Partial, (\d+) Missing, (\d+) Unverified\b/.exec(
      checklist,
    );
  if (totals) {
    const counted = STATUSES.map(
      (status) => rows.filter((row) => row.status === status).length,
    );
    if (counted.some((count, index) => count !== Number(totals[index + 1])))
      problems.push({
        line: checklist.slice(0, totals.index).split("\n").length,
        message: `the totals line must read "${STATUSES.map((status, index) => `${counted[index]} ${status}`).join(", ")}"`,
      });
  }
  return { problems, rows };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { problems, rows } = checkRequirements(root);
  for (const problem of problems)
    console.error(
      `docs/internal/REQUIREMENTS.md:${problem.line}: ${problem.message}`,
    );
  if (problems.length) {
    console.error(
      `${problems.length} problem${problems.length === 1 ? "" : "s"} in the requirements checklist.`,
    );
    return 1;
  }
  const counts = STATUSES.map(
    (status) =>
      `${rows.filter((row) => row.status === status).length} ${status}`,
  );
  console.log(`Checked ${rows.length} requirement rows: ${counts.join(", ")}.`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = main();
