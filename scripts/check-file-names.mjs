#!/usr/bin/env node
// Fails when tracked files would collide on a case-insensitive disk (Windows,
// macOS): two files in a directory whose names differ only in letter case, or
// two script modules whose import names do (TypeScript tries `./Foo.ts` before
// `./Foo.tsx`, so there an import of the component `Foo.tsx` lands on `foo.ts`).
//   node scripts/check-file-names.mjs
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const scriptModule = /\.(?:d\.ts|[cm]?[jt]sx?)$/;
const notImportable = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Groups of tracked paths that one case-insensitive disk would merge. */
export function caseCollisions(files) {
  const names = new Map();
  const modules = new Map();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    const name = path.posix.basename(file);
    const key = `${dir}/${name.toLowerCase()}`;
    names.set(key, [...(names.get(key) ?? []), file]);
    if (scriptModule.test(name) && !notImportable.test(name)) {
      const stem = `${dir}/${name.replace(scriptModule, "").toLowerCase()}`;
      modules.set(stem, [...(modules.get(stem) ?? []), file]);
    }
  }
  const problems = [];
  for (const group of names.values())
    if (group.length > 1)
      problems.push(`same name but for letter case: ${group.join(", ")}`);
  for (const group of modules.values()) {
    const spellings = new Set(
      group.map((f) => path.posix.basename(f).replace(scriptModule, "")),
    );
    if (spellings.size > 1)
      problems.push(
        `modules whose import names differ only in letter case: ${group.join(", ")}`,
      );
  }
  return problems;
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const problems = caseCollisions(files);
  for (const problem of problems) console.error(problem);
  if (problems.length) return 1;
  console.log(
    `${files.length} tracked files: none collide on a case-insensitive disk.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = main();
