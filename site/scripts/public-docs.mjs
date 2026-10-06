import assert from "node:assert/strict";
import { mapMarkdownLinks } from "../../help-center/scripts/markdown.mjs";

// Preserve code examples while turning installed-server links into instructions.
export function publicMarkdown(source) {
  const prefix = "vectory-installed-reference-";
  assert(!source.includes(prefix), "Reserved public documentation marker");
  const references = [];
  let markdown = mapMarkdownLinks(source, (href) => {
    if (!href.startsWith("/#/") && href !== "/api-reference.html") return href;
    references.push(href);
    return `${prefix}${references.length - 1}`;
  });
  markdown = markdown.replace(/\[([^\]\n]+)\]\(vectory-installed-reference-(\d+)\)/g,
    (_match, label, index) => references[Number(index)] === "/api-reference.html"
      ? `${label} on your own Vectory server at \`/api-reference.html\``
      : label);
  assert(!markdown.includes(prefix), "Unsupported installed-server link syntax");
  if (references.some((href) => href.startsWith("/#/"))) {
    markdown += "\nDashboard views named in this guide are available in your own installed Vectory server. The public documentation does not host those views.\n";
  }
  return markdown;
}
