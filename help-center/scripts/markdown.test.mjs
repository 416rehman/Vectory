import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { articleContent, canonicalLink, homeMarkdown, leadParagraph, mapMarkdownLinks, markdownReferences, renderMdx, stripComments } from "./markdown.mjs";
import { prepare, helpRoot, repoRoot, topics, llmsText } from "./prepare.mjs";
import { groups } from "../pages.mjs";

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
  for (const href of markdownReferences(result.markdown).filter((href) => href.startsWith("/help/") && !href.includes("llms.txt")))
    assert.ok(topics.includes(href.split("/")[2]), `home links to an unknown page: ${href}`);
  for (const target of ["quickstart", "getting-started", "installation", "install-server", "ports", "troubleshooting"])
    assert.ok(result.markdown.includes(`](/help/${target}/`), target);
  assert.ok(!result.markdown.includes("\n\n\n"));
  const sample = "---\ntitle: Example\n---\n\n```html\n<p class=\"sample\">Keep me</p>\n```\n\n<p>Prose</p>\n";
  assert.ok(homeMarkdown(sample).markdown.includes("```html\n<p class=\"sample\">Keep me</p>\n```"));
});

test("all authored articles keep their title, prose, code and tables in the Markdown copy", async () => {
  for (const topic of topics) {
    const source = await fs.readFile(path.join(repoRoot, "docs/user", topic + ".md"), "utf8");
    const result = articleContent(source, topic);
    assert.ok(result.markdown.startsWith(source.replace(/^﻿/, "").split(/\r?\n/)[0] + "\n\n"), topic);
    for (const block of source.matchAll(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm)) assert.ok(result.markdown.includes(block[0].trimEnd()), `${topic}: code fence`);
    for (const row of source.split(/\r?\n/).filter(line => /^\|/.test(line))) assert.ok(result.markdown.includes(mapMarkdownLinks(row, href => canonicalLink(href, topic))), `${topic}: table row`);
    const sourceBody = source.replace(/^﻿/, "").replace(/^# .+\r?\n/, "");
    assert.equal(result.markdown, `# ${result.title}\n\n${stripComments(mapMarkdownLinks(sourceBody, href => canonicalLink(href, topic))).trim()}\n`, `${topic}: complete source body`);
    assert.ok(!result.markdown.includes("<!--"), `${topic}: maintainer comments stay out of the Markdown copy`);
    assert.ok(!markdownReferences(result.markdown).some(link => link.startsWith("#/docs/")), topic);
    assert.ok(result.description, `${topic}: lead paragraph`);
  }
});

test("GitHub alerts become Starlight asides with an optional bold title", () => {
  const mdx = renderMdx("Intro.\n> [!WARNING]\n> **Keep it safe**\n> Body with `code {x}`.\n\nAfter.\n");
  assert.match(mdx, /Intro\.\n\n:::caution\[Keep it safe\]\nBody with `code \{x\}`\.\n:::\n\nAfter\./);
  assert.match(renderMdx("> [!NOTE]\n> Plain.\n"), /^:::note\nPlain\.\n:::/m);
  assert.match(renderMdx("> [!CAUTION]\n> Stop.\n"), /^:::danger\n/m);
  assert.match(renderMdx("> A normal quote.\n"), /^> A normal quote\./m);
});

test("steps, tabs and diagrams render as components and import only what they use", () => {
  const steps = renderMdx("<!-- steps -->\n1. One.\n\n   ```sh\n   echo {}\n   ```\n\n2. Two.\n\nAfter.\n");
  assert.match(steps, /^import \{ Steps \} from "@astrojs\/starlight\/components";/);
  assert.match(steps, /<Steps>\n\n1\. One\.\n\n   ```sh\n   echo \{\}\n   ```\n\n2\. Two\.\n\n<\/Steps>\n\nAfter\./);
  assert.ok(steps.includes("   echo {}\n"), "code inside steps is not escaped");
  const tabs = renderMdx("<!-- tabs:os -->\n#### Linux\n\n```sh\n#### not a label\n```\n#### macOS\nMac.\n<!-- /tabs -->\n");
  assert.match(tabs, /<Tabs syncKey="os">\n<TabItem label="Linux">\n\n```sh\n#### not a label\n```\n\n<\/TabItem>\n<TabItem label="macOS">\n\nMac\.\n\n<\/TabItem>\n<\/Tabs>/);
  assert.match(tabs, /import \{ Tabs, TabItem \}/);
  const diagram = renderMdx("<!-- diagram: architecture -->\n```mermaid\nflowchart LR\n  A --> B\n```\n");
  assert.match(diagram, /import Architecture from "\.\.\/\.\.\/components\/Architecture\.astro";\n\n<Architecture \/>\n$/);
  assert.equal(renderMdx("Plain.\n"), "Plain.\n");
  assert.throws(() => renderMdx("<!-- steps -->\nNot a list.\n"), /ordered list/);
  assert.throws(() => renderMdx("<!-- tabs -->\n#### Only one\n<!-- /tabs -->\n"), /at least two/);
  assert.throws(() => renderMdx("<!-- tabs -->\n#### A\n#### B\n"), /Unclosed/);
  assert.throws(() => renderMdx("<!-- diagram: nope -->\n```mermaid\nx\n```\n"), /Unknown diagram/);
  assert.throws(() => renderMdx("<!-- /tabs -->\n"), /without an opening/);
});

test("comments disappear, prose braces and angle brackets are escaped, code stays verbatim", () => {
  const source = "<!-- verify-after-merge: check -->\nA {brace} and <placeholder> and `{kept} <kept>`.\n<!--\nmulti\nline\n-->\nEnd <kbd>K</kbd>.\n\n```json\n{\"a\": \"<b>\"}\n```\n";
  const mdx = renderMdx(source);
  assert.ok(!mdx.includes("verify-after-merge") && !mdx.includes("multi"));
  assert.ok(mdx.includes("A \\{brace\\} and &lt;placeholder> and `{kept} <kept>`."));
  assert.ok(mdx.includes("End <kbd>K</kbd>."));
  assert.ok(mdx.includes("```json\n{\"a\": \"<b>\"}\n```"));
  assert.equal(stripComments("a\n\n<!-- x -->\n\nb\n"), "a\n\nb\n");
  assert.equal(stripComments("```\n<!-- kept in code -->\n```\n"), "```\n<!-- kept in code -->\n```\n");
  assert.throws(() => stripComments("<!-- open\n"), /Unclosed/);
});

test("the lead paragraph is plain text from the first prose block", () => {
  assert.equal(leadParagraph("<!-- c -->\n> [!NOTE]\n> x\n\nUse **Vectory** with [Vector](https://vector.dev/) and `vectory`.\n\nNext."), "Use Vectory with Vector and vectory.");
});

test("llms.txt lists every page, grouped like the sidebar, with Markdown links", () => {
  const pages = [{ slug: "index", title: "Home", path: "/help/_markdown/index.md" }, ...topics.map((slug) => ({ slug, title: slug.toUpperCase(), description: `About ${slug}.`, path: `/help/_markdown/${slug}.md` }))];
  const text = llmsText(pages);
  assert.match(text, /^# Vectory Help center\n\n> /);
  for (const group of groups) assert.ok(text.includes(`\n## ${group.label}\n`), group.label);
  for (const slug of topics) assert.ok(text.includes(`- [${slug.toUpperCase()}](/help/_markdown/${slug}.md): About ${slug}.`), slug);
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
  const llms = await fs.readFile(path.join(helpRoot, "public/llms.txt"), "utf8");
  for (const topic of topics) assert.ok(llms.includes(`(/help/_markdown/${topic}.md)`), topic);
});

test("every docs/user page is registered once, and nothing else lives in docs/user", async () => {
  assert.equal(new Set(topics).size, topics.length);
  const entries = (await fs.readdir(path.join(repoRoot, "docs/user"))).sort();
  assert.deepEqual(entries, [...topics].map((topic) => topic + ".md").sort());
});
