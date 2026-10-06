import assert from "node:assert/strict";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

// Public metadata comes from the same guide inventory as the installed Help
// center. The public documentation index describes a collection, not an article.
export function publicGuideMetadata(html, { origin, pathname, page }) {
  assert(page?.title, `No source title for ${pathname}`);
  assert(pathname.startsWith("/help/") && pathname.endsWith("/"), "Invalid public guide path");
  const url = new URL(pathname, origin).href;
  const home = pathname === "/help/";
  const title = home ? "Vectory documentation | Installation and Vector pipeline guides" : `${page.title} | Vectory`;
  const description = home
    ? "Install Vectory with Docker or the prebuilt native Linux kit, connect Linux, macOS or Windows agents, and design, deploy and monitor Vector pipelines."
    : page.description;
  assert(description, `No source description for ${pathname}`);
  assert.equal(new URL(url).origin, origin, "Guide URL must use the canonical origin");

  const headEnd = html.indexOf("</head>");
  assert(headEnd !== -1, "Guide head is missing");
  let head = html.slice(0, headEnd);
  const tail = html.slice(headEnd);
  head = head.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)}</title>`);
  head = head.replace(/<link\b[^>]*\brel="canonical"[^>]*>/g, "");
  const tags = [
    ["name", "description", description],
    ["property", "og:type", home ? "website" : "article"],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", url],
    ["property", "og:image", `${origin}/social-preview.png`],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["property", "og:image:alt", "Vectory's Vector pipeline workspace showing labeled synthetic demo data"],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
    ["name", "twitter:image", `${origin}/social-preview.png`],
    ["name", "twitter:image:alt", "Vectory's Vector pipeline workspace showing labeled synthetic demo data"],
  ];
  for (const [attribute, key] of tags) {
    head = head.replace(new RegExp(`<meta\\b[^>]*\\b${attribute}="${key}"[^>]*>`, "g"), "");
  }
  const document = {
    "@type": home ? "CollectionPage" : "TechArticle",
    "@id": `${url}#${home ? "collection" : "article"}`,
    [home ? "name" : "headline"]: home ? "Vectory documentation" : page.title,
    description,
    url,
    inLanguage: "en",
    isPartOf: { "@id": `${origin}/#website` },
    publisher: { "@type": "Organization", "@id": `${origin}/#organization`, name: "Vectory", url: `${origin}/` },
    ...(home ? {} : { mainEntityOfPage: { "@type": "WebPage", "@id": url } }),
  };
  const hierarchy = [
    ["Vectory", `${origin}/`],
    ["Documentation", `${origin}/help/`],
    ...(home ? [] : [[page.title, url]]),
  ];
  const graph = {
    "@context": "https://schema.org",
    "@graph": [document, {
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumbs`,
      itemListElement: hierarchy.map(([name, item], index) => ({ "@type": "ListItem", position: index + 1, name, item })),
    }],
  };
  const structured = JSON.stringify(graph).replaceAll("<", "\\u003c");
  return `${head}<link rel="canonical" href="${url}"><link rel="icon" href="/favicon.ico" sizes="any"><link rel="apple-touch-icon" href="/favicons/icon-180.png">${tags.map(([attribute, key, content]) => `<meta ${attribute}="${key}" content="${escapeHtml(content)}">`).join("")}<script type="application/ld+json">${structured}</script>${tail}`;
}

export function publicDiscoveryIndex(origin, version) {
  return `# Vectory\n\n> Open-source, self-hosted Vector pipeline and fleet manager. Design configurations, deploy immutable versions and monitor the hosts that run them. Vectory ${version} uses signed prebuilt images and downloads.\n\n## Product and free tool\n\n- [Vector pipeline and fleet management](${origin}/)\n- [Vector configuration visualizer and designer](${origin}/designer/): Create, import, visualize and export YAML, JSON and TOML locally in your browser, without an account.\n\n## Install and operate\n\n- [Quickstart](${origin}/help/_markdown/quickstart.md): Run the prebuilt server, connect a host and deploy a first pipeline.\n- [Install the server](${origin}/help/_markdown/install-server.md): Docker on Windows, macOS or Linux, a native Linux kit, and automatic HTTPS.\n- [Connect Linux, macOS or Windows agents](${origin}/help/_markdown/installation.md): One device or reusable fleet setup with configurable service, permissions and paths.\n- [Build Vector pipelines](${origin}/help/_markdown/pipelines.md)\n- [Deploy and roll back](${origin}/help/_markdown/deployments.md)\n- [Monitor devices](${origin}/help/_markdown/telemetry.md)\n- [Security model](${origin}/help/_markdown/security.md)\n- [Compatibility and known limits](${origin}/help/_markdown/compatibility.md)\n- [All guides](${origin}/help/llms.txt)\n`;
}
