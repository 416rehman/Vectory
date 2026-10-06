import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
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
// Pagefind's shipped browser WASM includes third-party code. Keep its exact
// corresponding-source archive next to the search files in both the installed
// Help center and the public copy. A changed binary or source bundle must be
// reviewed and recorded before either build can be distributed.
const legalInput = path.join(helpRoot, "legal");
const sourceManifest = JSON.parse(
  await fs.readFile(
    path.join(legalInput, "pagefind-1.5.2-source.json"),
    "utf8",
  ),
);
const nativePackages = {
  "darwin-arm64": "@pagefind/darwin-arm64",
  "darwin-x64": "@pagefind/darwin-x64",
  "freebsd-x64": "@pagefind/freebsd-x64",
  "linux-arm64": "@pagefind/linux-arm64",
  "linux-x64": "@pagefind/linux-x64",
  "win32-arm64": "@pagefind/windows-arm64",
  "win32-x64": "@pagefind/windows-x64",
};
if (
  sourceManifest.schema !== 2 ||
  sourceManifest.version !== "1.5.2" ||
  sourceManifest.upstream_commit !==
    "a2e9f40ef326f9a7926247695df25981a6f3ef4b" ||
  !sourceManifest.upstream_source_url?.includes("Pagefind/pagefind") ||
  typeof sourceManifest.build_recipe !== "string" ||
  !sourceManifest.build_recipe.trim() ||
  sourceManifest.archive?.filename !== "pagefind-1.5.2-source.tar.gz" ||
  !Array.isArray(sourceManifest.source_inputs) ||
  sourceManifest.source_inputs.length < 23 ||
  !Array.isArray(sourceManifest.ui_source_inputs) ||
  sourceManifest.ui_source_inputs.length !== 5 ||
  !sourceManifest.wasm_profiles ||
  Object.keys(sourceManifest.wasm_profiles).sort().join(",") !==
    Object.keys(nativePackages).sort().join(",")
) {
  throw new Error(
    "Pagefind source manifest is incomplete or refers to a different release",
  );
}
const profileKey = `${process.platform}-${process.arch}`;
const profile = sourceManifest.wasm_profiles[profileKey];
if (!profile)
  throw new Error(`Unverified Pagefind build platform: ${profileKey}`);
const nativePackage = profile.native_package;
const lockedPackages = JSON.parse(
  await fs.readFile(path.join(helpRoot, "package-lock.json"), "utf8"),
);
const lockEntry =
  lockedPackages.packages?.[`node_modules/${nativePackage?.name}`];
if (
  nativePackage?.name !== nativePackages[profileKey] ||
  nativePackage.version !== "1.5.2" ||
  nativePackage.upstream_commit !== sourceManifest.upstream_commit ||
  !nativePackage.published_provenance_url ||
  !/^[a-f0-9]{64}$/.test(nativePackage.published_provenance_sha256 || "") ||
  !/^[a-f0-9]{64}$/.test(nativePackage.sha256 || "") ||
  !Number.isSafeInteger(nativePackage.bytes) ||
  nativePackage.bytes <= 0 ||
  lockEntry?.version !== nativePackage.version ||
  lockEntry.resolved !== nativePackage.url ||
  lockEntry.integrity !== nativePackage.integrity ||
  !Array.isArray(profile.wasm) ||
  profile.wasm.length !== 2 ||
  !profile.verification
) {
  throw new Error(
    `Pagefind ${profileKey} native package is not the reviewed release`,
  );
}
const nativeRoot = path.join(
  helpRoot,
  "node_modules",
  ...nativePackage.name.split("/"),
);
const installedPackage = JSON.parse(
  await fs.readFile(path.join(nativeRoot, "package.json"), "utf8"),
);
if (
  installedPackage.name !== nativePackage.name ||
  installedPackage.version !== nativePackage.version
)
  throw new Error(
    `Installed Pagefind native package differs from ${profileKey} manifest`,
  );
const nativeBinaryPath = path.resolve(nativeRoot, nativePackage.binary);
if (!nativeBinaryPath.startsWith(nativeRoot + path.sep))
  throw new Error("Pagefind native binary path leaves its installed package");
const nativeBinary = await fs.readFile(nativeBinaryPath);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (sha256(nativeBinary) !== nativePackage.binary_sha256)
  throw new Error(
    `Pagefind ${profileKey} native binary differs from reviewed package`,
  );
async function verifySourceRecord(file, record) {
  const bytes = await fs.readFile(file);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256)
    throw new Error(
      `Pagefind source or browser binary does not match its manifest: ${file}`,
    );
  return bytes;
}
await verifySourceRecord(
  path.join(legalInput, sourceManifest.archive.filename),
  sourceManifest.archive,
);
const expectedWasm = new Set(["wasm.en.pagefind", "wasm.unknown.pagefind"]);
for (const record of profile.wasm) {
  if (!expectedWasm.delete(record.filename))
    throw new Error(
      `Unexpected or duplicate Pagefind browser binary: ${record.filename}`,
    );
  const compressed = await verifySourceRecord(
    path.join(output, "pagefind", record.filename),
    record,
  );
  const uncompressed = gunzipSync(compressed);
  if (
    uncompressed.length !== record.uncompressed_bytes ||
    sha256(uncompressed) !== record.uncompressed_sha256 ||
    !uncompressed.subarray(0, 12).equals(Buffer.from("pagefind_dcd"))
  ) {
    throw new Error(
      `Pagefind ${profileKey} browser module is not the reviewed source payload`,
    );
  }
  const decoded = uncompressed.subarray(12);
  if (
    decoded.length !== record.decoded_wasm_bytes ||
    sha256(decoded) !== record.decoded_wasm_sha256
  )
    throw new Error(
      `Pagefind ${profileKey} decoded WASM differs from reviewed source payload`,
    );
  if (
    !Number.isSafeInteger(record.native_binary_offset) ||
    record.native_binary_offset < 0 ||
    record.native_binary_offset + compressed.length > nativeBinary.length ||
    !nativeBinary
      .subarray(
        record.native_binary_offset,
        record.native_binary_offset + compressed.length,
      )
      .equals(compressed)
  ) {
    throw new Error(
      `Pagefind ${profileKey} browser module is absent from its native binary`,
    );
  }
}
await fs.mkdir(path.join(output, "legal"), { recursive: true });
await fs.copyFile(
  path.join(legalInput, sourceManifest.archive.filename),
  path.join(output, "legal", sourceManifest.archive.filename),
);
await fs.copyFile(
  path.join(legalInput, "pagefind-1.5.2-source.json"),
  path.join(output, "legal/pagefind-1.5.2-source.json"),
);
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
  JSON.stringify(
    {
      version: version.vectory,
      vector: version.vector,
      pages,
      markdown: prepared.markdown,
    },
    null,
    2,
  ) + "\n",
);
await checkLinks(
  output,
  pages.map((page) => path.join(output, page)),
  path.join(repoRoot, "dashboard/src"),
  prepared.markdown,
  {
    legacy: JSON.parse(
      await fs.readFile(path.join(helpRoot, "legacy-anchors.json"), "utf8"),
    ),
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
