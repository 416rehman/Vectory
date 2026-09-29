import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build } from "astro";
import { parse, serialize } from "parse5";
import { prepare, helpRoot, repoRoot, version } from "./prepare.mjs";
import { checkLinks } from "./check-links.mjs";

const prepared = await prepare();
// Astro's prerender worker resolves external packages from the process cwd.
// The dashboard invokes this script from its own package directory.
process.chdir(helpRoot);
await build({ root: pathToFileURL(helpRoot + path.sep) });
const output = path.join(helpRoot, "dist");
const scriptDir = path.join(output, "_scripts");
await fs.mkdir(scriptDir, { recursive: true });
const pages = [];
async function files(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(full)));
    else result.push(full);
  }
  return result;
}
function walk(node, callback) {
  callback(node);
  for (const child of node.childNodes || []) walk(child, callback);
}
// Starlight's theme, code-copy and search bootstraps normally contain inline JS.
// Externalize them so help works under Vectory's script-src 'self' policy.
for (const file of (await files(output)).filter((file) =>
  file.endsWith(".html"),
)) {
  const document = parse(await fs.readFile(file, "utf8"));
  const scripts = [];
  walk(document, (node) => {
    // Wide examples must be reachable for keyboard users to scroll on mobile.
    if (
      node.tagName === "pre" &&
      !node.attrs.some((a) => a.name === "tabindex")
    ) {
      node.attrs.push({ name: "tabindex", value: "0" });
    }
    if (node.tagName !== "script" || node.attrs.some((a) => a.name === "src"))
      return;
    const type = node.attrs.find((a) => a.name === "type")?.value || "";
    if (
      type &&
      !["module", "text/javascript", "application/javascript"].includes(type)
    )
      return;
    const source = node.childNodes.map((child) => child.value || "").join("");
    if (!source.trim()) return;
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 24);
    node.attrs.push({ name: "src", value: `/help/_scripts/${hash}.js` });
    node.childNodes = [];
    scripts.push(fs.writeFile(path.join(scriptDir, hash + ".js"), source));
  });
  await Promise.all(scripts);
  await fs.writeFile(file, serialize(document));
  pages.push(path.relative(output, file).replaceAll(path.sep, "/"));
}
await fs.writeFile(
  path.join(output, "help-manifest.json"),
  JSON.stringify({ version: version.vectory, vector: version.vector, pages, markdown: prepared.markdown }, null, 2) +
    "\n",
);
await checkLinks(
  output,
  pages.map((page) => path.join(output, page)),
  path.join(repoRoot, "dashboard/src"),
  prepared.markdown,
  {
    legacy: JSON.parse(await fs.readFile(path.join(helpRoot, "legacy-anchors.json"), "utf8")),
    texts: ["/help/llms.txt"],
  },
);
const destination = path.resolve(repoRoot, "dashboard/dist/help");
if (path.dirname(destination) !== path.resolve(repoRoot, "dashboard/dist"))
  throw new Error("Unexpected help output path");
await fs.rm(destination, { recursive: true, force: true });
await fs.cp(output, destination, { recursive: true });
console.log(
  `Bundled ${pages.length} help pages with local search and CSP-compatible scripts.`,
);
