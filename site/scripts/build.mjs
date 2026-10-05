import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(siteRoot, "..");
const helpRoot = path.join(repoRoot, "help-center");
const output = path.join(siteRoot, "dist");
const origin = "https://vectory.ahmadz.ai";

// This is the only directory this build clears. Keep it exact and inside site/.
assert.equal(path.resolve(output), path.join(siteRoot, "dist"));
assert.equal(path.dirname(output), siteRoot);

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function allFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(full));
    else files.push(full);
  }
  return files;
}

// The regular Help center build also verifies every local documentation link,
// externalizes Starlight's scripts for the server CSP, and bundles /help/ into
// dashboard/dist. The public build copies its output; it does not fork the docs.
await run(process.execPath, ["scripts/build.mjs"], helpRoot);
const helpOutput = path.join(helpRoot, "dist");
const manifest = JSON.parse(await fs.readFile(path.join(helpOutput, "help-manifest.json"), "utf8"));
assert.equal(manifest.version, "0.1.0", "Public preview copy and built docs must describe the same release");
assert(manifest.pages.length >= 20, "A partial Help center must not be published");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(path.join(output, "help"), { recursive: true });
await fs.cp(helpOutput, path.join(output, "help"), { recursive: true });
await fs.copyFile(path.join(siteRoot, "src/index.html"), path.join(output, "index.html"));
await fs.copyFile(path.join(siteRoot, "src/site.css"), path.join(output, "site.css"));
await fs.copyFile(path.join(repoRoot, "dashboard/public/favicon.svg"), path.join(output, "favicon.svg"));
await fs.mkdir(path.join(output, "fonts"), { recursive: true });
await fs.copyFile(path.join(helpOutput, "fonts/instrument-sans-latin.woff2"), path.join(output, "fonts/instrument-sans-latin.woff2"));
await fs.mkdir(path.join(output, "media"), { recursive: true });
for (const name of ["product-editor.png", "product-overview.png"]) {
  await fs.copyFile(path.join(repoRoot, "docs/screenshots", name), path.join(output, "media", name));
}

// The installed Help center links directly into the server dashboard. The
// public site has no dashboard at /#/, so keep those references as readable
// text rather than leading visitors to an empty route. Its header returns home.
const helpPages = (await allFiles(path.join(output, "help"))).filter((file) => file.endsWith(".html"));
const publicPaths = [];
for (const file of helpPages) {
  const relative = path.relative(path.join(output, "help"), file).replaceAll(path.sep, "/");
  const pathname = "/help/" + relative.replace(/index\.html$/, "");
  let html = await fs.readFile(file, "utf8");
  const headerLink = /<a class="help-open-app" href="\/#\/overview" aria-label="Open Vectory">[\s\S]*?<\/a>/;
  assert(headerLink.test(html), `Missing Help center header in ${relative}`);
  html = html.replace(headerLink, '<a class="help-open-app" href="/" aria-label="Vectory home">Home <span aria-hidden="true">↗</span></a>');
  html = html.replace(/<a\b[^>]*\bhref="\/#\/[^\"]+"[^>]*>([\s\S]*?)<\/a>/g,
    (_match, label) => `<span class="help-local-app-reference" title="Open this view in your own Vectory server">${label}</span>`);
  assert(!/href="\/#\//.test(html), `Public docs contain an unusable dashboard link: ${relative}`);
  if (relative !== "404.html") {
    html = html.replace("</head>", `<link rel="canonical" href="${origin}${pathname}"></head>`);
    publicPaths.push(pathname);
  }
  await fs.writeFile(file, html);
}

const sitemapPaths = ["/", ...publicPaths.sort()];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPaths.map((pathname) => `  <url><loc>${origin}${pathname}</loc></url>`).join("\n")}\n</urlset>\n`;
await fs.writeFile(path.join(output, "sitemap.xml"), sitemap);
await fs.writeFile(path.join(output, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
await fs.writeFile(path.join(output, "llms.txt"), `# Vectory\n\n> Self-hosted Vector control plane. Vectory 0.1.0 is an unsigned developer preview.\n\n- [Overview](${origin}/)\n- [Quickstart](${origin}/help/_markdown/quickstart.md)\n- [Security model](${origin}/help/_markdown/security.md)\n- [Known limits](${origin}/help/whats-new/#known-limits)\n- [All guides](${origin}/help/llms.txt)\n`);
await fs.copyFile(path.join(siteRoot, "src/_headers"), path.join(output, "_headers"));
await fs.copyFile(path.join(siteRoot, "src/_redirects"), path.join(output, "_redirects"));
await fs.copyFile(path.join(siteRoot, "src/404.html"), path.join(output, "404.html"));
console.log(`Built public site with ${publicPaths.length} documentation pages at ${output}`);
