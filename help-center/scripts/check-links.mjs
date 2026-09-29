import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "parse5";
import { markdownReferences } from "./markdown.mjs";
import { createHash } from "node:crypto";

export async function checkLinks(output, htmlFiles, dashboardSrc, markdown = []) {
  const documents = new Map();
  const references = [];
  const origin = "https://vectory.invalid";
  function walk(node, visit) {
    visit(node);
    for (const child of node.childNodes || []) walk(child, visit);
  }
  for (const file of htmlFiles) {
    const relative = path.relative(output, file).replaceAll(path.sep, "/");
    const pathname = "/help/" + relative.replace(/index\.html$/, "");
    const ids = new Set();
    const document = parse(await fs.readFile(file, "utf8"));
    walk(document, (node) => {
      const attributes = Object.fromEntries(
        (node.attrs || []).map((a) => [a.name, a.value]),
      );
      if (attributes.id) ids.add(attributes.id);
      if (attributes.href)
        references.push({ href: attributes.href, from: pathname });
      if (attributes.src && ["script", "img"].includes(node.tagName))
        references.push({ href: attributes.src, from: pathname });
    });
    documents.set(pathname, ids);
  }
  // Verify the application's explicit contextual links alongside article links.
  for (const file of (await fs.readdir(dashboardSrc)).filter((file) =>
    file.endsWith(".tsx"),
  )) {
    const source = await fs.readFile(path.join(dashboardSrc, file), "utf8");
    for (const match of source.matchAll(/<DocLink\b([\s\S]*?)>/g)) {
      const topic = match[1].match(/\btopic="([^"]+)"/)?.[1];
      const section = match[1].match(/\bsection="([^"]+)"/)?.[1];
      if (topic)
        references.push({
          href: `/help/${topic}/${section ? "#" + section : ""}`,
          from: file,
        });
    }
  }
  const errors = [];
  for (const entry of markdown) {
    if (!/^\/help\/_markdown\/[a-z][a-z-]*\.md$/.test(entry.path))
      throw new Error(`Invalid Markdown asset path: ${entry.path}`);
    const source = await fs.readFile(path.join(output, entry.path.slice("/help/".length)), "utf8");
    if (entry.sha256 && createHash("sha256").update(source).digest("hex") !== entry.sha256)
      throw new Error(`Markdown asset does not match its authored source: ${entry.path}`);
    for (const href of markdownReferences(source)) references.push({href, from: entry.path});
  }
  for (const { href, from } of references) {
    const url = new URL(href, origin + (from.startsWith("/") ? from : "/"));
    if (url.origin !== origin || !url.pathname.startsWith("/help/")) continue;
    const ids = documents.get(url.pathname);
    if (ids) {
      if (url.hash && !ids.has(decodeURIComponent(url.hash.slice(1))))
        errors.push(`${from}: missing section ${href}`);
    } else {
      const target = path.resolve(
        output,
        "." + decodeURIComponent(url.pathname.slice(5)),
      );
      if (!target.startsWith(output + path.sep))
        errors.push(`${from}: invalid local link ${href}`);
      else if (!(await fs.stat(target).catch(() => null))?.isFile())
        errors.push(`${from}: missing local link ${href}`);
    }
  }
  if (errors.length)
    throw new Error(
      "Help link check failed:\n" + [...new Set(errors)].join("\n"),
    );
  console.log(
    `Verified ${references.length} help links and assets, including application context links.`,
  );
}
