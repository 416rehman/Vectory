import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkLinks, dashboardHelpTargets } from "./check-links.mjs";

test("dashboard help targets come from DocLink, HelpLink, page help descriptors and literal help paths", () => {
  const source = [
    '<DocLink topic="installation" section="trust-the-server-certificate">x</DocLink>',
    '<HelpLink\n  topic="deployments"\n  section="choose-a-rollout"\n  label="Help"\n/>',
    'help={{\n  topic: "troubleshooting",\n  section: "a-device-page-shows-mismatched-details",\n}}',
    'help={{ topic: "administer" }}',
    'href="/help/troubleshooting/#a-page-is-blank-or-cannot-load"',
    '<DocLink topic={dynamic} section="ignored">x</DocLink>',
  ].join("\n");
  assert.deepEqual(dashboardHelpTargets(source).map((target) => target.href), [
    "/help/installation/#trust-the-server-certificate",
    "/help/deployments/#choose-a-rollout",
    "/help/troubleshooting/#a-device-page-shows-mismatched-details",
    "/help/administer/",
    "/help/troubleshooting/#a-page-is-blank-or-cannot-load",
  ]);
});

test("legacy anchors keep moved sections reachable and cannot rot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vectory-legacy-links-"));
  const output = path.join(root, "help"), dashboard = path.join(root, "dashboard");
  await fs.mkdir(path.join(output, "old"), { recursive: true });
  await fs.mkdir(path.join(output, "new"), { recursive: true });
  await fs.mkdir(dashboard);
  const oldPage = path.join(output, "old/index.html"), newPage = path.join(output, "new/index.html");
  await fs.writeFile(oldPage, '<h2 id="kept">Kept</h2>');
  await fs.writeFile(newPage, '<h2 id="moved-here">Moved</h2>');
  await fs.writeFile(path.join(dashboard, "Page.tsx"), '<DocLink topic="old" section="moved">Help</DocLink>');
  const pages = [oldPage, newPage];
  try {
    await assert.rejects(checkLinks(output, pages, dashboard), /Page\.tsx:1: missing section \/help\/old\/#moved/);
    await checkLinks(output, pages, dashboard, [], { legacy: { old: { moved: "new#moved-here" } } });
    await assert.rejects(checkLinks(output, pages, dashboard, [], { legacy: { old: { moved: "new#missing" } } }), /points to missing new#missing/);
    await assert.rejects(checkLinks(output, pages, dashboard, [], { legacy: { old: { moved: "new#moved-here", kept: "new#moved-here" } } }), /old#kept still exists/);
    await assert.rejects(checkLinks(output, pages, dashboard, [], { legacy: { gone: { x: "new" } } }), /unknown page gone/);
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("vectory-legacy-links-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

test("every legacy anchor in the shipped map names a registered page", async () => {
  const { topics } = await import("../pages.mjs");
  const legacy = JSON.parse(await fs.readFile(new URL("../legacy-anchors.json", import.meta.url), "utf8"));
  for (const [page, sections] of Object.entries(legacy)) {
    assert.ok(topics.includes(page), page);
    for (const target of Object.values(sections)) assert.ok(topics.includes(target.split("#")[0]), target);
  }
});

test("published Markdown links retain query tokens, verify sections/assets, and reject mismatched source hashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vectory-markdown-links-"));
  const output = path.join(root, "help"), dashboard = path.join(root, "dashboard");
  await fs.mkdir(path.join(output, "topic"), {recursive:true});
  await fs.mkdir(path.join(output, "_markdown"));
  await fs.mkdir(dashboard);
  const html = path.join(output, "topic/index.html");
  const asset = path.join(output, "_markdown/topic.md");
  await fs.writeFile(html, '<h1 id="title">Topic</h1><h2 id="section">Section</h2>');
  const source = "# Topic\n\n[Section](/help/topic/?query=example#section)\n[App](/#/configurations?panel=settings&section=tests)\n[External](https://vector.dev/docs/)\n";
  const item={slug:"topic",title:"Topic",path:"/help/_markdown/topic.md",sha256:createHash("sha256").update(source).digest("hex")};
  try {
    await fs.writeFile(asset, source);
    await checkLinks(output,[html],dashboard,[item]);
    await fs.writeFile(asset, source.replace("#section", "#missing"));
    await assert.rejects(checkLinks(output,[html],dashboard,[{...item,sha256:undefined}]), /missing section/);
    await assert.rejects(checkLinks(output,[html],dashboard,[item]), /does not match its authored source/);
    await fs.writeFile(asset, "# Topic\n\n[Missing](/help/_markdown/missing.md)\n");
    await assert.rejects(checkLinks(output,[html],dashboard,[{...item,sha256:undefined}]), /missing local link/);
    await assert.rejects(checkLinks(output,[html],dashboard,[{path:"/help/_markdown/../../outside.md"}]), /Invalid Markdown asset path/);
    await fs.unlink(asset);
    await assert.rejects(checkLinks(output,[html],dashboard,[item]), /ENOENT/);
  } finally {
    const resolved=path.resolve(root);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("vectory-markdown-links-"));
    await fs.rm(resolved,{recursive:true,force:true});
  }
});
