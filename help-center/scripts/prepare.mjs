import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { articleContent, homeMarkdown } from "./markdown.mjs";
import { groups, topics } from "../pages.mjs";

export const helpRoot = fileURLToPath(new URL("../", import.meta.url));
export const repoRoot = path.resolve(helpRoot, "..");
export { topics };
// The Help center says the version its own package declares; scripts/check-versions.mjs
// keeps that equal to the agent's, the server's and the changelog's.
const own = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
export const version = { vectory: own.version, vector: "0.58.0" };

// Page titles come from each source's H1; the sidebar and llms.txt reuse them.
export async function pageTitles() {
  const titles = {};
  for (const topic of topics) {
    const source = await fs.readFile(path.join(repoRoot, "docs/user", topic + ".md"), "utf8");
    const heading = source.replace(/^﻿/, "").match(/^# (.+)\r?\n/);
    if (!heading) throw new Error(`Missing title in docs/user/${topic}.md`);
    titles[topic] = heading[1];
  }
  return titles;
}

// llms.txt (https://llmstxt.org): the page list with links to plain Markdown.
export function llmsText(pages) {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const lines = [
    "# Vectory Help center",
    "",
    `> Build, deploy and operate Vector pipelines with Vectory ${version.vectory} and Vector ${version.vector}. Every page is also available as plain Markdown.`,
    "",
    `- [Help center home](/help/_markdown/index.md)`,
  ];
  for (const group of groups) {
    lines.push("", `## ${group.label}`, "");
    for (const [slug] of group.pages) {
      const page = bySlug.get(slug);
      lines.push(`- [${page.title}](${page.path})${page.description ? `: ${page.description}` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function prepare() {
  const content = path.join(helpRoot, "src/content/docs");
  const markdownDirectory = path.join(helpRoot, "public/_markdown");
  await fs.mkdir(content, { recursive: true });
  await fs.mkdir(markdownDirectory, { recursive: true });
  for (const entry of await fs.readdir(markdownDirectory)) {
    if (entry.endsWith(".md")) await fs.unlink(path.join(markdownDirectory, entry));
  }
  const markdown = [];
  async function writeMarkdown(slug, title, source, description = "") {
    if (!/^[a-z][a-z-]*$/.test(slug)) throw new Error("Invalid Markdown slug");
    await fs.writeFile(path.join(markdownDirectory, slug + ".md"), source);
    markdown.push({slug, title, description, path: `/help/_markdown/${slug}.md`, sha256: createHash("sha256").update(source).digest("hex")});
  }
  // This directory contains only generated copies. Authored sources live in docs/user.
  for (const entry of await fs.readdir(content)) {
    if (/\.mdx?$/.test(entry)) await fs.unlink(path.join(content, entry));
  }
  const authored = (await fs.readdir(path.join(repoRoot, "docs/user"))).filter((entry) => entry.endsWith(".md"));
  const unlisted = authored.map((entry) => entry.slice(0, -3)).filter((slug) => !topics.includes(slug));
  if (unlisted.length)
    throw new Error(`Add these docs/user pages to help-center/pages.mjs: ${unlisted.join(", ")}`);
  for (const topic of topics) {
    const source = (
      await fs.readFile(path.join(repoRoot, "docs/user", topic + ".md"), "utf8")
    ).replace(/^﻿/, "");
    const article = articleContent(source, topic);
    const {title, description, body} = article;
    await fs.writeFile(
      path.join(content, topic + ".mdx"),
      `---\ntitle: ${JSON.stringify(title)}\n${description ? `description: ${JSON.stringify(description)}\n` : ""}---\n${body}`,
    );
    await writeMarkdown(topic, title, article.markdown, description);
  }
  const home = await fs.readFile(path.join(helpRoot, "home.md"), "utf8");
  await fs.writeFile(path.join(content, "index.md"), home);
  const homeCopy = homeMarkdown(home);
  await writeMarkdown("index", homeCopy.title, homeCopy.markdown);
  await fs.writeFile(
    path.join(content, "404.md"),
    "---\ntitle: Page not found\neditUrl: false\npagefind: false\n---\nThis guide could not be found. [Browse the help center](/help/) or use search to find an answer.\n",
  );
  await fs.writeFile(path.join(helpRoot, "public/llms.txt"), llmsText(markdown));
  await fs.mkdir(path.join(helpRoot, "public/fonts"), { recursive: true });
  await fs.cp(
    path.join(repoRoot, "dashboard/public/fonts"),
    path.join(helpRoot, "public/fonts"),
    { recursive: true },
  );
  await fs.copyFile(
    path.join(repoRoot, "dashboard/public/favicon.svg"),
    path.join(helpRoot, "public/favicon.svg"),
  );
  return {markdown};
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prepare();
