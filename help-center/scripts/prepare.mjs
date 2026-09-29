import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { articleContent, homeMarkdown } from "./markdown.mjs";

export const helpRoot = fileURLToPath(new URL("../", import.meta.url));
export const repoRoot = path.resolve(helpRoot, "..");
export const topics = [
  "getting-started",
  "installation",
  "pipelines",
  "resources",
  "deployments",
  "telemetry",
  "troubleshooting",
  "administer",
  "compatibility",
  "glossary",
  "api",
];

export async function prepare() {
  const content = path.join(helpRoot, "src/content/docs");
  const markdownDirectory = path.join(helpRoot, "public/_markdown");
  await fs.mkdir(content, { recursive: true });
  await fs.mkdir(markdownDirectory, { recursive: true });
  for (const entry of await fs.readdir(markdownDirectory)) {
    if (entry.endsWith(".md")) await fs.unlink(path.join(markdownDirectory, entry));
  }
  const markdown = [];
  async function writeMarkdown(slug, title, source) {
    if (!/^[a-z][a-z-]*$/.test(slug)) throw new Error("Invalid Markdown slug");
    await fs.writeFile(path.join(markdownDirectory, slug + ".md"), source);
    markdown.push({slug, title, path: `/help/_markdown/${slug}.md`, sha256: createHash("sha256").update(source).digest("hex")});
  }
  // This directory contains only generated copies. Authored sources live in docs/user.
  for (const entry of await fs.readdir(content)) {
    if (entry.endsWith(".md")) await fs.unlink(path.join(content, entry));
  }
  for (const topic of topics) {
    const source = (
      await fs.readFile(path.join(repoRoot, "docs/user", topic + ".md"), "utf8")
    ).replace(/^\uFEFF/, "");
    const article = articleContent(source, topic);
    const {title, body} = article;
    await fs.writeFile(
      path.join(content, topic + ".md"),
      `---\ntitle: ${JSON.stringify(title)}\n---\n${body}`,
    );
    await writeMarkdown(topic, title, article.markdown);
  }
  const home = await fs.readFile(path.join(helpRoot, "home.md"), "utf8");
  await fs.writeFile(path.join(content, "index.md"), home);
  const homeCopy = homeMarkdown(home);
  await writeMarkdown("index", homeCopy.title, homeCopy.markdown);
  await fs.writeFile(
    path.join(content, "404.md"),
    "---\ntitle: Page not found\neditUrl: false\npagefind: false\n---\nThis guide could not be found. [Browse the help center](/help/) or use search to find an answer.\n",
  );
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
