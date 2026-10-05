import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "site/dist");
const landing = await fs.readFile(path.join(output, "index.html"), "utf8");
const manifest = JSON.parse(await fs.readFile(path.join(output, "help/help-manifest.json"), "utf8"));

test("public landing describes the preview and labels demo evidence", () => {
  const body = landing.slice(landing.indexOf("<body>"));
  assert.match(body, /0\.1\.0 is a developer preview/);
  assert.match(body, /Downloads are unsigned/);
  assert.match(body, /synthetic demo/);
  assert.match(landing, /rel="canonical" href="https:\/\/vectory\.ahmadz\.ai\/"/);
  assert.match(landing, /name="description"/);
});

test("public landing's local destinations exist", async () => {
  const ids = new Set([...landing.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const [, href] of landing.matchAll(/\bhref="(\/[^"]*|#[^"]+)"/g)) {
    const url = new URL(href, "https://vectory.ahmadz.ai/");
    if (url.pathname === "/" && url.hash) {
      assert(ids.has(url.hash.slice(1)), `Missing landing section ${href}`);
      continue;
    }
    const target = path.join(output, url.pathname, url.pathname.endsWith("/") ? "index.html" : "");
    assert((await fs.stat(target).catch(() => null))?.isFile(), `Missing local destination ${href}`);
  }
  for (const [, src] of landing.matchAll(/\bsrc="(\/[^"]+)"/g)) {
    assert((await fs.stat(path.join(output, src)).catch(() => null))?.isFile(), `Missing local asset ${src}`);
  }
});

test("public docs are complete and do not point at a nonexistent dashboard", async () => {
  assert(manifest.pages.length >= 20);
  const home = await fs.readFile(path.join(output, "help/index.html"), "utf8");
  assert.match(home, /Vectory 0\.1\.0 developer preview/);
  for (const relative of manifest.pages) {
    const file = path.join(output, "help", relative);
    const html = await fs.readFile(file, "utf8");
    assert(!html.includes("\u2014"), `${relative} uses an em dash`);
    assert(!/href="\/#\//.test(html), `${relative} retains a local dashboard route`);
    assert.match(html, /href="\/" aria-label="Vectory home"/);
    if (relative !== "404.html") assert.match(html, /rel="canonical" href="https:\/\/vectory\.ahmadz\.ai\/help\//);
  }
});

test("the installed Help center keeps its dashboard route", async () => {
  const embedded = await fs.readFile(path.join(root, "dashboard/dist/help/index.html"), "utf8");
  assert.match(embedded, /href="\/#\/overview" aria-label="Open Vectory"/);
});

test("sitemap, machine-readable docs and static hosting files ship", async () => {
  const sitemap = await fs.readFile(path.join(output, "sitemap.xml"), "utf8");
  assert.match(sitemap, /https:\/\/vectory\.ahmadz\.ai\/help\/quickstart\//);
  // The built manifest includes the docs 404, while the sitemap replaces it
  // with the public landing page.
  assert.equal((sitemap.match(/<url>/g) || []).length, manifest.pages.length + 1);
  assert.match(sitemap, /https:\/\/vectory\.ahmadz\.ai\/designer\//);
  for (const name of ["robots.txt", "llms.txt", "_headers", "_redirects", "404.html", "favicon.svg", "favicon.ico", "site.webmanifest", "social-preview.png", "favicons/icon-180.png", "designer/index.html", "site.css", "site.js", "media/flow-art.webp", "fonts/instrument-sans-latin.woff2"]) {
    assert((await fs.stat(path.join(output, name)).catch(() => null))?.isFile(), `${name} missing`);
  }
});

test("public pages have valid search metadata and usable branding assets", async () => {
  const designer = await fs.readFile(path.join(output, "designer/index.html"), "utf8");
  for (const [name, html, canonical] of [["landing", landing, "https://vectory.ahmadz.ai/"], ["designer", designer, "https://vectory.ahmadz.ai/designer/"]]) {
    assert(html.includes(`rel="canonical" href="${canonical}"`), `${name} canonical missing`);
    assert.match(html, /name="description"/);
    assert(!html.includes("\u2014"), `${name} uses an em dash`);
    const structured = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
    assert(structured.length, `${name} has no structured data`);
    for (const [, json] of structured) assert.equal(JSON.parse(json)["@context"], "https://schema.org");
    assert(html.includes('/social-preview.png'), `${name} social preview missing`);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(output, "site.webmanifest"), "utf8"));
  for (const icon of manifest.icons) assert((await fs.stat(path.join(output, icon.src))).isFile());
  const ico = await fs.readFile(path.join(output, "favicon.ico"));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  const preview = await fs.readFile(path.join(output, "social-preview.png"));
  assert.equal(preview.readUInt32BE(16), 1200);
  assert.equal(preview.readUInt32BE(20), 630);
  assert.match(designer, /connect-src 'none'/);
  assert.match(designer, /Create a Vector configuration from an empty canvas/);
  assert.match(designer, /name="twitter:card" content="summary_large_image"/);
});
