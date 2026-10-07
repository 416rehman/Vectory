import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { publicMarkdown } from "../scripts/public-docs.mjs";
import { publicGuideMetadata } from "../scripts/seo.mjs";
import { markdownReferences } from "../../help-center/scripts/markdown.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "site/dist");
const landing = await fs.readFile(path.join(output, "index.html"), "utf8");
const manifest = JSON.parse(await fs.readFile(path.join(output, "help/help-manifest.json"), "utf8"));

test("public landing describes the install path and labels demo evidence", () => {
  const body = landing.slice(landing.indexOf("<body>"));
  assert.match(body, /No Rust, Go or Node toolchain is needed/);
  assert.match(body, /https:\/\/vectory\.ahmadz\.ai\/install.sh/);
  assert.match(body, /Choose your OS\.<br \/>Start your server\./);
  assert.match(body, /synthetic demo/);
  assert.match(landing, /rel="canonical" href="https:\/\/vectory\.ahmadz\.ai\/"/);
  assert.match(landing, /name="description"/);
  assert.doesNotMatch(body, /Actual interface/);
  for (const name of ["linux", "macos", "windows"]) {
    assert.match(body, new RegExp(`id="install-${name}-tab"`));
    assert.match(body, new RegExp(`id="install-${name}-panel"`));
  }
  assert.match(body, /install-native\.sh/);
  assert.match(body, /install-desktop\.sh/);
  assert.match(body, /install\.ps1/);
});

test("the product leads the landing page and the standalone designer remains a tool", () => {
  const hero = landing.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0];
  assert(hero, "Landing hero missing");
  assert.match(hero, /class="button button-dark" href="#start">Install Vectory/);
  assert.match(hero, /class="quiet-link" href="\/designer\/">Try the standalone designer/);
  assert.match(hero, /src="\/media\/flow-art.webp"/);
  assert.doesNotMatch(hero, /Open source · Docker Compose · No compiling/);
  const navigation = landing.match(/<nav aria-label="Main navigation">[\s\S]*?<\/nav>/)?.[0];
  assert.match(navigation, /<summary>Tools/);
  assert.match(navigation, /href="\/designer\/"/);
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
    if (url.hash) {
      const html = await fs.readFile(target, 'utf8');
      const targetIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
      assert(targetIds.has(decodeURIComponent(url.hash.slice(1))), `Missing destination section ${href}`);
    }
  }
  for (const [, src] of landing.matchAll(/\bsrc="(\/[^"]+)"/g)) {
    const pathname = new URL(src, "https://vectory.ahmadz.ai/").pathname;
    assert((await fs.stat(path.join(output, pathname)).catch(() => null))?.isFile(), `Missing local asset ${src}`);
  }
});

test("public installers ship exact release-owned bytes with fresh download headers", async () => {
  const headers = await fs.readFile(path.join(output, '_headers'), 'utf8');
  for (const name of ["install.sh", "install-desktop.sh", "install.ps1", "install-native.sh"]) {
    const bytes = await fs.readFile(path.join(output, name));
    assert(bytes.equals(await fs.readFile(path.join(root, "deploy", name))), `${name} differs from its release-owned source`);
    const pinned = name.endsWith('.ps1') ? /^\$version = '([^']+)'$/m : /^version='([^']+)'$/m;
    assert.equal(pinned.exec(bytes.toString('utf8'))?.[1], manifest.version, `${name} does not install the advertised release`);
    const section = headers.replaceAll("\r\n", "\n").split(`/${name}\n`)[1]?.split("\n\n")[0];
    assert(section, `Missing headers for ${name}`);
    assert.match(section, /X-Robots-Tag: noindex/);
    assert.match(section, /Content-Type: text\/plain; charset=utf-8/);
    assert.match(section, /Content-Disposition: attachment/);
    assert.match(section, /Cache-Control: no-store, max-age=0/);
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
    assert(
      (await fs.readFile(path.join(root, file))).equals(canonical),
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

test("public HTML opts out of edge rewriting without changing asset cache policies", async () => {
  const headers = (await fs.readFile(path.join(output, "_headers"), "utf8")).replaceAll("\r\n", "\n");
  const blocks = headers.trim().split(/\n\s*\n/);
  const rules = new Map(blocks.map((block) => {
    const [route, ...entries] = block.split("\n");
    return [route, entries.map((entry) => entry.trim())];
  }));
  assert.equal(rules.size, blocks.length, "duplicate _headers routes could override the HTML policy");

  const sitemap = await fs.readFile(path.join(output, "sitemap.xml"), "utf8");
  const htmlRoutes = [
    ...[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => new URL(url).pathname),
    "/404.html",
    "/help/404.html",
  ].sort();
  const policy = "Cache-Control: public, max-age=0, must-revalidate, no-transform";
  for (const route of htmlRoutes) {
    assert.deepEqual(rules.get(`https://vectory.ahmadz.ai${route}`), [policy], `${route} must retain HTML caching and prevent edge injection`);
  }
  assert.deepEqual(
    [...rules].filter(([, entries]) => entries.some((entry) => entry.includes("no-transform"))).map(([route]) => route).sort(),
    htmlRoutes.map((route) => `https://vectory.ahmadz.ai${route}`).sort(),
    "only this domain's HTML routes should opt out of transformation",
  );
  assert.deepEqual(rules.get("/media/*"), ["Cache-Control: public, max-age=3600"]);
  assert.deepEqual(rules.get("/fonts/*"), ["Cache-Control: public, max-age=31536000, immutable"]);
  assert.deepEqual(rules.get("/favicons/*"), ["Cache-Control: public, max-age=86400"]);
  assert(!rules.get("/*").some((entry) => entry.startsWith("Cache-Control:")));
  assert(rules.get("/designer/*").some((entry) => entry.startsWith("Content-Security-Policy: ")));
});

test("installed and public Help ship the source for their exact Pagefind browser binaries", async () => {
  const manifestBytes = await fs.readFile(path.join(root, "help-center/legal/pagefind-1.5.2-source.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const archiveName = manifest.archive.filename;
  assert.equal(archiveName, "pagefind-1.5.2-source.tar.gz");
  assert.equal(manifest.version, "1.5.2");
  assert.equal(manifest.upstream_commit, "a2e9f40ef326f9a7926247695df25981a6f3ef4b");
  assert.equal(manifest.schema, 2);
  assert.deepEqual(Object.keys(manifest.wasm_profiles).sort(), [
    "darwin-arm64", "darwin-x64", "freebsd-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64",
  ]);
  const profile = manifest.wasm_profiles[`${process.platform}-${process.arch}`];
  assert(profile, "no reviewed Pagefind profile for the build platform");
  assert.equal(profile.native_package.upstream_commit, manifest.upstream_commit);
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
    for (const record of profile.wasm) {
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
  assert.match(home, /Vectory 0\.2\.0/);
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

test("every sitemap page has one indexable canonical and distinct source-based metadata", async () => {
  const origin = "https://vectory.ahmadz.ai";
  const sitemap = await fs.readFile(path.join(output, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url);
  assert.equal(new Set(urls).size, urls.length, "Sitemap contains duplicate destinations");
  const titles = new Set();
  for (const url of urls) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, origin);
    assert.equal(parsed.search + parsed.hash, "", `Noncanonical sitemap destination: ${url}`);
    assert(parsed.pathname.endsWith("/"), `Canonical page must use its trailing slash: ${url}`);
    const html = await fs.readFile(path.join(output, parsed.pathname, "index.html"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    const canonical = [...head.matchAll(/<link\b[^>]*\brel="canonical"[^>]*>/g)];
    assert.equal(canonical.length, 1, `Ambiguous canonical for ${url}`);
    assert(canonical[0][0].includes(`href="${url}"`), `Canonical differs from sitemap: ${url}`);
    assert.doesNotMatch(head, /<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/, `${url} is in the sitemap but not indexable`);
    const title = head.match(/<title>([\s\S]*?)<\/title>/)?.[1].trim();
    assert(title && !titles.has(title), `Missing or repeated page title: ${url}`);
    titles.add(title);
    for (const [attribute, key] of [["name", "description"], ["property", "og:title"], ["property", "og:description"], ["property", "og:url"], ["name", "twitter:card"]]) {
      const tags = [...head.matchAll(new RegExp(`<meta\\b[^>]*\\b${attribute}="${key}"[^>]*>`, "g"))];
      assert.equal(tags.length, 1, `Missing or duplicate ${key}: ${url}`);
      assert.match(tags[0][0], /content="[^\"]+"/, `Empty ${key}: ${url}`);
    }
    if (parsed.pathname.startsWith("/help/")) {
      const structured = [...head.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap(([, json]) => JSON.parse(json)["@graph"] || []);
      const document = structured.find((node) => node["@type"] === (parsed.pathname === "/help/" ? "CollectionPage" : "TechArticle"));
      assert.equal(document?.url, url, `Guide schema does not describe this page: ${url}`);
      assert(document.description, `Guide schema needs the source description: ${url}`);
      const breadcrumbs = structured.find((node) => node["@type"] === "BreadcrumbList")?.itemListElement;
      assert.equal(breadcrumbs?.at(-1)?.item, url, `Guide hierarchy ends elsewhere: ${url}`);
      breadcrumbs.forEach((entry, index) => {
        assert.equal(entry.position, index + 1);
        assert(entry.name);
        assert(urls.includes(entry.item), `Breadcrumb points outside the canonical inventory: ${url}`);
      });
    }
  }
  const robots = await fs.readFile(path.join(output, "robots.txt"), "utf8");
  assert.match(robots, /User-agent: \*\nAllow: \/\n/);
  assert(robots.includes(`Sitemap: ${origin}/sitemap.xml`));
  const discovery = await fs.readFile(path.join(output, "llms.txt"), "utf8");
  assert.match(discovery, /Vector pipeline and fleet manager/);
  for (const href of markdownReferences(discovery)) {
    const destination = new URL(href);
    assert.equal(destination.origin, origin);
    const file = path.join(output, destination.pathname, destination.pathname.endsWith("/") ? "index.html" : "");
    assert((await fs.stat(file).catch(() => null))?.isFile(), `Machine-readable index links to missing ${href}`);
  }
});

test("public guide metadata escapes source text while preserving article content", () => {
  const title = 'A & "quoted" </script> title';
  const input = '<html><head><title>Old</title><meta name="description" content="Old"><link rel="canonical" href="https://example.invalid/"></head><body><p>Original guide</p></body></html>';
  const html = publicGuideMetadata(input, { origin: "https://vectory.ahmadz.ai", pathname: "/help/pipelines/", page: { title, description: 'A "source" & description' } });
  assert(html.endsWith('<body><p>Original guide</p></body></html>'));
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((html.match(/name="description"/g) || []).length, 1);
  assert(html.includes('A &amp; &quot;quoted&quot; &lt;/script&gt; title'));
  const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.equal(JSON.parse(json)["@graph"][0].headline, title);
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
  assert.match(designer, /<h1>Vector config builder<\/h1>/);
  assert.match(designer, /<summary>About this tool<\/summary>/);
  assert.match(designer, /Visualize and generate Vector configurations/);
  assert.match(designer, /name="twitter:card" content="summary_large_image"/);
  const designerGraph = JSON.parse(designer.match(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)?.[1])["@graph"];
  const designerPage = designerGraph.find((node) => node["@type"] === "WebPage");
  const designerApp = designerGraph.find((node) => node["@type"] === "WebApplication");
  const designerBreadcrumbs = designerGraph.find((node) => node["@type"] === "BreadcrumbList");
  assert.equal(designerPage.url, "https://vectory.ahmadz.ai/designer/");
  assert.equal(designerApp.url, designerPage.url);
  assert.equal(designerPage.mainEntity["@id"], designerApp["@id"]);
  assert.equal(designerPage.breadcrumb["@id"], designerBreadcrumbs["@id"]);
  assert.equal(designerBreadcrumbs.itemListElement.at(-1).item, designerPage.url);
  assert.equal(designerApp.isAccessibleForFree, true);
  assert.equal(designerApp.offers.price, "0");
  for (const [attribute, key] of [["name", "description"], ["property", "og:description"], ["name", "twitter:description"]]) {
    const tag = designer.match(new RegExp(`<meta\\b[^>]*\\b${attribute}="${key}"[^>]*>`))?.[0];
    assert.equal(tag?.match(/content="([^"]+)"/)?.[1], designerPage.description);
  }
});
