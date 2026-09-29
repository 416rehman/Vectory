// Facts the reference pages must cover, read from source so the pages can't
// silently drift: every VECTORY_* variable, and every agent command and flag.
import fs from "node:fs/promises";
import path from "node:path";

async function files(root, keep) {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full, keep)));
    else if (keep(full)) found.push(full);
  }
  return found.sort();
}

// Map of VECTORY_* name -> repository-relative files that mention it.
export async function environmentVariables(repoRoot) {
  const sources = [
    ...(await files(path.join(repoRoot, "server/src"), (file) => file.endsWith(".rs"))),
    ...(await files(path.join(repoRoot, "deploy"), () => true)),
    path.join(repoRoot, "scripts/preview.sh"),
  ];
  const variables = new Map();
  for (const file of sources) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const [name] of text.matchAll(/\bVECTORY_[A-Z0-9_]+\b/g)) {
      const where = path.relative(repoRoot, file).replaceAll(path.sep, "/");
      variables.set(name, [...new Set([...(variables.get(name) || []), where])]);
    }
  }
  return variables;
}

// Balanced-brace body of the block that opens at text[start] === "{".
function block(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start + 1, i);
  }
  return text.slice(start + 1);
}

// `case` labels that belong to this switch, not to switches nested inside it.
function topLevelCases(body) {
  const labels = [];
  let depth = 0;
  for (const line of body.split("\n")) {
    const match = depth === 0 && line.match(/^\s*case\s+([^:]+):/);
    if (match) labels.push(match[1]);
    for (const char of line.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, "")) {
      if (char === "{") depth++;
      else if (char === "}") depth--;
    }
  }
  return labels;
}

// Commands and flags defined by the agent CLI in agent/cmd/vectory (tests excluded).
export async function agentInterface(repoRoot) {
  const sources = await files(path.join(repoRoot, "agent/cmd/vectory"), (file) => file.endsWith(".go") && !file.endsWith("_test.go"));
  const commands = new Map(), flags = new Map();
  const add = (map, name, file) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return;
    const where = path.relative(repoRoot, file).replaceAll(path.sep, "/");
    map.set(name, [...new Set([...(map.get(name) || []), where])]);
  };
  for (const file of sources) {
    const text = await fs.readFile(file, "utf8");
    // switch command { case "install": ... case "service-start", "service-stop": ... }
    for (const match of text.matchAll(/\bswitch\s+(?:command|cmd|name|sub|subcommand|verb)\s*\{/g))
      for (const label of topLevelCases(block(text, match.index + match[0].length - 1)))
        for (const [, name] of label.matchAll(/"([^"]+)"/g)) add(commands, name, file);
    // if command == "version"
    for (const [, name] of text.matchAll(/\b(?:command|cmd)\s*==\s*"([^"]+)"/g)) add(commands, name, file);
    // var commands = map[string]spec{ "install": {...} } or []spec{{name: "install"}}
    for (const match of text.matchAll(/\b\w*[cC]ommands?\w*\s*=\s*(?:map\[string\]|\[\])[\w.*]+\s*\{/g)) {
      const body = block(text, match.index + match[0].length - 1);
      for (const [, name] of body.matchAll(/^\s*"([^"]+)"\s*:/gm)) add(commands, name, file);
      for (const [, name] of body.matchAll(/\b[nN]ame\s*:\s*"([^"]+)"/g)) add(commands, name, file);
    }
    // FlagSet definitions: fs.String("state-dir", ...), fs.BoolVar(&x, "json", ...), fs.Func("mode", ...)
    for (const [, name] of text.matchAll(/\.(?:String|Bool|Int|Int64|Uint|Uint64|Float64|Duration|Func|BoolFunc)\(\s*"([^"]+)"/g)) add(flags, name, file);
    for (const [, name] of text.matchAll(/\.(?:StringVar|BoolVar|IntVar|Int64Var|UintVar|Uint64Var|Float64Var|DurationVar|TextVar|Var)\(\s*[^,()]+,\s*"([^"]+)"/g)) add(flags, name, file);
  }
  return { commands, flags };
}

// Report what a reference page is missing, one line per item with its source.
export function missing(items, documented, label) {
  return [...items]
    .filter(([name]) => !documented(name))
    .map(([name, where]) => `  ${label(name)}  (defined in ${where.join(", ")})`);
}
