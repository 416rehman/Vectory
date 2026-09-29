import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkLinks } from "./check-links.mjs";

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
