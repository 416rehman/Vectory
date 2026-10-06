import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { publicMarkdown } from "../scripts/public-docs.mjs";
import { markdownReferences } from "../../help-center/scripts/markdown.mjs";

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

test("browser distributions expose the release notices and required upstream terms", async () => {
  const canonical = await fs.readFile(path.join(root, "NOTICE"));
  const notice = canonical.toString("utf8");
  assert.match(notice, /Copyright \(c\) Meta Platforms, Inc\. and affiliates\./);
  assert.match(notice, /Mozilla Public License, version 2\.0/i);
  assert.match(notice, /vectordotdev\/vector\/tree\/v0\.58\.0/);
  assert.match(notice, /@astrojs\/starlight/);
  assert.match(notice, /Instrument Sans/);
  assert.match(notice, /component.artwork/i);
  for (const file of [
    "dashboard/public/NOTICE.txt",
    "dashboard/dist-designer/NOTICE.txt",
    "site/dist/NOTICE.txt",
    "site/dist/designer/NOTICE.txt",
  ]) {
    assert.deepEqual(
      await fs.readFile(path.join(root, file)),
      canonical,
      `${file} differs from the release notice`,
    );
  }
  for (const file of [
    "dashboard/dist/help/index.html",
    "site/dist/help/index.html",
    "site/dist/index.html",
    "site/dist/designer/index.html",
  ]) {
    const html = await fs.readFile(path.join(root, file), "utf8");
    assert.match(html, /href="\/NOTICE\.txt"/, `${file} has no visible notice link`);
  }
  const headers = (await fs.readFile(path.join(output, "_headers"), "utf8")).replaceAll("\r\n", "\n");
  for (const route of ["/NOTICE.txt", "/LICENSE.txt", "/designer/NOTICE.txt", "/help/legal/*"]) {
    assert(
      headers.includes(`${route}\n  X-Robots-Tag: noindex`),
      `${route} is missing its noindex response header`,
    );
  }
});

test("installed and public Help ship the source for their exact Pagefind browser binaries", async () => {
  const manifestBytes = await fs.readFile(path.join(root, "help-center/legal/pagefind-1.5.2-source.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const archiveName = manifest.archive.filename;
  assert.equal(archiveName, "pagefind-1.5.2-source.tar.gz");
  assert.equal(manifest.version, "1.5.2");
  assert.equal(manifest.upstream_commit, "a2e9f40ef326f9a7926247695df25981a6f3ef4b");
  assert.equal(manifest.source_inputs.length, 23);
  assert.deepEqual(
    manifest.ui_source_inputs.map(({ name }) => name).sort(),
    ["bcp-47", "is-alphabetical", "is-alphanumerical", "is-decimal", "svelte"],
  );
  const archive = await fs.readFile(path.join(root, "help-center/legal", archiveName));
  assert.equal(archive.length, manifest.archive.bytes);
  assert.equal(createHash("sha256").update(archive).digest("hex"), manifest.archive.sha256);
  const notice = await fs.readFile(path.join(root, "NOTICE"), "utf8");
  assert.match(notice, /\/help\/legal\/pagefind-1\.5\.2-source\.tar\.gz/);
  for (const helpPath of ["dashboard/dist/help", "site/dist/help"]) {
    const directory = path.join(root, helpPath);
    assert.deepEqual(
      await fs.readFile(path.join(directory, "legal/pagefind-1.5.2-source.json")),
      manifestBytes,
    );
    assert.deepEqual(
      await fs.readFile(path.join(directory, "legal", archiveName)),
      archive,
    );
    for (const record of manifest.wasm) {
      const bytes = await fs.readFile(path.join(directory, "pagefind", record.filename));
      assert.equal(bytes.length, record.bytes, `${helpPath}/${record.filename} size`);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        record.sha256,
        `${helpPath}/${record.filename} digest`,
      );
    }
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
    else assert.match(html, /name="robots" content="noindex"/);
    for (const [, href] of html.matchAll(/\bhref="(\/[^"]*)"/g)) {
      const pathname = new URL(href, "https://vectory.ahmadz.ai/").pathname;
      const target = path.join(output, pathname, pathname.endsWith("/") ? "index.html" : "");
      assert((await fs.stat(target).catch(() => null))?.isFile(), `${relative} links to missing ${href}`);
    }
  }
});

test("the installed Help center keeps its dashboard route", async () => {
  const embedded = await fs.readFile(path.join(root, "dashboard/dist/help/index.html"), "utf8");
  assert.match(embedded, /href="\/#\/overview" aria-label="Open Vectory"/);
  const api = await fs.readFile(path.join(root, "dashboard/dist/help/api/index.html"), "utf8");
  assert.match(api, /href="\/api-reference.html"/);
});

test("public Markdown is usable outside an installed server and matches its inventory", async () => {
  for (const entry of manifest.markdown) {
    const markdown = await fs.readFile(path.join(output, entry.path), "utf8");
    assert(!markdown.includes("\u2014"), `${entry.slug} Markdown uses an em dash`);
    assert.equal(createHash("sha256").update(markdown).digest("hex"), entry.sha256);
    assert(!markdownReferences(markdown).some((href) => href.startsWith("/#/") || href === "/api-reference.html"), `${entry.slug} retains an installed-server link`);
  }
});

test("public documentation instructions preserve literal configuration examples", () => {
  const example = "```text\n[Devices](/#/devices)\n```\n\n`[API](/api-reference.html)`";
  const markdown = publicMarkdown(`# Guide\n\n[Devices](/#/devices) and [API](/api-reference.html).\n\n${example}\n`);
  assert(markdown.includes(example), "Code example was rewritten");
  assert(markdown.includes("API on your own Vectory server at `/api-reference.html`"));
  assert.deepEqual(markdownReferences(markdown), []);
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
