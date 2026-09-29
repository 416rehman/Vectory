import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "parse5";
import { markdownReferences } from "./markdown.mjs";
import { createHash } from "node:crypto";

// Help destinations named in dashboard source: DocLink and HelpLink elements,
// page-header help={{ topic, section }} descriptors, and literal /help/ paths.
export function dashboardHelpTargets(source) {
  const targets = [];
  const add = (topic, section, index) =>
    targets.push({ href: `/help/${topic}/${section ? "#" + section : ""}`, line: source.slice(0, index).split("\n").length });
  for (const match of source.matchAll(/<(?:DocLink|HelpLink)\b([\s\S]*?)>/g)) {
    const topic = match[1].match(/\btopic="([^"]+)"/)?.[1];
    const section = match[1].match(/\bsection="([^"]+)"/)?.[1];
    if (topic) add(topic, section, match.index);
  }
  for (const match of source.matchAll(/\bhelp=\{\{([\s\S]*?)\}\}/g)) {
    const topic = match[1].match(/\btopic:\s*"([^"]+)"/)?.[1];
    const section = match[1].match(/\bsection:\s*"([^"]+)"/)?.[1];
    if (topic) add(topic, section, match.index);
  }
  for (const match of source.matchAll(/["'`]\/help\/([a-z][a-z-]*)\/(?:#([a-z0-9-]+))?["'`]/g))
    add(match[1], match[2], match.index);
  return targets;
}

// legacy: { page: { "old-section": "new-page#new-section" } }
export async function checkLinks(output, htmlFiles, dashboardSrc, markdown = [], { legacy = {}, texts = [] } = {}) {
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
    for (const { href, line } of dashboardHelpTargets(source))
      references.push({ href, from: `${file}:${line}` });
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
  for (const text of texts) {
    const source = await fs.readFile(path.join(output, text.slice("/help/".length)), "utf8");
    for (const href of markdownReferences(source)) references.push({ href, from: text });
  }
  const pageOf = (pathname) => pathname.match(/^\/help\/(?:([a-z][a-z-]*)\/)?$/)?.[1] || "index";
  const pathOf = (page) => `/help/${page === "index" ? "" : page + "/"}`;
  // Every legacy entry must point at a real section and must not shadow one.
  for (const [page, sections] of Object.entries(legacy)) {
    const ids = documents.get(pathOf(page));
    if (!ids) {
      errors.push(`legacy-anchors.json: unknown page ${page}`);
      continue;
    }
    for (const [old, target] of Object.entries(sections)) {
      if (ids.has(old)) errors.push(`legacy-anchors.json: ${page}#${old} still exists on the page; remove the entry`);
      const [targetPage, targetSection = ""] = target.split("#");
      const targetIds = documents.get(pathOf(targetPage));
      if (!targetIds || (targetSection && !targetIds.has(targetSection)))
        errors.push(`legacy-anchors.json: ${page}#${old} points to missing ${target}`);
    }
  }
  let legacyReferences = 0;
  for (const { href, from } of references) {
    const url = new URL(href, origin + (from.startsWith("/") ? from : "/"));
    if (url.origin !== origin || !url.pathname.startsWith("/help/")) continue;
    const ids = documents.get(url.pathname);
    if (ids) {
      const section = decodeURIComponent(url.hash.slice(1));
      if (!section || ids.has(section)) continue;
      if (legacy[pageOf(url.pathname)]?.[section]) {
        legacyReferences++;
        continue;
      }
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
    `Verified ${references.length} help links and assets, including application context links` +
      (legacyReferences ? ` (${legacyReferences} through legacy-anchors.json).` : "."),
  );
}
