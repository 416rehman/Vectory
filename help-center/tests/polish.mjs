// Public, read-only checks for article copying and navigation. Never uses preview credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(path.join(root, "dashboard/package.json"));
const { chromium, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const origin = new URL(process.env.VECTORY_HELP_URL || "http://127.0.0.1:8080")
  .origin;
const output = path.resolve(
  root,
  process.env.VECTORY_HELP_POLISH_ARTIFACTS || ".local/help-polish",
);
const evidencePath = path.resolve(
  root,
  process.env.VECTORY_HELP_POLISH_EVIDENCE || "docs/evidence/help-polish.json",
);
await fs.mkdir(output, { recursive: true });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const evidence = {
  started_at: new Date().toISOString(),
  origin,
  help_index_sha256: sha(
    await fs.readFile(path.join(root, "dashboard/dist/help/index.html")),
  ),
  help_manifest_sha256: sha(
    await fs.readFile(
      path.join(root, "dashboard/dist/help/help-manifest.json"),
    ),
  ),
  scope:
    "Unauthenticated Chromium checks through the real Vectory server: complete page Markdown, clipboard success and simulated failures, public navigation and responsive accessibility. No configuration, account, deployment or fleet mutations. Context uses a synthetic UUID; authenticated draft preservation is tested separately.",
  results: [],
  markdown: [],
  screenshots: [],
  accessibility: [],
  network: { external: [], mutations: [] },
};
const browser = await chromium.launch();
evidence.browser = browser.version();
const contexts = [];
async function context(options = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
  contexts.push(ctx);
  ctx.on("request", (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin)
      evidence.network.external.push(url);
    if (!["GET", "HEAD"].includes(request.method()))
      evidence.network.mutations.push({ method: request.method(), url });
  });
  return ctx;
}
const ctx = await context();
await ctx.addInitScript(() => {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  const write = clipboard.writeText.bind(clipboard);
  clipboard.writeText = async (value) => {
    window.__helpCopiedMarkdown = value;
    return write(value);
  };
});
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
const copy = (page) =>
  page.getByRole("button", { name: "Copy page as Markdown", exact: true });
async function visit(page, topic = "", query = "") {
  await page.goto(`${origin}/help/${topic ? topic + "/" : ""}${query}`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => document.fonts.ready);
}
async function markdown(topic) {
  const response = await ctx.request.get(
    `${origin}/help/_markdown/${topic || "index"}.md`,
  );
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-type"], /^text\/markdown(?:;|$)/);
  assert.equal(response.headers()["x-content-type-options"], "nosniff");
  const text = await response.text();
  assert.equal(
    text,
    await fs.readFile(
      path.join(
        root,
        "dashboard/dist/help/_markdown",
        (topic || "index") + ".md",
      ),
      "utf8",
    ),
  );
  assert.match(text, /^# .+\n/);
  assert(!text.startsWith("---") && !text.startsWith("\uFEFF"));
  return text;
}
async function test(name, run) {
  await run();
  evidence.results.push({ name, passed: true });
  console.log("PASS", name);
}
try {
  await test("all twelve public page Markdown assets retain their full published bytes", async () => {
    for (const topic of [
      "",
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
    ]) {
      const text = await markdown(topic);
      evidence.markdown.push({
        topic: topic || "index",
        bytes: Buffer.byteLength(text),
        sha256: sha(text),
      });
    }
    assert.equal(
      (await ctx.request.get(origin + "/help/_markdown/404.md")).status(),
      404,
    );
  });
  await test("clipboard write receives exact full article; native read preserves it with OS newline normalization", async () => {
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    for (const topic of ["", "installation", "pipelines", "resources"]) {
      const expected = await markdown(topic);
      await visit(page, topic);
      await copy(page).click();
      await expect(
        page.getByText("Page Markdown copied.", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.__helpCopiedMarkdown))
        .toBe(expected);
      const readback = await page.evaluate(() =>
        navigator.clipboard.readText(),
      );
      assert.equal(readback.replaceAll("\r\n", "\n"), expected);
      evidence.clipboard_line_endings = readback.includes("\r\n")
        ? "native CRLF; exact LF passed to writeText"
        : "LF";
      assert.equal(
        await page
          .getByRole("link", { name: "View Markdown", exact: true })
          .getAttribute("href"),
        `/help/_markdown/${topic || "index"}.md`,
      );
    }
  });
  await test("denied and unavailable clipboard both offer selectable complete Markdown without false success", async () => {
    for (const mode of ["denied", "unavailable"]) {
      const fallback = await context();
      await fallback.addInitScript((mode) => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value:
            mode === "unavailable"
              ? undefined
              : {
                  writeText: async () => {
                    throw new DOMException(
                      "Synthetic clipboard denial",
                      "NotAllowedError",
                    );
                  },
                },
        });
      }, mode);
      const p = await fallback.newPage();
      await visit(p, "pipelines");
      await copy(p).click();
      const dialog = p.getByRole("dialog", {
        name: "Copy page as Markdown",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      const input = dialog.getByRole("textbox", {
        name: "Page Markdown",
        exact: true,
      });
      await expect(input).toHaveValue(await markdown("pipelines"));
      await expect(input).toBeFocused();
      assert.equal(await input.getAttribute("readonly"), "");
      const selection = await input.evaluate((e) => [
        e.selectionStart,
        e.selectionEnd,
        e.value.length,
      ]);
      assert.deepEqual(selection, [0, selection[2], selection[2]]);
      await expect(
        p.getByText("Page Markdown copied.", { exact: true }),
      ).toHaveCount(0);
      await dialog
        .getByRole("button", { name: "Select Markdown", exact: true })
        .click();
      await expect(input).toBeFocused();
      if (mode === "denied") {
        const screenshot = path.join(output, "help-copy-markdown-fallback.png");
        await p.screenshot({ path: screenshot });
        evidence.screenshots.push(
          path.relative(root, screenshot).replaceAll("\\", "/"),
        );
      }
      if (mode === "denied")
        await dialog
          .getByRole("button", {
            name: "Close Markdown copy dialog",
            exact: true,
          })
          .click();
      else await p.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(copy(p)).toBeFocused();
      await p.close();
    }
  });
  await test("Markdown fetch failure is visible and a subsequent retry can succeed", async () => {
    await visit(page, "pipelines");
    const address = `${origin}/help/_markdown/pipelines.md`;
    await page.route(address, (route) =>
      route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Synthetic unavailable Markdown",
      }),
    );
    await copy(page).click();
    await expect(
      page.getByText(
        "Could not load this page's Markdown. Try again or use View Markdown.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Page Markdown copied.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Copy page as Markdown", exact: true }),
    ).not.toBeVisible();
    await page.unroute(address);
    await copy(page).click();
    await expect
      .poll(() => page.evaluate(() => window.__helpCopiedMarkdown))
      .toBe(await markdown("pipelines"));
    await expect(
      page.getByText("Page Markdown copied.", { exact: true }),
    ).toBeVisible();
  });
  await test("only the synthetic pipeline UUID follows guide navigation and app links remain same-origin", async () => {
    const id = "af027d3d-94bd-44a0-9559-1a9a6c154271";
    await visit(
      page,
      "resources",
      `?pipeline=${id}&action=publish&token=DO_NOT_PROPAGATE`,
    );
    const section = page
      .locator('a[href*="#choose-the-right-reference"]:visible')
      .first();
    await section.click();
    assert.deepEqual([...new URL(page.url()).searchParams], [["pipeline", id]]);
    const links = page.locator(
      '.sl-markdown-content a[href^="/#/configurations"]',
    );
    assert((await links.count()) > 0);
    for (const link of await links.all()) {
      const url = new URL(await link.getAttribute("href"), origin);
      assert.equal(url.origin, origin);
      assert(url.hash.startsWith(`#/configurations/${id}`));
      assert(
        !url.href.includes("DO_NOT_PROPAGATE") &&
          !url.href.includes("action=publish"),
      );
    }
    const next = page
      .getByRole("navigation", { name: "Main", exact: true })
      .getByRole("link", { name: "Build a pipeline", exact: true });
    await next.click();
    assert.equal(new URL(page.url()).pathname, "/help/pipelines/");
    assert.deepEqual([...new URL(page.url()).searchParams], [["pipeline", id]]);
    await copy(page).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied.replaceAll("\r\n", "\n"), await markdown("pipelines"));
    assert(!copied.includes(id) && !copied.includes("DO_NOT_PROPAGATE"));
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const search = page.getByRole("dialog", { name: "Search", exact: true });
    await search
      .getByRole("textbox", { name: "Search", exact: true })
      .fill("rollback");
    await search
      .getByRole("link", { name: "Roll back deliberately", exact: true })
      .click();
    await expect(page).toHaveURL(
      `${origin}/help/deployments/?pipeline=${id}#roll-back-deliberately`,
    );
    assert.deepEqual([...new URL(page.url()).searchParams], [["pipeline", id]]);
    for (const invalid of [
      "https://example.invalid/",
      "../api/v1/logout",
      "not-a-uuid",
    ]) {
      await visit(
        page,
        "resources",
        `?pipeline=${encodeURIComponent(invalid)}`,
      );
      await page
        .locator('a[href*="#choose-the-right-reference"]:visible')
        .first()
        .click();
      assert.deepEqual([...new URL(page.url()).searchParams], []);
      for (const link of await page
        .locator('.sl-markdown-content a[href^="/#/configurations"]')
        .all()) {
        const url = new URL(await link.getAttribute("href"), origin);
        assert.equal(url.origin, origin);
        assert.equal(url.hash.split("?")[0], "#/configurations");
        assert(!url.href.includes(encodeURIComponent(invalid)));
      }
    }
  });
  await test("no-context task links target pipeline selection and ordinary navigation never invokes an action", async () => {
    await visit(page, "resources");
    const hrefs = await page
      .locator('.sl-markdown-content a[href^="/#/"]')
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    assert(
      hrefs.some((href) => href.startsWith("/#/configurations?panel=settings")),
    );
    for (const href of hrefs) {
      const url = new URL(href, origin);
      assert.equal(url.origin, origin);
      assert(!url.hash.includes("/api/") && !url.hash.includes("action="));
    }
    assert.deepEqual(evidence.network.mutations, []);
  });
  await test("text-first navigation icons and page actions remain accessible on mobile in both themes", async () => {
    for (const sample of [
      { theme: "light", width: 1440, menu: false },
      { theme: "dark", width: 1440, menu: false },
      { theme: "light", width: 375, menu: false },
      { theme: "dark", width: 375, menu: true },
    ]) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await visit(page, "installation");
      await page
        .getByRole("combobox", { name: "Select theme", exact: true })
        .selectOption(sample.theme);
      const links = page.locator('.sidebar-content a[href^="/help/"]');
      assert((await links.count()) >= 12);
      for (const link of await links.all()) {
        assert((await link.innerText()).trim());
        const icon = await link.evaluate((element) => {
          const style = getComputedStyle(element, "::before");
          return { content: style.content, mask: style.maskImage };
        });
        assert.equal(icon.content, '\"\"');
        assert.match(icon.mask, /url\(/);
      }
      await page.setViewportSize({
        width: sample.width,
        height: sample.width === 375 ? 812 : 1000,
      });
      if (sample.menu)
        await page.getByRole("button", { name: "Menu", exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("pre")].every(
          (block) =>
            block.scrollWidth <= block.clientWidth || block.tabIndex >= 0,
        ),
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      evidence.accessibility.push({ ...sample, violations: result.violations });
      assert.deepEqual(result.violations, []);
      const screenshot = path.join(
        output,
        `help-article-${sample.width}-${sample.theme}${sample.menu ? "-menu" : ""}.png`,
      );
      await page.screenshot({ path: screenshot });
      evidence.screenshots.push(
        path.relative(root, screenshot).replaceAll("\\", "/"),
      );
    }
  });
  await test("overflowing reference tables support keyboard scrolling and remove extra tab stops when they fit", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await visit(page, "resources");
    await page
      .getByRole("combobox", { name: "Select theme", exact: true })
      .selectOption("dark");
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb", exact: true }),
    ).toContainText("Use Vectory");
    await page.setViewportSize({ width: 375, height: 812 });
    const table = page.locator(".sl-markdown-content table").first();
    await expect
      .poll(() =>
        table.evaluate(
          (element) =>
            element.scrollWidth > element.clientWidth && element.tabIndex === 0,
        ),
      )
      .toBe(true);
    await table.focus();
    await expect(table).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => table.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("pre")].every(
        (block) =>
          block.scrollWidth <= block.clientWidth || block.tabIndex >= 0,
      ),
    );
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    evidence.accessibility.push({
      page: "resources",
      width: 375,
      theme: "dark",
      violations: result.violations,
    });
    assert.deepEqual(result.violations, []);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect
      .poll(() =>
        table.evaluate(
          (element) =>
            element.scrollWidth <= element.clientWidth + 1 &&
            !element.hasAttribute("tabindex"),
        ),
      )
      .toBe(true);
  });
  assert.deepEqual(evidence.network.external, []);
  assert.deepEqual(evidence.network.mutations, []);
  evidence.passed = true;
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
  evidence.finished_at = new Date().toISOString();
  if (evidence.passed) {
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  }
}
console.log(`Passed ${evidence.results.length} public help polish groups.`);
