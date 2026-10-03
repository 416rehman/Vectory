#!/usr/bin/env node
// Fails when a tracked text file carries a work-package, workstream, review-
// round or finding identifier, wording for how work is organised, an absolute
// home directory or a link to a chat or session page. The repository states
// the product and its design decisions on their merits.
//
//   node scripts/check-writing-rules.mjs
//
// Each failure names the file, the line, the rule and the text that matched.
// scripts/writing-rules-allow.json lists the few legitimate hits, each with
// its reason. Lock files, generated files, vendored Vector data and binary
// files are not scanned.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Ids are matched case-sensitively and not inside a longer token. A word
// whose product meaning is common ("wave" of a rollout, "worker" for the
// isolated validator, "round trip") is matched only in the phrases that
// name working arrangements.
const standalone = (body) => `(?<![\\w#./-])${body}(?![\\w-])`;
const unrelatedBrief =
  "pause|moment|delay|period|flash|window|gap|outage|time|interval|lapse|interruption|wait|overlap|summary|description|note|mention|introduction|overview|sentence|paragraph|explanation|reminder|look|glance|sketch|account|reference|history|tour|visit|check|excerpt|statement|message|answer";

export const RULES = [
  {
    id: "work-package-id",
    pattern: /\bWP\d{1,2}[a-z]?\b/g,
    why: 'number a design\'s steps ("Step 3"), not work packages',
  },
  {
    id: "work-package",
    pattern: /\bwork[- ]packages?\b/gi,
    why: 'say "step" for a part of a plan, or name the area',
  },
  {
    id: "workstream",
    pattern: /\bworkstreams?\b|\bbackend agent\b/gi,
    why: "name the area of the product, not who works on it",
  },
  {
    id: "workstream-id",
    pattern: new RegExp(standalone("W[1-7]"), "g"),
    why: "name the area of the product, not a workstream code",
  },
  {
    id: "round-id",
    // R12, R7a, and the lowercase tag a round left in names (r15-demo).
    pattern: new RegExp(
      `${standalone("R[1-9]\\d?[a-z]?")}|(?<![\\w#./-])r[1-9]\\d?-[a-z]`,
      "g",
    ),
    why: "a review round's id says nothing about the product",
  },
  {
    id: "review-round",
    pattern:
      /\breview rounds?\b|\bround[- ](?:\d+|one|two|three|four|five)\b|\b(?:first|second|third|fourth|fifth) (?:independent |operator )?review\b/gi,
    why: 'say "an independent review" and describe what it found',
  },
  {
    id: "finding-id",
    pattern: /\bP[0-3]-\d{1,2}\b/g,
    why: "describe the finding by what it was, not by its id in a review",
  },
  {
    id: "reviewers-said",
    pattern:
      /\bcritics?\b|\breviewers? (?:said|found|asked|reported|flagged|noted|wrote|recommended|wanted|demanded)\b/gi,
    why: "state the property or decision itself, not who raised it",
  },
  {
    id: "the-lead",
    pattern: /\bthe lead\b(?! paragraphs?\b)|\blead's\b/gi,
    why: "say what the thing is, or name the area",
  },
  {
    id: "worker",
    pattern:
      /\b(?:another|other|each|every|all|several|parallel|implementation|review|second|third|previous|earlier|prior|next) workers?\b|\bworkers?(?:'s|’s|s')? (?:brief|branch|branches|report|reports|worktree|worktrees|prompt|merge|commit|task|handoff|wave|finish(?:es|ed)?)\b|\bworkers? (?:and|or|to) (?:the )?(?:lead|reviewers?|maintainer)\b/gi,
    why: "name the process or test that runs, not a person doing the work",
  },
  {
    id: "wave",
    pattern:
      /\bwave[- ]?\d+\b|\b(?:worker|agent|implementation|review|fix|merge|engineer)s?[- ]waves?\b|\bwaves? of (?:workers?|agents?|work|fixes|reviews?|changes|implementation|engineers?|commits)\b|\bend-of-wave\b/gi,
    why: 'say "batch" for a set of changes; "wave" names a rollout stage',
  },
  {
    id: "brief",
    pattern: new RegExp(
      `\\b(?:the|this|that|your|our|each|every|worker|task|work|scrub|implementation) briefs?\\b(?!\\s+(?:${unrelatedBrief})\\b)|\\b[A-Z]+-BRIEF\\b`,
      "gi",
    ),
    why: "state the requirement itself, not the instructions it came from",
  },
  {
    id: "handoff",
    pattern: /(?<![\w-])hand-?offs?(?![\w-])(?!\.md)/gi,
    why: "describe what is passed on and to what; a status report is a status report",
  },
  {
    id: "session-link",
    pattern:
      /\bsession_[0-9A-Za-z]{10,}\b|https?:\/\/[^\s)>\]"'`]*\/(?:chat|chats|c|share|session|sessions|conversation|conversations)\/[0-9A-Za-z_-]{8,}/g,
    why: "a link to a chat or a session is private",
  },
];

// Absolute home directories on Linux, macOS and Windows. The account name is
// captured: placeholder accounts listed in the allowlist are fine.
const HOME_DIRECTORIES = [
  /(?<![\w.~-])\/home\/([A-Za-z_][\w.-]*)/g,
  /(?<![\w.~-])\/Users\/([A-Za-z_][\w.-]*)/g,
  /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([A-Za-z_][\w.~-]*)/g,
];
const HOME_RULE = {
  id: "home-directory",
  why: "a home directory names a person or a machine; use a placeholder such as /home/you",
};

export const RULE_IDS = [...RULES.map((rule) => rule.id), HOME_RULE.id];

const SKIPPED_DIRECTORIES = ["node_modules/", "vector-catalog/"];
const LOCKFILES =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|[^/]*\.lock)$/;
const BINARY =
  /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|zip|gz|tgz|xz|bz2|7z|exe|dll|so|dylib|a|o|wasm|pdf|msi|deb|rpm)$/i;
const GENERATED_HEADER = /\bgenerated by\b|\bcode generated\b|\bdo not edit\b/i;

/** Whether a repository-relative POSIX path is never scanned. */
export function isSkippedPath(file) {
  if (SKIPPED_DIRECTORIES.some((directory) => file.startsWith(directory)))
    return true;
  if (file.includes("/node_modules/")) return true;
  if (/^contracts\/[^/]+\.json$/.test(file)) return true;
  if (file.startsWith("dashboard/src/generated/")) return true;
  if (/_generated\.[a-z]+$/.test(file)) return true;
  return LOCKFILES.test(file) || BINARY.test(file);
}

/** Whether a file's own header says it is generated. */
export function isGenerated(text) {
  return GENERATED_HEADER.test(text.split("\n", 8).join("\n"));
}

/** Every rule violation in one text: { line, rule, match, why }. */
export function scanText(text, { accounts = new Set() } = {}) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((content, index) => {
    const line = index + 1;
    for (const rule of RULES) {
      for (const hit of content.matchAll(rule.pattern))
        found.push({
          line,
          rule: rule.id,
          match: hit[0],
          why: rule.why,
          content,
        });
    }
    for (const pattern of HOME_DIRECTORIES) {
      for (const hit of content.matchAll(pattern)) {
        const account = hit[1].toLowerCase().replace(/~\d+$/, "");
        if (accounts.has(account)) continue;
        found.push({
          line,
          rule: HOME_RULE.id,
          match: hit[0],
          why: HOME_RULE.why,
          content,
        });
      }
    }
  });
  return found;
}

function globToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (character === "*") source += "[^/]*";
    else source += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Whether an allowlist path pattern covers a file ("dir/" covers a directory). */
export function pathMatches(pattern, file) {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  return pattern.includes("*")
    ? globToRegExp(pattern).test(file)
    : pattern === file;
}

/** Problems in the allowlist itself; an empty list means it can be trusted. */
export function allowlistProblems(allow) {
  const problems = [];
  const entries = allow?.entries;
  if (!Array.isArray(entries)) return ["entries must be an array"];
  entries.forEach((entry, index) => {
    const where = `entries[${index}]`;
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 12)
      problems.push(`${where}: a reason of at least a sentence is required`);
    if (
      !Array.isArray(entry.paths) ||
      !entry.paths.length ||
      !entry.paths.every((p) => typeof p === "string" && p)
    )
      problems.push(`${where}: paths must list at least one path`);
    if (entry.rules !== undefined) {
      if (!Array.isArray(entry.rules) || !entry.rules.length)
        problems.push(`${where}: rules must list at least one rule`);
      else
        for (const rule of entry.rules)
          if (!RULE_IDS.includes(rule))
            problems.push(`${where}: unknown rule "${rule}"`);
    }
    if (
      entry.match !== undefined &&
      (typeof entry.match !== "string" || !entry.match)
    )
      problems.push(`${where}: match must be a non-empty string`);
  });
  for (const [index, account] of (allow.accounts ?? []).entries()) {
    if (typeof account.name !== "string" || !account.name)
      problems.push(`accounts[${index}]: a name is required`);
    if (typeof account.reason !== "string" || account.reason.trim().length < 12)
      problems.push(
        `accounts[${index}]: a reason of at least a sentence is required`,
      );
  }
  return problems;
}

/**
 * Scans files ({ path, text }) and returns the violations the allowlist does
 * not excuse, plus the allowlist entries that excused nothing.
 */
export function check(files, allow = { entries: [], accounts: [] }) {
  const accounts = new Set(
    (allow.accounts ?? []).map((account) => account.name.toLowerCase()),
  );
  const used = new Set();
  const violations = [];
  for (const { path: file, text } of files) {
    if (isSkippedPath(file) || isGenerated(text)) continue;
    for (const hit of scanText(text, { accounts })) {
      const entryIndex = (allow.entries ?? []).findIndex(
        (entry) =>
          entry.paths.some((pattern) => pathMatches(pattern, file)) &&
          (!entry.rules || entry.rules.includes(hit.rule)) &&
          (!entry.match || hit.content.includes(entry.match)),
      );
      if (entryIndex >= 0) used.add(entryIndex);
      else violations.push({ file, ...hit });
    }
  }
  const unused = (allow.entries ?? [])
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !used.has(index))
    .map(({ entry, index }) => ({ index, paths: entry.paths }));
  return { violations, unused };
}

function listFiles(root) {
  const names = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const files = [];
  for (const name of names) {
    if (isSkippedPath(name)) continue;
    let data;
    try {
      data = fs.readFileSync(path.join(root, name));
    } catch {
      continue;
    }
    if (data.subarray(0, 8192).includes(0)) continue;
    files.push({ path: name, text: data.toString("utf8") });
  }
  return files;
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const allow = JSON.parse(
    fs.readFileSync(
      path.join(root, "scripts/writing-rules-allow.json"),
      "utf8",
    ),
  );
  const broken = allowlistProblems(allow);
  for (const problem of broken)
    console.error(`scripts/writing-rules-allow.json: ${problem}`);
  if (broken.length) return 1;
  const files = listFiles(root);
  const { violations, unused } = check(files, allow);
  const missing = unused.filter(({ paths }) =>
    paths.every(
      (pattern) =>
        !pattern.includes("*") &&
        !pattern.endsWith("/") &&
        !fs.existsSync(path.join(root, pattern)),
    ),
  );
  for (const { index, paths } of missing)
    console.error(
      `scripts/writing-rules-allow.json: entries[${index}] names ${paths.join(", ")}, which is not in the repository`,
    );
  for (const violation of violations)
    console.error(
      `${violation.file}:${violation.line}: [${violation.rule}] "${violation.match}": ${violation.why}`,
    );
  for (const { index, paths } of unused.filter(
    (item) => !missing.includes(item),
  ))
    console.log(
      `note: allowlist entries[${index}] (${paths.join(", ")}) excused nothing; remove it if it is no longer needed.`,
    );
  if (violations.length || missing.length) {
    if (violations.length)
      console.error(
        `${violations.length} violation${violations.length === 1 ? "" : "s"} of the writing rules. Reword the text to say what the product does and why; scripts/writing-rules-allow.json lists the legitimate exceptions.`,
      );
    return 1;
  }
  console.log(
    `${files.length} tracked text files: no process vocabulary, personal home directory or session link.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = main();
