#!/usr/bin/env node
// Fails when a Markdown record links to a file that is not in the repository.
//
// Checks every relative link, image and HTML src/href/srcset in:
//   README.md, SECURITY.md, CHANGELOG.md, and every *.md under docs/ (except
//   docs/user/, which the Help center's own tests check), agent/, server/,
//   packaging/, deploy/ and tests/.
// A link's file must exist. A "#section" must match a heading or an explicit
// id: in the same file, or in the linked Markdown file. Links inside code are
// not links; external URLs are not checked.
//
//   node scripts/check-doc-links.mjs            check the whole scope (CI)
//   node scripts/check-doc-links.mjs FILE...    check only these files
//
// Dependency-free: CI runs it before any npm install.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCOPE = {
  files: ["README.md", "SECURITY.md", "CHANGELOG.md"],
  trees: ["docs", "agent", "server", "packaging", "deploy", "tests"],
  excluded: ["docs/user"],
};
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".local",
  "artifacts",
  "dist",
  "node_modules",
  "target",
]);

const toPosix = (value) => value.split(path.sep).join("/");

/** Whether a repository-relative POSIX path is one of the checked records. */
export function inScope(relative) {
  if (!relative.endsWith(".md")) return false;
  if (SCOPE.files.includes(relative)) return true;
  if (SCOPE.excluded.some((prefix) => relative.startsWith(prefix + "/")))
    return false;
  return SCOPE.trees.some((tree) => relative.startsWith(tree + "/"));
}

/** Every checked Markdown file under root, as sorted POSIX paths. */
export function listMarkdownFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name))
          walk(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        const relative = toPosix(
          path.relative(root, path.join(directory, entry.name)),
        );
        if (inScope(relative)) found.push(relative);
      }
    }
  };
  for (const file of SCOPE.files)
    if (fs.existsSync(path.join(root, file))) found.push(file);
  for (const tree of SCOPE.trees)
    if (fs.existsSync(path.join(root, tree))) walk(path.join(root, tree));
  return [...new Set(found)].sort();
}

/**
 * Blanks fenced code blocks and HTML comments, keeping line breaks so that
 * line numbers still match the source.
 */
export function blankBlocks(markdown) {
  const lines = markdown.split("\n");
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        line.trim() === marker[1]
      )
        fence = null;
      lines[index] = "";
    } else if (marker) {
      fence = marker[1];
      lines[index] = "";
    }
  }
  return lines
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** blankBlocks, plus inline code spans: what is left is prose. */
export function stripCode(markdown) {
  return blankBlocks(markdown)
    .split("\n")
    .map((line) =>
      line.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (span) =>
        " ".repeat(span.length),
      ),
    )
    .join("\n");
}

function inlineDestinations(line) {
  const found = [];
  let start = 0;
  for (;;) {
    const at = line.indexOf("](", start);
    if (at === -1) break;
    let cursor = at + 2;
    while (line[cursor] === " ") cursor++;
    let destination;
    if (line[cursor] === "<") {
      const end = line.indexOf(">", cursor);
      if (end === -1) {
        start = cursor;
        continue;
      }
      destination = line.slice(cursor + 1, end);
    } else {
      let depth = 0;
      let end = cursor;
      for (; end < line.length; end++) {
        const character = line[end];
        if (character === "\\") {
          end++;
          continue;
        }
        if (character === "(") depth++;
        else if (character === ")") {
          if (depth === 0) break;
          depth--;
        } else if (/\s/.test(character)) break;
      }
      destination = line.slice(cursor, end);
    }
    if (destination) found.push({ target: destination, column: at });
    start = cursor;
  }
  return found;
}

/** Link, image, reference and HTML destinations with their 1-based lines, in source order. */
export function extractLinks(markdown) {
  const links = [];
  stripCode(markdown)
    .split("\n")
    .forEach((line, index) => {
      const found = [];
      const definition = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(line);
      if (definition)
        found.push({ target: definition[1].replace(/^<|>$/g, ""), column: 0 });
      found.push(...inlineDestinations(line));
      for (const tag of line.matchAll(
        /<(?:a|img|source|video|audio)\b[^>]*>/gi,
      ))
        for (const attribute of tag[0].matchAll(
          /\b(src|href|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
        )) {
          const value = attribute[2] ?? attribute[3] ?? "";
          const targets =
            attribute[1].toLowerCase() === "srcset"
              ? value
                  .split(",")
                  .map((candidate) => candidate.trim().split(/\s+/)[0])
              : [value];
          for (const target of targets)
            if (target)
              found.push({ target, column: tag.index + attribute.index });
        }
      found.sort((a, b) => a.column - b.column);
      for (const { target } of found) links.push({ target, line: index + 1 });
    });
  return links;
}

/** The anchor GitHub gives a heading (github-slugger, before deduplication). */
export function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "")
    .replace(/ /g, "-");
}

function headingText(raw) {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[*~]/g, "")
    .replace(/&[a-z]+;|&#\d+;/gi, "")
    .trim();
}

/** Every anchor a Markdown file defines: heading slugs and explicit ids. */
export function anchorsOf(markdown) {
  const anchors = new Set();
  const seen = new Map();
  const prose = stripCode(markdown).split("\n");
  blankBlocks(markdown)
    .split("\n")
    .forEach((line, index) => {
      const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (heading) {
        const base = githubSlug(headingText(heading[1]));
        let slug = base;
        if (seen.has(base)) {
          let count = seen.get(base);
          do slug = `${base}-${++count}`;
          while (seen.has(slug));
          seen.set(base, count);
        }
        seen.set(slug, seen.get(slug) ?? 0);
        anchors.add(slug);
      }
      for (const tag of prose[index].matchAll(/<[a-z][^>]*>/gi))
        for (const id of tag[0].matchAll(
          /\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/g,
        ))
          anchors.add(id[1] ?? id[2]);
    });
  return anchors;
}

function hasAnchor(anchors, fragment) {
  let wanted = fragment;
  try {
    wanted = decodeURIComponent(fragment);
  } catch {
    return false;
  }
  return anchors.has(wanted) || anchors.has(wanted.toLowerCase());
}

/**
 * Problems in one file: [{ file, line, target, reason }]. `read` caches file
 * contents; `anchorCache` caches each Markdown target's anchors.
 */
export function checkFile(root, relative, caches = {}) {
  const anchorCache = caches.anchors ?? new Map();
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const problems = [];
  const anchorsFor = (file) => {
    if (!anchorCache.has(file))
      anchorCache.set(
        file,
        anchorsOf(fs.readFileSync(path.join(root, file), "utf8")),
      );
    return anchorCache.get(file);
  };
  for (const { target, line } of extractLinks(source)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//"))
      continue;
    const hash = target.indexOf("#");
    const location = (hash === -1 ? target : target.slice(0, hash)).split(
      "?",
    )[0];
    const fragment = hash === -1 ? "" : target.slice(hash + 1);
    const report = (reason) =>
      problems.push({ file: relative, line, target, reason });
    if (!location) {
      if (fragment && !hasAnchor(anchorsFor(relative), fragment))
        report(`no heading or id "#${fragment}" in this file`);
      continue;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(location);
    } catch {
      report("the path is not valid URL encoding");
      continue;
    }
    const resolved = decoded.startsWith("/")
      ? path.join(root, decoded)
      : path.join(root, path.dirname(relative), decoded);
    const inside = toPosix(path.relative(root, resolved));
    if (inside.startsWith("../") || inside === "..") {
      report("the path leaves the repository");
      continue;
    }
    if (!fs.existsSync(resolved)) {
      report("no such file in the repository");
      continue;
    }
    if (
      fragment &&
      inside.endsWith(".md") &&
      fs.statSync(resolved).isFile() &&
      !hasAnchor(anchorsFor(inside), fragment)
    )
      report(`no heading or id "#${fragment}" in ${inside}`);
  }
  return problems;
}

/** Checks the given files, or the whole scope; returns every problem. */
export function checkLinks(root, files = listMarkdownFiles(root)) {
  const caches = { anchors: new Map() };
  return files.flatMap((file) => checkFile(root, file, caches));
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const requested = argv.map((file) =>
    toPosix(path.relative(root, path.resolve(file))),
  );
  const files = requested.length ? requested : listMarkdownFiles(root);
  const problems = checkLinks(root, files);
  for (const problem of problems)
    console.error(
      `${problem.file}:${problem.line}: ${problem.target}: ${problem.reason}`,
    );
  if (problems.length) {
    console.error(
      `${problems.length} broken link${problems.length === 1 ? "" : "s"} in ${new Set(problems.map((problem) => problem.file)).size} file(s). Link only to committed files; name uncommitted evidence in plain text.`,
    );
    return 1;
  }
  console.log(
    `Checked ${files.length} Markdown files: every relative link resolves.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = main(process.argv.slice(2));
