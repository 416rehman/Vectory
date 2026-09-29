import { parseFragment } from "parse5";

export function canonicalLink(href, slug) {
  if (href.startsWith("#/docs/")) {
    const match = href.match(/^#\/docs\/([a-z-]+)(#[^\s]*)?$/);
    if (!match) throw new Error(`Invalid documentation link: ${href}`);
    return `/help/${match[1]}/${match[2] || ""}`;
  }
  if (href.startsWith("#/")) return "/" + href;
  if (href.startsWith("#"))
    return `/help/${slug === "index" ? "" : slug + "/"}${href}`;
  const relative = href.match(/^(?:\.\/)?([a-z-]+)\.md(#[^\s]*)?$/);
  if (relative)
    return `/help/${relative[1] === "index" ? "" : relative[1] + "/"}${relative[2] || ""}`;
  return href;
}

// Rewrite link destinations, never examples inside fenced, indented or inline
// code. Preserve source bytes outside the specific destination replacement.
export function mapMarkdownLinks(source, map) {
  let fence = null;
  let inlineTicks = 0;
  function prose(text) {
    return text
      .replace(/(\]\(\s*<?)([^\s)>]+)(?=[>\s)])/g,
        (_, prefix, href) => prefix + map(href))
      .replace(/(^ {0,3}\[[^\]\n]+\]:\s*<?)([^\s>]+)(?=[>\s]|$)/g,
        (_, prefix, href) => prefix + map(href))
      .replace(/(\bhref\s*=\s*["'])([^"']+)(["'])/g,
        (_, before, href, after) => before + map(href) + after);
  }
  return source.split(/(?<=\n)/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (!inlineTicks && marker) { fence = marker[1]; return line; }
    if (!inlineTicks && /^(?: {4}|\t)/.test(line)) return line;
    let result = "", start = 0;
    for (let i = 0; i < line.length;) {
      if (line[i] !== "`") { i++; continue; }
      let end = i + 1;
      while (line[end] === "`") end++;
      const size = end - i;
      if (!inlineTicks) {
        result += prose(line.slice(start, i)) + line.slice(i, end);
        inlineTicks = size; start = end;
      } else if (inlineTicks === size) {
        result += line.slice(start, end);
        inlineTicks = 0; start = end;
      }
      i = end;
    }
    return result + (inlineTicks ? line.slice(start) : prose(line.slice(start)));
  }).join("");
}

export function markdownReferences(source) {
  const links = [];
  mapMarkdownLinks(source, href => { links.push(href); return href; });
  return links;
}

export function articleContent(source, slug) {
  source = source.replace(/^\uFEFF/, "");
  const heading = source.match(/^# (.+)\r?\n/);
  if (!heading) throw new Error(`Missing title in ${slug}.md`);
  const title = heading[1];
  let body = mapMarkdownLinks(source.slice(heading[0].length), href => canonicalLink(href, slug));
  if (slug === "api")
    body = "[Open the interactive API reference](/api-reference.html). It uses your current Vectory session.\n\n" + body;
  return { title, body, markdown: `# ${title}\n\n${body.trim()}\n` };
}

export function homeMarkdown(source) {
  const frontmatter = source.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!frontmatter) throw new Error("Home requires title frontmatter");
  const rawTitle = frontmatter[1].match(/^title:\s*(.+)$/m)?.[1].trim();
  if (!rawTitle) throw new Error("Home title is missing");
  const title = rawTitle.startsWith('"') ? JSON.parse(rawTitle) : rawTitle.startsWith("'") ? rawTitle.slice(1, -1).replaceAll("''", "'") : rawTitle;
  function text(node) {
    return node.nodeName === "#text" ? node.value : (node.childNodes || []).map(text).join("");
  }
  function render(node) {
    if (node.nodeName === "#text") return node.value;
    const children = (node.childNodes || []).map(render).join("");
    const attrs = Object.fromEntries((node.attrs || []).map(item => [item.name, item.value]));
    if (node.tagName === "a") {
      const label = node.childNodes?.find(child => child.tagName === "strong");
      const description = node.childNodes?.find(child => child.tagName === "span");
      if (label && description)
        return `- [${text(label).trim().replace(/\s*→$/, "")}](${canonicalLink(attrs.href || "", "index")}) — ${text(description).trim()}`;
      return `[${children}](${canonicalLink(attrs.href || "", "index")})`;
    }
    if (node.tagName === "strong") return `**${children}**`;
    if (node.tagName === "em") return `*${children}*`;
    if (node.tagName === "code") return `\`${children}\``;
    if (["p", "div"].includes(node.tagName)) return children.trim();
    if (node.tagName === "br") return "\n";
    return children;
  }
  // Only convert the authored home HTML blocks. Markdown headings, tables and
  // fenced examples elsewhere retain their original source formatting.
  let offset = 0, start = 0, fence = null;
  const codeRanges = [];
  for (const line of frontmatter[2].split(/(?<=\n)/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (!fence && marker) { fence = marker[1]; start = offset; }
    else if (fence && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      codeRanges.push([start, offset + line.length]); fence = null;
    }
    offset += line.length;
  }
  if (fence) codeRanges.push([start, offset]);
  const body = frontmatter[2].replace(/^(?: {0,3})<(p|div)\b[^>]*>[\s\S]*?<\/\1>/gm,
    (html, _tag, offset) => codeRanges.some(([start, end]) => offset >= start && offset < end) ? html : render(parseFragment(html)));
  const markdown = mapMarkdownLinks(`# ${title}\n\n${body.trim()}\n`, href => canonicalLink(href, "index"));
  return { title, markdown };
}
