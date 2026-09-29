import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { articleContent, canonicalLink, homeMarkdown, mapMarkdownLinks, markdownReferences } from "./markdown.mjs";
import { prepare, helpRoot, repoRoot, topics } from "./prepare.mjs";

test("canonical destinations preserve application queries and avoid installation-specific context", () => {
  assert.equal(canonicalLink("#/docs/pipelines#vrl", "resources"), "/help/pipelines/#vrl");
  assert.equal(canonicalLink("#one", "index"), "/help/#one");
  assert.equal(canonicalLink("#one", "pipelines"), "/help/pipelines/#one");
  assert.equal(canonicalLink("pipelines.md#vrl", "index"), "/help/pipelines/#vrl");
  assert.equal(canonicalLink("#/configurations?panel=settings&section=tests", "resources"), "/#/configurations?panel=settings&section=tests");
  assert.equal(canonicalLink("https://vector.dev/docs/", "resources"), "https://vector.dev/docs/");
});

test("link rewriting preserves fenced, inline, indented and multiline code verbatim", () => {
  const source = "[Read](#/docs/pipelines#vrl)\n[ref]: #/docs/resources\n`[inline](#/docs/api)` and [Open](#/devices)\n``two ` ticks [example](#/docs/api)``\n```markdown\n[code](#/docs/api)\n```\n~~~~md\n[tilde](#/docs/api)\n~~~~\n    [indent](#/docs/api)\n`multiline\n[inside](#/docs/api)\n` [after](#local)\n";
  const actual = mapMarkdownLinks(source, link => canonicalLink(link, "resources"));
  const expected = source.replace("[Read](#/docs/pipelines#vrl)", "[Read](/help/pipelines/#vrl)").replace("[ref]: #/docs/resources", "[ref]: /help/resources/").replace("[Open](#/devices)", "[Open](/#/devices)").replace("[after](#local)", "[after](/help/resources/#local)");
  assert.equal(actual, expected);
  assert.deepEqual(markdownReferences(actual), ["/help/pipelines/#vrl", "/help/resources/", "/#/devices", "/help/resources/#local"]);
});

test("home becomes ordinary Markdown with its authored content and no HTML chrome", async () => {
  const source = await fs.readFile(path.join(helpRoot, "home.md"), "utf8");
  const result = homeMarkdown(source);
  assert.ok(result.markdown.startsWith(`# ${result.title}\n\n`));
  assert.ok(!/<\/?(?:div|p|a|span|strong)\b/.test(result.markdown));
  assert.ok(!result.markdown.includes("tableOfContents:"));
  assert.ok(result.markdown.includes("## Common questions"));
  for (const target of ["getting-started", "pipelines", "deployments", "troubleshooting", "administer", "glossary"]) assert.ok(result.markdown.includes(`](/help/${target}/)`));
  assert.ok(!result.markdown.includes("\n\n\n"));
  const sample = "---\ntitle: Example\n---\n\n```html\n<p class=\"sample\">Keep me</p>\n```\n\n<p>Prose</p>\n";
  assert.ok(homeMarkdown(sample).markdown.includes("```html\n<p class=\"sample\">Keep me</p>\n```"));
});

test("all authored articles retain title, prose, code fences and table rows", async () => {
  for (const topic of topics) {
    const source = await fs.readFile(path.join(repoRoot, "docs/user", topic + ".md"), "utf8");
    const result = articleContent(source, topic);
    assert.ok(result.markdown.startsWith(source.replace(/^\uFEFF/, "").split(/\r?\n/)[0] + "\n\n"), topic);
    for (const block of source.matchAll(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm)) assert.ok(result.markdown.includes(block[0].trimEnd()), `${topic}: code fence`);
    for (const row of source.split(/\r?\n/).filter(line => /^\|/.test(line))) assert.ok(result.markdown.includes(mapMarkdownLinks(row, href => canonicalLink(href, topic))), `${topic}: table row`);
    const sourceBody = source.replace(/^\uFEFF/, "").replace(/^# .+\r?\n/, "");
    assert.ok(result.markdown.endsWith(mapMarkdownLinks(sourceBody, href => canonicalLink(href, topic)).trim() + "\n"), `${topic}: complete source body`);
    assert.ok(!markdownReferences(result.markdown).some(link => link.startsWith("#/docs/")), topic);
  }
});

test("prepare emits one deterministic Markdown asset per article and homepage", async () => {
  const first = await prepare();
  assert.equal(first.markdown.length, topics.length + 1);
  for (const entry of first.markdown) {
    assert.match(entry.path, /^\/help\/_markdown\/[a-z][a-z-]*\.md$/);
    const source = await fs.readFile(path.join(helpRoot, "public/_markdown", entry.slug + ".md"), "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), entry.sha256);
    assert.ok(source.startsWith(`# ${entry.title}\n\n`));
    assert.ok(!source.startsWith("---"));
    assert.equal(source, entry.slug === "index" ? homeMarkdown(await fs.readFile(path.join(helpRoot,"home.md"),"utf8")).markdown : articleContent(await fs.readFile(path.join(repoRoot,"docs/user",entry.slug+".md"),"utf8"),entry.slug).markdown);
  }
  assert.deepEqual((await prepare()).markdown, first.markdown);
  assert.deepEqual((await fs.readdir(path.join(helpRoot,"public/_markdown"))).sort(), [...topics,"index"].map(topic=>topic+".md").sort());
});
