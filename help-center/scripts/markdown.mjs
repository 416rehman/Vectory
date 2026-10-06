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

// Authored pages stay plain GitHub-flavored Markdown, so they read well on
// GitHub. These constructs become Starlight components in the Help center:
//   > [!NOTE] | [!TIP] | [!IMPORTANT] | [!WARNING] | [!CAUTION]   aside
//   <!-- steps --> directly before an ordered list                  <Steps>
//   <!-- tabs --> or <!-- tabs:key -->, #### Label ..., <!-- /tabs --> <Tabs>
//   <!-- diagram: name --> directly before a ```mermaid block       component
// Every other HTML comment (for example verify-after-merge notes for
// maintainers) is removed from the rendered page and its Markdown copy.
const alertTypes = { NOTE: "note", TIP: "tip", IMPORTANT: "note", WARNING: "caution", CAUTION: "danger" };
export const diagrams = { architecture: "Architecture", "apply-states": "ApplyStates" };
const starlightComponents = ["Steps", "Tabs", "TabItem"];

function fenceOf(line) {
  return line.match(/^\s*(`{3,}|~{3,})([^\r\n]*)$/);
}
function closesFence(marker, fence) {
  return marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim();
}
function trimBlankLines(lines) {
  let start = 0, end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

// Remove HTML comments outside code, then tidy the blank lines they leave.
export function stripComments(source) {
  const out = [];
  let fence = null, comment = false;
  for (const line of source.split("\n")) {
    if (comment) {
      if (line.includes("-->")) {
        comment = false;
        const rest = line.slice(line.indexOf("-->") + 3);
        if (rest.trim()) out.push(rest);
      }
      continue;
    }
    const marker = fenceOf(line);
    if (fence) {
      out.push(line);
      if (marker && closesFence(marker, fence)) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      out.push(line);
      continue;
    }
    if (/^\s*<!--[\s\S]*?-->\s*$/.test(line)) {
      out.push(null);
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      comment = true;
      out.push(null);
      continue;
    }
    out.push(line.replace(/<!--[\s\S]*?-->/g, ""));
  }
  if (comment) throw new Error("Unclosed HTML comment");
  // A removed comment line must not leave two consecutive blank lines.
  const tidy = [];
  for (const line of out) {
    if (line === null) continue;
    if (!line.trim() && tidy.length && !tidy.at(-1).trim() && !line.length) continue;
    tidy.push(line);
  }
  return tidy.join("\n");
}

// MDX treats { } and < as expression and JSX syntax. Escape them in prose;
// code spans and fenced code stay verbatim.
function escapeProse(line) {
  let result = "", ticks = 0, start = 0;
  const prose = (text) =>
    text
      .replace(/[{}]/g, (brace) => "\\" + brace)
      .replace(/<(?!\/?(?:kbd|br)\b)/g, "&lt;");
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let end = i + 1;
    while (line[end] === "`") end++;
    if (!ticks) {
      result += prose(line.slice(start, i)) + line.slice(i, end);
      ticks = end - i;
      start = end;
    } else if (ticks === end - i) {
      result += line.slice(start, end);
      ticks = 0;
      start = end;
    }
    i = end;
  }
  return result + (ticks ? line.slice(start) : prose(line.slice(start)));
}

function convert(lines, used) {
  const out = [];
  let fence = null, comment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = fenceOf(line);
    if (comment) {
      if (line.includes("-->")) {
        comment = false;
        const rest = line.slice(line.indexOf("-->") + 3);
        if (rest.trim()) out.push(escapeProse(rest));
      }
      continue;
    }
    if (fence) {
      out.push(line);
      if (marker && closesFence(marker, fence)) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      out.push(line);
      continue;
    }
    const diagram = line.match(/^<!--\s*diagram:\s*([a-z-]+)\s*-->\s*$/);
    if (diagram) {
      const component = diagrams[diagram[1]];
      if (!component) throw new Error(`Unknown diagram "${diagram[1]}"`);
      let open = i + 1;
      while (open < lines.length && !lines[open].trim()) open++;
      const opening = fenceOf(lines[open] || "");
      if (!opening || !/^mermaid\b/.test(opening[2].trim()))
        throw new Error(`<!-- diagram: ${diagram[1]} --> must directly precede a mermaid code block`);
      let close = open + 1;
      while (close < lines.length && !(fenceOf(lines[close]) && closesFence(fenceOf(lines[close]), opening[1]))) close++;
      if (close >= lines.length) throw new Error(`Unclosed mermaid block for ${diagram[1]}`);
      used.add(component);
      out.push(`<${component} />`);
      i = close;
      continue;
    }
    const tabs = line.match(/^<!--\s*tabs(?::([a-z0-9-]+))?\s*-->\s*$/);
    if (tabs) {
      let end = i + 1;
      while (end < lines.length && !/^<!--\s*\/tabs\s*-->\s*$/.test(lines[end])) end++;
      if (end >= lines.length) throw new Error("Unclosed <!-- tabs --> block");
      const items = [];
      let tabFence = null;
      for (const tabLine of lines.slice(i + 1, end)) {
        const tabMarker = fenceOf(tabLine);
        if (tabFence) {
          items.at(-1).lines.push(tabLine);
          if (tabMarker && closesFence(tabMarker, tabFence)) tabFence = null;
          continue;
        }
        const label = tabLine.match(/^#### (.+?)\s*$/);
        if (label) {
          items.push({ label: label[1], lines: [] });
          continue;
        }
        if (!items.length) {
          if (tabLine.trim()) throw new Error("Tab content must start with a #### label");
          continue;
        }
        if (tabMarker) tabFence = tabMarker[1];
        items.at(-1).lines.push(tabLine);
      }
      if (items.length < 2) throw new Error("A tabs block needs at least two #### labels");
      used.add("Tabs").add("TabItem");
      out.push(tabs[1] ? `<Tabs syncKey="${tabs[1]}">` : "<Tabs>");
      for (const item of items)
        out.push(`<TabItem label=${JSON.stringify(item.label)}>`, "", ...convert(trimBlankLines(item.lines), used), "", "</TabItem>");
      out.push("</Tabs>");
      i = end;
      continue;
    }
    if (/^<!--\s*steps\s*-->\s*$/.test(line)) {
      let start = i + 1;
      while (start < lines.length && !lines[start].trim()) start++;
      if (!/^\d+\.\s/.test(lines[start] || ""))
        throw new Error("<!-- steps --> must directly precede an ordered list");
      let last = start, stepFence = null;
      for (let j = start; j < lines.length; j++) {
        const stepLine = lines[j];
        const stepMarker = fenceOf(stepLine);
        if (stepFence) {
          if (stepMarker && closesFence(stepMarker, stepFence)) stepFence = null;
          last = j;
          continue;
        }
        if (!stepLine.trim()) continue;
        if (/^\d+\.\s/.test(stepLine) || /^\s{2,}\S/.test(stepLine)) {
          if (stepMarker) stepFence = stepMarker[1];
          last = j;
          continue;
        }
        break;
      }
      used.add("Steps");
      out.push("<Steps>", "", ...convert(lines.slice(start, last + 1), used), "", "</Steps>");
      i = last;
      continue;
    }
    const alert = line.match(/^(\s*)> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/);
    if (alert) {
      const [, pad, kind] = alert;
      const body = [];
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith(pad + ">")) {
        body.push(lines[j].slice(pad.length + 1).replace(/^ /, ""));
        j++;
      }
      let title = "";
      const first = trimBlankLines(body)[0] || "";
      if (/^\*\*[^*\]]+\*\*$/.test(first.trim())) {
        title = first.trim().slice(2, -2);
        body.splice(body.indexOf(first), 1);
      }
      const content = convert(trimBlankLines(body), used).map((l) => (l ? pad + l : l));
      // An aside is always its own block, even where GitHub lets a quote
      // interrupt a paragraph.
      if (out.length && out.at(-1).trim()) out.push("");
      out.push(`${pad}:::${alertTypes[kind]}${title ? `[${escapeProse(title)}]` : ""}`, ...content, `${pad}:::`);
      if (lines[j]?.trim()) out.push("");
      i = j - 1;
      continue;
    }
    if (/^\s*<!--\s*\/tabs\s*-->\s*$/.test(line)) throw new Error("<!-- /tabs --> without an opening <!-- tabs -->");
    if (/^\s*<!--[\s\S]*?-->\s*$/.test(line)) continue;
    if (/^\s*<!--/.test(line)) {
      comment = true;
      continue;
    }
    out.push(escapeProse(line.replace(/<!--[\s\S]*?-->/g, "")));
  }
  if (comment) throw new Error("Unclosed HTML comment");
  return out;
}

// Render an article body (links already canonical) as MDX for Starlight.
export function renderMdx(body) {
  const used = new Set();
  const content = convert(body.split("\n"), used);
  const imports = [];
  const starlight = starlightComponents.filter((name) => used.has(name));
  if (starlight.length)
    imports.push(`import { ${starlight.join(", ")} } from "@astrojs/starlight/components";`);
  for (const component of Object.values(diagrams))
    if (used.has(component)) imports.push(`import ${component} from "../../components/${component}.astro";`);
  return (imports.length ? imports.join("\n") + "\n\n" : "") + content.join("\n").trim() + "\n";
}

// The first prose paragraph, as plain text: the page's lead sentence.
export function leadParagraph(markdown) {
  for (const block of stripComments(markdown).split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || /^(?:#|>|<|\||```|~~~|[-*+] |\d+\. |:::)/.test(text)) continue;
    return text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

export function articleContent(source, slug) {
  source = source.replace(/^\uFEFF/, "");
  const heading = source.match(/^# (.+)\r?\n/);
  if (!heading) throw new Error(`Missing title in ${slug}.md`);
  const title = heading[1];
  const body = mapMarkdownLinks(source.slice(heading[0].length), href => canonicalLink(href, slug));
  const markdown = `# ${title}\n\n${stripComments(body).trim()}\n`;
  return { title, description: leadParagraph(body), body: renderMdx(body), markdown };
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
        return `- [${text(label).trim().replace(/\s*→$/, "")}](${canonicalLink(attrs.href || "", "index")}) · ${text(description).trim()}`;
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
