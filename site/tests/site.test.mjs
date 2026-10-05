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
  assert.match(landing, /0\.1\.0 developer preview/);
  assert.match(landing, /Unsigned developer-preview downloads/);
  assert.match(landing, /synthetic demo fixtures/);
  assert.match(landing, /One deliberate path to deployment/);
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
  assert.equal((sitemap.match(/<url>/g) || []).length, manifest.pages.length);
  for (const name of ["robots.txt", "llms.txt", "_headers", "_redirects", "404.html", "favicon.svg", "site.css", "fonts/instrument-sans-latin.woff2"]) {
    assert((await fs.stat(path.join(output, name)).catch(() => null))?.isFile(), `${name} missing`);
  }
});
