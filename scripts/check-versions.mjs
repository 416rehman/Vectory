#!/usr/bin/env node
// Fails when the parts of the product disagree about their version: the agent's
// source constant (which the release build and `vectory version` read), the
// server crate and its lock file, the dashboard and Help center packages and
// their lock files, the API description and the newest changelog heading.
//   node scripts/check-versions.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const json = (root, file) => JSON.parse(read(root, file));

/** Where each part says its version; a part that says nothing maps to undefined. */
export function versions(root) {
  const found = {};
  const grab = (file, find) => {
    try {
      found[file] = find();
    } catch {
      found[file] = undefined;
    }
  };
  grab(
    "agent/internal/agent/types.go",
    () =>
      /^const Version = "([^"]+)"$/m.exec(
        read(root, "agent/internal/agent/types.go"),
      )?.[1],
  );
  grab(
    "server/Cargo.toml",
    () => /^version = "([^"]+)"$/m.exec(read(root, "server/Cargo.toml"))?.[1],
  );
  grab(
    "server/Cargo.lock",
    () =>
      /name = "vectory-server"\r?\nversion = "([^"]+)"/.exec(
        read(root, "server/Cargo.lock"),
      )?.[1],
  );
  for (const dir of ["dashboard", "help-center"]) {
    grab(
      `${dir}/package.json`,
      () => json(root, `${dir}/package.json`).version,
    );
    grab(
      `${dir}/package-lock.json`,
      () => json(root, `${dir}/package-lock.json`).version,
    );
  }
  grab(
    "contracts/openapi.json",
    () => json(root, "contracts/openapi.json").info.version,
  );
  grab(
    "CHANGELOG.md",
    () =>
      /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/m.exec(
        read(root, "CHANGELOG.md"),
      )?.[1],
  );
  return found;
}

/** One line per part that is missing or differs from the agent's constant. */
export function problems(found) {
  const wanted = found["agent/internal/agent/types.go"];
  if (!wanted)
    return ["agent/internal/agent/types.go: no `const Version` found"];
  const out = [];
  for (const [file, version] of Object.entries(found)) {
    if (!version) out.push(`${file}: no version found`);
    else if (version !== wanted)
      out.push(`${file}: ${version}, but the agent says ${wanted}`);
  }
  return out;
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const found = versions(root);
  const bad = problems(found);
  for (const line of bad) console.error(line);
  if (bad.length) return 1;
  console.log(
    `Every one of ${Object.keys(found).length} version declarations says ${found["agent/internal/agent/types.go"]}.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = main();
